import { createHash } from "node:crypto";
import {
  ComplaintAnalysisContractError,
  ComplaintAnalysisScope,
  COMPLAINT_TYPES,
  executeTrackedComplaintModelInvocation,
  isFactEligible,
  redactComplaintAnalysisText,
  validateComplaintAnalysis,
  type ComplaintEligibilityFacts,
  type ComplaintModelResult,
  type RedactedComplaintAnalysisText,
} from "./complaint-domain";
import type { ComplaintAnalysisModel } from "./deepseek-complaint-analysis";
import { DeepSeekConfigurationError, DeepSeekModelContractError, DeepSeekTransientError } from "../deepseek/client";
import {
  ComplaintRepository,
  type ComplaintCaseRecord,
} from "../storage/complaint-repository";
import type { PersistedReplyDraft } from "../storage/repositories";
import type {
  TmallPlatformActionState,
  TmallPlatformComplaintEntryState,
} from "../tmall/review-reader";

export interface ComplaintEligibilityVerifier {
  verify(input: {
    draft: PersistedReplyDraft;
    caseId: string;
    result: ComplaintModelResult;
    primaryInvocationId: string;
    control?: ComplaintReviewControl;
    analysisText: string;
    redacted: RedactedComplaintAnalysisText;
  }): Promise<{ finalResult: ComplaintModelResult; facts: ComplaintEligibilityFacts }>;
}

export type ComplaintExecutionResult =
  | ({ state: "submitted" } & (
      | { platformCaseId: string; detailUrl?: string }
      | { platformCaseId?: string; detailUrl: string }
    ))
  | { state: "uncertain"; reason: string }
  | { state: "already_handled"; reason: string }
  | { state: "failed_before_click"; reason: string };

/**
 * This is the only seam allowed to conduct a complaint action. The service
 * deliberately has no page, chat-history, or evidence-upload capability.
 */
export interface ComplaintExecutor {
  execute(input: {
    case: ComplaintCaseRecord;
    sourceKey: string;
    reviewPhase: "initial" | "followup";
    /**
     * Must be called immediately before the browser clicks the final complaint
     * submit control. Opening a panel, selecting a type and filling the
     * description are all still safely retryable before this checkpoint.
     */
    beforeSubmit(): void;
  }): Promise<ComplaintExecutionResult>;
}

export type ComplaintReviewDecision =
  | { action: "reply"; caseId: string; caseState: "no_complaint" | "rejected" }
  | { action: "manual_action_required"; caseId: string; caseState: ComplaintCaseRecord["state"] }
  | { action: "error"; caseId: string; caseState: "failed" }
  | { action: "paused"; caseId: string; caseState: ComplaintCaseRecord["state"] }
  | { action: "skip"; caseId: string; caseState: ComplaintCaseRecord["state"] };

export interface ComplaintReviewPolicy {
  evaluate(draft: PersistedReplyDraft, control?: ComplaintReviewControl): Promise<ComplaintReviewDecision>;
  reconcilePlatformState?(
    draft: PersistedReplyDraft,
    state: TmallPlatformActionState,
  ): Promise<ComplaintReviewDecision | null>;
}

export interface ComplaintReviewControl {
  shouldContinue?: () => boolean;
  complaintEntryState?: TmallPlatformComplaintEntryState;
}
export interface ComplaintInvocationLedger {
  recordAnalysisInvocation(caseId: string, pass: "primary" | "independent_review" | "adjudication", result: ComplaintModelResult, invocationId: string): void;
}

const ANALYSIS_PROMPT_VERSION = "2026-07-24-v5";
const ANALYSIS_RULE_VERSION = "2026-07-24-v3";
const FACT_MAPPING_VERSION = "2026-07-23-v2";
const VISUAL_VERSION = "2026-07-14-v1";
const PLATFORM_OPTION_MAPPING_VERSION = "2026-07-14-v1";
const MODEL_VERSION = "deepseek-complaint-analysis-v1";

