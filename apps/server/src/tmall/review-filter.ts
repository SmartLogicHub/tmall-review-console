import { isReviewedAtWithinScope, type ResolvedReviewScope } from "@tmall/domain";
import type { TmallReviewSnapshot } from "./review-reader";

export type ReviewFilterToggle = "buyer" | "content" | "unanswered" | "followup";
export type ReviewFilterMode = "followup_only" | "content_unanswered";
export type ReviewScanPhase = "initial" | "followup";

export interface ReviewFilterAdapter {
  assertSafePage(): Promise<void>;
  readToggle(toggle: ReviewFilterToggle): Promise<{ matches: number; selected: boolean | null }>;
  clickToggle(toggle: ReviewFilterToggle): Promise<void>;
  readDateRange(): Promise<{ matches: number; startDate: string | null; endDate: string | null }>;
  selectPreset(preset: "today" | "yesterday" | "last7" | "last30"): Promise<void>;
  openCustomCalendar(): Promise<void>;
  closeDatePicker(): Promise<void>;
  readVisibleCalendarMonths(): Promise<string[]>;
  moveCalendar(direction: "previous" | "next"): Promise<void>;
  selectCalendarDate(date: string): Promise<void>;
  clickSearch(scope: ResolvedReviewScope): Promise<void>;
}

export class ReviewFilterStateError extends Error {
  constructor(
    readonly operationKey: string,
    message: string,
  ) {
    super(message);
    this.name = "ReviewFilterStateError";
  }
}

const ALL_TOGGLES: readonly ReviewFilterToggle[] = ["buyer", "content", "unanswered", "followup"];
const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const MAX_CALENDAR_MOVES = 36;

export function assertReviewSnapshotsWithinScope(
  snapshots: readonly TmallReviewSnapshot[],
  scope: ResolvedReviewScope,
): void {
  for (const [index, snapshot] of snapshots.entries()) {
    if (!snapshot.reviewedAt || !isReviewedAtWithinScope(snapshot.reviewedAt, scope)) {
      throw new ReviewFilterStateError(
        "review.date.result",
        `第 ${index + 1} 条评价时间缺失、格式无效或不在当前处理日期内`,
      );
    }
  }
}

export async function verifyReviewFilters(
  adapter: ReviewFilterAdapter,
  scope: ResolvedReviewScope,
  phase: ReviewScanPhase = "initial",
  mode: ReviewFilterMode = "content_unanswered",
): Promise<void> {
  await adapter.assertSafePage();
  const required = requiredToggles(phase, mode);
  for (const toggle of ALL_TOGGLES) {
    const state = await adapter.readToggle(toggle);
    assertUniqueToggleState(toggle, state);
    if (state.selected !== required.includes(toggle)) {
      throw new ReviewFilterStateError(toggleOperationKey(toggle), `天猫评价筛选“${toggleLabel(toggle)}”未选中`);
    }
  }

  const date = await adapter.readDateRange();
  if (date.matches !== 1) {
    throw new ReviewFilterStateError("review.date.trigger", "天猫评价日期筛选无法唯一识别");
  }
  if (date.startDate !== scope.startDate || date.endDate !== scope.endDate) {
    throw new ReviewFilterStateError("review.date.trigger", "天猫评价日期范围未正确生效");
  }
}

