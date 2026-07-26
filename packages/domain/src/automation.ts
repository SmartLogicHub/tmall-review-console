export const AUTOMATION_STATES = [
  "disabled",
  "waiting",
  "running",
  "paused",
  "stopping",
  "manual_action_required",
  "error",
] as const;

export type AutomationState = (typeof AUTOMATION_STATES)[number];
export type AutomationTrigger = "scheduled" | "manual";

export interface ScheduleWindow {
  id: string;
  start: string;
  end: string;
}

export interface AutomationPlan {
  enabled: boolean;
  paused: boolean;
  timezone: "Asia/Shanghai";
  intervalMinutes: number;
  windows: ScheduleWindow[];
}

export interface AutomationPlanInput {
  enabled?: boolean;
  paused?: boolean;
  intervalMinutes?: number;
  windows?: Array<Partial<ScheduleWindow>>;
}

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export function timeToMinutes(value: string): number {
  if (!TIME_PATTERN.test(value)) throw new Error("时间必须使用HH:mm格式");
  const [hours, minutes] = value.split(":").map(Number);
  return hours! * 60 + minutes!;
}

export function minutesToTime(value: number): string {
  const safe = Math.max(0, Math.min(1439, Math.trunc(value)));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

export function validateAutomationPlan(input: AutomationPlanInput): AutomationPlan {
  const intervalMinutes = Number(input.intervalMinutes ?? 15);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 120) {
    throw new Error("运行间隔必须在1到120分钟之间");
  }
  const windows = (input.windows ?? []).map((item, index) => {
    const id = String(item.id ?? `window-${index + 1}`).trim();
    const start = String(item.start ?? "");
    const end = String(item.end ?? "");
    if (!id || id.length > 80) throw new Error("时间段标识无效");
    const startMinute = timeToMinutes(start);
    const endMinute = timeToMinutes(end);
    if (endMinute <= startMinute) throw new Error("结束时间必须晚于开始时间，不支持跨天时间段");
    return { id, start, end, startMinute, endMinute };
  }).sort((left, right) => left.startMinute - right.startMinute);
  if (new Set(windows.map((window) => window.id)).size !== windows.length) throw new Error("时间段标识不能重复");
  for (let index = 1; index < windows.length; index += 1) {
    if (windows[index]!.startMinute < windows[index - 1]!.endMinute) throw new Error("时间段不能重叠");
  }
  return {
    enabled: Boolean(input.enabled) && windows.length > 0,
    paused: Boolean(input.paused),
    timezone: "Asia/Shanghai",
    intervalMinutes,
    windows: windows.map(({ id, start, end }) => ({ id, start, end })),
  };
}

function chinaDateParts(now: Date): { year: number; month: number; day: number; minuteOfDay: number } {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function chinaLocalInstant(year: number, month: number, day: number, minute: number): Date {
  return new Date(Date.UTC(year, month, day, 0, minute) - 8 * 60 * 60 * 1000);
}

export function evaluateAutomationSchedule(plan: AutomationPlan, now = new Date()): {
  insideWindow: boolean;
  currentWindow: ScheduleWindow | null;
  currentWindowEnd: Date | null;
  nextWindowStart: Date | null;
} {
  if (!plan.enabled || plan.paused || plan.windows.length === 0) {
    return { insideWindow: false, currentWindow: null, currentWindowEnd: null, nextWindowStart: null };
  }
  const parts = chinaDateParts(now);
  const expanded = plan.windows.map((window) => ({ ...window, startMinute: timeToMinutes(window.start), endMinute: timeToMinutes(window.end) }));
  const current = expanded.find((window) => parts.minuteOfDay >= window.startMinute && parts.minuteOfDay < window.endMinute);
  if (current) {
    return {
      insideWindow: true,
      currentWindow: { id: current.id, start: current.start, end: current.end },
      currentWindowEnd: chinaLocalInstant(parts.year, parts.month, parts.day, current.endMinute),
      nextWindowStart: null,
    };
  }
  const laterToday = expanded.find((window) => window.startMinute > parts.minuteOfDay);
  if (laterToday) {
    return {
      insideWindow: false,
      currentWindow: null,
      currentWindowEnd: null,
      nextWindowStart: chinaLocalInstant(parts.year, parts.month, parts.day, laterToday.startMinute),
    };
  }
  const first = expanded[0]!;
  return {
    insideWindow: false,
    currentWindow: null,
    currentWindowEnd: null,
    nextWindowStart: chinaLocalInstant(parts.year, parts.month, parts.day + 1, first.startMinute),
  };
}
