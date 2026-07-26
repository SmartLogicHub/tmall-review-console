import { describe, expect, it, vi } from "vitest";
import { ComplaintReviewService, createAdjudicatedComplaintEligibilityVerifier, type ComplaintEligibilityVerifier, type ComplaintExecutor } from "./complaint-review-service";
import { ComplaintAnalysisScope, executeTrackedComplaintModelInvocation, redactComplaintAnalysisText } from "./complaint-domain";
import type { ComplaintAnalysisModel } from "./deepseek-complaint-analysis";
import { openDatabase, runMigrations } from "../storage/database";
import { ComplaintRepository } from "../storage/complaint-repository";
import type { PersistedReplyDraft } from "../storage/repositories";
import { ReviewActionGate } from "../submission/review-action-gate";
import { DeepSeekConfigurationError, DeepSeekModelContractError, DeepSeekTransientError } from "../deepseek/client";

function draft(sourceKey: string, phase: "initial" | "followup" = "initial"): PersistedReplyDraft {
  return {
    id: `draft-${sourceKey}`, sourceKey, orderId: "order-1", review: "这不是我购买的商品", product: "耳机",
    reviewedAt: null, sentimentLabel: "negative", itemId: "123", reviewPhase: phase,
    library: null, primaryCategory: "", category: "", classificationConfidence: null, classificationReason: null,
    templateVersionId: null, templateSequence: null, originalTemplate: "", finalReply: "", productAdjusted: false,
    rewriteNotes: null, attentionReasons: [], detectedTemplateProducts: [], unsupportedClaims: [], state: "discovered",
    errorCode: null, errorMessage: null, discoveredAt: "2026-07-17T00:00:00.000Z", processedAt: null, updatedAt: "2026-07-17T00:00:00.000Z",
    manualProductId: null, manualHoldReason: null, manualCatalogRevision: null, manualMatchKind: null, manualHoldLastSeenAt: null, manualHoldAbsentScans: 0,
    aiCheckpointStage: null, failedStage: null, aiRetryErrorKind: null, nextRetryAt: null, consecutiveAiFailureRounds: 0,
  };
}

const noComplaintModel: ComplaintAnalysisModel = {
  analyzeComplaint: async () => ({ decision: "no_complaint", complaintType: "none", confidence: 10, quoteStart: null, quoteEnd: null, factCode: "none", reason: "没有可核对的投诉依据" }),
};

const candidateModel: ComplaintAnalysisModel = {
  analyzeComplaint: async () => ({ decision: "complaint_candidate", complaintType: "purchase_a_review_b", confidence: 92, quoteStart: 0, quoteEnd: 9, factCode: "review_targets_other_product", reason: "评价对象明确不是当前商品" }),
};

const verifier: ComplaintEligibilityVerifier = {
  verify: async ({ result }) => ({ finalResult: result, facts: {
    primaryConfirmation: { confirmed: true, pass: "primary", sourceInvocationId: "11111111-1111-4111-8111-111111111111", complaintType: "purchase_a_review_b", factCode: "review_targets_other_product", quoteStart: 0, quoteEnd: 9 },
    independentConfirmation: { confirmed: true, pass: "independent_review", sourceInvocationId: "22222222-2222-4222-8222-222222222222", complaintType: "purchase_a_review_b", factCode: "review_targets_other_product", quoteStart: 0, quoteEnd: 9 },
    targetsOtherProduct: true,
    otherProductExcludedContext: false,
  } }),
};

function setup(model: ComplaintAnalysisModel, executor?: ComplaintExecutor) {
  const database = openDatabase(":memory:");
  runMigrations(database);
  const complaints = new ComplaintRepository(database);
  const ledgerVerifier: ComplaintEligibilityVerifier = { verify: async (input) => {
    const verified = await verifier.verify(input);
    const independentCall = await executeTrackedComplaintModelInvocation("independent_review", async () => input.result);
    const independentInvocationId = independentCall.invocationId;
    complaints.recordAnalysisInvocation(input.caseId, "independent_review", input.result, independentInvocationId);
    return { ...verified, facts: {
      ...verified.facts,
      primaryConfirmation: { ...verified.facts.primaryConfirmation!, sourceInvocationId: input.primaryInvocationId },
      independentConfirmation: { ...verified.facts.independentConfirmation!, sourceInvocationId: independentInvocationId },
    } };
  } };
  const service = new ComplaintReviewService({ complaints, model, verifier: ledgerVerifier, executor });
  return { database, complaints, service };
}

