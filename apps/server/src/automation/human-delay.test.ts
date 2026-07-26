import { describe, expect, it } from "vitest";
import {
  TMALL_ACTION_DELAY_RANGES,
  TMALL_BROWSER_PACING_CONFIG,
  humanClick,
  humanDelay,
  humanType,
  randomViewport,
} from "./human-delay";

describe("human browser pacing", () => {
  it("publishes every base input, click and viewport boundary from one immutable config", () => {
    expect(TMALL_BROWSER_PACING_CONFIG).toEqual({
      inputFocus: [200, 500],
      characterDelay: [60, 180],
      thinkProbability: 0.08,
      thinkPause: [300, 800],
      clickBefore: [150, 600],
      clickAfter: [200, 500],
      viewportWidthOffset: [-120, 120],
      viewportHeightOffset: [-80, 80],
      actions: TMALL_ACTION_DELAY_RANGES,
    });
    expect(Object.isFrozen(TMALL_BROWSER_PACING_CONFIG)).toBe(true);
    expect(Object.values(TMALL_BROWSER_PACING_CONFIG).every((value) => typeof value === "number" || Object.isFrozen(value))).toBe(true);
  });

  it("publishes every approved action delay range from one immutable table", () => {
    expect(TMALL_ACTION_DELAY_RANGES).toEqual({
      paginationAfter: [1_500, 3_500],
      directNavigationAfter: [1_000, 2_500],
      replyOpenAfter: [500, 1_200],
      editorFocusAfter: [300, 700],
      replyFillAfter: [50, 150],
      submitAfter: [500, 1_000],
      successPoll: [400, 800],
      loginFieldGap: [300, 800],
      loginSubmitBefore: [500, 1_200],
      loginSubmitAfter: [1_500, 3_000],
      tradeNavigationAfter: [800, 2_000],
      reviewNavigationAfter: [500, 1_500],
      filterAfter: [400, 1_000],
      reviewInterItem: [500, 1_200],
    });
    expect(Object.isFrozen(TMALL_ACTION_DELAY_RANGES)).toBe(true);
    expect(Object.values(TMALL_ACTION_DELAY_RANGES).every(Object.isFrozen)).toBe(true);
  });

  it("uses injected randomness and wait without touching the real clock", async () => {
    const waits: number[] = [];
    await humanDelay(100, 200, {
      random: () => 0.5,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(waits).toEqual([150]);
  });

  it.each([
    [Number.NaN, 10],
    [0, Number.POSITIVE_INFINITY],
    [1.5, 10],
    [-1, 10],
    [11, 10],
    [0, 120_001],
  ])("rejects an unsafe delay range %s..%s before waiting", async (minMs, maxMs) => {
    let waited = false;
    await expect(humanDelay(minMs, maxMs, {
      random: () => 0,
      wait: async () => { waited = true; },
    })).rejects.toThrow("延迟范围");
    expect(waited).toBe(false);
  });

  it.each([Number.NaN, -0.01, 1, Number.POSITIVE_INFINITY])("rejects an invalid injected random value %s", async (value) => {
    await expect(humanDelay(1, 2, {
      random: () => value,
      wait: async () => undefined,
    })).rejects.toThrow("随机源");
  });

  it("clears, types one character at a time, waits in approved ranges and verifies the final value", async () => {
    const calls: string[] = [];
    const waits: number[] = [];
    let value = "old value";
    const locator = {
      click: async () => { calls.push("click"); },
      fill: async (next: string) => { calls.push(`fill:${next}`); value = next; },
      pressSequentially: async (character: string, options: { delay: number }) => {
        calls.push(`type:${character}:${options.delay}`);
        value += character;
      },
      inputValue: async () => value,
    } as unknown as Parameters<typeof humanType>[0];

    await humanType(locator, "ab", {
      random: () => 0,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });

    expect(calls).toEqual(["click", "fill:", "type:a:60", "type:b:60"]);
    expect(waits).toEqual([200, 300, 300]);
  });

  it.each([
    [0, 200],
    [0.999_999, 500],
  ])("honors the input-focus boundary for random=%s", async (randomValue, expectedWait) => {
    const waits: number[] = [];
    const locator = {
      click: async () => undefined,
      fill: async () => undefined,
      pressSequentially: async () => undefined,
      inputValue: async () => "",
    } as unknown as Parameters<typeof humanType>[0];
    await humanType(locator, "", { random: () => randomValue, wait: async (milliseconds) => { waits.push(milliseconds); } });
    expect(waits).toEqual([expectedWait]);
  });

  it.each([
    [0, 60],
    [0.999_999, 180],
  ])("honors the per-character delay boundary for random=%s", async (characterRandom, expectedDelay) => {
    const randomValues = [0, 0.08, characterRandom];
    let index = 0;
    let value = "";
    const delays: number[] = [];
    const locator = {
      click: async () => undefined,
      fill: async () => { value = ""; },
      pressSequentially: async (character: string, options: { delay: number }) => { value += character; delays.push(options.delay); },
      inputValue: async () => value,
    } as unknown as Parameters<typeof humanType>[0];
    await humanType(locator, "a", { random: () => randomValues[index++] ?? 0, wait: async () => undefined });
    expect(delays).toEqual([expectedDelay]);
  });

  it.each([
    [0.0799, true],
    [0.08, false],
  ])("uses an exact 8 percent think-pause boundary for random=%s", async (probabilitySample, shouldPause) => {
    const randomValues = [0, probabilitySample, 0, 0];
    let index = 0;
    let value = "";
    const waits: number[] = [];
    const locator = {
      click: async () => undefined,
      fill: async () => { value = ""; },
      pressSequentially: async (character: string) => { value += character; },
      inputValue: async () => value,
    } as unknown as Parameters<typeof humanType>[0];
    await humanType(locator, "a", {
      random: () => randomValues[index++] ?? 0,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(waits).toEqual(shouldPause ? [200, 300] : [200]);
  });

  it.each([
    [0, 300],
    [0.999_999, 800],
  ])("honors the think-pause delay boundary for random=%s", async (pauseRandom, expectedPause) => {
    const randomValues = [0, 0, pauseRandom, 0];
    let index = 0;
    let value = "";
    const waits: number[] = [];
    const locator = {
      click: async () => undefined,
      fill: async () => { value = ""; },
      pressSequentially: async (character: string) => { value += character; },
      inputValue: async () => value,
    } as unknown as Parameters<typeof humanType>[0];
    await humanType(locator, "a", {
      random: () => randomValues[index++] ?? 0,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(waits).toEqual([200, expectedPause]);
  });

  it("redacts the typed value when final input verification fails", async () => {
    const secret = "sensitive-password";
    const locator = {
      click: async () => undefined,
      fill: async () => undefined,
      pressSequentially: async () => undefined,
      inputValue: async () => "different",
    } as unknown as Parameters<typeof humanType>[0];

    let caught: unknown;
    try {
      await humanType(locator, secret, { random: () => 0.5, wait: async () => undefined });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(secret);
  });

  it("waits before and after a click using injected dependencies", async () => {
    const events: string[] = [];
    const locator = { click: async () => { events.push("click"); } } as unknown as Parameters<typeof humanClick>[0];
    await humanClick(locator, {
      random: () => 0,
      wait: async (milliseconds) => { events.push(`wait:${milliseconds}`); },
    });
    expect(events).toEqual(["wait:150", "click", "wait:200"]);
  });

  it("retains the underlying click failure as a cause while keeping the user-facing error safe", async () => {
    const rootCause = new Error("locator received events from an overlapping dialog");
    const locator = { click: async () => { throw rootCause; } } as unknown as Parameters<typeof humanClick>[0];

    await expect(humanClick(locator, { random: () => 0, wait: async () => undefined }))
      .rejects.toMatchObject({ cause: rootCause });
  });

  it.each([
    [[0, 0], [150, 200]],
    [[0.999_999, 0.999_999], [600, 500]],
  ] as const)("honors both click delay boundaries for random=%s", async (randomValues, expectedWaits) => {
    let index = 0;
    const waits: number[] = [];
    const locator = { click: async () => undefined } as unknown as Parameters<typeof humanClick>[0];
    await humanClick(locator, {
      random: () => randomValues[index++] ?? 0,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(waits).toEqual(expectedWaits);
  });

  it("randomizes the viewport within approved offsets and enforces safe lower bounds", () => {
    expect(randomViewport(1_440, 900, { random: () => 0 })).toEqual({ width: 1_320, height: 820 });
    expect(randomViewport(100, 100, { random: () => 0 })).toEqual({ width: 800, height: 600 });
    expect(() => randomViewport(Number.NaN, 900, { random: () => 0 })).toThrow("视口");
  });

  it.each([
    [[0, 0], { width: 1_320, height: 820 }],
    [[0.999_999, 0.999_999], { width: 1_560, height: 980 }],
  ] as const)("honors both viewport offset boundaries for random=%s", (randomValues, expectedViewport) => {
    let index = 0;
    expect(randomViewport(1_440, 900, { random: () => randomValues[index++] ?? 0 })).toEqual(expectedViewport);
  });
});
