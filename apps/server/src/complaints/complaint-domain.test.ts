import { describe, expect, it } from "vitest";
import {
  COMPLAINT_TYPES,
  buildComplaintDescription,
  executeTrackedComplaintModelInvocation,
  hasValidComplaintConfirmationCombination,
  redactComplaintAnalysisText,
  validateComplaintAnalysis,
} from "./complaint-domain";

const review = "这个耳机不是我买的商品，完全无法使用。";
async function confirmationsFor(result: Parameters<typeof validateComplaintAnalysis>[0]["result"]) {
  if (result.decision !== "complaint_candidate") throw new Error("candidate required");
  const primary = await executeTrackedComplaintModelInvocation("primary", async () => result);
  const independent = await executeTrackedComplaintModelInvocation("independent_review", async () => result);
  const base = { confirmed: true as const, complaintType: result.complaintType, factCode: result.factCode, quoteStart: result.quoteStart!, quoteEnd: result.quoteEnd! };
  return {
    primaryConfirmation: { ...base, pass: "primary" as const, sourceInvocationId: primary.invocationId },
    independentConfirmation: { ...base, pass: "independent_review" as const, sourceInvocationId: independent.invocationId },
  };
}

describe("complaint domain", () => {
  it("accepts one tracked primary confirmation and never accepts a copied pass", async () => {
    const result = { decision: "complaint_candidate" as const, complaintType: "advertising_content" as const, confidence: 90, quoteStart: 0, quoteEnd: 3, factCode: "review_contains_ad_diversion" as const, reason: "广告" };
    const tracked = await confirmationsFor(result);
    const primary = tracked.primaryConfirmation;
    const independent = tracked.independentConfirmation;
    const adjudicationCall = await executeTrackedComplaintModelInvocation("adjudication", async () => result);
    const adjudication = { ...primary, pass: "adjudication" as const, sourceInvocationId: adjudicationCall.invocationId };
    expect(hasValidComplaintConfirmationCombination({ primaryConfirmation: primary, independentConfirmation: independent }, result)).toBe(true);
    expect(hasValidComplaintConfirmationCombination({ primaryConfirmation: primary, adjudicationConfirmation: adjudication }, result)).toBe(true);
    expect(hasValidComplaintConfirmationCombination({ primaryConfirmation: primary }, result)).toBe(true);
    expect(hasValidComplaintConfirmationCombination({ independentConfirmation: { ...primary, pass: "independent_review" } }, result)).toBe(false);
  });

  it("uses only the fixed candidate identity tuple when reasons or confidence differ across real calls", async () => {
    const primaryResult = { decision: "complaint_candidate" as const, complaintType: "advertising_content" as const, confidence: 94, quoteStart: 0, quoteEnd: 3, factCode: "review_contains_ad_diversion" as const, reason: "第一轮理由" };
    const independentResult = { ...primaryResult, confidence: 71, reason: "独立审核使用不同理由" };
    const adjudicationResult = { ...primaryResult, confidence: 83, reason: "裁决理由也不同" };
    const primaryCall = await executeTrackedComplaintModelInvocation("primary", async () => primaryResult);
    const independentCall = await executeTrackedComplaintModelInvocation("independent_review", async () => independentResult);
    const adjudicationCall = await executeTrackedComplaintModelInvocation("adjudication", async () => adjudicationResult);
    const base = { confirmed: true as const, complaintType: primaryResult.complaintType, factCode: primaryResult.factCode, quoteStart: 0, quoteEnd: 3 };
    const primaryConfirmation = { ...base, pass: "primary" as const, sourceInvocationId: primaryCall.invocationId };
    const independentConfirmation = { ...base, pass: "independent_review" as const, sourceInvocationId: independentCall.invocationId };
    const adjudicationConfirmation = { ...base, pass: "adjudication" as const, sourceInvocationId: adjudicationCall.invocationId };

    expect(hasValidComplaintConfirmationCombination({ primaryConfirmation, independentConfirmation }, primaryResult)).toBe(true);
    expect(hasValidComplaintConfirmationCombination({ primaryConfirmation, adjudicationConfirmation }, primaryResult)).toBe(true);
  });

  it("accepts two tracked confirmations for the same complaint fact when their exact quote boundaries differ", async () => {
    const primaryResult = { decision: "complaint_candidate" as const, complaintType: "advertising_content" as const, confidence: 94, quoteStart: 0, quoteEnd: 3, factCode: "review_contains_ad_diversion" as const, reason: "广告引流" };
    const independentResult = { ...primaryResult, confidence: 88, quoteEnd: 7, reason: "独立审核引用了更完整的句子" };
    const primaryCall = await executeTrackedComplaintModelInvocation("primary", async () => primaryResult);
    const independentCall = await executeTrackedComplaintModelInvocation("independent_review", async () => independentResult);
    const primaryConfirmation = {
      confirmed: true as const,
      pass: "primary" as const,
      sourceInvocationId: primaryCall.invocationId,
      complaintType: primaryResult.complaintType,
      factCode: primaryResult.factCode,
      quoteStart: primaryResult.quoteStart,
      quoteEnd: primaryResult.quoteEnd,
    };
    const independentConfirmation = {
      confirmed: true as const,
      pass: "independent_review" as const,
      sourceInvocationId: independentCall.invocationId,
      complaintType: independentResult.complaintType,
      factCode: independentResult.factCode,
      quoteStart: independentResult.quoteStart,
      quoteEnd: independentResult.quoteEnd,
    };

    expect(hasValidComplaintConfirmationCombination({ primaryConfirmation, independentConfirmation }, primaryResult)).toBe(true);
  });

  it("rejects a semantic confirmation whose own quote range is outside the review", async () => {
    const text = "加微信";
    const primaryResult = { decision: "complaint_candidate" as const, complaintType: "advertising_content" as const, confidence: 94, quoteStart: 0, quoteEnd: 99, factCode: "review_contains_ad_diversion" as const, reason: "引用范围越界" };
    const primaryCall = await executeTrackedComplaintModelInvocation("primary", async () => primaryResult);
    const primaryConfirmation = {
      confirmed: true as const,
      pass: "primary" as const,
      sourceInvocationId: primaryCall.invocationId,
      complaintType: primaryResult.complaintType,
      factCode: primaryResult.factCode,
      quoteStart: primaryResult.quoteStart,
      quoteEnd: primaryResult.quoteEnd,
    };
    expect(() => validateComplaintAnalysis({
      reviewText: text,
      result: primaryResult,
      facts: {
        primaryConfirmation,
        hasDiversionSignal: true,
        piiDetected: false,
      },
    })).toThrow(/引用范围/u);
  });

  it("rejects confirmation UUIDs manufactured without tracked model invocations", () => {
    const result = {
      decision: "complaint_candidate" as const,
      complaintType: "advertising_content" as const,
      confidence: 90,
      quoteStart: 0,
      quoteEnd: 3,
      factCode: "review_contains_ad_diversion" as const,
      reason: "广告",
    };
    const base = {
      confirmed: true as const,
      complaintType: result.complaintType,
      factCode: result.factCode,
      quoteStart: 0,
      quoteEnd: 3,
    };

    expect(() => validateComplaintAnalysis({
      reviewText: "加微信",
      result,
      facts: {
        primaryConfirmation: {
          ...base,
          pass: "primary",
          sourceInvocationId: "11111111-1111-4111-8111-111111111111",
        },
        independentConfirmation: {
          ...base,
          pass: "independent_review",
          sourceInvocationId: "22222222-2222-4222-8222-222222222222",
        },
        hasDiversionSignal: true,
        piiDetected: false,
      },
    })).toThrow(/事实|条件|核对/u);
  });

  it("requires meaninglessProgramDetected to be explicitly true", async () => {
    const text = "哈哈哈哈";
    const result = { decision: "complaint_candidate" as const, complaintType: "meaningless_content" as const, confidence: 90, quoteStart: 0, quoteEnd: 4, factCode: "review_is_meaningless" as const, reason: "重复内容" };
    const tracked = await confirmationsFor(result);
    const confirmations = {
      ...tracked,
      shortSentimentExcluded: true,
      logisticsOrServiceExcluded: true,
    };
    expect(() => validateComplaintAnalysis({ reviewText: text, result, facts: { ...confirmations, meaninglessProgramDetected: false } })).toThrow(/事实|条件|核对/u);
    expect(validateComplaintAnalysis({ reviewText: text, result, facts: { ...confirmations, meaninglessProgramDetected: true } })).toMatchObject({ decision: "complaint_candidate" });
  });
  it("keeps exactly the thirteen controlled official complaint types", () => {
    expect(COMPLAINT_TYPES).toHaveLength(13);
    expect(new Set(COMPLAINT_TYPES.map((item) => item.code)).size).toBe(13);
    expect(COMPLAINT_TYPES.map((item) => item.name)).toEqual([
      "购买A商品评价B商品", "评价内容无意义", "辱骂侮辱的评论", "评论泄露隐私", "评价内容为广告信息", "涉政暴恐等敏感信息", "低俗色情",
      "毒品枪支等违禁品", "涉未成年人", "利用中差评索取不当利益", "未收到货但给出与商品实际不符的虚假评价", "评价使用虚假或网络图片", "同行恶意中差评",
    ]);
    expect(COMPLAINT_TYPES[0]?.factDescription).toBe("该评价主要描述的对象与本订单商品不一致");
  });

  it("accepts only an exact quote, matching fact, and trusted eligibility evidence", async () => {
    const modelResult = {
      decision: "complaint_candidate" as const, complaintType: "purchase_a_review_b" as const, confidence: 88,
      quoteStart: 0, quoteEnd: 11, factCode: "review_targets_other_product" as const, reason: "评价明确表示对象不是当前订单商品",
    };
    const result = validateComplaintAnalysis({
      reviewText: review,
      facts: { ...(await confirmationsFor(modelResult)), targetsOtherProduct: true, otherProductExcludedContext: false },
      result: modelResult,
    });

    expect(result.quote).toBe("这个耳机不是我买的商品");
    expect(result.complaintType.name).toBe("购买A商品评价B商品");
  });

  it("rejects an invented type, fact, quote range, or missing trusted eligibility facts", () => {
    expect(() => validateComplaintAnalysis({
      reviewText: review,
      facts: {},
      result: {
        decision: "complaint_candidate",
        complaintType: "invented_type",
        confidence: 88,
        quoteStart: 0,
        quoteEnd: 2,
        factCode: "invented_fact",
        reason: "x",
      },
    })).toThrow(/投诉分析结果/);

    expect(() => validateComplaintAnalysis({
      reviewText: review,
      facts: {},
      result: {
        decision: "complaint_candidate",
        complaintType: "purchase_a_review_b",
        confidence: 88,
        quoteStart: 3,
        quoteEnd: 3,
        factCode: "review_targets_other_product",
        reason: "x",
      },
    })).toThrow(/引用/);
  });

  it("creates the one fixed user-approved description and never adds evidence or chat claims", async () => {
    const modelResult = { decision: "complaint_candidate" as const, complaintType: "purchase_a_review_b" as const, confidence: 88, quoteStart: 0, quoteEnd: 11, factCode: "review_targets_other_product" as const, reason: "x" };
    const analysis = validateComplaintAnalysis({
      reviewText: review,
      facts: { ...(await confirmationsFor(modelResult)), targetsOtherProduct: true, otherProductExcludedContext: false },
      result: modelResult,
    });

    expect(buildComplaintDescription(analysis)).toBe(
      "该评价内容为“这个耳机不是我买的商品”。经核对，该评价主要描述的对象与本订单商品不一致，符合“购买A商品评价B商品”场景。请平台结合评价内容及相关信息审核，并屏蔽处理，谢谢。",
    );
  });

  it("shortens a long quote as an exact continuous substring while retaining the fixed description skeleton", async () => {
    const modelResult = { decision: "complaint_candidate" as const, complaintType: "purchase_a_review_b" as const, confidence: 90, quoteStart: 0, quoteEnd: 1200, factCode: "review_targets_other_product" as const, reason: "x" };
    const longConfirmation = { ...(await confirmationsFor(modelResult)), targetsOtherProduct: true, otherProductExcludedContext: false };
    const analysis = validateComplaintAnalysis({
      reviewText: "甲".repeat(1200),
      facts: longConfirmation,
      result: modelResult,
    });
    const description = buildComplaintDescription(analysis);
    expect(Array.from(description).length).toBeLessThanOrEqual(1000);
    expect(description).toContain("经核对，");
    expect(description.endsWith("请平台结合评价内容及相关信息审核，并屏蔽处理，谢谢。")).toBe(true);
  });

  it("requires a structurally empty no-complaint result", () => {
    expect(validateComplaintAnalysis({
      reviewText: review,
      facts: {},
      result: {
        decision: "no_complaint",
        complaintType: "none",
        confidence: 0,
        quoteStart: null,
        quoteEnd: null,
        factCode: "none",
        reason: "没有可核对的投诉依据",
      },
    }).decision).toBe("no_complaint");
  });

  it("does not let an ordinary quality complaint become a competitor-malicious complaint", () => {
    expect(() => validateComplaintAnalysis({
      reviewText: "质量很差，完全不好用",
      facts: {},
      result: {
        decision: "complaint_candidate", complaintType: "competitor_malicious_review", confidence: 98,
        quoteStart: 0, quoteEnd: 10, factCode: "review_explicit_competitor_malice", reason: "x",
      },
    })).toThrow(/可信事实/);
  });

  it("redacts PII with equal-length placeholders before validation, persistence, and description generation", async () => {
    const redacted = redactComplaintAnalysisText("快递员电话13800138000，住在上海市浦东新区世纪大道100号");
    expect(Array.from(redacted.analysisText)).toHaveLength(Array.from("快递员电话13800138000，住在上海市浦东新区世纪大道100号").length);
    expect(redacted.analysisText).not.toContain("13800138000");
    const modelResult = { decision: "complaint_candidate" as const, complaintType: "privacy_leak" as const, confidence: 95,
      quoteStart: 0, quoteEnd: Array.from(redacted.analysisText).length, factCode: "review_exposes_third_party_privacy" as const, reason: "x" };
    const analysis = validateComplaintAnalysis({
      reviewText: redacted.analysisText,
      facts: { ...(await confirmationsFor(modelResult)), piiDetected: true, piiOwner: "courier" },
      result: modelResult,
    });
    expect(buildComplaintDescription(analysis)).not.toContain("13800138000");
  });
});
