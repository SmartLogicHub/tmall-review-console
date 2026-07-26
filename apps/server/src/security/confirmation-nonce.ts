import { createHash, randomBytes } from "node:crypto";

export type SecretConfirmationAction = "replace" | "delete" | "factory_reset";

interface NonceRecord {
  action: SecretConfirmationAction;
  expiresAt: number;
  sessionId: string;
}

interface ConfirmationNonceOptions {
  now?: () => number;
  ttlMs?: number;
}

export class ConfirmationNonceService {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #records = new Map<string, NonceRecord>();

  constructor(options: ConfirmationNonceOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  }

  prepare(input: { sessionId: string; action: SecretConfirmationAction }) {
    this.#removeExpired();
    const nonce = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + this.#ttlMs;
    this.#records.set(this.#hash(nonce), {
      sessionId: input.sessionId,
      action: input.action,
      expiresAt,
    });
    return { nonce, expiresAt };
  }

  consume(input: {
    nonce: string;
    sessionId: string;
    action: SecretConfirmationAction;
  }): true {
    const key = this.#hash(input.nonce);
    const record = this.#records.get(key);
    this.#records.delete(key);

    if (
      !record ||
      record.expiresAt < this.#now() ||
      record.sessionId !== input.sessionId ||
      record.action !== input.action
    ) {
      throw new Error("Confirmation nonce is invalid or expired");
    }
    return true;
  }

  #hash(nonce: string) {
    return createHash("sha256").update(nonce, "utf8").digest("hex");
  }

  #removeExpired() {
    const now = this.#now();
    for (const [key, record] of this.#records) {
      if (record.expiresAt < now) this.#records.delete(key);
    }
  }
}
