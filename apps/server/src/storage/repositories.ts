import { randomUUID } from "node:crypto";
import {
  isReviewedAtWithinScope,
  minutesToTime,
  resolveReviewScope,
  timeToMinutes,
  validateAutomationPlan,
  FIXED_TEMPLATE_SCHEMAS,
  type AutomationPlan,
  type AutomationTrigger,
  type NormalizedTemplate,
  type ResolvedReviewScope,
  type ReviewScopePreset,
  type TemplateLibrary,
} from "@tmall/domain";
import type { TmallReviewSnapshot } from "../tmall/review-reader";
import { ReviewActionConflictError, ReviewActionGate } from "../submission/review-action-gate";
import type { AppDatabase } from "./database";

export interface TemplateSourceInput {
  library: TemplateLibrary;
  url: string;
  appToken: string;
  tableId: string;
  viewId: string | null;
}

export interface TemplateVersionInput {
  library: TemplateLibrary;
  contentHash: string;
  sourceRecordCount: number;
  templates: NormalizedTemplate[];
  warnings: string[];
}

export interface ActiveTemplateCategory extends NormalizedTemplate {
  replies: Array<{ sequence: number; text: string }>;
}

export class SettingsRepository {
  constructor(private readonly database: AppDatabase) {}

  get<T = unknown>(key: string): T | null {
    const row = this.database.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : null;
  }

  set(key: string, value: unknown): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), now);
  }
}

export interface AutomationRunRecord {
  id: string;
  trigger: AutomationTrigger;
  state: string;
  processed: number;
  succeeded: number;
  manual: number;
  failed: number;
  stopReason: string | null;
  startedAt: string;
  finishedAt: string | null;
  scope: AutomationRunScopeSnapshot | null;
}

export type TemplateSourceHealth =
  | { state: "ready"; usable: true; activeVersionId: number }
  | {
      state: "usable_with_warning";
      usable: true;
      activeVersionId: number;
      warning: { code: string };
    }
  | {
      state: "not_ready";
      usable: false;
      reason: "source_not_configured" | "active_version_missing" | "active_version_invalid";
    };

export interface AutomationRunScopeSnapshot {
  preset: ReviewScopePreset;
  startDate: string;
  endDate: string;
  revision: number;
  timezone: "Asia/Shanghai";
}

export interface PersistedAutomationPlan extends AutomationPlan {
  revision: number;
}

export class AutomationPlanRevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";

  constructor(readonly currentRevision: number) {
    super("自动计划已在其他页面修改，请刷新后重试");
    this.name = "AutomationPlanRevisionConflictError";
  }
}

export class AutomationRepository {
  constructor(private readonly database: AppDatabase) {}

  getPlan(): PersistedAutomationPlan {
    const row = this.database.prepare("SELECT * FROM automation_plan WHERE id = 1").get() as {
      enabled: number; paused: number; timezone: string; interval_minutes: number; revision: number;
    } | undefined;
    if (!row) return { ...validateAutomationPlan({ enabled: false, paused: false, intervalMinutes: 15, windows: [] }), revision: 1 };
    const windows = this.database.prepare("SELECT id, start_minute, end_minute FROM schedule_windows WHERE plan_id = 1 ORDER BY sort_order")
      .all() as Array<{ id: string; start_minute: number; end_minute: number }>;
    return {
      ...validateAutomationPlan({
      enabled: row.enabled === 1,
      paused: row.paused === 1,
      intervalMinutes: row.interval_minutes,
      windows: windows.map((window) => ({ id: window.id, start: minutesToTime(window.start_minute), end: minutesToTime(window.end_minute) })),
      }),
      revision: row.revision,
    };
  }

  savePlan(input: AutomationPlan, expectedRevision: number): PersistedAutomationPlan {
    const plan = validateAutomationPlan(input);
    return this.database.transaction(() => {
      const current = this.getPlan();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || current.revision !== expectedRevision) {
        throw new AutomationPlanRevisionConflictError(current.revision);
      }
      const now = new Date().toISOString();
      const exists = this.database.prepare("SELECT 1 FROM automation_plan WHERE id = 1").get();
      if (!exists) {
        this.database.prepare(`
          INSERT INTO automation_plan(id, enabled, paused, timezone, interval_minutes, revision, updated_at)
          VALUES (1, ?, ?, 'Asia/Shanghai', ?, 2, ?)
        `).run(plan.enabled ? 1 : 0, plan.paused ? 1 : 0, plan.intervalMinutes, now);
      } else {
        const updated = this.database.prepare(`
          UPDATE automation_plan
          SET enabled = ?, paused = ?, timezone = 'Asia/Shanghai', interval_minutes = ?,
            revision = revision + 1, updated_at = ?
          WHERE id = 1 AND revision = ?
        `).run(plan.enabled ? 1 : 0, plan.paused ? 1 : 0, plan.intervalMinutes, now, expectedRevision);
        if (updated.changes !== 1) throw new AutomationPlanRevisionConflictError(this.getPlan().revision);
      }
      this.database.prepare("DELETE FROM schedule_windows WHERE plan_id = 1").run();
      const insert = this.database.prepare("INSERT INTO schedule_windows(id, plan_id, start_minute, end_minute, sort_order) VALUES (?, 1, ?, ?, ?)");
      plan.windows.forEach((window, index) => insert.run(window.id, timeToMinutes(window.start), timeToMinutes(window.end), index));
      return this.getPlan();
    }).immediate();
  }

  setPaused(paused: boolean): PersistedAutomationPlan {
    return this.mutatePlan((plan) => ({ ...plan, paused }));
  }

  disable(): PersistedAutomationPlan {
    return this.mutatePlan((plan) => ({ ...plan, enabled: false, paused: false }));
  }

  private mutatePlan(mutator: (plan: PersistedAutomationPlan) => AutomationPlan): PersistedAutomationPlan {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = this.getPlan();
      try {
        return this.savePlan(mutator(current), current.revision);
      } catch (error) {
        if (!(error instanceof AutomationPlanRevisionConflictError) || attempt === 1) throw error;
      }
    }
    throw new Error("自动计划更新失败");
  }

  createRun(trigger: AutomationTrigger, scope: AutomationRunScopeSnapshot, at = new Date()): string {
    const id = randomUUID();
    return this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO automation_runs(
          id, trigger_type, state, started_at,
          scope_preset, scope_start_date, scope_end_date, scope_revision, scope_timezone
        ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        trigger,
        at.toISOString(),
        scope.preset,
        scope.startDate,
        scope.endDate,
        scope.revision,
        scope.timezone,
      );
      return id;
    }).immediate();
  }

  finishRun(id: string, input: { state: string; processed: number; succeeded: number; manual: number; failed: number; stopReason: string; at?: Date }): boolean {
    const result = this.database.prepare(`
      UPDATE automation_runs
      SET state = ?, processed_count = ?, succeeded_count = ?, manual_count = ?, failed_count = ?, stop_reason = ?, finished_at = ?
      WHERE id = ? AND state = 'running'
    `).run(input.state, input.processed, input.succeeded, input.manual, input.failed, input.stopReason, (input.at ?? new Date()).toISOString(), id);
    return result.changes === 1;
  }

  recoverInterruptedRuns(at = new Date()): number {
    return this.database.prepare(`
      UPDATE automation_runs
      SET state = 'interrupted', stop_reason = 'application_restarted', finished_at = ?
      WHERE state = 'running' AND finished_at IS NULL
    `).run(at.toISOString()).changes;
  }

  getLastRun(): AutomationRunRecord | null {
    const row = this.database.prepare("SELECT * FROM automation_runs ORDER BY started_at DESC, rowid DESC LIMIT 1").get() as {
      id: string; trigger_type: AutomationTrigger; state: string; processed_count: number; succeeded_count: number;
      manual_count: number; failed_count: number; stop_reason: string | null; started_at: string; finished_at: string | null;
      scope_preset: ReviewScopePreset | null; scope_start_date: string | null; scope_end_date: string | null;
      scope_revision: number | null; scope_timezone: "Asia/Shanghai" | null;
    } | undefined;
    return row ? {
      id: row.id,
      trigger: row.trigger_type,
      state: row.state,
      processed: row.processed_count,
      succeeded: row.succeeded_count,
      manual: row.manual_count,
      failed: row.failed_count,
      stopReason: row.stop_reason,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      scope: row.scope_preset && row.scope_start_date && row.scope_end_date && row.scope_revision && row.scope_timezone
        ? {
            preset: row.scope_preset,
            startDate: row.scope_start_date,
            endDate: row.scope_end_date,
            revision: row.scope_revision,
            timezone: row.scope_timezone,
          }
        : null,
    } : null;
  }

  pruneRuns(retentionDays: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    return this.database.prepare("DELETE FROM automation_runs WHERE started_at < ? AND state != 'running' AND finished_at IS NOT NULL").run(cutoff).changes;
  }
}

export interface LocatorRecord {
  operationKey: string;
  label: string;
  risk: "low" | "high";
  health: "healthy" | "recovered" | "attention";
  version: number;
  strategy: string;
  selector: string;
  lastSuccessAt: string | null;
}

export interface LocatorRepairRecord {
  id: string;
  operationKey: string;
  label: string;
  risk: "low" | "high";
  status: "pending_approval" | "auto_applied" | "approved" | "rejected" | "rolled_back";
  candidateVersionId: number | null;
  evidenceSummary: string;
  createdAt: string;
  resolvedAt: string | null;
  canRollback: boolean;
}

const SAFE_POPUP_CLOSE_SELECTOR = "[aria-label='关闭'], [title='关闭'], .next-dialog-close";
const OBSOLETE_BROAD_POPUP_CLOSE_SELECTOR = `${SAFE_POPUP_CLOSE_SELECTOR}, [class*='close']`;

const DEFAULT_LOCATORS: Array<{ operationKey: string; label: string; risk: "low" | "high"; strategy: string; selector: string }> = [
  { operationKey: "login.account", label: "登录账号框", risk: "low", strategy: "placeholder", selector: "账号名/邮箱/手机号" },
  { operationKey: "login.password", label: "登录密码框", risk: "low", strategy: "placeholder", selector: "请输入登录密码" },
  { operationKey: "login.submit", label: "登录按钮", risk: "low", strategy: "role", selector: "button:登录" },
  { operationKey: "navigation.trade", label: "交易菜单", risk: "low", strategy: "text", selector: "交易" },
  { operationKey: "navigation.reviews", label: "评价管理入口", risk: "low", strategy: "text", selector: "评价管理" },
  { operationKey: "review.filter.buyer", label: "来自买家的评价", risk: "low", strategy: "text", selector: "来自买家的评价" },
  { operationKey: "review.filter.content", label: "有内容筛选", risk: "low", strategy: "text", selector: "有内容" },
  { operationKey: "review.filter.unanswered", label: "未回复筛选", risk: "low", strategy: "text", selector: "未回复" },
  { operationKey: "review.filter.followup", label: "有追评筛选", risk: "low", strategy: "text", selector: "有追评" },
  { operationKey: "review.date.trigger", label: "评价日期", risk: "low", strategy: "text", selector: "评价时间" },
  { operationKey: "review.date.preset.today", label: "今天快捷日期", risk: "low", strategy: "text", selector: "今天" },
  { operationKey: "review.date.preset.yesterday", label: "昨天快捷日期", risk: "low", strategy: "text", selector: "昨天" },
  { operationKey: "review.date.preset.last7", label: "近7天快捷日期", risk: "low", strategy: "text", selector: "近7天" },
  { operationKey: "review.date.preset.last30", label: "近30天快捷日期", risk: "low", strategy: "text", selector: "近30天" },
  { operationKey: "review.date.previous", label: "日历上个月", risk: "low", strategy: "role", selector: "button:上个月|上一月|向前" },
  { operationKey: "review.date.next", label: "日历下个月", risk: "low", strategy: "role", selector: "button:下个月|下一月|向后" },
  { operationKey: "review.date.day", label: "日历日期", risk: "low", strategy: "css", selector: "[data-value], [data-date], [title], [aria-label]" },
  { operationKey: "review.search", label: "评价搜索", risk: "low", strategy: "role", selector: "button:搜索" },
  { operationKey: "review.list", label: "评价列表", risk: "low", strategy: "semantic", selector: "评价回复行" },
  { operationKey: "review.product", label: "商品名称", risk: "low", strategy: "scoped", selector: "评价行商品链接" },
  { operationKey: "review.pagination", label: "列表翻页", risk: "low", strategy: "role", selector: "button:下一页|>" },
  { operationKey: "review.pagination.current", label: "当前评价页码", risk: "low", strategy: "css", selector: "[aria-current='page'], .next-pagination-item.next-current, .next-pagination-item.current" },
  { operationKey: "popup.notice.close", label: "通知弹窗关闭", risk: "low", strategy: "css", selector: SAFE_POPUP_CLOSE_SELECTOR },
  { operationKey: "reply.open", label: "回复入口", risk: "high", strategy: "text", selector: "评价回复|追评回复" },
  { operationKey: "reply.editor", label: "回复输入框", risk: "high", strategy: "role", selector: "textbox" },
  { operationKey: "reply.submit", label: "回复提交按钮", risk: "high", strategy: "role", selector: "button:提交|确认提交|确认回复|发布|回复|确认|确定" },
  { operationKey: "reply.success", label: "回复成功标识", risk: "high", strategy: "text", selector: "已回复|商家回复成功|回复成功" },
  { operationKey: "complaint.type", label: "投诉类型", risk: "high", strategy: "role", selector: "combobox" },
  { operationKey: "complaint.description", label: "投诉描述框", risk: "high", strategy: "role", selector: "textbox" },
  { operationKey: "complaint.submit", label: "投诉提交按钮", risk: "high", strategy: "role", selector: "button:提交投诉|确认投诉|提交" },
];

export class LocatorRepository {
  constructor(private readonly database: AppDatabase) {}

  ensureDefaults(): void {
    this.database.transaction(() => {
      const now = new Date().toISOString();
      for (const item of DEFAULT_LOCATORS) {
        this.database.prepare(`INSERT OR IGNORE INTO locator_rules(operation_key, label, risk, health, updated_at) VALUES (?, ?, ?, ?, ?)`)
          .run(item.operationKey, item.label, item.risk, "healthy", now);
        const existing = this.database.prepare("SELECT current_version_id FROM locator_rules WHERE operation_key = ?").get(item.operationKey) as { current_version_id: number | null };
        if (existing.current_version_id === null) {
          const version = this.database.prepare(`INSERT INTO locator_versions(operation_key, version, strategy, selector, status, source, created_at, activated_at) VALUES (?, 1, ?, ?, 'active', 'built_in', ?, ?)`)
            .run(item.operationKey, item.strategy, item.selector, now, now);
          this.database.prepare("UPDATE locator_rules SET current_version_id = ? WHERE operation_key = ?").run(Number(version.lastInsertRowid), item.operationKey);
        }
        if (item.operationKey === "popup.notice.close") {
          const current = this.database.prepare(`
            SELECT v.id, v.version, v.selector
            FROM locator_rules r JOIN locator_versions v ON v.id = r.current_version_id
            WHERE r.operation_key = ?
          `).get(item.operationKey) as { id: number; version: number; selector: string } | undefined;
          if (current?.selector === OBSOLETE_BROAD_POPUP_CLOSE_SELECTOR) {
            this.database.prepare("UPDATE locator_versions SET status = 'historical' WHERE id = ?").run(current.id);
            const replacement = this.database.prepare(`
              INSERT INTO locator_versions(operation_key, version, strategy, selector, status, source, created_at, activated_at)
              VALUES (?, ?, 'css', ?, 'active', 'built_in', ?, ?)
            `).run(item.operationKey, current.version + 1, SAFE_POPUP_CLOSE_SELECTOR, now, now);
            this.database.prepare("UPDATE locator_rules SET current_version_id = ?, updated_at = ? WHERE operation_key = ?")
              .run(Number(replacement.lastInsertRowid), now, item.operationKey);
          }
        }
        this.database.prepare(`UPDATE locator_rules SET health = 'healthy', updated_at = ?
          WHERE operation_key = ? AND health = 'attention'
          AND NOT EXISTS (
            SELECT 1 FROM locator_repairs
            WHERE operation_key = ? AND status = 'pending_approval'
          )`)
          .run(now, item.operationKey, item.operationKey);
      }
    })();
  }

