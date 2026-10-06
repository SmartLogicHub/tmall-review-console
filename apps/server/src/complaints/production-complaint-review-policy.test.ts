import { describe, expect, it, vi } from "vitest";
import { bindComplaintAnalysis, createProductionComplaintReviewPolicy } from "./production-complaint-review-policy";
import { COMPLAINT_TYPES, redactComplaintAnalysisText } from "./complaint-domain";
import type { ComplaintAnalysisInput } from "./deepseek-complaint-analysis";
import { openDatabase, runMigrations } from "../storage/database";
import { ComplaintRepository } from "../storage/complaint-repository";
import type { PersistedReplyDraft } from "../storage/repositories";
import { ReviewActionGate } from "../submission/review-action-gate";

function draft(
  sourceKey: string,
  overrides: Partial<Pick<PersistedReplyDraft, "review" | "sentimentLabel">> = {},
): PersistedReplyDraft {
  return {
    id: `draft-${sourceKey}`,
    sourceKey,
    orderId: "order-1",
    review: "耳机音质不错，外观也很好看。",
    product: "测试耳机",
    reviewedAt: null,
    sentimentLabel: "positive",
    itemId: "item-1",
    reviewPhase: "initial",
    library: null,
    primaryCategory: "",
    category: "",
    classificationConfidence: null,
    classificationReason: "",
    templateVersionId: null,
    templateSequence: null,
    originalTemplate: "",
    finalReply: "",
    productAdjusted: false,
    rewriteNotes: "",
    detectedTemplateProducts: [],
    unsupportedClaims: [],
    attentionReasons: [],
    state: "discovered",
    errorCode: null,
    errorMessage: null,
    discoveredAt: "2026-07-21T00:00:00.000Z",
    processedAt: null,
    updatedAt: "2026-07-21T00:00:00.000Z",
    manualProductId: null,
    manualHoldReason: null,
    manualCatalogRevision: null,
    manualMatchKind: null,
    manualHoldLastSeenAt: null,
    manualHoldAbsentScans: 0,
    aiCheckpointStage: null,
    failedStage: null,
    aiRetryErrorKind: null,
    nextRetryAt: null,
    consecutiveAiFailureRounds: 0,
    ...overrides,
  };
}

function discoveryInput(sourceKey: string) {
  return {
    reviewId: sourceKey,
    contentHash: "a".repeat(64),
    canonicalizerVersion: "test-v1",
    phase: "initial" as const,
    imagePairs: [],
    promptVersion: "test-v1",
    ruleVersion: "test-v1",
    mappingVersion: "test-v1",
    visualVersion: "test-v1",
    platformMappingVersion: "test-v1",
    modelVersion: "test-v1",
  };
}

describe("bindComplaintAnalysis", () => {
  it("preserves the DeepSeek client receiver for production complaint calls", async () => {
    class ReceiverSensitiveAnalyzer {
      #calls = 0;

      async analyzeComplaint(_input: ComplaintAnalysisInput) {
        this.#calls += 1;
        return {
          decision: "no_complaint" as const,
          complaintType: "none" as const,
          confidence: 90,
          quoteStart: null,
          quoteEnd: null,
          factCode: "none" as const,
          reason: "普通商品差评，不符合平台投诉条件",
        };
      }

      get calls(): number {
        return this.#calls;
      }
    }

    const client = new ReceiverSensitiveAnalyzer();
    const analyzeComplaint = bindComplaintAnalysis(client);

    await expect(analyzeComplaint?.({
      pass: "primary",
      review: redactComplaintAnalysisText("佩戴时间久了耳朵疼"),
      officialTypes: COMPLAINT_TYPES.map((item) => item.code),
      productName: "测试耳机",
    })).resolves.toMatchObject({ decision: "no_complaint" });
    expect(client.calls).toBe(1);
  });
});

