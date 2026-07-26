import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { correctImportedReplyHistory } from "./correct-imported-reply-history.mjs";

function createFixture(databasePath) {
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE reply_drafts (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      review_text TEXT NOT NULL,
      product_title TEXT NOT NULL,
      sentiment_label TEXT NOT NULL,
      state TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      discovered_at TEXT NOT NULL,
      processed_at TEXT,
      updated_at TEXT NOT NULL,
      ai_checkpoint_stage TEXT,
      failed_stage TEXT,
      ai_retry_error_kind TEXT,
      next_retry_at TEXT,
      consecutive_ai_failure_rounds INTEGER NOT NULL DEFAULT 0,
      ai_retry_claim_token TEXT,
      ai_retry_claim_expires_at TEXT
    );
    CREATE TABLE reply_attempts (
      id TEXT PRIMARY KEY,
      reply_draft_id TEXT,
      source_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      evidence TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      submitted_at TEXT,
      verified_at TEXT,
      action_lock_version INTEGER
    );
    CREATE TABLE review_action_locks (
      store_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      lock_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(store_id, source_key)
    );
    CREATE TABLE review_action_tombstones (
      store_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      terminal_action TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      PRIMARY KEY(store_id, source_key)
    );
    CREATE TABLE complaint_cases (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(store_id, source_key)
    );
    CREATE TABLE complaint_attempts (
      id TEXT PRIMARY KEY,
      complaint_case_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE complaint_events (
      id TEXT PRIMARY KEY,
      complaint_case_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE complaint_analysis_invocations (
      id TEXT NOT NULL,
      complaint_case_id TEXT NOT NULL,
      analysis_pass TEXT NOT NULL,
      result_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(complaint_case_id, id)
    );
  `);
  const insertDraft = database.prepare(`
    INSERT INTO reply_drafts(
      id, source_key, review_text, product_title, sentiment_label, state,
      error_code, error_message, discovered_at, processed_at, updated_at,
      ai_retry_error_kind, next_retry_at, consecutive_ai_failure_rounds,
      ai_retry_claim_token, ai_retry_claim_expires_at
    ) VALUES (?, ?, '评价', '商品', 'positive', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const at = "2026-07-23T00:00:00.000Z";
  insertDraft.run("sent-id", "sent-key", "sent", null, null, at, at, at, null, null, 0, null, null);
  insertDraft.run("failed-id", "failed-key", "failed", "TMALL_SUBMISSION_FAILED", "旧电脑已实际提交", at, null, at, null, null, 0, null, null);
  insertDraft.run("retry-id", "retry-key", "retry_wait", "AI_RETRY", "等待重试", at, null, at, "timeout", at, 2, "claim", at);
  insertDraft.run("new-id", "new-key", "discovered", null, null, at, null, at, null, null, 0, null, null);

  const insertAttempt = database.prepare(`
    INSERT INTO reply_attempts(
      id, reply_draft_id, source_key, state, evidence, error_code, error_message,
      created_at, updated_at, submitted_at, verified_at, action_lock_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertAttempt.run("sent-attempt", "sent-id", "sent-key", "sent", "旧证据", null, null, at, at, at, at, null);
  insertAttempt.run("failed-attempt", "failed-id", "failed-key", "submission_uncertain", null, "SUBMIT", "失败", at, at, null, null, 1);
  insertAttempt.run("retry-attempt", "retry-id", "retry-key", "pending", null, null, null, at, at, null, null, 1);

  const insertLock = database.prepare(`
    INSERT INTO review_action_locks(store_id, source_key, action_kind, lock_version, created_at, updated_at)
    VALUES ('primary', ?, 'reply', 1, ?, ?)
  `);
  insertLock.run("failed-key", at, at);
  insertLock.run("retry-key", at, at);
  database.prepare(`
    INSERT INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at)
    VALUES ('primary', 'sent-key', 'reply_sent', ?)
  `).run(at);

  const insertComplaint = database.prepare(`
    INSERT INTO complaint_cases(id, store_id, source_key, state, created_at, updated_at)
    VALUES (?, 'primary', ?, ?, ?, ?)
  `);
  insertComplaint.run("complaint-failed", "complaint-failed-key", "failed", at, at);
  insertComplaint.run("complaint-retry", "complaint-retry-key", "retry_wait", at, at);
  insertComplaint.run("complaint-no-op", "complaint-no-op-key", "no_complaint", at, at);
  insertComplaint.run("complaint-submitted", "complaint-submitted-key", "submitted", at, at);
  database.prepare("INSERT INTO complaint_attempts(id, complaint_case_id, source_key, state) VALUES (?, ?, ?, ?)")
    .run("complaint-failed-attempt", "complaint-failed", "complaint-failed-key", "failed");
  database.prepare("INSERT INTO complaint_events(id, complaint_case_id, event_type, detail_json, created_at) VALUES (?, ?, 'failed', '{}', ?)")
    .run("complaint-failed-event", "complaint-failed", at);
  database.prepare("INSERT INTO complaint_analysis_invocations(id, complaint_case_id, analysis_pass, result_digest, created_at) VALUES (?, ?, 'primary', ?, ?)")
    .run("complaint-failed-model", "complaint-failed", "a".repeat(64), at);
  insertLock.run("complaint-failed-key", at, at);
  database.prepare(`
    INSERT INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at)
    VALUES ('primary', 'complaint-submitted-key', 'complaint_submitted', ?)
  `).run(at);
  database.close();
}

test("creates a separate viewing database containing only successful replies", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tmall-history-correction-"));
  try {
    const sourcePath = path.join(directory, "source.sqlite");
    const outputPath = path.join(directory, "corrected.sqlite");
    createFixture(sourcePath);

    const report = await correctImportedReplyHistory({
      sourcePath,
      outputPath,
      correctionAt: "2026-07-24T03:00:00.000Z",
    });

    assert.equal(report.convertedFailed, 1);
    assert.equal(report.deletedNotSuccessful, 2);
    assert.equal(report.deletedComplaintCases, 3);
    assert.deepEqual(report.after.replyDraftsByState, { sent: 2 });
    assert.deepEqual(report.after.replyAttemptsByState, {});
    assert.deepEqual(report.after.complaintCasesByState, { submitted: 1 });

    const corrected = new Database(outputPath, { readonly: true });
    assert.deepEqual(
      corrected.prepare("SELECT source_key, state, error_code, error_message FROM reply_drafts ORDER BY source_key").all(),
      [
        { source_key: "failed-key", state: "sent", error_code: null, error_message: null },
        { source_key: "sent-key", state: "sent", error_code: null, error_message: null },
      ],
    );
    assert.equal(corrected.prepare("SELECT COUNT(*) AS count FROM reply_attempts").get().count, 0);
    assert.equal(corrected.prepare("SELECT COUNT(*) AS count FROM review_action_locks").get().count, 0);
    assert.deepEqual(
      corrected.prepare("SELECT source_key, terminal_action FROM review_action_tombstones ORDER BY source_key").all(),
      [
        { source_key: "complaint-submitted-key", terminal_action: "complaint_submitted" },
      ],
    );
    assert.deepEqual(
      corrected.prepare("SELECT source_key, state FROM complaint_cases ORDER BY source_key").all(),
      [{ source_key: "complaint-submitted-key", state: "submitted" }],
    );
    assert.equal(corrected.prepare("SELECT COUNT(*) AS count FROM complaint_attempts").get().count, 0);
    assert.equal(corrected.prepare("SELECT COUNT(*) AS count FROM complaint_events").get().count, 0);
    assert.equal(corrected.prepare("SELECT COUNT(*) AS count FROM complaint_analysis_invocations").get().count, 0);
    corrected.close();

    const original = new Database(sourcePath, { readonly: true });
    assert.equal(original.prepare("SELECT COUNT(*) AS count FROM reply_drafts").get().count, 4);
    assert.equal(original.prepare("SELECT state FROM reply_drafts WHERE source_key = 'failed-key'").get().state, "failed");
    original.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to overwrite the source or an existing output database", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tmall-history-correction-"));
  try {
    const sourcePath = path.join(directory, "source.sqlite");
    const outputPath = path.join(directory, "corrected.sqlite");
    createFixture(sourcePath);

    await assert.rejects(
      correctImportedReplyHistory({ sourcePath, outputPath: sourcePath }),
      /源数据库和输出数据库不能是同一个文件/u,
    );
    createFixture(outputPath);
    await assert.rejects(
      correctImportedReplyHistory({ sourcePath, outputPath }),
      /输出文件已存在/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
