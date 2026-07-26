import type { ResolvedReviewScope } from "@tmall/domain";
import type { TmallReviewSnapshot } from "../tmall/review-reader";
import type { ReviewFilterMode, ReviewScanPhase } from "../tmall/review-filter";
import { humanDelay, TMALL_ACTION_DELAY_RANGES } from "./human-delay";

export interface QueueDrainResult {
  processed: number;
  succeeded: number;
  manual: number;
  failed: number;
  stopReason: "queue_empty" | "control_requested";
}

export type QueueDrainPhase = "processing" | "checking_for_new_reviews";

export interface FullScanEvidence {
  observedSourceKeys: ReadonlySet<string>;
  scope: ResolvedReviewScope;
}

export function scanPhasesForMode(mode: ReviewFilterMode): readonly ReviewScanPhase[] {
  return mode === "followup_only" ? ["followup"] : ["initial"];
}

export interface PendingReviewPage {
  items: TmallReviewSnapshot[];
  hasNextPage: boolean;
}

export async function drainPendingReviewQueue(input: {
  pageSize?: number;
  scope: ResolvedReviewScope;
  mode?: ReviewFilterMode;
  readPage: (page: number, pageSize: number, phase: ReviewScanPhase) => Promise<TmallReviewSnapshot[] | PendingReviewPage>;
  processOne: (review: TmallReviewSnapshot) => Promise<"succeeded" | "manual" | "failed">;
  shouldStartNext: () => boolean;
  interItemDelay?: () => Promise<void>;
  onPhaseChange?: (phase: QueueDrainPhase) => void;
  onFullScanCompleted?: (evidence: FullScanEvidence) => void | Promise<void>;
}): Promise<QueueDrainResult> {
  // Tmall decides how many rows a page contains. Read and finish the complete
  // current page before Search refreshes it or pagination advances.
  const pageSize = Math.max(1, Math.min(100, Math.trunc(input.pageSize ?? 20)));
  const scanPhases = scanPhasesForMode(input.mode ?? "content_unanswered");
  const seen = new Set<string>();
  const scheduled = new Set<string>();
  let work: TmallReviewSnapshot[] = [];
  let processed = 0;
  let succeeded = 0;
  let manual = 0;
  let failed = 0;
  let page = 1;
  let phaseIndex = 0;
  let scansWithoutNew = 0;
  let observedSourceKeys = new Set<string>();
  let hasProcessedReview = false;
  const interItemDelay = input.interItemDelay ?? (() => humanDelay(...TMALL_ACTION_DELAY_RANGES.reviewInterItem));

  const result = (stopReason: QueueDrainResult["stopReason"]): QueueDrainResult => ({
    processed,
    succeeded,
    manual,
    failed,
    stopReason,
  });

  const enqueueNew = (items: readonly TmallReviewSnapshot[]): number => {
    const discovered: TmallReviewSnapshot[] = [];
    for (const item of items) {
      if (seen.has(item.sourceKey) || scheduled.has(item.sourceKey)) continue;
      scheduled.add(item.sourceKey);
      discovered.push(item);
    }
    work.push(...discovered);
    return discovered.length;
  };

  const readPhasePage = async (requestedPage: number, phase = scanPhases[phaseIndex]!): Promise<PendingReviewPage> => {
    const pageResult = await input.readPage(requestedPage, pageSize, phase);
    return Array.isArray(pageResult)
      ? { items: pageResult, hasNextPage: pageResult.length >= pageSize }
      : pageResult;
  };

  const resetFullScan = (): void => {
    page = 1;
    phaseIndex = 0;
    observedSourceKeys = new Set<string>();
  };

  while (true) {
    if (!input.shouldStartNext()) return result("control_requested");

    const next = work.shift();
    if (next) {
      scheduled.delete(next.sourceKey);
      if (seen.has(next.sourceKey)) continue;
      if (hasProcessedReview) {
        if (!input.shouldStartNext()) return result("control_requested");
        await interItemDelay();
        if (!input.shouldStartNext()) return result("control_requested");
      }
      seen.add(next.sourceKey);
      input.onPhaseChange?.("processing");
      const outcome = await input.processOne(next);
      processed += 1;
      if (outcome === "succeeded") succeeded += 1;
      else if (outcome === "manual") manual += 1;
      else failed += 1;
      hasProcessedReview = true;
      // Stop, pause and the end of a scheduled window take effect after the
      // current review. Do not perform another browser read once requested.
      if (!input.shouldStartNext()) return result("control_requested");
      continue;
    }

    input.onPhaseChange?.("checking_for_new_reviews");
    const pageResult = await readPhasePage(page);
    const items = pageResult.items;
    for (const item of items) observedSourceKeys.add(item.sourceKey);
    if (enqueueNew(items) > 0) {
      scansWithoutNew = 0;
      continue;
    }

    if (pageResult.hasNextPage) {
      page += 1;
      continue;
    }
    if (phaseIndex + 1 < scanPhases.length) {
      phaseIndex += 1;
      page = 1;
      continue;
    }

    // This is a complete scan only when every page in every applicable phase
    // was read without discovering work. Partial scans are discarded whenever
    // a page batch is processed, so manual-hold disappearance evidence remains
    // trustworthy.
    if (!input.shouldStartNext()) return result("control_requested");
    await input.onFullScanCompleted?.({
      observedSourceKeys: new Set(observedSourceKeys),
      scope: input.scope,
    });
    scansWithoutNew += 1;
    if (scansWithoutNew >= 2) return result("queue_empty");
    resetFullScan();
  }
}
