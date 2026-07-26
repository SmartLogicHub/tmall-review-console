import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "./database";
import { ComplaintRepository } from "./complaint-repository";
import { ReviewActionGate } from "../submission/review-action-gate";
import { executeTrackedComplaintModelInvocation, redactComplaintAnalysisText, validateComplaintAnalysis, type ValidComplaintCandidate } from "../complaints/complaint-domain";

function createRepository() {
  const database = openDatabase(":memory:");
  runMigrations(database);
  return { database, repository: new ComplaintRepository(database) };
}

function discover(repository: ComplaintRepository, sourceKey: string) {
  return repository.discover("primary", sourceKey, {
    reviewId: `review-id-${sourceKey}`, contentHash: "b".repeat(64), canonicalizerVersion: "canonical-v1", phase: "initial", imagePairs: [],
    promptVersion: "p1", ruleVersion: "r1", mappingVersion: "m1", visualVersion: "visual-v1", platformMappingVersion: "platform-v1", modelVersion: "model-v1",
  });
}

const candidate = await (async () => {
  const text = redactComplaintAnalysisText("不是当前商品");
  const result = { decision: "complaint_candidate" as const, complaintType: "purchase_a_review_b" as const, factCode: "review_targets_other_product" as const, confidence: 90, quoteStart: 0, quoteEnd: 6, reason: "评价对象不一致" };
  const primary = await executeTrackedComplaintModelInvocation("primary", async () => result);
  const independent = await executeTrackedComplaintModelInvocation("independent_review", async () => result);
  return validateComplaintAnalysis({ reviewText: text.analysisText, facts: {
    primaryConfirmation: { confirmed: true, pass: "primary", sourceInvocationId: primary.invocationId, complaintType: "purchase_a_review_b", factCode: "review_targets_other_product", quoteStart: 0, quoteEnd: 6 },
    independentConfirmation: { confirmed: true, pass: "independent_review", sourceInvocationId: independent.invocationId, complaintType: "purchase_a_review_b", factCode: "review_targets_other_product", quoteStart: 0, quoteEnd: 6 }, targetsOtherProduct: true, otherProductExcludedContext: false,
  }, result });
})();

function recordCandidate(repository: ComplaintRepository, caseId: string, value = candidate as ValidComplaintCandidate) {
  for (const confirmation of [value.validationFacts.primaryConfirmation, value.validationFacts.independentConfirmation, value.validationFacts.adjudicationConfirmation]) {
    if (confirmation) repository.recordAnalysisInvocation(caseId, confirmation.pass, value.modelResult, confirmation.sourceInvocationId);
  }
  return repository.recordValidatedCandidate(caseId, value);
}

