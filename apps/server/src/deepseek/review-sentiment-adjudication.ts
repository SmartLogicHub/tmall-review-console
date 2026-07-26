import {
  DeepSeekModelContractError,
  type DeepSeekClientApi,
  type SentimentDetermination,
} from "./client";

export interface SentimentVerdict {
  sentiment: "positive" | "negative";
  confidence: number;
  reason: string;
}

export class SentimentAdjudicationPausedError extends Error {
  constructor() {
    super("Sentiment adjudication paused");
    this.name = "SentimentAdjudicationPausedError";
  }
}

const POSITIVE_RISK_PATTERNS = [
  /(?:但是|不过|可是|然而|只是|可惜|但)/u,
  /(?:后悔|不该|勉强|将就|算了|买都买了|好歹)/u,
  /(?:没感觉|感受不到|不如|不值|不好|不行|失望|差劲|垃圾|退货|退款)/u,
  /(?:问题|故障|坏了|断连|断开|卡顿|杂音|电流声|没声音|无声|发热|漏电|破损|少件|缺件|异味)/u,
  /(?:夹|勒|磨)(?:耳|头)|耳朵?(?:疼|痛|不舒服)/u,
  /(?:物流|快递|发货).{0,6}(?:慢|迟|久|破损|丢失|没到)/u,
  /客服.{0,6}(?:冷淡|态度差|不理|不回复|没回复|敷衍)/u,
  /(?:按键|按钮|触控).{0,4}(?:失灵|不灵|没反应|坏了)/u,
  /续航.{0,4}(?:太短|短|差|不足|不耐用|掉电快)/u,
  /(?:呵呵|可真|真棒啊|绝了)/u,
] as const;

export function requiresPositiveRiskSentimentReview(primary: SentimentVerdict, review: string): boolean {
  if (primary.sentiment !== "positive") return false;
  if (primary.confidence < 0.9) return true;
  const text = review.normalize("NFKC").replace(/\s+/gu, "");
  const riskText = text.replace(/(?:不但|不仅)/gu, "");
  return POSITIVE_RISK_PATTERNS.some((pattern) => pattern.test(riskText));
}

export async function resolvePositiveRiskSentiment(input: {
  review: string;
  product: string;
  reviewPhase: "initial" | "followup";
  primary: SentimentVerdict;
  model: Required<Pick<DeepSeekClientApi, "reviewSentiment" | "adjudicateSentiment">>;
  control?: { shouldContinue?: () => boolean };
}): Promise<SentimentVerdict> {
  if (!requiresPositiveRiskSentimentReview(input.primary, input.review)) return input.primary;

  assertSentimentAdjudicationContinues(input.control);
  const independent = validateIndependentVerdict(await input.model.reviewSentiment({
    review: input.review,
    product: input.product,
    reviewPhase: input.reviewPhase,
  }));
  assertSentimentAdjudicationContinues(input.control);
  if (independent.sentiment === "positive") {
    return {
      sentiment: independent.sentiment,
      confidence: independent.confidence,
      reason: independent.reason,
    };
  }

  return validateFinalVerdict(await input.model.adjudicateSentiment({
    review: input.review,
    product: input.product,
    reviewPhase: input.reviewPhase,
    primary: input.primary,
    independent,
  }));
}

function assertSentimentAdjudicationContinues(control?: { shouldContinue?: () => boolean }): void {
  if (control?.shouldContinue && !control.shouldContinue()) {
    throw new SentimentAdjudicationPausedError();
  }
}

function validateIndependentVerdict(value: SentimentDetermination): SentimentDetermination {
  if (!isStrictSentimentResult(value, ["positive", "neutral", "negative"])) {
    throw new DeepSeekModelContractError("独立情感复核结果字段不符合约定");
  }
  return { sentiment: value.sentiment, confidence: value.confidence, reason: value.reason.trim() };
}

function validateFinalVerdict(value: SentimentVerdict): SentimentVerdict {
  if (!isStrictSentimentResult(value, ["positive", "negative"])) {
    throw new DeepSeekModelContractError("情感最终裁决必须严格二选一");
  }
  return { sentiment: value.sentiment, confidence: value.confidence, reason: value.reason.trim() };
}

function isStrictSentimentResult(
  value: unknown,
  sentiments: readonly string[],
): value is { sentiment: "positive" | "neutral" | "negative"; confidence: number; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  return keys.length === 3
    && keys[0] === "confidence"
    && keys[1] === "reason"
    && keys[2] === "sentiment"
    && typeof record.sentiment === "string"
    && sentiments.includes(record.sentiment)
    && reason.length > 0
    && [...reason].length <= 100
    && typeof record.confidence === "number"
    && Number.isFinite(record.confidence)
    && record.confidence >= 0
    && record.confidence <= 1;
}
