import {
  validateReviewScopeInput,
  type ReviewScopeConfig,
  type ReviewScopePreset,
} from "@tmall/domain";
import type { AppDatabase } from "./database";

export class RevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";

  constructor(readonly currentRevision: number) {
    super("配置已发生变化，请刷新后重试");
    this.name = "RevisionConflictError";
  }
}

export interface PersistedReviewScope {
  preset: ReviewScopePreset;
  startDate: string | null;
  endDate: string | null;
  timezone: "Asia/Shanghai";
  revision: number;
  updatedAt: string;
}

type ReviewScopeRow = {
  preset: ReviewScopePreset;
  custom_start_date: string | null;
  custom_end_date: string | null;
  timezone: "Asia/Shanghai";
  revision: number;
  updated_at: string;
};

export class ReviewScopeRepository {
  constructor(private readonly database: AppDatabase) {}

  get(): PersistedReviewScope {
    const row = this.database.prepare("SELECT * FROM review_scope WHERE id = 1").get() as ReviewScopeRow | undefined;
    if (!row) throw new Error("评价日期范围尚未初始化");
    return this.map(row);
  }

  save(input: ReviewScopeConfig, expectedRevision: number): PersistedReviewScope {
    const normalized = validateReviewScopeInput(input);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new RevisionConflictError(this.get().revision);
    }
    return this.database.transaction(() => {
      const current = this.get();
      if (current.revision !== expectedRevision) throw new RevisionConflictError(current.revision);
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        UPDATE review_scope
        SET preset = ?, custom_start_date = ?, custom_end_date = ?, revision = revision + 1, updated_at = ?
        WHERE id = 1 AND revision = ?
      `).run(
        normalized.preset,
        normalized.preset === "custom" ? normalized.startDate : null,
        normalized.preset === "custom" ? normalized.endDate : null,
        now,
        expectedRevision,
      );
      if (result.changes !== 1) throw new RevisionConflictError(this.get().revision);
      return this.get();
    }).immediate();
  }

  private map(row: ReviewScopeRow): PersistedReviewScope {
    return {
      preset: row.preset,
      startDate: row.custom_start_date,
      endDate: row.custom_end_date,
      timezone: row.timezone,
      revision: row.revision,
      updatedAt: row.updated_at,
    };
  }
}
