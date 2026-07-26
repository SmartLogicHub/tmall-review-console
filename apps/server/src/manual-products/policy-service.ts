import { matchManualProduct } from "@tmall/domain";
import { DeepSeekConfigurationError, type DeepSeekClientApi, type SentimentDetermination } from "../deepseek/client";
import {
  requiresPositiveRiskSentimentReview,
  resolvePositiveRiskSentiment,
  SentimentAdjudicationPausedError,
} from "../deepseek/review-sentiment-adjudication";
import type { ManualProductRecord, ManualProductRepository } from "../storage/manual-product-repository";
import type { PersistedReplyDraft, ReplyRepository } from "../storage/repositories";
import { ReviewActionConflictError } from "../submission/review-action-gate";

export type ManualProductPolicyDecision =
  | {
    action: "continue";
    catalogRevision: number;
    matchedBy?: "not_matched" | "item_id" | "normalized_title";
    productId?: string | null;
    sentiment?: "positive" | "neutral" | "negative";
    sentimentAdjudicated?: boolean;
    reason?: string;
  }
  | {
    action: "manual_hold";
    catalogRevision: number;
    matchedBy: "item_id" | "normalized_title" | "ambiguous" | "identity_untrusted";
    productId: string | null;
    sentiment: "positive" | "neutral" | "negative" | "unknown";
    reason: string;
  };

export interface ManualProductPolicyEvaluationOptions {
  propagateSentimentErrors?: boolean;
  shouldContinue?: () => boolean;
  expectedRetryClaimToken?: string;
  now?: () => Date;
}

export interface ManualProductPolicy {
  evaluate(
    replyDraftId: string,
    options?: ManualProductPolicyEvaluationOptions,
  ): Promise<ManualProductPolicyDecision>;
}

type ManualHoldMatchKind = "item_id" | "normalized_title" | "ambiguous" | "identity_untrusted";

export class ManualProductPolicyService implements ManualProductPolicy {
  readonly #products: ManualProductRepository;
  readonly #replies: ReplyRepository;
  readonly #ai: Pick<DeepSeekClientApi, "determineSentiment" | "reviewSentiment" | "adjudicateSentiment">;
  readonly #storeId: string;

  constructor(options: {
    products: ManualProductRepository;
    replies: ReplyRepository;
    ai: Pick<DeepSeekClientApi, "determineSentiment" | "reviewSentiment" | "adjudicateSentiment">;
    storeId?: string;
  }) {
    this.#products = options.products;
    this.#replies = options.replies;
    this.#ai = options.ai;
    this.#storeId = options.storeId ?? "primary";
  }