/**
 * Complaint analysis always owns a review before any reply classification.
 * A no-complaint decision atomically becomes the reply lock; every other
 * outcome keeps the complaint lock, so reply and complaint cannot overlap.
 */
export class ComplaintReviewService implements ComplaintReviewPolicy {
  readonly #complaints: ComplaintRepository;
  readonly #model: ComplaintAnalysisModel;
  readonly #verifier: ComplaintEligibilityVerifier;
  readonly #executor: ComplaintExecutor | undefined;
  readonly #storeId: string;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: {
    complaints: ComplaintRepository;
    model: ComplaintAnalysisModel;
    verifier: ComplaintEligibilityVerifier;
    executor?: ComplaintExecutor;
    storeId?: string;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    this.#complaints = options.complaints;
    this.#model = options.model;
    this.#verifier = options.verifier;
    this.#executor = options.executor;
    this.#storeId = options.storeId ?? "primary";
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async evaluate(draft: PersistedReplyDraft, control: ComplaintReviewControl = {}): Promise<ComplaintReviewDecision> {
    let current = this.#complaints.findBySource(this.#storeId, draft.sourceKey);
    if (!current) {
      current = this.#complaints.discover(this.#storeId, draft.sourceKey, {
        reviewId: draft.sourceKey,
        contentHash: contentHash(draft.review, draft.reviewPhase),
        canonicalizerVersion: "review-content-v1",
        phase: draft.reviewPhase,
        imagePairs: [],
        promptVersion: ANALYSIS_PROMPT_VERSION,
        ruleVersion: ANALYSIS_RULE_VERSION,
        mappingVersion: FACT_MAPPING_VERSION,
        visualVersion: VISUAL_VERSION,
        platformMappingVersion: PLATFORM_OPTION_MAPPING_VERSION,
        modelVersion: MODEL_VERSION,
      });
    }
    if (!current) throw new Error("投诉案件创建失败");

    if (control.complaintEntryState === "unavailable") {
      const handled = this.#complaints.markPlatformAlreadyHandled(current.id);
      return { action: "skip", caseId: handled.id, caseState: handled.state };
    }

    if (current.state === "manual_action_required" && current.complaintType === null && current.promptVersion !== ANALYSIS_PROMPT_VERSION) {
      current = this.#complaints.reopenForPromptUpgrade(current.id, ANALYSIS_PROMPT_VERSION);
    }
    if (current?.state === "failed") current = this.#complaints.reopenFailedAnalysis(current.id);
    const known = this.#decisionForKnownCase(current);
    if (known) return known;

    if (current.state === "discovered" || current.state === "analyzing") {
      const analyzed = await this.#analyzeAndPersist(current, draft, control);
      if (analyzed.action !== "manual_action_required") return analyzed;
      current = this.#complaints.get(analyzed.caseId)!;
    }

    if (current.state === "prepared") return this.#executePrepared(current, draft, control);
    return this.#manual(current);
  }

  async reconcilePlatformState(
    draft: PersistedReplyDraft,
    state: TmallPlatformActionState,
  ): Promise<ComplaintReviewDecision | null> {
    if (!["complaint_record", "complaint_under_review", "complaint_upheld", "complaint_rejected"].includes(state)) {
      return null;
    }
    let current = this.#complaints.findBySource(this.#storeId, draft.sourceKey);
    if (!current) {
      current = this.#complaints.discover(this.#storeId, draft.sourceKey, {
        reviewId: draft.sourceKey,
        contentHash: contentHash(draft.review, draft.reviewPhase),
        canonicalizerVersion: "review-content-v1",
        phase: draft.reviewPhase,
        imagePairs: [],
        promptVersion: ANALYSIS_PROMPT_VERSION,
        ruleVersion: ANALYSIS_RULE_VERSION,
        mappingVersion: FACT_MAPPING_VERSION,
        visualVersion: VISUAL_VERSION,
        platformMappingVersion: PLATFORM_OPTION_MAPPING_VERSION,
        modelVersion: MODEL_VERSION,
      });
    }
    const reconciled = this.#complaints.reconcileObservedPlatformComplaint(
      current.id,
      state as "complaint_record" | "complaint_under_review" | "complaint_upheld" | "complaint_rejected",
    );
    return { action: "skip", caseId: reconciled.id, caseState: reconciled.state };
  }

  async #analyzeAndPersist(current: ComplaintCaseRecord, draft: PersistedReplyDraft, control: ComplaintReviewControl): Promise<ComplaintReviewDecision> {
    const scope = new ComplaintAnalysisScope();
    try {
      const redacted = redactComplaintAnalysisText(draft.review, scope);
      assertComplaintContinue(control);
      const primaryCall = await callComplaintModelWithOneRetry(this.#model, {
        pass: "primary",
        review: redacted,
        // The model receives the complete fixed official catalogue. It is not
        // allowed to invent a browser label or a free-form complaint type.
        officialTypes: COMPLAINT_TYPES.map((item) => item.code),
        productName: draft.product,
      }, control, this.#sleep);
      this.#complaints.recordAnalysisInvocation(current.id, "primary", primaryCall.result, primaryCall.invocationId);
      assertComplaintContinue(control);
      const { finalResult: result, facts } = await this.#verifier.verify({ caseId: current.id, draft, result: primaryCall.result, primaryInvocationId: primaryCall.invocationId, control, analysisText: redacted.analysisText, redacted });
      assertComplaintContinue(control);
      // A text-only candidate is actionable only when its deterministic facts
      // satisfy the controlled mapping below. An unproven candidate must not
      // halt the reply queue.
      if (result.decision === "complaint_candidate"
        && result.complaintType === "meaningless_content"
        && facts.meaninglessProgramDetected === undefined) {
        const released = this.#complaints.finalizeNoComplaint(
          current.id,
          Math.min(result.confidence, 80),
          "评价未满足无意义投诉的严格可核对条件，按普通评价处理",
          { reviewStillReplyable: true },
        );
        return { action: "reply", caseId: released.id, caseState: "no_complaint" };
      }
      if (result.decision === "complaint_candidate"
        && !isFactEligible(result.complaintType as Exclude<ComplaintModelResult["complaintType"], "none">, facts, result, redacted.analysisText)) {
        const released = this.#complaints.finalizeNoComplaint(
          current.id,
          Math.min(result.confidence, 80),
          "投诉候选缺少可由现有数据硬校验的客观事实，按普通评价继续处理",
          { reviewStillReplyable: true },
        );
        return { action: "reply", caseId: released.id, caseState: "no_complaint" };
      }
      assertComplaintContinue(control);
      const validated = validateComplaintAnalysis({ reviewText: redacted.analysisText, facts, result }, scope);
      if (validated.decision === "no_complaint") {
        const released = this.#complaints.finalizeNoComplaint(current.id, validated.confidence, validated.reason, { reviewStillReplyable: true });
        return { action: "reply", caseId: released.id, caseState: "no_complaint" };
      }
      assertComplaintContinue(control);
      const prepared = this.#complaints.prepareValidatedCandidate(current.id, validated);
      if (!complaintShouldContinue(control)) {
        const rolledBack = this.#complaints.rollbackPreparedBeforeSubmit(prepared.id);
        return { action: "paused", caseId: rolledBack.id, caseState: rolledBack.state };
      }
      if (!this.#executor) return this.#manual(this.#complaints.markManualActionRequired(prepared.id, "manual_required"));
      return this.#executePrepared(prepared, draft, control);
    } catch (error) {
      if (error instanceof ComplaintAnalysisPausedError) {
        return { action: "paused", caseId: current.id, caseState: this.#complaints.get(current.id)?.state ?? current.state };
      }
      // Analysis, fact verification, and model-contract failures must never
      // fall through into a reply. Keep the complaint action lock and expose
      // the review to the operator instead.
      const failed = this.#complaints.markFailed(current.id, complaintAnalysisFailureCode(error));
      return { action: "error", caseId: failed.id, caseState: "failed" };
    } finally {
      scope.clear();
    }
  }

  async #executePrepared(current: ComplaintCaseRecord, draft: PersistedReplyDraft, control: ComplaintReviewControl = {}): Promise<ComplaintReviewDecision> {
    if (!complaintShouldContinue(control)) {
      const rolledBack = this.#complaints.rollbackPreparedBeforeSubmit(current.id);
      return { action: "paused", caseId: rolledBack.id, caseState: rolledBack.state };
    }
    if (!this.#executor) return this.#manual(this.#complaints.markManualActionRequired(current.id, "manual_required"));
    let submitCheckpointWritten = false;
    const beforeSubmit = () => {
      assertComplaintContinue(control);
      if (submitCheckpointWritten) throw new Error("complaint submit checkpoint already written");
      this.#complaints.markAttemptClickStarted(current.id);
      submitCheckpointWritten = true;
    };
    let result: ComplaintExecutionResult;
    try {
      result = await this.#executor.execute({ case: current, sourceKey: draft.sourceKey, reviewPhase: draft.reviewPhase, beforeSubmit });
    } catch (error) {
      if (error instanceof ComplaintAnalysisPausedError && !submitCheckpointWritten) {
        const rolledBack = this.#complaints.rollbackPreparedBeforeSubmit(current.id);
        return { action: "paused", caseId: rolledBack.id, caseState: rolledBack.state };
      }
      const failed = submitCheckpointWritten
        ? this.#complaints.markSubmissionUncertain(current.id, "submission_uncertain")
        : this.#complaints.markFailed(current.id, "platform_changed");
      return { action: "skip", caseId: failed.id, caseState: failed.state };
    }
    if (result.state === "submitted") {
      if (!submitCheckpointWritten) return this.#manual(this.#complaints.markFailed(current.id, "platform_changed"));
      this.#complaints.markAttemptClickFinished(current.id);
      const submitted = this.#complaints.confirmSubmitted(current.id, result);
      return { action: "skip", caseId: submitted.id, caseState: submitted.state };
    }
    if (result.state === "already_handled") {
      const handled = this.#complaints.markPlatformAlreadyHandled(current.id);
      return { action: "skip", caseId: handled.id, caseState: handled.state };
    }
    if (result.state === "uncertain") {
      const uncertain = submitCheckpointWritten
        ? this.#complaints.markSubmissionUncertain(current.id, "submission_uncertain")
        : this.#complaints.markFailed(current.id, "platform_changed");
      return { action: "skip", caseId: uncertain.id, caseState: uncertain.state };
    }
    const failed = submitCheckpointWritten
      ? this.#complaints.markSubmissionUncertain(current.id, "submission_uncertain")
      : this.#complaints.markFailed(current.id, "platform_changed");
    return { action: "skip", caseId: failed.id, caseState: failed.state };
  }

  #decisionForKnownCase(current: ComplaintCaseRecord): ComplaintReviewDecision | null {
    if (current.state === "no_complaint" || current.state === "rejected") {
      return { action: "reply", caseId: current.id, caseState: current.state };
    }
    if (["submitted", "under_review", "upheld", "not_actionable", "closed"].includes(current.state)) {
      return { action: "skip", caseId: current.id, caseState: current.state };
    }
    return null;
  }

  #manual(current: ComplaintCaseRecord): ComplaintReviewDecision {
    return { action: "manual_action_required", caseId: current.id, caseState: current.state };
  }
}

