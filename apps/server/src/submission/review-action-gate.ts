import type { AppDatabase } from "../storage/database";

export type ReviewActionKind = "manual_hold" | "complaint" | "reply";

export interface ReviewActionLock {
  storeId: string;
  sourceKey: string;
  actionKind: ReviewActionKind;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewActionTombstone {
  storeId: string;
  sourceKey: string;
  terminalAction: string;
  completedAt: string;
}

export class ReviewActionConflictError extends Error {
  readonly code: "ACTION_CONFLICT" | "ACTION_VERSION_CONFLICT" | "ACTION_TERMINAL";

  constructor(code: ReviewActionConflictError["code"], message: string) {
    super(message);
    this.name = "ReviewActionConflictError";
    this.code = code;
  }
}

type LockRow = {
  store_id: string;
  source_key: string;
  action_kind: ReviewActionKind;
  lock_version: number;
  created_at: string;
  updated_at: string;
};

type TombstoneRow = {
  store_id: string;
  source_key: string;
  terminal_action: string;
  completed_at: string;
};

export class ReviewActionGate {
  constructor(private readonly database: AppDatabase) {}

  getLock(storeId: string, sourceKey: string): ReviewActionLock | null {
    const row = this.database.prepare(`
      SELECT * FROM review_action_locks WHERE store_id = ? AND source_key = ?
    `).get(storeId, sourceKey) as LockRow | undefined;
    return row ? this.mapLock(row) : null;
  }

  getTombstone(storeId: string, sourceKey: string): ReviewActionTombstone | null {
    const row = this.database.prepare(`
      SELECT * FROM review_action_tombstones WHERE store_id = ? AND source_key = ?
    `).get(storeId, sourceKey) as TombstoneRow | undefined;
    return row ? {
      storeId: row.store_id,
      sourceKey: row.source_key,
      terminalAction: row.terminal_action,
      completedAt: row.completed_at,
    } : null;
  }

  pruneTombstonesOlderThan(retentionDays: number, now = new Date()): number {
    if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error("终结记录保留天数必须大于 0");
    const cutoff = new Date(now.getTime() - Math.trunc(retentionDays) * 86_400_000).toISOString();
    return this.database.prepare("DELETE FROM review_action_tombstones WHERE completed_at < ?").run(cutoff).changes;
  }

  acquire(
    storeId: string,
    sourceKey: string,
    actionKind: ReviewActionKind,
    initialVersion = 1,
  ): ReviewActionLock {
    return this.database.transaction(() => {
      this.assertNotTerminal(storeId, sourceKey);
      const current = this.getLock(storeId, sourceKey);
      if (current) {
        if (current.actionKind !== actionKind) {
          throw new ReviewActionConflictError("ACTION_CONFLICT", "该评价已有其他处理动作，不能重复操作");
        }
        return current;
      }
      if (!Number.isSafeInteger(initialVersion) || initialVersion < 1) {
        throw new ReviewActionConflictError("ACTION_VERSION_CONFLICT", "动作状态已发生变化，请重新读取后再试");
      }
      if (actionKind === "manual_hold") this.assertManualHoldMayStart(storeId, sourceKey);
      const now = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO review_action_locks(
          store_id, source_key, action_kind, lock_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(storeId, sourceKey, actionKind, initialVersion, now, now);
      return this.getLock(storeId, sourceKey)!;
    }).immediate();
  }

  transition(
    storeId: string,
    sourceKey: string,
    from: ReviewActionKind,
    to: ReviewActionKind,
    expectedVersion: number,
  ): ReviewActionLock {
    return this.database.transaction(() => {
      this.assertNotTerminal(storeId, sourceKey);
      this.assertNoProtectedReplyAttempt(sourceKey);
      if (from === "manual_hold") {
        const current = this.getLock(storeId, sourceKey);
        if (!current || current.actionKind !== from || current.lockVersion !== expectedVersion) {
          this.throwLockConflict(storeId, sourceKey);
        }
        throw new ReviewActionConflictError("ACTION_CONFLICT", "人工处理必须先解除，再重新获取其他处理动作");
      }
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        UPDATE review_action_locks
        SET action_kind = ?, lock_version = lock_version + 1, updated_at = ?
        WHERE store_id = ? AND source_key = ? AND action_kind = ? AND lock_version = ?
      `).run(to, now, storeId, sourceKey, from, expectedVersion);
      if (result.changes !== 1) this.throwLockConflict(storeId, sourceKey);
      return this.getLock(storeId, sourceKey)!;
    }).immediate();
  }

  release(
    storeId: string,
    sourceKey: string,
    actionKind: ReviewActionKind,
    expectedVersion: number,
  ): boolean {
    return this.database.transaction(() => {
      this.assertNotTerminal(storeId, sourceKey);
      this.assertNoProtectedReplyAttempt(sourceKey);
      const result = this.database.prepare(`
        DELETE FROM review_action_locks
        WHERE store_id = ? AND source_key = ? AND action_kind = ? AND lock_version = ?
      `).run(storeId, sourceKey, actionKind, expectedVersion);
      if (result.changes !== 1) this.throwLockConflict(storeId, sourceKey);
      return true;
    }).immediate();
  }

  releaseManualHold(storeId: string, sourceKey: string, expectedVersion: number): boolean {
    return this.database.transaction(() => {
      this.assertNotTerminal(storeId, sourceKey);
      this.assertNoProtectedReplyAttempt(sourceKey);
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        DELETE FROM review_action_locks
        WHERE store_id = ? AND source_key = ? AND action_kind = 'manual_hold' AND lock_version = ?
      `).run(storeId, sourceKey, expectedVersion);
      if (result.changes !== 1) this.throwLockConflict(storeId, sourceKey);
      this.database.prepare(`
        UPDATE reply_drafts
        SET state = 'discovered', manual_product_id = NULL, manual_hold_reason = NULL,
            manual_catalog_revision = NULL, manual_match_kind = NULL,
            manual_hold_last_seen_at = NULL, manual_hold_absent_scans = 0,
            processed_at = NULL, updated_at = ?
        WHERE source_key = ? AND state = 'manual_product_hold'
      `).run(now, sourceKey);
      return true;
    }).immediate();
  }

