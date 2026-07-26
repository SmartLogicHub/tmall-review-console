import type { AppDatabase } from "./database";

export type OperatorRecordCleanupMode = "reprocess" | "completed" | "reply_pending";

export interface OperatorRecordCleanupResult {
  mode: OperatorRecordCleanupMode;
  sourceKey: string;
}

export class OperatorRecordCleanupNotFoundError extends Error {
  constructor(readonly entity: "reply" | "complaint") {
    super(entity === "reply" ? "回复记录不存在" : "投诉记录不存在");
    this.name = "OperatorRecordCleanupNotFoundError";
  }
}

export class OperatorRecordCleanupConflictError extends Error {
  constructor(readonly code: "automation_in_progress" | "submission_in_progress" | "submission_uncertain") {
    super(code === "submission_uncertain"
      ? "提交结果尚未确定，请先核对平台结果后再删除"
      : "记录正在提交，请等待当前操作结束后再删除");
    this.name = "OperatorRecordCleanupConflictError";
  }
}

type ReplyRow = { id: string; source_key: string; state: string };
type ComplaintRow = { id: string; store_id: string; source_key: string; state: string };

const COMPLETED_REPLY_STATES = new Set(["sent"]);
const COMPLETED_REPLY_ATTEMPT_STATES = new Set(["sent"]);
const COMPLETED_COMPLAINT_STATES = new Set([
  "submitted", "under_review", "upheld", "rejected", "closed", "not_actionable",
]);
const COMPLETED_COMPLAINT_ATTEMPT_STATES = new Set(["submitted"]);

export class OperatorRecordCleanup {
  constructor(private readonly database: AppDatabase) {}

  removeReplyRecords(scope: "sent" | "unsent"): number {
    return this.database.transaction(() => {
      const rows = this.database.prepare(`
        SELECT id, source_key, state
        FROM reply_drafts
        WHERE ${scope === "sent" ? "state = 'sent'" : "state <> 'sent'"}
        ORDER BY discovered_at ASC, id ASC
      `).all() as ReplyRow[];
      for (const row of rows) {
        this.removeSource("reply", row.source_key, row.state, undefined, scope === "unsent");
      }
      return rows.length;
    }).immediate();
  }

  removeReply(id: string): OperatorRecordCleanupResult {
    return this.database.transaction(() => {
      const draft = this.database.prepare("SELECT id, source_key, state FROM reply_drafts WHERE id = ?").get(id) as ReplyRow | undefined;
      if (!draft) throw new OperatorRecordCleanupNotFoundError("reply");
      return this.removeSource("reply", draft.source_key, draft.state);
    }).immediate();
  }

  removeComplaint(id: string): OperatorRecordCleanupResult {
    return this.database.transaction(() => {
      const complaint = this.database.prepare("SELECT id, store_id, source_key, state FROM complaint_cases WHERE id = ?").get(id) as ComplaintRow | undefined;
      if (!complaint) throw new OperatorRecordCleanupNotFoundError("complaint");
      return this.removeSource("complaint", complaint.source_key, null, complaint);
    }).immediate();
  }

  private removeSource(
    entity: "reply" | "complaint",
    sourceKey: string,
    replyState: string | null,
    knownComplaint?: ComplaintRow,
    allowUnsentBulkRemoval = false,
  ): OperatorRecordCleanupResult {
    const attempt = this.database.prepare("SELECT state FROM reply_attempts WHERE source_key = ?").get(sourceKey) as { state: string } | undefined;
    const complaint = knownComplaint ?? this.database.prepare(
      "SELECT id, store_id, source_key, state FROM complaint_cases WHERE store_id = 'primary' AND source_key = ?",
    ).get(sourceKey) as ComplaintRow | undefined;
    const complaintAttempt = this.database.prepare(
      "SELECT state FROM complaint_attempts WHERE store_id = 'primary' AND source_key = ? ORDER BY created_at DESC LIMIT 1",
    ).get(sourceKey) as { state: string } | undefined;
    const tombstone = this.database.prepare(
      "SELECT terminal_action FROM review_action_tombstones WHERE store_id = 'primary' AND source_key = ?",
    ).get(sourceKey) as { terminal_action: string } | undefined;
    const lock = this.database.prepare(
      "SELECT action_kind FROM review_action_locks WHERE store_id = 'primary' AND source_key = ?",
    ).get(sourceKey) as { action_kind: string } | undefined;

    if (!allowUnsentBulkRemoval && (replyState === "submission_uncertain" || attempt?.state === "submission_uncertain"
      || complaint?.state === "submission_uncertain" || complaintAttempt?.state === "submission_uncertain")) {
      throw new OperatorRecordCleanupConflictError("submission_uncertain");
    }
    if (!allowUnsentBulkRemoval && (replyState === "submitting" || attempt?.state === "submitting"
      || complaint?.state === "submitting" || complaintAttempt?.state === "click_started" || complaintAttempt?.state === "click_finished")) {
      throw new OperatorRecordCleanupConflictError("submission_in_progress");
    }

    if (entity === "complaint" && lock?.action_kind === "reply") {
      this.deleteComplaintDetails(sourceKey);
      return { mode: "reply_pending", sourceKey };
    }

    const replyCompleted = (replyState !== null && COMPLETED_REPLY_STATES.has(replyState))
      || Boolean(attempt && COMPLETED_REPLY_ATTEMPT_STATES.has(attempt.state));
    const complaintCompleted = Boolean(complaint && COMPLETED_COMPLAINT_STATES.has(complaint.state))
      || Boolean(complaintAttempt && COMPLETED_COMPLAINT_ATTEMPT_STATES.has(complaintAttempt.state));
    const completed = Boolean(tombstone) || replyCompleted || complaintCompleted;

    if (completed && !tombstone) {
      const terminalAction = replyCompleted
        ? "reply_sent"
        : complaint?.state === "not_actionable"
          ? "complaint_not_actionable"
          : complaint?.state === "upheld"
            ? "complaint_upheld"
            : "complaint_submitted";
      this.database.prepare(`
        INSERT OR IGNORE INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at)
        VALUES ('primary', ?, ?, ?)
      `).run(sourceKey, terminalAction, new Date().toISOString());
    }

    this.deleteComplaintDetails(sourceKey);
    this.database.prepare("DELETE FROM reply_attempts WHERE source_key = ?").run(sourceKey);
    this.database.prepare("DELETE FROM reply_drafts WHERE source_key = ?").run(sourceKey);
    this.database.prepare("DELETE FROM review_action_locks WHERE store_id = 'primary' AND source_key = ?").run(sourceKey);

    return { mode: completed ? "completed" : "reprocess", sourceKey };
  }

  private deleteComplaintDetails(sourceKey: string): void {
    this.database.prepare(`
      DELETE FROM complaint_events
      WHERE complaint_case_id IN (SELECT id FROM complaint_cases WHERE store_id = 'primary' AND source_key = ?)
    `).run(sourceKey);
    this.database.prepare(`
      DELETE FROM complaint_analysis_invocations
      WHERE complaint_case_id IN (SELECT id FROM complaint_cases WHERE store_id = 'primary' AND source_key = ?)
    `).run(sourceKey);
    this.database.prepare("DELETE FROM complaint_attempts WHERE store_id = 'primary' AND source_key = ?").run(sourceKey);
    this.database.prepare("DELETE FROM complaint_cases WHERE store_id = 'primary' AND source_key = ?").run(sourceKey);
  }
}