describe("createProductionComplaintReviewPolicy", () => {
  it("bypasses complaint AI and does not create a complaint case for an ordinary positive review", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const analyzeComplaint = vi.fn(async () => {
      throw new Error("ordinary positive reviews must not reach complaint AI");
    });
    const policy = createProductionComplaintReviewPolicy({
      complaints,
      complaintAutoSubmit: false,
      analyzeComplaint,
    });
    const input = draft("ordinary-positive", {
      review: "耳机音质很好，佩戴也很舒服",
      sentimentLabel: "positive",
    });

    await expect(policy.evaluate(input)).resolves.toMatchObject({
      action: "reply",
      caseState: "no_complaint",
    });
    expect(analyzeComplaint).not.toHaveBeenCalled();
    expect(complaints.findBySource("primary", input.sourceKey)).toBeNull();
    database.close();
  });

  it("bypasses complaint AI for an ordinary negative product experience", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const analyzeComplaint = vi.fn(async () => {
      throw new Error("ordinary product dissatisfaction must not reach complaint AI");
    });
    const policy = createProductionComplaintReviewPolicy({
      complaints,
      complaintAutoSubmit: false,
      analyzeComplaint,
    });
    const input = draft("ordinary-negative", {
      review: "音质很差，戴久了耳朵疼",
      sentimentLabel: "negative",
    });

    await expect(policy.evaluate(input)).resolves.toMatchObject({
      action: "reply",
      caseState: "no_complaint",
    });
    expect(analyzeComplaint).not.toHaveBeenCalled();
    expect(complaints.findBySource("primary", input.sourceKey)).toBeNull();
    database.close();
  });

  it("does not send an ordinary noise-cancellation complaint into complaint pre-review", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const analyzeComplaint = vi.fn(async () => {
      throw new Error("ordinary feature feedback must not reach complaint AI");
    });
    const policy = createProductionComplaintReviewPolicy({
      complaints,
      complaintAutoSubmit: true,
      analyzeComplaint,
    });
    const input = draft("ordinary-noise-cancellation-negative", {
      review: "降噪效果不行，音质及续航可以。",
      sentimentLabel: "negative",
    });

    await expect(policy.evaluate(input, { complaintEntryState: "available" })).resolves.toMatchObject({
      action: "reply",
      caseState: "no_complaint",
    });
    expect(analyzeComplaint).not.toHaveBeenCalled();
    expect(complaints.findBySource("primary", input.sourceKey)).toBeNull();
    database.close();
  });

  it("uses contextual violation clues only to request semantic complaint analysis", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const analyzeComplaint = vi.fn(async () => ({
      decision: "complaint_candidate" as const,
      complaintType: "advertising_content" as const,
      confidence: 94,
      quoteStart: 5,
      quoteEnd: 18,
      factCode: "review_contains_ad_diversion" as const,
      reason: "评价语义是引导扫码进入外部群领取课程",
    }));
    const policy = createProductionComplaintReviewPolicy({
      complaints,
      complaintAutoSubmit: false,
      analyzeComplaint,
    });
    const input = draft("semantic-diversion", {
      review: "包装卡片让我扫图案去外部群领取课程",
      sentimentLabel: "neutral",
    });

    await expect(policy.evaluate(input)).resolves.toMatchObject({
      action: "reply",
      caseState: "no_complaint",
    });
    expect(analyzeComplaint).toHaveBeenCalled();
    database.close();
  });

  it("runs complaint analysis for positive-page text containing an explicit diversion signal", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const candidate = {
      decision: "complaint_candidate" as const,
      complaintType: "advertising_content" as const,
      confidence: 96,
      quoteStart: 5,
      quoteEnd: 10,
      factCode: "review_contains_ad_diversion" as const,
      reason: "评价含站外广告引流",
    };
    const analyzeComplaint = vi.fn(async () => candidate);
    const policy = createProductionComplaintReviewPolicy({
      complaints,
      complaintAutoSubmit: false,
      analyzeComplaint,
    });
    const input = draft("positive-with-diversion", {
      review: "音质很好，加微信买课",
      sentimentLabel: "positive",
    });

    await expect(policy.evaluate(input)).resolves.toMatchObject({
      action: "manual_action_required",
    });
    expect(analyzeComplaint).toHaveBeenCalledOnce();
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({
      complaintType: "advertising_content",
    });
    database.close();
  });

  it("submits a clearly fact-backed platform complaint without requiring a second identical model verdict", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const candidate = {
      decision: "complaint_candidate" as const,
      complaintType: "advertising_content" as const,
      confidence: 92,
      quoteStart: 0,
      quoteEnd: 7,
      factCode: "review_contains_ad_diversion" as const,
      reason: "评价明确引导添加微信购买课程",
    };
    let analysisCalls = 0;
    const analyzeComplaint = vi.fn(async () => {
      analysisCalls += 1;
      if (analysisCalls > 1) throw new Error("a clear fact-backed complaint must not depend on a duplicate verdict");
      return candidate;
    });
    const executeComplaint = vi.fn(async (input: {
      beforeSubmit?: () => void;
    }) => {
      input.beforeSubmit?.();
      return {
        state: "sent" as const,
        platformCaseId: "platform-case-1",
        detailUrl: "https://myseller.taobao.com/complaint/platform-case-1",
      };
    });
    const policy = createProductionComplaintReviewPolicy({
      complaints,
      complaintAutoSubmit: true,
      analyzeComplaint,
      executeComplaint,
    });
    const input = draft("clear-advertising-complaint", {
      review: "加微信购买课程",
      sentimentLabel: "positive",
    });

    const decision = await policy.evaluate(input);
    expect(analyzeComplaint).toHaveBeenCalledOnce();
    expect(executeComplaint).toHaveBeenCalledOnce();
    expect({
      decision,
      complaintCase: complaints.findBySource("primary", input.sourceKey),
    }).toMatchObject({
      decision: { action: "skip", caseState: "submitted" },
      complaintCase: { state: "submitted", complaintType: "advertising_content", errorCode: null },
    });
    database.close();
  });

  it("releases a legacy failed internal analysis for an ordinary positive review without deleting its audit history", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const input = draft("legacy-internal-positive", {
      review: "做工很好，物流也很快",
      sentimentLabel: "positive",
    });
    const legacy = complaints.discover("primary", input.sourceKey, discoveryInput(input.sourceKey));
    complaints.markFailed(legacy.id, "internal");
    const analyzeComplaint = vi.fn(async () => {
      throw new Error("legacy ordinary reviews must not retry complaint AI");
    });
    const policy = createProductionComplaintReviewPolicy({
      complaints,
      complaintAutoSubmit: false,
      analyzeComplaint,
    });

    await expect(policy.evaluate(input)).resolves.toMatchObject({
      action: "reply",
      caseId: legacy.id,
      caseState: "no_complaint",
    });
    expect(analyzeComplaint).not.toHaveBeenCalled();
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({
      id: legacy.id,
      state: "no_complaint",
      complaintType: null,
    });
    expect(complaints.listEvents(legacy.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "failed" }),
      expect.objectContaining({ eventType: "analysis_released_by_screening" }),
    ]));
    expect(new ReviewActionGate(database).getLock("primary", input.sourceKey)).toMatchObject({
      actionKind: "reply",
    });
    database.close();
  });

  it("releases a validated legacy complaint intent when the current live review is ordinary and no submit click ever started", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const candidate = {
      decision: "complaint_candidate" as const,
      complaintType: "advertising_content" as const,
      confidence: 96,
      quoteStart: 0,
      quoteEnd: 3,
      factCode: "review_contains_ad_diversion" as const,
      reason: "评价含站外广告引流",
    };
    const analyzeComplaint = vi.fn(async () => candidate);
    const policy = createProductionComplaintReviewPolicy({
      complaints,
      complaintAutoSubmit: false,
      analyzeComplaint,
    });
    const candidateDraft = draft("protected-complaint", {
      review: "加微信购买课程",
      sentimentLabel: "positive",
    });
    await expect(policy.evaluate(candidateDraft)).resolves.toMatchObject({
      action: "manual_action_required",
    });
    const protectedCase = complaints.findBySource("primary", candidateDraft.sourceKey)!;
    expect(protectedCase).toMatchObject({
      state: "manual_action_required",
      complaintType: "advertising_content",
    });
    expect(database.prepare("SELECT COUNT(*) AS value FROM complaint_attempts WHERE complaint_case_id = ?").get(protectedCase.id)).toEqual({ value: 1 });

    await expect(policy.evaluate(draft(candidateDraft.sourceKey, {
      review: "音质很好，佩戴舒服",
      sentimentLabel: "positive",
    }))).resolves.toMatchObject({
      action: "reply",
      caseId: protectedCase.id,
      caseState: "no_complaint",
    });
    expect(complaints.findBySource("primary", candidateDraft.sourceKey)).toMatchObject({
      state: "no_complaint",
      complaintType: "advertising_content",
    });
    expect(new ReviewActionGate(database).getLock("primary", candidateDraft.sourceKey)).toMatchObject({
      actionKind: "reply",
    });
    expect(database.prepare("SELECT state FROM complaint_attempts WHERE complaint_case_id = ?").get(protectedCase.id))
      .toEqual({ state: "failed" });
    database.close();
  });

  it("keeps candidate screening independent from the complaint auto-submit setting", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const analyzeComplaint = vi.fn(async () => ({
      decision: "no_complaint" as const,
      complaintType: "none" as const,
      confidence: 0,
      quoteStart: null,
      quoteEnd: null,
      factCode: "none" as const,
      reason: "没有可核对的投诉依据",
    }));
    const policy = createProductionComplaintReviewPolicy({
      complaints,
      complaintAutoSubmit: false,
      analyzeComplaint,
    });

    await expect(policy.evaluate(draft("ordinary-review-with-complaints-disabled"))).resolves.toMatchObject({
      action: "reply",
      caseState: "no_complaint",
    });
    expect(analyzeComplaint).not.toHaveBeenCalled();
    expect(complaints.findBySource("primary", "ordinary-review-with-complaints-disabled")).toBeNull();
    database.close();
  });

  it("persists a configuration failure for a true complaint candidate when complaint AI is unavailable", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const policy = createProductionComplaintReviewPolicy({
      complaints,
      complaintAutoSubmit: false,
    });
    const input = draft("candidate-without-complaint-model", {
      review: "加微信购买课程",
      sentimentLabel: "negative",
    });

    await expect(policy.evaluate(input)).resolves.toMatchObject({
      action: "error",
      caseState: "failed",
    });
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({
      state: "failed",
      errorCode: "configuration",
      complaintType: null,
    });
    database.close();
  });
});
