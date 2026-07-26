import { createHash, randomBytes } from "node:crypto";

const PREVIEW_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_ACTIVE_ATTEMPTS = 1_000;
const INVALID_PREVIEW_MESSAGE = "预览已失效，请重新上传文件";
const SUPERSEDED_PREVIEW_MESSAGE = "预览已被新的上传请求取代";

export class ImportPreviewSupersededError extends Error {
  constructor() {
    super(SUPERSEDED_PREVIEW_MESSAGE);
    this.name = "ImportPreviewSupersededError";
  }
}

export interface ImportPreviewAttempt {
  readonly sessionId: string;
  readonly attemptId: string;
}

export interface ImportPreviewScheduler {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

interface StoredPreview<T> {
  readonly sessionId: string;
  readonly expiresAt: number;
  readonly payload: T;
  timer: unknown;
}

export interface ImportPreviewStoreOptions {
  now?: () => number;
  scheduler?: ImportPreviewScheduler;
  maxEntries?: number;
  maxActiveAttempts?: number;
}

const defaultScheduler: ImportPreviewScheduler = {
  set(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export class ImportPreviewStore<T> {
  private readonly entries = new Map<string, StoredPreview<T>>();
  private readonly latestBySession = new Map<string, string>();
  private readonly currentAttemptBySession = new Map<string, string>();
  private readonly activeAttemptIds = new Set<string>();
  private readonly now: () => number;
  private readonly scheduler: ImportPreviewScheduler;
  private readonly maxEntries: number;
  private readonly maxActiveAttempts: number;

  constructor(options: ImportPreviewStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.maxActiveAttempts = Math.max(1, Math.trunc(options.maxActiveAttempts ?? DEFAULT_MAX_ACTIVE_ATTEMPTS));
  }

  beginAttempt(sessionId: string): ImportPreviewAttempt {
    this.sweepExpired();
    if (this.activeAttemptIds.size >= this.maxActiveAttempts) {
      throw new Error("预览请求过多，请稍后重试");
    }
    this.deleteLatestForSession(sessionId);
    const attemptId = randomBytes(16).toString("base64url");
    this.activeAttemptIds.add(attemptId);
    this.currentAttemptBySession.set(sessionId, attemptId);
    return Object.freeze({ sessionId, attemptId });
  }

  finishAttempt(sessionId: string, attemptId: string): void {
    this.activeAttemptIds.delete(attemptId);
    if (this.currentAttemptBySession.get(sessionId) === attemptId) {
      this.currentAttemptBySession.delete(sessionId);
    }
  }

  invalidateSession(sessionId: string): void {
    this.sweepExpired();
    this.deleteLatestForSession(sessionId);
    const attemptId = this.currentAttemptBySession.get(sessionId);
    if (attemptId) this.activeAttemptIds.delete(attemptId);
    this.currentAttemptBySession.delete(sessionId);
  }

  issue(attempt: ImportPreviewAttempt, payload: T): string {
    this.sweepExpired();
    if (this.currentAttemptBySession.get(attempt.sessionId) !== attempt.attemptId) {
      throw new ImportPreviewSupersededError();
    }
    const cloned = cloneJsonSafe(payload) as T;
    this.deleteLatestForSession(attempt.sessionId);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.deleteEntry(oldest);
    }

    const token = randomBytes(32).toString("base64url");
    const digest = digestToken(token);
    const expiresAt = this.now() + PREVIEW_TTL_MS;
    const stored: StoredPreview<T> = {
      sessionId: attempt.sessionId,
      expiresAt,
      payload: deepFreeze(cloned),
      timer: undefined,
    };
    this.entries.set(digest, stored);
    this.latestBySession.set(attempt.sessionId, digest);
    this.scheduleExpiry(digest, stored);
    this.finishAttempt(attempt.sessionId, attempt.attemptId);
    return token;
  }

  consume(token: string, sessionId: string): T {
    this.sweepExpired();
    const digest = digestToken(token);
    const stored = this.entries.get(digest);
    this.deleteEntry(digest);
    if (
      !stored || stored.sessionId !== sessionId || this.now() >= stored.expiresAt
    ) {
      throw new Error(INVALID_PREVIEW_MESSAGE);
    }
    return stored.payload;
  }

  dispose(): void {
    for (const digest of [...this.entries.keys()]) this.deleteEntry(digest);
    this.latestBySession.clear();
    this.currentAttemptBySession.clear();
    this.activeAttemptIds.clear();
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [digest, stored] of this.entries) {
      if (now >= stored.expiresAt) this.deleteEntry(digest);
    }
  }

  private deleteLatestForSession(sessionId: string): void {
    const digest = this.latestBySession.get(sessionId);
    if (digest) this.deleteEntry(digest);
  }

  private deleteEntry(digest: string): void {
    const stored = this.entries.get(digest);
    if (!stored) return;
    this.entries.delete(digest);
    this.scheduler.clear(stored.timer);
    if (this.latestBySession.get(stored.sessionId) === digest) {
      this.latestBySession.delete(stored.sessionId);
    }
  }

  private scheduleExpiry(digest: string, stored: StoredPreview<T>): void {
    const delay = Math.max(0, stored.expiresAt - this.now());
    stored.timer = this.scheduler.set(delay, () => {
      const current = this.entries.get(digest);
      if (current !== stored) return;
      if (this.now() >= stored.expiresAt) this.deleteEntry(digest);
      else this.scheduleExpiry(digest, stored);
    });
  }
}

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function cloneJsonSafe(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw unsafePayload();
  }
  if (typeof value !== "object") throw unsafePayload();
  if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) throw unsafePayload();
  if (ancestors.has(value)) throw unsafePayload();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
        throw unsafePayload();
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || names.at(-1) !== "length") throw unsafePayload();
      const clone: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !("value" in descriptor)) throw unsafePayload();
        clone.push(cloneJsonSafe(descriptor.value, ancestors));
      }
      return clone;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw unsafePayload();
    if (Object.getOwnPropertySymbols(value).length > 0) throw unsafePayload();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const clone: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) throw unsafePayload();
      Object.defineProperty(clone, key, {
        value: cloneJsonSafe(descriptor.value, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function unsafePayload(): Error {
  return new Error("预览数据不安全");
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
