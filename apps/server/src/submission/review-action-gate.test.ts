import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "../storage/database";
import { ReplyAttemptRepository, ReplyRepository } from "../storage/repositories";
import { ReviewActionConflictError, ReviewActionGate } from "./review-action-gate";

const cleanup: string[] = [];
let sourceSequence = 0;
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function setupDraft(sourceKey: string, reviewedAt = "2026-07-15 08:00") {
  const database = openDatabase(":memory:");
  runMigrations(database);
  const replies = new ReplyRepository(database);
  const draft = replies.discover({
    sourceKey, orderId: "1", review: "一般", product: "耳机", reviewedAt, sentimentLabel: "negative",
    itemId: null, reviewPhase: "initial",
  });
  replies.complete(draft.id, {
    finalReply: "感谢您的反馈，若使用过程中有任何疑问可咨询在线客服。",
    productAdjusted: false, needsAttention: false, notes: "", attentionReasons: [],
  });
  return { database, replies, draft };
}

describe("ReviewActionGate", () => {
  it("requires manual hold release before reply or complaint can acquire the action", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const gate = new ReviewActionGate(database);

    expect(gate.acquire("primary", "source", "manual_hold")).toMatchObject({ actionKind: "manual_hold", lockVersion: 1 });
    expect(() => gate.acquire("primary", "source", "reply")).toThrowError(ReviewActionConflictError);
    expect(() => gate.acquire("primary", "source", "complaint")).toThrowError(ReviewActionConflictError);
    expect(() => gate.transition("primary", "source", "manual_hold", "reply", 2)).toThrowError(/动作状态已发生变化/);
    expect(() => gate.transition("primary", "source", "manual_hold", "reply", 1)).toThrowError(/人工处理/);
    expect(() => gate.transition("primary", "source", "manual_hold", "complaint", 1)).toThrowError(/人工处理/);
    expect(gate.getLock("primary", "source")).toMatchObject({ actionKind: "manual_hold", lockVersion: 1 });
    expect(gate.releaseManualHold("primary", "source", 1)).toBe(true);
    const reply = gate.acquire("primary", "source", "reply");
    expect(reply).toMatchObject({ actionKind: "reply", lockVersion: 1 });
    expect(() => gate.release("primary", "source", "reply", 2)).toThrowError(/动作状态已发生变化/);
    expect(gate.release("primary", "source", "reply", 1)).toBe(true);
    database.close();
  });

  it("atomically converts an active lock to a permanent terminal tombstone", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const gate = new ReviewActionGate(database);
    const lock = gate.acquire("primary", "source", "complaint");

    gate.complete("primary", "source", "complaint", lock.lockVersion, "complaint_upheld", new Date("2026-07-15T00:00:00.000Z"));
    expect(gate.getLock("primary", "source")).toBeNull();
    expect(gate.getTombstone("primary", "source")).toMatchObject({ terminalAction: "complaint_upheld" });
    expect(() => gate.acquire("primary", "source", "manual_hold")).toThrowError(/已经完成/);
    database.close();
  });

  it.each(["pending", "submitting", "submission_uncertain"] as const)(
    "does not let generic completion bypass a %s reply attempt",
    (state) => {
      const sourceKey = `complete-bypass-${state}`;
      const { database, draft } = setupDraft(sourceKey);
      const attempts = new ReplyAttemptRepository(database);
      const attempt = attempts.prepareWithReplyLock(draft.id, sourceKey).attempt;
      if (state !== "pending") attempts.markSubmitting(attempt.id);
      if (state === "submission_uncertain") attempts.markUncertain(attempt.id, "响应中断");
      const gate = new ReviewActionGate(database);
      const lock = gate.getLock("primary", sourceKey)!;
      const unsafeComplete = gate.complete.bind(gate) as unknown as (
        storeId: string,
        key: string,
        actionKind: string,
        expectedVersion: number,
        terminalAction: string,
      ) => void;
      const before = {
        attempt: database.prepare("SELECT * FROM reply_attempts WHERE id = ?").get(attempt.id),
        draft: database.prepare("SELECT * FROM reply_drafts WHERE id = ?").get(draft.id),
        lock: database.prepare("SELECT * FROM review_action_locks WHERE source_key = ?").get(sourceKey),
        tombstone: database.prepare("SELECT * FROM review_action_tombstones WHERE source_key = ?").get(sourceKey),
      };

      expect(() => unsafeComplete("primary", sourceKey, "reply", lock.lockVersion, "reply_sent"))
        .toThrowError(ReviewActionConflictError);
      expect({
        attempt: database.prepare("SELECT * FROM reply_attempts WHERE id = ?").get(attempt.id),
        draft: database.prepare("SELECT * FROM reply_drafts WHERE id = ?").get(draft.id),
        lock: database.prepare("SELECT * FROM review_action_locks WHERE source_key = ?").get(sourceKey),
        tombstone: database.prepare("SELECT * FROM review_action_tombstones WHERE source_key = ?").get(sourceKey),
      }).toEqual(before);
      database.close();
    },
  );

  it("does not let a bare reply lock manufacture a reply_sent tombstone", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const gate = new ReviewActionGate(database);
    const lock = gate.acquire("primary", "bare-reply-lock", "reply");
    const unsafeComplete = gate.complete.bind(gate) as unknown as (
      storeId: string,
      key: string,
      actionKind: string,
      expectedVersion: number,
      terminalAction: string,
    ) => void;

    expect(() => unsafeComplete("primary", "bare-reply-lock", "reply", lock.lockVersion, "reply_sent"))
      .toThrowError(ReviewActionConflictError);
    expect(gate.getLock("primary", "bare-reply-lock")).toEqual(lock);
    expect(gate.getTombstone("primary", "bare-reply-lock")).toBeNull();
    database.close();
  });

  it.each([
    { actionKind: "complaint", terminalAction: "manual_hold_expired" },
    { actionKind: "manual_hold", terminalAction: "complaint_submitted" },
  ] as const)("rejects illegal $actionKind to $terminalAction completion mappings", ({ actionKind, terminalAction }) => {
    const sourceKey = `illegal-completion-${actionKind}`;
    const database = openDatabase(":memory:");
    runMigrations(database);
    const gate = new ReviewActionGate(database);
    const lock = gate.acquire("primary", sourceKey, actionKind);
    const unsafeComplete = gate.complete.bind(gate) as unknown as (
      storeId: string,
      key: string,
      kind: string,
      expectedVersion: number,
      terminal: string,
    ) => void;

    expect(() => unsafeComplete("primary", sourceKey, actionKind, lock.lockVersion, terminalAction))
      .toThrowError(ReviewActionConflictError);
    expect(gate.getLock("primary", sourceKey)).toEqual(lock);
    expect(gate.getTombstone("primary", sourceKey)).toBeNull();
    database.close();
  });

  it("rejects manual hold completion at both the public type boundary and runtime without mutation", () => {
    const sourceKey = "manual-hold-complete-bypass";
    const { database, replies, draft } = setupDraft(sourceKey);
    replies.markManualProductHold(draft.id, {
      storeId: "primary", manualProductId: null, catalogRevision: 1,
      matchKind: "item_id", reason: "人工处理",
    });
    const gate = new ReviewActionGate(database);
    const lock = gate.getLock("primary", sourceKey)!;
    if (false) {
      // @ts-expect-error manual hold terminal states belong to ReplyRepository atomic workflows
      gate.complete("primary", sourceKey, "manual_hold", lock.lockVersion, "not_actionable");
    }
    const before = {
      draft: database.prepare("SELECT * FROM reply_drafts WHERE id = ?").get(draft.id),
      lock: database.prepare("SELECT * FROM review_action_locks WHERE source_key = ?").get(sourceKey),
      tombstone: database.prepare("SELECT * FROM review_action_tombstones WHERE source_key = ?").get(sourceKey),
    };

    expect(() => (gate.complete as any).call(
      gate,
      "primary",
      sourceKey,
      "manual_hold",
      lock.lockVersion,
      "not_actionable",
    )).toThrowError(ReviewActionConflictError);
    expect({
      draft: database.prepare("SELECT * FROM reply_drafts WHERE id = ?").get(draft.id),
      lock: database.prepare("SELECT * FROM review_action_locks WHERE source_key = ?").get(sourceKey),
      tombstone: database.prepare("SELECT * FROM review_action_tombstones WHERE source_key = ?").get(sourceKey),
    }).toEqual(before);
    database.close();
  });

  it("propagates storage failures from acquire without disguising them as action conflicts", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    database.exec(`
      CREATE TEMP TRIGGER reject_action_lock_insert
      BEFORE INSERT ON review_action_locks
      BEGIN
        SELECT RAISE(ABORT, 'storage failure');
      END;
    `);
    const gate = new ReviewActionGate(database);

    let failure: unknown;
    try {
      gate.acquire("primary", "storage-failure", "complaint");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ReviewActionConflictError);
    expect((failure as Error).message).toContain("storage failure");
    expect(gate.getLock("primary", "storage-failure")).toBeNull();
    expect(gate.getTombstone("primary", "storage-failure")).toBeNull();
    database.close();
  });

  it("allows only an eligible manual hold to release", () => {
    const { database, replies, draft } = setupDraft("held");
    replies.markManualProductHold(draft.id, {
      storeId: "primary", manualProductId: null, catalogRevision: 1, matchKind: "item_id", reason: "人工处理",
    });
    const gate = new ReviewActionGate(database);
    const lock = gate.getLock("primary", "held")!;
    expect(gate.releaseManualHold("primary", "held", lock.lockVersion)).toBe(true);
    expect(replies.get(draft.id)).toMatchObject({ state: "discovered", manualProductId: null });
    replies.complete(draft.id, {
      finalReply: "重新生成的安全回复", productAdjusted: false, needsAttention: false, notes: "", attentionReasons: [],
    });

    const attempt = new ReplyAttemptRepository(database).prepareWithReplyLock(draft.id, "held").attempt;
    expect(() => gate.acquire("primary", "held", "manual_hold")).toThrowError(ReviewActionConflictError);
    expect(attempt.state).toBe("pending");
    database.close();
  });

  it("releaseEligibleManualHolds treats a proven pre-click failed attempt as audit only", () => {
    const { database, replies, draft } = setupDraft("failed-audit-release");
    const attempts = new ReplyAttemptRepository(database);
    const attempt = attempts.prepareWithReplyLock(draft.id, "failed-audit-release").attempt;
    attempts.markFailed(attempt.id, "SAFE_PRE_CLICK", "确认未点击平台按钮");
    database.prepare(`
      INSERT INTO manual_products(id, item_id, product_title, normalized_title, created_at, updated_at)
      VALUES ('failed-audit-product', 'failed-audit-product', '人工商品', '人工商品', ?, ?)
    `).run("2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z");
    replies.markManualProductHold(draft.id, {
      storeId: "primary", manualProductId: "failed-audit-product", catalogRevision: 1,
      matchKind: "item_id", reason: "人工商品中差评",
    });
    expect(replies.get(draft.id)?.processedAt).not.toBeNull();

    expect(replies.releaseEligibleManualHolds({ manualProductIds: ["failed-audit-product"] })).toBe(1);
    expect(replies.get(draft.id)).toMatchObject({ state: "discovered", manualProductId: null, processedAt: null });
    expect(attempts.get(attempt.id)).toMatchObject({ state: "failed" });
    expect(new ReviewActionGate(database).getLock("primary", "failed-audit-release")).toBeNull();
    database.close();
  });

  it("serializes a manual rule and reply preparation across two connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-action-concurrency-"));
    cleanup.push(directory);
    const path = join(directory, "console.sqlite");
    const firstDb = openDatabase(path);
    const secondDb = openDatabase(path);
    try {
      runMigrations(firstDb);
      runMigrations(secondDb);
      secondDb.pragma("busy_timeout = 1");
      const replies = new ReplyRepository(firstDb);
      const draft = replies.discover({ sourceKey: "race", orderId: null, review: "一般", product: "耳机", reviewedAt: null, sentimentLabel: "negative", itemId: null, reviewPhase: "initial" });
      replies.complete(draft.id, {
        finalReply: "并发测试回复", productAdjusted: false, needsAttention: false, notes: "", attentionReasons: [],
      });
      let competingWriteError: unknown;
      firstDb.function("try_competing_manual_hold", () => {
        try {
          new ReplyRepository(secondDb).markManualProductHold(draft.id, {
            storeId: "primary", manualProductId: null, catalogRevision: 1,
            matchKind: "item_id", reason: "并发人工规则",
          });
        } catch (error) {
          competingWriteError = error;
        }
        return 1;
      });
      firstDb.exec(`
        CREATE TEMP TRIGGER race_between_lock_and_attempt
        BEFORE INSERT ON reply_attempts
        WHEN NEW.source_key = 'race'
        BEGIN
          SELECT try_competing_manual_hold();
        END;
      `);

      new ReplyAttemptRepository(firstDb).prepareWithReplyLock(draft.id, "race");
      expect(competingWriteError).toBeTruthy();
      expect(() => new ReplyRepository(secondDb).markManualProductHold(draft.id, {
        storeId: "primary", manualProductId: null, catalogRevision: 1,
        matchKind: "item_id", reason: "并发人工规则",
      })).toThrowError(ReviewActionConflictError);
      expect(new ReviewActionGate(secondDb).getLock("primary", "race")).toMatchObject({ actionKind: "reply" });
      expect((secondDb.prepare("SELECT COUNT(*) AS value FROM reply_attempts WHERE source_key = 'race'").get() as { value: number }).value).toBe(1);
    } finally {
      firstDb.close();
      secondDb.close();
    }
  });

  const protectedReplyStates = ["pending", "submitting", "sent", "submission_uncertain"] as const;
  const forbiddenGateOperations = [
    { name: "transition_reply_to_manual_hold", type: "transition", current: "reply", target: "manual_hold" },
    { name: "transition_reply_to_complaint", type: "transition", current: "reply", target: "complaint" },
    { name: "transition_complaint_to_reply", type: "transition", current: "complaint", target: "reply" },
    { name: "release_reply", type: "release", current: "reply" },
    { name: "release_complaint", type: "release", current: "complaint" },
    { name: "release_manual_hold", type: "release", current: "manual_hold" },
  ] as const;
  it.each(protectedReplyStates.flatMap((state) => forbiddenGateOperations.map((operation) => ({ state, operation }))))(
    "rejects $operation.name while a $state reply attempt is protected without changing either record",
    ({ state, operation }) => {
      const sourceKey = `protected-${state}-${operation.name}`;
      const { database, draft } = setupDraft(sourceKey);
      const attempts = new ReplyAttemptRepository(database);
      const attempt = attempts.prepareWithReplyLock(draft.id, sourceKey).attempt;
      if (state === "submitting" || state === "submission_uncertain") attempts.markSubmitting(attempt.id);
      if (state === "submission_uncertain") attempts.markUncertain(attempt.id, "响应中断");
      if (state === "sent") database.prepare("UPDATE reply_attempts SET state = 'sent' WHERE id = ?").run(attempt.id);
      if (operation.current !== "reply") {
        database.prepare("UPDATE review_action_locks SET action_kind = ? WHERE source_key = ?")
          .run(operation.current, sourceKey);
      }
      const gate = new ReviewActionGate(database);
      const lock = gate.getLock("primary", sourceKey)!;
      const before = {
        attempt: database.prepare("SELECT * FROM reply_attempts WHERE id = ?").get(attempt.id),
        lock: database.prepare("SELECT * FROM review_action_locks WHERE source_key = ?").get(sourceKey),
      };

      const action = operation.type === "release"
        ? () => gate.release("primary", sourceKey, operation.current, lock.lockVersion)
        : () => gate.transition(
          "primary",
          sourceKey,
          operation.current,
          operation.target,
          lock.lockVersion,
        );
      expect(action).toThrowError(/活动回复提交/);
      expect({
        attempt: database.prepare("SELECT * FROM reply_attempts WHERE id = ?").get(attempt.id),
        lock: database.prepare("SELECT * FROM review_action_locks WHERE source_key = ?").get(sourceKey),
      }).toEqual(before);
      database.close();
    },
  );
});