  list(): LocatorRecord[] {
    return (this.database.prepare(`
      SELECT r.operation_key, r.label, r.risk, r.health, r.last_success_at,
        v.version, v.strategy, v.selector
      FROM locator_rules r JOIN locator_versions v ON v.id = r.current_version_id
      ORDER BY CASE r.risk WHEN 'high' THEN 1 ELSE 0 END, r.operation_key
    `).all() as Array<{ operation_key: string; label: string; risk: "low" | "high"; health: "healthy" | "recovered" | "attention"; last_success_at: string | null; version: number; strategy: string; selector: string }>).map((row) => ({
      operationKey: row.operation_key,
      label: row.label,
      risk: row.risk,
      health: row.health,
      version: row.version,
      strategy: row.strategy,
      selector: row.selector,
      lastSuccessAt: row.last_success_at,
    }));
  }

  get(operationKey: string): LocatorRecord | null {
    return this.list().find((item) => item.operationKey === operationKey) ?? null;
  }

  markAttention(operationKey: string): void {
    this.database.prepare("UPDATE locator_rules SET health = 'attention', updated_at = ? WHERE operation_key = ?")
      .run(new Date().toISOString(), operationKey);
  }

  markSuccess(operationKey: string): void {
    this.database.prepare("UPDATE locator_rules SET health = CASE WHEN health = 'attention' THEN 'healthy' ELSE health END, last_success_at = ?, updated_at = ? WHERE operation_key = ?")
      .run(new Date().toISOString(), new Date().toISOString(), operationKey);
  }