export async function applyReviewFilters(
  adapter: ReviewFilterAdapter,
  scope: ResolvedReviewScope,
  phase: ReviewScanPhase = "initial",
  mode: ReviewFilterMode = "content_unanswered",
): Promise<boolean> {
  await adapter.assertSafePage();
  let changed = false;

  // Freeze the run's date boundary first. Switching content/reply modes can
  // refresh the list, but must never cause the calendar to be reopened or the
  // date boundary to drift later in the same run.
  const currentDate = await adapter.readDateRange();
  if (currentDate.matches !== 1) {
    throw new ReviewFilterStateError("review.date.trigger", "天猫评价日期筛选无法唯一识别");
  }

  const dateAlreadyApplied = currentDate.startDate === scope.startDate && currentDate.endDate === scope.endDate;
  if (!dateAlreadyApplied) {
    changed = true;
    if (scope.preset === "custom") {
      await applyCustomRange(adapter, scope);
      await adapter.closeDatePicker();
      await adapter.clickSearch(scope);
      await adapter.assertSafePage();
    } else {
      await adapter.selectPreset(scope.preset);
      await adapter.assertSafePage();
      await adapter.closeDatePicker();
      await adapter.clickSearch(scope);
      await adapter.assertSafePage();

      // Platform shortcuts can use a different inclusive-day definition.
      // Keep the shortcut for normal cases, but never accept dates that differ
      // from the run's frozen scope: switch to the exact custom range instead.
      const nativeResult = await adapter.readDateRange();
      if (nativeResult.matches !== 1) {
        throw new ReviewFilterStateError("review.date.trigger", "天猫评价日期筛选无法唯一识别");
      }
      if (nativeResult.startDate !== scope.startDate || nativeResult.endDate !== scope.endDate) {
        await applyCustomRange(adapter, scope);
        await adapter.closeDatePicker();
        await adapter.clickSearch(scope);
        await adapter.assertSafePage();
      }
    }
  }

  const required = requiredToggles(phase, mode);
  for (const toggle of ALL_TOGGLES) {
    const before = await adapter.readToggle(toggle);
    assertUniqueToggleState(toggle, before);
    if (before.selected === required.includes(toggle)) continue;

    await adapter.clickToggle(toggle);
    changed = true;
    await adapter.assertSafePage();
    const after = await adapter.readToggle(toggle);
    assertUniqueToggleState(toggle, after);
    if (after.selected !== required.includes(toggle)) {
      throw new ReviewFilterStateError(toggleOperationKey(toggle), `天猫评价筛选“${toggleLabel(toggle)}”点击后未生效`);
    }
  }

  // The platform can leave its calendar panel open even after the date range
  // has already been applied.  That panel intercepts the subsequent reply or
  // complaint controls, so always close it before inspecting the queue.
  await adapter.closeDatePicker();

  await verifyReviewFilters(adapter, scope, phase, mode);
  return changed;
}

async function applyCustomRange(adapter: ReviewFilterAdapter, scope: ResolvedReviewScope): Promise<void> {
  await adapter.openCustomCalendar();
  await adapter.assertSafePage();

  await makeMonthVisible(adapter, scope.startDate.slice(0, 7));
  await adapter.selectCalendarDate(scope.startDate);
  await adapter.assertSafePage();

  if (scope.startDate === scope.endDate) {
    const sameDay = await adapter.readDateRange();
    if (sameDay.matches === 1 && sameDay.startDate === scope.startDate && sameDay.endDate === scope.endDate) return;
  }

  await adapter.openCustomCalendar();
  await adapter.assertSafePage();
  await makeMonthVisible(adapter, scope.endDate.slice(0, 7));
  await adapter.selectCalendarDate(scope.endDate);
  await adapter.assertSafePage();
}

async function makeMonthVisible(adapter: ReviewFilterAdapter, targetMonth: string): Promise<void> {
  for (let moves = 0; moves <= MAX_CALENDAR_MOVES; moves += 1) {
    const visibleMonths = await readValidVisibleMonths(adapter);
    if (visibleMonths.includes(targetMonth)) return;
    if (moves === MAX_CALENDAR_MOVES) break;

    const direction = targetMonth < visibleMonths[0]! ? "previous" : "next";
    await adapter.moveCalendar(direction);
    await adapter.assertSafePage();
  }
  throw new ReviewFilterStateError("review.date.trigger", "无法在日历中定位目标月份");
}

async function readValidVisibleMonths(adapter: ReviewFilterAdapter): Promise<string[]> {
  const months = await adapter.readVisibleCalendarMonths();
  const unique = [...new Set(months)].sort();
  if (unique.length === 0 || unique.length > 2 || unique.some((month) => !MONTH_PATTERN.test(month))) {
    throw new ReviewFilterStateError("review.date.trigger", "天猫评价日历月份状态无法安全确认");
  }
  return unique;
}

function assertUniqueToggleState(
  toggle: ReviewFilterToggle,
  state: { matches: number; selected: boolean | null },
): asserts state is { matches: 1; selected: boolean } {
  if (state.matches !== 1 || state.selected === null) {
    throw new ReviewFilterStateError(toggleOperationKey(toggle), `天猫评价筛选“${toggleLabel(toggle)}”状态无法安全确认`);
  }
}

function toggleOperationKey(toggle: ReviewFilterToggle): string {
  return `review.filter.${toggle}`;
}

function toggleLabel(toggle: ReviewFilterToggle): string {
  if (toggle === "buyer") return "来自买家的评价";
  if (toggle === "content") return "有内容";
  if (toggle === "followup") return "有追评";
  return "未回复";
}

export function requiredToggles(phase: ReviewScanPhase, mode: ReviewFilterMode): readonly ReviewFilterToggle[] {
  // The follow-up filter must stand alone: combining it with content or
  // unanswered makes some rows disappear before the per-row reply-action check.
  if (phase === "followup") return ["buyer", "followup"];
  if (mode === "followup_only") return ["buyer", "followup"];
  return ["buyer", "content", "unanswered"];
}
