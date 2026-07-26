import { randomInt } from "node:crypto";
import { FIXED_TEMPLATE_SCHEMAS } from "@tmall/domain";
import {
  DeepSeekConfigurationError,
  DeepSeekModelContractError,
  DeepSeekTransientError,
  type DeepSeekClientApi,
  type ReviewCategoryCandidate,
  type ReviewClassification,
  type TemplateRewriteResult,
} from "../deepseek/client";
import {
  resolvePositiveRiskSentiment,
  SentimentAdjudicationPausedError,
} from "../deepseek/review-sentiment-adjudication";
import type { ManualProductPolicy } from "../manual-products/policy-service";
import type { ComplaintReviewPolicy } from "../complaints/complaint-review-service";
import type {
  AiRetryErrorKind,
  AiRetryStage,
  PersistedReplyDraft,
  ReplyRepository,
  TemplateRepository,
} from "../storage/repositories";
import { ReviewActionConflictError } from "../submission/review-action-gate";
import type { TmallReviewSnapshot } from "../tmall/review-reader";
import {
  applyNoUseExperienceGuard,
  refineFallbackCategory,
  selectReplyTemplate,
} from "./template-selection";

export interface DraftProcessorOptions {
  replies: ReplyRepository;
  templates: TemplateRepository;
  ai: DeepSeekClientApi;
  manualProductPolicy?: ManualProductPolicy;
  /** Complaint review is an optional policy seam for legacy draft-only callers. */
  complaintPolicy?: ComplaintReviewPolicy;
  pickIndex?: (length: number) => number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type DraftProcessOutcome =
  | "completed"
  | "retry_wait"
  | "circuit_breaker"
  | "manual_action_required"
  | "paused"
  | "skipped";

export interface DraftProcessItem {
  id: string;
  state: string;
  outcome?: DraftProcessOutcome;
  skipped?: boolean;
}

export interface DraftBatchResult {
  processed: number;
  failed: number;
  skipped: number;
  items: DraftProcessItem[];
}

interface ProcessControl {
  shouldContinue?: () => boolean;
  expectedClaimToken?: string;
  at?: Date;
  claimedRetry?: boolean;
  complaintAnalysisResume?: boolean;
  platformComplaintEntryState?: TmallReviewSnapshot["platformComplaintEntryState"];
}

type StageAttempt<T> =
  | { status: "success"; value: T }
  | { status: "paused" }
  | { status: "exhausted"; errorKind: AiRetryErrorKind };

interface ClassifiedTemplate {
  classification: ReviewClassification;
  primaryCategory: string;
  category: string;
  replies: Array<{ sequence: number; text: string }>;
  fallbackReplies: Array<{ sequence: number; text: string }>;
  templateVersionId: number;
}

interface ConfigurationFailure {
  code: string;
  message: string;
}

class DraftConfigurationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DraftConfigurationError";
    this.code = code;
  }
}

const TEMPLATE_CONFIGURATION_FAILURE: ConfigurationFailure = {
  code: "TEMPLATE_LIBRARY_CONFIGURATION_REQUIRED",
  message: "话术库配置不完整，请检查好评和差评模板后重试",
};

/**
 * A small deterministic backstop for an explicit, high-signal semantic error
 * that must never be treated as praise.  It deliberately requires a direct
 * low-price/value comparison rather than treating ordinary neutral wording as
 * negative.  The model remains responsible for selecting specific categories.
 */
function hasExplicitNegativeValueComparison(review: string): boolean {
  const text = review.replace(/\s+/gu, "");
  return [
    /(?:没有感受到|没感受到|没有感觉到|没感觉到|感受不到).{0,18}(?:十几|二十|低价|便宜).{0,18}(?:区别|差别)/u,
    /(?:不值|不如|还不如).{0,18}(?:十几|二十|低价|便宜)/u,
    /(?:十几|二十|低价|便宜).{0,18}(?:没有区别|没区别|没有差别|没差别)/u,
  ].some((pattern) => pattern.test(text));
}

function hasExplicitCelebrityReference(review: string): boolean {
  const text = review.normalize("NFKC").replace(/\s+/gu, "");
  return /(?:明星|代言人?|偶像|爱豆|艺人|演员|歌手|男团|女团|博主|网红|主播|达人|粉丝|饭圈|应援)/u.test(text)
    || /(?:同款|推荐).{0,12}(?:老师|哥哥|姐姐)/u.test(text);
}

function applyExplicitValueComparisonGuard(
  classification: ReviewClassification,
  review: string,
): ReviewClassification {
  if (classification.library !== "good" || !hasExplicitNegativeValueComparison(review)) return classification;
  return {
    library: "bad",
    category: FIXED_TEMPLATE_SCHEMAS.bad.fallbackCategory,
    confidence: Math.max(classification.confidence, 0.92),
    reason: "规则保护：明确低价对比，表达当前商品价值否定。",
    needsAttention: classification.needsAttention,
  };
}