  proposeRepair(input: { operationKey: string; strategy: string; selector: string; evidenceSummary: string; validated: boolean }): LocatorRepairRecord {
    const current = this.get(input.operationKey);
    if (!current) throw new Error("页面元素不存在");
    if (!input.strategy.trim() || !input.selector.trim()) throw new Error("修复候选不能为空");
    const next = (this.database.prepare("SELECT COALESCE(MAX(version), 0) AS value FROM locator_versions WHERE operation_key = ?").get(input.operationKey) as { value: number }).value + 1;
    const now = new Date().toISOString();
    const status: LocatorRepairRecord["status"] = !input.validated ? "rejected" : current.risk === "low" ? "auto_applied" : "pending_approval";
    const version = this.database.prepare(`INSERT INTO locator_versions(operation_key, version, strategy, selector, status, source, created_at, activated_at) VALUES (?, ?, ?, ?, ?, 'ai_repair', ?, ?)`)
      .run(input.operationKey, next, input.strategy.trim(), input.selector.trim(), status === "auto_applied" ? "active" : status === "rejected" ? "rejected" : "candidate", now, status === "auto_applied" ? now : null);
    const versionId = Number(version.lastInsertRowid);
    const id = randomUUID();
    this.database.prepare(`INSERT INTO locator_repairs(id, operation_key, risk, status, candidate_version_id, evidence_summary, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.operationKey, current.risk, status, versionId, input.evidenceSummary.slice(0, 800), now, status === "pending_approval" ? null : now);
    if (status === "auto_applied") this.#activate(input.operationKey, versionId, "recovered");
    else this.#pruneVersions(input.operationKey);
    return this.getRepair(id)!;
  }

  approveRepair(id: string): LocatorRepairRecord | null {
    const repair = this.getRepair(id);
    if (!repair || repair.status !== "pending_approval" || !repair.candidateVersionId) return null;
    this.#activate(repair.operationKey, repair.candidateVersionId, "recovered");
    const now = new Date().toISOString();
    this.database.prepare("UPDATE locator_repairs SET status = 'approved', resolved_at = ? WHERE id = ?").run(now, id);
    return this.getRepair(id);
  }

  rejectRepair(id: string): LocatorRepairRecord | null {
    const repair = this.getRepair(id);
    if (!repair || repair.status !== "pending_approval") return null;
    const now = new Date().toISOString();
    this.database.prepare("UPDATE locator_repairs SET status = 'rejected', resolved_at = ? WHERE id = ?").run(now, id);
    if (repair.candidateVersionId) this.database.prepare("UPDATE locator_versions SET status = 'rejected' WHERE id = ?").run(repair.candidateVersionId);
    this.database.prepare(`UPDATE locator_rules SET health = 'healthy', updated_at = ?
      WHERE operation_key = ? AND health = 'attention'
      AND NOT EXISTS (
        SELECT 1 FROM locator_repairs
        WHERE operation_key = ? AND status = 'pending_approval'
      )`).run(now, repair.operationKey, repair.operationKey);
    this.#pruneVersions(repair.operationKey);
    return this.getRepair(id);
  }

  rollback(operationKey: string): LocatorRecord | null {
    const current = this.database.prepare("SELECT current_version_id FROM locator_rules WHERE operation_key = ?").get(operationKey) as { current_version_id: number | null } | undefined;
    if (!current?.current_version_id) return null;
    const previous = this.database.prepare("SELECT id FROM locator_versions WHERE operation_key = ? AND id != ? AND status = 'historical' ORDER BY version DESC LIMIT 1")
      .get(operationKey, current.current_version_id) as { id: number } | undefined;
    if (!previous) return null;
    this.#activate(operationKey, previous.id, "recovered");
    return this.get(operationKey);
  }

  rollbackRepair(id: string): LocatorRepairRecord | null {
    const repair = this.getRepair(id);
    if (!repair?.candidateVersionId) return null;
    const current = this.database.prepare("SELECT current_version_id FROM locator_rules WHERE operation_key = ?").get(repair.operationKey) as { current_version_id: number | null } | undefined;
    if (current?.current_version_id !== repair.candidateVersionId || !this.rollback(repair.operationKey)) return null;
    this.database.prepare("UPDATE locator_repairs SET status = 'rolled_back', resolved_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return this.getRepair(id);
  }

  listRepairs(limit = 100): LocatorRepairRecord[] {
    return (this.database.prepare(`SELECT p.*, r.label, r.current_version_id FROM locator_repairs p JOIN locator_rules r ON r.operation_key = p.operation_key ORDER BY p.created_at DESC LIMIT ?`).all(limit) as Array<{ id: string; operation_key: string; label: string; risk: "low" | "high"; status: LocatorRepairRecord["status"]; candidate_version_id: number | null; evidence_summary: string; created_at: string; resolved_at: string | null; current_version_id: number | null }>).map((row) => ({
      id: row.id, operationKey: row.operation_key, label: row.label, risk: row.risk, status: row.status,
      candidateVersionId: row.candidate_version_id, evidenceSummary: row.evidence_summary, createdAt: row.created_at, resolvedAt: row.resolved_at,
      canRollback: ["auto_applied", "approved"].includes(row.status) && row.candidate_version_id !== null && row.candidate_version_id === row.current_version_id,
    }));
  }

  getRepair(id: string): LocatorRepairRecord | null {
    return this.listRepairs(1000).find((item) => item.id === id) ?? null;
  }

  pruneRepairs(retentionDays: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    const result = this.database.prepare("DELETE FROM locator_repairs WHERE created_at < ? AND status != 'pending_approval'").run(cutoff).changes;
    for (const item of DEFAULT_LOCATORS) this.#pruneVersions(item.operationKey);
    return result;
  }

  saveSnapshot(operationKey: string, sanitizedSnapshot: string): string {
    if (!this.get(operationKey)) throw new Error("页面元素不存在");
    const id = randomUUID();
    this.database.prepare("INSERT INTO locator_snapshots(id, operation_key, snapshot_json, created_at) VALUES (?, ?, ?, ?)")
      .run(id, operationKey, sanitizedSnapshot.slice(0, 12_000), new Date().toISOString());
    return id;
  }

  pruneSnapshots(retentionDays: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    return this.database.prepare("DELETE FROM locator_snapshots WHERE created_at < ?").run(cutoff).changes;
  }

  snapshotCount(): number {
    return (this.database.prepare("SELECT COUNT(*) AS value FROM locator_snapshots").get() as { value: number }).value;
  }

  #activate(operationKey: string, versionId: number, health: LocatorRecord["health"]): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare("UPDATE locator_versions SET status = 'historical' WHERE operation_key = ? AND status = 'active'").run(operationKey);
      this.database.prepare("UPDATE locator_versions SET status = 'active', activated_at = ? WHERE id = ? AND operation_key = ?").run(now, versionId, operationKey);
      this.database.prepare("UPDATE locator_rules SET current_version_id = ?, health = ?, updated_at = ? WHERE operation_key = ?").run(versionId, health, now, operationKey);
      this.#pruneVersions(operationKey);
    })();
  }

  #pruneVersions(operationKey: string): void {
    this.database.prepare(`DELETE FROM locator_versions
      WHERE operation_key = ?
        AND id != (SELECT current_version_id FROM locator_rules WHERE operation_key = ?)
        AND id NOT IN (SELECT candidate_version_id FROM locator_repairs WHERE operation_key = ? AND status = 'pending_approval' AND candidate_version_id IS NOT NULL)
        AND id NOT IN (SELECT id FROM locator_versions WHERE operation_key = ? ORDER BY version DESC LIMIT 10)`)
      .run(operationKey, operationKey, operationKey, operationKey);
  }
}

export type ReplyAttemptState = "pending" | "submitting" | "sent" | "failed" | "submission_uncertain";
export interface ReplyAttemptRecord {
  id: string;
  replyDraftId: string | null;
  sourceKey: string;
  state: ReplyAttemptState;
  evidence: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  verifiedAt: string | null;
  actionLockVersion: number | null;
}

export class ReplyAttemptRepository {
  private readonly gate: ReviewActionGate;

  constructor(private readonly database: AppDatabase, private readonly storeId = "primary") {
    this.gate = new ReviewActionGate(database);
  }

  prepare(replyDraftId: string, sourceKey: string): { attempt: ReplyAttemptRecord; created: boolean } {
    return this.prepareWithReplyLock(replyDraftId, sourceKey);
  }

  prepareWithReplyLock(replyDraftId: string, sourceKey: string): { attempt: ReplyAttemptRecord; created: boolean } {
    return this.database.transaction(() => {
      const draft = this.database.prepare(`
        SELECT id, source_key, state FROM reply_drafts WHERE id = ?
      `).get(replyDraftId) as { id: string; source_key: string; state: string } | undefined;
      if (!draft || draft.source_key !== sourceKey) throw new Error("回复草稿与评价不一致");
      const existing = this.getBySourceKey(sourceKey);
      const tombstone = this.gate.getTombstone(this.storeId, sourceKey);
      if (existing?.state === "sent") {
        if (tombstone?.terminalAction !== "reply_sent") {
          throw new ReviewActionConflictError("ACTION_TERMINAL", "回复完成记录不完整，需要人工核对");
        }
        return { attempt: existing, created: false };
      }
      if (tombstone) {
        throw new ReviewActionConflictError("ACTION_TERMINAL", "该评价已经完成处理，不能再次操作");
      }
      if (existing && existing.state !== "failed") {
        this.assertReplyLock(existing);
        return { attempt: existing, created: false };
      }
      if (!["read_only_ready", "needs_attention"].includes(draft.state)) {
        throw new ReviewActionConflictError("ACTION_CONFLICT", "回复草稿状态不允许准备提交");
      }
      if (existing?.state === "failed" && this.gate.getLock(this.storeId, sourceKey)) {
        throw new ReviewActionConflictError("ACTION_VERSION_CONFLICT", "动作状态已发生变化，请重新读取后再试");
      }

      const nextVersion = existing ? (existing.actionLockVersion ?? 0) + 1 : 1;
      const lock = this.gate.acquire(this.storeId, sourceKey, "reply", nextVersion);
      const now = new Date().toISOString();
      if (existing) {
        const updated = this.database.prepare(`
          UPDATE reply_attempts
          SET reply_draft_id = ?, state = 'pending', evidence = NULL, error_code = NULL,
              error_message = NULL, submitted_at = NULL, verified_at = NULL,
              action_lock_version = ?, updated_at = ?
          WHERE id = ? AND state = 'failed'
        `).run(replyDraftId, lock.lockVersion, now, existing.id);
        if (updated.changes !== 1) throw new ReviewActionConflictError("ACTION_CONFLICT", "提交记录状态已发生变化");
        return { attempt: this.get(existing.id)!, created: true };
      }

      const id = randomUUID();
      this.database.prepare(`
        INSERT INTO reply_attempts(
          id, reply_draft_id, source_key, state, created_at, updated_at, action_lock_version
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?)
      `).run(id, replyDraftId, sourceKey, now, now, lock.lockVersion);
      return { attempt: this.get(id)!, created: true };
    }).immediate();
  }

  getBySourceKey(sourceKey: string): ReplyAttemptRecord | null {
    const row = this.database.prepare("SELECT * FROM reply_attempts WHERE source_key = ?").get(sourceKey) as Record<string, unknown> | undefined;
    return row ? this.#map(row) : null;
  }

  get(id: string): ReplyAttemptRecord | null {
    const row = this.database.prepare("SELECT * FROM reply_attempts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.#map(row) : null;
  }

  list(limit = 500): ReplyAttemptRecord[] {
    return (this.database.prepare("SELECT * FROM reply_attempts ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((row) => this.#map(row));
  }

  unresolvedCount(): number {
    return (this.database.prepare(
      "SELECT COUNT(*) AS value FROM reply_attempts WHERE state = 'submission_uncertain'",
    ).get() as { value: number }).value;
  }

  recoverInterrupted(at = new Date()): { releasedPending: number; markedUncertain: number } {
    return this.database.transaction(() => {
      const now = at.toISOString();
      const pending = (this.database.prepare(
        "SELECT * FROM reply_attempts WHERE state = 'pending' ORDER BY created_at",
      ).all() as Record<string, unknown>[]).map((row) => this.#map(row));
      const submitting = (this.database.prepare(
        "SELECT * FROM reply_attempts WHERE state = 'submitting' ORDER BY created_at",
      ).all() as Record<string, unknown>[]).map((row) => this.#map(row));

      for (const attempt of pending) {
        const lock = this.gate.getLock(this.storeId, attempt.sourceKey);
        if (lock) this.assertReplyLock(attempt);
        this.database.prepare(`
          UPDATE reply_attempts
          SET state = 'failed', evidence = '应用在点击提交前中断，未向平台发送回复',
              error_code = 'PROCESS_INTERRUPTED_BEFORE_SUBMIT',
              error_message = '应用在点击提交前中断，允许下次安全重试', updated_at = ?
          WHERE id = ? AND state = 'pending'
        `).run(now, attempt.id);
        if (attempt.replyDraftId) {
          this.database.prepare(`
            UPDATE reply_drafts
            SET state = CASE WHEN attention_reasons_json = '[]' THEN 'read_only_ready' ELSE 'needs_attention' END,
                error_code = NULL, error_message = NULL, updated_at = ?
            WHERE id = ?
          `).run(now, attempt.replyDraftId);
        }
        if (lock) this.releaseAttemptLock(attempt);
      }

      for (const attempt of submitting) {
        let lock = this.gate.getLock(this.storeId, attempt.sourceKey);
        const lockVersion = attempt.actionLockVersion ?? lock?.lockVersion ?? 1;
        if (!lock) {
          this.database.prepare(`
            INSERT INTO review_action_locks(
              store_id, source_key, action_kind, lock_version, created_at, updated_at
            ) VALUES (?, ?, 'reply', ?, ?, ?)
          `).run(this.storeId, attempt.sourceKey, lockVersion, now, now);
          this.database.prepare(`
            UPDATE reply_attempts SET action_lock_version = ? WHERE id = ?
          `).run(lockVersion, attempt.id);
          lock = this.gate.getLock(this.storeId, attempt.sourceKey);
        }
        const protectedAttempt = attempt.actionLockVersion === null
          ? { ...attempt, actionLockVersion: lockVersion }
          : attempt;
        this.assertReplyLock(protectedAttempt);
        this.database.prepare(`
          UPDATE reply_attempts
          SET state = 'submission_uncertain', evidence = '应用在提交过程中中断，平台结果需要人工核对',
              error_code = 'SUBMISSION_INTERRUPTED',
              error_message = '提交结果无法确认，已禁止自动重试', updated_at = ?
          WHERE id = ? AND state = 'submitting'
        `).run(now, attempt.id);
        this.updateDraftState(
          attempt.replyDraftId,
          "submission_uncertain",
          "SUBMISSION_INTERRUPTED",
          "提交结果无法确认，已禁止自动重试",
          now,
          true,
        );
      }

      return { releasedPending: pending.length, markedUncertain: submitting.length };
    }).immediate();
  }

  markSubmitting(id: string): void {
    this.database.transaction(() => {
      const attempt = this.requireAttempt(id, ["pending", "submitting"]);
      this.assertReplyLock(attempt);
      if (attempt.state === "submitting") return;
      const now = new Date().toISOString();
      this.database.prepare(`
        UPDATE reply_attempts SET state = 'submitting', submitted_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'
      `).run(now, now, id);
      this.updateDraftState(attempt.replyDraftId, "submitting", null, null, now);
    }).immediate();
  }

  markSent(id: string, evidence: string): void {
    if (!evidence.trim()) throw new Error("必须提供平台成功证据");
    this.finishSent(id, evidence);
  }

  markFailed(id: string, code: string, message: string): void {
    this.markPreSubmitFailed(id, code, message);
  }

  markPreSubmitFailed(id: string, code: string, message: string): void {
    this.database.transaction(() => {
      const attempt = this.requireAttempt(id, ["pending", "submitting"]);
      this.assertReplyLock(attempt);
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        UPDATE reply_attempts
        SET state = 'failed', error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ? AND state IN ('pending', 'submitting')
      `).run(code, message.slice(0, 800), now, id);
      if (result.changes !== 1) throw new Error("提交记录不存在");
      this.database.prepare(`
        UPDATE reply_drafts SET
          state = CASE WHEN attention_reasons_json = '[]' THEN 'read_only_ready' ELSE 'needs_attention' END,
          error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, attempt.replyDraftId);
      this.releaseAttemptLock(attempt);
    }).immediate();
  }

  /**
   * Browser-side failures before a known submit click must not block the
   * queue or be retried automatically.  Preserve the reason on both records
   * and make the draft terminal for normal scheduled processing; an operator
   * can still explicitly reprocess it later from the result screen.
   */
  markSkipped(id: string, code: string, message: string): void {
    this.database.transaction(() => {
      const attempt = this.requireAttempt(id, ["pending", "submitting"]);
      this.assertReplyLock(attempt);
      const now = new Date().toISOString();
      const reason = message.slice(0, 800);
      const result = this.database.prepare(`
        UPDATE reply_attempts
        SET state = 'failed', evidence = ?, error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ? AND state IN ('pending', 'submitting')
      `).run(reason, code, reason, now, id);
      if (result.changes !== 1) throw new Error("提交记录不存在");
      this.database.prepare(`
        UPDATE reply_drafts
        SET state = 'failed', error_code = ?, error_message = ?, processed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(code, reason, now, now, attempt.replyDraftId);
      this.releaseAttemptLock(attempt);
    }).immediate();
  }

  markUncertain(id: string, evidence: string): void {
    if (!evidence.trim()) throw new Error("必须提供提交不确定证据");
    this.database.transaction(() => {
      const attempt = this.requireAttempt(id, ["submitting", "submission_uncertain"]);
      this.assertReplyLock(attempt);
      if (attempt.state === "submission_uncertain") return;
      const now = new Date().toISOString();
      this.database.prepare(`
        UPDATE reply_attempts
        SET state = 'submission_uncertain', evidence = ?, error_code = 'SUBMISSION_UNCERTAIN',
            error_message = '提交结果无法确认，已禁止自动重试', updated_at = ?
        WHERE id = ? AND state = 'submitting'
      `).run(evidence.slice(0, 800), now, id);
      this.updateDraftState(attempt.replyDraftId, "submission_uncertain", "SUBMISSION_UNCERTAIN", "提交结果无法确认，已禁止自动重试", now, true);
    }).immediate();
  }

  resolveUncertainByDraftId(replyDraftId: string, outcome: "sent" | "not_sent"): ReplyAttemptRecord | null {
    const attempt = this.database.prepare("SELECT id FROM reply_attempts WHERE reply_draft_id = ? AND state = 'submission_uncertain'").get(replyDraftId) as { id: string } | undefined;
    if (!attempt) return null;
    return this.resolveUncertain(
      attempt.id,
      outcome,
      outcome === "sent" ? "人工核对：平台已显示回复" : "人工核对：平台确认尚未回复",
    );
  }

  resolveUncertain(id: string, outcome: "sent" | "not_sent", evidence: string): ReplyAttemptRecord {
    if (!evidence.trim()) throw new Error("必须提供平台核对证据");
    if (outcome === "sent") {
      this.finishSent(id, evidence, true);
      return this.get(id)!;
    }
    this.database.transaction(() => {
      const attempt = this.requireAttempt(id, ["submission_uncertain"]);
      this.assertReplyLock(attempt);
      const now = new Date().toISOString();
      this.database.prepare(`
        UPDATE reply_attempts
        SET state = 'failed', evidence = ?, error_code = 'MANUALLY_CONFIRMED_NOT_SENT',
            error_message = '人工核对：平台确认尚未回复，允许下次安全重试', updated_at = ?
        WHERE id = ? AND state = 'submission_uncertain'
      `).run(evidence.slice(0, 800), now, id);
      this.database.prepare(`
        UPDATE reply_drafts SET
          state = CASE WHEN attention_reasons_json = '[]' THEN 'read_only_ready' ELSE 'needs_attention' END,
          error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, attempt.replyDraftId);
      this.releaseAttemptLock(attempt);
    }).immediate();
    return this.get(id)!;
  }

  pruneOlderThan(retentionDays: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    return this.database.transaction(() => this.database.prepare(`
      DELETE FROM reply_attempts
      WHERE created_at < ? AND state NOT IN ('pending', 'submitting', 'submission_uncertain')
        AND NOT EXISTS (
          SELECT 1 FROM review_action_locks
          WHERE review_action_locks.source_key = reply_attempts.source_key
        )
    `).run(cutoff).changes).immediate();
  }

  private finishSent(id: string, evidence: string, requireUncertain = false): void {
    this.database.transaction(() => {
      const allowed: ReplyAttemptState[] = requireUncertain ? ["submission_uncertain"] : ["submitting", "sent"];
      const attempt = this.requireAttempt(id, allowed);
      if (attempt.state === "sent") {
        const tombstone = this.gate.getTombstone(this.storeId, attempt.sourceKey);
        if (tombstone?.terminalAction === "reply_sent") return;
        throw new ReviewActionConflictError("ACTION_TERMINAL", "回复完成记录不完整，需要人工核对");
      }
      this.assertReplyLock(attempt);
      const now = new Date().toISOString();
      this.database.prepare(`
        UPDATE reply_attempts
        SET state = 'sent', evidence = ?, error_code = NULL, error_message = NULL,
            submitted_at = COALESCE(submitted_at, ?), verified_at = ?, updated_at = ?
        WHERE id = ?
      `).run(evidence.slice(0, 800), now, now, now, id);
      this.updateDraftState(attempt.replyDraftId, "sent", null, null, now, true);
      const removed = this.database.prepare(`
        DELETE FROM review_action_locks
        WHERE store_id = ? AND source_key = ? AND action_kind = 'reply' AND lock_version = ?
      `).run(this.storeId, attempt.sourceKey, attempt.actionLockVersion);
      if (removed.changes !== 1) throw new ReviewActionConflictError("ACTION_VERSION_CONFLICT", "动作状态已发生变化，请重新读取后再试");
      this.database.prepare(`
        INSERT INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at)
        VALUES (?, ?, 'reply_sent', ?)
      `).run(this.storeId, attempt.sourceKey, now);
    }).immediate();
  }

  private requireAttempt(id: string, allowed: ReplyAttemptState[]): ReplyAttemptRecord {
    const attempt = this.get(id);
    if (!attempt) throw new Error("提交记录不存在");
    if (!allowed.includes(attempt.state)) {
      throw new ReviewActionConflictError("ACTION_CONFLICT", "提交记录当前状态不允许该操作");
    }
    return attempt;
  }

  private assertReplyLock(attempt: ReplyAttemptRecord): void {
    if (this.gate.getTombstone(this.storeId, attempt.sourceKey)) {
      throw new ReviewActionConflictError("ACTION_TERMINAL", "该评价已经完成处理，不能再次操作");
    }
    const lock = this.gate.getLock(this.storeId, attempt.sourceKey);
    if (!lock || lock.actionKind !== "reply" || lock.lockVersion !== attempt.actionLockVersion) {
      throw new ReviewActionConflictError("ACTION_VERSION_CONFLICT", "动作状态已发生变化，请重新读取后再试");
    }
  }

  private releaseAttemptLock(attempt: ReplyAttemptRecord): void {
    const result = this.database.prepare(`
      DELETE FROM review_action_locks
      WHERE store_id = ? AND source_key = ? AND action_kind = 'reply' AND lock_version = ?
    `).run(this.storeId, attempt.sourceKey, attempt.actionLockVersion);
    if (result.changes !== 1) {
      throw new ReviewActionConflictError("ACTION_VERSION_CONFLICT", "动作状态已发生变化，请重新读取后再试");
    }
  }

  private updateDraftState(
    replyDraftId: string | null,
    state: string,
    errorCode: string | null,
    errorMessage: string | null,
    now: string,
    processed = false,
  ): void {
    if (!replyDraftId) return;
    this.database.prepare(`
      UPDATE reply_drafts
      SET state = ?, error_code = ?, error_message = ?, updated_at = ?,
          processed_at = CASE WHEN ? THEN ? ELSE processed_at END
      WHERE id = ?
    `).run(state, errorCode, errorMessage, now, processed ? 1 : 0, now, replyDraftId);
  }

  #map(row: Record<string, unknown>): ReplyAttemptRecord {
    return {
      id: String(row.id), replyDraftId: row.reply_draft_id === null ? null : String(row.reply_draft_id), sourceKey: String(row.source_key), state: row.state as ReplyAttemptState,
      evidence: row.evidence === null ? null : String(row.evidence), errorCode: row.error_code === null ? null : String(row.error_code),
      errorMessage: row.error_message === null ? null : String(row.error_message), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      submittedAt: row.submitted_at === null ? null : String(row.submitted_at), verifiedAt: row.verified_at === null ? null : String(row.verified_at),
      actionLockVersion: row.action_lock_version === null ? null : Number(row.action_lock_version),
    };
  }
}

export class TemplateRepository {
  constructor(private readonly database: AppDatabase) {}

  saveSource(input: TemplateSourceInput): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO template_sources(library, url, app_token, table_id, view_id, status, created_at, updated_at)
      VALUES (@library, @url, @appToken, @tableId, @viewId, 'configured', @now, @now)
      ON CONFLICT(library) DO UPDATE SET
        url = excluded.url,
        app_token = excluded.app_token,
        table_id = excluded.table_id,
        view_id = excluded.view_id,
        status = CASE WHEN template_sources.active_version_id IS NULL THEN 'configured' ELSE template_sources.status END,
        updated_at = excluded.updated_at
    `).run({ ...input, now });
  }

  getSource(library: TemplateLibrary): Record<string, unknown> | null {
    return (this.database.prepare(`
      SELECT s.*, v.content_hash, v.category_count, v.reply_count, v.warnings_json, v.activated_at
      FROM template_sources s
      LEFT JOIN template_versions v ON v.id = s.active_version_id
      WHERE s.library = ?
    `).get(library) as Record<string, unknown> | undefined) ?? null;
  }

  getSources(): Record<string, unknown>[] {
    return this.database.prepare(`
      SELECT s.*, v.content_hash, v.category_count, v.reply_count, v.warnings_json, v.activated_at
      FROM template_sources s
      LEFT JOIN template_versions v ON v.id = s.active_version_id
      ORDER BY s.library
    `).all() as Record<string, unknown>[];
  }

  getHealth(library: TemplateLibrary): TemplateSourceHealth {
    const source = this.database.prepare(`
      SELECT s.status, s.active_version_id, s.last_error_code, v.library AS version_library,
        v.category_count, v.reply_count
      FROM template_sources s
      LEFT JOIN template_versions v ON v.id = s.active_version_id
      WHERE s.library = ?
    `).get(library) as {
      status: string;
      active_version_id: number | null;
      last_error_code: string | null;
      version_library: TemplateLibrary | null;
      category_count: number | null;
      reply_count: number | null;
    } | undefined;
    if (!source) return { state: "not_ready", usable: false, reason: "source_not_configured" };
    if (!source.active_version_id || source.version_library !== library) {
      return { state: "not_ready", usable: false, reason: "active_version_missing" };
    }
    if (!this.#isActiveVersionValid(library, source.active_version_id, source.category_count, source.reply_count)) {
      return { state: "not_ready", usable: false, reason: "active_version_invalid" };
    }
    if (source.status === "ready" && !source.last_error_code) {
      return { state: "ready", usable: true, activeVersionId: source.active_version_id };
    }
    return {
      state: "usable_with_warning",
      usable: true,
      activeVersionId: source.active_version_id,
      warning: { code: source.last_error_code ?? "TEMPLATE_SOURCE_STALE" },
    };
  }

  recordTestResult(library: TemplateLibrary, success: boolean, code?: string, message?: string): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE template_sources SET
        status = CASE WHEN ? THEN CASE WHEN active_version_id IS NULL THEN 'configured' ELSE status END ELSE 'error' END,
        last_tested_at = ?,
        last_error_code = CASE WHEN ? THEN NULL ELSE ? END,
        last_error_message = CASE WHEN ? THEN NULL ELSE ? END,
        updated_at = ?
      WHERE library = ?
    `).run(success ? 1 : 0, now, success ? 1 : 0, code ?? null, success ? 1 : 0, message ?? null, now, library);
    this.audit("template_test", library, success ? "success" : "failed", code);
  }

  recordSyncFailure(library: TemplateLibrary, code: string, message: string): void {
    const now = new Date().toISOString();
    const safeMessage = this.#redactSyncError(message);
    this.database.prepare(`
      UPDATE template_sources SET status = 'error', last_error_code = ?, last_error_message = ?, updated_at = ? WHERE library = ?
    `).run(code, safeMessage, now, library);
    this.database.prepare(`
      INSERT INTO operation_audit(event_type, target, result, error_code, created_at) VALUES ('template_sync', ?, 'failed', ?, ?)
    `).run(library, code, now);
  }

  activateVersion(input: TemplateVersionInput): { versionId: number; changed: boolean } {
    return this.database.transaction(() => {
      const source = this.database.prepare("SELECT active_version_id FROM template_sources WHERE library = ?").get(input.library) as { active_version_id: number | null } | undefined;
      if (!source) throw new Error(`模板来源 ${input.library} 尚未配置`);

      const existing = this.database.prepare("SELECT id FROM template_versions WHERE library = ? AND content_hash = ?").get(input.library, input.contentHash) as { id: number } | undefined;
      const now = new Date().toISOString();
      if (existing) {
        this.database.prepare(`
          UPDATE template_sources SET active_version_id = ?, status = 'ready', last_synced_at = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE library = ?
        `).run(existing.id, now, now, input.library);
        this.pruneVersions(input.library);
        return { versionId: existing.id, changed: false };
      }

      const replyCount = input.templates.reduce((total, item) => total + item.replies.length, 0);
      const version = this.database.prepare(`
        INSERT INTO template_versions(library, content_hash, source_record_count, category_count, reply_count, warnings_json, created_at, activated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.library, input.contentHash, input.sourceRecordCount, input.templates.length, replyCount, JSON.stringify(input.warnings), now, now);
      const versionId = Number(version.lastInsertRowid);
      const insertCategory = this.database.prepare(`
        INSERT INTO template_categories(version_id, row_index, primary_category, category, keywords_json) VALUES (?, ?, ?, ?, ?)
      `);
      const insertReply = this.database.prepare(`
        INSERT INTO template_replies(category_id, sequence, text) VALUES (?, ?, ?)
      `);
      input.templates.forEach((item, rowIndex) => {
        const category = insertCategory.run(versionId, rowIndex, item.primaryCategory, item.category, JSON.stringify(item.keywords));
        const categoryId = Number(category.lastInsertRowid);
        item.replies.forEach((reply) => insertReply.run(categoryId, reply.sequence, reply.text));
      });

      this.database.prepare(`
        UPDATE template_sources SET active_version_id = ?, status = 'ready', last_synced_at = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE library = ?
      `).run(versionId, now, now, input.library);
      this.database.prepare(`
        INSERT INTO operation_audit(event_type, target, result, created_at) VALUES ('template_sync', ?, 'success', ?)
      `).run(input.library, now);
      this.pruneVersions(input.library);
      return { versionId, changed: true };
    })();
  }

  getActiveCategories(library: TemplateLibrary): ActiveTemplateCategory[] {
    const rows = this.database.prepare(`
      SELECT c.id, c.primary_category, c.category, c.keywords_json
      FROM template_sources s
      JOIN template_categories c ON c.version_id = s.active_version_id
      WHERE s.library = ?
      ORDER BY c.row_index
    `).all(library) as Array<{ id: number; primary_category: string; category: string; keywords_json: string }>;
    const replies = this.database.prepare("SELECT sequence, text FROM template_replies WHERE category_id = ? ORDER BY sequence");
    return rows.map((row) => ({
      primaryCategory: row.primary_category,
      category: row.category,
      keywords: JSON.parse(row.keywords_json) as string[],
      replies: replies.all(row.id) as Array<{ sequence: number; text: string }>,
    }));
  }

  getActiveVersionId(library: TemplateLibrary): number | null {
    const row = this.database.prepare("SELECT active_version_id FROM template_sources WHERE library = ?").get(library) as { active_version_id: number | null } | undefined;
    return row?.active_version_id ?? null;
  }

  listVersions(library: TemplateLibrary): Array<{ id: number; contentHash: string; activatedAt: string }> {
    return (this.database.prepare(`
      SELECT id, content_hash, activated_at FROM template_versions WHERE library = ? ORDER BY id DESC
    `).all(library) as Array<{ id: number; content_hash: string; activated_at: string }>).map((row) => ({
      id: row.id,
      contentHash: row.content_hash,
      activatedAt: row.activated_at,
    }));
  }

  audit(eventType: string, target: string, result: string, errorCode?: string, createdAt = new Date()): void {
    this.database.prepare(`
      INSERT INTO operation_audit(event_type, target, result, error_code, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(eventType, target, result, errorCode ?? null, createdAt.toISOString());
  }

  pruneAudit(retentionDays: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    return this.database.prepare("DELETE FROM operation_audit WHERE created_at < ?").run(cutoff).changes;
  }

  private pruneVersions(library: TemplateLibrary): void {
    this.database.prepare(`
      DELETE FROM template_versions
      WHERE library = ?
        AND id != (SELECT active_version_id FROM template_sources WHERE library = ?)
        AND id NOT IN (
          SELECT v.id
          FROM template_versions v
          WHERE v.library = ?
            AND v.id != (SELECT active_version_id FROM template_sources WHERE library = ?)
          ORDER BY v.id DESC
          LIMIT 9
        )
        AND id NOT IN (
          SELECT DISTINCT template_version_id
          FROM reply_drafts
          WHERE ai_checkpoint_stage = 'template_selected'
            AND template_version_id IS NOT NULL
            AND state NOT IN ('sent', 'not_actionable', 'manual_hold_expired')
        )
    `).run(library, library, library, library);
  }

  #isActiveVersionValid(
    library: TemplateLibrary,
    versionId: number,
    expectedCategoryCount: number | null,
    expectedReplyCount: number | null,
  ): boolean {
    if (!Number.isInteger(expectedCategoryCount) || !Number.isInteger(expectedReplyCount)) return false;
    const categories = this.database.prepare(`
      SELECT id, primary_category, category, keywords_json
      FROM template_categories
      WHERE version_id = ?
      ORDER BY row_index
    `).all(versionId) as Array<{ id: number; primary_category: string; category: string; keywords_json: string }>;
    if (categories.length !== expectedCategoryCount || categories.length === 0) return false;

    const schema = FIXED_TEMPLATE_SCHEMAS[library];
    const seenCategories = new Set<string>();
    let replyCount = 0;
    const replies = this.database.prepare(`
      SELECT sequence, text FROM template_replies WHERE category_id = ? ORDER BY sequence
    `);
    for (const category of categories) {
      if (!category.category.trim() || seenCategories.has(category.category)) return false;
      seenCategories.add(category.category);
      if (library === "good" && category.primary_category !== "") return false;
      if (library === "bad" && !category.primary_category.trim()) return false;
      if (category.category === schema.fallbackCategory && library === "bad" && category.primary_category !== schema.fallbackCategory) {
        return false;
      }
      try {
        const keywords = JSON.parse(category.keywords_json) as unknown;
        if (!Array.isArray(keywords) || keywords.some((value) => typeof value !== "string" || !value.trim())) return false;
        if (new Set(keywords).size !== keywords.length) return false;
      } catch {
        return false;
      }
      const categoryReplies = replies.all(category.id) as Array<{ sequence: number; text: string }>;
      if (categoryReplies.length === 0) return false;
      const sequences = new Set<number>();
      for (const reply of categoryReplies) {
        if (!Number.isInteger(reply.sequence) || reply.sequence < 1 || !reply.text.trim() || sequences.has(reply.sequence)) return false;
        sequences.add(reply.sequence);
      }
      replyCount += categoryReplies.length;
    }
    return replyCount === expectedReplyCount && seenCategories.has(schema.fallbackCategory);
  }

  #redactSyncError(message: string): string {
    return message
      .replace(/https?:\/\/[^\s,)}]+/giu, "[REDACTED_URL]")
      .replace(/((?:app[_-]?secret|app[_-]?token|table[_-]?id)\s*[:=]\s*)[^\s,)}]+/giu, "$1[REDACTED]")
      .slice(0, 800);
  }
}

export interface PersistedReplyDraft {
  id: string;
  sourceKey: string;
  orderId: string | null;
  review: string;
  product: string;
  reviewedAt: string | null;
  sentimentLabel: TmallReviewSnapshot["sentimentLabel"];
  library: TemplateLibrary | null;
  primaryCategory: string;
  category: string;
  classificationConfidence: number | null;
  classificationReason: string;
  templateVersionId: number | null;
  templateSequence: number | null;
  originalTemplate: string;
  finalReply: string;
  productAdjusted: boolean;
  rewriteNotes: string;
  detectedTemplateProducts: string[];
  unsupportedClaims: string[];
  attentionReasons: string[];
  state: string;
  errorCode: string | null;
  errorMessage: string | null;
  discoveredAt: string;
  processedAt: string | null;
  updatedAt: string;
  itemId: string | null;
  reviewPhase: "initial" | "followup";
  manualProductId: string | null;
  manualHoldReason: string | null;
  manualCatalogRevision: number | null;
  manualMatchKind: string | null;
  manualHoldLastSeenAt: string | null;
  manualHoldAbsentScans: number;
  aiCheckpointStage: "template_selected" | null;
  failedStage: AiRetryStage | null;
  aiRetryErrorKind: AiRetryErrorKind | null;
  nextRetryAt: string | null;
  consecutiveAiFailureRounds: number;
}

export type ReplyListFilter = "all" | "sent" | "unsent" | "good" | "bad" | "attention";

export interface ReplyListPage {
  items: PersistedReplyDraft[];
  total: number;
  overallTotal: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const AI_RETRY_ERROR_KINDS = [
  "network",
  "timeout",
  "rate_limited",
  "service_unavailable",
  "model_contract",
  "transient_unknown",
] as const;

export type AiRetryErrorKind = typeof AI_RETRY_ERROR_KINDS[number];
export type AiRetryStage = "classification" | "rewrite";

export interface AiRetryClaimBatch {
  claimToken: string;
  leaseExpiresAt: string;
  drafts: PersistedReplyDraft[];
}

function normalizeAiRetryClaimToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  const token = value.trim();
  if (!token || token !== value || token.length > 200) throw new Error("AI 重试领取凭证无效");
  return token;
}

function normalizeAiRetryOperationAt(value: Date | undefined): string {
  const at = value ?? new Date();
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Error("AI 重试操作时间无效");
  return at.toISOString();
}

/**
 * SQLite accepts several overflow calendar dates (for example June 31).  AI
 * retry scope decisions must use the same strict parser as the review reader,
 * so malformed timestamps are never silently turned into eligible work.
 */
function resolveAiRetryDateScope(scope: Pick<ResolvedReviewScope, "startDate" | "endDate">): ResolvedReviewScope {
  return resolveReviewScope({
    preset: "custom",
    startDate: scope.startDate,
    endDate: scope.endDate,
  }, new Date(0));
}

function isStrictAiRetryTimestampWithinScope(
  reviewedAt: string | null,
  scope: ResolvedReviewScope,
): boolean {
  return typeof reviewedAt === "string" && isReviewedAtWithinScope(reviewedAt, scope);
}

const AI_RETRY_NO_ACTION_CONFLICT_SQL = `
  AND NOT EXISTS (
    SELECT 1 FROM reply_attempts
    WHERE reply_attempts.source_key = reply_drafts.source_key
  )
  AND NOT EXISTS (
    SELECT 1 FROM review_action_locks
    WHERE review_action_locks.source_key = reply_drafts.source_key
      AND (
        review_action_locks.action_kind <> 'reply'
        OR NOT EXISTS (
          SELECT 1 FROM complaint_cases
          WHERE complaint_cases.store_id = review_action_locks.store_id
            AND complaint_cases.source_key = review_action_locks.source_key
            AND complaint_cases.state IN ('no_complaint', 'rejected')
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM review_action_tombstones
    WHERE review_action_tombstones.source_key = reply_drafts.source_key
  )
`;

/**
 * An already-claimed safe complaint-analysis recovery may classify the review
 * before deciding whether the complaint lock should be retained or atomically
 * handed back to reply processing. This guard is deliberately narrower than
 * the ordinary claim predicate: it only permits an unstarted complaint case
 * with no type, facts, description, attempt, reply attempt, or tombstone.
 */
const AI_RETRY_ACTIVE_CLAIM_ACTION_GUARD_SQL = `
  AND NOT EXISTS (
    SELECT 1 FROM reply_attempts
    WHERE reply_attempts.source_key = reply_drafts.source_key
  )
  AND NOT EXISTS (
    SELECT 1 FROM review_action_locks l
    WHERE l.source_key = reply_drafts.source_key
      AND NOT (
        (l.action_kind = 'reply' AND EXISTS (
          SELECT 1 FROM complaint_cases c
          WHERE c.store_id = l.store_id AND c.source_key = l.source_key
            AND c.state IN ('no_complaint', 'rejected')
        ))
        OR
        (l.action_kind = 'complaint' AND EXISTS (
          SELECT 1 FROM complaint_cases c
          WHERE c.store_id = l.store_id AND c.source_key = l.source_key
            AND c.action_lock_version = l.lock_version
            AND c.state IN ('failed', 'discovered')
            AND c.complaint_type IS NULL AND c.fact_code IS NULL AND c.description IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM complaint_attempts a WHERE a.complaint_case_id = c.id
            )
        ))
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM review_action_tombstones
    WHERE review_action_tombstones.source_key = reply_drafts.source_key
  )
`;

type ReplyDraftRow = {
  id: string;
  source_key: string;
  order_id: string | null;
  review_text: string;
  product_title: string;
  reviewed_at: string | null;
  sentiment_label: TmallReviewSnapshot["sentimentLabel"];
  library: TemplateLibrary | null;
  primary_category: string | null;
  category: string | null;
  classification_confidence: number | null;
  classification_reason: string | null;
  template_version_id: number | null;
  template_sequence: number | null;
  original_template: string | null;
  final_reply: string | null;
  product_adjusted: number;
  rewrite_notes: string | null;
  detected_template_products_json: string;
  unsupported_claims_json: string;
  attention_reasons_json: string;
  state: string;
  error_code: string | null;
  error_message: string | null;
  discovered_at: string;
  processed_at: string | null;
  updated_at: string;
  item_id: string | null;
  review_phase: "initial" | "followup";
  manual_product_id: string | null;
  manual_hold_reason: string | null;
  manual_catalog_revision: number | null;
  manual_match_kind: string | null;
  manual_hold_last_seen_at: string | null;
  manual_hold_absent_scans: number;
  ai_checkpoint_stage: "template_selected" | null;
  failed_stage: AiRetryStage | null;
  ai_retry_error_kind: AiRetryErrorKind | null;
  next_retry_at: string | null;
  consecutive_ai_failure_rounds: number;
  ai_retry_claim_token: string | null;
  ai_retry_claim_expires_at: string | null;
};

function asReplyDraft(row: ReplyDraftRow): PersistedReplyDraft {
  let attentionReasons: string[] = [];
  try {
    const parsed = JSON.parse(row.attention_reasons_json) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) attentionReasons = parsed;
  } catch {
    attentionReasons = ["历史记录的检查说明无法读取"];
  }
  const stringArray = (value: string): string[] => {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
    } catch {
      return [];
    }
  };
  return {
    id: row.id,
    sourceKey: row.source_key,
    orderId: row.order_id,
    review: row.review_text,
    product: row.product_title,
    reviewedAt: row.reviewed_at,
    sentimentLabel: row.sentiment_label,
    library: row.library,
    primaryCategory: row.primary_category ?? "",
    category: row.category ?? "",
    classificationConfidence: row.classification_confidence,
    classificationReason: row.classification_reason ?? "",
    templateVersionId: row.template_version_id,
    templateSequence: row.template_sequence,
    originalTemplate: row.original_template ?? "",
    finalReply: row.final_reply ?? "",
    productAdjusted: row.product_adjusted === 1,
    rewriteNotes: row.rewrite_notes ?? "",
    detectedTemplateProducts: stringArray(row.detected_template_products_json),
    unsupportedClaims: stringArray(row.unsupported_claims_json),
    attentionReasons,
    state: row.state,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    discoveredAt: row.discovered_at,
    processedAt: row.processed_at,
    updatedAt: row.updated_at,
    itemId: row.item_id,
    reviewPhase: row.review_phase,
    manualProductId: row.manual_product_id,
    manualHoldReason: row.manual_hold_reason,
    manualCatalogRevision: row.manual_catalog_revision,
    manualMatchKind: row.manual_match_kind,
    manualHoldLastSeenAt: row.manual_hold_last_seen_at,
    manualHoldAbsentScans: row.manual_hold_absent_scans,
    aiCheckpointStage: row.ai_checkpoint_stage,
    failedStage: row.failed_stage,
    aiRetryErrorKind: row.ai_retry_error_kind,
    nextRetryAt: row.next_retry_at,
    consecutiveAiFailureRounds: row.consecutive_ai_failure_rounds,
  };
}

export class ReplyRepository {
  constructor(private readonly database: AppDatabase) {}

  discover(snapshot: TmallReviewSnapshot): { id: string; created: boolean } {
    return this.database.transaction(() => {
      const id = randomUUID();
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO reply_drafts(
          id, source_key, order_id, review_text, product_title, reviewed_at, sentiment_label,
          item_id, review_phase, state, discovered_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?)
      `).run(
        id,
        snapshot.sourceKey,
        snapshot.orderId,
        snapshot.review,
        snapshot.product,
        snapshot.reviewedAt,
        snapshot.sentimentLabel,
        snapshot.itemId?.trim() || null,
        snapshot.reviewPhase,
        now,
        now,
      );
      if (result.changes === 1) return { id, created: true };
      const existing = this.database.prepare("SELECT id, item_id, review_phase FROM reply_drafts WHERE source_key = ?").get(snapshot.sourceKey) as {
        id: string;
        item_id: string | null;
        review_phase: TmallReviewSnapshot["reviewPhase"];
      };
      const incomingItemId = snapshot.itemId?.trim() || null;
      if (existing.review_phase !== snapshot.reviewPhase) {
        throw new Error("同一评价的评价阶段冲突，已停止更新");
      }
      if (existing.item_id && incomingItemId && existing.item_id !== incomingItemId) {
        throw new Error("同一评价的商品ID冲突，已停止更新");
      }
      this.database.prepare(`
        UPDATE reply_drafts SET
          item_id = COALESCE(item_id, ?),
          updated_at = ?
        WHERE id = ?
      `).run(incomingItemId, now, existing.id);
      return { id: existing.id, created: false };
    }).immediate();
  }

  markPlatformActionObserved(
    id: string,
    platformState: Exclude<TmallReviewSnapshot["platformActionState"], undefined | "none">,
  ): PersistedReplyDraft {
    const complaintObserved = platformState.startsWith("complaint_");
    const code = complaintObserved
      ? "TMALL_PLATFORM_COMPLAINT_HANDLED"
      : platformState === "reply_record"
        ? "TMALL_REPLY_ALREADY_RECORDED"
        : "TMALL_REVIEW_NOT_REPLYABLE";
    const message = complaintObserved
      ? "当前评价阶段显示平台投诉记录或处理状态；已按平台状态跳过，不计为本程序投诉成功"
      : platformState === "reply_record"
        ? "天猫平台已存在该评价阶段的回复记录，程序已同步并跳过重复回复"
        : "该评价在天猫平台当前不可回复，程序已同步并跳过";
    return this.database.transaction(() => {
      const current = this.get(id);
      if (!current) throw new Error("回复草稿不存在");
      if (platformState === "reply_record") {
        const attempt = this.database.prepare(`
          SELECT id, state FROM reply_attempts WHERE source_key = ?
        `).get(current.sourceKey) as { id: string; state: ReplyAttemptState } | undefined;
        if (attempt && ["failed", "submitting", "submission_uncertain", "sent"].includes(attempt.state)) {
          const terminal = this.database.prepare(`
            SELECT terminal_action AS terminalAction
            FROM review_action_tombstones
            WHERE store_id = 'primary' AND source_key = ?
          `).get(current.sourceKey) as { terminalAction: string } | undefined;
          if (terminal && terminal.terminalAction !== "reply_sent") {
            throw new ReviewActionConflictError("ACTION_TERMINAL", "平台回复记录与本地终态冲突，需要人工核对");
          }
          const now = new Date().toISOString();
          const evidence = "天猫平台已显示该评价阶段的回复记录";
          this.database.prepare(`
            UPDATE reply_attempts
            SET state = 'sent', evidence = ?, error_code = NULL, error_message = NULL,
                submitted_at = COALESCE(submitted_at, ?), verified_at = ?, updated_at = ?
            WHERE id = ? AND state IN ('failed','submitting','submission_uncertain','sent')
          `).run(evidence, now, now, now, attempt.id);
          this.database.prepare(`
            UPDATE reply_drafts
            SET state = 'sent', error_code = NULL, error_message = NULL,
                ai_retry_claim_token = NULL, ai_retry_claim_expires_at = NULL,
                next_retry_at = NULL, processed_at = COALESCE(processed_at, ?), updated_at = ?
            WHERE id = ?
          `).run(now, now, id);
          this.database.prepare(`
            DELETE FROM review_action_locks
            WHERE store_id = 'primary' AND source_key = ? AND action_kind = 'reply'
          `).run(current.sourceKey);
          this.database.prepare(`
            INSERT OR IGNORE INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at)
            VALUES ('primary', ?, 'reply_sent', ?)
          `).run(current.sourceKey, now);
          return this.get(id)!;
        }
      }
      if (["sent", "submitting", "submission_uncertain"].includes(current.state)) return current;
      const now = new Date().toISOString();
      this.database.prepare(`
        UPDATE reply_drafts
        SET state = 'not_actionable', error_code = ?, error_message = ?,
            ai_retry_claim_token = NULL, ai_retry_claim_expires_at = NULL,
            next_retry_at = NULL, processed_at = ?, updated_at = ?
        WHERE id = ? AND state NOT IN ('sent','submitting','submission_uncertain')
      `).run(code, message, now, now, id);
      return this.get(id)!;
    }).immediate();
  }

  markNotActionable(id: string, code: string, message: string): PersistedReplyDraft {
    return this.database.transaction(() => {
      const current = this.get(id);
      if (!current) throw new Error("回复草稿不存在");
      if (["sent", "submitting", "submission_uncertain"].includes(current.state)) return current;
      const now = new Date().toISOString();
      this.database.prepare(`
        UPDATE reply_drafts
        SET state = 'not_actionable', error_code = ?, error_message = ?,
            ai_retry_claim_token = NULL, ai_retry_claim_expires_at = NULL,
            next_retry_at = NULL, processed_at = ?, updated_at = ?
        WHERE id = ? AND state NOT IN ('sent','submitting','submission_uncertain')
      `).run(code, message.slice(0, 800), now, now, id);
      this.database.prepare(`
        DELETE FROM review_action_locks
        WHERE store_id = 'primary' AND source_key = ?
      `).run(current.sourceKey);
      this.database.prepare(`
        INSERT OR IGNORE INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at)
        VALUES ('primary', ?, 'not_actionable', ?)
      `).run(current.sourceKey, now);
      return this.get(id)!;
    }).immediate();
  }

  saveManualProductDecision(id: string, input: {
    storeId: string;
    manualProductId: string | null;
    catalogRevision: number;
    matchKind: "not_matched" | "item_id" | "normalized_title";
    expectedClaimToken?: string;
    at?: Date;
  }): PersistedReplyDraft {
    const claimToken = normalizeAiRetryClaimToken(input.expectedClaimToken);
    const operationAt = normalizeAiRetryOperationAt(input.at);
    return this.database.transaction(() => {
      if (claimToken) this.#assertActiveAiRetryClaim(id, claimToken, operationAt);
      const draft = this.get(id);
      if (!draft) throw new Error("回复草稿不存在");
      const protectedState = [
        "manual_product_hold",
        "manual_hold_expired",
        "not_actionable",
        "sent",
        "submitting",
        "submission_uncertain",
      ].includes(draft.state);
      const protectedAction = this.database.prepare(`
        SELECT 1 FROM review_action_locks
        WHERE store_id = ? AND source_key = ?
          AND (
            action_kind <> 'reply'
            OR NOT EXISTS (
              SELECT 1 FROM complaint_cases
              WHERE complaint_cases.store_id = review_action_locks.store_id
                AND complaint_cases.source_key = review_action_locks.source_key
                AND complaint_cases.state IN ('no_complaint', 'rejected')
            )
          )
        UNION ALL
        SELECT 1 FROM review_action_tombstones WHERE store_id = ? AND source_key = ?
        LIMIT 1
      `).get(input.storeId, draft.sourceKey, input.storeId, draft.sourceKey);
      if (protectedState || protectedAction) {
        throw new ReviewActionConflictError("ACTION_CONFLICT", "该评价已有其他处理动作，不能更新人工名单决策");
      }
      const result = this.database.prepare(`
        UPDATE reply_drafts
        SET manual_product_id = CASE
              WHEN ? IS NOT NULL AND EXISTS (SELECT 1 FROM manual_products WHERE id = ?) THEN ?
              ELSE NULL
            END,
            manual_catalog_revision = ?, manual_match_kind = ?, updated_at = ?
        WHERE id = ?
          AND state NOT IN (
            'manual_product_hold', 'manual_hold_expired', 'not_actionable',
            'sent', 'submitting', 'submission_uncertain'
          )
          AND NOT EXISTS (
            SELECT 1 FROM review_action_locks
            WHERE store_id = ? AND source_key = reply_drafts.source_key
              AND (
                action_kind <> 'reply'
                OR NOT EXISTS (
                  SELECT 1 FROM complaint_cases
                  WHERE complaint_cases.store_id = review_action_locks.store_id
                    AND complaint_cases.source_key = review_action_locks.source_key
                    AND complaint_cases.state IN ('no_complaint', 'rejected')
                )
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM review_action_tombstones
            WHERE store_id = ? AND source_key = reply_drafts.source_key
          )
      `).run(
        input.manualProductId,
        input.manualProductId,
        input.manualProductId,
        input.catalogRevision,
        input.matchKind,
        operationAt,
        id,
        input.storeId,
        input.storeId,
      );
      if (result.changes !== 1) {
        throw new ReviewActionConflictError("ACTION_CONFLICT", "该评价已有其他处理动作，不能更新人工名单决策");
      }
      return this.get(id)!;
    }).immediate();
  }

  markManualProductHold(id: string, input: {
    storeId: string;
    manualProductId: string | null;
    catalogRevision: number;
    matchKind: string;
    reason: string;
    expectedClaimToken?: string;
    at?: Date;
  }): PersistedReplyDraft {
    const claimToken = normalizeAiRetryClaimToken(input.expectedClaimToken);
    const operationAt = normalizeAiRetryOperationAt(input.at);
    return this.database.transaction(() => {
      if (claimToken) this.#assertActiveAiRetryClaim(id, claimToken, operationAt);
      const draft = this.get(id);
      if (!draft) throw new Error("回复草稿不存在");
      const gate = new ReviewActionGate(this.database);
      const currentLock = gate.getLock(input.storeId, draft.sourceKey);
      if (draft.state === "manual_product_hold" || currentLock?.actionKind === "manual_hold") {
        const currentProductId = input.manualProductId && this.database.prepare(
          "SELECT id FROM manual_products WHERE id = ?",
        ).get(input.manualProductId) ? input.manualProductId : null;
        const sameDecision = draft.state === "manual_product_hold"
          && currentLock?.actionKind === "manual_hold"
          && draft.manualProductId === currentProductId
          && draft.manualCatalogRevision === input.catalogRevision
          && draft.manualMatchKind === input.matchKind
          && draft.manualHoldReason === input.reason.slice(0, 800);
        if (sameDecision) return draft;
        throw new ReviewActionConflictError("ACTION_VERSION_CONFLICT", "人工处理决策已发生变化，不能覆盖");
      }
      // A reply lock created by the completed no-complaint review is a
      // deliberate hand-off, not an external submission.  The product
      // exclusion decision is still allowed to take ownership before any
      // reply attempt exists.  Any other reply lock remains a hard conflict.
      if (currentLock?.actionKind === "reply") {
        const releasedByComplaintReview = this.database.prepare(`
          SELECT 1 FROM complaint_cases
          WHERE store_id = ? AND source_key = ? AND state IN ('no_complaint', 'rejected')
          LIMIT 1
        `).get(input.storeId, draft.sourceKey);
        if (!releasedByComplaintReview) {
          throw new ReviewActionConflictError("ACTION_CONFLICT", "该评价已有其他处理动作，不能转人工处理");
        }
        gate.transition(input.storeId, draft.sourceKey, "reply", "manual_hold", currentLock.lockVersion);
      } else {
        gate.acquire(input.storeId, draft.sourceKey, "manual_hold");
      }
      this.clearUnsubmittedDraftForManualHold(id, input.storeId);
      const now = operationAt;
      const result = this.database.prepare(`
        UPDATE reply_drafts
        SET state = 'manual_product_hold',
            manual_product_id = CASE
              WHEN ? IS NOT NULL AND EXISTS (SELECT 1 FROM manual_products WHERE id = ?) THEN ?
              ELSE NULL
            END,
            manual_hold_reason = ?,
            manual_catalog_revision = ?, manual_match_kind = ?, manual_hold_last_seen_at = ?,
            manual_hold_absent_scans = 0, error_code = NULL, error_message = NULL,
            processed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.manualProductId,
        input.manualProductId,
        input.manualProductId,
        input.reason.slice(0, 800),
        input.catalogRevision,
        input.matchKind,
        now,
        now,
        now,
        id,
      );
      if (result.changes !== 1) throw new Error("回复草稿不存在");
      return this.get(id)!;
    }).immediate();
  }

  clearUnsubmittedDraftForManualHold(id: string, storeId = "primary"): void {
    this.database.transaction(() => {
      const draft = this.get(id);
      if (!draft) throw new Error("回复草稿不存在");
      const blocked = this.database.prepare(`
        SELECT 1 FROM reply_attempts
        WHERE source_key = ? AND state IN ('pending', 'submitting', 'sent', 'submission_uncertain')
        UNION ALL
        SELECT 1 FROM review_action_tombstones WHERE store_id = ? AND source_key = ?
        LIMIT 1
      `).get(draft.sourceKey, storeId, draft.sourceKey);
      if (blocked) throw new ReviewActionConflictError("ACTION_CONFLICT", "该评价已有提交记录，不能转为人工处理");
      this.database.prepare(`
        UPDATE reply_drafts
        SET library = NULL, primary_category = NULL, category = NULL,
            classification_confidence = NULL, classification_reason = NULL,
            template_version_id = NULL, template_sequence = NULL, original_template = NULL,
            final_reply = NULL, product_adjusted = 0, rewrite_notes = NULL,
            attention_reasons_json = '[]', detected_template_products_json = '[]',
            unsupported_claims_json = '[]', error_code = NULL, error_message = NULL,
            ai_checkpoint_stage = NULL, failed_stage = NULL, ai_retry_error_kind = NULL,
            next_retry_at = NULL,
            ai_retry_claim_token = NULL, ai_retry_claim_expires_at = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), id);
    }).immediate();
  }

  releaseEligibleManualHolds(input: { manualProductIds: readonly string[]; storeId?: string }): number {
    return this.database.transaction(() => {
      const storeId = input.storeId ?? "primary";
      const productIds = input.manualProductIds;
      if (productIds.length === 0) return 0;
      const productFilter = `AND d.manual_product_id IN (${productIds.map(() => "?").join(",")})`;
      const rows = this.database.prepare(`
        SELECT d.source_key, l.lock_version
        FROM reply_drafts d
        JOIN review_action_locks l
          ON l.store_id = ? AND l.source_key = d.source_key AND l.action_kind = 'manual_hold'
        LEFT JOIN reply_attempts a
          ON a.source_key = d.source_key
         AND a.state IN ('pending', 'submitting', 'sent', 'submission_uncertain')
        LEFT JOIN review_action_tombstones t ON t.store_id = ? AND t.source_key = d.source_key
        WHERE d.state = 'manual_product_hold' AND a.id IS NULL AND t.source_key IS NULL
          ${productFilter}
      `).all(storeId, storeId, ...productIds) as Array<{ source_key: string; lock_version: number }>;
      const gate = new ReviewActionGate(this.database);
      let released = 0;
      for (const row of rows) {
        gate.releaseManualHold(storeId, row.source_key, row.lock_version);
        released += 1;
      }
      return released;
    }).immediate();
  }

  recordManualHoldScanEvidence(input: {
    storeId?: string;
    scopeStartDate: string;
    scopeEndDate: string;
    seenSourceKeys: readonly string[];
    complete: boolean;
    now?: Date;
  }): { observed: number; absent: number; finalized: number } {
    const scope = resolveReviewScope({
      preset: "custom",
      startDate: input.scopeStartDate,
      endDate: input.scopeEndDate,
    }, input.now ?? new Date());
    if (!input.complete) return { observed: 0, absent: 0, finalized: 0 };
    return this.database.transaction(() => {
      const storeId = input.storeId ?? "primary";
      const seen = new Set(input.seenSourceKeys);
      const rows = this.database.prepare(`
        SELECT d.id, d.source_key, d.reviewed_at, d.manual_hold_absent_scans, l.lock_version
        FROM reply_drafts d
        JOIN review_action_locks l
          ON l.store_id = ? AND l.source_key = d.source_key AND l.action_kind = 'manual_hold'
        WHERE d.state = 'manual_product_hold'
      `).all(storeId) as Array<{
        id: string; source_key: string; reviewed_at: string | null;
        manual_hold_absent_scans: number; lock_version: number;
      }>;
      const now = (input.now ?? new Date()).toISOString();
      let observed = 0;
      let absent = 0;
      let finalized = 0;
      for (const row of rows) {
        if (!row.reviewed_at || !isReviewedAtWithinScope(row.reviewed_at, scope)) continue;
        if (seen.has(row.source_key)) {
          this.database.prepare(`
            UPDATE reply_drafts
            SET manual_hold_absent_scans = 0, manual_hold_last_seen_at = ?, updated_at = ?
            WHERE id = ? AND state = 'manual_product_hold'
          `).run(now, now, row.id);
          observed += 1;
          continue;
        }
        absent += 1;
        const nextCount = row.manual_hold_absent_scans + 1;
        if (nextCount < 2) {
          this.database.prepare(`
            UPDATE reply_drafts SET manual_hold_absent_scans = ?, updated_at = ?
            WHERE id = ? AND state = 'manual_product_hold'
          `).run(nextCount, now, row.id);
          continue;
        }
        const removed = this.database.prepare(`
          DELETE FROM review_action_locks
          WHERE store_id = ? AND source_key = ? AND action_kind = 'manual_hold' AND lock_version = ?
        `).run(storeId, row.source_key, row.lock_version);
        if (removed.changes !== 1) throw new ReviewActionConflictError("ACTION_VERSION_CONFLICT", "动作状态已发生变化，请重新扫描");
        this.database.prepare(`
          INSERT INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at)
          VALUES (?, ?, 'not_actionable', ?)
        `).run(storeId, row.source_key, now);
        this.database.prepare(`
          UPDATE reply_drafts
          SET state = 'not_actionable', manual_hold_absent_scans = ?, processed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(nextCount, now, now, row.id);
        finalized += 1;
      }
      return { observed, absent, finalized };
    }).immediate();
  }

  compactExpiredManualHolds(retentionDays: number, now = new Date(), storeId = "primary"): number {
    if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error("人工保留天数必须大于 0");
    return this.database.transaction(() => {
      const cutoff = new Date(now.getTime() - Math.trunc(retentionDays) * 86_400_000).toISOString();
      const rows = this.database.prepare(`
        SELECT d.id, d.source_key, l.lock_version
        FROM reply_drafts d
        JOIN review_action_locks l
          ON l.store_id = ? AND l.source_key = d.source_key AND l.action_kind = 'manual_hold'
        LEFT JOIN reply_attempts a
          ON a.source_key = d.source_key
         AND a.state IN ('pending', 'submitting', 'sent', 'submission_uncertain')
        LEFT JOIN review_action_tombstones t ON t.store_id = ? AND t.source_key = d.source_key
        WHERE d.state = 'manual_product_hold' AND d.discovered_at < ?
          AND a.id IS NULL AND t.source_key IS NULL
      `).all(storeId, storeId, cutoff) as Array<{ id: string; source_key: string; lock_version: number }>;
      const completedAt = now.toISOString();
      let compacted = 0;
      for (const row of rows) {
        const removed = this.database.prepare(`
          DELETE FROM review_action_locks
          WHERE store_id = ? AND source_key = ? AND action_kind = 'manual_hold' AND lock_version = ?
        `).run(storeId, row.source_key, row.lock_version);
        if (removed.changes !== 1) throw new ReviewActionConflictError("ACTION_VERSION_CONFLICT", "动作状态已发生变化，请稍后重试");
        this.database.prepare(`
          INSERT INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at)
          VALUES (?, ?, 'manual_hold_expired', ?)
        `).run(storeId, row.source_key, completedAt);
        this.database.prepare(`
          UPDATE reply_drafts SET state = 'manual_hold_expired', processed_at = ?, updated_at = ? WHERE id = ?
        `).run(completedAt, completedAt, row.id);
        compacted += 1;
      }
      return compacted;
    }).immediate();
  }

  saveAiCheckpoint(id: string, input: {
    library: TemplateLibrary;
    primaryCategory: string;
    category: string;
    confidence: number;
    reason: string;
    needsAttention: boolean;
    templateVersionId: number;
    templateSequence: number;
    originalTemplate: string;
    expectedClaimToken?: string;
    at?: Date;
  }): PersistedReplyDraft {
    if ((input.library !== "good" && input.library !== "bad")
      || !input.category.trim()
      || !Number.isFinite(input.confidence)
      || input.confidence < 0
      || input.confidence > 1
      || !input.reason.trim()
      || !Number.isInteger(input.templateVersionId)
      || input.templateVersionId < 1
      || !Number.isInteger(input.templateSequence)
      || input.templateSequence < 1
      || !input.originalTemplate.trim()) {
      throw new Error("AI 处理检查点不完整");
    }
    const expectedClaimToken = normalizeAiRetryClaimToken(input.expectedClaimToken);
    const operationAt = normalizeAiRetryOperationAt(input.at);
    return this.database.transaction(() => {
      const template = this.database.prepare(`
        SELECT 1
        FROM template_versions v
        JOIN template_categories c ON c.version_id = v.id
        JOIN template_replies r ON r.category_id = c.id
        WHERE v.id = ? AND v.library = ? AND c.category = ?
          AND r.sequence = ? AND r.text = ?
        LIMIT 1
      `).get(
        input.templateVersionId,
        input.library,
        input.category,
        input.templateSequence,
        input.originalTemplate,
      );
      if (!template) throw new Error("所选话术与模板版本不一致");

      const now = operationAt;
      const reasons = input.needsAttention ? ["AI 建议人工检查分类"] : [];
      const result = this.database.prepare(`
        UPDATE reply_drafts
        SET library = ?, primary_category = ?, category = ?,
            classification_confidence = ?, classification_reason = ?,
            template_version_id = ?, template_sequence = ?, original_template = ?,
            attention_reasons_json = ?, ai_checkpoint_stage = 'template_selected',
            failed_stage = NULL, ai_retry_error_kind = NULL, next_retry_at = NULL,
            state = 'template_selected', error_code = NULL, error_message = NULL,
            processed_at = NULL, updated_at = ?
        WHERE id = ?
          AND state IN ('discovered', 'classifying', 'retry_wait')
          AND consecutive_ai_failure_rounds < 3
          AND ai_checkpoint_stage IS NULL
          AND (
            (state IN ('discovered', 'classifying')
              AND (
                (ai_retry_claim_token IS NULL AND ? IS NULL)
                OR (ai_retry_claim_token = ? AND ai_retry_claim_expires_at > ?)
              ))
            OR
            (state = 'retry_wait' AND ai_retry_claim_token = ?
              AND ai_retry_claim_expires_at > ?)
          )
          ${AI_RETRY_NO_ACTION_CONFLICT_SQL}
      `).run(
        input.library,
        input.primaryCategory,
        input.category,
        input.confidence,
        input.reason,
        input.templateVersionId,
        input.templateSequence,
        input.originalTemplate,
        JSON.stringify(reasons),
        now,
        id,
        expectedClaimToken,
        expectedClaimToken,
        operationAt,
        expectedClaimToken,
        operationAt,
      );
      if (result.changes !== 1) {
        throw new ReviewActionConflictError("ACTION_CONFLICT", "该评价已有其他处理动作，不能保存 AI 检查点");
      }
      return this.get(id)!;
    }).immediate();
  }

  recordAiRetryRoundFailure(id: string, input: {
    failedStage: AiRetryStage;
    errorKind: AiRetryErrorKind;
    nextRetryAt: Date;
    expectedClaimToken?: string;
    at?: Date;
  }): PersistedReplyDraft {
    if (input.failedStage !== "classification" && input.failedStage !== "rewrite") {
      throw new Error("AI 失败阶段无效");
    }
    if (!(AI_RETRY_ERROR_KINDS as readonly string[]).includes(input.errorKind)) {
      throw new Error("AI 错误类型不可重试");
    }
    if (!(input.nextRetryAt instanceof Date) || Number.isNaN(input.nextRetryAt.getTime())) {
      throw new Error("AI 下次重试时间无效");
    }
    const expectedClaimToken = normalizeAiRetryClaimToken(input.expectedClaimToken);
    const operationAt = normalizeAiRetryOperationAt(input.at);
    return this.database.transaction(() => {
      const current = this.get(id);
      if (current && ["read_only_ready", "needs_attention"].includes(current.state)) {
        if (input.failedStage !== "classification" || expectedClaimToken !== null) {
          throw new ReviewActionConflictError("ACTION_CONFLICT", "已完成草稿只能安全进入名单情感分类重试");
        }
        const result = this.database.prepare(`
          UPDATE reply_drafts
          SET library = NULL, primary_category = NULL, category = NULL,
              classification_confidence = NULL, classification_reason = NULL,
              template_version_id = NULL, template_sequence = NULL, original_template = NULL,
              final_reply = NULL, product_adjusted = 0, rewrite_notes = NULL,
              attention_reasons_json = '[]', detected_template_products_json = '[]',
              unsupported_claims_json = '[]', ai_checkpoint_stage = NULL,
              state = 'retry_wait', failed_stage = 'classification', ai_retry_error_kind = ?, next_retry_at = ?,
              consecutive_ai_failure_rounds = consecutive_ai_failure_rounds + 1,
              ai_retry_claim_token = NULL, ai_retry_claim_expires_at = NULL,
              error_code = NULL, error_message = NULL, processed_at = NULL, updated_at = ?
          WHERE id = ?
            AND state IN ('read_only_ready', 'needs_attention')
            AND consecutive_ai_failure_rounds < 3
            ${AI_RETRY_NO_ACTION_CONFLICT_SQL}
        `).run(input.errorKind, input.nextRetryAt.toISOString(), operationAt, id);
        if (result.changes !== 1) {
          throw new ReviewActionConflictError("ACTION_CONFLICT", "旧回复已有提交记录或不兼容动作锁，不能进入安全重试");
        }
        return this.get(id)!;
      }
      const result = this.database.prepare(`
        UPDATE reply_drafts
        SET state = 'retry_wait', failed_stage = ?, ai_retry_error_kind = ?, next_retry_at = ?,
            consecutive_ai_failure_rounds = consecutive_ai_failure_rounds + 1,
            ai_retry_claim_token = NULL, ai_retry_claim_expires_at = NULL,
            error_code = NULL, error_message = NULL, processed_at = NULL, updated_at = ?
        WHERE id = ?
          AND state IN ('discovered', 'classifying', 'template_selected', 'rewriting', 'retry_wait')
          AND consecutive_ai_failure_rounds < 3
          AND (
            (? = 'classification' AND ai_checkpoint_stage IS NULL)
            OR
            (? = 'rewrite' AND ai_checkpoint_stage = 'template_selected'
              AND library IS NOT NULL AND category IS NOT NULL
              AND template_version_id IS NOT NULL AND template_sequence IS NOT NULL
              AND original_template IS NOT NULL)
          )
          AND (
            (state != 'retry_wait' AND ai_retry_claim_token IS NULL AND ? IS NULL)
            OR
            (ai_retry_claim_token IS NOT NULL AND ai_retry_claim_token = ?
              AND ai_retry_claim_expires_at > ?)
          )
          ${AI_RETRY_NO_ACTION_CONFLICT_SQL}
      `).run(
        input.failedStage,
        input.errorKind,
        input.nextRetryAt.toISOString(),
        operationAt,
        id,
        input.failedStage,
        input.failedStage,
        expectedClaimToken,
        expectedClaimToken,
        operationAt,
      );
      if (result.changes !== 1) {
        throw new ReviewActionConflictError("ACTION_CONFLICT", "该评价已有提交记录、动作锁或不匹配的 AI 检查点");
      }
      return this.get(id)!;
    }).immediate();
  }

  hasOpenAiCircuit(): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM reply_drafts
      WHERE state = 'retry_wait' AND consecutive_ai_failure_rounds >= 3
        ${AI_RETRY_NO_ACTION_CONFLICT_SQL}
      LIMIT 1
    `).get());
  }

  /**
   * A successful, explicit provider health check can reopen only a transient
   * provider-failure circuit. Model-contract failures require deterministic
   * corrective evidence and are never reset by connectivity alone.
   */
  reopenAiRetryCircuitsAfterHealthCheck(at = new Date()): number {
    const operationAt = normalizeAiRetryOperationAt(at);
    return this.database.transaction(() => this.database.prepare(`
      UPDATE reply_drafts
      SET consecutive_ai_failure_rounds = 0,
          next_retry_at = ?,
          ai_retry_claim_token = NULL,
          ai_retry_claim_expires_at = NULL,
          updated_at = ?
      WHERE state = 'retry_wait'
        AND consecutive_ai_failure_rounds >= 3
        AND ai_retry_error_kind IN ('network', 'timeout', 'rate_limited', 'service_unavailable', 'transient_unknown')
        ${AI_RETRY_NO_ACTION_CONFLICT_SQL}
    `).run(operationAt, operationAt).changes).immediate();
  }

  hasDueAiRetryOutsideScope(input: { now: Date; scope: Pick<ResolvedReviewScope, "startDate" | "endDate">; includeNotDue?: boolean }): boolean {
    const now = normalizeAiRetryOperationAt(input.now);
    let scope: ResolvedReviewScope;
    try {
      scope = resolveAiRetryDateScope(input.scope);
    } catch {
      return true;
    }
    const rows = this.database.prepare(`
      SELECT reviewed_at FROM reply_drafts
      WHERE state = 'retry_wait'
        AND consecutive_ai_failure_rounds < 3
        AND ai_retry_error_kind IS NOT NULL
        AND next_retry_at IS NOT NULL
        ${input.includeNotDue ? "" : "AND next_retry_at <= ?"}
        ${AI_RETRY_NO_ACTION_CONFLICT_SQL}
    `).all(...(input.includeNotDue ? [] : [now])) as Array<{ reviewed_at: string | null }>;
    return rows.some((row) => !isStrictAiRetryTimestampWithinScope(row.reviewed_at, scope));
  }

  claimObservedAiRetry(input: {
    id: string;
    sourceKey: string;
    now: Date;
    leaseMs: number;
    scope?: Pick<ResolvedReviewScope, "startDate" | "endDate">;
  }): AiRetryClaimBatch {
    if (!input.id.trim() || !input.sourceKey.trim()) {
      throw new Error("页面识别到的 AI 重试记录无效");
    }
    return this.claimDueAiRetries({
      now: input.now,
      leaseMs: input.leaseMs,
      limit: 1,
      ...(input.scope ? { scope: input.scope } : {}),
      includeNotDue: true,
      observed: { id: input.id, sourceKey: input.sourceKey },
    });
  }

  claimDueAiRetries(input: {
    now: Date;
    leaseMs: number;
    limit?: number;
    scope?: Pick<ResolvedReviewScope, "startDate" | "endDate">;
    includeNotDue?: boolean;
    observed?: { id: string; sourceKey: string };
  }): AiRetryClaimBatch {
    if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
      throw new Error("AI 重试领取时间无效");
    }
    if (!Number.isFinite(input.leaseMs) || !Number.isInteger(input.leaseMs)
      || input.leaseMs < 1_000 || input.leaseMs > 30 * 60_000) {
      throw new Error("AI 重试租约必须在 1 秒至 30 分钟之间");
    }
    const safeLimit = Math.max(1, Math.min(1000, Math.trunc(input.limit ?? 100)));
    const resolvedScope = input.scope ? resolveAiRetryDateScope(input.scope) : null;
    const claimToken = randomUUID();
    const now = input.now.toISOString();
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString();
    const dueFilter = input.includeNotDue ? "" : "AND next_retry_at <= ?";
    const scopeFilter = input.scope ? `
          AND reviewed_at IS NOT NULL
          AND date(substr(reviewed_at, 1, 10)) IS NOT NULL
          AND substr(reviewed_at, 1, 10) >= ?
          AND substr(reviewed_at, 1, 10) <= ?` : "";
    const observedFilter = input.observed ? "AND id = ? AND source_key = ?" : "";
    return this.database.transaction(() => {
      const candidates = this.database.prepare(`
        SELECT id, reviewed_at
        FROM reply_drafts
        WHERE (
          (state = 'retry_wait'
            AND consecutive_ai_failure_rounds < 3
            AND ai_retry_error_kind IS NOT NULL
            AND next_retry_at IS NOT NULL
            ${dueFilter}
            AND (
              (failed_stage = 'classification' AND ai_checkpoint_stage IS NULL)
              OR
              (failed_stage = 'rewrite'
                AND ai_checkpoint_stage = 'template_selected'
                AND library IS NOT NULL
                AND length(trim(category)) > 0
                AND template_version_id IS NOT NULL
                AND template_sequence IS NOT NULL
                AND template_sequence > 0
                AND length(trim(original_template)) > 0
                AND EXISTS (
                  SELECT 1
                  FROM template_versions v
                  JOIN template_categories c ON c.version_id = v.id
                  JOIN template_replies r ON r.category_id = c.id
                  WHERE v.id = reply_drafts.template_version_id
                    AND v.library = reply_drafts.library
                    AND c.category = reply_drafts.category
                    AND r.sequence = reply_drafts.template_sequence
                    AND r.text = reply_drafts.original_template
                ))
            ))
          OR
          (state IN ('template_selected', 'rewriting')
            AND consecutive_ai_failure_rounds < 3
            AND ai_checkpoint_stage = 'template_selected'
            AND ai_retry_claim_token IS NOT NULL
            AND ai_retry_claim_expires_at IS NOT NULL
            AND ai_retry_claim_expires_at <= ?
            AND library IS NOT NULL
            AND length(trim(category)) > 0
            AND template_version_id IS NOT NULL
            AND template_sequence IS NOT NULL
            AND template_sequence > 0
            AND length(trim(original_template)) > 0
            AND EXISTS (
              SELECT 1
              FROM template_versions v
              JOIN template_categories c ON c.version_id = v.id
              JOIN template_replies r ON r.category_id = c.id
              WHERE v.id = reply_drafts.template_version_id
                AND v.library = reply_drafts.library
                AND c.category = reply_drafts.category
                AND r.sequence = reply_drafts.template_sequence
                AND r.text = reply_drafts.original_template
            ))
        )
          AND (
            ai_retry_claim_token IS NULL
            OR ai_retry_claim_expires_at IS NULL
            OR ai_retry_claim_expires_at <= ?
          )
          ${scopeFilter}
          ${observedFilter}
          AND NOT EXISTS (
            SELECT 1 FROM reply_attempts
            WHERE reply_attempts.source_key = reply_drafts.source_key
          )
          AND NOT EXISTS (
            SELECT 1 FROM review_action_locks
            WHERE review_action_locks.source_key = reply_drafts.source_key
          )
          AND NOT EXISTS (
            SELECT 1 FROM review_action_tombstones
            WHERE review_action_tombstones.source_key = reply_drafts.source_key
          )
        ORDER BY COALESCE(next_retry_at, updated_at), discovered_at
        LIMIT ?
      `).all(...(input.scope
        ? [
            now,
            now,
            ...(input.includeNotDue ? [] : [now]),
            input.scope.startDate,
            input.scope.endDate,
            ...(input.observed ? [input.observed.id, input.observed.sourceKey] : []),
            safeLimit,
          ]
        : [
            now,
            now,
            ...(input.includeNotDue ? [] : [now]),
            ...(input.observed ? [input.observed.id, input.observed.sourceKey] : []),
            safeLimit,
          ])) as Array<{ id: string; reviewed_at: string | null }>;
      const eligibleCandidates = resolvedScope
        ? candidates.filter((candidate) => isStrictAiRetryTimestampWithinScope(candidate.reviewed_at, resolvedScope))
        : candidates;
      if (eligibleCandidates.length === 0) return { claimToken, leaseExpiresAt, drafts: [] };

      const ids = eligibleCandidates.map((candidate) => candidate.id);
      const placeholders = ids.map(() => "?").join(", ");
      const claimed = this.database.prepare(`
        UPDATE reply_drafts
        SET ai_retry_claim_token = ?, ai_retry_claim_expires_at = ?, updated_at = ?
        WHERE id IN (${placeholders})
          AND (
            ai_retry_claim_token IS NULL
            OR ai_retry_claim_expires_at IS NULL
            OR ai_retry_claim_expires_at <= ?
          )
      `).run(claimToken, leaseExpiresAt, now, ...ids, now);
      if (claimed.changes !== ids.length) {
        throw new ReviewActionConflictError("ACTION_VERSION_CONFLICT", "AI 重试任务已被其他运行实例领取");
      }
      const drafts = (this.database.prepare(`
        SELECT * FROM reply_drafts
        WHERE ai_retry_claim_token = ?
        ORDER BY COALESCE(next_retry_at, updated_at), discovered_at
      `).all(claimToken) as ReplyDraftRow[]).map(asReplyDraft);
      return { claimToken, leaseExpiresAt, drafts };
    }).immediate();
  }

  /**
   * Gives an unstarted or paused retry lease back immediately.  The compare
   * and swap intentionally refuses to touch a terminal/action-owned draft;
   * callers may only release the exact, still-live lease they claimed.
   */
  releaseAiRetryClaim(id: string, input: { claimToken: string; at: Date }): boolean {
    const claimToken = normalizeAiRetryClaimToken(input.claimToken);
    if (!claimToken) throw new Error("AI retry claim token is invalid");
    const operationAt = normalizeAiRetryOperationAt(input.at);
    return this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE reply_drafts
        SET state = CASE WHEN state IN ('template_selected', 'rewriting') THEN 'retry_wait' ELSE state END,
            failed_stage = CASE
              WHEN state IN ('template_selected', 'rewriting')
                THEN COALESCE(failed_stage, CASE WHEN ai_checkpoint_stage = 'template_selected' THEN 'rewrite' ELSE 'classification' END)
              ELSE failed_stage
            END,
            ai_retry_error_kind = CASE
              WHEN state IN ('template_selected', 'rewriting') THEN COALESCE(ai_retry_error_kind, 'transient_unknown')
              ELSE ai_retry_error_kind
            END,
            next_retry_at = CASE
              WHEN state IN ('template_selected', 'rewriting') THEN COALESCE(next_retry_at, ?)
              ELSE next_retry_at
            END,
            ai_retry_claim_token = NULL, ai_retry_claim_expires_at = NULL, updated_at = ?
        WHERE id = ?
          AND ai_retry_claim_token = ?
          AND ai_retry_claim_expires_at IS NOT NULL
          AND ai_retry_claim_expires_at > ?
          AND state IN ('retry_wait', 'template_selected', 'rewriting')
          ${AI_RETRY_NO_ACTION_CONFLICT_SQL}
      `).run(operationAt, operationAt, id, claimToken, operationAt);
      return result.changes === 1;
    }).immediate();
  }

  /** Startup recovery for AI-only leases.  It never alters a submission or action-owned record. */
  recoverInterruptedAiRetryClaims(at = new Date()): number {
    const operationAt = normalizeAiRetryOperationAt(at);
    return this.database.transaction(() => this.database.prepare(`
      UPDATE reply_drafts
      SET state = CASE
            WHEN state = 'classifying' AND ai_checkpoint_stage IS NULL THEN 'discovered'
            WHEN state IN ('template_selected', 'rewriting') THEN 'retry_wait'
            ELSE state
          END,
          failed_stage = CASE
            WHEN state IN ('template_selected', 'rewriting')
              THEN COALESCE(failed_stage, CASE WHEN ai_checkpoint_stage = 'template_selected' THEN 'rewrite' ELSE 'classification' END)
            ELSE failed_stage
          END,
          ai_retry_error_kind = CASE
            WHEN state IN ('template_selected', 'rewriting') THEN COALESCE(ai_retry_error_kind, 'transient_unknown')
            ELSE ai_retry_error_kind
          END,
          next_retry_at = CASE
            WHEN state IN ('template_selected', 'rewriting') THEN COALESCE(next_retry_at, ?)
            ELSE next_retry_at
          END,
          ai_retry_claim_token = NULL, ai_retry_claim_expires_at = NULL, updated_at = ?
      WHERE ai_retry_claim_token IS NOT NULL
        AND ai_retry_claim_expires_at IS NOT NULL
        AND state IN ('discovered', 'classifying', 'retry_wait', 'template_selected', 'rewriting')
        ${AI_RETRY_NO_ACTION_CONFLICT_SQL}
    `).run(operationAt, operationAt).changes).immediate();
  }

  /**
   * Confirms that a claimed retry is still exclusively owned immediately before
   * an external AI request. This deliberately performs no state transition: it
   * is a short-lived guard against an expired or taken-over lease spending an
   * additional model request.
   */
  assertAiRetryClaim(id: string, claimToken: string, at = new Date()): PersistedReplyDraft {
    const expectedClaimToken = normalizeAiRetryClaimToken(claimToken);
    if (!expectedClaimToken) throw new Error("AI retry claim token is invalid");
    const operationAt = normalizeAiRetryOperationAt(at);
    return this.database.transaction(() => this.#assertActiveAiRetryClaim(id, expectedClaimToken, operationAt)).immediate();
  }

  /** Extends an active internal AI lease immediately before a model request. */
  renewAiRetryClaim(id: string, input: { claimToken: string; at: Date; leaseMs: number }): boolean {
    const claimToken = normalizeAiRetryClaimToken(input.claimToken);
    const operationAt = normalizeAiRetryOperationAt(input.at);
    if (!Number.isFinite(input.leaseMs) || !Number.isInteger(input.leaseMs)
      || input.leaseMs < 1_000 || input.leaseMs > 30 * 60_000) {
      throw new Error("AI retry lease duration is invalid");
    }
    const expiresAt = new Date(input.at.getTime() + input.leaseMs).toISOString();
    return this.database.transaction(() => this.database.prepare(`
      UPDATE reply_drafts
      SET ai_retry_claim_expires_at = ?, updated_at = ?
      WHERE id = ?
        AND ai_retry_claim_token = ?
        AND ai_retry_claim_expires_at IS NOT NULL
        AND ai_retry_claim_expires_at > ?
        ${AI_RETRY_ACTIVE_CLAIM_ACTION_GUARD_SQL}
    `).run(expiresAt, operationAt, id, claimToken, operationAt).changes === 1).immediate();
  }

  /** Claims ordinary draft generation so concurrent reprocess requests cannot both call AI. */
  claimDraftProcessing(id: string, input: { at: Date; leaseMs: number }): string | null {
    const operationAt = normalizeAiRetryOperationAt(input.at);
    if (!Number.isFinite(input.leaseMs) || !Number.isInteger(input.leaseMs)
      || input.leaseMs < 1_000 || input.leaseMs > 30 * 60_000) throw new Error("draft processing lease duration is invalid");
    const claimToken = randomUUID();
    const expiresAt = new Date(input.at.getTime() + input.leaseMs).toISOString();
    const changed = this.database.transaction(() => this.database.prepare(`
      UPDATE reply_drafts
      SET ai_retry_claim_token = ?, ai_retry_claim_expires_at = ?, updated_at = ?
      WHERE id = ?
        AND state IN ('discovered', 'classifying', 'template_selected', 'rewriting')
        AND consecutive_ai_failure_rounds < 3
        AND (ai_retry_claim_token IS NULL OR ai_retry_claim_expires_at IS NULL OR ai_retry_claim_expires_at <= ?)
        ${AI_RETRY_NO_ACTION_CONFLICT_SQL}
    `).run(claimToken, expiresAt, operationAt, id, operationAt).changes === 1).immediate();
    return changed ? claimToken : null;
  }

  /** Special claim used only to resume a safe pre-submit complaint analysis failure. */
  claimFailedComplaintAnalysisProcessing(id: string, input: { at: Date; leaseMs: number }): string | null {
    const operationAt = normalizeAiRetryOperationAt(input.at);
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 30 * 60_000) throw new Error("draft processing lease duration is invalid");
    const claimToken = randomUUID();
    const expiresAt = new Date(input.at.getTime() + input.leaseMs).toISOString();
    const changed = this.database.transaction(() => this.database.prepare(`
      UPDATE reply_drafts SET ai_retry_claim_token = ?, ai_retry_claim_expires_at = ?, updated_at = ?
      WHERE id = ? AND state = 'discovered'
        AND (ai_retry_claim_token IS NULL OR ai_retry_claim_expires_at IS NULL OR ai_retry_claim_expires_at <= ?)
        AND EXISTS (
          SELECT 1 FROM complaint_cases c
          JOIN review_action_locks l ON l.store_id = c.store_id AND l.source_key = c.source_key
            AND l.action_kind = 'complaint' AND l.lock_version = c.action_lock_version
          WHERE c.source_key = reply_drafts.source_key AND c.state IN ('failed','discovered')
            AND c.complaint_type IS NULL AND c.fact_code IS NULL AND c.description IS NULL
            AND NOT EXISTS (SELECT 1 FROM complaint_attempts a WHERE a.complaint_case_id = c.id)
        )
    `).run(claimToken, expiresAt, operationAt, id, operationAt).changes === 1).immediate();
    return changed ? claimToken : null;
  }

  canResumeFailedComplaintAnalysis(id: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM reply_drafts d
      JOIN complaint_cases c ON c.source_key = d.source_key
      JOIN review_action_locks l ON l.store_id = c.store_id AND l.source_key = c.source_key
        AND l.action_kind = 'complaint' AND l.lock_version = c.action_lock_version
      WHERE d.id = ? AND d.state = 'discovered' AND d.ai_retry_claim_token IS NULL
        AND c.state IN ('failed','discovered') AND c.complaint_type IS NULL AND c.fact_code IS NULL AND c.description IS NULL
        AND NOT EXISTS (SELECT 1 FROM complaint_attempts a WHERE a.complaint_case_id = c.id)
      LIMIT 1`).get(id));
  }

  /** Returns an interrupted ordinary draft to its current safe state. */
  releaseDraftProcessingClaim(id: string, input: { claimToken: string; at: Date }): boolean {
    const claimToken = normalizeAiRetryClaimToken(input.claimToken);
    const operationAt = normalizeAiRetryOperationAt(input.at);
    return this.database.transaction(() => this.database.prepare(`
      UPDATE reply_drafts
      SET ai_retry_claim_token = NULL, ai_retry_claim_expires_at = NULL, updated_at = ?
      WHERE id = ? AND ai_retry_claim_token = ? AND ai_retry_claim_expires_at > ?
        AND state IN ('discovered', 'classifying', 'template_selected', 'rewriting')
        ${AI_RETRY_NO_ACTION_CONFLICT_SQL}
    `).run(operationAt, id, claimToken, operationAt).changes === 1).immediate();
  }

  releaseFailedComplaintAnalysisProcessingClaim(id: string, input: { claimToken: string; at: Date }): boolean {
    const claimToken = normalizeAiRetryClaimToken(input.claimToken);
    const operationAt = normalizeAiRetryOperationAt(input.at);
    return this.database.transaction(() => this.database.prepare(`
      UPDATE reply_drafts SET ai_retry_claim_token = NULL, ai_retry_claim_expires_at = NULL, updated_at = ?
      WHERE id = ? AND ai_retry_claim_token = ? AND ai_retry_claim_expires_at > ? AND state = 'discovered'
        AND EXISTS (
          SELECT 1 FROM complaint_cases c
          JOIN review_action_locks l ON l.store_id = c.store_id AND l.source_key = c.source_key
            AND l.action_kind = 'complaint' AND l.lock_version = c.action_lock_version
          WHERE c.source_key = reply_drafts.source_key AND c.state IN ('failed','discovered')
            AND c.complaint_type IS NULL AND c.fact_code IS NULL AND c.description IS NULL
            AND NOT EXISTS (SELECT 1 FROM complaint_attempts a WHERE a.complaint_case_id = c.id)
        )
    `).run(operationAt, id, claimToken, operationAt).changes === 1).immediate();
  }

  #assertActiveAiRetryClaim(id: string, claimToken: string, operationAt: string): PersistedReplyDraft {
    const row = this.database.prepare(`
      SELECT *
      FROM reply_drafts
      WHERE id = ?
        AND ai_retry_claim_token = ?
        AND ai_retry_claim_expires_at IS NOT NULL
        AND ai_retry_claim_expires_at > ?
        AND consecutive_ai_failure_rounds < 3
        ${AI_RETRY_ACTIVE_CLAIM_ACTION_GUARD_SQL}
      LIMIT 1
    `).get(id, claimToken, operationAt) as ReplyDraftRow | undefined;
    if (!row) {
      throw new ReviewActionConflictError(
        "ACTION_VERSION_CONFLICT",
        "AI retry claim is no longer active",
      );
    }
    return asReplyDraft(row);
  }

  /** Diagnostic visibility only. Execution must use claimDueAiRetries for an atomic lease. */
  listDueAiRetriesForDiagnostics(at = new Date(), limit = 100): PersistedReplyDraft[] {
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Error("AI 重试查询时间无效");
    const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    return (this.database.prepare(`
      SELECT *
      FROM reply_drafts
      WHERE state = 'retry_wait'
        AND failed_stage IS NOT NULL
        AND ai_retry_error_kind IS NOT NULL
        AND next_retry_at IS NOT NULL
        AND next_retry_at <= ?
        AND (
          (failed_stage = 'classification' AND ai_checkpoint_stage IS NULL)
          OR
          (failed_stage = 'rewrite'
            AND ai_checkpoint_stage = 'template_selected'
            AND library IS NOT NULL
            AND length(trim(category)) > 0
            AND template_version_id IS NOT NULL
            AND template_sequence IS NOT NULL
            AND template_sequence > 0
            AND length(trim(original_template)) > 0
            AND EXISTS (
              SELECT 1
              FROM template_versions v
              JOIN template_categories c ON c.version_id = v.id
              JOIN template_replies r ON r.category_id = c.id
              WHERE v.id = reply_drafts.template_version_id
                AND v.library = reply_drafts.library
                AND c.category = reply_drafts.category
                AND r.sequence = reply_drafts.template_sequence
                AND r.text = reply_drafts.original_template
            ))
        )
        AND NOT EXISTS (
          SELECT 1 FROM reply_attempts
          WHERE reply_attempts.source_key = reply_drafts.source_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM review_action_locks
          WHERE review_action_locks.source_key = reply_drafts.source_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM review_action_tombstones
          WHERE review_action_tombstones.source_key = reply_drafts.source_key
        )
      ORDER BY next_retry_at, discovered_at
      LIMIT ?
    `).all(at.toISOString(), safeLimit) as ReplyDraftRow[]).map(asReplyDraft);
  }

  saveClassification(id: string, input: {
    library: TemplateLibrary;
    primaryCategory: string;
    category: string;
    confidence: number;
    reason: string;
    needsAttention: boolean;
  }): void {
    const reasons = input.needsAttention ? ["AI 建议人工检查分类"] : [];
    this.database.prepare(`
      UPDATE reply_drafts SET library = ?, primary_category = ?, category = ?,
        classification_confidence = ?, classification_reason = ?, attention_reasons_json = ?,
        state = 'classifying', error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(input.library, input.primaryCategory, input.category, input.confidence, input.reason, JSON.stringify(reasons), new Date().toISOString(), id);
  }

  saveTemplate(id: string, input: { versionId: number; sequence: number; text: string }): void {
    this.database.prepare(`
      UPDATE reply_drafts SET template_version_id = ?, template_sequence = ?, original_template = ?,
        state = 'template_selected', updated_at = ? WHERE id = ?
    `).run(input.versionId, input.sequence, input.text, new Date().toISOString(), id);
  }

  markRewriting(id: string, options: { expectedClaimToken?: string; at?: Date } = {}): void {
    const claimToken = normalizeAiRetryClaimToken(options.expectedClaimToken);
    const operationAt = normalizeAiRetryOperationAt(options.at);
    const result = this.database.prepare(`
      UPDATE reply_drafts SET state = 'rewriting', updated_at = ?
      WHERE id = ?
        AND state IN ('template_selected', 'retry_wait')
        AND consecutive_ai_failure_rounds < 3
        AND (
          (state != 'retry_wait' AND (
            (ai_retry_claim_token IS NULL AND ? IS NULL)
            OR (ai_retry_claim_token = ? AND ai_retry_claim_expires_at > ?)
          ))
          OR
          (ai_retry_claim_token IS NOT NULL AND ai_retry_claim_token = ?
            AND ai_retry_claim_expires_at > ?)
        )
        ${AI_RETRY_NO_ACTION_CONFLICT_SQL}
    `).run(operationAt, id, claimToken, claimToken, operationAt, claimToken, operationAt);
    if (result.changes !== 1) {
      throw new ReviewActionConflictError("ACTION_VERSION_CONFLICT", "AI 重试任务领取状态已变更");
    }
  }

  complete(id: string, input: {
    finalReply: string;
    productAdjusted: boolean;
    needsAttention: boolean;
    notes: string;
    attentionReasons: string[];
    detectedTemplateProducts?: string[];
    unsupportedClaims?: string[];
    expectedClaimToken?: string;
    at?: Date;
  }): void {
    const claimToken = normalizeAiRetryClaimToken(input.expectedClaimToken);
    const operationAt = normalizeAiRetryOperationAt(input.at);
    this.database.transaction(() => {
    const current = this.get(id);
    if (!current) throw new Error("回复草稿不存在");
    const attentionReasons = [...new Set([...current.attentionReasons, ...input.attentionReasons])];
    const state = input.needsAttention || attentionReasons.length > 0 ? "needs_attention" : "read_only_ready";
    const now = operationAt;
    const result = this.database.prepare(`
      UPDATE reply_drafts SET final_reply = ?, product_adjusted = ?, rewrite_notes = ?,
        attention_reasons_json = ?, detected_template_products_json = ?, unsupported_claims_json = ?,
        failed_stage = NULL, ai_retry_error_kind = NULL, next_retry_at = NULL,
        consecutive_ai_failure_rounds = 0,
        ai_retry_claim_token = NULL, ai_retry_claim_expires_at = NULL,
        state = ?, processed_at = ?, updated_at = ?
      WHERE id = ?
        AND (
          (state != 'retry_wait' AND (
            (ai_retry_claim_token IS NULL AND ? IS NULL)
            OR (ai_retry_claim_token = ? AND ai_retry_claim_expires_at > ?)
          ))
          OR
          (ai_retry_claim_token IS NOT NULL AND ai_retry_claim_token = ?
            AND ai_retry_claim_expires_at > ?)
        )
        ${AI_RETRY_NO_ACTION_CONFLICT_SQL}
    `).run(input.finalReply, input.productAdjusted ? 1 : 0, input.notes, JSON.stringify(attentionReasons),
      JSON.stringify(input.detectedTemplateProducts ?? []), JSON.stringify(input.unsupportedClaims ?? []),
      state, now, now, id, claimToken, claimToken, operationAt, claimToken, operationAt);
    if (result.changes !== 1) {
      throw new ReviewActionConflictError("ACTION_VERSION_CONFLICT", "AI 重试任务领取状态已变更");
    }
    }).immediate();
  }

  fail(
    id: string,
    code: string,
    message: string,
    options: { expectedClaimToken?: string; at?: Date } = {},
  ): boolean {
    const claimToken = normalizeAiRetryClaimToken(options.expectedClaimToken);
    const operationAt = normalizeAiRetryOperationAt(options.at);
    return this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE reply_drafts
        SET state = 'failed', error_code = ?, error_message = ?, processed_at = ?, updated_at = ?,
            ai_retry_claim_token = NULL, ai_retry_claim_expires_at = NULL
        WHERE id = ?
          AND consecutive_ai_failure_rounds < 3
          AND (
            (state NOT IN (
                'retry_wait', 'manual_product_hold', 'manual_hold_expired', 'not_actionable',
                'sent', 'submitting', 'submission_uncertain'
              )
              AND (
                (ai_retry_claim_token IS NULL AND ? IS NULL)
                OR (ai_retry_claim_token = ? AND ai_retry_claim_expires_at > ?)
              ))
            OR
            (state IN ('retry_wait', 'classifying', 'template_selected', 'rewriting')
              AND ai_retry_claim_token IS NOT NULL AND ai_retry_claim_token = ?
              AND ai_retry_claim_expires_at > ?)
          )
          ${AI_RETRY_NO_ACTION_CONFLICT_SQL}
      `).run(
        code,
        message.slice(0, 800),
        operationAt,
        operationAt,
        id,
        claimToken,
        claimToken,
        operationAt,
        claimToken,
        operationAt,
      );
      if (result.changes === 1) return true;
      const current = this.database.prepare(`
        SELECT ai_retry_claim_token FROM reply_drafts WHERE id = ?
      `).get(id) as { ai_retry_claim_token: string | null } | undefined;
      if (claimToken !== null || current?.ai_retry_claim_token) {
        throw new ReviewActionConflictError("ACTION_VERSION_CONFLICT", "AI 重试任务领取状态已变更");
      }
      return false;
    }).immediate();
  }

  resetForReprocess(id: string): boolean {
    const result = this.database.prepare(`
      UPDATE reply_drafts SET library = NULL, primary_category = NULL, category = NULL,
        classification_confidence = NULL, classification_reason = NULL, template_version_id = NULL,
        template_sequence = NULL, original_template = NULL, final_reply = NULL, product_adjusted = 0,
        rewrite_notes = NULL, attention_reasons_json = '[]', state = 'discovered', error_code = NULL,
        detected_template_products_json = '[]', unsupported_claims_json = '[]',
        ai_checkpoint_stage = NULL, failed_stage = NULL, ai_retry_error_kind = NULL,
        next_retry_at = NULL,
        ai_retry_claim_token = NULL, ai_retry_claim_expires_at = NULL,
        error_message = NULL, processed_at = NULL, updated_at = ?
      WHERE id = ?
        AND state NOT IN (
          'retry_wait', 'manual_product_hold', 'not_actionable',
          'sent', 'submitting', 'submission_uncertain'
        )
        AND consecutive_ai_failure_rounds < 3
        AND ai_retry_claim_token IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM review_action_locks
          WHERE review_action_locks.source_key = reply_drafts.source_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM review_action_tombstones
          WHERE review_action_tombstones.source_key = reply_drafts.source_key
        )
    `).run(new Date().toISOString(), id);
    return result.changes === 1;
  }

  /**
   * Reconciles a locally terminal-looking draft with an explicit live reply
   * action. Display-only imports and failures that never crossed the submit
   * boundary may be reopened; locks, tombstones, sent attempts and uncertain
   * submission boundaries remain protected.
   */
  reopenObservedLiveAction(id: string): boolean {
    return this.database.transaction(() => {
      const current = this.get(id);
      if (!current) return false;
      const stalePlatformMarker = current.state === "not_actionable"
        && [
          "TMALL_COMPLAINT_ALREADY_RECORDED",
          "TMALL_PLATFORM_COMPLAINT_HANDLED",
          "TMALL_REPLY_ALREADY_RECORDED",
          "TMALL_REVIEW_NOT_REPLYABLE",
        ].includes(current.errorCode ?? "");
      const importedSent = current.state === "sent";
      const failedBeforeSubmit = current.state === "failed";
      if (!stalePlatformMarker && !importedSent && !failedBeforeSubmit) return false;
      const protectedAction = this.database.prepare(`
        SELECT 1
        FROM review_action_locks
        WHERE store_id = 'primary' AND source_key = ?
        UNION ALL
        SELECT 1
        FROM review_action_tombstones
        WHERE store_id = 'primary' AND source_key = ?
        UNION ALL
        SELECT 1
        FROM reply_attempts
        WHERE source_key = ?
          AND (
            ? != 'failed'
            OR state != 'failed'
            OR (
              submitted_at IS NOT NULL
              AND COALESCE(error_code, '') != 'MANUALLY_CONFIRMED_NOT_SENT'
            )
          )
        LIMIT 1
      `).get(current.sourceKey, current.sourceKey, current.sourceKey, current.state);
      if (protectedAction) return false;
      if (failedBeforeSubmit) {
        this.database.prepare(`
          DELETE FROM reply_attempts
          WHERE reply_draft_id = ? AND source_key = ? AND state = 'failed'
            AND (
              submitted_at IS NULL
              OR error_code = 'MANUALLY_CONFIRMED_NOT_SENT'
            )
        `).run(current.id, current.sourceKey);
      }
      const now = new Date().toISOString();
      const changed = this.database.prepare(`
        UPDATE reply_drafts
        SET library = NULL, primary_category = NULL, category = NULL,
            classification_confidence = NULL, classification_reason = NULL,
            template_version_id = NULL, template_sequence = NULL,
            original_template = NULL, final_reply = NULL, product_adjusted = 0,
            rewrite_notes = NULL, attention_reasons_json = '[]',
            detected_template_products_json = '[]', unsupported_claims_json = '[]',
            state = 'discovered', error_code = NULL, error_message = NULL,
            ai_checkpoint_stage = NULL, failed_stage = NULL,
            ai_retry_error_kind = NULL, next_retry_at = NULL,
            ai_retry_claim_token = NULL, ai_retry_claim_expires_at = NULL,
            consecutive_ai_failure_rounds = 0, processed_at = NULL, updated_at = ?
        WHERE id = ? AND state = ?
      `).run(now, id, current.state);
      return changed.changes === 1;
    }).immediate();
  }

  get(id: string): PersistedReplyDraft | null {
    const row = this.database.prepare("SELECT * FROM reply_drafts WHERE id = ?").get(id) as ReplyDraftRow | undefined;
    return row ? asReplyDraft(row) : null;
  }

  getBySourceKey(sourceKey: string): PersistedReplyDraft | null {
    const row = this.database.prepare("SELECT * FROM reply_drafts WHERE source_key = ?").get(sourceKey) as ReplyDraftRow | undefined;
    return row ? asReplyDraft(row) : null;
  }

  list(limit = 200): PersistedReplyDraft[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    return (this.database.prepare("SELECT * FROM reply_drafts ORDER BY discovered_at DESC LIMIT ?").all(safeLimit) as ReplyDraftRow[]).map(asReplyDraft);
  }

  listPage(input: { page: number; pageSize: number; filter: ReplyListFilter; query: string }): ReplyListPage {
    const requestedPage = Math.max(1, Math.trunc(input.page));
    const pageSize = Math.max(1, Math.min(100, Math.trunc(input.pageSize)));
    const query = input.query.trim().slice(0, 200);
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];

    switch (input.filter) {
      case "sent":
        clauses.push("state = 'sent'");
        break;
      case "unsent":
        clauses.push("state <> 'sent'");
        break;
      case "good":
        clauses.push("library = 'good'");
        break;
      case "bad":
        clauses.push("library = 'bad'");
        break;
      case "attention":
        clauses.push("state = 'needs_attention'");
        break;
      case "all":
        break;
    }
    if (query) {
      clauses.push(`instr(lower(
        review_text || ' ' || product_title || ' ' ||
        COALESCE(primary_category, '') || ' ' || COALESCE(category, '') || ' ' ||
        COALESCE(final_reply, '')
      ), lower(?)) > 0`);
      parameters.push(query);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = (this.database.prepare(`SELECT COUNT(*) AS value FROM reply_drafts ${where}`)
      .get(...parameters) as { value: number }).value;
    const overallTotal = (this.database.prepare("SELECT COUNT(*) AS value FROM reply_drafts").get() as { value: number }).value;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = this.database.prepare(`
      SELECT * FROM reply_drafts
      ${where}
      ORDER BY discovered_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, pageSize, (page - 1) * pageSize) as ReplyDraftRow[];

    return {
      items: rows.map(asReplyDraft),
      total,
      overallTotal,
      page,
      pageSize,
      totalPages,
    };
  }

  countByStates(states: readonly string[]): number {
    const uniqueStates = [...new Set(states.filter((state) => state.length > 0))];
    if (uniqueStates.length === 0) return 0;
    const placeholders = uniqueStates.map(() => "?").join(", ");
    const row = this.database.prepare(`SELECT COUNT(*) AS value FROM reply_drafts WHERE state IN (${placeholders})`)
      .get(...uniqueStates) as { value: number };
    return row.value;
  }

  manualDiversionCount(): number {
    return this.countByStates(["manual_product_hold", "manual_hold_expired", "not_actionable"]);
  }

  pruneOlderThan(retentionDays: number, now = new Date()): number {
    if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error("评论保留天数必须大于 0");
    const cutoff = new Date(now.getTime() - Math.trunc(retentionDays) * 24 * 60 * 60 * 1000).toISOString();
    return this.database.transaction(() => this.database.prepare(`
      DELETE FROM reply_drafts WHERE discovered_at < ?
        AND state NOT IN (
          'discovered', 'classifying', 'template_selected', 'rewriting',
          'retry_wait', 'manual_product_hold', 'submitting', 'submission_uncertain'
        )
        AND NOT EXISTS (
          SELECT 1 FROM review_action_locks
          WHERE review_action_locks.source_key = reply_drafts.source_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM reply_attempts
          WHERE reply_attempts.source_key = reply_drafts.source_key
            AND reply_attempts.state IN ('pending', 'submitting', 'submission_uncertain')
        )
    `).run(cutoff).changes).immediate();
  }
}
