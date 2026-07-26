export const REVIEW_SCOPE_PRESETS = ["today", "yesterday", "last7", "last30", "custom"] as const;

export type ReviewScopePreset = (typeof REVIEW_SCOPE_PRESETS)[number];

export interface ReviewScopeConfig {
  preset?: ReviewScopePreset;
  startDate?: string;
  endDate?: string;
}

export interface ResolvedReviewScope {
  preset: ReviewScopePreset;
  timezone: "Asia/Shanghai";
  startDate: string;
  endDate: string;
  startsAt: Date;
  endsAt: Date;
}

const SHANGHAI_OFFSET_MINUTES = 8 * 60;
const SHANGHAI_OFFSET_MS = SHANGHAI_OFFSET_MINUTES * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const OFFSET_LESS_REVIEWED_AT_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/u;
const EXPLICIT_ZONE_REVIEWED_AT_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;

function parseCalendarDate(value: string): Date {
  if (!DATE_PATTERN.test(value)) throw new Error("Invalid date: expected YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
}

function formatCalendarDate(utcMidnightMs: number): string {
  return new Date(utcMidnightMs).toISOString().slice(0, 10);
}

function shanghaiCalendarDate(now: Date): string {
  if (Number.isNaN(now.getTime())) throw new Error("Invalid current date");
  return formatCalendarDate(now.getTime() + SHANGHAI_OFFSET_MS);
}

export function validateReviewScopeInput(input: unknown = {}): ReviewScopeConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Review scope must be an object");
  }

  const record = input as Record<string, unknown>;
  const preset = record.preset ?? "last7";
  if (typeof preset !== "string" || !(REVIEW_SCOPE_PRESETS as readonly string[]).includes(preset)) {
    throw new Error("Invalid review scope preset");
  }
  if (preset !== "custom") return { preset: preset as ReviewScopePreset };

  if (typeof record.startDate !== "string" || typeof record.endDate !== "string") {
    throw new Error("Custom review scope requires start and end dates");
  }
  const start = parseCalendarDate(record.startDate);
  const end = parseCalendarDate(record.endDate);
  if (start.getTime() > end.getTime()) throw new Error("Start date must not be after end date");

  const inclusiveDays = Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
  if (inclusiveDays > 90) throw new Error("Review scope cannot exceed 90 days");

  return { preset: "custom", startDate: record.startDate, endDate: record.endDate };
}

export function resolveReviewScope(input: ReviewScopeConfig, now: Date): ResolvedReviewScope {
  const config = validateReviewScopeInput(input);
  const preset = config.preset ?? "last7";
  let startDate: string;
  let endDate: string;

  if (preset === "custom") {
    startDate = config.startDate!;
    endDate = config.endDate!;
  } else {
    const today = parseCalendarDate(shanghaiCalendarDate(now)).getTime();
    const offsets: Record<Exclude<ReviewScopePreset, "custom">, { start: number; end: number }> = {
      today: { start: 0, end: 0 },
      yesterday: { start: 1, end: 1 },
      last7: { start: 6, end: 0 },
      last30: { start: 29, end: 0 },
    };
    startDate = formatCalendarDate(today - offsets[preset].start * DAY_MS);
    endDate = formatCalendarDate(today - offsets[preset].end * DAY_MS);
  }

  const startUtcMidnight = parseCalendarDate(startDate).getTime();
  const endUtcMidnight = parseCalendarDate(endDate).getTime();
  return {
    preset,
    timezone: "Asia/Shanghai",
    startDate,
    endDate,
    startsAt: new Date(startUtcMidnight - SHANGHAI_OFFSET_MS),
    endsAt: new Date(endUtcMidnight - SHANGHAI_OFFSET_MS + DAY_MS - 1),
  };
}

export function isReviewedAtWithinScope(
  reviewedAt: Date | string,
  scope: ResolvedReviewScope,
): boolean {
  const time = reviewedAt instanceof Date ? reviewedAt.getTime() : parseReviewedAtString(reviewedAt);
  return time !== null
    && !Number.isNaN(time)
    && time >= scope.startsAt.getTime()
    && time <= scope.endsAt.getTime();
}

function reviewedAtInstant(
  date: string,
  hoursText: string,
  minutesText: string,
  secondsText: string,
  milliseconds: number,
  offsetMinutes: number,
): number | null {
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  try {
    return parseCalendarDate(date).getTime()
      + ((hours * 60 + minutes) * 60 + seconds) * 1000
      + milliseconds
      - offsetMinutes * 60 * 1000;
  } catch {
    return null;
  }
}

function parseReviewedAtString(value: string): number | null {
  const offsetLess = OFFSET_LESS_REVIEWED_AT_PATTERN.exec(value);
  if (offsetLess) {
    const [, date, hours, minutes, seconds = "00"] = offsetLess;
    return reviewedAtInstant(date!, hours!, minutes!, seconds, 0, SHANGHAI_OFFSET_MINUTES);
  }

  const explicitZone = EXPLICIT_ZONE_REVIEWED_AT_PATTERN.exec(value);
  if (!explicitZone) return null;
  const [, date, hours, minutes, seconds, fraction = "", zone] = explicitZone;
  const milliseconds = fraction.length === 0 ? 0 : Number(fraction.padEnd(3, "0").slice(0, 3));
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHours = Number(zone!.slice(1, 3));
    const offsetMinutePart = Number(zone!.slice(4, 6));
    if (offsetHours > 23 || offsetMinutePart > 59) return null;
    offsetMinutes = (zone![0] === "+" ? 1 : -1) * (offsetHours * 60 + offsetMinutePart);
  }
  return reviewedAtInstant(date!, hours!, minutes!, seconds!, milliseconds, offsetMinutes);
}

export function formatReviewScopeSummary(scope: ResolvedReviewScope): string {
  const labels: Record<ReviewScopePreset, string> = {
    today: "今天",
    yesterday: "昨天",
    last7: "最近7天",
    last30: "最近30天",
    custom: "自定义",
  };
  return `${labels[scope.preset]}（${scope.startDate} 至 ${scope.endDate}）`;
}