  complete(
    storeId: string,
    sourceKey: string,
    actionKind: "complaint",
    expectedVersion: number,
    terminalAction: "complaint_upheld",
    completedAt?: Date,
  ): void;
  complete(
    storeId: string,
    sourceKey: string,
    actionKind: ReviewActionKind,
    expectedVersion: number,
    terminalAction: string,
    completedAt = new Date(),
  ): void {
    this.database.transaction(() => {
      this.assertNotTerminal(storeId, sourceKey);
      this.assertNoProtectedReplyAttempt(sourceKey);
      const validCompletion = actionKind === "complaint" && terminalAction === "complaint_upheld";
      if (!validCompletion) {
        throw new ReviewActionConflictError("ACTION_CONFLICT", "该处理动作不能写入指定的完成状态");
      }
      const removed = this.database.prepare(`
        DELETE FROM review_action_locks
        WHERE store_id = ? AND source_key = ? AND action_kind = ? AND lock_version = ?
      `).run(storeId, sourceKey, actionKind, expectedVersion);
      if (removed.changes !== 1) this.throwLockConflict(storeId, sourceKey);
      this.database.prepare(`
        INSERT INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at)
        VALUES (?, ?, ?, ?)
      `).run(storeId, sourceKey, terminalAction, completedAt.toISOString());
    }).immediate();
  }

  private assertNotTerminal(storeId: string, sourceKey: string): void {
    if (this.getTombstone(storeId, sourceKey)) {
      throw new ReviewActionConflictError("ACTION_TERMINAL", "该评价已经完成处理，不能再次操作");
    }
  }

  private assertManualHoldMayStart(_storeId: string, sourceKey: string): void {
    this.assertNoProtectedReplyAttempt(sourceKey);
  }

  private assertNoProtectedReplyAttempt(sourceKey: string): void {
    const protectedAttempt = this.database.prepare(`
      SELECT 1 FROM reply_attempts
      WHERE source_key = ? AND state IN ('pending', 'submitting', 'sent', 'submission_uncertain')
      LIMIT 1
    `).get(sourceKey);
    if (protectedAttempt) {
      throw new ReviewActionConflictError("ACTION_CONFLICT", "该评价存在活动回复提交，不能改变动作锁");
    }
  }

  private throwLockConflict(storeId: string, sourceKey: string): never {
    const current = this.getLock(storeId, sourceKey);
    if (current) {
      throw new ReviewActionConflictError("ACTION_VERSION_CONFLICT", "动作状态已发生变化，请重新读取后再试");
    }
    throw new ReviewActionConflictError("ACTION_CONFLICT", "该评价当前没有可转换的处理动作");
  }

  private mapLock(row: LockRow): ReviewActionLock {
    return {
      storeId: row.store_id,
      sourceKey: row.source_key,
      actionKind: row.action_kind,
      lockVersion: row.lock_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
