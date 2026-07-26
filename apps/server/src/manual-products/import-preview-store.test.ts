import { describe, expect, it, vi } from "vitest";
import {
  ImportPreviewStore,
  type ImportPreviewScheduler,
} from "./import-preview-store";

interface Payload {
  catalogRevision: number;
  rows: Array<{ itemId: string | null; title: string }>;
}

function payload(title = "商品 A"): Payload {
  return { catalogRevision: 7, rows: [{ itemId: "1001", title }] };
}

function issue(store: ImportPreviewStore<Payload>, sessionId: string, value = payload()): string {
  return store.issue(store.beginAttempt(sessionId), value);
}

class ManualScheduler implements ImportPreviewScheduler {
  private nextId = 1;
  readonly callbacks = new Map<number, () => void>();
  readonly cleared: number[] = [];

  set(_delayMs: number, callback: () => void): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  clear(handle: unknown): void {
    const id = handle as number;
    this.cleared.push(id);
    this.callbacks.delete(id);
  }

  runAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

describe("ImportPreviewStore", () => {
  it("issues an opaque token while storing only its sha256 digest", () => {
    const store = new ImportPreviewStore<Payload>();
    const token = issue(store, "session-a");

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const storedKeys = [...(Reflect.get(store, "entries") as Map<string, unknown>).keys()];
    expect(storedKeys).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/u)]);
    expect(storedKeys).not.toContain(token);
  });

  it("binds a token to one session and deletes it before any validation", () => {
    const store = new ImportPreviewStore<Payload>();
    const token = issue(store, "session-a");

    expect(() => store.consume(token, "session-b")).toThrowError("预览已失效，请重新上传文件");
    expect(() => store.consume(token, "session-a")).toThrowError("预览已失效，请重新上传文件");
  });

  it("expires at exactly ten minutes and cannot be replayed", () => {
    const now = vi.fn(() => 1_000);
    const store = new ImportPreviewStore<Payload>({ now });
    const token = issue(store, "session-a");
    now.mockReturnValue(601_000);

    expect(() => store.consume(token, "session-a")).toThrowError("预览已失效，请重新上传文件");
    expect(() => store.consume(token, "session-a")).toThrowError("预览已失效，请重新上传文件");
  });

  it("invalidates the previous preview when the same session uploads again", () => {
    const store = new ImportPreviewStore<Payload>();
    const oldToken = issue(store, "session-a", payload("旧商品"));
    const currentToken = issue(store, "session-a", payload("新商品"));

    expect(() => store.consume(oldToken, "session-a")).toThrowError("预览已失效，请重新上传文件");
    expect(store.consume(currentToken, "session-a").rows[0]?.title).toBe("新商品");
  });

  it("deep clones and freezes issued payloads", () => {
    const input = payload();
    const store = new ImportPreviewStore<Payload>();
    const token = issue(store, "session-a", input);
    input.rows[0]!.title = "已篡改";

    const stored = store.consume(token, "session-a");
    expect(stored.rows[0]?.title).toBe("商品 A");
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.rows)).toBe(true);
    expect(Object.isFrozen(stored.rows[0])).toBe(true);
  });

  it("rejects Buffer values instead of retaining uploaded bytes", () => {
    const store = new ImportPreviewStore<Payload>();
    const attempt = store.beginAttempt("session-a");
    expect(() => store.issue(attempt, { ...payload(), raw: Buffer.from("secret") } as Payload))
      .toThrowError("预览数据不安全");
  });

  it("does not share tokens across store restarts", () => {
    const first = new ImportPreviewStore<Payload>();
    const token = issue(first, "session-a");
    const restarted = new ImportPreviewStore<Payload>();

    expect(() => restarted.consume(token, "session-a")).toThrowError("预览已失效，请重新上传文件");
  });

  it("invalidates an issued token as soon as a newer preview attempt begins", () => {
    const store = new ImportPreviewStore<Payload>();
    const token = issue(store, "session-a");

    store.beginAttempt("session-a");

    expect(() => store.consume(token, "session-a")).toThrowError("预览已失效，请重新上传文件");
  });

  it("explicitly invalidates both the latest token and any in-flight attempt for a session", () => {
    const store = new ImportPreviewStore<Payload>();
    const token = issue(store, "session-a");

    store.invalidateSession("session-a");
    expect(() => store.consume(token, "session-a")).toThrowError("预览已失效，请重新上传文件");

    const inFlight = store.beginAttempt("session-a");
    store.invalidateSession("session-a");
    expect(() => store.issue(inFlight, payload("过期预览"))).toThrowError("预览已被新的上传请求取代");
  });

  it("prevents an older in-flight attempt from issuing after a newer attempt", () => {
    const store = new ImportPreviewStore<Payload>();
    const older = store.beginAttempt("session-a");
    const newer = store.beginAttempt("session-a");
    const currentToken = store.issue(newer, payload("新预览"));

    expect(() => store.issue(older, payload("旧预览"))).toThrowError("预览已被新的上传请求取代");
    expect(store.consume(currentToken, "session-a").rows[0]?.title).toBe("新预览");
  });

  it("physically removes expired entries and indexes using an injected scheduler", () => {
    const now = vi.fn(() => 1_000);
    const scheduler = new ManualScheduler();
    const store = new ImportPreviewStore<Payload>({ now, scheduler });
    issue(store, "session-a");
    now.mockReturnValue(601_000);

    scheduler.runAll();

    expect((Reflect.get(store, "entries") as Map<string, unknown>).size).toBe(0);
    expect((Reflect.get(store, "latestBySession") as Map<string, unknown>).size).toBe(0);
    expect((Reflect.get(store, "currentAttemptBySession") as Map<string, unknown>).size).toBe(0);
    expect((Reflect.get(store, "activeAttemptIds") as Set<string>).size).toBe(0);
  });

  it("cancels timers on replacement, consumption and dispose", () => {
    const scheduler = new ManualScheduler();
    const store = new ImportPreviewStore<Payload>({ scheduler });
    issue(store, "session-a");
    const current = issue(store, "session-a", payload("当前"));
    store.consume(current, "session-a");
    issue(store, "session-b");

    store.dispose();

    expect(scheduler.callbacks.size).toBe(0);
    expect(scheduler.cleared).toHaveLength(3);
    expect((Reflect.get(store, "entries") as Map<string, unknown>).size).toBe(0);
  });

  it.each([
    ["Map with Buffer", { nested: new Map([["raw", Buffer.from("secret")]]) }],
    ["Set", { nested: new Set(["secret"]) }],
    ["Date", { nested: new Date() }],
    ["typed array", { nested: new Uint8Array([1, 2]) }],
    ["ArrayBuffer", { nested: new ArrayBuffer(2) }],
    ["undefined", { nested: undefined }],
    ["non-finite", { nested: Number.POSITIVE_INFINITY }],
    ["custom prototype", Object.create({ inherited: true })],
  ])("rejects non-JSON-safe payloads: %s", (_label, unsafe) => {
    const store = new ImportPreviewStore<Payload>();
    const attempt = store.beginAttempt("session-a");
    expect(() => store.issue(attempt, { ...payload(), unsafe } as Payload)).toThrowError("预览数据不安全");
  });

  it("rejects cyclic payloads", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const store = new ImportPreviewStore<Payload>();
    expect(() => store.issue(store.beginAttempt("session-a"), { ...payload(), cyclic } as Payload))
      .toThrowError("预览数据不安全");
  });

  it("rejects accessor arrays without evaluating their getters", () => {
    let accessed = false;
    const unsafe: unknown[] = ["placeholder"];
    Object.defineProperty(unsafe, "0", {
      enumerable: true,
      configurable: true,
      get() { accessed = true; return "secret"; },
    });
    const store = new ImportPreviewStore<Payload>();

    expect(() => store.issue(store.beginAttempt("session-a"), { ...payload(), unsafe } as Payload))
      .toThrowError("预览数据不安全");
    expect(accessed).toBe(false);
  });

  it("bounds active expiry timers and evicts the oldest token", () => {
    const scheduler = new ManualScheduler();
    const store = new ImportPreviewStore<Payload>({ scheduler, maxEntries: 2 });
    const oldest = issue(store, "session-a", payload("A"));
    issue(store, "session-b", payload("B"));
    issue(store, "session-c", payload("C"));

    expect((Reflect.get(store, "entries") as Map<string, unknown>).size).toBe(2);
    expect(scheduler.callbacks.size).toBe(2);
    expect(() => store.consume(oldest, "session-a")).toThrowError("预览已失效，请重新上传文件");
  });

  it("bounds active attempts and releases capacity through idempotent finish", () => {
    const store = new ImportPreviewStore<Payload>({ maxActiveAttempts: 2 });
    const first = store.beginAttempt("session-a");
    const second = store.beginAttempt("session-b");

    expect(() => store.beginAttempt("session-c")).toThrowError("预览请求过多，请稍后重试");
    store.finishAttempt("session-a", first.attemptId);
    store.finishAttempt("session-a", first.attemptId);
    expect(() => store.beginAttempt("session-c")).not.toThrow();
    store.finishAttempt("session-b", second.attemptId);
    store.dispose();
    expect((Reflect.get(store, "currentAttemptBySession") as Map<string, unknown>).size).toBe(0);
    expect((Reflect.get(store, "activeAttemptIds") as Set<string>).size).toBe(0);
  });

  it("does not let an older finish clear a newer attempt", () => {
    const store = new ImportPreviewStore<Payload>();
    const older = store.beginAttempt("session-a");
    const newer = store.beginAttempt("session-a");

    store.finishAttempt("session-a", older.attemptId);

    const token = store.issue(newer, payload("新预览"));
    expect(store.consume(token, "session-a").rows[0]?.title).toBe("新预览");
  });

  it("counts overlapping attempts from the same session and releases only the finished id", () => {
    const store = new ImportPreviewStore<Payload>({ maxActiveAttempts: 2 });
    const older = store.beginAttempt("session-a");
    const newer = store.beginAttempt("session-a");

    expect(() => store.beginAttempt("session-a")).toThrowError("预览请求过多，请稍后重试");
    store.finishAttempt("session-a", older.attemptId);
    expect((Reflect.get(store, "activeAttemptIds") as Set<string>).size).toBe(1);
    expect((Reflect.get(store, "currentAttemptBySession") as Map<string, string>).get("session-a"))
      .toBe(newer.attemptId);

    const token = store.issue(newer, payload("新预览"));
    expect((Reflect.get(store, "activeAttemptIds") as Set<string>).size).toBe(0);
    expect(store.consume(token, "session-a").rows[0]?.title).toBe("新预览");
  });

  it("keeps the previous token valid when global attempt capacity rejects a new begin", () => {
    const store = new ImportPreviewStore<Payload>({ maxActiveAttempts: 1 });
    const validToken = issue(store, "session-a", payload("已有预览"));
    const blocker = store.beginAttempt("session-b");

    expect(() => store.beginAttempt("session-a")).toThrowError("预览请求过多，请稍后重试");
    expect(store.consume(validToken, "session-a").rows[0]?.title).toBe("已有预览");
    store.finishAttempt("session-b", blocker.attemptId);
  });
});
