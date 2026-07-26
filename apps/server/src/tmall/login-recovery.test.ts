import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { InMemorySecretStore } from "../security/credential-store";
import { openDatabase, runMigrations } from "../storage/database";
import { SettingsRepository } from "../storage/repositories";
import type { TmallAuthDriver, TmallAuthResult } from "./auth-driver";

const host = "127.0.0.1:4300";
const origin = `http://${host}`;
const sessionToken = "login-recovery-session";
const csrfToken = "login-recovery-csrf";
const credentialRejectionKey = "tmall_credential_rejection_times_v2";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

type RecoveryState =
  | "authenticated"
  | "credential_rejected"
  | "manual_verification_required"
  | "onboarding_or_safe_guide"
  | "manual_action_required"
  | "not_ready"
  | "navigation_failed";

function authResult(state: RecoveryState): TmallAuthResult {
  if (state === "authenticated") {
    return { state, page: "review_list", storeName: "测试店铺" } as TmallAuthResult;
  }
  const messages: Record<Exclude<RecoveryState, "authenticated">, string> = {
    credential_rejected: "淘宝明确提示账号或密码错误",
    manual_verification_required: "请在已打开的淘宝窗口完成短信、电话或扫码验证",
    onboarding_or_safe_guide: "淘宝窗口显示新手引导，请完成或关闭后继续",
    manual_action_required: "淘宝窗口需要人工处理",
    not_ready: "淘宝页面尚未完成登录",
    navigation_failed: "淘宝页面暂时无法进入评价管理",
  };
  return { state, page: state === "navigation_failed" ? "review_list" : "login", message: messages[state] } as TmallAuthResult;
}

