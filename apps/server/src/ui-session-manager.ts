export interface UiSessionManagerOptions {
  leaseMs: number;
  onIdle: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class UiSessionManager {
  readonly #leaseMs: number;
  readonly #onIdle: () => void;
  readonly #now: () => number;
  readonly #setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  readonly #leases = new Map<string, number>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #idleNotified = false;

  constructor(options: UiSessionManagerOptions) {
    if (!Number.isFinite(options.leaseMs) || options.leaseMs < 1_000) throw new Error("UI session lease must be at least one second");
    this.#leaseMs = options.leaseMs;
    this.#onIdle = options.onIdle;
    this.#now = options.now ?? Date.now;
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  register(id: string): number {
    this.#assertId(id);
    this.#leases.set(id, this.#now() + this.#leaseMs);
    this.#idleNotified = false;
    this.#schedule();
    return this.#leases.size;
  }

  heartbeat(id: string): number {
    return this.register(id);
  }

  close(id: string): number {
    this.#assertId(id);
    this.#leases.delete(id);
    this.#schedule();
    return this.#leases.size;
  }

  activeCount(): number {
    return this.#leases.size;
  }

  dispose(): void {
    this.#clearScheduledTimer();
    this.#leases.clear();
  }

  #schedule(): void {
    this.#clearScheduledTimer();
    if (this.#leases.size === 0) {
      this.#timer = this.#setTimer(() => this.#notifyIdleIfStillEmpty(), this.#leaseMs);
      return;
    }
    const nextExpiry = Math.min(...this.#leases.values());
    this.#timer = this.#setTimer(() => this.#expireLeases(), Math.max(0, nextExpiry - this.#now()));
  }

  #expireLeases(): void {
    const now = this.#now();
    for (const [id, expiresAt] of this.#leases) {
      if (expiresAt <= now) this.#leases.delete(id);
    }
    if (this.#leases.size === 0) {
      this.#notifyIdleIfStillEmpty();
      return;
    }
    this.#schedule();
  }

  #notifyIdleIfStillEmpty(): void {
    this.#timer = null;
    if (this.#leases.size > 0 || this.#idleNotified) return;
    this.#idleNotified = true;
    this.#onIdle();
  }

  #clearScheduledTimer(): void {
    if (!this.#timer) return;
    this.#clearTimer(this.#timer);
    this.#timer = null;
  }

  #assertId(id: string): void {
    if (!id.trim() || id.length > 200 || /[\x00-\x1f]/u.test(id)) throw new Error("Invalid UI session id");
  }
}
