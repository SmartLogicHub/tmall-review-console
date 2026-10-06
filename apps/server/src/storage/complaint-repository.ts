import { randomUUID } from "node:crypto";
import { buildComplaintDescription, complaintCandidateIdentityDigest, complaintConfirmationIdentityDigest, COMPLAINT_TYPES, containsPotentialRawPii, hasRedactionProvenance, hasValidComplaintConfirmationCombination, type ComplaintEligibilityFacts, type ComplaintModelResult, type ComplaintTypeCode, type FactCode, type ValidComplaintCandidate } from "../complaints/complaint-domain";
import type { AppDatabase } from "./database";

export type ComplaintCaseState =
  | "discovered" | "analyzing" | "no_complaint" | "prepared" | "submitting" | "submitted"
  | "under_review" | "upheld" | "rejected" | "closed" | "not_actionable"
  | "submission_uncertain" | "retry_wait" | "manual_action_required" | "failed";

export interface ComplaintCaseRecord {
  id: string;
  storeId: string;
  sourceKey: string;
  state: ComplaintCaseState;
  complaintType: ComplaintTypeCode | null;
  factCode: FactCode | null;
  quote: string | null;
  confidence: number | null;
  reason: string | null;
  description: string | null;
  actionLockVersion: number | null;
  errorCode: string | null;
  reviewId: string | null;
  contentHash: string | null;
  canonicalizerVersion: string | null;
  imagePairs: Array<{ imageId: string; imageHash: string }>;
  visualVersion: string | null;
  platformMappingVersion: string | null;
  modelVersion: string | null;
  phase: "initial" | "followup" | null;
  promptVersion: string | null;
  ruleVersion: string | null;
  mappingVersion: string | null;
  factDescription: string | null;
  validationFacts: Record<string, unknown> | null;
  modelResult: Record<string, unknown> | null;
  descriptionBuilderVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComplaintDiscoveryInput {
  reviewId: string;
  contentHash: string;
  canonicalizerVersion: string;
  phase: "initial" | "followup";
  imagePairs: Array<{ imageId: string; imageHash: string }>;
  promptVersion: string;
  ruleVersion: string;
  mappingVersion: string;
  visualVersion: string;
  platformMappingVersion: string;
  modelVersion: string;
}

const SAFE_ERROR_CODES = new Set([
  "configuration", "network", "timeout", "model_contract", "internal", "platform_changed", "platform_already_handled", "manual_required", "submission_uncertain",
]);

export interface ComplaintEventRecord {
  id: string;
  eventType: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ComplaintReconciliationSnapshot {
  outcome: "received" | "under_review" | "upheld" | "rejected" | "not_received" | "unknown";
  platformCaseId?: string;
  detailPath?: string;
  doubleConfirmedNotReceived?: boolean;
  reviewStillReplyable?: boolean;
  observedAt: Date;
}

type CaseRow = {
  id: string; store_id: string; source_key: string; state: ComplaintCaseState;
  review_id: string | null; content_hash: string | null; canonicalizer_version: string | null; review_phase: "initial" | "followup" | null; image_pairs_json: string; prompt_version: string | null; rule_version: string | null; mapping_version: string | null; visual_version: string | null; platform_mapping_version: string | null; model_version: string | null; fact_description: string | null; validation_facts_json: string | null; model_result_json: string | null; description_builder_version: string | null;
  complaint_type: ComplaintTypeCode | null; fact_code: FactCode | null; quote_text: string | null;
  confidence: number | null; reason: string | null; description: string | null;
  action_lock_version: number | null; error_code: string | null; created_at: string; updated_at: string;
};

export class ComplaintRepository {
  constructor(private readonly database: AppDatabase) {
  }

  recordAnalysisInvocation(caseId: string, pass: "primary" | "independent_review" | "adjudication", result: ComplaintModelResult, invocationId: string): void {
    if (!/^[0-9a-f-]{36}$/iu.test(invocationId)) throw new Error("投诉分析调用标识无效");
    this.database.transaction(() => {
      const current = this.get(caseId);
      if (!current || !["discovered", "analyzing"].includes(current.state)) throw new Error("投诉分析调用没有可用案件");
      this.assertFrozenComplaintLock(current);
      this.database.prepare(`INSERT INTO complaint_analysis_invocations(id, complaint_case_id, analysis_pass, result_digest, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(invocationId, caseId, pass, complaintCandidateIdentityDigest(result), new Date().toISOString());
    }).immediate();
  }

  /** Must be called before any complaint AI request. The lock and case are one IMMEDIATE transaction. */
  discover(storeId: string, sourceKey: string, input: ComplaintDiscoveryInput): ComplaintCaseRecord {
    if (!/^[a-f0-9]{64}$/i.test(input.contentHash) || !input.reviewId.trim() || ![input.canonicalizerVersion, input.promptVersion, input.ruleVersion, input.mappingVersion, input.visualVersion, input.platformMappingVersion, input.modelVersion].every((item) => item.trim()) || !input.imagePairs.every((item) => item.imageId && item.imageHash)) {
      throw new Error("投诉案件冻结信息无效");
    }
    return this.database.transaction(() => {
      const existing = this.findBySource(storeId, sourceKey);
      if (existing) return existing;
      const terminal = this.database.prepare("SELECT 1 FROM review_action_tombstones WHERE store_id = ? AND source_key = ?").get(storeId, sourceKey);
      if (terminal) throw new Error("该评价已有终态外部处理记录");
      const replyAttempt = this.database.prepare(`SELECT 1 FROM reply_attempts WHERE source_key = ? AND state IN ('pending','submitting','sent','submission_uncertain')`).get(sourceKey);
      const lock = this.database.prepare("SELECT action_kind, lock_version FROM review_action_locks WHERE store_id = ? AND source_key = ?").get(storeId, sourceKey) as { action_kind: string; lock_version: number } | undefined;
      if (replyAttempt || (lock && lock.action_kind !== "complaint")) throw new Error("该评价已由回复动作占用");
      const now = new Date().toISOString();
      if (!lock) this.database.prepare(`INSERT INTO review_action_locks(store_id, source_key, action_kind, lock_version, created_at, updated_at) VALUES (?, ?, 'complaint', 1, ?, ?)`).run(storeId, sourceKey, now, now);
      const id = randomUUID();
      this.database.prepare(`
        INSERT INTO complaint_cases(id, store_id, source_key, state, review_id, content_hash, canonicalizer_version, review_phase, image_hashes_json, image_pairs_json, prompt_version, rule_version, mapping_version, visual_version, platform_mapping_version, model_version, action_lock_version, created_at, updated_at)
        VALUES (?, ?, ?, 'discovered', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, storeId, sourceKey, input.reviewId, input.contentHash, input.canonicalizerVersion, input.phase, JSON.stringify(input.imagePairs.map((item) => item.imageHash)), JSON.stringify(input.imagePairs), input.promptVersion, input.ruleVersion, input.mappingVersion, input.visualVersion, input.platformMappingVersion, input.modelVersion, lock?.lock_version ?? 1, now, now);
      this.insertEvent(id, "discovered", { phase: input.phase, promptVersion: input.promptVersion, ruleVersion: input.ruleVersion, mappingVersion: input.mappingVersion }, now);
      return this.get(id)!;
    }).immediate();
  }

  finalizeNoComplaint(caseId: string, confidence: number, reason: string, input: { reviewStillReplyable: boolean }): ComplaintCaseRecord {
    if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100 || !reason.trim() || Array.from(reason).length > 200) throw new Error("不投诉分析结果无效");
    return this.database.transaction(() => {
      const current = this.get(caseId);
      if (!current || !["discovered", "analyzing"].includes(current.state)) throw new Error("投诉状态当前不能转换");
      this.assertFrozenComplaintLock(current);
      const now = new Date().toISOString();
      const next = input.reviewStillReplyable ? "no_complaint" : "not_actionable";
      const changed = this.database.prepare(`UPDATE complaint_cases SET state = ?, confidence = ?, reason = ?, updated_at = ? WHERE id = ? AND action_lock_version = ? AND state IN ('discovered','analyzing')`)
        .run(next, confidence, sanitizeSafeText(reason), now, caseId, current.actionLockVersion);
      if (changed.changes !== 1) throw new Error("投诉状态已发生变化");
      if (input.reviewStillReplyable) {
        const lock = this.database.prepare(`UPDATE review_action_locks SET action_kind = 'reply', lock_version = lock_version + 1, updated_at = ? WHERE store_id = ? AND source_key = ? AND action_kind = 'complaint' AND lock_version = ?`).run(now, current.storeId, current.sourceKey, current.actionLockVersion);
        if (lock.changes !== 1) throw new Error("投诉动作锁已发生变化");
      } else {
        const removed = this.database.prepare("DELETE FROM review_action_locks WHERE store_id = ? AND source_key = ? AND action_kind = 'complaint' AND lock_version = ?").run(current.storeId, current.sourceKey, current.actionLockVersion);
        if (removed.changes !== 1) throw new Error("投诉动作锁已发生变化");
        this.database.prepare("INSERT OR IGNORE INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at) VALUES (?, ?, 'complaint_not_actionable', ?)").run(current.storeId, current.sourceKey, now);
      }
      this.insertEvent(caseId, next, { confidence }, now);
      return this.get(caseId)!;
    }).immediate();
  }