describe("Tmall login recovery outcome contract", () => {
  let app: FastifyInstance;
  let database: ReturnType<typeof openDatabase>;
  let settings: SettingsRepository;
  let cookie: string;
  let openCount: number;
  let continueCount: number;
  let currentOpenResult: TmallAuthResult;
  let currentContinueResult: TmallAuthResult;

  async function start(overrides?: {
    legacyFailures?: number[];
    credentialRejections?: number[];
    credentialRead?: () => Promise<string | null>;
  }): Promise<void> {
    const now = new Date("2026-07-16T08:00:00.000Z");
    database = openDatabase(":memory:");
    runMigrations(database);
    settings = new SettingsRepository(database);
    settings.set("tmall_verified_credential_fingerprint", createHash("sha256").update("测试店铺:客服", "utf8").digest("hex"));
    settings.set("tmall_verified_store_name", "测试店铺");
    settings.set("tmall_verified_at", now.toISOString());
    if (overrides?.legacyFailures) settings.set("tmall_login_failure_times", overrides.legacyFailures);
    if (overrides?.credentialRejections) settings.set(credentialRejectionKey, overrides.credentialRejections);

    const inMemorySecretStore = new InMemorySecretStore();
    await inMemorySecretStore.write("taobao_seller", JSON.stringify({ account: "测试店铺:客服", password: "secret" }));
    const secretStore = overrides?.credentialRead
      ? {
          has: (key: string) => inMemorySecretStore.has(key),
          read: (key: string) => key === "taobao_seller" ? overrides.credentialRead!() : inMemorySecretStore.read(key),
          write: (key: string, value: string) => inMemorySecretStore.write(key, value),
          delete: (key: string) => inMemorySecretStore.delete(key),
        }
      : inMemorySecretStore;
    const driver = {
      canSubmitReplies: true,
      openReviewPage: async () => {
        openCount += 1;
        return currentOpenResult;
      },
      continueReviewPage: async () => {
        continueCount += 1;
        return currentContinueResult;
      },
      readPendingReviews: async () => [],
      verifyCriticalElements: async () => ({ verifiedOperationKeys: [], missingOperationKeys: [], queueEmpty: true }),
      close: async () => undefined,
      clearProfile: async () => undefined,
    } as unknown as TmallAuthDriver;

    app = buildApp({
      host,
      origin,
      sessionToken,
      csrfToken,
      database,
      secretStore,
      tmallAuthDriver: driver,
      now: () => new Date(now),
      runtimeReadinessCheck: async () => [],
    });
    await app.ready();
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host } });
    cookie = bootstrap.cookies[0]?.value ?? "";
  }

  function headers(): Record<string, string> {
    return {
      host,
      origin,
      "sec-fetch-site": "same-origin",
      "x-csrf-token": csrfToken,
      cookie: `tmall_console_session=${cookie}`,
    };
  }

  beforeEach(() => {
    openCount = 0;
    continueCount = 0;
    currentOpenResult = authResult("authenticated");
    currentContinueResult = authResult("authenticated");
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("does not preserve or display legacy generic failure lockouts without credential-rejection evidence", async () => {
    const now = new Date("2026-07-16T08:00:00.000Z").getTime();
    currentOpenResult = authResult("not_ready");
    await start({ legacyFailures: [now - 2_000, now - 1_000] });

    const first = await app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers: headers() });
    const second = await app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers: headers() });
    const third = await app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers: headers() });
    const status = await app.inject({ method: "GET", url: "/api/tmall-auth/status", headers: { host, cookie: `tmall_console_session=${cookie}` } });

    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([200, 200, 200]);
    expect(third.json()).toMatchObject({ state: "not_ready" });
    expect(status.json()).not.toMatchObject({ state: "locked_out" });
    expect(status.body).not.toContain("10分钟");
    expect(settings.get<number[]>("tmall_login_failure_times")).toEqual([]);
    expect(openCount).toBe(3);
  });

  it("serializes authentication before the asynchronous credential read starts", async () => {
    const firstReadStarted = deferred<void>();
    const releaseFirstRead = deferred<void>();
    let reads = 0;
    await start({
      credentialRead: async () => {
        reads += 1;
        if (reads === 1) {
          firstReadStarted.resolve();
          await releaseFirstRead.promise;
        }
        return JSON.stringify({ account: "测试店铺:客服", password: "secret" });
      },
    });

    const first = app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers: headers() });
    await firstReadStarted.promise;
    const concurrent = await app.inject({ method: "POST", url: "/api/tmall-auth/continue", headers: headers() });
    releaseFirstRead.resolve();
    const completed = await first;

    expect(concurrent.statusCode).toBe(409);
    expect(concurrent.json()).toMatchObject({ error: "tmall_authentication_in_progress" });
    expect(completed.statusCode).toBe(200);
    expect(reads).toBe(1);
    expect(openCount).toBe(1);
    expect(continueCount).toBe(0);
  });

  it.each([
    "manual_verification_required",
    "onboarding_or_safe_guide",
    "manual_action_required",
    "not_ready",
    "navigation_failed",
  ] as const)("does not count %s as a rejected credential attempt", async (state) => {
    currentOpenResult = authResult(state);
    await start();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers: headers() });
      expect(response.statusCode).not.toBe(429);
      expect(response.json()).toMatchObject({ state });
    }

    expect(settings.get<number[]>(credentialRejectionKey) ?? []).toEqual([]);
    expect(openCount).toBe(3);
  });

  it("reports explicit credential rejection without locking any later user-initiated attempt", async () => {
    currentOpenResult = authResult("credential_rejected");
    await start();

    const attempts = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      attempts.push(await app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers: headers() }));
    }

    expect(attempts.map((item) => item.statusCode)).toEqual([422, 422, 422]);
    expect(attempts[2]!.json()).toMatchObject({ state: "credential_rejected" });
    expect(attempts[2]!.body).not.toContain("10分钟");
    expect(settings.get<number[]>(credentialRejectionKey) ?? []).toEqual([]);
    expect(openCount).toBe(3);
  });

  it("continues the same interactive browser session without credentials or the automatic limiter", async () => {
    const now = new Date("2026-07-16T08:00:00.000Z").getTime();
    currentContinueResult = authResult("authenticated");
    await start({ credentialRejections: [now - 2_000, now - 1_000] });

    const continued = await app.inject({ method: "POST", url: "/api/tmall-auth/continue", headers: headers() });

    expect(continued.statusCode).toBe(200);
    expect(continued.json()).toMatchObject({ state: "authenticated", page: "review_list" });
    expect(openCount).toBe(0);
    expect(continueCount).toBe(1);
    expect(settings.get<number[]>(credentialRejectionKey)).toEqual([]);
  });

  it("clears explicit rejection history after a verified login", async () => {
    const now = new Date("2026-07-16T08:00:00.000Z").getTime();
    await start({ credentialRejections: [now - 1_000] });

    const result = await app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers: headers() });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ state: "authenticated" });
    expect(settings.get<number[]>(credentialRejectionKey)).toEqual([]);
  });
});
