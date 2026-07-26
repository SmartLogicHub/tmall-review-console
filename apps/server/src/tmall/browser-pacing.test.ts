import { describe, expect, it } from "vitest";
import {
  enterTextWithStablePacing,
  TMALL_PACING,
  waitForExplicitOutcome,
} from "./browser-pacing";

type TextControlCall =
  | ["fill", string]
  | ["pressSequentially", string, { delay: number }];

class FakeTextControl {
  readonly calls: TextControlCall[] = [];
  finalValue = "";

  async fill(value: string): Promise<void> {
    this.calls.push(["fill", value]);
    this.finalValue = value;
  }

  async pressSequentially(value: string, options: { delay: number }): Promise<void> {
    this.calls.push(["pressSequentially", value, options]);
    this.finalValue += value;
  }

  async inputValue(): Promise<string> {
    return this.finalValue;
  }
}

describe("deterministic Tmall browser pacing", () => {
  it("clears a text control before entering characters in order with a fixed delay", async () => {
    const control = new FakeTextControl();

    await enterTextWithStablePacing(control, "账号");

    expect(control.calls).toEqual([
      ["fill", ""],
      ["pressSequentially", "账号", { delay: 80 }],
    ]);
  });

  it("rejects a final value mismatch without exposing the input value", async () => {
    const control = new FakeTextControl();
    const sensitiveValue = "private-password-123";
    control.inputValue = async () => "different-value";

    const error = await enterTextWithStablePacing(control, sensitiveValue).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Tmall text entry verification failed");
    expect((error as Error).message).not.toContain(sensitiveValue);
  });

  it("exposes fixed readonly action timing slots", () => {
    expect(TMALL_PACING).toEqual({
      character: 80,
      field: 400,
      navigation: 300,
      filter: 500,
      list: 800,
    });
    expect(Object.isFrozen(TMALL_PACING)).toBe(true);
  });

  it("stops waiting as soon as the probe reports an explicit outcome", async () => {
    const waits: number[] = [];
    let probeCalls = 0;
    let nowMs = 0;

    const result = await waitForExplicitOutcome({
      now: () => nowMs,
      probe: async () => {
        probeCalls += 1;
        return probeCalls === 2 ? { state: "authenticated" as const } : null;
      },
      wait: async (durationMs) => {
        waits.push(durationMs);
        nowMs += durationMs;
      },
      timeoutMs: 100,
      pollMs: 25,
    });

    expect(result).toEqual({ state: "authenticated" });
    expect(probeCalls).toBe(2);
    expect(waits).toEqual([25]);
  });

  it("returns timed_out exactly at the configured upper bound", async () => {
    const waits: number[] = [];
    let probeCalls = 0;
    let nowMs = 0;

    const result = await waitForExplicitOutcome({
      now: () => nowMs,
      probe: async () => {
        probeCalls += 1;
        return null;
      },
      wait: async (durationMs) => {
        waits.push(durationMs);
        nowMs += durationMs;
      },
      timeoutMs: 100,
      pollMs: 40,
    });

    expect(result).toBe("timed_out");
    expect(probeCalls).toBe(3);
    expect(waits).toEqual([40, 40, 20]);
    expect(waits.reduce((total, durationMs) => total + durationMs, 0)).toBe(100);
  });

  it.each([
    ["zero poll duration", { timeoutMs: 100, pollMs: 0 }],
    ["negative poll duration", { timeoutMs: 100, pollMs: -1 }],
    ["infinite poll duration", { timeoutMs: 100, pollMs: Number.POSITIVE_INFINITY }],
    ["NaN poll duration", { timeoutMs: 100, pollMs: Number.NaN }],
    ["negative timeout", { timeoutMs: -1, pollMs: 10 }],
    ["infinite timeout", { timeoutMs: Number.POSITIVE_INFINITY, pollMs: 10 }],
    ["NaN timeout", { timeoutMs: Number.NaN, pollMs: 10 }],
  ])("rejects %s before invoking browser callbacks", async (_name, timing) => {
    let probeCalls = 0;
    let waitCalls = 0;

    const error = await waitForExplicitOutcome({
      probe: async () => {
        probeCalls += 1;
        return { state: "authenticated" as const };
      },
      wait: async () => {
        waitCalls += 1;
      },
      ...timing,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Invalid Tmall browser pacing configuration");
    expect(probeCalls).toBe(0);
    expect(waitCalls).toBe(0);
  });

  it("counts slow probe time against the timeout upper bound", async () => {
    const waits: number[] = [];
    let probeCalls = 0;
    let nowMs = 0;

    const result = await waitForExplicitOutcome({
      now: () => nowMs,
      probe: async () => {
        probeCalls += 1;
        nowMs += 70;
        return null;
      },
      wait: async (durationMs) => {
        waits.push(durationMs);
        nowMs += durationMs;
      },
      timeoutMs: 100,
      pollMs: 80,
    });

    expect(result).toBe("timed_out");
    expect(probeCalls).toBe(1);
    expect(waits).toEqual([30]);
    expect(nowMs).toBe(100);
  });
});
