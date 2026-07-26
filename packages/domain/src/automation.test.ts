import { describe, expect, it } from "vitest";
import { evaluateAutomationSchedule, validateAutomationPlan } from "./automation";

describe("automation plan", () => {
  it("normalizes multiple daily windows and disables an empty plan", () => {
    expect(validateAutomationPlan({ enabled: true, intervalMinutes: 15, windows: [] })).toMatchObject({ enabled: false, intervalMinutes: 15, windows: [] });
    expect(validateAutomationPlan({
      enabled: true,
      intervalMinutes: 30,
      windows: [{ id: "late", start: "14:00", end: "16:00" }, { id: "early", start: "08:00", end: "09:00" }],
    }).windows.map((window) => window.id)).toEqual(["early", "late"]);
  });

  it.each([
    [{ enabled: true, intervalMinutes: 0, windows: [] }, "运行间隔必须在1到120分钟之间"],
    [{ enabled: true, intervalMinutes: 15, windows: [{ id: "x", start: "09:00", end: "08:00" }] }, "结束时间必须晚于开始时间"],
    [{ enabled: true, intervalMinutes: 15, windows: [{ id: "a", start: "08:00", end: "10:00" }, { id: "b", start: "09:30", end: "11:00" }] }, "时间段不能重叠"],
  ])("rejects invalid schedule %#", (input, message) => {
    expect(() => validateAutomationPlan(input)).toThrow(message as string);
  });

  it("starts immediately inside a China-time window and finds the next window outside it", () => {
    const plan = validateAutomationPlan({ enabled: true, intervalMinutes: 20, windows: [{ id: "morning", start: "08:00", end: "09:00" }, { id: "evening", start: "18:00", end: "19:00" }] });
    expect(evaluateAutomationSchedule(plan, new Date("2026-07-14T00:15:00.000Z"))).toMatchObject({ insideWindow: true, currentWindow: { id: "morning" } });
    const waiting = evaluateAutomationSchedule(plan, new Date("2026-07-14T02:00:00.000Z"));
    expect(waiting.insideWindow).toBe(false);
    expect(waiting.nextWindowStart?.toISOString()).toBe("2026-07-14T10:00:00.000Z");
  });
});