describe("ReplyAttemptRepository lock lifecycle", () => {
  it.each([
    {
      name: "markSubmitting",
      prepareState: (_attempts: ReplyAttemptRepository, _id: string) => undefined,
      run: (attempts: ReplyAttemptRepository, id: string) => attempts.markSubmitting(id),
    },
    {
      name: "markPreSubmitFailed",
      prepareState: (_attempts: ReplyAttemptRepository, _id: string) => undefined,
      run: (attempts: ReplyAttemptRepository, id: string) => attempts.markPreSubmitFailed(id, "SAFE", "点击前失败"),
    },
    {
      name: "markFailed",
      prepareState: (_attempts: ReplyAttemptRepository, _id: string) => undefined,
      run: (attempts: ReplyAttemptRepository, id: string) => attempts.markFailed(id, "SAFE", "点击前失败"),
    },
    {
      name: "markUncertain",
      prepareState: (attempts: ReplyAttemptRepository, id: string) => attempts.markSubmitting(id),
      run: (attempts: ReplyAttemptRepository, id: string) => attempts.markUncertain(id, "响应中断"),
    },
    {
      name: "resolveUncertain(not_sent)",
      prepareState: (attempts: ReplyAttemptRepository, id: string) => {
        attempts.markSubmitting(id);
        attempts.markUncertain(id, "响应中断");
      },
      run: (attempts: ReplyAttemptRepository, id: string) => attempts.resolveUncertain(id, "not_sent", "平台显示未回复"),
    },
    {
      name: "markSent",
      prepareState: (attempts: ReplyAttemptRepository, id: string) => attempts.markSubmitting(id),
      run: (attempts: ReplyAttemptRepository, id: string) => attempts.markSent(id, "平台显示已回复"),
    },
  ])("$name fails closed when a tombstone abnormally coexists with the matching reply lock", ({ prepareState, run }) => {
    const sourceKey = `tombstone-${randomSuffix()}`;
    const { database, replies, draft } = setupDraft(sourceKey);
    const attempts = new ReplyAttemptRepository(database);
    const attempt = attempts.prepareWithReplyLock(draft.id, sourceKey).attempt;
    prepareState(attempts, attempt.id);
    database.prepare(`
      INSERT INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at)
      VALUES ('primary', ?, 'not_actionable', '2026-07-15T00:00:00.000Z')
    `).run(sourceKey);
    const before = {
      attempt: database.prepare("SELECT * FROM reply_attempts WHERE id = ?").get(attempt.id),
      draft: database.prepare("SELECT * FROM reply_drafts WHERE id = ?").get(draft.id),
      lock: database.prepare("SELECT * FROM review_action_locks WHERE source_key = ?").get(sourceKey),
      tombstone: database.prepare("SELECT * FROM review_action_tombstones WHERE source_key = ?").get(sourceKey),
    };

    expect(() => run(attempts, attempt.id)).toThrowError(/已经完成/);
    expect({
      attempt: database.prepare("SELECT * FROM reply_attempts WHERE id = ?").get(attempt.id),
      draft: database.prepare("SELECT * FROM reply_drafts WHERE id = ?").get(draft.id),
      lock: database.prepare("SELECT * FROM review_action_locks WHERE source_key = ?").get(sourceKey),
      tombstone: database.prepare("SELECT * FROM review_action_tombstones WHERE source_key = ?").get(sourceKey),
    }).toEqual(before);
    expect(replies.get(draft.id)).not.toBeNull();
    database.close();
  });

  it("prepares atomically, validates the saved lock version and preserves uncertain attempts", () => {
    const { database, replies, draft } = setupDraft("uncertain");
    const attempts = new ReplyAttemptRepository(database);
    const prepared = attempts.prepareWithReplyLock(draft.id, "uncertain");
    expect(prepared).toMatchObject({ created: true, attempt: { state: "pending", actionLockVersion: 1 } });
    expect(attempts.prepareWithReplyLock(draft.id, "uncertain")).toMatchObject({
      created: false, attempt: { id: prepared.attempt.id, state: "pending", actionLockVersion: 1 },
    });

    attempts.markSubmitting(prepared.attempt.id);
    attempts.markUncertain(prepared.attempt.id, "点击后响应中断");
    expect(attempts.prepareWithReplyLock(draft.id, "uncertain")).toMatchObject({
      created: false, attempt: { id: prepared.attempt.id, state: "submission_uncertain", actionLockVersion: 1 },
    });
    expect(new ReviewActionGate(database).getLock("primary", "uncertain")).toMatchObject({ actionKind: "reply", lockVersion: 1 });
    expect(replies.get(draft.id)?.state).toBe("submission_uncertain");
    database.close();
  });

  it("fails closed on a mismatched lock without partially mutating the attempt", () => {
    const { database, draft } = setupDraft("stale-lock");
    const attempts = new ReplyAttemptRepository(database);
    const prepared = attempts.prepareWithReplyLock(draft.id, "stale-lock").attempt;
    database.prepare("UPDATE review_action_locks SET lock_version = 2 WHERE source_key = 'stale-lock'").run();

    expect(() => attempts.markSubmitting(prepared.id)).toThrowError(/动作状态已发生变化/);
    expect(attempts.get(prepared.id)).toMatchObject({ state: "pending", actionLockVersion: 1 });
    database.close();
  });

  it("marks sent with a tombstone in the same transaction and cannot reopen it", () => {
    const { database, replies, draft } = setupDraft("sent");
    const attempts = new ReplyAttemptRepository(database);
    const attempt = attempts.prepareWithReplyLock(draft.id, "sent").attempt;
    attempts.markSubmitting(attempt.id);
    attempts.markSent(attempt.id, "平台显示已回复");

    expect(attempts.get(attempt.id)).toMatchObject({ state: "sent", evidence: "平台显示已回复" });
    expect(replies.get(draft.id)?.state).toBe("sent");
    expect(new ReviewActionGate(database).getTombstone("primary", "sent")).toMatchObject({ terminalAction: "reply_sent" });
    expect(attempts.prepareWithReplyLock(draft.id, "sent")).toMatchObject({
      created: false,
      attempt: { id: attempt.id, state: "sent" },
    });
    expect(() => new ReviewActionGate(database).acquire("primary", "sent", "manual_hold")).toThrowError(/已经完成/);
    database.close();
  });

  it("releases only a proven pre-click failure and retries with a new lock version", () => {
    const { database, replies, draft } = setupDraft("retry");
    const attempts = new ReplyAttemptRepository(database);
    const first = attempts.prepareWithReplyLock(draft.id, "retry").attempt;
    attempts.markSubmitting(first.id);
    attempts.markPreSubmitFailed(first.id, "ELEMENT_NOT_FOUND", "点击前未找到回复框");
    expect(new ReviewActionGate(database).getLock("primary", "retry")).toBeNull();
    expect(replies.get(draft.id)?.state).toBe("read_only_ready");

    const retry = attempts.prepareWithReplyLock(draft.id, "retry");
    expect(retry).toMatchObject({ created: true, attempt: { id: first.id, state: "pending", actionLockVersion: 2 } });
    database.close();
  });

  it("does not retry a failed attempt while its old reply lock still exists", () => {
    const { database, draft } = setupDraft("failed-stale-lock");
    const attempts = new ReplyAttemptRepository(database);
    const attempt = attempts.prepareWithReplyLock(draft.id, "failed-stale-lock").attempt;
    database.prepare("UPDATE reply_attempts SET state = 'failed' WHERE id = ?").run(attempt.id);
    database.prepare("UPDATE reply_attempts SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(attempt.id);

    const before = {
      attempt: database.prepare("SELECT * FROM reply_attempts WHERE id = ?").get(attempt.id),
      lock: database.prepare("SELECT * FROM review_action_locks WHERE source_key = ?").get("failed-stale-lock"),
    };

    expect(attempts.pruneOlderThan(180, new Date("2026-07-15T00:00:00.000Z"))).toBe(0);
    expect({
      attempt: database.prepare("SELECT * FROM reply_attempts WHERE id = ?").get(attempt.id),
      lock: database.prepare("SELECT * FROM review_action_locks WHERE source_key = ?").get("failed-stale-lock"),
    }).toEqual(before);
    expect(() => attempts.prepareWithReplyLock(draft.id, "failed-stale-lock")).toThrowError(/动作状态已发生变化/);
    expect(attempts.get(attempt.id)).toMatchObject({ state: "failed", actionLockVersion: 1 });
    expect(new ReviewActionGate(database).getLock("primary", "failed-stale-lock")).toMatchObject({ lockVersion: 1 });
    database.close();
  });

  it("prunes an old failed audit after its reply lock was safely released", () => {
    const { database, draft } = setupDraft("failed-without-lock");
    const attempts = new ReplyAttemptRepository(database);
    const attempt = attempts.prepareWithReplyLock(draft.id, "failed-without-lock").attempt;
    attempts.markFailed(attempt.id, "SAFE_PRE_CLICK", "确认未点击平台按钮");
    database.prepare("UPDATE reply_attempts SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(attempt.id);

    expect(new ReviewActionGate(database).getLock("primary", "failed-without-lock")).toBeNull();
    expect(attempts.pruneOlderThan(180, new Date("2026-07-15T00:00:00.000Z"))).toBe(1);
    expect(attempts.get(attempt.id)).toBeNull();
    database.close();
  });

  it.each([
    "discovered", "classifying", "template_selected", "rewriting", "failed",
    "manual_product_hold", "not_actionable", "manual_hold_expired", "sent", "submitting", "submission_uncertain",
  ])("does not create an attempt for a %s draft even when its lock is corrupted to reply", (state) => {
    const sourceKey = `non-preparable-${state}`;
    const { database, draft } = setupDraft(sourceKey);
    database.prepare("UPDATE reply_drafts SET state = ? WHERE id = ?").run(state, draft.id);
    const gate = new ReviewActionGate(database);
    gate.acquire("primary", sourceKey, "reply");
    const before = {
      draft: database.prepare("SELECT * FROM reply_drafts WHERE id = ?").get(draft.id),
      lock: database.prepare("SELECT * FROM review_action_locks WHERE source_key = ?").get(sourceKey),
      attempts: database.prepare("SELECT COUNT(*) AS value FROM reply_attempts WHERE source_key = ?").get(sourceKey),
    };

    expect(() => new ReplyAttemptRepository(database).prepareWithReplyLock(draft.id, sourceKey)).toThrowError(/草稿状态/);
    expect({
      draft: database.prepare("SELECT * FROM reply_drafts WHERE id = ?").get(draft.id),
      lock: database.prepare("SELECT * FROM review_action_locks WHERE source_key = ?").get(sourceKey),
      attempts: database.prepare("SELECT COUNT(*) AS value FROM reply_attempts WHERE source_key = ?").get(sourceKey),
    }).toEqual(before);
    database.close();
  });

  it("resolves an uncertain outcome only with evidence", () => {
    const { database, replies, draft } = setupDraft("resolve");
    const attempts = new ReplyAttemptRepository(database);
    const attempt = attempts.prepareWithReplyLock(draft.id, "resolve").attempt;
    attempts.markSubmitting(attempt.id);
    attempts.markUncertain(attempt.id, "响应丢失");
    expect(() => attempts.resolveUncertain(attempt.id, "not_sent", " ")).toThrowError(/核对证据/);
    expect(attempts.resolveUncertain(attempt.id, "not_sent", "平台显示未回复")).toMatchObject({ state: "failed" });
    expect(new ReviewActionGate(database).getLock("primary", "resolve")).toBeNull();
    expect(replies.get(draft.id)?.state).toBe("read_only_ready");
    database.close();
  });

  it("resolves a confirmed sent uncertain attempt into a terminal tombstone", () => {
    const { database, replies, draft } = setupDraft("resolve-sent");
    const attempts = new ReplyAttemptRepository(database);
    const attempt = attempts.prepareWithReplyLock(draft.id, "resolve-sent").attempt;
    attempts.markSubmitting(attempt.id);
    attempts.markUncertain(attempt.id, "响应丢失");

    expect(attempts.resolveUncertain(attempt.id, "sent", "人工核对平台已回复")).toMatchObject({ state: "sent" });
    expect(replies.get(draft.id)?.state).toBe("sent");
    expect(new ReviewActionGate(database).getLock("primary", "resolve-sent")).toBeNull();
    expect(new ReviewActionGate(database).getTombstone("primary", "resolve-sent")).toMatchObject({ terminalAction: "reply_sent" });
    database.close();
  });

  it("rejects sent and uncertain transitions before submitting and preserves the pending lock", () => {
    const { database, draft } = setupDraft("pending-transition");
    const attempts = new ReplyAttemptRepository(database);
    const attempt = attempts.prepareWithReplyLock(draft.id, "pending-transition").attempt;

    expect(() => attempts.markSent(attempt.id, "伪成功证据")).toThrowError(/当前状态不允许/);
    expect(() => attempts.markUncertain(attempt.id, "伪不确定证据")).toThrowError(/当前状态不允许/);
    expect(attempts.get(attempt.id)).toMatchObject({ state: "pending", actionLockVersion: 1 });
    expect(new ReviewActionGate(database).getLock("primary", "pending-transition")).toMatchObject({ actionKind: "reply", lockVersion: 1 });
    database.close();
  });

  it("returns an existing submitting attempt without resetting its lock", () => {
    const { database, draft } = setupDraft("submitting-duplicate");
    const attempts = new ReplyAttemptRepository(database);
    const attempt = attempts.prepareWithReplyLock(draft.id, "submitting-duplicate").attempt;
    attempts.markSubmitting(attempt.id);

    expect(attempts.prepareWithReplyLock(draft.id, "submitting-duplicate")).toMatchObject({
      created: false,
      attempt: { id: attempt.id, state: "submitting", actionLockVersion: 1 },
    });
    expect(new ReviewActionGate(database).getLock("primary", "submitting-duplicate")).toMatchObject({ lockVersion: 1 });
    database.close();
  });
});

function randomSuffix(): string {
  sourceSequence += 1;
  return String(sourceSequence);
}

describe("manual hold scan evidence and compaction", () => {
  it("ordinary cleanup protects pending attempts and their read-only-ready drafts", () => {
    const { database, replies, draft } = setupDraft("old-pending", "2026-01-01 08:00");
    const attempts = new ReplyAttemptRepository(database);
    const attempt = attempts.prepareWithReplyLock(draft.id, "old-pending").attempt;
    database.prepare("UPDATE reply_attempts SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(attempt.id);
    database.prepare("UPDATE reply_drafts SET discovered_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(draft.id);

    expect(replies.get(draft.id)?.state).toBe("read_only_ready");
    expect(attempts.pruneOlderThan(180, new Date("2026-07-15T00:00:00.000Z"))).toBe(0);
    expect(replies.pruneOlderThan(90, new Date("2026-07-15T00:00:00.000Z"))).toBe(0);
    expect(attempts.get(attempt.id)).toMatchObject({ state: "pending", replyDraftId: draft.id });
    expect(replies.get(draft.id)).not.toBeNull();
    expect(new ReviewActionGate(database).getLock("primary", "old-pending")).toMatchObject({ actionKind: "reply" });
    database.close();
  });

  it("ordinary review cleanup protects a draft with any active action lock", () => {
    const { database, replies, draft } = setupDraft("old-complaint-lock", "2026-01-01 08:00");
    new ReviewActionGate(database).acquire("primary", "old-complaint-lock", "complaint");
    database.prepare("UPDATE reply_drafts SET discovered_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(draft.id);

    expect(replies.pruneOlderThan(90, new Date("2026-07-15T00:00:00.000Z"))).toBe(0);
    expect(replies.get(draft.id)).not.toBeNull();
    expect(new ReviewActionGate(database).getLock("primary", "old-complaint-lock")).toMatchObject({ actionKind: "complaint" });
    database.close();
  });

  it("ordinary review cleanup never deletes an active manual hold", () => {
    const { database, replies, draft } = setupDraft("active-old-hold", "2026-01-01 08:00");
    replies.markManualProductHold(draft.id, {
      storeId: "primary", manualProductId: null, catalogRevision: 1, matchKind: "item_id", reason: "人工处理",
    });
    database.prepare("UPDATE reply_drafts SET discovered_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(draft.id);

    expect(replies.pruneOlderThan(90, new Date("2026-07-15T00:00:00.000Z"))).toBe(0);
    expect(replies.get(draft.id)).toMatchObject({ state: "manual_product_hold" });
    expect(new ReviewActionGate(database).getLock("primary", "active-old-hold")).toMatchObject({ actionKind: "manual_hold" });
    database.close();
  });

  it("counts only complete in-scope scans and finalizes after two absences", () => {
    const { database, replies, draft } = setupDraft("scan", "2026-07-15 08:00");
    replies.markManualProductHold(draft.id, {
      storeId: "primary", manualProductId: null, catalogRevision: 1, matchKind: "item_id", reason: "人工处理",
    });
    const scan = { storeId: "primary", scopeStartDate: "2026-07-15", scopeEndDate: "2026-07-15", seenSourceKeys: [] as string[] };

    expect(replies.recordManualHoldScanEvidence({ ...scan, complete: false })).toMatchObject({ finalized: 0 });
    expect(replies.get(draft.id)?.manualHoldAbsentScans).toBe(0);
    expect(replies.recordManualHoldScanEvidence({ ...scan, complete: true })).toMatchObject({ finalized: 0 });
    expect(replies.get(draft.id)?.manualHoldAbsentScans).toBe(1);
    expect(replies.recordManualHoldScanEvidence({ ...scan, complete: true })).toMatchObject({ finalized: 1 });
    expect(replies.get(draft.id)?.state).toBe("not_actionable");
    expect(new ReviewActionGate(database).getLock("primary", "scan")).toBeNull();
    expect(new ReviewActionGate(database).getTombstone("primary", "scan")).toMatchObject({ terminalAction: "not_actionable" });
    database.close();
  });

  it("resets seen holds and ignores an absence outside the frozen date range", () => {
    const { database, replies, draft } = setupDraft("seen", "2026-07-15 08:00");
    replies.markManualProductHold(draft.id, {
      storeId: "primary", manualProductId: null, catalogRevision: 1, matchKind: "item_id", reason: "人工处理",
    });
    replies.recordManualHoldScanEvidence({ storeId: "primary", scopeStartDate: "2026-07-15", scopeEndDate: "2026-07-15", seenSourceKeys: [], complete: true });
    replies.recordManualHoldScanEvidence({ storeId: "primary", scopeStartDate: "2026-07-15", scopeEndDate: "2026-07-15", seenSourceKeys: ["seen"], complete: true });
    expect(replies.get(draft.id)?.manualHoldAbsentScans).toBe(0);
    replies.recordManualHoldScanEvidence({ storeId: "primary", scopeStartDate: "2026-07-01", scopeEndDate: "2026-07-14", seenSourceKeys: [], complete: true });
    expect(replies.get(draft.id)?.manualHoldAbsentScans).toBe(0);
    database.close();
  });

  it("interprets UTC review timestamps by the frozen Asia/Shanghai calendar day", () => {
    const { database, replies, draft } = setupDraft("utc-cross-day", "2026-07-14T16:30:00Z");
    replies.markManualProductHold(draft.id, {
      storeId: "primary", manualProductId: null, catalogRevision: 1, matchKind: "item_id", reason: "人工处理",
    });

    expect(replies.recordManualHoldScanEvidence({
      storeId: "primary", scopeStartDate: "2026-07-15", scopeEndDate: "2026-07-15",
      seenSourceKeys: [], complete: true,
    })).toMatchObject({ absent: 1, finalized: 0 });
    expect(replies.get(draft.id)?.manualHoldAbsentScans).toBe(1);
    database.close();
  });

  it("does not count an explicit-offset review whose Shanghai day is outside the frozen scope", () => {
    const { database, replies, draft } = setupDraft("offset-cross-day", "2026-07-15T23:30:00-07:00");
    replies.markManualProductHold(draft.id, {
      storeId: "primary", manualProductId: null, catalogRevision: 1, matchKind: "item_id", reason: "人工处理",
    });
    const scan = {
      storeId: "primary", scopeStartDate: "2026-07-15", scopeEndDate: "2026-07-15",
      seenSourceKeys: [] as string[], complete: true,
    };

    expect(replies.recordManualHoldScanEvidence(scan)).toMatchObject({ absent: 0, finalized: 0 });
    expect(replies.recordManualHoldScanEvidence(scan)).toMatchObject({ absent: 0, finalized: 0 });
    expect(replies.get(draft.id)).toMatchObject({ state: "manual_product_hold", manualHoldAbsentScans: 0 });
    database.close();
  });

  it("fails closed on an invalid frozen scope without changing hold evidence", () => {
    const { database, replies, draft } = setupDraft("invalid-frozen-scope", "2026-07-15 08:00");
    replies.markManualProductHold(draft.id, {
      storeId: "primary", manualProductId: null, catalogRevision: 1, matchKind: "item_id", reason: "人工处理",
    });
    const before = replies.get(draft.id);

    expect(() => replies.recordManualHoldScanEvidence({
      storeId: "primary", scopeStartDate: "2026-07-20", scopeEndDate: "2026-07-15",
      seenSourceKeys: [], complete: true,
    })).toThrowError(/Start date/);
    expect(replies.get(draft.id)).toEqual(before);
    database.close();
  });

  it("compacts an old inactive hold into an expiry tombstone without touching attempted reviews", () => {
    const { database, replies, draft } = setupDraft("old", "2026-01-01 08:00");
    replies.markManualProductHold(draft.id, {
      storeId: "primary", manualProductId: null, catalogRevision: 1, matchKind: "item_id", reason: "人工处理",
    });
    database.prepare("UPDATE reply_drafts SET discovered_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(draft.id);

    expect(replies.compactExpiredManualHolds(90, new Date("2026-07-15T00:00:00.000Z"))).toBe(1);
    expect(replies.get(draft.id)?.state).toBe("manual_hold_expired");
    expect(new ReviewActionGate(database).getLock("primary", "old")).toBeNull();
    expect(new ReviewActionGate(database).getTombstone("primary", "old")).toMatchObject({ terminalAction: "manual_hold_expired" });
    expect(replies.pruneOlderThan(90, new Date("2026-07-15T00:00:00.000Z"))).toBe(1);
    expect(replies.get(draft.id)).toBeNull();
    expect(new ReviewActionGate(database).getTombstone("primary", "old")).toMatchObject({ terminalAction: "manual_hold_expired" });
    database.close();
  });

  it("compacts an old manual hold while preserving its failed pre-click audit", () => {
    const { database, replies, draft } = setupDraft("old-failed-audit", "2026-01-01 08:00");
    const attempts = new ReplyAttemptRepository(database);
    const attempt = attempts.prepareWithReplyLock(draft.id, "old-failed-audit").attempt;
    attempts.markFailed(attempt.id, "SAFE_PRE_CLICK", "确认未点击平台按钮");
    replies.markManualProductHold(draft.id, {
      storeId: "primary", manualProductId: null, catalogRevision: 1, matchKind: "item_id", reason: "人工处理",
    });
    database.prepare("UPDATE reply_drafts SET discovered_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(draft.id);

    expect(replies.compactExpiredManualHolds(90, new Date("2026-07-15T00:00:00.000Z"))).toBe(1);
    expect(replies.get(draft.id)).toMatchObject({ state: "manual_hold_expired" });
    expect(attempts.get(attempt.id)).toMatchObject({ state: "failed", replyDraftId: draft.id });
    expect(new ReviewActionGate(database).getLock("primary", "old-failed-audit")).toBeNull();
    expect(new ReviewActionGate(database).getTombstone("primary", "old-failed-audit"))
      .toMatchObject({ terminalAction: "manual_hold_expired" });
    database.close();
  });
});