/**
 * Fact-backed verifier for platform complaint types. A tracked primary result
 * is sufficient when its quoted text deterministically proves the selected
 * official fact. Candidates without that direct proof may still use the
 * independent/adjudication path; external facts are never invented.
 */
export function createAdjudicatedComplaintEligibilityVerifier(
  model: ComplaintAnalysisModel,
  options: { sleep?: (milliseconds: number) => Promise<void>; invocations?: ComplaintInvocationLedger } = {},
): ComplaintEligibilityVerifier {
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  return {
    async verify({ caseId, draft, result, primaryInvocationId, control = {}, redacted }) {
      if (result.decision !== "complaint_candidate") return { finalResult: result, facts: {} };
      if (typeof result.quoteStart !== "number" || typeof result.quoteEnd !== "number") {
        return { finalResult: noComplaintAfterAdjudication(), facts: {} };
      }
      const primaryQuote = Array.from(redacted.analysisText).slice(result.quoteStart, result.quoteEnd).join("");
      const primaryFacts: ComplaintEligibilityFacts = {
        ...reviewOnlyFacts(result.complaintType, primaryQuote, {
          productName: draft.product,
          quoteStart: result.quoteStart,
          quoteEnd: result.quoteEnd,
          redacted,
        }),
        primaryConfirmation: {
          confirmed: true,
          pass: "primary",
          sourceInvocationId: primaryInvocationId,
          complaintType: result.complaintType as Exclude<ComplaintModelResult["complaintType"], "none">,
          factCode: result.factCode as Exclude<ComplaintModelResult["factCode"], "none">,
          quoteStart: result.quoteStart,
          quoteEnd: result.quoteEnd,
        },
      };
      if (isFactEligible(
        result.complaintType as Exclude<ComplaintModelResult["complaintType"], "none">,
        primaryFacts,
        result,
        redacted.analysisText,
      )) {
        return { finalResult: result, facts: primaryFacts };
      }
      assertComplaintContinue(control);
      const repeatedCall = await callComplaintModelWithOneRetry(model, {
        pass: "independent_review",
        review: redacted,
        officialTypes: COMPLAINT_TYPES.map((item) => item.code),
        productName: draft.product,
      }, control, sleep);
      assertComplaintContinue(control);
      const repeated = repeatedCall.result;
      options.invocations?.recordAnalysisInvocation(caseId, "independent_review", repeated, repeatedCall.invocationId);
      let finalResult = result;
      let adjudication: ComplaintModelResult | undefined;
      let adjudicationInvocationId: string | undefined;
      if (!sameCandidate(result, repeated)) {
        assertComplaintContinue(control);
        const adjudicationCall = await callComplaintModelWithOneRetry(model, {
          pass: "adjudication",
          review: redacted,
          officialTypes: COMPLAINT_TYPES.map((item) => item.code),
          productName: draft.product,
          priorResults: [result, repeated],
        }, control, sleep);
        assertComplaintContinue(control);
        adjudication = adjudicationCall.result;
        adjudicationInvocationId = adjudicationCall.invocationId;
        options.invocations?.recordAnalysisInvocation(caseId, "adjudication", adjudication, adjudicationInvocationId);
        if (sameCandidate(adjudication, result) || sameCandidate(adjudication, repeated)) {
          finalResult = adjudication;
        } else {
          finalResult = noComplaintAfterAdjudication();
        }
      }
      if (finalResult.decision !== "complaint_candidate") return { finalResult, facts: {} };
      if (typeof finalResult.quoteStart !== "number" || typeof finalResult.quoteEnd !== "number") {
        return { finalResult: noComplaintAfterAdjudication(), facts: {} };
      }
      const confirmationFor = (pass: "primary" | "independent_review" | "adjudication", sourceInvocationId: string, candidate: ComplaintModelResult) => sameCandidate(candidate, finalResult) ? ({
        confirmed: true as const,
        pass,
        sourceInvocationId,
        complaintType: candidate.complaintType as Exclude<ComplaintModelResult["complaintType"], "none">,
        factCode: candidate.factCode as Exclude<ComplaintModelResult["factCode"], "none">,
        quoteStart: candidate.quoteStart as number,
        quoteEnd: candidate.quoteEnd as number,
      }) : undefined;
      const quote = Array.from(redacted.analysisText).slice(finalResult.quoteStart, finalResult.quoteEnd).join("");
      const facts: ComplaintEligibilityFacts = {
        ...reviewOnlyFacts(finalResult.complaintType, quote, {
          productName: draft.product,
          quoteStart: finalResult.quoteStart,
          quoteEnd: finalResult.quoteEnd,
          redacted,
        }),
      };
      const primaryConfirmation = confirmationFor("primary", primaryInvocationId, result);
      const independentConfirmation = confirmationFor("independent_review", repeatedCall.invocationId, repeated);
      const adjudicationConfirmation = adjudication && adjudicationInvocationId ? confirmationFor("adjudication", adjudicationInvocationId, adjudication) : undefined;
      if (primaryConfirmation) facts.primaryConfirmation = primaryConfirmation;
      if (independentConfirmation) facts.independentConfirmation = independentConfirmation;
      if (adjudicationConfirmation) facts.adjudicationConfirmation = adjudicationConfirmation;
      return { finalResult, facts };
    },
  };
}