export class DraftProcessor {
  readonly #replies: ReplyRepository;
  readonly #templates: TemplateRepository;
  readonly #ai: DeepSeekClientApi;
  readonly #manualProductPolicy: ManualProductPolicy | undefined;
  readonly #complaintPolicy: ComplaintReviewPolicy | undefined;
  readonly #pickIndex: (length: number) => number;
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: DraftProcessorOptions) {
    this.#replies = options.replies;
    this.#templates = options.templates;
    this.#ai = options.ai;
    this.#manualProductPolicy = options.manualProductPolicy;
    this.#complaintPolicy = options.complaintPolicy;
    this.#pickIndex = options.pickIndex ?? ((length) => randomInt(length));
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async processSnapshots(
    snapshots: TmallReviewSnapshot[],
    options: {
      shouldContinue?: () => boolean;
      onProgress?: (message: string) => void;
    } = {},
  ): Promise<DraftBatchResult> {
    const result: DraftBatchResult = { processed: 0, failed: 0, skipped: 0, items: [] };
    for (const snapshot of snapshots) {
      if (options.shouldContinue && !options.shouldContinue()) break;
      const discovered = this.#replies.discover(snapshot);
      let existing = this.#replies.get(discovered.id);
      if (hasExplicitCelebrityReference(snapshot.review)) {
        const marked = this.#replies.markNotActionable(
          discovered.id,
          "CELEBRITY_REVIEW_SKIPPED",
          "评价提及明星、代言人、博主或其他公众人物关联内容，已按规则跳过回复",
        );
        result.skipped += 1;
        result.items.push({ id: marked.id, state: marked.state, outcome: "skipped", skipped: true });
        continue;
      }
      const platformActionState = snapshot.platformActionState ?? "none";
      if (platformActionState !== "none") {
        if (existing && this.#complaintPolicy?.reconcilePlatformState) {
          // A row-level platform status is authoritative for duplicate-action
          // prevention. A local reconciliation conflict must not make the
          // batch submit the same complaint or reply again; the local draft is
          // still marked non-actionable and processing continues.
          await this.#complaintPolicy.reconcilePlatformState(existing, platformActionState).catch(() => null);
        }
        const marked = this.#replies.markPlatformActionObserved(
          discovered.id,
          platformActionState,
        );
        result.skipped += 1;
        result.items.push({ id: marked.id, state: marked.state, outcome: "skipped", skipped: true });
        continue;
      }
      const reopenedLiveAction = !discovered.created
        && existing !== null
        && this.#replies.reopenObservedLiveAction(discovered.id);
      if (reopenedLiveAction) existing = this.#replies.get(discovered.id);
      const observedAsNew = discovered.created || reopenedLiveAction;
      if (!observedAsNew && existing) {
        if (existing.state === "retry_wait") {
          const observedAt = this.#now();
          let claim;
          try {
            claim = this.#replies.claimObservedAiRetry({
              id: existing.id,
              sourceKey: snapshot.sourceKey,
              now: observedAt,
              leaseMs: 60_000,
            });
          } catch (error) {
            if (!(error instanceof ReviewActionConflictError)) throw error;
            result.skipped += 1;
            result.items.push({ id: existing.id, state: existing.state, outcome: "skipped", skipped: true });
            continue;
          }
          const claimed = claim.drafts[0];
          if (!claimed) {
            result.skipped += 1;
            result.items.push({ id: existing.id, state: existing.state, outcome: "skipped", skipped: true });
            continue;
          }
          const item = await this.processClaimedRetry(claimed, claim.claimToken, observedAt, {
            ...options,
            platformComplaintEntryState: snapshot.platformComplaintEntryState,
          });
          if (item.outcome === "paused") {
            this.#replies.releaseAiRetryClaim(claimed.id, { claimToken: claim.claimToken, at: this.#now() });
          }
          if (item.skipped) result.skipped += 1;
          else {
            result.processed += 1;
            if (item.state === "failed") result.failed += 1;
          }
          result.items.push(item);
          continue;
        }
        if ([
          "manual_product_hold",
          "not_actionable",
          "sent",
          "submitting",
          "submission_uncertain",
          "failed",
        ].includes(existing.state)) {
          result.skipped += 1;
          result.items.push({ id: existing.id, state: existing.state, outcome: "skipped", skipped: true });
          continue;
        }
        if (["read_only_ready", "needs_attention"].includes(existing.state)) {
          let manualAttempt: StageAttempt<Awaited<ReturnType<ManualProductPolicy["evaluate"]>> | undefined>;
          try {
            manualAttempt = await this.#attemptStage(
              "classification",
              existing.id,
              async () => await this.#manualProductPolicy?.evaluate(existing.id, {
                propagateSentimentErrors: true,
                ...(options.shouldContinue ? { shouldContinue: options.shouldContinue } : {}),
              }),
              options.shouldContinue ? { shouldContinue: options.shouldContinue } : {},
            );
          } catch (error) {
            if (!(error instanceof ReviewActionConflictError)) throw error;
            const protectedDraft = this.#requireRecord(existing.id);
            result.skipped += 1;
            result.items.push({ id: protectedDraft.id, state: protectedDraft.state, outcome: "skipped", skipped: true });
            continue;
          }
          if (manualAttempt.status === "exhausted") {
            const failedRound = this.#recordRoundFailure(existing.id, "classification", manualAttempt.errorKind, {});
            result.processed += 1;
            result.items.push(failedRound);
          } else if (manualAttempt.status === "paused") {
            result.skipped += 1;
            result.items.push({ id: existing.id, state: existing.state, outcome: "paused", skipped: true });
          } else if (manualAttempt.value?.action === "manual_hold") {
            const held = this.#requireRecord(existing.id);
            result.processed += 1;
            result.items.push({ id: held.id, state: held.state, outcome: "completed" });
          } else {
            result.skipped += 1;
            result.items.push({ id: existing.id, state: existing.state, outcome: "skipped", skipped: true });
          }
          continue;
        }
      }

      const resumesCheckpoint = !observedAsNew
        && existing?.aiCheckpointStage === "template_selected"
        && ["template_selected", "rewriting"].includes(existing.state);
      const resumesFailedComplaint = !observedAsNew && this.#replies.canResumeFailedComplaintAnalysis(discovered.id);
      if (!observedAsNew && !resumesCheckpoint && !resumesFailedComplaint && !this.#replies.resetForReprocess(discovered.id)) {
        const protectedDraft = this.#requireRecord(discovered.id);
        result.skipped += 1;
        result.items.push({ id: protectedDraft.id, state: protectedDraft.state, outcome: "skipped", skipped: true });
        continue;
      }
      options.onProgress?.(`正在分析：${snapshot.review.slice(0, 24)}`);
      const item = await this.#processOwned(
        discovered.id,
        options.onProgress,
        options.shouldContinue,
        snapshot.platformComplaintEntryState,
      );
      if (item.skipped) {
        result.skipped += 1;
      } else {
        result.processed += 1;
        if (item.state === "failed") result.failed += 1;
      }
      result.items.push(item);
    }
    return result;
  }

  async reprocess(id: string): Promise<DraftProcessItem> {
    const existing = this.#replies.get(id);
    if (!existing) throw new Error("回复草稿不存在");
    if (["manual_product_hold", "not_actionable", "sent", "submitting", "submission_uncertain"].includes(existing.state)) {
      return { id, state: existing.state, outcome: "skipped", skipped: true };
    }
    if (existing.aiCheckpointStage === "template_selected" && ["template_selected", "rewriting"].includes(existing.state)) {
      return this.#processOwned(id);
    }
    if (!this.#replies.resetForReprocess(id)) {
      throw new Error("该评价已有其他处理动作，不能重新生成草稿");
    }
    return this.#processOwned(id);
  }

  async processClaimedRetry(
    draft: PersistedReplyDraft,
    claimToken: string,
    at = this.#now(),
    options: {
      shouldContinue?: () => boolean;
      onProgress?: (message: string) => void;
      platformComplaintEntryState?: TmallReviewSnapshot["platformComplaintEntryState"];
    } = {},
  ): Promise<DraftProcessItem> {
    if (!draft?.id) throw new Error("AI 重试草稿无效");
    if (!claimToken.trim() || claimToken !== claimToken.trim()) throw new Error("AI 重试领取凭证无效");
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Error("AI 重试执行时间无效");
    return this.#process(draft.id, options.onProgress, {
      expectedClaimToken: claimToken,
      at,
      claimedRetry: true,
      ...(options.platformComplaintEntryState
        ? { platformComplaintEntryState: options.platformComplaintEntryState }
        : {}),
      ...(options.shouldContinue ? { shouldContinue: options.shouldContinue } : {}),
    });
  }

  async #processOwned(
    id: string,
    onProgress?: (message: string) => void,
    shouldContinue?: () => boolean,
    platformComplaintEntryState?: TmallReviewSnapshot["platformComplaintEntryState"],
  ): Promise<DraftProcessItem> {
    const at = this.#now();
    let complaintAnalysisResume = false;
    let claimToken = this.#replies.claimDraftProcessing(id, { at, leaseMs: 30 * 60_000 });
    if (!claimToken) {
      claimToken = this.#replies.claimFailedComplaintAnalysisProcessing(id, { at, leaseMs: 30 * 60_000 });
      complaintAnalysisResume = claimToken !== null;
    }
    if (!claimToken) {
      const record = this.#requireRecord(id);
      return { id, state: record.state, outcome: "skipped", skipped: true };
    }
    const item = await this.#process(id, onProgress, {
      expectedClaimToken: claimToken,
      at,
      ...(complaintAnalysisResume ? { complaintAnalysisResume: true } : {}),
      ...(platformComplaintEntryState ? { platformComplaintEntryState } : {}),
      ...(shouldContinue ? { shouldContinue } : {}),
    });
    if (item.outcome === "paused" || item.outcome === "circuit_breaker") {
      const releaseInput = { claimToken, at: this.#operationAt({ at }) };
      if (!this.#replies.releaseDraftProcessingClaim(id, releaseInput)) {
        this.#replies.releaseFailedComplaintAnalysisProcessingClaim(id, releaseInput);
      }
    }
    return item;
  }

  async #process(
    id: string,
    onProgress?: (message: string) => void,
    control: ProcessControl = {},
  ): Promise<DraftProcessItem> {
    try {
      let record = this.#requireRecord(id);
      let listedUnknownPositiveAlreadyAdjudicated = false;
      const complaintEvaluationRequired = record.state === "discovered"
        || (control.claimedRetry === true
          && record.state === "retry_wait"
          && record.failedStage === "classification"
          && record.aiCheckpointStage === null
          && record.library === null);

      // A claimed classification retry has no frozen template yet, so the
      // manual-product sentiment gate must be evaluated again. A rewrite
      // checkpoint skips it to preserve the already frozen template choice.
      // A safe failed-complaint recovery already completed this gate before
      // the earlier complaint call, so it proceeds directly to classification.
      if (record.aiCheckpointStage !== "template_selected" && !control.complaintAnalysisResume) {
        if (control.shouldContinue && !control.shouldContinue()) {
          return { id, state: record.state, outcome: "paused" };
        }
        let manualDecision: StageAttempt<Awaited<ReturnType<ManualProductPolicy["evaluate"]>> | undefined>;
        try {
          manualDecision = await this.#attemptStage<Awaited<ReturnType<ManualProductPolicy["evaluate"]>> | undefined>(
            "classification",
            id,
            async () => await this.#manualProductPolicy?.evaluate(id, {
              propagateSentimentErrors: true,
              ...(control.shouldContinue ? { shouldContinue: control.shouldContinue } : {}),
              ...(control.expectedClaimToken ? {
                expectedRetryClaimToken: control.expectedClaimToken,
                now: () => this.#operationAt(control),
              } : {}),
            }),
            control,
          );
        } catch (error) {
          if (!(error instanceof ReviewActionConflictError) || control.claimedRetry) throw error;
          const protectedDraft = this.#requireRecord(id);
          return { id, state: protectedDraft.state, outcome: "skipped", skipped: true };
        }
        if (manualDecision.status === "paused") {
          return { id, state: this.#requireRecord(id).state, outcome: "paused" };
        }
        if (manualDecision.status === "exhausted") {
          return this.#recordRoundFailure(id, "classification", manualDecision.errorKind, control);
        }
        if (manualDecision.value?.action === "manual_hold") {
          return { id, state: this.#requireRecord(id).state, outcome: "completed" };
        }
        listedUnknownPositiveAlreadyAdjudicated = manualDecision.value?.action === "continue"
          && manualDecision.value.matchedBy === "item_id"
          && manualDecision.value.sentiment === "positive"
          && manualDecision.value.sentimentAdjudicated === true
          && record.sentimentLabel === "unknown";
        record = this.#requireRecord(id);
      }

      if (record.aiCheckpointStage === "template_selected") {
        return await this.#rewriteFromCheckpoint(record, control, onProgress);
      }
      const { good, bad, goodVersionId, badVersionId, categories } = this.#validatedTemplateCatalog();

      if (control.shouldContinue && !control.shouldContinue()) {
        return { id, state: record.state, outcome: "paused" };
      }
      onProgress?.("正在判断评论分类");
      const classified = await this.#attemptStage("classification", record.id, async () => {
        const modelClassification = await this.#ai.classifyReview({
          review: record.review,
          product: record.product,
          sentimentLabel: record.sentimentLabel,
          categories,
        });
        let classification = applyExplicitValueComparisonGuard(modelClassification, record.review);
        classification = applyNoUseExperienceGuard(
          classification,
          record.review,
          FIXED_TEMPLATE_SCHEMAS.good.fallbackCategory,
        );
        const primarySentiment = {
          sentiment: classification.library === "good" ? "positive" as const : "negative" as const,
          confidence: classification.confidence,
          reason: classification.reason,
        };
        const resolvedSentiment = listedUnknownPositiveAlreadyAdjudicated && classification.library === "good"
          ? primarySentiment
          : await resolvePositiveRiskSentiment({
            review: record.review,
            product: record.product,
            reviewPhase: record.reviewPhase,
            primary: primarySentiment,
            model: this.#sentimentAdjudicationModel(),
            ...(control.shouldContinue ? { control: { shouldContinue: control.shouldContinue } } : {}),
          });
        if (classification.library === "good" && resolvedSentiment.sentiment === "negative") {
          classification = {
            library: "bad",
            category: FIXED_TEMPLATE_SCHEMAS.bad.fallbackCategory,
            confidence: resolvedSentiment.confidence,
            reason: `情感最终裁决：${resolvedSentiment.reason}`.slice(0, 100),
            needsAttention: classification.needsAttention,
          };
        } else if (classification.library === "good") {
          classification = {
            ...classification,
            confidence: resolvedSentiment.confidence,
            reason: resolvedSentiment.reason,
          };
        }
        const fallbackCategory = FIXED_TEMPLATE_SCHEMAS[classification.library].fallbackCategory;
        const refinedCategory = refineFallbackCategory({
          library: classification.library,
          category: classification.category,
          fallbackCategory,
          review: record.review,
          product: record.product,
          categories,
        });
        if (refinedCategory !== classification.category) {
          classification = {
            ...classification,
            category: refinedCategory,
            reason: `${classification.reason}；具体评价维度命中${refinedCategory}`.slice(0, 100),
          };
        }
        const libraryCategories = classification.library === "good" ? good : bad;
        const selected = libraryCategories.find((item) => item.category === classification.category);
        if (!selected) {
          throw new DeepSeekModelContractError("返回分类不属于当前话术库");
        }
        const fallback = libraryCategories.find((item) => item.category === fallbackCategory);
        if (!fallback) throw this.#templateConfigurationError();
        return {
          classification,
          primaryCategory: selected.primaryCategory,
          category: selected.category,
          replies: selected.replies,
          fallbackReplies: fallback.replies,
          templateVersionId: classification.library === "good" ? goodVersionId : badVersionId,
        } satisfies ClassifiedTemplate;
      }, control);
      if (classified.status === "paused") {
        return { id, state: this.#requireRecord(id).state, outcome: "paused" };
      }
      if (classified.status === "exhausted") {
        // A safe complaint-recovery claim still owns the complaint action
        // boundary. Leave that case untouched and release the short AI lease
        // through #processOwned instead of converting it into a reply retry.
        if (control.complaintAnalysisResume) {
          return { id, state: this.#requireRecord(id).state, outcome: "circuit_breaker" };
        }
        return this.#recordRoundFailure(id, "classification", classified.errorKind, control);
      }

      // Page sentiment is only metadata and is frequently unavailable. The
      // ordinary classifier supplies the first reliable semantic decision;
      // complaint screening therefore runs afterwards using that final
      // positive/negative result, but still before any reply checkpoint.
      const selected = classified.value;
      if (selected.classification.skipReply) {
        const marked = this.#replies.markNotActionable(
          record.id,
          "CELEBRITY_REVIEW_SKIPPED",
          selected.classification.skipReason || "评价提及公众人物关联内容，已按规则跳过回复",
        );
        return { id: marked.id, state: marked.state, outcome: "skipped", skipped: true };
      }
      if (this.#complaintPolicy
        && complaintEvaluationRequired
        && record.aiCheckpointStage === null
        && record.library === null) {
        if (control.shouldContinue && !control.shouldContinue()) {
          return { id, state: record.state, outcome: "paused" };
        }
        onProgress?.("正在核对评价投诉资格");
        const complaintDecision = await this.#complaintPolicy.evaluate({
          ...record,
          sentimentLabel: selected.classification.library === "good" ? "positive" : "negative",
        }, {
          ...(control.shouldContinue ? { shouldContinue: control.shouldContinue } : {}),
          ...(control.platformComplaintEntryState
            ? { complaintEntryState: control.platformComplaintEntryState }
            : {}),
        });
        if (complaintDecision.action === "paused") {
          return { id, state: this.#requireRecord(id).state, outcome: "paused" };
        }
        if (complaintDecision.action === "error") {
          return { id, state: this.#requireRecord(id).state, outcome: "circuit_breaker" };
        }
        if (complaintDecision.action === "manual_action_required") {
          return { id, state: this.#requireRecord(id).state, outcome: "skipped", skipped: true };
        }
        if (complaintDecision.action === "skip") {
          if (complaintDecision.caseState === "not_actionable") {
            const marked = this.#replies.markNotActionable(
              record.id,
              "TMALL_PLATFORM_ALREADY_HANDLED",
              "当前评价没有可用投诉入口，或平台未受理本次投诉；平台已处理，无需重复投诉",
            );
            return { id: marked.id, state: marked.state, outcome: "skipped", skipped: true };
          }
          return { id, state: this.#requireRecord(id).state, outcome: "skipped", skipped: true };
        }
        record = this.#requireRecord(id);
      }

      onProgress?.("正在选择回复话术");
      if (selected.replies.length === 0) throw this.#templateConfigurationError();
      let picked;
      try {
        picked = selectReplyTemplate({
          review: record.review,
          product: record.product,
          replies: selected.replies,
          fallbackReplies: selected.fallbackReplies,
          pickIndex: this.#pickIndex,
        });
      } catch {
        throw this.#templateConfigurationError();
      }
      const checkpointAt = this.#operationAt(control);
      record = this.#replies.saveAiCheckpoint(id, {
        library: selected.classification.library,
        primaryCategory: selected.primaryCategory,
        category: selected.category,
        confidence: selected.classification.confidence,
        reason: selected.classification.reason,
        needsAttention: selected.classification.needsAttention,
        templateVersionId: selected.templateVersionId,
        templateSequence: picked.sequence,
        originalTemplate: picked.text,
        ...this.#writeOptions(control, checkpointAt),
      });

      if (control.shouldContinue && !control.shouldContinue()) {
        return { id, state: record.state, outcome: "paused" };
      }
      return await this.#rewriteFromCheckpoint(record, control, onProgress);
    } catch (error) {
      if (error instanceof ReviewActionConflictError) throw error;
      const configuration = this.#configurationFailure(error);
      if (configuration) return this.#failConfiguration(id, configuration, control);
      const failed = this.#replies.fail(
        id,
        "DRAFT_PROCESSING_FAILED",
        "回复草稿生成失败，请稍后重试",
        this.#writeOptions(control, this.#operationAt(control)),
      );
      const current = this.#requireRecord(id);
      return failed
        ? { id, state: current.state, outcome: "manual_action_required" }
        : { id, state: current.state, outcome: "skipped", skipped: true };
    }
  }

  async #rewriteFromCheckpoint(
    record: PersistedReplyDraft,
    control: ProcessControl,
    onProgress?: (message: string) => void,
  ): Promise<DraftProcessItem> {
    if (!record.library || !record.category || !record.templateVersionId
      || !record.templateSequence || !record.originalTemplate.trim()) {
      throw this.#templateConfigurationError();
    }
    if (control.shouldContinue && !control.shouldContinue()) {
      return { id: record.id, state: record.state, outcome: "paused" };
    }
    if (record.state !== "rewriting") {
      this.#replies.markRewriting(record.id, this.#writeOptions(control, this.#operationAt(control)));
    }

    onProgress?.("正在修正商品信息");
    const rewritten = await this.#attemptStage("rewrite", record.id, async () => {
      const candidate = await this.#ai.rewriteTemplate({
        review: record.review,
        product: record.product,
        category: record.category,
        template: record.originalTemplate,
      });
      this.#assertTemplatePreservingRewrite(record, candidate);
      return candidate;
    }, control);
    if (rewritten.status === "paused") {
      return { id: record.id, state: this.#requireRecord(record.id).state, outcome: "paused" };
    }
    if (rewritten.status === "exhausted") {
      return this.#recordRoundFailure(record.id, "rewrite", rewritten.errorKind, control);
    }
    // A completed model request is not permission to make the reply
    // submit-ready: pause/close may have won while the request was in flight.
    // Keep the frozen template checkpoint so resume reuses it without another
    // random selection, and deliberately discard this uncommitted result.
    if (control.shouldContinue && !control.shouldContinue()) {
      return { id: record.id, state: this.#requireRecord(record.id).state, outcome: "paused" };
    }

    const rewrite = rewritten.value;
    const attentionReasons = this.#attentionReasons(
      record,
      record.classificationConfidence ?? 0,
      rewrite.finalReply,
    );
    const classificationNeedsAttention = record.attentionReasons.includes("AI 建议人工检查分类");
    this.#replies.complete(record.id, {
      finalReply: rewrite.finalReply,
      productAdjusted: rewrite.productAdjusted,
      needsAttention: classificationNeedsAttention || rewrite.needsAttention,
      notes: rewrite.notes,
      attentionReasons,
      detectedTemplateProducts: rewrite.detectedTemplateProducts,
      unsupportedClaims: rewrite.unsupportedClaims,
      ...this.#writeOptions(control, this.#operationAt(control)),
    });
    onProgress?.("回复草稿已生成");
    return { id: record.id, state: this.#requireRecord(record.id).state, outcome: "completed" };
  }

  /**
   * The selected Feishu row is the source of truth.  The model may identify
   * legacy product tokens and replace those exact tokens with the product on
   * the current review, or remove explicitly identified unsupported product
   * claims.  It must never paraphrase the rest of a merchant-approved
   * template.
   */
  #assertTemplatePreservingRewrite(record: PersistedReplyDraft, rewrite: TemplateRewriteResult): void {
    const original = record.originalTemplate.trim();
    const product = record.product.trim();
    if (!original || !product || !rewrite.finalReply.trim()) {
      throw new DeepSeekModelContractError("模板修正缺少必要内容");
    }
    const detected = [...new Set(rewrite.detectedTemplateProducts.map((item) => item.trim()).filter(Boolean))];
    const unsupported = [...new Set(rewrite.unsupportedClaims.map((item) => item.trim()).filter(Boolean))];
    if (detected.some((item) => item.length < 2 || !original.includes(item))
      || unsupported.some((item) => item.length < 2 || !original.includes(item))) {
      throw new DeepSeekModelContractError("模板修正包含未在原话术中出现的产品片段");
    }
    let expected = original;
    for (const claim of unsupported) expected = expected.split(claim).join("");
    for (const oldProduct of detected) expected = expected.split(oldProduct).join(product);
    if (rewrite.finalReply.trim() !== expected.trim()) {
      throw new DeepSeekModelContractError("模板修正改动了商品信息以外的内容");
    }
    if (rewrite.productAdjusted !== (expected.trim() !== original)) {
      throw new DeepSeekModelContractError("模板修正状态与实际变更不一致");
    }
  }

  async #attemptStage<T>(
    _stage: AiRetryStage,
    draftId: string,
    operation: () => Promise<T>,
    control: ProcessControl,
  ): Promise<StageAttempt<T>> {
    try {
      this.#assertClaimBeforeAiCall(draftId, control);
      return { status: "success", value: await operation() };
    } catch (error) {
      if (error instanceof SentimentAdjudicationPausedError) return { status: "paused" };
      if (error instanceof ReviewActionConflictError || error instanceof DeepSeekConfigurationError) throw error;
      const firstKind = this.#retryErrorKind(error);
      if (control.shouldContinue && !control.shouldContinue()) return { status: "paused" };
      await this.#sleep(1_000);
      if (control.shouldContinue && !control.shouldContinue()) return { status: "paused" };
      try {
        this.#assertClaimBeforeAiCall(draftId, control);
        return { status: "success", value: await operation() };
      } catch (secondError) {
        if (secondError instanceof SentimentAdjudicationPausedError) return { status: "paused" };
        if (secondError instanceof ReviewActionConflictError || secondError instanceof DeepSeekConfigurationError) {
          throw secondError;
        }
        return { status: "exhausted", errorKind: this.#retryErrorKind(secondError ?? firstKind) };
      }
    }
  }

  #assertClaimBeforeAiCall(draftId: string, control: ProcessControl): void {
    if (!control.expectedClaimToken) return;
    const at = this.#operationAt(control);
    if (!this.#replies.renewAiRetryClaim(draftId, {
      claimToken: control.expectedClaimToken,
      at,
      // Internal ownership only; it is released on pause/stop/failure and
      // startup recovery, so this is never a user-visible waiting lock.
      leaseMs: 30 * 60_000,
    })) {
      throw new ReviewActionConflictError("ACTION_VERSION_CONFLICT", "AI retry claim is no longer active");
    }
    this.#replies.assertAiRetryClaim(draftId, control.expectedClaimToken, at);
  }

  #recordRoundFailure(
    id: string,
    failedStage: AiRetryStage,
    errorKind: AiRetryErrorKind,
    control: ProcessControl,
  ): DraftProcessItem {
    const failedAt = this.#operationAt(control);
    const saved = this.#replies.recordAiRetryRoundFailure(id, {
      failedStage,
      errorKind,
      nextRetryAt: new Date(failedAt.getTime() + 5 * 60_000),
      ...this.#writeOptions(control, failedAt),
    });
    return {
      id,
      state: saved.state,
      outcome: saved.consecutiveAiFailureRounds >= 3 ? "circuit_breaker" : "retry_wait",
    };
  }

  #validatedTemplateCatalog(): {
    good: ReturnType<TemplateRepository["getActiveCategories"]>;
    bad: ReturnType<TemplateRepository["getActiveCategories"]>;
    goodVersionId: number;
    badVersionId: number;
    categories: ReviewCategoryCandidate[];
  } {
    const good = this.#templates.getActiveCategories("good");
    const bad = this.#templates.getActiveCategories("bad");
    const goodVersion = this.#templates.getActiveVersionId("good");
    const badVersion = this.#templates.getActiveVersionId("bad");
    const goodFallback = FIXED_TEMPLATE_SCHEMAS.good.fallbackCategory;
    const badFallback = FIXED_TEMPLATE_SCHEMAS.bad.fallbackCategory;
    const goodGeneric = good.find((item) => item.category === goodFallback);
    const badGeneric = bad.find((item) => item.category === badFallback);
    if (!goodVersion || !badVersion || good.length === 0 || bad.length === 0
      || !goodGeneric || !badGeneric || goodGeneric.replies.length === 0 || badGeneric.replies.length === 0
      || badGeneric.primaryCategory !== badFallback
      || good.some((item) => item.replies.length === 0)
      || bad.some((item) => item.replies.length === 0)) {
      throw this.#templateConfigurationError();
    }
    const categories = [
      ...good.map((item) => ({ ...item, library: "good" as const })),
      ...bad.map((item) => ({ ...item, library: "bad" as const })),
    ].map(({ library, primaryCategory, category, keywords }) => ({ library, primaryCategory, category, keywords }));
    return { good, bad, goodVersionId: goodVersion, badVersionId: badVersion, categories };
  }

  #retryErrorKind(error: unknown): AiRetryErrorKind {
    if (error instanceof DeepSeekModelContractError) return "model_contract";
    if (error instanceof DeepSeekTransientError) return error.kind;
    return "transient_unknown";
  }

  #sentimentAdjudicationModel(): Required<Pick<DeepSeekClientApi, "reviewSentiment" | "adjudicateSentiment">> {
    return {
      reviewSentiment: async (input) => {
        if (!this.#ai.reviewSentiment) {
          throw new DeepSeekConfigurationError("model_unavailable", "DeepSeek independent sentiment review is not configured");
        }
        return await this.#ai.reviewSentiment(input);
      },
      adjudicateSentiment: async (input) => {
        if (!this.#ai.adjudicateSentiment) {
          throw new DeepSeekConfigurationError("model_unavailable", "DeepSeek sentiment adjudication is not configured");
        }
        return await this.#ai.adjudicateSentiment(input);
      },
    };
  }

  #configurationFailure(error: unknown): ConfigurationFailure | null {
    if (error instanceof DraftConfigurationError) return { code: error.code, message: error.message };
    if (!(error instanceof DeepSeekConfigurationError)) return null;
    if (error.code === "authentication") {
      return {
        code: "DEEPSEEK_AUTHENTICATION_REQUIRED",
        message: "DeepSeek 连接信息无效，请在系统设置中重新保存并验证",
      };
    }
    if (error.code === "missing_api_key") {
      return {
        code: "DEEPSEEK_CONFIGURATION_REQUIRED",
        message: "请先在系统设置中保存并验证 DeepSeek 连接信息",
      };
    }
    if (error.code === "insufficient_balance") {
      return {
        code: "DEEPSEEK_BALANCE_REQUIRED",
        message: "DeepSeek 账户余额不足，请充值后在系统设置中重新验证",
      };
    }
    if (error.code === "request_contract") {
      return {
        code: "DEEPSEEK_REQUEST_CONFIGURATION_REQUIRED",
        message: "DeepSeek 请求配置不可用，请在系统设置中重新验证",
      };
    }
    return {
      code: "DEEPSEEK_MODEL_CONFIGURATION_REQUIRED",
      message: "DeepSeek 模型当前不可用，请检查模型配置后重试",
    };
  }

  #failConfiguration(id: string, failure: ConfigurationFailure, control: ProcessControl): DraftProcessItem {
    const failed = this.#replies.fail(
      id,
      failure.code,
      failure.message,
      this.#writeOptions(control, this.#operationAt(control)),
    );
    const current = this.#requireRecord(id);
    return failed
      ? { id, state: current.state, outcome: "manual_action_required" }
      : { id, state: current.state, outcome: "skipped", skipped: true };
  }

  #templateConfigurationError(): DraftConfigurationError {
    return new DraftConfigurationError(TEMPLATE_CONFIGURATION_FAILURE.code, TEMPLATE_CONFIGURATION_FAILURE.message);
  }

  #operationAt(control: ProcessControl): Date {
    const actual = this.#now();
    if (!(actual instanceof Date) || Number.isNaN(actual.getTime())) throw new Error("AI 处理时间无效");
    if (!control.at) return new Date(actual.getTime());
    if (!(control.at instanceof Date) || Number.isNaN(control.at.getTime())) throw new Error("AI 处理时间无效");
    return new Date(Math.max(control.at.getTime(), actual.getTime()));
  }

  #writeOptions(control: ProcessControl, at: Date): { expectedClaimToken?: string; at: Date } {
    return control.expectedClaimToken ? { expectedClaimToken: control.expectedClaimToken, at } : { at };
  }

  #requireRecord(id: string): PersistedReplyDraft {
    const record = this.#replies.get(id);
    if (!record) throw new Error("回复草稿不存在");
    return record;
  }

  #attentionReasons(
    record: PersistedReplyDraft,
    confidence: number,
    finalReply: string,
  ): string[] {
    const reasons: string[] = [];
    // Platform sentiment is untrusted diagnostic metadata. A disagreement
    // with the content classifier must not block an otherwise safe reply.
    if (confidence < 0.65) reasons.push("AI 分类置信度较低");
    if (record.product === "商品名称未识别") reasons.push("商品名称未能从页面中识别");
    if (/退货|退款|赔偿|补偿|无条件|保证给您/u.test(finalReply)) {
      reasons.push("草稿包含需要人工确认的售后承诺词");
    }
    return reasons;
  }
}