  async evaluate(
    replyDraftId: string,
    options: ManualProductPolicyEvaluationOptions = {},
  ): Promise<ManualProductPolicyDecision> {
    const draft = this.#requireDraft(replyDraftId);
    if (draft.state === "manual_product_hold") return this.#persistedHoldDecision(draft);
    const catalog = this.#products.catalogSnapshot();

    const match = matchManualProduct({ itemId: draft.itemId, title: draft.product }, catalog.products);
    if (match.status === "identity_untrusted") {
      return this.#continue(draft, catalog.catalogRevision, {
        matchedBy: "not_matched",
        product: null,
      }, options);
    }
    if (match.status === "not_matched") {
      return this.#continue(draft, catalog.catalogRevision, {
        matchedBy: "not_matched",
        product: null,
      }, options);
    }
    if (match.status === "ambiguous") {
      return this.#hold(draft, catalog.catalogRevision, {
        matchedBy: "ambiguous",
        product: null,
        sentiment: draft.sentimentLabel,
        reason: "商品身份命中多条跳过名单记录，无法安全确认，已记录后自动跳过",
      }, options);
    }

    // The platform DOM label is diagnostic metadata only. It can be absent,
    // stale, or wrong, so every matched product decision must use the review
    // text analysis instead of trusting positive/neutral/negative page labels.
    if (!this.#ai.determineSentiment) {
      throw new DeepSeekConfigurationError("missing_api_key", "DeepSeek sentiment service is not configured");
    }
    const determined: SentimentDetermination = await this.#ai.determineSentiment({
      review: draft.review,
      product: draft.product,
      reviewPhase: draft.reviewPhase,
    });
    if (options.shouldContinue && !options.shouldContinue()) {
      throw new SentimentAdjudicationPausedError();
    }

    if (determined.sentiment === "positive") {
      const primary = {
        sentiment: "positive" as const,
        confidence: determined.confidence,
        reason: determined.reason,
      };
      const sentimentAdjudicated = requiresPositiveRiskSentimentReview(primary, draft.review);
      const resolved = await resolvePositiveRiskSentiment({
        review: draft.review,
        product: draft.product,
        reviewPhase: draft.reviewPhase,
        primary,
        model: this.#sentimentAdjudicationModel(),
        ...(options.shouldContinue ? { control: { shouldContinue: options.shouldContinue } } : {}),
      });
      if (resolved.sentiment === "negative") {
        return this.#hold(draft, catalog.catalogRevision, {
          matchedBy: match.matchedBy,
          product: match.product,
          sentiment: "negative",
          reason: `名单商品最终裁决为差评，自动流程已跳过：${resolved.reason}`,
        }, options);
      }
      return this.#continue(draft, catalog.catalogRevision, {
        matchedBy: match.matchedBy,
        product: match.product,
        sentiment: "positive",
        sentimentAdjudicated,
        reason: resolved.reason,
      }, options);
    }
    return this.#hold(draft, catalog.catalogRevision, {
      matchedBy: match.matchedBy,
      product: match.product,
      sentiment: determined.sentiment,
      reason: `名单商品判断为${determined.sentiment === "neutral" ? "中评" : "差评"}，自动流程已跳过：${determined.reason}`,
    }, options);
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

  #continue(
    draft: PersistedReplyDraft,
    catalogRevision: number,
    input: {
      matchedBy: "not_matched" | "item_id" | "normalized_title";
      product: ManualProductRecord | null;
      sentiment?: "positive";
      sentimentAdjudicated?: boolean;
      reason?: string;
    },
    options: ManualProductPolicyEvaluationOptions,
  ): ManualProductPolicyDecision {
    // Preserve the frozen match evidence. If a matched row disappeared after an AI wait,
    // keep the revision and match kind while avoiding a dangling foreign key.
    const saved = this.#replies.saveManualProductDecision(draft.id, {
      storeId: this.#storeId,
      manualProductId: input.product?.id ?? null,
      catalogRevision,
      matchKind: input.matchedBy,
      ...this.#persistenceOptions(options),
    });
    return {
      action: "continue",
      catalogRevision,
      matchedBy: input.matchedBy,
      productId: saved.manualProductId,
      ...(input.sentiment ? { sentiment: input.sentiment } : {}),
      ...(input.sentimentAdjudicated !== undefined ? { sentimentAdjudicated: input.sentimentAdjudicated } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    };
  }

  #hold(
    draft: PersistedReplyDraft,
    catalogRevision: number,
    input: {
      matchedBy: ManualHoldMatchKind;
      product: ManualProductRecord | null;
      sentiment: "positive" | "neutral" | "negative" | "unknown";
      reason: string;
    },
    options: ManualProductPolicyEvaluationOptions,
  ): ManualProductPolicyDecision {
    // The decision uses the frozen catalog. A matched row may be removed while the AI call is in flight;
    // keep the frozen decision but avoid writing a now-invalid foreign key.
    const saved = this.#replies.markManualProductHold(draft.id, {
      storeId: this.#storeId,
      manualProductId: input.product?.id ?? null,
      catalogRevision,
      matchKind: input.matchedBy,
      reason: input.reason,
      ...this.#persistenceOptions(options),
    });
    return {
      action: "manual_hold",
      catalogRevision,
      matchedBy: input.matchedBy,
      productId: saved.manualProductId,
      sentiment: input.sentiment,
      reason: input.reason,
    };
  }

  #persistenceOptions(options: ManualProductPolicyEvaluationOptions): {
    expectedClaimToken?: string;
    at?: Date;
  } {
    if (!options.expectedRetryClaimToken) return {};
    const at = options.now?.() ?? new Date();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Error("Manual policy clock is invalid");
    return { expectedClaimToken: options.expectedRetryClaimToken, at };
  }

  #persistedHoldDecision(draft: PersistedReplyDraft): ManualProductPolicyDecision {
    const matchedBy = draft.manualMatchKind;
    if (draft.manualCatalogRevision === null
      || !["item_id", "normalized_title", "ambiguous", "identity_untrusted"].includes(matchedBy ?? "")) {
      throw new ReviewActionConflictError("ACTION_VERSION_CONFLICT", "人工处理决策缺少完整版本信息，不能覆盖");
    }
    const sentiment = ["positive", "neutral", "negative"].includes(draft.sentimentLabel)
      ? draft.sentimentLabel as "positive" | "neutral" | "negative"
      : "unknown";
    return {
      action: "manual_hold",
      catalogRevision: draft.manualCatalogRevision,
      matchedBy: matchedBy as "item_id" | "normalized_title" | "ambiguous" | "identity_untrusted",
      productId: draft.manualProductId,
      sentiment,
      reason: draft.manualHoldReason ?? "已自动跳过",
    };
  }

  #requireDraft(id: string): PersistedReplyDraft {
    const draft = this.#replies.get(id);
    if (!draft) throw new Error("回复草稿不存在");
    return draft;
  }
}