function sameCandidate(first: ComplaintModelResult, second: ComplaintModelResult): boolean {
  return first.decision === "complaint_candidate"
    && second.decision === "complaint_candidate"
    && first.complaintType === second.complaintType
    && first.factCode === second.factCode;
}

function noComplaintAfterAdjudication(): ComplaintModelResult {
  return { decision: "no_complaint", complaintType: "none", confidence: 0, quoteStart: null, quoteEnd: null, factCode: "none", reason: "多轮审核未形成可硬校验的一致投诉结论" };
}

async function callComplaintModelWithOneRetry(
  model: ComplaintAnalysisModel,
  input: Parameters<ComplaintAnalysisModel["analyzeComplaint"]>[0],
  control: ComplaintReviewControl = {},
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
): Promise<{ result: ComplaintModelResult; invocationId: string }> {
  const invoke = () => executeTrackedComplaintModelInvocation(input.pass, () => model.analyzeComplaint(input));
  try {
    return await invoke();
  } catch (error) {
    if (!isRetryableComplaintModelError(error)) throw error;
    assertComplaintContinue(control);
    await sleep(100);
    assertComplaintContinue(control);
    return invoke();
  }
}

class ComplaintAnalysisPausedError extends Error {}
function complaintShouldContinue(control: ComplaintReviewControl): boolean { return control.shouldContinue?.() !== false; }
function assertComplaintContinue(control: ComplaintReviewControl): void {
  if (!complaintShouldContinue(control)) throw new ComplaintAnalysisPausedError("complaint analysis paused");
}

