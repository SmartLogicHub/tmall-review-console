import { describe, expect, it } from "vitest";
import { resolveReviewScope, type ResolvedReviewScope } from "@tmall/domain";
import {
  applyReviewFilters,
  assertReviewSnapshotsWithinScope,
  verifyReviewFilters,
  ReviewFilterStateError,
  type ReviewFilterAdapter,
  type ReviewFilterToggle,
} from "./review-filter";
import type { TmallReviewSnapshot } from "./review-reader";

const NOW = new Date("2026-07-15T00:30:00.000Z");

class FakeReviewFilterAdapter implements ReviewFilterAdapter {
  readonly actions: string[] = [];
  readonly toggleClicks: ReviewFilterToggle[] = [];
  readonly presetClicks: string[] = [];
  readonly selectedDates: string[] = [];
  readonly monthMoves: Array<"previous" | "next"> = [];
  searchClicks = 0;
  closeDatePickerCalls = 0;
  safeChecks = 0;
  safe = true;
  toggleMatches = 1;
  dateMatches = 1;
  selectedReadable = true;
  applyClicks = true;
  toggles: Record<ReviewFilterToggle, boolean> = {
    buyer: true,
    content: true,
    unanswered: true,
    followup: false,
  };
  startDate = "2026-07-15";
  endDate = "2026-07-15";
  visibleMonths = ["2026-07", "2026-08"];

  async assertSafePage(): Promise<void> {
    this.safeChecks += 1;
    if (!this.safe) throw new ReviewFilterStateError("session.login", "登录状态或页面弹窗不安全");
  }

  async readToggle(toggle: ReviewFilterToggle) {
    return {
      matches: this.toggleMatches,
      selected: this.selectedReadable ? this.toggles[toggle] : null,
    };
  }

  async clickToggle(toggle: ReviewFilterToggle): Promise<void> {
    this.actions.push(`toggle:${toggle}`);
    this.toggleClicks.push(toggle);
    if (this.applyClicks) this.toggles[toggle] = !this.toggles[toggle];
  }

  async readDateRange() {
    return { matches: this.dateMatches, startDate: this.startDate, endDate: this.endDate };
  }

  async selectPreset(preset: "today" | "yesterday" | "last7" | "last30"): Promise<void> {
    this.presetClicks.push(preset);
  }

  async openCustomCalendar(): Promise<void> {}

  async closeDatePicker(): Promise<void> {
    this.closeDatePickerCalls += 1;
  }

  async readVisibleCalendarMonths(): Promise<string[]> {
    return [...this.visibleMonths];
  }

  async moveCalendar(direction: "previous" | "next"): Promise<void> {
    this.monthMoves.push(direction);
    const delta = direction === "previous" ? -1 : 1;
    this.visibleMonths = this.visibleMonths.map((month) => {
      const [year, value] = month.split("-").map(Number);
      const shifted = new Date(Date.UTC(year!, value! - 1 + delta, 1));
      return shifted.toISOString().slice(0, 7);
    });
  }

  async selectCalendarDate(date: string): Promise<void> {
    this.selectedDates.push(date);
  }

  async clickSearch(scope: ResolvedReviewScope): Promise<void> {
    this.actions.push("search");
    this.searchClicks += 1;
    if (this.applyClicks) {
      this.startDate = scope.startDate;
      this.endDate = scope.endDate;
    }
  }
}

function scope(preset: "today" | "yesterday" | "last7" | "last30" | "custom", startDate?: string, endDate?: string) {
  return resolveReviewScope({ preset, startDate, endDate }, NOW);
}

