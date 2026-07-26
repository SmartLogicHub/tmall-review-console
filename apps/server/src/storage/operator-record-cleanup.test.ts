import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, runMigrations, type AppDatabase } from "./database";
import { ComplaintRepository } from "./complaint-repository";
import { ReplyAttemptRepository, ReplyRepository } from "./repositories";
import { OperatorRecordCleanup, OperatorRecordCleanupConflictError } from "./operator-record-cleanup";

const snapshot = (sourceKey: string) => ({
  sourceKey,
  orderId: `${sourceKey}-order`,
  review: "测试评价",
  product: "测试商品",
  reviewedAt: "2026-07-20 10:00",
  sentimentLabel: "negative" as const,
  itemId: `${sourceKey}-item`,
  reviewPhase: "initial" as const,
});

describe("operator per-record cleanup", () => {
  let database: AppDatabase;
  let replies: ReplyRepository;
  let complaints: ComplaintRepository;
  let cleanup: OperatorRecordCleanup;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    replies = new ReplyRepository(database);
    complaints = new ComplaintRepository(database);
    cleanup = new OperatorRecordCleanup(database);
  });

  afterEach(() => database.close());

  it("fully deletes a never-submitted reply so the review can run again", () => {
    const sourceKey = "cleanup-reply-retry";
    const draft = replies.discover(snapshot(sourceKey));
    database.prepare("UPDATE reply_drafts SET state = 'failed' WHERE id = ?").run(draft.id);

    expect(cleanup.removeReply(draft.id)).toEqual({ mode: "reprocess", sourceKey });
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_drafts WHERE source_key = ?").get(sourceKey)).toEqual({ value: 0 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM review_action_tombstones WHERE source_key = ?").get(sourceKey)).toEqual({ value: 0 });
    expect(replies.discover(snapshot(sourceKey))).toMatchObject({ created: true });
  });

  it("deletes sent reply details but retains only the minimal anti-duplicate tombstone", () => {
    const sourceKey = "cleanup-reply-sent";
    const draft = replies.discover(snapshot(sourceKey));
    database.prepare("UPDATE reply_drafts SET state = 'read_only_ready' WHERE id = ?").run(draft.id);
    const attempts = new ReplyAttemptRepository(database);
    const attempt = attempts.prepare(draft.id, sourceKey).attempt;
    attempts.markSubmitting(attempt.id);
    attempts.markSent(attempt.id, "platform-confirmed");

    expect(cleanup.removeReply(draft.id)).toEqual({ mode: "completed", sourceKey });
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_drafts WHERE source_key = ?").get(sourceKey)).toEqual({ value: 0 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_attempts WHERE source_key = ?").get(sourceKey)).toEqual({ value: 0 });
    expect(database.prepare("SELECT terminal_action FROM review_action_tombstones WHERE source_key = ?").get(sourceKey)).toEqual({ terminal_action: "reply_sent" });
  });

  it("fully deletes a never-submitted complaint and its linked reply so it can run again", () => {
    const sourceKey = "cleanup-complaint-retry";
    replies.discover(snapshot(sourceKey));
    const complaint = complaints.discover("primary", sourceKey, {
      reviewId: sourceKey,
      contentHash: "a".repeat(64),
      canonicalizerVersion: "canonical-v1",
      phase: "initial",
      imagePairs: [],
      promptVersion: "p1",
      ruleVersion: "r1",
      mappingVersion: "m1",
      visualVersion: "v1",
      platformMappingVersion: "platform-v1",
      modelVersion: "m1",
    });
    complaints.markFailed(complaint.id, "timeout");

    expect(cleanup.removeComplaint(complaint.id)).toEqual({ mode: "reprocess", sourceKey });
    expect(database.prepare("SELECT COUNT(*) AS value FROM complaint_cases WHERE source_key = ?").get(sourceKey)).toEqual({ value: 0 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_drafts WHERE source_key = ?").get(sourceKey)).toEqual({ value: 0 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM review_action_tombstones WHERE source_key = ?").get(sourceKey)).toEqual({ value: 0 });
  });

  it("deletes submitted complaint details but retains a minimal anti-duplicate tombstone", () => {
    const sourceKey = "cleanup-complaint-submitted";
    replies.discover(snapshot(sourceKey));
    const complaint = complaints.discover("primary", sourceKey, {
      reviewId: sourceKey,
      contentHash: "b".repeat(64),
      canonicalizerVersion: "canonical-v1",
      phase: "initial",
      imagePairs: [],
      promptVersion: "p1",
      ruleVersion: "r1",
      mappingVersion: "m1",
      visualVersion: "v1",
      platformMappingVersion: "platform-v1",
      modelVersion: "m1",
    });
    database.prepare("UPDATE complaint_cases SET state = 'submitted' WHERE id = ?").run(complaint.id);

    expect(cleanup.removeComplaint(complaint.id)).toEqual({ mode: "completed", sourceKey });
    expect(database.prepare("SELECT COUNT(*) AS value FROM complaint_cases WHERE source_key = ?").get(sourceKey)).toEqual({ value: 0 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_drafts WHERE source_key = ?").get(sourceKey)).toEqual({ value: 0 });
    expect(database.prepare("SELECT terminal_action FROM review_action_tombstones WHERE source_key = ?").get(sourceKey)).toEqual({ terminal_action: "complaint_submitted" });
  });

  it("refuses to delete an uncertain platform submission", () => {
    const sourceKey = "cleanup-reply-uncertain";
    const draft = replies.discover(snapshot(sourceKey));
    database.prepare("UPDATE reply_drafts SET state = 'submission_uncertain' WHERE id = ?").run(draft.id);

    expect(() => cleanup.removeReply(draft.id)).toThrowError(OperatorRecordCleanupConflictError);
    expect(replies.get(draft.id)).not.toBeNull();
  });

  it("cleans a rejected complaint without deleting the reply that is still pending", () => {
    const sourceKey = "cleanup-rejected-replyable";
    const draft = replies.discover(snapshot(sourceKey));
    const complaint = complaints.discover("primary", sourceKey, {
      reviewId: sourceKey, contentHash: "c".repeat(64), canonicalizerVersion: "canonical-v1", phase: "initial",
      imagePairs: [], promptVersion: "p1", ruleVersion: "r1", mappingVersion: "m1", visualVersion: "v1",
      platformMappingVersion: "platform-v1", modelVersion: "m1",
    });
    database.prepare("UPDATE complaint_cases SET state = 'rejected' WHERE id = ?").run(complaint.id);
    database.prepare("UPDATE review_action_locks SET action_kind = 'reply', lock_version = lock_version + 1 WHERE source_key = ?").run(sourceKey);

    expect(cleanup.removeComplaint(complaint.id)).toEqual({ mode: "reply_pending", sourceKey });
    expect(database.prepare("SELECT COUNT(*) AS value FROM complaint_cases WHERE source_key = ?").get(sourceKey)).toEqual({ value: 0 });
    expect(database.prepare("SELECT id FROM reply_drafts WHERE source_key = ?").get(sourceKey)).toEqual({ id: draft.id });
    expect(database.prepare("SELECT action_kind FROM review_action_locks WHERE source_key = ?").get(sourceKey)).toEqual({ action_kind: "reply" });
    expect(database.prepare("SELECT COUNT(*) AS value FROM review_action_tombstones WHERE source_key = ?").get(sourceKey)).toEqual({ value: 0 });
  });

  it("bulk-clears every non-sent reply and its unfinished history so only sent replies remain", () => {
    const states = [
      "sent",
      "failed",
      "retry_wait",
      "submitting",
      "submission_uncertain",
      "needs_attention",
      "manual_product_hold",
      "manual_hold_expired",
      "not_actionable",
    ] as const;
    const drafts = states.map((state) => {
      const sourceKey = `bulk-unsent-${state}`;
      const draft = replies.discover(snapshot(sourceKey));
      database.prepare("UPDATE reply_drafts SET state = ? WHERE id = ?").run(state, draft.id);
      return { ...draft, sourceKey, state };
    });
    const failed = drafts.find((draft) => draft.state === "failed")!;
    database.prepare(`
      INSERT INTO reply_attempts(
        id, reply_draft_id, source_key, state, created_at, updated_at, error_code, error_message
      ) VALUES ('bulk-failed-attempt', ?, ?, 'failed', ?, ?, 'NETWORK', 'network failed')
    `).run(failed.id, failed.sourceKey, new Date().toISOString(), new Date().toISOString());
    const complaint = complaints.discover("primary", failed.sourceKey, {
      reviewId: failed.sourceKey,
      contentHash: "d".repeat(64),
      canonicalizerVersion: "canonical-v1",
      phase: "initial",
      imagePairs: [],
      promptVersion: "p1",
      ruleVersion: "r1",
      mappingVersion: "m1",
      visualVersion: "v1",
      platformMappingVersion: "platform-v1",
      modelVersion: "m1",
    });
    complaints.markFailed(complaint.id, "network");

    expect(cleanup.removeReplyRecords("unsent")).toBe(states.length - 1);
    expect(database.prepare("SELECT state FROM reply_drafts ORDER BY state").all()).toEqual([{ state: "sent" }]);
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_attempts WHERE source_key = ?").get(failed.sourceKey)).toEqual({ value: 0 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM complaint_cases WHERE source_key = ?").get(failed.sourceKey)).toEqual({ value: 0 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM review_action_locks WHERE source_key = ?").get(failed.sourceKey)).toEqual({ value: 0 });
    expect(replies.discover(snapshot(failed.sourceKey))).toMatchObject({ created: true });
  });

  it("bulk-clears sent reply details while retaining anti-duplicate markers", () => {
    for (const sourceKey of ["bulk-sent-one", "bulk-sent-two"]) {
      const draft = replies.discover(snapshot(sourceKey));
      database.prepare("UPDATE reply_drafts SET state = 'sent' WHERE id = ?").run(draft.id);
    }
    const failed = replies.discover(snapshot("bulk-sent-keep-failed"));
    database.prepare("UPDATE reply_drafts SET state = 'failed' WHERE id = ?").run(failed.id);

    expect(cleanup.removeReplyRecords("sent")).toBe(2);
    expect(database.prepare("SELECT source_key, state FROM reply_drafts").all()).toEqual([
      { source_key: "bulk-sent-keep-failed", state: "failed" },
    ]);
    expect(database.prepare("SELECT source_key, terminal_action FROM review_action_tombstones ORDER BY source_key").all()).toEqual([
      { source_key: "bulk-sent-one", terminal_action: "reply_sent" },
      { source_key: "bulk-sent-two", terminal_action: "reply_sent" },
    ]);
  });
});
