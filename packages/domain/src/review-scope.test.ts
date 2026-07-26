import { describe, expect, it } from "vitest";
import {
  formatReviewScopeSummary,
  isReviewedAtWithinScope,
  resolveReviewScope,
  validateReviewScopeInput,
  type ReviewScopePreset,
} from "./review-scope";

const NOW = new Date("2026-07-14T12:00:00+08:00");

function withNonShanghaiServerTimezone(callback: () => void): void {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    callback();
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
}

describe("review scope", () => {
  it("defaults to the last seven Shanghai calendar days", () => {
    expect(validateReviewScopeInput({})).toEqual({ preset: "last7" });

    const scope = resolveReviewScope({}, NOW);
    expect(scope).toMatchObject({
      preset: "last7",
      timezone: "Asia/Shanghai",
      startDate: "2026-07-08",
      endDate: "2026-07-14",
    });
  });

  it.each<{
    preset: ReviewScopePreset;
    startDate: string;
    endDate: string;
    startsAt: string;
    endsAt: string;
  }>([
    {
      preset: "today",
      startDate: "2026-07-14",
      endDate: "2026-07-14",
      startsAt: "2026-07-13T16:00:00.000Z",
      endsAt: "2026-07-14T15:59:59.999Z",
    },
    {
      preset: "yesterday",
      startDate: "2026-07-13",
      endDate: "2026-07-13",
      startsAt: "2026-07-12T16:00:00.000Z",
      endsAt: "2026-07-13T15:59:59.999Z",
    },
    {
      preset: "last7",
      startDate: "2026-07-08",
      endDate: "2026-07-14",
      startsAt: "2026-07-07T16:00:00.000Z",
      endsAt: "2026-07-14T15:59:59.999Z",
    },
    {
      preset: "last30",
      startDate: "2026-06-15",
      endDate: "2026-07-14",
      startsAt: "2026-06-14T16:00:00.000Z",
      endsAt: "2026-07-14T15:59:59.999Z",
    },
  ])("resolves $preset using Asia/Shanghai calendar boundaries", ({ preset, startDate, endDate, startsAt, endsAt }) => {
    const scope = resolveReviewScope({ preset }, NOW);

    expect(scope.startDate).toBe(startDate);
    expect(scope.endDate).toBe(endDate);
    expect(scope.startsAt.toISOString()).toBe(startsAt);
    expect(scope.endsAt.toISOString()).toBe(endsAt);
  });

  it("resolves custom start and end dates inclusively", () => {
    const scope = resolveReviewScope(
      { preset: "custom", startDate: "2026-06-01", endDate: "2026-06-03" },
      NOW,
    );

    expect(scope.startDate).toBe("2026-06-01");
    expect(scope.endDate).toBe("2026-06-03");
    expect(scope.startsAt.toISOString()).toBe("2026-05-31T16:00:00.000Z");
    expect(scope.endsAt.toISOString()).toBe("2026-06-03T15:59:59.999Z");
  });

  it("rejects a custom range whose start is after its end", () => {
    expect(() => validateReviewScopeInput({
      preset: "custom",
      startDate: "2026-07-14",
      endDate: "2026-07-13",
    })).toThrow(/start date/i);
  });

  it("accepts at most 90 inclusive calendar days", () => {
    expect(validateReviewScopeInput({
      preset: "custom",
      startDate: "2026-01-01",
      endDate: "2026-03-31",
    })).toEqual({ preset: "custom", startDate: "2026-01-01", endDate: "2026-03-31" });

    expect(() => validateReviewScopeInput({
      preset: "custom",
      startDate: "2026-01-01",
      endDate: "2026-04-01",
    })).toThrow(/90 days/i);
  });

  it.each([
    { preset: "custom", startDate: "2026/07/01", endDate: "2026-07-14" },
    { preset: "custom", startDate: "2026-02-30", endDate: "2026-03-01" },
    { preset: "custom", startDate: "", endDate: "2026-07-14" },
  ])("rejects invalid custom dates: $startDate", (input) => {
    expect(() => validateReviewScopeInput(input)).toThrow(/date/i);
  });

  it("checks reviewedAt against both inclusive instant boundaries", () => {
    const scope = resolveReviewScope({ preset: "today" }, NOW);

    expect(isReviewedAtWithinScope("2026-07-13T16:00:00.000Z", scope)).toBe(true);
    expect(isReviewedAtWithinScope("2026-07-14T00:00:00+08:00", scope)).toBe(true);
    expect(isReviewedAtWithinScope(new Date("2026-07-14T15:59:59.999Z"), scope)).toBe(true);
    expect(isReviewedAtWithinScope("2026-07-13T15:59:59.999Z", scope)).toBe(false);
    expect(isReviewedAtWithinScope("2026-07-14T16:00:00.000Z", scope)).toBe(false);
    expect(isReviewedAtWithinScope("not-a-date", scope)).toBe(false);
  });

  it.each<{ timestamp: string; expected: boolean }>([
    { timestamp: "2026-07-13 16:00", expected: false },
    { timestamp: "2026-07-13T16:00", expected: false },
    { timestamp: "2026-07-14 00:00:00", expected: true },
    { timestamp: "2026-07-14T00:00:00", expected: true },
    { timestamp: "2026-07-13T16:00:00Z", expected: true },
    { timestamp: "2026-07-14T00:00:00+08:00", expected: true },
    { timestamp: "2026-07-13T16:00:00-07:00", expected: true },
    { timestamp: "2026-07-14T00:00:00+09:00", expected: false },
    { timestamp: "2026-07-13T16:00:00.123Z", expected: true },
    { timestamp: "2026-07-14T00:00:00.123456789+08:00", expected: true },
  ])("strictly interprets supported timestamp $timestamp", ({ timestamp, expected }) => {
    withNonShanghaiServerTimezone(() => {
      const scope = resolveReviewScope({ preset: "today" }, NOW);
      expect(isReviewedAtWithinScope(timestamp, scope)).toBe(expected);
    });
  });

  it.each([
    "2026-07-14",
    "07/14/2026 00:00:00",
    "2026-07-14 00:00:00.123",
    "2026-02-30 12:00:00",
    "2026-02-30T12:00:00Z",
    "2026-07-13T24:00:00-07:00",
    "2026-07-14T23:60:00Z",
    "2026-07-14T00:00:00+24:00",
    "2026-07-14T00:00:00+08:60",
    "2026-07-14T00:00:00+0800",
    "2026-07-14T00:00:00Z ",
    "2026-07-14T00:00:00Zjunk",
  ])("rejects unsupported or invalid timestamp %s", (timestamp) => {
    withNonShanghaiServerTimezone(() => {
      const scope = resolveReviewScope({ preset: "today" }, NOW);
      expect(isReviewedAtWithinScope(timestamp, scope)).toBe(false);
    });
  });

  it("formats a stable human-readable summary", () => {
    const scope = resolveReviewScope({ preset: "last7" }, NOW);
    expect(formatReviewScopeSummary(scope)).toBe("最近7天（2026-07-08 至 2026-07-14）");
  });
});
