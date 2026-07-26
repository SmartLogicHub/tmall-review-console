import { describe, expect, it, vi } from "vitest";
import { DeepSeekModelContractError, type DeepSeekClientApi } from "./client";
import {
  resolvePositiveRiskSentiment,
  type SentimentVerdict,
} from "./review-sentiment-adjudication";

type SentimentReviewModel = Required<Pick<DeepSeekClientApi, "reviewSentiment" | "adjudicateSentiment">>;

function verdict(sentiment: SentimentVerdict["sentiment"], confidence = 0.95): SentimentVerdict {
  return { sentiment, confidence, reason: `${sentiment} reason` };
}

function model(overrides: Partial<SentimentReviewModel> = {}): SentimentReviewModel {
  return {
    reviewSentiment: vi.fn(async () => ({
      sentiment: "positive" as const,
      confidence: 0.96,
      reason: "独立复核仍为正面",
    })),
    adjudicateSentiment: vi.fn(async () => verdict("positive", 0.94)),
    ...overrides,
  };
}

async function resolve(input: {
  review?: string;
  primary?: SentimentVerdict;
  model?: SentimentReviewModel;
} = {}) {
  return resolvePositiveRiskSentiment({
    review: input.review ?? "音质很好，佩戴也舒服",
    product: "漫步者耳机",
    reviewPhase: "initial",
    primary: input.primary ?? verdict("positive"),
    model: input.model ?? model(),
  });
}

describe("resolvePositiveRiskSentiment", () => {
  it("does not review an unambiguous high-confidence positive verdict", async () => {
    const sentimentModel = model();

    await expect(resolve({ model: sentimentModel })).resolves.toEqual(verdict("positive"));
    expect(sentimentModel.reviewSentiment).not.toHaveBeenCalled();
    expect(sentimentModel.adjudicateSentiment).not.toHaveBeenCalled();
  });

  it("reviews a positive verdict below 0.90 confidence", async () => {
    const sentimentModel = model();

    await resolve({ primary: verdict("positive", 0.89), model: sentimentModel });

    expect(sentimentModel.reviewSentiment).toHaveBeenCalledOnce();
  });

  it("reviews a positive verdict containing a deterministic negative-risk signal", async () => {
    const sentimentModel = model();

    await resolve({ review: "音质不错，但是每天都会断连", model: sentimentModel });

    expect(sentimentModel.reviewSentiment).toHaveBeenCalledOnce();
  });

  it.each([
    "戴着夹耳朵",
    "物流太慢",
    "客服态度冷淡",
    "按键失灵",
    "续航太短",
  ])("reviews an apparently positive verdict containing an explicit problem: %s", async (review) => {
    const sentimentModel = model();

    await resolve({ review, model: sentimentModel });

    expect(sentimentModel.reviewSentiment).toHaveBeenCalledOnce();
  });

  it("does not mistake a positive 不但……而且…… construction for a negative turn", async () => {
    const sentimentModel = model();

    await resolve({ review: "不但音质好，而且续航也好", model: sentimentModel });

    expect(sentimentModel.reviewSentiment).not.toHaveBeenCalled();
    expect(sentimentModel.adjudicateSentiment).not.toHaveBeenCalled();
  });

  it("returns positive without adjudication when both reviews are positive", async () => {
    const independent = verdict("positive", 0.93);
    const sentimentModel = model({ reviewSentiment: vi.fn(async () => independent) });

    await expect(resolve({ primary: verdict("positive", 0.82), model: sentimentModel }))
      .resolves.toEqual(independent);
    expect(sentimentModel.adjudicateSentiment).not.toHaveBeenCalled();
  });

  it("adjudicates a primary positive and independent negative conflict", async () => {
    const primary = verdict("positive", 0.82);
    const independent = { sentiment: "negative" as const, confidence: 0.91, reason: "存在持续断连" };
    const final = verdict("negative", 0.97);
    const sentimentModel = model({
      reviewSentiment: vi.fn(async () => independent),
      adjudicateSentiment: vi.fn(async () => final),
    });

    await expect(resolve({ review: "不错，但是每天断连", primary, model: sentimentModel }))
      .resolves.toEqual(final);
    expect(sentimentModel.adjudicateSentiment).toHaveBeenCalledWith({
      review: "不错，但是每天断连",
      product: "漫步者耳机",
      reviewPhase: "initial",
      primary,
      independent,
    });
  });

  it("adjudicates an independent neutral result and accepts a valid final negative", async () => {
    const sentimentModel = model({
      reviewSentiment: vi.fn(async () => ({
        sentiment: "neutral" as const,
        confidence: 0.74,
        reason: "正负体验接近",
      })),
      adjudicateSentiment: vi.fn(async () => verdict("negative", 0.92)),
    });

    await expect(resolve({ primary: verdict("positive", 0.81), model: sentimentModel }))
      .resolves.toEqual(verdict("negative", 0.92));
    expect(sentimentModel.adjudicateSentiment).toHaveBeenCalledOnce();
  });

  it.each([
    { sentiment: "neutral", confidence: 0.8, reason: "拒绝二选一" },
    { sentiment: "unknown", confidence: 0.8, reason: "无法判断" },
    { sentiment: "negative", confidence: 2, reason: "置信度越界" },
    { sentiment: "negative", confidence: 0.8, reason: "", extra: true },
  ])("rejects an invalid adjudication contract instead of treating it as negative: %o", async (invalid) => {
    const sentimentModel = model({
      reviewSentiment: vi.fn(async () => ({
        sentiment: "negative" as const,
        confidence: 0.91,
        reason: "存在明确问题",
      })),
      adjudicateSentiment: vi.fn(async () => invalid as never),
    });

    await expect(resolve({ primary: verdict("positive", 0.8), model: sentimentModel }))
      .rejects.toBeInstanceOf(DeepSeekModelContractError);
  });
});