describe("declarative Tmall review filters", () => {
  it("uses the follow-up filter alone rather than combining it with content or unanswered", async () => {
    const adapter = new FakeReviewFilterAdapter();

    await applyReviewFilters(adapter, scope("today"), "followup", "followup_only");

    expect(adapter.toggles).toEqual({ buyer: true, content: false, unanswered: false, followup: true });
    expect(adapter.toggleClicks).toEqual(["content", "unanswered", "followup"]);
    await expect(verifyReviewFilters(adapter, scope("today"), "followup", "followup_only")).resolves.toBeUndefined();
  });

  it("uses content and unanswered filters for the normal processing mode", async () => {
    const adapter = new FakeReviewFilterAdapter();

    await applyReviewFilters(adapter, scope("today"), "initial", "content_unanswered");
    expect(adapter.toggles).toEqual({ buyer: true, content: true, unanswered: true, followup: false });

  });
  it("does not click controls that are already selected and verifies the frozen range", async () => {
    const adapter = new FakeReviewFilterAdapter();
    const frozen = scope("today");

    const changed = await applyReviewFilters(adapter, frozen);

    expect(adapter.toggleClicks).toEqual([]);
    expect(adapter.presetClicks).toEqual([]);
    expect(adapter.closeDatePickerCalls).toBe(1);
    expect(adapter.searchClicks).toBe(0);
    expect(adapter.safeChecks).toBe(2);
    expect(changed).toBe(false);
  });

  it("clicks each unselected required control once and reads the postcondition", async () => {
    const adapter = new FakeReviewFilterAdapter();
    adapter.toggles = { buyer: false, content: false, unanswered: false, followup: false };

    const changed = await applyReviewFilters(adapter, scope("today"));

    expect(adapter.toggleClicks).toEqual(["buyer", "content", "unanswered"]);
    expect(adapter.searchClicks).toBe(0);
    expect(changed).toBe(true);
  });

  it("freezes the date range before changing the processing-mode toggles", async () => {
    const adapter = new FakeReviewFilterAdapter();
    adapter.startDate = "2026-01-01";
    adapter.endDate = "2026-01-01";
    adapter.toggles = { buyer: false, content: false, unanswered: false, followup: false };

    await applyReviewFilters(adapter, scope("last7"));

    expect(adapter.actions[0]).toBe("search");
    expect(adapter.actions.slice(1)).toEqual(["toggle:buyer", "toggle:content", "toggle:unanswered"]);
  });

  it.each(["today", "yesterday", "last7", "last30"] as const)(
    "uses the native %s shortcut and searches exactly once when the date differs",
    async (preset) => {
      const adapter = new FakeReviewFilterAdapter();
      adapter.startDate = "2026-01-01";
      adapter.endDate = "2026-01-01";
      const frozen = scope(preset);

      await applyReviewFilters(adapter, frozen);

      expect(adapter.presetClicks).toEqual([preset]);
      expect(adapter.closeDatePickerCalls).toBe(2);
      expect(adapter.searchClicks).toBe(1);
      await expect(verifyReviewFilters(adapter, frozen)).resolves.toBeUndefined();
    },
  );

  it("falls back to an exact custom range when a native shortcut uses different inclusive dates", async () => {
    class NativeShortcutMismatchAdapter extends FakeReviewFilterAdapter {
      override async clickSearch(target: ResolvedReviewScope): Promise<void> {
        this.searchClicks += 1;
        if (this.selectedDates.length === 0) {
          this.startDate = "2026-07-08";
          this.endDate = target.endDate;
          return;
        }
        this.startDate = target.startDate;
        this.endDate = target.endDate;
      }
    }
    const adapter = new NativeShortcutMismatchAdapter();
    adapter.startDate = "2026-01-01";
    adapter.endDate = "2026-01-01";
    const frozen = scope("last7");

    await applyReviewFilters(adapter, frozen);

    expect(adapter.presetClicks).toEqual(["last7"]);
    expect(adapter.closeDatePickerCalls).toBe(3);
    expect(adapter.searchClicks).toBe(2);
    expect(adapter.selectedDates).toEqual([frozen.startDate, frozen.endDate]);
    await expect(verifyReviewFilters(adapter, frozen)).resolves.toBeUndefined();
  });

  it("selects a same-day custom range by choosing both boundaries", async () => {
    const adapter = new FakeReviewFilterAdapter();
    adapter.startDate = "2026-01-01";
    adapter.endDate = "2026-01-01";
    const frozen = scope("custom", "2026-07-14", "2026-07-14");

    await applyReviewFilters(adapter, frozen);

    expect(adapter.selectedDates).toEqual(["2026-07-14", "2026-07-14"]);
    expect(adapter.monthMoves).toEqual([]);
    expect(adapter.closeDatePickerCalls).toBe(2);
    expect(adapter.searchClicks).toBe(1);
  });

  it("selects a cross-month custom range already visible in the dual-month panel", async () => {
    const adapter = new FakeReviewFilterAdapter();
    adapter.startDate = "2026-01-01";
    adapter.endDate = "2026-01-01";
    const frozen = scope("custom", "2026-07-30", "2026-08-02");

    await applyReviewFilters(adapter, frozen);

    expect(adapter.selectedDates).toEqual(["2026-07-30", "2026-08-02"]);
    expect(adapter.monthMoves).toEqual([]);
  });

  it("moves the dual-month panel until an earlier custom range is visible", async () => {
    const adapter = new FakeReviewFilterAdapter();
    adapter.startDate = "2026-01-01";
    adapter.endDate = "2026-01-01";
    const frozen = scope("custom", "2026-05-30", "2026-06-02");

    await applyReviewFilters(adapter, frozen);

    expect(adapter.monthMoves).toEqual(["previous", "previous"]);
    expect(adapter.selectedDates).toEqual(["2026-05-30", "2026-06-02"]);
  });

  it.each([
    ["duplicate toggle", (adapter: FakeReviewFilterAdapter) => { adapter.toggleMatches = 2; }],
    ["unreadable selected state", (adapter: FakeReviewFilterAdapter) => { adapter.selectedReadable = false; }],
    ["duplicate date control", (adapter: FakeReviewFilterAdapter) => { adapter.dateMatches = 2; }],
    ["dangerous popup or expired login", (adapter: FakeReviewFilterAdapter) => { adapter.safe = false; }],
    ["failed postcondition", (adapter: FakeReviewFilterAdapter) => { adapter.toggles.content = false; adapter.applyClicks = false; }],
  ])("fails closed for %s", async (_name, arrange) => {
    const adapter = new FakeReviewFilterAdapter();
    arrange(adapter);
    await expect(applyReviewFilters(adapter, scope("today"))).rejects.toBeInstanceOf(ReviewFilterStateError);
  });

  it("uses only registered locator operation keys for date-control failures", async () => {
    const adapter = new FakeReviewFilterAdapter();
    adapter.dateMatches = 0;
    await expect(applyReviewFilters(adapter, scope("today"))).rejects.toMatchObject({
      operationKey: "review.date.trigger",
    });
  });
});

function snapshot(reviewedAt: string | null): TmallReviewSnapshot {
  return {
    sourceKey: `tmall:${reviewedAt ?? "missing"}`,
    orderId: "1001",
    review: "很好",
    product: "漫步者耳机",
    reviewedAt,
    sentimentLabel: "positive",
    itemId: "960227744800",
    reviewPhase: "initial",
  };
}

describe("server-side frozen review scope guard", () => {
  it("accepts a complete page only when every review is inside the frozen range", () => {
    expect(() => assertReviewSnapshotsWithinScope([
      snapshot("2026-07-14 00:00"),
      snapshot("2026-07-14 23:59"),
    ], scope("custom", "2026-07-14", "2026-07-14"))).not.toThrow();
  });

  it.each([
    ["missing time", null],
    ["invalid time", "2026-07-14"],
    ["outside range", "2026-07-15 00:00"],
  ])("rejects the whole page for %s", (_name, reviewedAt) => {
    expect(() => assertReviewSnapshotsWithinScope([
      snapshot("2026-07-14 12:00"),
      snapshot(reviewedAt),
    ], scope("custom", "2026-07-14", "2026-07-14"))).toThrow(ReviewFilterStateError);
  });
});
