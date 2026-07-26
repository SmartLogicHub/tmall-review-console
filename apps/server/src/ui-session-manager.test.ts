import { afterEach, describe, expect, it, vi } from "vitest";
import { UiSessionManager } from "./ui-session-manager";

describe("UiSessionManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a browser session alive when its heartbeat renews the lease, then notifies once after it expires", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const manager = new UiSessionManager({ leaseMs: 15_000, onIdle });

    manager.register("console-tab");
    vi.advanceTimersByTime(14_000);
    manager.heartbeat("console-tab");

    vi.advanceTimersByTime(14_999);
    expect(onIdle).not.toHaveBeenCalled();
    expect(manager.activeCount()).toBe(1);

    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(manager.activeCount()).toBe(0);

    vi.advanceTimersByTime(60_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending idle shutdown when a new browser session registers", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const manager = new UiSessionManager({ leaseMs: 15_000, onIdle });

    manager.register("first-tab");
    manager.close("first-tab");
    manager.register("replacement-tab");

    vi.advanceTimersByTime(14_999);
    expect(onIdle).not.toHaveBeenCalled();
    expect(manager.activeCount()).toBe(1);
  });
});