describe("ComplaintRepository", () => {
  it("accepts persisted real invocations with the same candidate tuple but different confidence and reasons", async () => {
    const { database, repository } = createRepository();
    const redacted = redactComplaintAnalysisText("加微信");
    const primaryResult = { decision: "complaint_candidate" as const, complaintType: "advertising_content" as const, confidence: 94, quoteStart: 0, quoteEnd: 3, factCode: "review_contains_ad_diversion" as const, reason: "第一轮理由" };
    const independentResult = { ...primaryResult, confidence: 72, reason: "独立审核理由不同" };
    const primaryCall = await executeTrackedComplaintModelInvocation("primary", async () => primaryResult);
    const independentCall = await executeTrackedComplaintModelInvocation("independent_review", async () => independentResult);
    const base = { confirmed: true as const, complaintType: primaryResult.complaintType, factCode: primaryResult.factCode, quoteStart: 0, quoteEnd: 3 };
    const validated = validateComplaintAnalysis({
      reviewText: redacted.analysisText,
      result: primaryResult,
      facts: {
        primaryConfirmation: { ...base, pass: "primary", sourceInvocationId: primaryCall.invocationId },
        independentConfirmation: { ...base, pass: "independent_review", sourceInvocationId: independentCall.invocationId },
        hasDiversionSignal: true,
        piiDetected: false,
      },
    });
    const discovered = discover(repository, "same-identity-different-narrative");
    repository.recordAnalysisInvocation(discovered.id, "primary", primaryResult, primaryCall.invocationId);
    repository.recordAnalysisInvocation(discovered.id, "independent_review", independentResult, independentCall.invocationId);

    expect(repository.recordValidatedCandidate(discovered.id, validated as ValidComplaintCandidate)).toMatchObject({
      complaintType: "advertising_content",
      factCode: "review_contains_ad_diversion",
    });
    expect(new Set((database.prepare("SELECT result_digest FROM complaint_analysis_invocations WHERE complaint_case_id = ?").all(discovered.id) as Array<{ result_digest: string }>).map((row) => row.result_digest)).size).toBe(1);
    database.close();
  });

  it("persists one tracked primary confirmation and rejects a copied pass", async () => {
    const { database, repository } = createRepository();
    const redacted = redactComplaintAnalysisText("加微信");
    const result = { decision: "complaint_candidate" as const, complaintType: "advertising_content" as const, confidence: 93, quoteStart: 0, quoteEnd: 3, factCode: "review_contains_ad_diversion" as const, reason: "广告引流" };
    const primaryCall = await executeTrackedComplaintModelInvocation("primary", async () => result);
    const adjudicationCall = await executeTrackedComplaintModelInvocation("adjudication", async () => result);
    const primary = { confirmed: true as const, pass: "primary" as const, sourceInvocationId: primaryCall.invocationId, complaintType: result.complaintType, factCode: result.factCode, quoteStart: 0, quoteEnd: 3 };
    const adjudication = { ...primary, pass: "adjudication" as const, sourceInvocationId: adjudicationCall.invocationId };
    const adjudicated = validateComplaintAnalysis({ reviewText: redacted.analysisText, result, facts: {
      primaryConfirmation: primary, adjudicationConfirmation: adjudication, hasDiversionSignal: true, piiDetected: false,
    } });
    const saved = recordCandidate(repository, discover(repository, "adjudicated-storage").id, adjudicated as ValidComplaintCandidate);
    expect(saved).toMatchObject({ complaintType: "advertising_content", factCode: "review_contains_ad_diversion" });
    const copiedConfirmation = { ...primary, pass: "independent_review" as const };
    const forged = { ...adjudicated, validationFacts: { independentConfirmation: copiedConfirmation, hasDiversionSignal: true, piiDetected: false } };
    expect(() => repository.recordValidatedCandidate(discover(repository, "copied-confirmation-storage").id, forged as Exclude<typeof adjudicated, { decision: "no_complaint" }>)).toThrow(/证明|验证|修改/u);
    const primaryOnly = validateComplaintAnalysis({ reviewText: redacted.analysisText, result, facts: {
      primaryConfirmation: primary, hasDiversionSignal: true, piiDetected: false,
    } });
    const primaryOnlyCase = discover(repository, "primary-only-storage");
    repository.recordAnalysisInvocation(primaryOnlyCase.id, "primary", result, primaryCall.invocationId);
    expect(repository.recordValidatedCandidate(primaryOnlyCase.id, primaryOnly as ValidComplaintCandidate)).toMatchObject({
      complaintType: "advertising_content",
      factCode: "review_contains_ad_diversion",
    });
    database.close();
  });

  it("reopens only a safe pre-submit analysis failure", () => {
    const { database, repository } = createRepository();
    const analysisFailure = discover(repository, "analysis-failed-reopen");
    repository.markFailed(analysisFailure.id, "network");
    expect(repository.reopenFailedAnalysis(analysisFailure.id)).toMatchObject({ state: "discovered", complaintType: null, errorCode: null });

    const browserFailure = discover(repository, "browser-failed-no-reopen");
    recordCandidate(repository, browserFailure.id);
    repository.prepare(browserFailure.id);
    repository.markFailed(browserFailure.id, "platform_changed");
    expect(repository.reopenFailedAnalysis(browserFailure.id)).toMatchObject({ state: "failed", complaintType: "purchase_a_review_b" });
    database.close();
  });

  it("atomically prepares one exact validated candidate and rejects a different replay", () => {
    const { database, repository } = createRepository();
    const exact = discover(repository, "atomic-prepare");
    for (const confirmation of [candidate.validationFacts.primaryConfirmation, candidate.validationFacts.independentConfirmation]) {
      if (confirmation) repository.recordAnalysisInvocation(exact.id, confirmation.pass, candidate.modelResult, confirmation.sourceInvocationId);
    }

    expect(repository.prepareValidatedCandidate(exact.id, candidate as ValidComplaintCandidate)).toMatchObject({
      state: "prepared",
      complaintType: "purchase_a_review_b",
    });
    expect(repository.prepareValidatedCandidate(exact.id, candidate as ValidComplaintCandidate).state).toBe("prepared");
    expect(database.prepare("SELECT COUNT(*) AS value FROM complaint_attempts WHERE complaint_case_id = ?").get(exact.id)).toEqual({ value: 1 });

    const storedBeforePrepare = discover(repository, "mismatched-prepare");
    recordCandidate(repository, storedBeforePrepare.id);
    const changed = {
      ...(candidate as ValidComplaintCandidate),
      modelResult: { ...candidate.modelResult, reason: "不同的二审结果" },
    } as ValidComplaintCandidate;
    expect(() => repository.prepareValidatedCandidate(storedBeforePrepare.id, changed)).toThrow(/不一致/u);
    expect(repository.get(storedBeforePrepare.id)).toMatchObject({ state: "discovered" });
    expect(database.prepare("SELECT COUNT(*) AS value FROM complaint_attempts WHERE complaint_case_id = ?").get(storedBeforePrepare.id)).toEqual({ value: 0 });
    database.close();
  });

  it("never reopens prompt-upgrade or failed analysis records that contain a submit attempt", () => {
    const { database, repository } = createRepository();
    const promptUpgrade = discover(repository, "prompt-upgrade-with-attempt");
    recordCandidate(repository, promptUpgrade.id);
    repository.prepare(promptUpgrade.id);
    database.prepare(`UPDATE complaint_cases SET state = 'manual_action_required', complaint_type = NULL,
      fact_code = NULL, fact_description = NULL, description = NULL WHERE id = ?`).run(promptUpgrade.id);
    expect(repository.reopenForPromptUpgrade(promptUpgrade.id, "p2")).toMatchObject({
      state: "manual_action_required",
      promptVersion: "p1",
    });

    const failed = discover(repository, "failed-with-attempt");
    recordCandidate(repository, failed.id);
    repository.prepare(failed.id);
    database.prepare(`UPDATE complaint_cases SET state = 'failed', complaint_type = NULL,
      fact_code = NULL, fact_description = NULL, description = NULL WHERE id = ?`).run(failed.id);
    expect(repository.reopenFailedAnalysis(failed.id)).toMatchObject({ state: "failed" });
    database.close();
  });
  it("lists complaint cases newest first and reports an operator-safe status summary", () => {
    const { database, repository } = createRepository();
    const noComplaint = discover(repository, "list-no-complaint");
    repository.finalizeNoComplaint(noComplaint.id, 0, "没有可核对依据", { reviewStillReplyable: true });
    const operatorCase = discover(repository, "list-manual");
    repository.markManualActionRequired(operatorCase.id, "manual_required");

    expect(repository.list()).toHaveLength(2);
    expect(repository.statusSummary()).toMatchObject({ total: 2, noComplaint: 1, manualActionRequired: 1, unresolved: 1 });
    database.close();
  });

  it("reports upheld and rejected complaint outcomes as separate non-zero totals", () => {
    const { database, repository } = createRepository();
    const advanceToUnderReview = (sourceKey: string) => {
      const discovered = discover(repository, sourceKey);
      recordCandidate(repository, discovered.id);
      repository.prepare(discovered.id);
      repository.markAttemptClickStarted(discovered.id);
      repository.markAttemptClickFinished(discovered.id);
      repository.confirmSubmitted(discovered.id, { platformCaseId: `CASE-${sourceKey}` });
      return repository.markUnderReview(discovered.id);
    };

    const upheld = advanceToUnderReview("summary-upheld");
    repository.resolveUpheld(upheld.id);
    const rejected = advanceToUnderReview("summary-rejected");
    repository.resolveRejected(rejected.id, { reviewStillReplyable: true });

    expect(repository.statusSummary()).toMatchObject({
      total: 2,
      submitted: 2,
      upheld: 1,
      rejected: 1,
      unresolved: 0,
    });
    database.close();
  });

  it("prunes only expired resolved cases and keeps unresolved or uncertain complaint records", () => {
    const { database, repository } = createRepository();
    const staleNotActionable = discover(repository, "retention-not-actionable");
    repository.finalizeNoComplaint(staleNotActionable.id, 0, "没有可核对依据", { reviewStillReplyable: false });

    const staleSubmitted = discover(repository, "retention-submitted");
    recordCandidate(repository, staleSubmitted.id);
    repository.prepare(staleSubmitted.id);
    repository.markAttemptClickStarted(staleSubmitted.id);
    repository.markAttemptClickFinished(staleSubmitted.id);
    repository.confirmSubmitted(staleSubmitted.id, { platformCaseId: "CASE-RETENTION" });
    repository.markUnderReview(staleSubmitted.id);
    repository.resolveUpheld(staleSubmitted.id);

    const uncertain = discover(repository, "retention-uncertain");
    recordCandidate(repository, uncertain.id);
    repository.prepare(uncertain.id);
    repository.markAttemptClickStarted(uncertain.id);
    repository.markSubmissionUncertain(uncertain.id, "submission_uncertain");

    const old = "2025-12-01T00:00:00.000Z";
    const auditOnlyOld = "2026-04-15T00:00:00.000Z";
    database.prepare("UPDATE complaint_cases SET updated_at = ? WHERE id IN (?, ?)")
      .run(old, staleNotActionable.id, uncertain.id);
    database.prepare("UPDATE complaint_cases SET updated_at = ? WHERE id = ?")
      .run(auditOnlyOld, staleSubmitted.id);
    database.prepare("UPDATE complaint_attempts SET updated_at = ? WHERE complaint_case_id = ?")
      .run(auditOnlyOld, staleSubmitted.id);
    database.prepare("UPDATE complaint_events SET created_at = ?").run(old);

    const now = new Date("2026-07-17T00:00:00.000Z");
    expect(repository.pruneOlderThan(90, now)).toEqual({ cases: 1, attempts: 0 });
    expect(repository.get(staleNotActionable.id)).toBeNull();
    expect(repository.get(staleSubmitted.id)).not.toBeNull();
    expect(repository.get(uncertain.id)).toMatchObject({ state: "submission_uncertain" });

    expect(repository.pruneOlderThan(180, new Date("2026-11-01T00:00:00.000Z"))).toEqual({ cases: 1, attempts: 1 });
    expect(repository.get(staleSubmitted.id)).toBeNull();
    expect(repository.get(uncertain.id)).toMatchObject({ state: "submission_uncertain" });
    database.close();
  });

  it("atomically locks an evaluation before any analysis and releases it only after no-complaint is finalized", () => {
    const { database, repository } = createRepository();
    const discovered = discover(repository, "review-preanalysis");
    expect(discovered.state).toBe("discovered");
    expect(discovered).toMatchObject({ reviewId: "review-id-review-preanalysis", canonicalizerVersion: "canonical-v1", promptVersion: "p1", ruleVersion: "r1", mappingVersion: "m1", visualVersion: "visual-v1", platformMappingVersion: "platform-v1", modelVersion: "model-v1" });
    expect(() => new ReviewActionGate(database).acquire("primary", "review-preanalysis", "reply")).toThrow();
    const noComplaint = repository.finalizeNoComplaint(discovered.id, 0, "无可核对依据", { reviewStillReplyable: true });
    expect(noComplaint.state).toBe("no_complaint");
    expect(new ReviewActionGate(database).acquire("primary", "review-preanalysis", "reply").actionKind).toBe("reply");
    database.close();
  });

  it("is idempotent per source key and writes only controlled analysis fields", () => {
    const { database, repository } = createRepository();
    discover(repository, "review-1");
    const first = recordCandidate(repository, discover(repository, "review-1").id);
    const second = repository.recordValidatedCandidate(first.id, candidate as Exclude<typeof candidate, { decision: "no_complaint" }>);
    expect(second.id).toBe(first.id);
    expect(repository.listEvents(first.id)).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "candidate_recorded" })]));
    expect(JSON.stringify(repository.get(first.id))).not.toContain("apiKey");
    database.close();
  });

  it("takes the complaint action lock before preparation and blocks a reply action", () => {
    const { database, repository } = createRepository();
    discover(repository, "review-2");
    const created = recordCandidate(repository, discover(repository, "review-2").id);
    const prepared = repository.prepare(created.id);
    expect(prepared.state).toBe("prepared");
    expect(() => new ReviewActionGate(database).acquire("primary", "review-2", "reply")).toThrow(/处理动作|处理/);
    database.close();
  });

  it("refuses a complaint when a reply already owns the evaluation", () => {
    const { database, repository } = createRepository();
    new ReviewActionGate(database).acquire("primary", "review-3", "reply");
    expect(() => discover(repository, "review-3")).toThrow(/回复动作|回复/);
    database.close();
  });

  it("records no-complaint without an action lock and allows the normal reply path", () => {
    const { database, repository } = createRepository();
    const source = discover(repository, "review-4");
    const result = repository.finalizeNoComplaint(source.id, 0, "没有依据", { reviewStillReplyable: true });
    expect(result.state).toBe("no_complaint");
    expect(new ReviewActionGate(database).acquire("primary", "review-4", "reply").actionKind).toBe("reply");
    database.close();
  });

  it("does not permit analyzed complaint data to be persisted before discovery has obtained a complaint lock", () => {
    const { database, repository } = createRepository();
    expect(() => repository.recordValidatedCandidate("unlocked", candidate as Exclude<typeof candidate, { decision: "no_complaint" }>)).toThrow(/先创建并锁定/);
    database.close();
  });

  it("preserves the complaint lock through submitted and under-review states and records immutable attempt checkpoints", () => {
    const { database, repository } = createRepository();
    const discovered = discover(repository, "checkpoint-case");
    recordCandidate(repository, discovered.id);
    repository.prepare(discovered.id);
    const clickStarted = repository.markAttemptClickStarted(discovered.id);
    expect(clickStarted.state).toBe("submitting");
    const clicked = repository.markAttemptClickFinished(discovered.id);
    expect(clicked.state).toBe("submitting");
    const submitted = repository.confirmSubmitted(discovered.id, { platformCaseId: "CASE-001", detailUrl: "https://myseller.taobao.com/case/001?secret=1#fragment" });
    expect(submitted.state).toBe("submitted");
    expect(repository.markUnderReview(discovered.id).state).toBe("under_review");
    expect(() => new ReviewActionGate(database).acquire("primary", "checkpoint-case", "reply")).toThrow();
    expect(() => repository.markAttemptClickStarted(discovered.id)).toThrow(/检查点/);
    database.close();
  });

  it("rejects raw PII in persisted quote, reason, and audit data", () => {
    const { database, repository } = createRepository();
    discover(repository, "private-case");
    expect(() => repository.recordValidatedCandidate(discover(repository, "private-case").id, { ...(candidate as Exclude<typeof candidate, { decision: "no_complaint" }>), quote: "电话13800138000" })).toThrow(/脱敏/);
    expect(() => repository.finalizeNoComplaint(discover(repository, "private-case-2").id, 0, "地址上海市浦东新区世纪大道100号", { reviewStillReplyable: true })).toThrow(/未脱敏/);
    database.close();
  });

  it("rejects arbitrary platform URLs and makes a click-start crash permanently uncertain", () => {
    const { database, repository } = createRepository();
    const discovered = discover(repository, "crash-case");
    recordCandidate(repository, discovered.id);
    repository.prepare(discovered.id);
    repository.markAttemptClickStarted(discovered.id);
    expect(() => repository.confirmSubmitted(discovered.id, { platformCaseId: "C", detailUrl: "https://evil.example/path" })).toThrow(/标识无效/);
    expect(repository.recoverInterruptedAttempts()).toBe(1);
    expect(repository.get(discovered.id)?.state).toBe("submission_uncertain");
    expect(() => repository.markFailed(discovered.id, "network")).toThrow(/当前不能转换/);
    database.close();
  });

  it("confirms submission when the platform exposes only one stable case identifier", () => {
    const { database, repository } = createRepository();
    const discovered = discover(repository, "case-id-only");
    recordCandidate(repository, discovered.id);
    repository.prepare(discovered.id);
    repository.markAttemptClickStarted(discovered.id);
    repository.markAttemptClickFinished(discovered.id);

    expect(repository.confirmSubmitted(discovered.id, { platformCaseId: "CASE-ONLY" })).toMatchObject({ state: "submitted" });
    database.close();
  });
});