describe("ComplaintReviewService", () => {
  it("pauses after an in-flight primary result without starting another model call", async () => {
    let keepRunning = true;
    let calls = 0;
    const model: ComplaintAnalysisModel = { analyzeComplaint: async () => {
      calls += 1;
      keepRunning = false;
      return { decision: "no_complaint", complaintType: "none", confidence: 90, quoteStart: null, quoteEnd: null, factCode: "none", reason: "无投诉依据" };
    } };
    const { database, complaints, service } = setup(model);
    await expect(service.evaluate(draft("pause-after-primary"), { shouldContinue: () => keepRunning })).resolves.toMatchObject({ action: "paused", caseState: "discovered" });
    expect(calls).toBe(1);
    expect(complaints.findBySource("primary", "pause-after-primary")).toMatchObject({ state: "discovered", complaintType: null });
    database.close();
  });

  it("checks pause before complaint retry and skips the second call and backoff", async () => {
    let keepRunning = true;
    let calls = 0;
    let sleeps = 0;
    const model: ComplaintAnalysisModel = { analyzeComplaint: async () => {
      calls += 1;
      keepRunning = false;
      throw new DeepSeekTransientError("network", "offline");
    } };
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const service = new ComplaintReviewService({ complaints, model, verifier, sleep: async () => { sleeps += 1; } });
    await expect(service.evaluate(draft("pause-before-retry"), { shouldContinue: () => keepRunning })).resolves.toMatchObject({ action: "paused" });
    expect(calls).toBe(1);
    expect(sleeps).toBe(0);
    database.close();
  });

  it("rolls back an intent_saved candidate when paused immediately after atomic prepare", async () => {
    let checkpoints = 0;
    const { database, complaints, service } = setup(candidateModel);
    const decision = await service.evaluate(draft("pause-after-prepare"), { shouldContinue: () => ++checkpoints < 6 });
    expect(decision).toMatchObject({ action: "paused", caseState: "discovered" });
    expect(complaints.findBySource("primary", "pause-after-prepare")).toMatchObject({ state: "discovered", complaintType: null });
    expect(database.prepare("SELECT COUNT(*) AS count FROM complaint_attempts WHERE complaint_case_id = ?").get(decision.caseId)).toEqual({ count: 0 });
    expect(new ReviewActionGate(database).getLock("primary", "pause-after-prepare")).toMatchObject({ actionKind: "complaint" });
    database.close();
  });
  it("accepts the same complaint type and fact with different quote boundaries without adjudication", async () => {
    const scope = new ComplaintAnalysisScope();
    const redacted = redactComplaintAnalysisText("加微信购买课程", scope);
    const primary = { decision: "complaint_candidate" as const, complaintType: "advertising_content" as const, confidence: 92, quoteStart: 0, quoteEnd: 7, factCode: "review_contains_ad_diversion" as const, reason: "广告引流" };
    const independent = { ...primary, quoteEnd: 6, reason: "独立审核引用范围不同" };
    const model: ComplaintAnalysisModel = { analyzeComplaint: vi.fn(async (input) => {
      expect(input.pass).toBe("independent_review");
      expect(input.priorResults).toBeUndefined();
      return independent;
    }) };
    const verified = await createAdjudicatedComplaintEligibilityVerifier(model).verify({ caseId: "case-adjudicated", draft: draft("adjudicated"), result: primary, primaryInvocationId: "11111111-1111-4111-8111-111111111111", analysisText: redacted.analysisText, redacted });
    expect(verified.finalResult).toEqual(primary);
    expect(verified.facts).toMatchObject({
      primaryConfirmation: { pass: "primary", quoteEnd: 7 },
      independentConfirmation: { pass: "independent_review", quoteEnd: 6 },
    });
    expect(verified.facts).not.toHaveProperty("adjudicationConfirmation");
    expect(verified.facts.primaryConfirmation?.sourceInvocationId).not.toBe(verified.facts.independentConfirmation?.sourceInvocationId);
    expect(model.analyzeComplaint).toHaveBeenCalledTimes(1);
    scope.clear();
  });

  it("accepts a tracked primary fact without requiring a duplicate verdict", async () => {
    const primary = { decision: "complaint_candidate" as const, complaintType: "advertising_content" as const, confidence: 94, quoteStart: 0, quoteEnd: 3, factCode: "review_contains_ad_diversion" as const, reason: "第一轮理由" };
    const independent = { ...primary, confidence: 72, reason: "独立审核理由不同" };
    const model: ComplaintAnalysisModel = { analyzeComplaint: vi.fn(async (input) => input.pass === "primary" ? primary : independent) };
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const service = new ComplaintReviewService({ complaints, model, verifier: createAdjudicatedComplaintEligibilityVerifier(model, { invocations: complaints }) });
    const input = { ...draft("same-tuple-different-narrative"), review: "加微信" };

    await expect(service.evaluate(input)).resolves.toMatchObject({ action: "manual_action_required" });
    expect(model.analyzeComplaint).toHaveBeenCalledOnce();
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({ complaintType: "advertising_content" });
    database.close();
  });

  it("rejects an adjudication candidate that matches neither earlier candidate", async () => {
    const scope = new ComplaintAnalysisScope();
    const redacted = redactComplaintAnalysisText("加微信购买课程", scope);
    const primary = { decision: "complaint_candidate" as const, complaintType: "advertising_content" as const, confidence: 90, quoteStart: 0, quoteEnd: 5, factCode: "review_contains_ad_diversion" as const, reason: "广告" };
    const independent = { decision: "no_complaint" as const, complaintType: "none" as const, confidence: 40, quoteStart: null, quoteEnd: null, factCode: "none" as const, reason: "不足" };
    const unmatched = {
      decision: "complaint_candidate" as const,
      complaintType: "insulting_content" as const,
      confidence: 86,
      quoteStart: 0,
      quoteEnd: 7,
      factCode: "review_attacks_person" as const,
      reason: "第三轮给出了不同投诉事实",
    };
    const model: ComplaintAnalysisModel = { analyzeComplaint: vi.fn(async (input) => input.pass === "independent_review" ? independent : unmatched) };
    const verified = await createAdjudicatedComplaintEligibilityVerifier(model).verify({ caseId: "case-unmatched", draft: draft("unmatched"), result: primary, primaryInvocationId: "11111111-1111-4111-8111-111111111111", analysisText: redacted.analysisText, redacted });
    expect(verified.finalResult).toMatchObject({ decision: "no_complaint", complaintType: "none" });
    expect(verified.facts).toEqual({});
    scope.clear();
  });

  it("keeps a clear primary platform complaint even if later model calls would disagree", async () => {
    const primary = { decision: "complaint_candidate" as const, complaintType: "advertising_content" as const, confidence: 90, quoteStart: 0, quoteEnd: 3, factCode: "review_contains_ad_diversion" as const, reason: "广告" };
    const independent = { decision: "no_complaint" as const, complaintType: "none" as const, confidence: 40, quoteStart: null, quoteEnd: null, factCode: "none" as const, reason: "依据不足" };
    const unmatched = {
      decision: "complaint_candidate" as const,
      complaintType: "insulting_content" as const,
      confidence: 86,
      quoteStart: 0,
      quoteEnd: 3,
      factCode: "review_attacks_person" as const,
      reason: "第三轮给出了不同投诉事实",
    };
    const model: ComplaintAnalysisModel = { analyzeComplaint: vi.fn(async (input) => {
      if (input.pass === "primary") return primary;
      return input.pass === "independent_review" ? independent : unmatched;
    }) };
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const service = new ComplaintReviewService({
      complaints,
      model,
      verifier: createAdjudicatedComplaintEligibilityVerifier(model, { invocations: complaints }),
    });
    const input = { ...draft("unresolved-three-pass"), review: "加微信" };

    await expect(service.evaluate(input)).resolves.toMatchObject({ action: "manual_action_required", caseState: "manual_action_required" });
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({
      state: "manual_action_required",
      complaintType: "advertising_content",
    });
    expect(new ReviewActionGate(database).getLock("primary", input.sourceKey)).toMatchObject({ actionKind: "complaint" });
    expect(model.analyzeComplaint).toHaveBeenCalledOnce();
    database.close();
  });

  it("retries a technical complaint call once, pauses, then safely reopens on the next run", async () => {
    let calls = 0;
    const model: ComplaintAnalysisModel = { analyzeComplaint: async () => {
      calls += 1;
      if (calls <= 2) throw new DeepSeekTransientError("network", "network unavailable");
      return { decision: "no_complaint", complaintType: "none", confidence: 80, quoteStart: null, quoteEnd: null, factCode: "none", reason: "无投诉依据" };
    } };
    const { database, complaints, service } = setup(model);
    await expect(service.evaluate(draft("retry-next-run"))).resolves.toMatchObject({ action: "error", caseState: "failed" });
    expect(calls).toBe(2);
    expect(complaints.findBySource("primary", "retry-next-run")).toMatchObject({ state: "failed", complaintType: null });
    await expect(service.evaluate(draft("retry-next-run"))).resolves.toMatchObject({ action: "reply", caseState: "no_complaint" });
    expect(calls).toBe(3);
    expect(complaints.listEvents(complaints.findBySource("primary", "retry-next-run")!.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "analysis_reopened" }),
    ]));
    database.close();
  });

  it("does not retry a complaint configuration failure", async () => {
    let calls = 0;
    const model: ComplaintAnalysisModel = { analyzeComplaint: async () => {
      calls += 1;
      throw new DeepSeekConfigurationError("missing_api_key", "missing");
    } };
    const { database, service } = setup(model);
    await expect(service.evaluate(draft("config-failure"))).resolves.toMatchObject({ action: "error", caseState: "failed" });
    expect(calls).toBe(1);
    database.close();
  });

  it.each([
    ["timeout", () => new DeepSeekTransientError("timeout", "timed out")],
    ["model contract", () => new DeepSeekModelContractError("bad json")],
  ] as const)("retries a %s complaint model failure exactly once", async (_name, failure) => {
    let calls = 0;
    const model: ComplaintAnalysisModel = { analyzeComplaint: async () => {
      calls += 1;
      throw failure();
    } };
    const { database, service } = setup(model);
    await expect(service.evaluate(draft(`retry-${_name}`))).resolves.toMatchObject({ action: "error", caseState: "failed" });
    expect(calls).toBe(2);
    database.close();
  });

  it.each(["rate_limited", "service_unavailable", "transient_unknown"] as const)("retries DeepSeek transient kind %s exactly once", async (kind) => {
    let calls = 0;
    const model: ComplaintAnalysisModel = { analyzeComplaint: async () => {
      calls += 1;
      throw new DeepSeekTransientError(kind, kind);
    } };
    const { database, service } = setup(model);
    await expect(service.evaluate(draft(`no-immediate-retry-${kind}`))).resolves.toMatchObject({ action: "error", caseState: "failed" });
    expect(calls).toBe(2);
    database.close();
  });

  it("retries an unknown model-call error once without misclassifying it as a model contract failure", async () => {
    let calls = 0;
    const model: ComplaintAnalysisModel = { analyzeComplaint: async () => {
      calls += 1;
      throw new Error("repository invariant failed");
    } };
    const { database, complaints, service } = setup(model);
    await expect(service.evaluate(draft("ordinary-program-error"))).resolves.toMatchObject({ action: "error", caseState: "failed" });
    expect(calls).toBe(2);
    expect(complaints.findBySource("primary", "ordinary-program-error")).toMatchObject({ errorCode: "internal" });
    database.close();
  });

  it("continues as no complaint when a candidate lacks deterministic objective facts", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const service = new ComplaintReviewService({
      complaints,
      model: candidateModel,
      verifier: { verify: async ({ result }) => ({ finalResult: result, facts: {} }) },
    });
    await expect(service.evaluate(draft("missing-hard-facts"))).resolves.toMatchObject({ action: "reply", caseState: "no_complaint" });
    expect(complaints.findBySource("primary", "missing-hard-facts")).toMatchObject({ state: "no_complaint", complaintType: null });
    database.close();
  });

  it("continues as no complaint when meaninglessProgramDetected is false", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const result = { decision: "complaint_candidate" as const, complaintType: "meaningless_content" as const, confidence: 90, quoteStart: 0, quoteEnd: 4, factCode: "review_is_meaningless" as const, reason: "疑似重复" };
    const base = { confirmed: true as const, complaintType: result.complaintType, factCode: result.factCode, quoteStart: 0, quoteEnd: 4 };
    const service = new ComplaintReviewService({
      complaints,
      model: { analyzeComplaint: async () => result },
      verifier: { verify: async () => ({ finalResult: result, facts: {
        primaryConfirmation: { ...base, pass: "primary", sourceInvocationId: "11111111-1111-4111-8111-111111111111" },
        independentConfirmation: { ...base, pass: "independent_review", sourceInvocationId: "22222222-2222-4222-8222-222222222222" },
        meaninglessProgramDetected: false,
        shortSentimentExcluded: true,
        logisticsOrServiceExcluded: true,
      } }) },
    });
    const input = { ...draft("meaningless-false"), review: "哈哈哈哈" };
    await expect(service.evaluate(input)).resolves.toMatchObject({ action: "reply", caseState: "no_complaint" });
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({ state: "no_complaint", complaintType: null });
    database.close();
  });

  it("uses one primary complaint analysis for praise that also contains deterministic ad diversion", async () => {
    let calls = 0;
    const model: ComplaintAnalysisModel = { analyzeComplaint: async () => {
      calls += 1;
      return { decision: "complaint_candidate", complaintType: "advertising_content", confidence: 96, quoteStart: 5, quoteEnd: 10, factCode: "review_contains_ad_diversion", reason: "评价含广告引流" };
    } };
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const service = new ComplaintReviewService({ complaints, model, verifier: createAdjudicatedComplaintEligibilityVerifier(model, { invocations: complaints }) });
    const input = { ...draft("positive-with-ad"), review: "音质很好，加微信买课", sentimentLabel: "positive" as const };

    await expect(service.evaluate(input)).resolves.toMatchObject({ action: "manual_action_required" });
    expect(calls).toBe(1);
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({ complaintType: "advertising_content" });
    database.close();
  });
  it("double-checks review-only meaningless content but never invents external evidence facts", async () => {
    const scope = new ComplaintAnalysisScope();
    const redacted = redactComplaintAnalysisText("哈哈哈哈", scope);
    const model: ComplaintAnalysisModel = {
      analyzeComplaint: async () => ({
        decision: "complaint_candidate", complaintType: "meaningless_content", factCode: "review_is_meaningless",
        confidence: 96, quoteStart: 0, quoteEnd: 4, reason: "评价仅为重复无意义字符",
      }),
    };
    const { facts } = await createAdjudicatedComplaintEligibilityVerifier(model).verify({
      caseId: "case-review-only-facts", draft: draft("review-only-facts"), result: await model.analyzeComplaint({ pass: "primary", review: redacted, officialTypes: ["meaningless_content"] }),
      primaryInvocationId: "11111111-1111-4111-8111-111111111111",
      analysisText: redacted.analysisText, redacted,
    });
    expect(facts).toMatchObject({
      primaryConfirmation: { complaintType: "meaningless_content" },
      independentConfirmation: { factCode: "review_is_meaningless" },
      shortSentimentExcluded: true,
      logisticsOrServiceExcluded: true,
    });
    scope.clear();
  });

  it("does not manufacture external evidence when the second candidate is a type that needs it", async () => {
    const scope = new ComplaintAnalysisScope();
    const redacted = redactComplaintAnalysisText("这不是我的商品", scope);
    const model: ComplaintAnalysisModel = {
      analyzeComplaint: async () => ({
        decision: "complaint_candidate", complaintType: "purchase_a_review_b", factCode: "review_targets_other_product",
        confidence: 96, quoteStart: 0, quoteEnd: 7, reason: "模型认为评价对象不同",
      }),
    };
    const { facts } = await createAdjudicatedComplaintEligibilityVerifier(model).verify({
      caseId: "case-external-facts", draft: draft("external-facts"), result: await model.analyzeComplaint({ pass: "primary", review: redacted, officialTypes: ["purchase_a_review_b"] }),
      primaryInvocationId: "11111111-1111-4111-8111-111111111111",
      analysisText: redacted.analysisText, redacted,
    });
    expect(facts).toEqual(expect.objectContaining({
      primaryConfirmation: expect.any(Object),
      independentConfirmation: expect.any(Object),
    }));
    expect(facts).not.toHaveProperty("targetsOtherProduct");
    scope.clear();
  });

  it("keeps the complaint lock when analysis fails before the case enters the analysing state", async () => {
    const unavailableModel: ComplaintAnalysisModel = {
      analyzeComplaint: async () => {
        throw new Error("network unavailable");
      },
    };
    const { database, complaints, service } = setup(unavailableModel);
    const result = await service.evaluate(draft("source-analysis-unavailable"));

    expect(result).toMatchObject({ action: "error", caseState: "failed" });
    expect(complaints.findBySource("primary", "source-analysis-unavailable")).toMatchObject({ state: "failed" });
    expect(new ReviewActionGate(database).getLock("primary", "source-analysis-unavailable")).toMatchObject({ actionKind: "complaint" });
    database.close();
  });

  it("runs complaint analysis before reply and atomically releases a no-complaint review to the reply action", async () => {
    const { database, complaints, service } = setup(noComplaintModel);
    const result = await service.evaluate(draft("source-no-complaint"));

    expect(result).toMatchObject({ action: "reply" });
    expect(complaints.findBySource("primary", "source-no-complaint")).toMatchObject({ state: "no_complaint" });
    expect(new ReviewActionGate(database).getLock("primary", "source-no-complaint")).toMatchObject({ actionKind: "reply" });
    database.close();
  });

  it("accepts obviously repetitive gibberish as text-only meaningless-content evidence", async () => {
    const review = "吧哈哈哈广告费风风光光vvvv发纷纷扰扰";
    const model: ComplaintAnalysisModel = {
      analyzeComplaint: async () => ({
        decision: "complaint_candidate", complaintType: "meaningless_content", factCode: "review_is_meaningless",
        confidence: 90, quoteStart: 0, quoteEnd: Array.from(review).length, reason: "评价为多段重复且无实际语义的字符",
      }),
    };
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const service = new ComplaintReviewService({
      complaints,
      model,
      verifier: createAdjudicatedComplaintEligibilityVerifier(model, { invocations: complaints }),
    });
    const input = { ...draft("source-text-only-meaningless"), review, sentimentLabel: "neutral" as const };

    await expect(service.evaluate(input)).resolves.toMatchObject({ action: "manual_action_required", caseState: "manual_action_required" });
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({
      state: "manual_action_required",
      complaintType: "meaningless_content",
    });
    expect(new ReviewActionGate(database).getLock("primary", input.sourceKey)).toMatchObject({ actionKind: "complaint" });
    database.close();
  });

  it("recovers when the independent complaint review has one temporary internal failure", async () => {
    const candidate = {
      decision: "complaint_candidate" as const,
      complaintType: "purchase_a_review_b" as const,
      confidence: 92,
      quoteStart: 0,
      quoteEnd: 9,
      factCode: "review_targets_other_product" as const,
      reason: "评价对象可能不是当前商品",
    };
    const noComplaint = {
      decision: "no_complaint" as const,
      complaintType: "none" as const,
      confidence: 88,
      quoteStart: null,
      quoteEnd: null,
      factCode: "none" as const,
      reason: "独立复核未发现投诉依据",
    };
    let independentCalls = 0;
    const model: ComplaintAnalysisModel = {
      analyzeComplaint: vi.fn(async (input) => {
        if (input.pass === "primary") return candidate;
        if (input.pass === "independent_review") {
          independentCalls += 1;
          if (independentCalls === 1) throw new Error("temporary internal");
        }
        return noComplaint;
      }),
    };
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const service = new ComplaintReviewService({
      complaints,
      model,
      verifier: createAdjudicatedComplaintEligibilityVerifier(model, { invocations: complaints }),
      sleep: async () => undefined,
    });

    await expect(service.evaluate(draft("independent-internal-retry"))).resolves.toMatchObject({
      action: "reply",
      caseState: "no_complaint",
    });
    expect(independentCalls).toBe(2);
    expect(model.analyzeComplaint).toHaveBeenCalledTimes(4);
    expect(complaints.findBySource("primary", "independent-internal-retry")).toMatchObject({ state: "no_complaint" });
    database.close();
  });

  it("rejects a political-sensitive candidate for an ordinary Taiwan registration limitation", async () => {
    const review = "臺灣地區無法注冊，只能當做普通耳機使用！可惜！在未改進前除大陸地區外，要購買需三思以免後悔！";
    const model: ComplaintAnalysisModel = {
      analyzeComplaint: vi.fn(async () => ({
        decision: "complaint_candidate",
        complaintType: "political_terror_sensitive",
        confidence: 95,
        quoteStart: 0,
        quoteEnd: Array.from(review).length,
        factCode: "review_contains_political_terror_content",
        reason: "评价提到地区名称",
      })),
    };
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const service = new ComplaintReviewService({
      complaints,
      model,
      verifier: createAdjudicatedComplaintEligibilityVerifier(model, { invocations: complaints }),
    });

    await expect(service.evaluate({ ...draft("taiwan-registration-limit"), review })).resolves.toMatchObject({
      action: "reply",
      caseState: "no_complaint",
    });
    expect(complaints.findBySource("primary", "taiwan-registration-limit")).toMatchObject({ state: "no_complaint" });
    database.close();
  });

  it("accepts a tracked primary semantic fact without requesting a wider duplicate quote", async () => {
    const primary = { decision: "complaint_candidate" as const, complaintType: "advertising_content" as const, confidence: 94, quoteStart: 0, quoteEnd: 3, factCode: "review_contains_ad_diversion" as const, reason: "广告引流" };
    const independent = { ...primary, confidence: 82, quoteEnd: 7, reason: "独立审核引用了完整句子" };
    const model: ComplaintAnalysisModel = { analyzeComplaint: vi.fn(async (input) => input.pass === "primary" ? primary : independent) };
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const service = new ComplaintReviewService({ complaints, model, verifier: createAdjudicatedComplaintEligibilityVerifier(model, { invocations: complaints }) });
    const input = { ...draft("same-fact-wider-quote"), review: "加微信购买课程" };

    await expect(service.evaluate(input)).resolves.toMatchObject({ action: "manual_action_required" });
    expect(model.analyzeComplaint).toHaveBeenCalledOnce();
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({ complaintType: "advertising_content" });
    database.close();
  });

  it.each([
    {
      name: "评价明确写错商品",
      type: "purchase_a_review_b" as const,
      factCode: "review_targets_other_product" as const,
      review: "这条评价写错商品了，说的是我买的音箱，不是这个耳机",
    },
    {
      name: "公开快递员隐私",
      type: "privacy_leak" as const,
      factCode: "review_exposes_third_party_privacy" as const,
      review: "快递员的电话是13800138000，大家都去联系他",
    },
    {
      name: "明确暴恐宣传",
      type: "political_terror_sensitive" as const,
      factCode: "review_contains_political_terror_content" as const,
      review: "支持恐怖组织发动袭击并号召加入",
    },
    {
      name: "明确色情传播",
      type: "vulgar_sexual_content" as const,
      factCode: "review_contains_vulgar_sexual_content" as const,
      review: "传播成人视频和色情图片",
    },
    {
      name: "明确违禁品交易",
      type: "prohibited_goods" as const,
      factCode: "review_promotes_prohibited_goods" as const,
      review: "出售冰毒，需要购买可以联系我",
    },
    {
      name: "明确针对未成年人的色情内容",
      type: "minor_harmful_content" as const,
      factCode: "review_contains_minor_harm" as const,
      review: "传播未成年人色情视频",
    },
    {
      name: "以删除差评索取额外红包",
      type: "extortion_for_improper_benefit" as const,
      factCode: "review_explicitly_demands_benefit" as const,
      review: "给我五百元红包，不然我就不删除差评",
    },
    {
      name: "明确同行身份并恶意报复",
      type: "competitor_malicious_review" as const,
      factCode: "review_explicit_competitor_malice" as const,
      review: "我就是同行，专门给你差评搞垮你的店",
    },
  ])("accepts text-only evidence for $name", async ({ type, factCode, review }) => {
    const result = {
      decision: "complaint_candidate" as const,
      complaintType: type,
      confidence: 94,
      quoteStart: 0,
      quoteEnd: Array.from(review).length,
      factCode,
      reason: "评价正文包含可直接核对的事实",
    };
    const model: ComplaintAnalysisModel = { analyzeComplaint: vi.fn(async () => result) };
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const service = new ComplaintReviewService({ complaints, model, verifier: createAdjudicatedComplaintEligibilityVerifier(model, { invocations: complaints }) });
    const input = { ...draft(`text-only-${type}`), review };

    await expect(service.evaluate(input)).resolves.toMatchObject({ action: "manual_action_required", caseState: "manual_action_required" });
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({ complaintType: type });
    database.close();
  });

  it.each([
    {
      name: "正常退款诉求",
      type: "extortion_for_improper_benefit" as const,
      factCode: "review_explicitly_demands_benefit" as const,
      review: "商品坏了，不给我退款我就不改评价",
    },
    {
      name: "正常儿童商品使用",
      type: "minor_harmful_content" as const,
      factCode: "review_contains_minor_harm" as const,
      review: "给孩子买的耳机很好用",
    },
    {
      name: "正常人体佩戴反馈",
      type: "vulgar_sexual_content" as const,
      factCode: "review_contains_vulgar_sexual_content" as const,
      review: "耳机戴久了耳朵疼",
    },
    {
      name: "普通历史内容",
      type: "political_terror_sensitive" as const,
      factCode: "review_contains_political_terror_content" as const,
      review: "这本书介绍二战历史，包装完好",
    },
    {
      name: "普通负面评价",
      type: "competitor_malicious_review" as const,
      factCode: "review_explicit_competitor_malice" as const,
      review: "质量很差，完全不推荐",
    },
  ])("rejects unsafe text-only inference for $name", async ({ type, factCode, review }) => {
    const result = {
      decision: "complaint_candidate" as const,
      complaintType: type,
      confidence: 94,
      quoteStart: 0,
      quoteEnd: Array.from(review).length,
      factCode,
      reason: "模型候选需要本地排除误判",
    };
    const model: ComplaintAnalysisModel = { analyzeComplaint: vi.fn(async () => result) };
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const service = new ComplaintReviewService({ complaints, model, verifier: createAdjudicatedComplaintEligibilityVerifier(model, { invocations: complaints }) });
    const input = { ...draft(`excluded-${type}`), review };

    await expect(service.evaluate(input)).resolves.toMatchObject({ action: "reply", caseState: "no_complaint" });
    database.close();
  });

  it("rejects a meaningless-content complaint for explicit positive product text", async () => {
    const review = "非常好用 值得推荐啊啊啊啊啊啊啊啊 图片随便找的";
    const model: ComplaintAnalysisModel = {
      analyzeComplaint: async () => ({
        decision: "complaint_candidate", complaintType: "meaningless_content", factCode: "review_is_meaningless",
        confidence: 90, quoteStart: 0, quoteEnd: Array.from(review).length, reason: "评价含重复字符",
      }),
    };
    const database = openDatabase(":memory:");
    runMigrations(database);
    const complaints = new ComplaintRepository(database);
    const service = new ComplaintReviewService({
      complaints,
      model,
      verifier: createAdjudicatedComplaintEligibilityVerifier(model, { invocations: complaints }),
    });
    const input = { ...draft("source-explicit-positive-text"), review, sentimentLabel: "positive" as const };

    await expect(service.evaluate(input)).resolves.toMatchObject({ action: "reply", caseState: "no_complaint" });
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({ state: "no_complaint" });
    expect(new ReviewActionGate(database).getLock("primary", input.sourceKey)).toMatchObject({ actionKind: "reply" });
    database.close();
  });

  it("releases a clearly positive review directly to the reply flow without complaint analysis", async () => {
    let calls = 0;
    const model: ComplaintAnalysisModel = {
      analyzeComplaint: async () => {
        calls += 1;
        return { decision: "no_complaint", complaintType: "none", confidence: 100, quoteStart: null, quoteEnd: null, factCode: "none", reason: "unused" };
      },
    };
    const { database, complaints, service } = setup(model);
    const positive = { ...draft("source-clear-praise"), review: "戴了两小时耳朵也没觉得压，真的很舒服。", sentimentLabel: "positive" as const };

    await expect(service.evaluate(positive)).resolves.toMatchObject({ action: "reply", caseState: "no_complaint" });
    expect(calls).toBe(1);
    expect(complaints.findBySource("primary", "source-clear-praise")).toMatchObject({ state: "no_complaint" });
    database.close();
  });

  it("retries a pre-submit complaint analysis hold once after a prompt upgrade", async () => {
    const { database, complaints, service } = setup(noComplaintModel);
    const input = draft("source-prompt-upgrade");
    const discovered = complaints.discover("primary", input.sourceKey, {
      reviewId: input.sourceKey, contentHash: "b".repeat(64), canonicalizerVersion: "test", phase: "initial", imagePairs: [],
      promptVersion: "2026-07-14-v1", ruleVersion: "test", mappingVersion: "test", visualVersion: "test", platformMappingVersion: "test", modelVersion: "test",
    });
    complaints.markManualActionRequired(discovered.id, "model_contract");

    await expect(service.evaluate(input)).resolves.toMatchObject({ action: "reply", caseState: "no_complaint" });
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({ state: "no_complaint", promptVersion: "2026-07-24-v5" });
    database.close();
  });

  it("persists a fixed candidate and blocks reply when the complaint executor is unavailable", async () => {
    const { database, complaints, service } = setup(candidateModel);
    const result = await service.evaluate(draft("source-executor-unavailable"));
    const saved = complaints.findBySource("primary", "source-executor-unavailable");

    expect(result).toMatchObject({ action: "manual_action_required" });
    expect(saved).toMatchObject({ state: "manual_action_required", complaintType: "purchase_a_review_b" });
    expect(saved?.description).toContain("请平台结合评价内容及相关信息审核，并屏蔽处理，谢谢。");
    expect(new ReviewActionGate(database).getLock("primary", "source-executor-unavailable")).toMatchObject({ actionKind: "complaint" });
    database.close();
  });

  it("keeps a follow-up complaint target and forbids reply after an uncertain complaint submission", async () => {
    const executor: ComplaintExecutor = {
      execute: async (input) => {
        expect(input.reviewPhase).toBe("followup");
        input.beforeSubmit();
        return { state: "uncertain", reason: "submission result unavailable" };
      },
    };
    const { database, complaints, service } = setup(candidateModel, executor);
    const result = await service.evaluate(draft("source-followup", "followup"));

    expect(result).toMatchObject({ action: "skip", caseState: "submission_uncertain" });
    expect(complaints.findBySource("primary", "source-followup")).toMatchObject({ state: "submission_uncertain", phase: "followup" });
    expect(new ReviewActionGate(database).getLock("primary", "source-followup")).toMatchObject({ actionKind: "complaint" });
    database.close();
  });

  it("does not create a submission-uncertain case when the browser fails before the submit click", async () => {
    const executor: ComplaintExecutor = {
      execute: async () => ({ state: "failed_before_click", reason: "type option unavailable" }),
    };
    const { database, complaints, service } = setup(candidateModel, executor);
    const result = await service.evaluate(draft("source-before-click"));

    expect(result).toMatchObject({ action: "skip", caseState: "failed" });
    expect(complaints.findBySource("primary", "source-before-click")).toMatchObject({ state: "failed" });
    database.close();
  });

  it("marks an explicitly platform-handled violation as terminal without clicking or retrying", async () => {
    const executor: ComplaintExecutor = {
      execute: async () => ({ state: "already_handled", reason: "platform already handled the user's violation" }),
    };
    const { database, complaints, service } = setup(candidateModel, executor);

    await expect(service.evaluate(draft("source-platform-handled"))).resolves.toMatchObject({ action: "skip", caseState: "not_actionable" });
    const saved = complaints.findBySource("primary", "source-platform-handled");
    expect(saved).toMatchObject({ state: "not_actionable", errorCode: "platform_already_handled" });
    expect(database.prepare("SELECT COUNT(*) AS value FROM complaint_attempts WHERE complaint_case_id = ?").get(saved!.id)).toEqual({ value: 0 });
    expect(new ReviewActionGate(database).getTombstone("primary", "source-platform-handled")).toMatchObject({ terminalAction: "complaint_not_actionable" });
    database.close();
  });

  it("records a platform rejection after click as platform handled, never as this program's submitted complaint", async () => {
    const executor: ComplaintExecutor = {
      execute: async (input) => {
        input.beforeSubmit();
        return { state: "already_handled", reason: "平台已判定该评价违规，本次提交未受理" };
      },
    };
    const { database, complaints, service } = setup(candidateModel, executor);

    await expect(service.evaluate(draft("source-platform-handled-after-click"))).resolves.toMatchObject({
      action: "skip",
      caseState: "not_actionable",
    });
    const saved = complaints.findBySource("primary", "source-platform-handled-after-click");
    expect(saved).toMatchObject({
      state: "not_actionable",
      errorCode: "platform_already_handled",
    });
    expect(database.prepare(`
      SELECT state, error_code, submitted_at
      FROM complaint_attempts
      WHERE complaint_case_id = ?
    `).get(saved!.id)).toEqual({
      state: "failed",
      error_code: "platform_already_handled",
      submitted_at: null,
    });
    expect(new ReviewActionGate(database).getTombstone("primary", "source-platform-handled-after-click")).toMatchObject({
      terminalAction: "complaint_not_actionable",
    });
    database.close();
  });

  it("reconciles a previously failed local complaint to the platform upheld state and never analyzes or submits it again", async () => {
    let calls = 0;
    const unavailableModel: ComplaintAnalysisModel = {
      analyzeComplaint: async () => {
        calls += 1;
        throw new DeepSeekTransientError("timeout", "timed out");
      },
    };
    const { database, complaints, service } = setup(unavailableModel);
    const input = draft("source-platform-upheld-after-local-failure");

    await expect(service.evaluate(input)).resolves.toMatchObject({ action: "error", caseState: "failed" });
    expect(calls).toBe(2);

    await expect(service.reconcilePlatformState(input, "complaint_upheld")).resolves.toMatchObject({
      action: "skip",
      caseState: "upheld",
    });
    await expect(service.evaluate(input)).resolves.toMatchObject({ action: "skip", caseState: "upheld" });

    expect(calls).toBe(2);
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({ state: "upheld" });
    expect(new ReviewActionGate(database).getTombstone("primary", input.sourceKey)).toMatchObject({
      terminalAction: "complaint_upheld",
    });
    database.close();
  });

  it("treats a platform complaint record as under review and skips AI and browser submission", async () => {
    let calls = 0;
    const model: ComplaintAnalysisModel = {
      analyzeComplaint: async () => {
        calls += 1;
        return { decision: "no_complaint", complaintType: "none", confidence: 100, quoteStart: null, quoteEnd: null, factCode: "none", reason: "unused" };
      },
    };
    const executor: ComplaintExecutor = { execute: vi.fn(async () => ({ state: "failed_before_click", reason: "must not run" })) };
    const { database, complaints, service } = setup(model, executor);
    const input = draft("source-platform-complaint-record");

    await expect(service.reconcilePlatformState(input, "complaint_record")).resolves.toMatchObject({
      action: "skip",
      caseState: "under_review",
    });
    await expect(service.evaluate(input)).resolves.toMatchObject({ action: "skip", caseState: "under_review" });

    expect(calls).toBe(0);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({ state: "under_review" });
    database.close();
  });

  it("continues the queue after a confirmed complaint submission without replying to that review", async () => {
    const executor: ComplaintExecutor = {
      execute: async (input) => {
        input.beforeSubmit();
        return { state: "submitted", platformCaseId: "case-1", detailUrl: "https://myseller.taobao.com/complaint/case-1" };
      },
    };
    const { database, complaints, service } = setup(candidateModel, executor);
    const result = await service.evaluate(draft("source-submitted"));

    expect(result).toMatchObject({ action: "skip", caseState: "submitted" });
    expect(complaints.findBySource("primary", "source-submitted")).toMatchObject({ state: "submitted" });
    database.close();
  });

  it("keeps a confirmed complaint terminal when the platform returns only a case id", async () => {
    const executor: ComplaintExecutor = {
      execute: async (input) => {
        input.beforeSubmit();
        return { state: "submitted", platformCaseId: "case-only" };
      },
    };
    const { database, complaints, service } = setup(candidateModel, executor);

    expect(await service.evaluate(draft("source-case-only"))).toMatchObject({ action: "skip", caseState: "submitted" });
    expect(complaints.findBySource("primary", "source-case-only")).toMatchObject({ state: "submitted" });
    database.close();
  });
});