  recordValidatedCandidate(caseId: string, candidate: ValidComplaintCandidate): ComplaintCaseRecord {
    const existing = this.get(caseId);
    if (!existing) throw new Error("投诉分析前必须先创建并锁定投诉案件");
    if (!["discovered", "analyzing"].includes(existing.state) || existing.complaintType !== null) return existing;
    if (!candidate.analysisScope.assertCandidate(candidate) || !hasRedactionProvenance(candidate.redaction) || !candidate.redaction.analysisText.includes(candidate.quote) || containsPotentialRawPii(candidate.quote)) throw new Error("投诉候选必须来自可验证的脱敏文本");
    if (!Number.isInteger(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 100 || !candidate.reason.trim() || Array.from(candidate.reason).length > 200) throw new Error("投诉候选审核字段无效");
    const complaintType = COMPLAINT_TYPES.find((item) => item.code === candidate.complaintType.code);
    if (!complaintType || complaintType.factCode !== candidate.complaintType.factCode || complaintType.factDescription !== candidate.complaintType.factDescription) throw new Error("投诉候选类型未通过固定注册表校验");
    const model = candidate.modelResult;
    const exactQuote = typeof model.quoteStart === "number" && typeof model.quoteEnd === "number"
      ? Array.from(candidate.redaction.analysisText).slice(model.quoteStart, model.quoteEnd).join("") : "";
    if (model.decision !== "complaint_candidate" || model.complaintType !== complaintType.code || model.factCode !== complaintType.factCode || model.confidence !== candidate.confidence || exactQuote !== candidate.quote || !hasValidComplaintConfirmationCombination(candidate.validationFacts, model, candidate.redaction.analysisText)
      || !this.hasPersistedInvocationCombination(caseId, candidate.validationFacts, model)) {
      throw new Error("投诉候选冻结证明不完整或已被修改");
    }
    const now = new Date().toISOString();
    sanitizeSafeText(candidate.quote);
    const description = buildComplaintDescription({ ...candidate, complaintType });
    if (Array.from(description).length > 1000) throw new Error("投诉描述长度无效");
    return this.database.transaction(() => {
        const lock = this.database.prepare("SELECT action_kind, lock_version FROM review_action_locks WHERE store_id = ? AND source_key = ?").get(existing.storeId, existing.sourceKey) as { action_kind: string; lock_version: number } | undefined;
        if (!lock || lock.action_kind !== "complaint" || lock.lock_version !== existing.actionLockVersion) throw new Error("投诉动作锁已发生变化");
        const changed = this.database.prepare(`
          UPDATE complaint_cases SET complaint_type = ?, fact_code = ?, fact_description = ?, quote_text = ?, confidence = ?,
            reason = ?, description = ?, validation_facts_json = ?, model_result_json = ?, description_builder_version = '2026-07-14-v1', updated_at = ?
          WHERE id = ? AND action_lock_version = ? AND state IN ('discovered','analyzing')
        `).run(complaintType.code, complaintType.factCode, complaintType.factDescription, candidate.quote, candidate.confidence, sanitizeSafeText(candidate.reason), description, JSON.stringify(candidate.validationFacts), JSON.stringify(candidate.modelResult), now, existing.id, existing.actionLockVersion);
        if (changed.changes !== 1) throw new Error("投诉状态已发生变化");
        this.insertEvent(existing.id, "candidate_recorded", { complaintType: complaintType.code, factCode: complaintType.factCode, confidence: candidate.confidence }, now);
        return this.get(existing.id)!;
    }).immediate();
  }

  private hasPersistedInvocationCombination(caseId: string, facts: ComplaintEligibilityFacts, result: ComplaintModelResult): boolean {
    const matches = (confirmation: ComplaintEligibilityFacts["primaryConfirmation"], pass: string) => {
      if (!confirmation || confirmation.pass !== pass) return false;
      if (confirmation.complaintType !== result.complaintType || confirmation.factCode !== result.factCode) return false;
      return Boolean(this.database.prepare(`SELECT 1 FROM complaint_analysis_invocations
        WHERE id = ? AND complaint_case_id = ? AND analysis_pass = ? AND result_digest = ? LIMIT 1`)
        .get(confirmation.sourceInvocationId, caseId, pass, complaintConfirmationIdentityDigest(confirmation)));
    };
    const primary = matches(facts.primaryConfirmation, "primary");
    const independent = matches(facts.independentConfirmation, "independent_review");
    const adjudication = matches(facts.adjudicationConfirmation, "adjudication");
    return primary || (adjudication && independent);
  }

  recordNoComplaint(storeId: string, sourceKey: string, confidence: number, reason: string): { case: ComplaintCaseRecord; created: boolean } {
    const existing = this.findBySource(storeId, sourceKey);
    if (!existing) throw new Error("投诉分析前必须先创建并锁定投诉案件");
    if (existing.state === "no_complaint") return { case: existing, created: false };
    return { case: this.finalizeNoComplaint(existing.id, confidence, reason, { reviewStillReplyable: true }), created: true };
  }

  prepare(caseId: string): ComplaintCaseRecord {
    return this.database.transaction(() => {
      const current = this.get(caseId);
      if (!current) throw new Error("投诉记录不存在");
      if (current.state === "prepared") return current;
      if (!(["discovered", "analyzing"] as string[]).includes(current.state) || !current.complaintType || !current.factCode || !current.quote || !current.description || current.actionLockVersion === null) {
        throw new Error("投诉必须先完成经过验证的类型、事实、脱敏引用和描述");
      }
      this.assertFrozenComplaintLock(current);
      const now = new Date().toISOString();
      const changed = this.database.prepare(`
        UPDATE complaint_cases SET state = 'prepared', prepared_at = ?, updated_at = ?
        WHERE id = ? AND action_lock_version = ? AND state IN ('discovered','analyzing')
      `).run(now, now, caseId, current.actionLockVersion);
      if (changed.changes !== 1) throw new Error("投诉状态已发生变化");
      this.database.prepare(`
        INSERT INTO complaint_attempts(id, complaint_case_id, store_id, source_key, state, action_lock_version, intent_saved_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'intent_saved', ?, ?, ?, ?)
      `).run(randomUUID(), current.id, current.storeId, current.sourceKey, current.actionLockVersion, now, now, now);
      this.insertEvent(caseId, "prepared", { complaintType: current.complaintType, factCode: current.factCode }, now);
      return this.get(caseId)!;
    }).immediate();
  }

  /** Atomically freezes a validated candidate and creates its pre-submit intent. */
  prepareValidatedCandidate(caseId: string, candidate: ValidComplaintCandidate): ComplaintCaseRecord {
    return this.database.transaction(() => {
      const current = this.get(caseId);
      if (!current) throw new Error("投诉记录不存在");
      if (current.complaintType !== null || current.modelResult !== null || current.validationFacts !== null) {
        if (JSON.stringify(current.modelResult) !== JSON.stringify(candidate.modelResult)
          || JSON.stringify(current.validationFacts) !== JSON.stringify(candidate.validationFacts)
          || current.complaintType !== candidate.complaintType.code
          || current.quote !== candidate.quote) {
          throw new Error("已准备投诉候选与本次审核结果不一致");
        }
        if (current.state !== "prepared") return this.prepare(current.id);
        const attempt = this.database.prepare("SELECT state FROM complaint_attempts WHERE complaint_case_id = ?").get(caseId) as { state: string } | undefined;
        if (attempt?.state !== "intent_saved") throw new Error("投诉准备检查点不完整");
        return current;
      }
      const recorded = this.recordValidatedCandidate(caseId, candidate);
      return this.prepare(recorded.id);
    }).immediate();
  }

  /** Cancels only an intent that has never reached the final-click checkpoint. */
  rollbackPreparedBeforeSubmit(caseId: string): ComplaintCaseRecord {
    return this.database.transaction(() => {
      const current = this.get(caseId);
      if (!current || current.state !== "prepared") throw new Error("投诉当前不在可暂停回滚状态");
      this.assertFrozenComplaintLock(current);
      const attempt = this.database.prepare("SELECT state FROM complaint_attempts WHERE complaint_case_id = ?").get(caseId) as { state: string } | undefined;
      if (attempt?.state !== "intent_saved") throw new Error("投诉已进入点击阶段，不能回滚");
      const removed = this.database.prepare("DELETE FROM complaint_attempts WHERE complaint_case_id = ? AND state = 'intent_saved'").run(caseId);
      if (removed.changes !== 1) throw new Error("投诉准备检查点已发生变化");
      const now = new Date().toISOString();
      const changed = this.database.prepare(`UPDATE complaint_cases SET state = 'discovered', complaint_type = NULL, fact_code = NULL,
        fact_description = NULL, quote_text = NULL, confidence = NULL, reason = NULL, description = NULL,
        validation_facts_json = NULL, model_result_json = NULL, description_builder_version = NULL,
        prepared_at = NULL, error_code = NULL, updated_at = ?
        WHERE id = ? AND state = 'prepared' AND action_lock_version = ?`)
        .run(now, caseId, current.actionLockVersion);
      if (changed.changes !== 1) throw new Error("投诉准备状态已发生变化");
      this.insertEvent(caseId, "prepared_rolled_back_for_pause", {}, now);
      return this.get(caseId)!;
    }).immediate();
  }

  markManualActionRequired(caseId: string, code: string): ComplaintCaseRecord {
    // A provider can fail before it transitions the freshly discovered case to
    // analysing. That is still an operator decision, not a reason to unlock
    // the review and let a reply race ahead of the complaint check.
    return this.transition(caseId, ["discovered", "analyzing", "prepared"], "manual_action_required", code);
  }

  markFailed(caseId: string, code: string): ComplaintCaseRecord {
    return this.transition(caseId, ["discovered", "analyzing", "prepared", "retry_wait"], "failed", code);
  }

  markPlatformAlreadyHandled(caseId: string): ComplaintCaseRecord {
    return this.database.transaction(() => {
      const current = this.get(caseId);
      if (!current || !["discovered", "prepared", "submitting"].includes(current.state)) {
        throw new Error("投诉当前不能标记为平台已处理");
      }
      this.assertFrozenComplaintLock(current);
      const attempt = this.database.prepare("SELECT state FROM complaint_attempts WHERE complaint_case_id = ?").get(caseId) as { state: string } | undefined;
      const now = new Date().toISOString();
      if (current.state === "discovered") {
        if (attempt) throw new Error("投诉发现状态不应存在提交检查点");
      } else if (current.state === "prepared") {
        if (attempt?.state !== "intent_saved") throw new Error("投诉准备检查点已发生变化");
        const removed = this.database.prepare("DELETE FROM complaint_attempts WHERE complaint_case_id = ? AND state = 'intent_saved'").run(caseId);
        if (removed.changes !== 1) throw new Error("投诉准备检查点已发生变化");
      } else {
        if (attempt?.state !== "click_started") throw new Error("投诉点击检查点已发生变化");
        const updatedAttempt = this.database.prepare(`
          UPDATE complaint_attempts
          SET state = 'failed', error_code = 'platform_already_handled',
              error_message = '平台已判定该评价，本次投诉未受理',
              result_observed_at = ?, updated_at = ?
          WHERE complaint_case_id = ? AND state = 'click_started'
        `).run(now, now, caseId);
        if (updatedAttempt.changes !== 1) throw new Error("投诉点击检查点已发生变化");
      }
      const changed = this.database.prepare(`
        UPDATE complaint_cases SET state = 'not_actionable', error_code = 'platform_already_handled', updated_at = ?
        WHERE id = ? AND state = ? AND action_lock_version = ?
      `).run(now, caseId, current.state, current.actionLockVersion);
      if (changed.changes !== 1) throw new Error("投诉状态已发生变化");
      this.removeComplaintLockToTombstone(current, "complaint_not_actionable", now);
      this.insertEvent(caseId, "platform_already_handled", {
        code: "platform_already_handled",
        submitClickStarted: current.state === "submitting",
      }, now);
      return this.get(caseId)!;
    }).immediate();
  }

  markSubmissionUncertain(caseId: string, code: string): ComplaintCaseRecord {
    if (!SAFE_ERROR_CODES.has(code)) throw new Error("投诉错误代码不受支持");
    return this.database.transaction(() => {
      const current = this.get(caseId);
      if (!current || !["prepared", "submitting"].includes(current.state)) throw new Error("投诉状态当前不能转换");
      this.assertFrozenComplaintLock(current);
      const now = new Date().toISOString();
      const changed = this.database.prepare("UPDATE complaint_cases SET state = 'submission_uncertain', error_code = ?, updated_at = ? WHERE id = ? AND state = ? AND action_lock_version = ?")
        .run(code, now, caseId, current.state, current.actionLockVersion);
      if (changed.changes !== 1) throw new Error("投诉状态已发生变化");
      const attempt = this.database.prepare("UPDATE complaint_attempts SET state = 'submission_uncertain', error_code = ?, result_observed_at = ?, updated_at = ? WHERE complaint_case_id = ? AND state IN ('intent_saved','click_started','click_finished')")
        .run(code, now, now, caseId);
      if (attempt.changes !== 1) throw new Error("投诉提交检查点已发生变化");
      this.insertEvent(caseId, "submission_uncertain", { code }, now);
      return this.get(caseId)!;
    }).immediate();
  }

  markRetryWait(caseId: string, code: string): ComplaintCaseRecord {
    return this.transition(caseId, ["discovered", "analyzing", "prepared"], "retry_wait", code);
  }

  /** A corrected complaint prompt may retry a pre-submit analysis failure once.
   * Submitted/prepared candidates are deliberately never reopened. */
  reopenForPromptUpgrade(caseId: string, promptVersion: string): ComplaintCaseRecord {
    if (!promptVersion.trim()) throw new Error("投诉提示词版本无效");
    return this.database.transaction(() => {
      const current = this.get(caseId);
      if (!current) throw new Error("投诉记录不存在");
      if (current.state !== "manual_action_required" || current.complaintType !== null || current.factCode !== null
        || current.description !== null || current.promptVersion === promptVersion) return current;
      const attempt = this.database.prepare("SELECT 1 FROM complaint_attempts WHERE complaint_case_id = ? LIMIT 1").get(caseId);
      if (attempt) return current;
      this.assertFrozenComplaintLock(current);
      const now = new Date().toISOString();
      const changed = this.database.prepare(`UPDATE complaint_cases
        SET state = 'discovered', error_code = NULL, prompt_version = ?, updated_at = ?
        WHERE id = ? AND state = 'manual_action_required' AND complaint_type IS NULL AND fact_code IS NULL
          AND description IS NULL AND action_lock_version = ?
          AND NOT EXISTS (SELECT 1 FROM complaint_attempts WHERE complaint_case_id = ?)`)
        .run(promptVersion, now, current.id, current.actionLockVersion, current.id);
      if (changed.changes !== 1) throw new Error("投诉分析状态已发生变化");
      this.insertEvent(current.id, "analysis_prompt_upgraded", { promptVersion }, now);
      return this.get(current.id)!;
    }).immediate();
  }

  /** Reopens only a technical analysis failure that never reached preparation or submission. */
  reopenFailedAnalysis(caseId: string): ComplaintCaseRecord {
    return this.database.transaction(() => {
      const current = this.get(caseId);
      if (!current) throw new Error("投诉记录不存在");
      if (current.state !== "failed") return current;
      if (current.complaintType !== null || current.factCode !== null || current.description !== null) return current;
      const attempt = this.database.prepare("SELECT 1 FROM complaint_attempts WHERE complaint_case_id = ? LIMIT 1").get(caseId);
      if (attempt) return current;
      this.assertFrozenComplaintLock(current);
      const now = new Date().toISOString();
      const changed = this.database.prepare(`UPDATE complaint_cases SET state = 'discovered', error_code = NULL, updated_at = ?
        WHERE id = ? AND state = 'failed' AND complaint_type IS NULL AND fact_code IS NULL AND description IS NULL
          AND action_lock_version = ? AND NOT EXISTS (SELECT 1 FROM complaint_attempts WHERE complaint_case_id = ?)`)
        .run(now, current.id, current.actionLockVersion, current.id);
      if (changed.changes !== 1) throw new Error("投诉分析状态已发生变化");
      this.insertEvent(caseId, "analysis_reopened", {}, now);
      return this.get(caseId)!;
    }).immediate();
  }

  /**
   * Releases a legacy complaint-analysis hold only when screening now proves
   * the review is not a complaint candidate and no complaint type, description
   * or platform attempt has ever been created. Audit rows are retained.
   */
  releaseUnstartedAnalysisAsNoComplaint(caseId: string, reason: string): ComplaintCaseRecord | null {
    if (!reason.trim() || Array.from(reason).length > 200) throw new Error("投诉候选筛选结果无效");
    return this.database.transaction(() => {
      const current = this.get(caseId);
      if (!current) throw new Error("投诉记录不存在");
      if (!["discovered", "analyzing", "failed"].includes(current.state)
        || current.complaintType !== null
        || current.factCode !== null
        || current.description !== null) return null;
      const attempt = this.database.prepare("SELECT 1 FROM complaint_attempts WHERE complaint_case_id = ? LIMIT 1").get(caseId);
      if (attempt) return null;
      this.assertFrozenComplaintLock(current);
      const now = new Date().toISOString();
      const changed = this.database.prepare(`UPDATE complaint_cases
        SET state = 'no_complaint', confidence = 100, reason = ?, error_code = NULL, updated_at = ?
        WHERE id = ? AND state IN ('discovered','analyzing','failed')
          AND complaint_type IS NULL AND fact_code IS NULL AND description IS NULL
          AND action_lock_version = ?
          AND NOT EXISTS (SELECT 1 FROM complaint_attempts WHERE complaint_case_id = ?)`)
        .run(sanitizeSafeText(reason), now, current.id, current.actionLockVersion, current.id);
      if (changed.changes !== 1) throw new Error("投诉分析状态已发生变化");
      const lock = this.database.prepare(`UPDATE review_action_locks
        SET action_kind = 'reply', lock_version = lock_version + 1, updated_at = ?
        WHERE store_id = ? AND source_key = ? AND action_kind = 'complaint' AND lock_version = ?`)
        .run(now, current.storeId, current.sourceKey, current.actionLockVersion);
      if (lock.changes !== 1) throw new Error("投诉动作锁已发生变化");
      this.insertEvent(current.id, "analysis_released_by_screening", { confidence: 100 }, now);
      return this.get(current.id)!;
    }).immediate();
  }

  /**
   * Releases a legacy validated complaint intent when the current live review
   * no longer passes complaint screening and the browser submit click never
   * started.  The candidate and failed intent remain as audit evidence.
   */
  releaseUnsubmittedCandidateAsNoComplaint(caseId: string, reason: string): ComplaintCaseRecord | null {
    if (!reason.trim() || Array.from(reason).length > 200) throw new Error("投诉候选筛选结果无效");
    return this.database.transaction(() => {
      const current = this.get(caseId);
      if (!current) throw new Error("投诉记录不存在");
      if (!["prepared", "manual_action_required", "failed", "retry_wait"].includes(current.state)
        || current.complaintType === null
        || current.factCode === null
        || current.description === null) return null;
      const attempt = this.database.prepare(`
        SELECT state, click_started_at, click_finished_at, platform_case_id, platform_detail_url
        FROM complaint_attempts
        WHERE complaint_case_id = ?
      `).get(caseId) as {
        state: string;
        click_started_at: string | null;
        click_finished_at: string | null;
        platform_case_id: string | null;
        platform_detail_url: string | null;
      } | undefined;
      if (!attempt
        || !["intent_saved", "failed"].includes(attempt.state)
        || attempt.click_started_at !== null
        || attempt.click_finished_at !== null
        || attempt.platform_case_id !== null
        || attempt.platform_detail_url !== null) return null;
      this.assertFrozenComplaintLock(current);
      const now = new Date().toISOString();
      const safeReason = sanitizeSafeText(reason);
      const attemptUpdate = this.database.prepare(`
        UPDATE complaint_attempts
        SET state = 'failed', error_code = 'screened_out_by_live_review',
            error_message = ?, result_observed_at = ?, updated_at = ?
        WHERE complaint_case_id = ? AND state IN ('intent_saved','failed')
          AND click_started_at IS NULL AND click_finished_at IS NULL
          AND platform_case_id IS NULL AND platform_detail_url IS NULL
      `).run(safeReason, now, now, current.id);
      if (attemptUpdate.changes !== 1) throw new Error("投诉准备检查点已发生变化");
      const changed = this.database.prepare(`
        UPDATE complaint_cases
        SET state = 'no_complaint', confidence = 100, reason = ?,
            error_code = NULL, updated_at = ?
        WHERE id = ? AND state = ? AND action_lock_version = ?
      `).run(safeReason, now, current.id, current.state, current.actionLockVersion);
      if (changed.changes !== 1) throw new Error("投诉状态已发生变化");
      const lock = this.database.prepare(`
        UPDATE review_action_locks
        SET action_kind = 'reply', lock_version = lock_version + 1, updated_at = ?
        WHERE store_id = ? AND source_key = ?
          AND action_kind = 'complaint' AND lock_version = ?
      `).run(now, current.storeId, current.sourceKey, current.actionLockVersion);
      if (lock.changes !== 1) throw new Error("投诉动作锁已发生变化");
      this.insertEvent(current.id, "candidate_released_by_live_screening", { confidence: 100 }, now);
      return this.get(current.id)!;
    }).immediate();
  }

  recoverInterruptedAttempts(): number {
    return this.database.transaction(() => {
      const rows = this.database.prepare(`SELECT c.id FROM complaint_cases c JOIN complaint_attempts a ON a.complaint_case_id = c.id WHERE a.state IN ('click_started','click_finished') AND c.state = 'submitting'`).all() as Array<{ id: string }>;
      for (const row of rows) {
        const current = this.get(row.id)!;
        this.assertFrozenComplaintLock(current);
        const now = new Date().toISOString();
        const updated = this.database.prepare("UPDATE complaint_cases SET state = 'submission_uncertain', error_code = 'submission_uncertain', updated_at = ? WHERE id = ? AND state = 'submitting' AND action_lock_version = ?")
          .run(now, row.id, current.actionLockVersion);
        if (updated.changes !== 1) throw new Error("投诉状态已发生变化");
        const attempt = this.database.prepare("UPDATE complaint_attempts SET state = 'submission_uncertain', error_code = 'submission_uncertain', result_observed_at = ?, updated_at = ? WHERE complaint_case_id = ? AND state IN ('click_started','click_finished')")
          .run(now, now, row.id);
        if (attempt.changes !== 1) throw new Error("投诉提交检查点已发生变化");
        this.insertEvent(row.id, "submission_uncertain", { code: "submission_uncertain" }, now);
      }
      return rows.length;
    }).immediate();
  }

  resolveUpheld(caseId: string): ComplaintCaseRecord {
    return this.resolveTerminal(caseId, "upheld", "complaint_upheld");
  }

  resolveRejected(caseId: string, input: { reviewStillReplyable: boolean }): ComplaintCaseRecord {
    return this.database.transaction(() => {
      const current = this.requireState(caseId, "under_review");
      this.assertFrozenComplaintLock(current);
      const now = new Date().toISOString();
      const state = input.reviewStillReplyable ? "rejected" : "not_actionable";
      const changed = this.database.prepare("UPDATE complaint_cases SET state = ?, updated_at = ? WHERE id = ? AND state = 'under_review' AND action_lock_version = ?")
        .run(state, now, caseId, current.actionLockVersion);
      if (changed.changes !== 1) throw new Error("投诉状态已发生变化");
      if (input.reviewStillReplyable) {
        const lock = this.database.prepare("UPDATE review_action_locks SET action_kind = 'reply', lock_version = lock_version + 1, updated_at = ? WHERE store_id = ? AND source_key = ? AND action_kind = 'complaint' AND lock_version = ?")
          .run(now, current.storeId, current.sourceKey, current.actionLockVersion);
        if (lock.changes !== 1) throw new Error("投诉动作锁已发生变化");
      } else {
        this.removeComplaintLockToTombstone(current, "complaint_not_actionable", now);
      }
      this.insertEvent(caseId, state, {}, now);
      return this.get(caseId)!;
    }).immediate();
  }

  markClosed(caseId: string): ComplaintCaseRecord {
    return this.transition(caseId, ["submitted", "under_review"], "closed", "platform_changed");
  }

  reconcile(caseId: string, snapshot: ComplaintReconciliationSnapshot): ComplaintCaseRecord {
    if (snapshot.outcome === "upheld") return this.resolveUpheld(caseId);
    if (snapshot.outcome === "rejected") {
      if (typeof snapshot.reviewStillReplyable !== "boolean") throw new Error("投诉驳回后必须核实评价是否仍可回复");
      return this.resolveRejected(caseId, { reviewStillReplyable: snapshot.reviewStillReplyable });
    }
    if (snapshot.outcome === "under_review") return this.markUnderReview(caseId);
    if (snapshot.outcome === "received") {
      if (!snapshot.platformCaseId || !snapshot.detailPath) throw new Error("平台核对结果缺少稳定案件标识");
      const current = this.get(caseId);
      if (!current) throw new Error("投诉记录不存在");
      if (current.state === "submission_uncertain") return this.confirmReconciledReceived(current, snapshot);
      return current.state === "submitted" ? this.markUnderReview(caseId) : current;
    }
    if (snapshot.outcome === "not_received") {
      if (snapshot.doubleConfirmedNotReceived !== true) throw new Error("未受理结果必须经双重核对");
      return this.database.transaction(() => {
        const current = this.requireState(caseId, "submission_uncertain");
        this.assertFrozenComplaintLock(current);
        const now = snapshot.observedAt.toISOString();
        const changed = this.database.prepare("UPDATE complaint_cases SET state = 'prepared', result_observed_at = ?, updated_at = ? WHERE id = ? AND state = 'submission_uncertain' AND action_lock_version = ?")
          .run(now, now, caseId, current.actionLockVersion);
        if (changed.changes !== 1) throw new Error("投诉状态已发生变化");
        this.insertEvent(caseId, "reconciled_not_received", {}, now);
        return this.get(caseId)!;
      }).immediate();
    }
    if (snapshot.outcome === "unknown") {
      const current = this.get(caseId);
      if (current?.state === "submission_uncertain") return current;
    }
    return this.markSubmissionUncertain(caseId, "submission_uncertain");
  }

  /**
   * Reconciles authoritative status text observed on the review row itself.
   * This path deliberately accepts historical local states such as `failed`
   * and `manual_action_required`: the platform is the source of truth and a
   * local pre-submit failure must never cause the same review to be filed
   * again. No complaint content or browser data is persisted here.
   */
  reconcileObservedPlatformComplaint(
    caseId: string,
    outcome: "complaint_record" | "complaint_under_review" | "complaint_upheld" | "complaint_rejected",
    observedAt = new Date(),
  ): ComplaintCaseRecord {
    if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
      throw new Error("平台投诉状态核对时间无效");
    }
    return this.database.transaction(() => {
      let current = this.get(caseId);
      if (!current) throw new Error("投诉记录不存在");
      if (current.state === "upheld" || (current.state === "under_review" && outcome !== "complaint_upheld" && outcome !== "complaint_rejected")) {
        return current;
      }

      const terminal = this.database.prepare("SELECT terminal_action FROM review_action_tombstones WHERE store_id = ? AND source_key = ?")
        .get(current.storeId, current.sourceKey) as { terminal_action: string } | undefined;
      if (terminal) return current;

      const protectedReply = this.database.prepare(`
        SELECT 1 FROM reply_attempts
        WHERE source_key = ? AND state IN ('pending','submitting','sent','submission_uncertain')
        LIMIT 1
      `).get(current.sourceKey);
      if (protectedReply) throw new Error("平台投诉状态与已提交回复记录冲突");

      const now = observedAt.toISOString();
      const lock = this.database.prepare("SELECT action_kind, lock_version FROM review_action_locks WHERE store_id = ? AND source_key = ?")
        .get(current.storeId, current.sourceKey) as { action_kind: string; lock_version: number } | undefined;
      let lockVersion: number;
      if (!lock) {
        lockVersion = Math.max(1, current.actionLockVersion ?? 1);
        this.database.prepare(`
          INSERT INTO review_action_locks(store_id, source_key, action_kind, lock_version, created_at, updated_at)
          VALUES (?, ?, 'complaint', ?, ?, ?)
        `).run(current.storeId, current.sourceKey, lockVersion, now, now);
      } else if (lock.action_kind === "complaint") {
        lockVersion = lock.lock_version;
      } else {
        lockVersion = lock.lock_version + 1;
        const changed = this.database.prepare(`
          UPDATE review_action_locks
          SET action_kind = 'complaint', lock_version = ?, updated_at = ?
          WHERE store_id = ? AND source_key = ? AND action_kind = ? AND lock_version = ?
        `).run(lockVersion, now, current.storeId, current.sourceKey, lock.action_kind, lock.lock_version);
        if (changed.changes !== 1) throw new Error("平台投诉状态核对时动作锁已变化");
      }

      const state: ComplaintCaseState = outcome === "complaint_upheld"
        ? "upheld"
        : outcome === "complaint_rejected"
          ? "rejected"
          : "under_review";
      const updated = this.database.prepare(`
        UPDATE complaint_cases
        SET state = ?, action_lock_version = ?, error_code = 'platform_already_handled',
            result_observed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(state, lockVersion, now, now, caseId);
      if (updated.changes !== 1) throw new Error("平台投诉状态核对失败");
      current = this.get(caseId)!;

      if (state === "upheld" || state === "rejected") {
        const terminalAction = state === "upheld" ? "complaint_upheld" : "complaint_rejected";
        this.removeComplaintLockToTombstone(current, terminalAction, now);
      }
      this.insertEvent(caseId, "platform_status_reconciled", { outcome, state }, now);
      return this.get(caseId)!;
    }).immediate();
  }

  /** Checkpoint is saved before a browser driver would be allowed to click. */
  markAttemptClickStarted(caseId: string): ComplaintCaseRecord {
    return this.database.transaction(() => {
      const current = this.requireState(caseId, "prepared");
      this.assertFrozenComplaintLock(current);
      const now = new Date().toISOString();
      const updated = this.database.prepare(`
        UPDATE complaint_attempts SET state = 'click_started', click_started_at = ?, updated_at = ?
        WHERE complaint_case_id = ? AND state = 'intent_saved'
      `).run(now, now, caseId);
      if (updated.changes !== 1) throw new Error("投诉提交检查点已发生变化");
      const caseUpdate = this.database.prepare("UPDATE complaint_cases SET state = 'submitting', updated_at = ? WHERE id = ? AND state = 'prepared' AND action_lock_version = ?").run(now, caseId, current.actionLockVersion);
      if (caseUpdate.changes !== 1) throw new Error("投诉状态已发生变化");
      this.insertEvent(caseId, "click_started", {}, now);
      return this.get(current.id)!;
    }).immediate();
  }

  markAttemptClickFinished(caseId: string): ComplaintCaseRecord {
    return this.database.transaction(() => {
      const current = this.requireState(caseId, "submitting");
      this.assertFrozenComplaintLock(current);
      const now = new Date().toISOString();
      const updated = this.database.prepare(`
        UPDATE complaint_attempts SET state = 'click_finished', click_finished_at = ?, updated_at = ?
        WHERE complaint_case_id = ? AND state = 'click_started'
      `).run(now, now, caseId);
      if (updated.changes !== 1) throw new Error("投诉提交检查点已发生变化");
      this.insertEvent(caseId, "click_finished", {}, now);
      return this.get(current.id)!;
    }).immediate();
  }

  confirmSubmitted(caseId: string, result:
    | { platformCaseId: string; detailUrl?: string }
    | { platformCaseId?: string; detailUrl: string }): ComplaintCaseRecord {
    const platformCaseId = result.platformCaseId?.trim() || null;
    const detailUrl = result.detailUrl ? canonicalPlatformDetailUrl(result.detailUrl) : null;
    if ((platformCaseId !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(platformCaseId))
      || (result.detailUrl !== undefined && !detailUrl)
      || (!platformCaseId && !detailUrl)) throw new Error("平台投诉结果标识无效");
    return this.database.transaction(() => {
      const current = this.requireState(caseId, "submitting");
      this.assertFrozenComplaintLock(current);
      const now = new Date().toISOString();
      const updated = this.database.prepare(`
        UPDATE complaint_attempts SET state = 'submitted', platform_case_id = ?, platform_detail_url = ?, submitted_at = ?, updated_at = ?
        WHERE complaint_case_id = ? AND state = 'click_finished'
      `).run(platformCaseId, detailUrl, now, now, caseId);
      if (updated.changes !== 1) throw new Error("投诉提交检查点已发生变化");
      const caseUpdated = this.database.prepare(`
        UPDATE complaint_cases SET state = 'submitted', platform_case_id = ?, platform_detail_url = ?, submitted_at = ?, updated_at = ?
        WHERE id = ? AND state = 'submitting' AND action_lock_version = ?
      `).run(platformCaseId, detailUrl, now, now, caseId, current.actionLockVersion);
      if (caseUpdated.changes !== 1) throw new Error("投诉状态已发生变化");
      this.insertEvent(caseId, "submitted", platformCaseId ? { platformCaseId } : { detailPath: detailUrl }, now);
      return this.get(current.id)!;
    }).immediate();
  }

  markUnderReview(caseId: string): ComplaintCaseRecord {
    return this.database.transaction(() => {
      const current = this.requireState(caseId, "submitted");
      this.assertFrozenComplaintLock(current);
      const now = new Date().toISOString();
      const changed = this.database.prepare("UPDATE complaint_cases SET state = 'under_review', result_observed_at = ?, updated_at = ? WHERE id = ? AND state = 'submitted' AND action_lock_version = ?")
        .run(now, now, caseId, current.actionLockVersion);
      if (changed.changes !== 1) throw new Error("投诉状态已发生变化");
      this.insertEvent(caseId, "under_review", {}, now);
      return this.get(current.id)!;
    }).immediate();
  }

  get(id: string): ComplaintCaseRecord | null {
    const row = this.database.prepare("SELECT * FROM complaint_cases WHERE id = ?").get(id) as CaseRow | undefined;
    return row ? this.map(row) : null;
  }

  findBySource(storeId: string, sourceKey: string): ComplaintCaseRecord | null {
    const row = this.database.prepare("SELECT * FROM complaint_cases WHERE store_id = ? AND source_key = ?").get(storeId, sourceKey) as CaseRow | undefined;
    return row ? this.map(row) : null;
  }

  /** Read-only operator view. Raw review text and browser data are not stored here. */
  list(): ComplaintCaseRecord[] {
    return (this.database.prepare("SELECT * FROM complaint_cases ORDER BY created_at DESC, id DESC").all() as CaseRow[])
      .map((row) => this.map(row));
  }

  statusSummary(): {
    total: number;
    noComplaint: number;
    prepared: number;
    submitted: number;
    upheld: number;
    rejected: number;
    manualActionRequired: number;
    unresolved: number;
  } {
    const rows = this.database.prepare("SELECT state, COUNT(*) AS count FROM complaint_cases GROUP BY state")
      .all() as Array<{ state: ComplaintCaseState; count: number }>;
    const count = (states: readonly ComplaintCaseState[]) => rows
      .filter((row) => states.includes(row.state))
      .reduce((total, row) => total + Number(row.count), 0);
    return {
      total: rows.reduce((total, row) => total + Number(row.count), 0),
      noComplaint: count(["no_complaint"]),
      prepared: count(["prepared"]),
      submitted: count(["submitted", "under_review", "upheld", "rejected", "closed", "not_actionable"]),
      upheld: count(["upheld"]),
      rejected: count(["rejected"]),
      manualActionRequired: count(["manual_action_required"]),
      unresolved: count(["discovered", "analyzing", "prepared", "submitting", "submission_uncertain", "retry_wait", "manual_action_required", "failed"]),
    };
  }

  /**
   * Deletes only finished, unowned cases.  Complaint attempts are audit
   * evidence, so a case with an attempt remains until the longer audit window
   * expires.  Active/manual/uncertain cases are intentionally never age-pruned.
   */
  pruneOlderThan(retentionDays: number, now = new Date(), auditRetentionDays = 180): { cases: number; attempts: number } {
    if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error("投诉保留天数必须大于 0");
    if (!Number.isFinite(auditRetentionDays) || auditRetentionDays < retentionDays) {
      throw new Error("投诉审计保留天数不能小于投诉记录保留天数");
    }
    const caseCutoff = new Date(now.getTime() - Math.trunc(retentionDays) * 86_400_000).toISOString();
    const auditCutoff = new Date(now.getTime() - Math.trunc(auditRetentionDays) * 86_400_000).toISOString();
    return this.database.transaction(() => {
      const eligible = this.database.prepare(`
        SELECT c.id
        FROM complaint_cases c
        WHERE c.updated_at < ?
          AND c.state IN ('no_complaint', 'upheld', 'closed', 'not_actionable')
          AND NOT EXISTS (
            SELECT 1 FROM review_action_locks l
            WHERE l.store_id = c.store_id AND l.source_key = c.source_key
          )
          AND NOT EXISTS (
            SELECT 1 FROM complaint_attempts a
            WHERE a.complaint_case_id = c.id AND a.updated_at >= ?
          )
      `).all(caseCutoff, auditCutoff) as Array<{ id: string }>;
      if (eligible.length === 0) return { cases: 0, attempts: 0 };
      const ids = eligible.map((item) => item.id);
      const placeholders = ids.map(() => "?").join(", ");
      const attempts = this.database.prepare(`
        DELETE FROM complaint_attempts WHERE complaint_case_id IN (${placeholders})
      `).run(...ids).changes;
      const cases = this.database.prepare(`
        DELETE FROM complaint_cases WHERE id IN (${placeholders})
      `).run(...ids).changes;
      return { cases, attempts };
    }).immediate();
  }

  storageCounts(): { cases: number; attempts: number; events: number; unresolved: number } {
    const count = (table: "complaint_cases" | "complaint_attempts" | "complaint_events") => Number(
      (this.database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number }).value,
    );
    return {
      cases: count("complaint_cases"),
      attempts: count("complaint_attempts"),
      events: count("complaint_events"),
      unresolved: this.statusSummary().unresolved,
    };
  }

  listEvents(caseId: string): ComplaintEventRecord[] {
    return (this.database.prepare("SELECT id, event_type, detail_json, created_at FROM complaint_events WHERE complaint_case_id = ? ORDER BY created_at, id").all(caseId) as Array<{ id: string; event_type: string; detail_json: string; created_at: string }>).map((row) => ({
      id: row.id, eventType: row.event_type, detail: JSON.parse(row.detail_json) as Record<string, unknown>, createdAt: row.created_at,
    }));
  }

  private assertFrozenComplaintLock(current: ComplaintCaseRecord): void {
    const lock = this.database.prepare("SELECT action_kind, lock_version FROM review_action_locks WHERE store_id = ? AND source_key = ?")
      .get(current.storeId, current.sourceKey) as { action_kind: string; lock_version: number } | undefined;
    if (!lock || lock.action_kind !== "complaint" || lock.lock_version !== current.actionLockVersion) throw new Error("投诉动作锁已发生变化");
  }

  private transition(caseId: string, allowed: ComplaintCaseState[], state: ComplaintCaseState, errorCode: string): ComplaintCaseRecord {
    if (!SAFE_ERROR_CODES.has(errorCode)) throw new Error("投诉错误代码不受支持");
    return this.database.transaction(() => {
      const current = this.get(caseId);
      if (!current || !allowed.includes(current.state)) throw new Error("投诉状态当前不能转换");
      this.assertFrozenComplaintLock(current);
      const now = new Date().toISOString();
      const changed = this.database.prepare("UPDATE complaint_cases SET state = ?, error_code = ?, updated_at = ? WHERE id = ? AND state = ? AND action_lock_version = ?")
        .run(state, errorCode, now, caseId, current.state, current.actionLockVersion);
      if (changed.changes !== 1) throw new Error("投诉状态已发生变化");
      this.insertEvent(caseId, state, { code: errorCode }, now);
      return this.get(caseId)!;
    }).immediate();
  }

  private requireState(caseId: string, state: ComplaintCaseState): ComplaintCaseRecord {
    const current = this.get(caseId);
    if (!current || current.state !== state) throw new Error("投诉提交检查点已发生变化");
    return current;
  }

  private resolveTerminal(caseId: string, state: "upheld", terminalAction: "complaint_upheld"): ComplaintCaseRecord {
    return this.database.transaction(() => {
      const current = this.get(caseId);
      if (!current || !["submitted", "under_review"].includes(current.state)) throw new Error("投诉状态当前不能转换");
      this.assertFrozenComplaintLock(current);
      const now = new Date().toISOString();
      const changed = this.database.prepare("UPDATE complaint_cases SET state = ?, result_observed_at = ?, updated_at = ? WHERE id = ? AND state IN ('submitted','under_review') AND action_lock_version = ?")
        .run(state, now, now, caseId, current.actionLockVersion);
      if (changed.changes !== 1) throw new Error("投诉状态已发生变化");
      this.removeComplaintLockToTombstone(current, terminalAction, now);
      this.insertEvent(caseId, state, {}, now);
      return this.get(caseId)!;
    }).immediate();
  }

  private confirmReconciledReceived(current: ComplaintCaseRecord, snapshot: ComplaintReconciliationSnapshot): ComplaintCaseRecord {
    const detailUrl = canonicalPlatformDetailUrl(snapshot.detailPath!);
    if (!detailUrl || !snapshot.platformCaseId || !/^[A-Za-z0-9_-]{1,128}$/.test(snapshot.platformCaseId)) throw new Error("平台核对结果无效");
    return this.database.transaction(() => {
      this.assertFrozenComplaintLock(current);
      const now = snapshot.observedAt.toISOString();
      const changed = this.database.prepare("UPDATE complaint_cases SET state = 'submitted', platform_case_id = ?, platform_detail_url = ?, result_observed_at = ?, updated_at = ? WHERE id = ? AND state = 'submission_uncertain' AND action_lock_version = ?")
        .run(snapshot.platformCaseId, detailUrl, now, now, current.id, current.actionLockVersion);
      if (changed.changes !== 1) throw new Error("投诉状态已发生变化");
      this.database.prepare("UPDATE complaint_attempts SET state = 'submitted', platform_case_id = ?, platform_detail_url = ?, result_observed_at = ?, updated_at = ? WHERE complaint_case_id = ? AND state IN ('click_started','click_finished')")
        .run(snapshot.platformCaseId, detailUrl, now, now, current.id);
      this.insertEvent(current.id, "reconciled_received", { platformCaseId: snapshot.platformCaseId }, now);
      return this.get(current.id)!;
    }).immediate();
  }

  private removeComplaintLockToTombstone(current: ComplaintCaseRecord, terminalAction: string, now: string): void {
    const removed = this.database.prepare("DELETE FROM review_action_locks WHERE store_id = ? AND source_key = ? AND action_kind = 'complaint' AND lock_version = ?")
      .run(current.storeId, current.sourceKey, current.actionLockVersion);
    if (removed.changes !== 1) throw new Error("投诉动作锁已发生变化");
    this.database.prepare("INSERT INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at) VALUES (?, ?, ?, ?)")
      .run(current.storeId, current.sourceKey, terminalAction, now);
  }

  private insertEvent(caseId: string, eventType: string, detail: Record<string, unknown>, at: string): void {
    this.database.prepare("INSERT INTO complaint_events(id, complaint_case_id, event_type, detail_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), caseId, eventType, JSON.stringify(detail), at);
  }

  private map(row: CaseRow): ComplaintCaseRecord {
    return {
      id: row.id, storeId: row.store_id, sourceKey: row.source_key, state: row.state,
      complaintType: row.complaint_type, factCode: row.fact_code, quote: row.quote_text,
      confidence: row.confidence, reason: row.reason, description: row.description,
      actionLockVersion: row.action_lock_version, errorCode: row.error_code,
      reviewId: row.review_id, contentHash: row.content_hash, canonicalizerVersion: row.canonicalizer_version,
      imagePairs: JSON.parse(row.image_pairs_json) as Array<{ imageId: string; imageHash: string }>,
      visualVersion: row.visual_version, platformMappingVersion: row.platform_mapping_version, modelVersion: row.model_version,
      phase: row.review_phase, promptVersion: row.prompt_version, ruleVersion: row.rule_version, mappingVersion: row.mapping_version,
      factDescription: row.fact_description, validationFacts: row.validation_facts_json ? JSON.parse(row.validation_facts_json) as Record<string, unknown> : null,
      modelResult: row.model_result_json ? JSON.parse(row.model_result_json) as Record<string, unknown> : null, descriptionBuilderVersion: row.description_builder_version,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
}

function sanitizeSafeText(value: string): string {
  if (/1\d{10}|\d{16,19}|[\u4e00-\u9fff]{2,}(?:省|市|区|县|路|街|道)[\u4e00-\u9fff\d-]{2,}(?:号|室|栋|单元)?/.test(value)) {
    throw new Error("投诉持久化文本不得包含未脱敏隐私信息");
  }
  return value.trim();
}

function canonicalPlatformDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !["myseller.taobao.com", "myseller.tmall.com"].includes(parsed.hostname)) return null;
    if (!parsed.pathname.startsWith("/")) return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}
