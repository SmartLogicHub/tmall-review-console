import { describe, expect, it, vi } from "vitest";
import { createForegroundBrowserIdleNotifier } from "./runtime-notices";

describe("foreground browser idle notice", () => {
  it("writes a normal status message at most once per cooldown window", () => {
    let now = 1_000;
    const info = vi.fn();
    const warn = vi.fn();
    const notify = createForegroundBrowserIdleNotifier({
      cooldownMs: 15 * 60_000,
      now: () => now,
      console: { info, warn },
    });

    notify();
    now += 60_000;
    notify();

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("Foreground browser session expired; local service remains available until the launcher is closed");
    expect(warn).not.toHaveBeenCalled();

    now += 15 * 60_000;
    notify();
    expect(info).toHaveBeenCalledTimes(2);
  });
});