function isRetryableComplaintModelError(error: unknown): boolean {
  if (error instanceof DeepSeekConfigurationError || error instanceof ComplaintAnalysisPausedError) return false;
  return error instanceof DeepSeekTransientError
    || error instanceof DeepSeekModelContractError
    || error instanceof ComplaintAnalysisContractError
    || error instanceof Error;
}

function reviewOnlyFacts(
  type: ComplaintModelResult["complaintType"],
  quote: string,
  context: {
    productName: string;
    quoteStart: number;
    quoteEnd: number;
    redacted: RedactedComplaintAnalysisText;
  },
): ComplaintEligibilityFacts {
  const compact = quote.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "");
  if (type === "purchase_a_review_b") {
    const reviewMismatch = /(?:这|该)(?:条)?(?:评价|评论).{0,8}(?:写错|评错|评价错|说的是|针对的是).{0,20}(?:商品|产品|音箱|耳机|扩音器)|(?:评价|评论).{0,8}(?:不是|并非)(?:这|该|本)(?:件|款|个)?(?:商品|产品)/u.test(quote);
    const deliveryMismatch = /(?:发错|寄错|收到|发来|寄来).{0,8}(?:商品|货|型号|颜色)/u.test(quote);
    return reviewMismatch && !deliveryMismatch
      ? { targetsOtherProduct: true, otherProductExcludedContext: false }
      : {};
  }
  if (type === "meaningless_content") {
    // Only truly content-free/repetitive snippets qualify. “不好”“垃圾耳机”
    // and logistics/service feedback remain ordinary reviews, never complaints.
    const hasBusinessContext = /(商品|耳机|质量|声音|音质|物流|快递|客服|售后|退款|退货|发货|店铺|商家|服务|好用|推荐|满意|喜欢|舒服|佩戴|续航|包装|连接|链接|蓝牙|降噪|价格|图片|使用|效果)/u.test(quote);
    const compactCharacters = Array.from(compact);
    const repeatedRuns = Array.from(compact.matchAll(/(.)\1+/gu));
    const repeatedCharacterCount = repeatedRuns.reduce((count, match) => count + Array.from(match[0]).length, 0);
    const shortRepetition = compactCharacters.length > 0
      && compactCharacters.length <= 8
      && new Set(compactCharacters).size <= 2;
    const multiRunGibberish = compactCharacters.length >= 8
      && compactCharacters.length <= 40
      && repeatedRuns.length >= 3
      && repeatedCharacterCount / compactCharacters.length >= 0.45;
    const repetitive = shortRepetition || multiRunGibberish;
    return repetitive && !hasBusinessContext
      ? { meaninglessProgramDetected: true, shortSentimentExcluded: true, logisticsOrServiceExcluded: true }
      : {};
  }
  if (type === "insulting_content") {
    const targetsPerson = /(客服|店员|老板|商家|你们|你|人)/u.test(quote);
    const personaAttack = /(傻[逼B]|废物|骗子|脑残|去死|畜生|垃圾人)/u.test(quote);
    return targetsPerson && personaAttack
      ? { targetsSpecificPerson: true, personaAttack: true, productOnlyNegative: false }
      : {};
  }
  if (type === "advertising_content") {
    const diversion = /(?:加|联系|私聊|扫码).{0,8}(?:微信|vx|V信|QQ|群|二维码)|(?:微信|vx|V信|QQ).{0,8}(?:购买|下单|咨询|联系)|https?:\/\//iu.test(quote);
    return diversion ? { hasDiversionSignal: true, piiDetected: false } : {};
  }
  if (type === "privacy_leak") {
    const containsRedactedPii = context.redacted.ranges.some((range) =>
      range.start < context.quoteEnd && range.end > context.quoteStart);
    if (!containsRedactedPii) return {};
    const owner = /(快递员|配送员|外卖员|司机)/u.test(quote)
      ? "courier" as const
      : /(客服|店员|老板|商家工作人员|售后人员)/u.test(quote)
        ? "seller_staff" as const
        : /(?:他|她|对方|某人|朋友|同事|邻居|客户)(?:的)?(?:电话|手机|微信|地址|账号)/u.test(quote)
          ? "named_other" as const
          : "unknown" as const;
    return owner === "unknown" ? {} : { piiDetected: true, piiOwner: owner };
  }
  if (type === "political_terror_sensitive") {
    const sensitiveSubject = /(恐怖组织|极端组织|暴恐组织|恐怖袭击|爆炸袭击)/u.test(quote);
    const promotionOrCall = /(支持|加入|宣传|号召|招募|发动|实施|策划|袭击|杀害)/u.test(quote);
    const ordinaryContext = /(历史|新闻|报道|书籍|本书|纪录片|电影|剧情|包装|介绍|研究|讨论)/u.test(quote)
      && !/(支持|加入|号召|招募|实施|策划)/u.test(quote);
    return sensitiveSubject && promotionOrCall && !ordinaryContext
      ? { sensitiveContentConfirmed: true, normalPoliticsHistoryOnly: false }
      : {};
  }
  if (type === "vulgar_sexual_content") {
    const sexualContent = /(色情|成人视频|黄片|裸聊|成人视频|淫秽|招嫖|成人视频)/u.test(quote);
    const normalBodyOrUse = /(耳朵|佩戴|皮肤|胸围|内衣|母婴|哺乳|按摩|医疗|健康|尺寸|疼|过敏)/u.test(quote)
      && !sexualContent;
    return sexualContent && !normalBodyOrUse
      ? { sexualContentConfirmed: true, minorHarmConfirmed: false, normalBodyOrProductUse: false }
      : {};
  }
  if (type === "prohibited_goods") {
    const prohibitedItem = /(冰毒|海洛因|毒品|大麻|枪支|枪械|子弹|弹药|炸药|爆炸物)/u.test(quote);
    const transactionOrPromotion = /(出售|售卖|购买|交易|下单|价格|联系|提供|代理|渠道)/u.test(quote);
    return prohibitedItem && transactionOrPromotion
      ? { prohibitedTransactionConfirmed: true, normalPoliticsHistoryOnly: false }
      : {};
  }
  if (type === "minor_harmful_content") {
    const minor = /(未成年人|未成年|儿童|小孩|幼童|学生)/u.test(quote);
    const harmful = /(色情|裸照|偷拍视频|性侵|猥亵|诱骗|虐待|伤害|贩卖|传播.{0,6}(?:视频|图片))/u.test(quote);
    const normalChildUse = /(给|适合|儿童款|孩子用|孩子买|学生用).{0,12}(?:买|使用|耳机|玩具|衣服|书包|产品|商品|好用)/u.test(quote)
      && !harmful;
    return minor && harmful && !normalChildUse
      ? { minorHarmConfirmed: true, normalChildProductUse: false }
      : {};
  }
  if (type === "extortion_for_improper_benefit") {
    const evaluationCondition = /(?:不然|否则|才|就).{0,12}(?:删|删除|撤回|改|修改).{0,8}(?:差评|评价|评论)|(?:删|删除|撤回|改|修改).{0,8}(?:差评|评价|评论).{0,12}(?:才|否则|不然)/u.test(quote);
    const improperBenefit = /(红包|返现|好处费|封口费|额外赔偿|额外补偿|私下转账)/u.test(quote);
    const normalAfterSales = /(退款|退货|换货|补发|维修|售后|运费|质量问题|商品坏)/u.test(quote)
      && !improperBenefit;
    return evaluationCondition && improperBenefit && !normalAfterSales
      ? { evaluationConditionPresent: true, outOfOrderBenefitDemanded: true, normalAfterSalesDemand: false }
      : {};
  }
  if (type === "competitor_malicious_review") {
    const competitorIdentity = /(?:我|我们)(?:就是|是|作为).{0,4}(?:同行|竞争对手|同业|隔壁店)|(?:同行|竞争对手|同业).{0,4}(?:身份|店家|商家)/u.test(quote);
    const explicitMalice = /(?:专门|故意|就是要|一定要).{0,10}(?:差评|搞垮|整垮|关店|报复|恶心)|(?:搞垮|整垮|报复).{0,8}(?:店|你们|商家)/u.test(quote);
    return competitorIdentity && explicitMalice
      ? { competitorIdentityExplicit: true, competitorMaliceExplicit: true, ordinaryNegativeOnly: false }
      : {};
  }
  return {};
}

function complaintAnalysisFailureCode(error: unknown): "configuration" | "model_contract" | "network" | "timeout" | "internal" {
  if (error instanceof DeepSeekConfigurationError) return "configuration";
  if (error instanceof DeepSeekModelContractError) return "model_contract";
  if (error instanceof ComplaintAnalysisContractError) return "model_contract";
  if (error instanceof DeepSeekTransientError) return error.kind === "timeout" ? "timeout" : "network";
  return "internal";
}

export class UnavailableComplaintReviewPolicy implements ComplaintReviewPolicy {
  async evaluate(draft: PersistedReplyDraft): Promise<ComplaintReviewDecision> {
    return { action: "error", caseId: draft.id, caseState: "failed" };
  }
}

function contentHash(review: string, phase: "initial" | "followup"): string {
  return createHash("sha256").update(`${phase}\0${review.normalize("NFC").replace(/\r\n?/gu, "\n")}`, "utf8").digest("hex");
}
