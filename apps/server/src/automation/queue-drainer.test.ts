import { describe, expect, it } from "vitest";
import { drainPendingReviewQueue as drainPendingReviewQueueWithProductionDelay, scanPhasesForMode } from "./queue-drainer";
import type { TmallReviewSnapshot } from "../tmall/review-reader";
import { resolveTmallItemIdCandidates } from "../tmall/review-reader";
import { resolveReviewScope } from "@tmall/domain";

const frozenScope = resolveReviewScope({ preset: "last7" }, new Date("2026-07-15T01:00:00.000Z"));
type QueueDrainInput = Parameters<typeof drainPendingReviewQueueWithProductionDelay>[0];
const drainPendingReviewQueue = (input: QueueDrainInput) => drainPendingReviewQueueWithProductionDelay({
  ...input,
  interItemDelay: input.interItemDelay ?? (async () => undefined),
});

function review(index: number): TmallReviewSnapshot {
  return { sourceKey: `tmall:${index}`, orderId: String(index), review: `评价${index}`, product: `商品${index}`, reviewedAt: null, sentimentLabel: "positive", itemId: null, reviewPhase: "initial" };
}

describe("full pending-review queue drainer", () => {
  it("reads the full Tmall page while keeping the processing batch independent", async () => {
    const pageSizes: number[] = [];
    await drainPendingReviewQueue({
      scope: frozenScope,
      readPage: async (_page, pageSize) => {
        pageSizes.push(pageSize);
        return [];
      },
      processOne: async () => "succeeded",
      shouldStartNext: () => true,
    });

    expect(new Set(pageSizes)).toEqual(new Set([20]));
  });

  it("moves to the next platform page when the current page only contains non-replyable records", async () => {
    const reads: number[] = [];
    const processed: string[] = [];
    await drainPendingReviewQueue({
      scope: frozenScope,
      readPage: async (page) => {
        reads.push(page);
        if (page === 1) return { items: [], hasNextPage: true };
        return { items: page === 2 ? [review(1)] : [], hasNextPage: false };
      },
      processOne: async (item) => { processed.push(item.sourceKey); return "succeeded"; },
      shouldStartNext: () => true,
    });

    expect(reads).toContain(2);
    expect(processed).toEqual(["tmall:1"]);
  });

  it("never drives concurrent reads on the same browser page", async () => {
    let activeReads = 0;
    let maximumConcurrentReads = 0;

    await drainPendingReviewQueue({
      scope: frozenScope,
      mode: "content_unanswered",
      pageSize: 20,
      readPage: async () => {
        activeReads += 1;
        maximumConcurrentReads = Math.max(maximumConcurrentReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeReads -= 1;
        return [];
      },
      processOne: async () => "succeeded",
      shouldStartNext: () => true,
    });

    expect(maximumConcurrentReads).toBe(1);
  });

  it("processes mixed initial and follow-up actions in one 有内容未回复 scan", async () => {
    const reads: Array<{ phase: string; page: number }> = [];
    const processed: string[] = [];
    const followup = { ...review(2), sourceKey: "tmall:followup", reviewPhase: "followup" as const };
    const duplicate = { ...review(3), sourceKey: "tmall:shared", reviewPhase: "initial" as const };
    const duplicateFollowup = { ...duplicate, reviewPhase: "followup" as const };

    await drainPendingReviewQueue({
      scope: frozenScope,
      mode: "content_unanswered",
      pageSize: 20,
      readPage: async (page, _pageSize, phase) => {
        reads.push({ phase, page });
        if (page !== 1) return [];
        return [review(1), followup, duplicate, duplicateFollowup];
      },
      processOne: async (item) => { processed.push(item.sourceKey); return "succeeded"; },
      shouldStartNext: () => true,
    });

    expect(reads.some((read) => read.phase === "initial")).toBe(true);
    expect(reads.some((read) => read.phase === "followup")).toBe(false);
    expect(processed).toHaveLength(3);
    expect(new Set(processed)).toEqual(new Set(["tmall:1", "tmall:shared", "tmall:followup"]));
  });

  it("maps each user mode to only its intended queue phases", () => {
    expect(scanPhasesForMode("followup_only")).toEqual(["followup"]);
    expect(scanPhasesForMode("content_unanswered")).toEqual(["initial"]);
  });

  it("waits only when another review is ready and never waits after the final review", async () => {
    const queue = [review(1), review(2)];
    const processed: string[] = [];
    let delays = 0;
    const result = await drainPendingReviewQueue({
      scope: frozenScope,
      readPage: async () => queue,
      processOne: async (item) => { processed.push(item.sourceKey); return "succeeded"; },
      shouldStartNext: () => true,
      interItemDelay: async () => { delays += 1; },
    });

    expect(result).toMatchObject({ processed: 2, stopReason: "queue_empty" });
    expect(processed).toEqual(["tmall:1", "tmall:2"]);
    expect(delays).toBe(1);
  });

  it("checks control state again after the inter-item delay before starting the next review", async () => {
    const processed: string[] = [];
    let allowed = true;
    let checks = 0;
    const result = await drainPendingReviewQueue({
      scope: frozenScope,
      readPage: async () => [review(1), review(2)],
      processOne: async (item) => { processed.push(item.sourceKey); return "succeeded"; },
      shouldStartNext: () => { checks += 1; return allowed; },
      interItemDelay: async () => { allowed = false; },
    });

    expect(processed).toEqual(["tmall:1"]);
    expect(result.stopReason).toBe("control_requested");
    expect(checks).toBeGreaterThanOrEqual(3);
  });

  it("does not enter the inter-item delay when control is already stopping", async () => {
    let allowed = true;
    let delays = 0;
    const result = await drainPendingReviewQueue({
      scope: frozenScope,
      readPage: async () => [review(1), review(2)],
      processOne: async () => { allowed = false; return "succeeded"; },
      shouldStartNext: () => allowed,
      interItemDelay: async () => { delays += 1; },
    });

    expect(result).toMatchObject({ processed: 1, stopReason: "control_requested" });
    expect(delays).toBe(0);
  });

  it("processes all 785 reviews through 20-item pages without duplicates", async () => {
    const queue = Array.from({ length: 785 }, (_, index) => review(index + 1));
    const processed: string[] = [];
    const result = await drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 20,
      readPage: async (page, pageSize) => queue.slice((page - 1) * pageSize, page * pageSize),
      processOne: async (item) => { processed.push(item.sourceKey); return "succeeded"; },
      shouldStartNext: () => true,
    });

    expect(result).toMatchObject({ processed: 785, succeeded: 785, failed: 0, stopReason: "queue_empty" });
    expect(new Set(processed).size).toBe(785);
  });

  it("finishes the current item and does not start another after a stop request", async () => {
    const queue = [review(1), review(2), review(3)];
    let allowNext = true;
    let reads = 0;
    let completedScans = 0;
    const processed: string[] = [];
    const result = await drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 20,
      readPage: async () => { reads += 1; return queue; },
      processOne: async (item) => { processed.push(item.sourceKey); allowNext = false; return "succeeded"; },
      shouldStartNext: () => allowNext,
      onFullScanCompleted: () => { completedScans += 1; },
    });

    expect(processed).toEqual(["tmall:1"]);
    expect(result.stopReason).toBe("control_requested");
    expect(reads).toBe(1);
    expect(completedScans).toBe(0);
  });

  it("tolerates a delayed list update without replying to the same review twice", async () => {
    const stale = review(1);
    const processed: string[] = [];
    let reads = 0;
    const result = await drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 20,
      readPage: async () => {
        reads += 1;
        return reads <= 2 ? [stale] : [];
      },
      processOne: async (item) => { processed.push(item.sourceKey); return "succeeded"; },
      shouldStartNext: () => true,
    });

    expect(processed).toEqual(["tmall:1"]);
    expect(result).toMatchObject({ processed: 1, succeeded: 1, stopReason: "queue_empty" });
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it("tracks manual diversion separately from success and failure", async () => {
    const outcomes = new Map([["tmall:1", "manual" as const], ["tmall:2", "succeeded" as const]]);

    const result = await drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 20,
      readPage: async () => [review(1), review(2)],
      processOne: async (item) => outcomes.get(item.sourceKey) ?? "failed",
      shouldStartNext: () => true,
    });

    expect(result).toMatchObject({ processed: 2, succeeded: 1, manual: 1, failed: 0, stopReason: "queue_empty" });
  });

  it("processes a review that arrives during the second confirmation scan", async () => {
    const processed: string[] = [];
    let reads = 0;
    const result = await drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 20,
      readPage: async () => {
        reads += 1;
        if (reads === 1) return [review(1)];
        if (reads === 2) return [review(1), review(2)];
        return [];
      },
      processOne: async (item) => { processed.push(item.sourceKey); return "succeeded"; },
      shouldStartNext: () => true,
    });

    expect(processed).toEqual(["tmall:1", "tmall:2"]);
    expect(result.processed).toBe(2);
  });

  it("finishes the current page snapshot before processing a newly inserted top review", async () => {
    let queue = Array.from({ length: 25 }, (_, index) => review(index + 1));
    const processed: string[] = [];
    const result = await drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 20,
      readPage: async (page, pageSize) => queue.slice((page - 1) * pageSize, page * pageSize),
      processOne: async (item) => {
        processed.push(item.sourceKey);
        queue = queue.filter((candidate) => candidate.sourceKey !== item.sourceKey);
        if (item.sourceKey === "tmall:1") queue.unshift(review(100));
        return "succeeded";
      },
      shouldStartNext: () => true,
    });

    expect(processed.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, index) => `tmall:${index + 1}`));
    expect(processed[20]).toBe("tmall:100");
    expect(new Set(processed).size).toBe(26);
    expect(result).toMatchObject({ processed: 26, succeeded: 26, stopReason: "queue_empty" });
  });

  it("finishes every actionable row on the current Tmall page before refreshing it", async () => {
    const queue = Array.from({ length: 20 }, (_, index) => review(index + 1));
    const readsSeenByEachItem: number[] = [];
    let reads = 0;

    await drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 20,
      readPage: async (page, pageSize) => {
        reads += 1;
        return page === 1 ? queue.slice(0, pageSize) : [];
      },
      processOne: async () => {
        readsSeenByEachItem.push(reads);
        return "succeeded";
      },
      shouldStartNext: () => true,
    });

    expect(readsSeenByEachItem.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 1));
  });

  it("search-refreshes the same page after all current actions are processed", async () => {
    let queue = Array.from({ length: 12 }, (_, index) => review(index + 1));
    const readsSeenByEachItem: number[] = [];
    let reads = 0;

    await drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 20,
      readPage: async () => {
        reads += 1;
        return [...queue];
      },
      processOne: async (item) => {
        readsSeenByEachItem.push(reads);
        queue = queue.filter((candidate) => candidate.sourceKey !== item.sourceKey);
        return "succeeded";
      },
      shouldStartNext: () => true,
    });

    expect(readsSeenByEachItem).toEqual(Array.from({ length: 12 }, () => 1));
    expect(reads).toBeGreaterThan(1);
  });

  it("does not let new top arrivals overtake reviews already captured in the page snapshot", async () => {
    let queue = Array.from({ length: 20 }, (_, index) => review(index + 1));
    const processed: string[] = [];

    await drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 20,
      readPage: async (page, pageSize) => queue.slice((page - 1) * pageSize, page * pageSize),
      processOne: async (item) => {
        processed.push(item.sourceKey);
        queue = queue.filter((candidate) => candidate.sourceKey !== item.sourceKey);
        if (processed.length <= 20) queue.unshift(review(100 + processed.length));
        return "succeeded";
      },
      shouldStartNext: () => true,
    });

    expect(processed.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, index) => `tmall:${index + 1}`));
    expect(new Set(processed)).toHaveLength(40);
  });

  it("does not miss reviews when middle pages shrink and reorder after each success", async () => {
    let queue = Array.from({ length: 7 }, (_, index) => review(index + 1));
    const processed: string[] = [];
    const result = await drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 2,
      readPage: async (page, pageSize) => queue.slice((page - 1) * pageSize, page * pageSize),
      processOne: async (item) => {
        processed.push(item.sourceKey);
        if (["tmall:3", "tmall:4"].includes(item.sourceKey)) {
          queue = queue.filter((candidate) => candidate.sourceKey !== item.sourceKey);
        }
        return "succeeded";
      },
      shouldStartNext: () => true,
    });

    expect(new Set(processed).size).toBe(7);
    expect(result.processed).toBe(7);
  });

  it("does not restart from page one in the middle of processing later pages", async () => {
    const queue = Array.from({ length: 4 }, (_, index) => review(index + 1));
    const processed: string[] = [];
    let inserted = false;
    let pageTwoReads = 0;
    const result = await drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 2,
      readPage: async (page, pageSize) => {
        if (page === 2) {
          pageTwoReads += 1;
          if (!inserted) {
            queue.unshift(review(9));
            inserted = true;
          }
        }
        return queue.slice((page - 1) * pageSize, page * pageSize);
      },
      processOne: async (item) => { processed.push(item.sourceKey); return "succeeded"; },
      shouldStartNext: () => true,
    });

    expect(pageTwoReads).toBeGreaterThan(0);
    expect(processed.indexOf("tmall:9")).toBeGreaterThan(processed.indexOf("tmall:4"));
    expect(new Set(processed)).toEqual(new Set(["tmall:1", "tmall:2", "tmall:3", "tmall:4", "tmall:9"]));
    expect(result.processed).toBe(5);
  });

  it("searches the first page again before accepting an empty queue", async () => {
    const processed: string[] = [];
    let reads = 0;
    const result = await drainPendingReviewQueue({
      scope: frozenScope,
      mode: "content_unanswered",
      pageSize: 20,
      readPage: async () => {
        reads += 1;
        return reads === 2 ? [review(99)] : [];
      },
      processOne: async (item) => { processed.push(item.sourceKey); return "succeeded"; },
      shouldStartNext: () => true,
    });

    expect(processed).toEqual(["tmall:99"]);
    expect(result.processed).toBe(1);
    expect(reads).toBeGreaterThanOrEqual(4);
  });

  it("publishes only completed full-scan evidence with the frozen scope", async () => {
    const scans: Array<{ keys: string[]; sameScope: boolean }> = [];
    const phases: string[] = [];
    const result = await drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 2,
      readPage: async (page) => page === 1 ? [review(1)] : [],
      processOne: async () => "succeeded",
      shouldStartNext: () => true,
      onPhaseChange: (phase) => phases.push(phase),
      onFullScanCompleted: ({ observedSourceKeys, scope }) => scans.push({
        keys: [...observedSourceKeys],
        sameScope: scope === frozenScope,
      }),
    });

    expect(result.processed).toBe(1);
    expect(scans).toHaveLength(2);
    expect(scans.every((scan) => scan.sameScope)).toBe(true);
    expect(scans[0]?.keys).toEqual(["tmall:1"]);
    expect(phases).toContain("checking_for_new_reviews");
  });

  it("stays within the read budget for 785 reviews that disappear after processing", async () => {
    let queue = Array.from({ length: 785 }, (_, index) => review(index + 1));
    let readCalls = 0;
    const result = await drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 20,
      readPage: async (page, pageSize) => {
        readCalls += 1;
        return queue.slice((page - 1) * pageSize, page * pageSize);
      },
      processOne: async (item) => {
        queue = queue.filter((candidate) => candidate.sourceKey !== item.sourceKey);
        return "succeeded";
      },
      shouldStartNext: () => true,
    });

    expect(result.processed).toBe(785);
    expect(queue).toEqual([]);
    expect(readCalls).toBeLessThanOrEqual(1_700);
  });

  it("honors stop immediately after the current item even when reviews keep arriving", async () => {
    let queue = [review(1)];
    let allowNext = true;
    const processed: string[] = [];
    const result = await drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 20,
      readPage: async () => queue,
      processOne: async (item) => {
        processed.push(item.sourceKey);
        queue = [review(2), review(3)];
        allowNext = false;
        return "succeeded";
      },
      shouldStartNext: () => allowNext,
    });

    expect(processed).toEqual(["tmall:1"]);
    expect(result.stopReason).toBe("control_requested");
  });

  it("leaves a review arriving after the final check for the next invocation", async () => {
    let queue = [review(1)];
    let completedScans = 0;
    const processed: string[] = [];
    const run = () => drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 20,
      readPage: async () => [...queue],
      processOne: async (item) => {
        processed.push(item.sourceKey);
        queue = queue.filter((candidate) => candidate.sourceKey !== item.sourceKey);
        return "succeeded";
      },
      shouldStartNext: () => true,
      onFullScanCompleted: () => {
        completedScans += 1;
        if (completedScans === 2) queueMicrotask(() => queue.push(review(2)));
      },
    });

    await expect(run()).resolves.toMatchObject({ processed: 1, stopReason: "queue_empty" });
    await Promise.resolve();
    expect(processed).toEqual(["tmall:1"]);
    expect(queue.map((item) => item.sourceKey)).toEqual(["tmall:2"]);
    await expect(run()).resolves.toMatchObject({ processed: 1, stopReason: "queue_empty" });
    expect(processed).toEqual(["tmall:1", "tmall:2"]);
  });

  it("never publishes a partial scan when a later page read fails", async () => {
    let completedScans = 0;
    await expect(drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 1,
      readPage: async (page) => {
        if (page === 1) return [review(1)];
        throw new Error("page read failed");
      },
      processOne: async () => "succeeded",
      shouldStartNext: () => true,
      onFullScanCompleted: () => { completedScans += 1; },
    })).rejects.toThrow("page read failed");
    expect(completedScans).toBe(0);
  });

  it("does not create a draft when the page snapshot is untrusted", async () => {
    let processed = 0;
    await expect(drainPendingReviewQueue({
      scope: frozenScope,
      pageSize: 20,
      readPage: async () => {
        resolveTmallItemIdCandidates([
          "https://detail.tmall.com/item.htm?id=1",
          "https://item.taobao.com/item.htm?id=2",
        ]);
        return [];
      },
      processOne: async () => { processed += 1; return "succeeded"; },
      shouldStartNext: () => true,
    })).rejects.toThrow("页面状态不可信");
    expect(processed).toBe(0);
  });
});
