import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import {
  evaluateAutomationSchedule,
  FIXED_TEMPLATE_SCHEMAS,
  formatReviewScopeSummary,
  RETENTION_POLICIES,
  resolveReviewScope,
  validateAutomationPlan,
  validateReviewScopeInput,
  type AutomationState,
  type AutomationTrigger,
  type ResolvedReviewScope,
  type TemplateLibrary,
} from "@tmall/domain";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { DraftProcessor } from "./drafts/processor";
import { TmallBrowserLaunchError } from "./tmall/browser-runtime";
import { DeepSeekClient, type DeepSeekClientApi } from "./deepseek/client";
import { FeishuClient, type FeishuClientApi } from "./feishu/client";
import { TemplateSyncService } from "./feishu/template-sync";
import { parseFeishuBaseUrl } from "./feishu/url";
import { ConfirmationNonceService, type SecretConfirmationAction } from "./security/confirmation-nonce";
import { InMemorySecretStore, type SecretStore } from "./security/credential-store";
import { createInitialState } from "./state";
import { drainPendingReviewQueue } from "./automation/queue-drainer";
import { openDatabase, runMigrations, type AppDatabase } from "./storage/database";
import { AutomationPlanRevisionConflictError, AutomationRepository, LocatorRepository, ReplyAttemptRepository, ReplyRepository, SettingsRepository, TemplateRepository, type ReplyListFilter } from "./storage/repositories";
import { ReviewScopeRepository, RevisionConflictError } from "./storage/review-scope-repository";
import { ManualCatalogRevisionConflictError, ManualProductConflictError, ManualProductRepository } from "./storage/manual-product-repository";
import { ImportPreviewStore, ImportPreviewSupersededError, type ImportPreviewStoreOptions } from "./manual-products/import-preview-store";
import { ManualProductImportError, ManualProductImportService, type ManualProductImportPreviewPayload, type ManualProductImportServiceOptions } from "./manual-products/import-service";
import { ManualProductPolicyService } from "./manual-products/policy-service";
import {
  LocalXlsxPickerUnavailableError,
  WindowsLocalXlsxPicker,
  type LocalXlsxPicker,
} from "./manual-products/local-xlsx-picker";
import { MAX_UPLOAD_BYTES, XlsxValidationError } from "./manual-products/xlsx-parser";
import { SubmissionService } from "./submission/service";
import { ReviewActionConflictError, ReviewActionGate } from "./submission/review-action-gate";
import { createTmallOperationActivity, TmallBrowserOperationTimeoutError, TmallDriverOperationError, type TmallAuthDriver, type TmallAuthResult, type TmallCredentials, UnavailableTmallAuthDriver, withTmallOperationDeadline } from "./tmall/auth-driver";
import {
  assertReviewSnapshotsWithinScope,
  ReviewFilterStateError,
  type ReviewFilterMode,
  type ReviewScanPhase,
} from "./tmall/review-filter";
import { TmallReviewPageStateError } from "./tmall/review-reader";
import { LocatorRepairService, sanitizeSemanticSnapshot } from "./locators/repair-service";
import { ComplaintRepository, type ComplaintCaseRecord } from "./storage/complaint-repository";
import {
  OperatorRecordCleanup,
  OperatorRecordCleanupConflictError,
  OperatorRecordCleanupNotFoundError,
} from "./storage/operator-record-cleanup";
import {
  ComplaintReviewService,
  createAdjudicatedComplaintEligibilityVerifier,
  UnavailableComplaintReviewPolicy,
  type ComplaintReviewPolicy,
} from "./complaints/complaint-review-service";
import { UiSessionManager } from "./ui-session-manager";

export interface AppOptions {
  host: string;
  origin: string;
  sessionToken: string;
  csrfToken: string;
  database?: AppDatabase;
  secretStore?: SecretStore;
  feishuClientFactory?: (credentials: { appId: string; appSecret: string }) => FeishuClientApi;
  deepseekClientFactory?: (credentials: { apiKey: string; baseUrl: string }) => DeepSeekClientApi;
  tmallAuthDriver?: TmallAuthDriver;
  runtimeReadinessCheck?: () => Promise<string[]>;
  interItemDelay?: () => Promise<void>;
  now?: () => Date;
  importPreviewStoreOptions?: Omit<ImportPreviewStoreOptions, "now">;
  localXlsxPicker?: LocalXlsxPicker;
  manualProductWorkbookParser?: ManualProductImportServiceOptions["parseWorkbook"];
  /**
   * Allows the browser integration to supply the strictly scoped complaint
   * verifier/executor. The default only performs analysis and never clicks a
   * complaint submit control.
   */
  complaintReviewPolicyFactory?: (input: {
    complaints: ComplaintRepository;
    ai: DeepSeekClientApi;
    complaintAutoSubmit: boolean;
  }) => ComplaintReviewPolicy;
  /** Testable hard deadline for one browser interaction chain. */
  tmallBrowserOperationDeadlineMs?: number;
  /** Optional foreground-console lease manager for session-bound desktop launches. */
  uiSessionManager?: UiSessionManager;
}

const SESSION_COOKIE = "tmall_console_session";
const FEISHU_SECRET_KEY = "feishu_app_secret";
const DEEPSEEK_SECRET_KEY = "deepseek_api_key";
const TMALL_CREDENTIAL_KEY = "taobao_seller";
/**
 * A known platform notice can close the current page after being acknowledged.
 * Recreating the browser context and returning to the review list needs more
 * than the old one-minute ceiling, especially on a cold session.
 */
export const DEFAULT_TMALL_BROWSER_OPERATION_DEADLINE_MS = 180_000;
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
type PublicReviewScope = Pick<ResolvedReviewScope, "preset" | "startDate" | "endDate" | "timezone"> & {
  summary: string;
  processingMode: ReviewFilterMode;
};
type PublicAutomationStatus = {
  state: AutomationState;
  trigger: AutomationTrigger | null;
  currentWindow: { id: string; start: string; end: string } | null;
  nextRunAt: string | null;
  currentStep: string;
  startedAt: string | null;
  processed: number;
  succeeded: number;
  manual: number;
  failed: number;
  reviewScope: PublicReviewScope | null;
  currentReview: { review: string; product: string } | null;
  currentReply: string | null;
  plan: {
    enabled: boolean;
    paused: boolean;
    timezone: string;
    intervalMinutes: number;
    windows: Array<{ id: string; start: string; end: string }>;
    revision: number;
  };
  lastRun: {
    trigger: AutomationTrigger;
    state: string;
    processed: number;
    succeeded: number;
    manual: number;
    failed: number;
    stopReason: string | null;
    startedAt: string;
    finishedAt: string | null;
    scope: PublicReviewScope | null;
  } | null;
};
const AUTOMATION_PLAN_VALIDATION_MESSAGES = new Set([
  "运行间隔必须在1到120分钟之间",
  "时间必须使用HH:mm格式",
  "时间段标识无效",
  "结束时间必须晚于开始时间，不支持跨天时间段",
  "时间段标识不能重复",
  "时间段不能重叠",
]);
const PRODUCT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REVIEW_FILTER_MODES = new Set<ReviewFilterMode>([
  "followup_only",
  "content_unanswered",
]);

class ManualProductNotFoundError extends Error {}

function isMutation(request: FastifyRequest): boolean {
  return !["GET", "HEAD"].includes(request.method);
}

function asLibrary(value: string): TemplateLibrary | null {
  return value === "good" || value === "bad" ? value : null;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "操作失败";
  return message.replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [REDACTED]").slice(0, 800);
}

function parseReviewFilterMode(value: unknown): ReviewFilterMode | null {
  if (typeof value !== "string" || !REVIEW_FILTER_MODES.has(value as ReviewFilterMode)) return null;
  return value as ReviewFilterMode;
}

function automationRunRetryMessage(error: unknown): string {
  if (error instanceof TmallBrowserLaunchError) return `${error.message}；已安排下一次自动重试`;
  if (error instanceof TmallBrowserOperationTimeoutError) return "淘宝页面打开超时，已安排下一次自动重试";
  return "淘宝页面暂时未准备好，已安排下一次自动重试";
}

function automationRunFailureMessage(currentStep: string): string {
  const stage = currentStep.includes("检查新评价")
    ? "正在检查新评价"
    : currentStep.includes("发送回复")
      ? "正在发送回复"
      : currentStep.includes("登录")
        ? "正在检查淘宝登录"
        : currentStep.includes("处理")
          ? "正在处理当前评价"
          : "执行当前步骤";
  return `在“${stage}”时发生临时错误，本轮已安全停止；可再次点击“立即处理一轮”重试`;
}

function automationPlanValidationMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return AUTOMATION_PLAN_VALIDATION_MESSAGES.has(message) ? message : "自动计划设置无效，请检查后重试";
}

function parseWarnings(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function maskAccount(account: string): string {
  const value = account.trim();
  if (value.length <= 4) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function parseTmallCredentials(value: string | null): TmallCredentials | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TmallCredentials>;
    return typeof parsed.account === "string" && typeof parsed.password === "string"
      ? { account: parsed.account, password: parsed.password }
      : null;
  } catch {
    return null;
  }
}

class TmallCredentialReadError extends Error {
  constructor(readonly originalError: unknown) {
    super("读取已保存的淘宝登录信息失败");
    this.name = "TmallCredentialReadError";
  }
}

export function buildApp(options: AppOptions): FastifyInstance {
  const tmallBrowserOperationDeadlineMs = options.tmallBrowserOperationDeadlineMs ?? DEFAULT_TMALL_BROWSER_OPERATION_DEADLINE_MS;
  const app = Fastify({ logger: false });
  const state = createInitialState();
  const clockSource = options.now ?? (() => new Date());
  const clockNow = (): Date => new Date(clockSource().getTime());
  const clockNowMs = (): number => clockNow().getTime();
  const uiSessionManager = options.uiSessionManager;
  const hasActiveUiSession = () => !uiSessionManager || uiSessionManager.activeCount() > 0;
  const database = options.database ?? openDatabase(":memory:");
  runMigrations(database);
  const settingsRepository = new SettingsRepository(database);
  // Older builds counted every unresolved login page as a password failure.
  // Those records contain no explicit credential-rejection evidence and must
  // never lock a user out of a new, user-initiated login action.
  settingsRepository.set("tmall_login_failure_times", []);
  settingsRepository.set("tmall_credential_rejection_times_v2", []);
  const templateRepository = new TemplateRepository(database);
  const replyRepository = new ReplyRepository(database);
  const replyAttemptRepository = new ReplyAttemptRepository(database);
  const complaintRepository = new ComplaintRepository(database);
  const operatorRecordCleanup = new OperatorRecordCleanup(database);
  const automationRepository = new AutomationRepository(database);
  const reviewScopeRepository = new ReviewScopeRepository(database);
  const manualProductRepository = new ManualProductRepository(database);
  const audit = (eventType: string, target: string, result: string, errorCode?: string): void => {
    templateRepository.audit(eventType, target, result, errorCode, clockNow());
  };
  const interruptedSubmissionRecovery = replyAttemptRepository.recoverInterrupted(clockNow());
  const interruptedComplaintRecovery = complaintRepository.recoverInterruptedAttempts();
  const interruptedAiRetryClaims = replyRepository.recoverInterruptedAiRetryClaims(clockNow());
  const interruptedRunCount = automationRepository.recoverInterruptedRuns(clockNow());
  if (interruptedSubmissionRecovery.releasedPending > 0) {
    audit("submission_recovered_before_click", "reply_attempts", "success");
  }
  if (interruptedSubmissionRecovery.markedUncertain > 0) {
    audit("submission_interrupted_requires_reconciliation", "reply_attempts", "attention", "SUBMISSION_INTERRUPTED");
  }
  if (interruptedRunCount > 0) {
    audit("automation_run_recovered_after_restart", "automation_runs", "attention", "APPLICATION_RESTARTED");
  }
  if (interruptedAiRetryClaims > 0) {
    audit("ai_retry_claim_recovered_after_restart", "reply_drafts", "success", "AI_RETRY_CLAIM_RECOVERED");
  }
  if (interruptedComplaintRecovery > 0) {
    audit("complaint_submission_interrupted_requires_reconciliation", "complaint_attempts", "attention", "COMPLAINT_SUBMISSION_INTERRUPTED");
  }
  const importPreviewStore = new ImportPreviewStore<ManualProductImportPreviewPayload>({
    ...options.importPreviewStoreOptions,
    now: clockNowMs,
  });
  const manualProductImportService = new ManualProductImportService({
    repository: manualProductRepository,
    previewStore: importPreviewStore,
    ...(options.manualProductWorkbookParser ? { parseWorkbook: options.manualProductWorkbookParser } : {}),
    now: clockNow,
  });
  const localXlsxPicker = options.localXlsxPicker ?? new WindowsLocalXlsxPicker();
  state.services = { importPreviewStore, manualProductImportService };
  const locatorRepository = new LocatorRepository(database);
  locatorRepository.ensureDefaults();
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function runLifecycleCleanup(at = clockNow()): void {
    const actionGate = new ReviewActionGate(database);
    const complaintCleanup = complaintRepository.pruneOlderThan(
      RETENTION_POLICIES.complaints.retentionDays ?? 90,
      at,
      RETENTION_POLICIES.complaint_audit.retentionDays ?? 180,
    );
    const pruned = {
      complaintCases: complaintCleanup.cases,
      complaintAttempts: complaintCleanup.attempts,
      attempts: replyAttemptRepository.pruneOlderThan(RETENTION_POLICIES.audit.retentionDays ?? 180, at),
      manualHolds: replyRepository.compactExpiredManualHolds(RETENTION_POLICIES.manual_holds.retentionDays ?? 90, at),
      drafts: replyRepository.pruneOlderThan(RETENTION_POLICIES.reviews.retentionDays ?? 90, at),
      actionTombstones: actionGate.pruneTombstonesOlderThan(RETENTION_POLICIES.action_tombstones.retentionDays ?? 180, at),
      repairs: locatorRepository.pruneRepairs(RETENTION_POLICIES.locator_history.retentionDays ?? 30, at),
      snapshots: locatorRepository.pruneSnapshots(RETENTION_POLICIES.redacted_snapshots.retentionDays ?? 7, at),
      runs: automationRepository.pruneRuns(RETENTION_POLICIES.audit.retentionDays ?? 180, at),
      audit: templateRepository.pruneAudit(RETENTION_POLICIES.audit.retentionDays ?? 180, at),
    };
    settingsRepository.set("last_cleanup_at", at.toISOString());
    settingsRepository.set("next_cleanup_at", new Date(at.getTime() + 86_400_000).toISOString());
    if (Object.values(pruned).some((count) => count > 0)) audit("automatic_cleanup", "expired_records", "success");
  }

  runLifecycleCleanup();
  cleanupTimer = setInterval(() => runLifecycleCleanup(), 86_400_000);
  cleanupTimer.unref?.();
  const secretStore = options.secretStore ?? new InMemorySecretStore();
  const readTmallCredentials = async (): Promise<TmallCredentials | null> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return parseTmallCredentials(await secretStore.read(TMALL_CREDENTIAL_KEY));
      } catch (error) {
        lastError = error;
      }
    }
    throw new TmallCredentialReadError(lastError);
  };
  const nonceService = new ConfirmationNonceService({ now: clockNowMs });
  const createFeishuClient =
    options.feishuClientFactory ??
    ((credentials: { appId: string; appSecret: string }) => new FeishuClient(credentials));
  const createDeepSeekClient = options.deepseekClientFactory ??
    ((credentials: { apiKey: string; baseUrl: string }) => new DeepSeekClient(credentials));
  const tmallAuthDriver: TmallAuthDriver = options.tmallAuthDriver ?? new UnavailableTmallAuthDriver();
  tmallAuthDriver.setLocatorProvider?.((operationKey) => locatorRepository.get(operationKey));
  let cachedClient: { key: string; client: FeishuClientApi } | null = null;
  let cachedDeepSeekClient: { key: string; client: DeepSeekClientApi } | null = null;
  let automationTimer: ReturnType<typeof setTimeout> | null = null;
  let automationPromise: Promise<void> | null = null;
  let tmallAuthenticationInFlight = false;
  let tmallBrowserOperationInFlight = false;
  let automationWindowEnd: Date | null = null;
  let submissionInFlight = false;
  let pausedTrigger: AutomationTrigger | null = null;
  let manualActionTrigger: AutomationTrigger | null = null;
  let automationControlEpoch = 0;
  let automationClosing = false;
  let automationStatus: {
    state: AutomationState;
    trigger: AutomationTrigger | null;
    currentWindow: { id: string; start: string; end: string } | null;
    nextRunAt: string | null;
    currentStep: string;
    startedAt: string | null;
    runId: string | null;
    processed: number;
    succeeded: number;
    manual: number;
    failed: number;
    reviewScope: PublicReviewScope | null;
    currentReview: { sourceKey: string; review: string; product: string } | null;
    currentReply: string | null;
  } = {
    state: "disabled",
    trigger: null,
    currentWindow: null,
    nextRunAt: null,
    currentStep: "自动计划未启用",
    startedAt: null,
    runId: null,
    processed: 0,
    succeeded: 0,
    manual: 0,
    failed: 0,
    reviewScope: null,
    currentReview: null,
    currentReply: null,
  };

  function templateHealthView(library: TemplateLibrary) {
    const row = templateRepository.getSource(library);
    const health = templateRepository.getHealth(library);
    const latestSyncStatus = health.state === "ready" ? "ready" : health.state === "usable_with_warning" ? "failed" : "not_synced";
    const message = health.state === "ready"
      ? "当前话术版本可正常使用"
      : health.state === "usable_with_warning"
        ? "最近一次同步未完成，当前仍使用已验证的话术版本"
        : "尚未同步可用的话术版本，请检查链接后重新同步";
    return {
      library,
      state: health.state,
      usable: health.usable,
      activeVersion: health.usable ? health.activeVersionId : null,
      latestSyncStatus,
      latestSyncAt: row?.last_synced_at ? String(row.last_synced_at) : null,
      categoryCount: Number(row?.category_count ?? 0),
      replyCount: Number(row?.reply_count ?? 0),
      warning: health.state === "usable_with_warning" ? message : null,
      message,
    };
  }

  function sourceView(library: TemplateLibrary) {
    const row = templateRepository.getSource(library);
    const schema = FIXED_TEMPLATE_SCHEMAS[library];
    return {
      library,
      label: library === "good" ? "好评回复规则库" : "差评回复规则库",
      url: String(row?.url ?? ""),
      schema: {
        fields:
          library === "good"
            ? ["关键词分类", "包含关键词", "回复话术 1…N"]
            : ["一级分类", "二级分类", "包含关键词", "回复话术 1…N"],
        replyFieldPattern: schema.replyFieldPattern,
        fallbackCategory: schema.fallbackCategory,
        primaryCategoryRule:
          library === "bad" ? "一级分类空白时沿用上一行；通用差评类的一级、二级分类必须同名" : null,
      },
      status: String(row?.status ?? "not_configured"),
      activeVersion: row?.active_version_id === null || row?.active_version_id === undefined
        ? null
        : Number(row.active_version_id),
      contentHash: row?.content_hash ? String(row.content_hash).slice(0, 12) : null,
      categoryCount: Number(row?.category_count ?? 0),
      replyCount: Number(row?.reply_count ?? 0),
      lastTestedAt: row?.last_tested_at ? String(row.last_tested_at) : null,
      lastSyncedAt: row?.last_synced_at ? String(row.last_synced_at) : null,
      warnings: parseWarnings(row?.warnings_json),
      health: templateHealthView(library),
    };
  }

  async function getFeishuClient(): Promise<FeishuClientApi> {
    const appId = settingsRepository.get<string>("feishu_app_id")?.trim() ?? "";
    const appSecret = await secretStore.read(FEISHU_SECRET_KEY);
    if (!appId || !appSecret) throw new Error("请先在系统设置中保存飞书 App ID 和 App Secret");
    const key = createHash("sha256").update(`${appId}\0${appSecret}`, "utf8").digest("hex");
    if (!cachedClient || cachedClient.key !== key) {
      cachedClient = { key, client: createFeishuClient({ appId, appSecret }) };
    }
    return cachedClient.client;
  }

  async function getDeepSeekClient(): Promise<DeepSeekClientApi> {
    const apiKey = await secretStore.read(DEEPSEEK_SECRET_KEY);
    if (!apiKey) throw new Error("请先保存 DeepSeek API Key");
    const baseUrl = settingsRepository.get<string>("deepseek_base_url") ?? DEEPSEEK_BASE_URL;
    const key = createHash("sha256").update(`${baseUrl}\0${apiKey}`, "utf8").digest("hex");
    if (!cachedDeepSeekClient || cachedDeepSeekClient.key !== key) {
      cachedDeepSeekClient = { key, client: createDeepSeekClient({ apiKey, baseUrl }) };
    }
    return cachedDeepSeekClient.client;
  }

  async function automationPreflight() {
    const sources = (["good", "bad"] as const).map(sourceView);
    let databaseReady = true;
    try {
      database.prepare("SELECT 1 AS ok").get();
    } catch {
      databaseReady = false;
    }
    const credentials = await readTmallCredentials();
    const deepseekSecret = await secretStore.read(DEEPSEEK_SECRET_KEY);
    const deepseekBaseUrl = settingsRepository.get<string>("deepseek_base_url") ?? DEEPSEEK_BASE_URL;
    const deepseekFingerprint = deepseekSecret ? createHash("sha256").update(`${deepseekBaseUrl}\0${deepseekSecret}`, "utf8").digest("hex") : "";
    const deepseekVerified = Boolean(deepseekSecret && deepseekFingerprint === (settingsRepository.get<string>("deepseek_verified_fingerprint") ?? ""));
    const checks = [
      { key: "tmall", label: "淘宝商家账号", ready: Boolean(credentials) },
      { key: "good_templates", label: "好评话术库", ready: sources.find((source) => source.library === "good")?.health.usable === true },
      { key: "bad_templates", label: "差评话术库", ready: sources.find((source) => source.library === "bad")?.health.usable === true },
      { key: "deepseek", label: "DeepSeek", ready: deepseekVerified },
      { key: "browser", label: "自动回复浏览器", ready: tmallAuthDriver.canSubmitReplies === true },
      {
        key: "uncertain_submissions",
        label: "等待平台自动核对的提交",
        ready: replyAttemptRepository.unresolvedCount() === 0,
        blocking: false,
      },
      { key: "ai_circuit", label: "AI 重试保护", ready: !replyRepository.hasOpenAiCircuit(), blocking: false },
      { key: "database", label: "本地数据", ready: databaseReady },
    ];
    const customMissing = options.runtimeReadinessCheck ? await options.runtimeReadinessCheck() : [];
    for (const label of customMissing) {
      const existing = checks.find((item) => item.label === label);
      if (existing) existing.ready = false;
      else checks.push({ key: `custom_${checks.length}`, label, ready: false });
    }
    return {
      ready: checks.every((item) => item.ready || item.blocking === false),
      checks,
      missing: checks.filter((item) => !item.ready && item.blocking !== false).map((item) => item.label),
    };
  }

  async function runtimeMissingRequirements(): Promise<string[]> {
    return (await automationPreflight()).missing;
  }

  async function attemptLocatorRepair(operationKey: string): Promise<"auto_applied" | "pending_approval" | "rejected" | "unavailable"> {
    const locator = locatorRepository.get(operationKey);
    if (!locator) return "unavailable";
    locatorRepository.markAttention(operationKey);
    if (!tmallAuthDriver.captureSemanticSnapshot || !tmallAuthDriver.probeLocatorCandidate) return "unavailable";
    try {
      const deepseek = await getDeepSeekClient();
      if (!deepseek.suggestLocatorRepair) return "unavailable";
      const service = new LocatorRepairService({
        repository: locatorRepository,
        ai: deepseek,
        probe: (input) => tmallAuthDriver.probeLocatorCandidate!(input),
      });
      const snapshot = await tmallAuthDriver.captureSemanticSnapshot();
      locatorRepository.saveSnapshot(operationKey, sanitizeSemanticSnapshot(snapshot));
      const repair = await service.repair(operationKey, snapshot);
      return repair.status === "auto_applied" ? "auto_applied" : repair.status === "pending_approval" ? "pending_approval" : "rejected";
    } catch {
      return "unavailable";
    }
  }

  async function verifyTmallLogin(
    credentials: TmallCredentials | null,
    mode: "open" | "continue" = "open",
    operationDeadlineAt = Date.now() + tmallBrowserOperationDeadlineMs,
  ): Promise<TmallAuthResult | {
    state: "identity_mismatch";
    page: "review_list" | "login";
    storeName?: string | null;
    message: string;
  }> {
    const runDriver = async (): Promise<TmallAuthResult> => {
      if (mode === "continue") {
        if (!tmallAuthDriver.continueReviewPage) {
          return { state: "navigation_failed", page: "login", message: "当前浏览器会话无法继续检测，请重新打开登录页" };
        }
        return tmallAuthDriver.continueReviewPage(credentials ?? undefined);
      }
      if (!credentials) return { state: "not_ready", page: "login", message: "请先保存淘宝商家登录信息" };
      return tmallAuthDriver.openReviewPage(credentials);
    };

    const runDriverWithDeadline = async (): Promise<TmallAuthResult> => {
      try {
        const remainingMs = operationDeadlineAt - Date.now();
        if (remainingMs <= 0) throw new TmallBrowserOperationTimeoutError();
        return await withTmallOperationDeadline(
          runDriver(),
          remainingMs,
          async () => undefined,
        );
      } catch (error) {
        if (error instanceof TmallBrowserOperationTimeoutError) {
          return { state: "navigation_failed", page: "review_list", message: "淘宝页面检测超时，本次检测已安全结束，请重新检测" };
        }
        throw error;
      }
    };

    let result = await runDriverWithDeadline();
    if ((result.state === "failed" || result.state === "navigation_failed") && result.failureOperationKey) {
      const repair = await attemptLocatorRepair(result.failureOperationKey);
      if (repair === "auto_applied") {
        result = await runDriverWithDeadline();
        if ((result.state === "failed" || result.state === "navigation_failed") && result.failureOperationKey) {
          locatorRepository.rollback(result.failureOperationKey);
          locatorRepository.markAttention(result.failureOperationKey);
        }
      }
    }
    if (result.state === "authenticated") {
      settingsRepository.set("tmall_login_failure_times", []);
      settingsRepository.set("tmall_credential_rejection_times_v2", []);
    }
    return result;
  }

  function clearPersistedTmallVerification(): void {
    settingsRepository.set("tmall_verified_credential_fingerprint", "");
    settingsRepository.set("tmall_verified_store_name", "");
    settingsRepository.set("tmall_verified_at", "");
    settingsRepository.set("tmall_element_verification_deferred", false);
  }

  function complaintReviewPolicyFor(ai: DeepSeekClientApi): ComplaintReviewPolicy {
    if (options.complaintReviewPolicyFactory) {
      return options.complaintReviewPolicyFactory({
        complaints: complaintRepository,
        ai,
        complaintAutoSubmit: settingsRepository.get<boolean>("complaint_auto_submit") === true,
      });
    }
    if (!ai.analyzeComplaint) return new UnavailableComplaintReviewPolicy();
    return new ComplaintReviewService({
      complaints: complaintRepository,
      model: { analyzeComplaint: (input) => ai.analyzeComplaint!(input) },
      // The default integration double-checks only facts that can be proven
      // from the review text itself. It never invents order/chat/image facts.
      verifier: createAdjudicatedComplaintEligibilityVerifier({ analyzeComplaint: (input) => ai.analyzeComplaint!(input) }, { invocations: complaintRepository }),
    });
  }

  function clearAutomationTimer(): void {
    if (automationTimer) clearTimeout(automationTimer);
    automationTimer = null;
  }

  function automationStatusView(): PublicAutomationStatus {
    const plan = automationRepository.getPlan();
    const lastRun = automationRepository.getLastRun();
    return {
      state: automationStatus.state,
      trigger: automationStatus.trigger,
      currentWindow: automationStatus.currentWindow,
      nextRunAt: automationStatus.nextRunAt,
      currentStep: automationStatus.currentStep,
      startedAt: automationStatus.startedAt,
      processed: automationStatus.processed,
      succeeded: automationStatus.succeeded,
      manual: automationStatus.manual,
      failed: automationStatus.failed,
      reviewScope: automationStatus.reviewScope,
      currentReview: automationStatus.currentReview ? {
        review: automationStatus.currentReview.review,
        product: automationStatus.currentReview.product,
      } : null,
      currentReply: automationStatus.currentReply,
      plan: {
        enabled: plan.enabled,
        paused: plan.paused,
        timezone: plan.timezone,
        intervalMinutes: plan.intervalMinutes,
        windows: plan.windows,
        revision: plan.revision,
      },
      lastRun: lastRun ? {
        trigger: lastRun.trigger,
        state: lastRun.state,
        processed: lastRun.processed,
        succeeded: lastRun.succeeded,
        manual: lastRun.manual,
        failed: lastRun.failed,
        stopReason: lastRun.stopReason,
        startedAt: lastRun.startedAt,
        finishedAt: lastRun.finishedAt,
        scope: lastRun.scope ? toPublicReviewScope(lastRun.scope) : null,
      } : null,
    };
  }

  function tryBeginTmallBrowserOperation(): (() => void) | null {
    if (tmallBrowserOperationInFlight) return null;
    tmallBrowserOperationInFlight = true;
    return () => {
      tmallBrowserOperationInFlight = false;
    };
  }

  function scheduleAutomationWake(at: Date): void {
    clearAutomationTimer();
    automationStatus.nextRunAt = at.toISOString();
    automationTimer = setTimeout(() => {
      automationTimer = null;
      if (clockNowMs() + 250 < at.getTime()) scheduleAutomationWake(at);
      else void rescheduleAutomation(true);
    }, Math.min(30_000, Math.max(0, at.getTime() - clockNowMs())));
    automationTimer.unref?.();
  }

  async function rescheduleAutomation(allowImmediate: boolean, expectedControlEpoch = automationControlEpoch): Promise<void> {
    const isCurrentControl = () => !automationClosing && automationControlEpoch === expectedControlEpoch;
    if (!isCurrentControl()) return;
    clearAutomationTimer();
    if (automationPromise) return;
    if (!hasActiveUiSession()) {
      automationStatus = {
        ...automationStatus,
        state: "waiting",
        trigger: null,
        currentWindow: null,
        nextRunAt: null,
        currentStep: "等待控制台页面打开后再运行自动回复",
        startedAt: null,
        runId: null,
      };
      return;
    }
    const plan = automationRepository.getPlan();
    if (!isCurrentControl()) return;
    if (plan.paused) {
      automationStatus = { ...automationStatus, state: "paused", trigger: null, nextRunAt: null, currentStep: "自动回复已暂停，需要手动继续" };
      return;
    }
    if (!plan.enabled) {
      automationStatus = { ...automationStatus, state: "disabled", trigger: null, currentWindow: null, nextRunAt: null, currentStep: "自动计划未启用", startedAt: null, runId: null };
      return;
    }
    const timing = evaluateAutomationSchedule(plan, clockNow());
    automationStatus.currentWindow = timing.currentWindow;
    automationWindowEnd = timing.currentWindowEnd;
    if (!timing.insideWindow) {
      automationStatus.state = "waiting";
      automationStatus.currentStep = "等待下一个运行时间段";
      if (timing.nextWindowStart) scheduleAutomationWake(timing.nextWindowStart);
      return;
    }
    automationStatus.state = "waiting";
    automationStatus.currentStep = "当前处于运行时间段，准备开始处理";
    if (allowImmediate) {
      let missing: string[];
      try {
        missing = await runtimeMissingRequirements();
      } catch {
        if (!isCurrentControl()) return;
        automationStatus.state = "manual_action_required";
        automationStatus.currentStep = "系统配置检测失败，请稍后再次检测";
        audit("automation_schedule_preflight_failed", "automation", "attention", "AUTOMATION_SCHEDULE_PREFLIGHT_FAILED");
        return;
      }
      if (!isCurrentControl()) return;
      const currentPlan = automationRepository.getPlan();
      if (!currentPlan.enabled || currentPlan.paused) return;
      const currentTiming = evaluateAutomationSchedule(currentPlan, clockNow());
      automationStatus.currentWindow = currentTiming.currentWindow;
      automationWindowEnd = currentTiming.currentWindowEnd;
      if (!currentTiming.insideWindow) {
        automationStatus.state = "waiting";
        automationStatus.currentStep = "等待下一个运行时间段";
        if (currentTiming.nextWindowStart) scheduleAutomationWake(currentTiming.nextWindowStart);
        return;
      }
      if (missing.length) {
        automationStatus.state = "manual_action_required";
        automationStatus.currentStep = `自动回复未启动，请先完成：${missing.join("、")}`;
        automationStatus.nextRunAt = null;
        return;
      }
      if (!isCurrentControl()) return;
      void launchAutomationRun("scheduled");
    }
    else if (timing.currentWindowEnd) scheduleAutomationWake(timing.currentWindowEnd);
  }

  /** Whether a new review may be started.  Stop/window-end never start another item. */
  function shouldStartNextReview(trigger: AutomationTrigger): boolean {
    if (automationStatus.state !== "running") return false;
    if (trigger === "manual") return true;
    return automationWindowEnd === null || clockNowMs() < automationWindowEnd.getTime();
  }

  function beginAutomationShutdown(): void {
    if (automationClosing) return;
    automationClosing = true;
    automationControlEpoch += 1;
    clearAutomationTimer();
  }

  /** Stop/window-end apply between reviews; Pause safely interrupts before another AI attempt. */
  function shouldContinueCurrentReview(): boolean {
    return automationStatus.state === "running" || automationStatus.state === "stopping";
  }


  function currentAutomationState(): AutomationState {
    return automationStatus.state;
  }

  async function executeAutomationRun(trigger: AutomationTrigger, onStartupSettled: () => void): Promise<void> {
    let runId: string | null = null;
    let startupSettled = false;
    const settleStartup = () => {
      if (startupSettled) return;
      startupSettled = true;
      onStartupSettled();
    };
    let frozenReviewScope: ResolvedReviewScope;
    let frozenProcessingMode: ReviewFilterMode;
    let finalState = "completed";
    let stopReason = "queue_empty";
    let recoverablePageFailure = false;
    try {
      const frozen = resolvePersistedReviewScope();
      frozenReviewScope = frozen.resolved;
      frozenProcessingMode = currentReviewFilterMode();
      runId = automationRepository.createRun(trigger, {
        preset: frozenReviewScope.preset,
        startDate: frozenReviewScope.startDate,
        endDate: frozenReviewScope.endDate,
        timezone: frozenReviewScope.timezone,
        revision: frozen.revision,
      }, clockNow());
      automationStatus = {
        ...automationStatus,
        state: "running",
        trigger,
        nextRunAt: null,
        currentStep: "正在检查淘宝登录",
        startedAt: clockNow().toISOString(),
        runId,
        processed: 0,
        succeeded: 0,
        manual: 0,
        failed: 0,
        reviewScope: toPublicReviewScope(frozenReviewScope, frozenProcessingMode),
        currentReview: null,
        currentReply: null,
      };
      const credentials = await readTmallCredentials();
      if (!credentials) throw new Error("请先保存并验证淘宝商家登录");
      const login = await verifyTmallLogin(credentials);
      if (login.state !== "authenticated") {
        automationStatus.state = "manual_action_required";
        automationStatus.currentStep = login.message ?? "淘宝登录需要人工处理";
        finalState = "manual_action_required";
        stopReason = login.state;
        return;
      }
      settleStartup();
      const deepseek = await getDeepSeekClient();
      const manualProductPolicy = new ManualProductPolicyService({
        products: manualProductRepository,
        replies: replyRepository,
        ai: deepseek,
      });
      const processor = new DraftProcessor({
        replies: replyRepository,
        templates: templateRepository,
        ai: deepseek,
        manualProductPolicy,
        complaintPolicy: complaintReviewPolicyFor(deepseek),
        now: clockNow,
      });
      if (!tmallAuthDriver.submitReply) throw new Error("当前浏览器驱动不支持正式回复提交，请重启本地控制台");
      const submitWithSessionRecovery = async (
        review: Parameters<NonNullable<TmallAuthDriver["submitReply"]>>[0],
        finalReply: string,
        control: { beforeSubmit(): void },
      ) => {
        const activity = createTmallOperationActivity();
        // A platform acknowledgement can occasionally hang after the click.
        // It must have the same hard deadline as navigation: after that point
        // the attempt is conservatively marked uncertain, never retried.
        const submitWithDeadline = () => withTmallOperationDeadline(
          tmallAuthDriver.submitReply!(review, finalReply, {
            beforeSubmit: () => {
              automationStatus.currentStep = "正在提交回复";
              control.beforeSubmit();
            },
            shouldContinue: activity.isActive,
          }),
          tmallBrowserOperationDeadlineMs,
          activity.cancel,
        );
        let delivery = await submitWithDeadline();
        if (delivery.state === "failed" && delivery.failureOperationKey === "session.login") {
          automationStatus.currentStep = "登录状态已失效，正在安全恢复并继续当前评价";
          const recovered = await verifyTmallLogin(credentials);
          if (recovered.state !== "authenticated") return delivery;
          delivery = await submitWithDeadline();
        }
        return delivery;
      };
      const submission = new SubmissionService({
        replies: replyRepository,
        attempts: replyAttemptRepository,
        driver: { submitReply: submitWithSessionRecovery },
      });
      let consecutiveFailures = 0;
      let retryWaiting = false;
      const submitReadyDraft = async (itemId: string): Promise<"succeeded" | "manual" | "failed"> => {
        if (!shouldContinueCurrentReview()) return "failed";
        automationStatus.currentReply = replyRepository.get(itemId)?.finalReply ?? null;
        automationStatus.currentStep = "正在核对目标评价";
        const submitOnce = async () => {
          submissionInFlight = true;
          try {
            return await submission.submit(itemId);
          } finally {
            submissionInFlight = false;
          }
        };
        let delivery = await submitOnce();
        let initialRepairResult: "auto_applied" | "pending_approval" | "rejected" | "unavailable" | null = null;
        let repairedOperationKey: string | null = null;
        if (delivery.state === "failed" && !delivery.manualActionRequired
          && delivery.failureOperationKey && delivery.failureOperationKey !== "session.login") {
          const failedLocator = locatorRepository.get(delivery.failureOperationKey);
          if (failedLocator?.risk === "low" && failedLocator.health !== "recovered") {
            automationStatus.currentStep = "页面元素发生变化，正在测试安全修复候选";
            initialRepairResult = await attemptLocatorRepair(delivery.failureOperationKey);
            if (initialRepairResult === "auto_applied") {
              repairedOperationKey = delivery.failureOperationKey;
              automationStatus.currentStep = "页面元素已自动恢复，正在续接当前评价";
              delivery = await submitOnce();
            }
          }
        }
        if (delivery.outcome === "skipped") {
          consecutiveFailures = 0;
          automationStatus.currentStep = delivery.evidence ?? "该评价已有其他处理动作，已跳过并继续";
          return "succeeded";
        }
        if (delivery.state === "submission_uncertain") {
          consecutiveFailures = 0;
          automationStatus.currentStep = "已记录旧提交状态并跳过该条，正在继续处理其他评价";
          return "succeeded";
        }
        if (delivery.state !== "sent") {
          automationStatus.failed += 1;
          consecutiveFailures += 1;
          if (delivery.manualActionRequired) {
            consecutiveFailures = 0;
            automationStatus.currentStep = "提交前无法安全定位，已记录原因并跳过该条";
            return "succeeded";
          }
          if (delivery.failureOperationKey === "session.login") {
            automationStatus.state = "manual_action_required";
            automationStatus.currentStep = "淘宝登录状态无法自动恢复，请在已打开的窗口完成验证后继续";
            return "failed";
          }
          if (delivery.failureOperationKey) {
            if (repairedOperationKey) {
              locatorRepository.rollback(repairedOperationKey);
              locatorRepository.markAttention(repairedOperationKey);
              automationStatus.state = "manual_action_required";
              automationStatus.currentStep = "自动修复未能恢复当前操作，已回滚并暂停等待处理";
              return "failed";
            }
            if (initialRepairResult) {
              automationStatus.currentStep = initialRepairResult === "pending_approval"
                ? "页面元素已找到修复候选，需要批准后继续"
                : "页面元素候选未通过安全验证，自动回复已暂停";
              automationStatus.state = "manual_action_required";
              return "failed";
            }
            const failedLocator = locatorRepository.get(delivery.failureOperationKey);
            if (failedLocator?.health === "recovered" && locatorRepository.rollback(delivery.failureOperationKey)) {
              automationStatus.state = "manual_action_required";
              automationStatus.currentStep = "新页面元素版本验证失败，已回滚到上一版本并暂停";
              return "failed";
            }
            automationStatus.currentStep = "页面元素发生变化，正在安全验证修复候选";
            const repair = await attemptLocatorRepair(delivery.failureOperationKey);
            automationStatus.currentStep = repair === "pending_approval"
              ? "回复相关页面元素已生成修复候选，需要在页面状态中批准"
              : repair === "auto_applied" ? "页面元素已自动恢复，下次将使用新版本" : "页面元素需要人工处理，自动回复已保持安全停止";
            automationStatus.state = "manual_action_required";
          }
          if (consecutiveFailures >= 3) {
            automationStatus.state = "error";
            automationStatus.currentStep = "连续三条回复提交失败，自动回复已暂停保护";
          }
          return "failed";
        }
        consecutiveFailures = 0;
        for (const operationKey of ["review.list", "review.product", "reply.open", "reply.editor", "reply.submit"]) locatorRepository.markSuccess(operationKey);
        automationStatus.succeeded += 1;
        return "succeeded";
      };
      const handleProcessedDraft = async (item: { id: string; state: string; outcome?: string; skipped?: boolean } | undefined): Promise<"succeeded" | "manual" | "failed"> => {
        if (!item) {
          automationStatus.failed += 1;
          return "failed";
        }
        const processedDraft = replyRepository.get(item.id);
        if (!processedDraft) {
          automationStatus.failed += 1;
          return "failed";
        }
        if (processedDraft.state === "manual_product_hold") {
          consecutiveFailures = 0;
          automationStatus.manual += 1;
          automationStatus.currentStep = "名单商品的中评或差评已跳过，未回复、未投诉，正在继续处理其他评价";
          return "manual";
        }
        if (["completed", "skipped"].includes(item.outcome ?? "")
          && ["read_only_ready", "needs_attention"].includes(processedDraft.state)) {
          return submitReadyDraft(item.id);
        }
        if (item.outcome === "circuit_breaker") {
          automationStatus.failed += 1;
          consecutiveFailures = 0;
          automationStatus.currentStep = "AI 连续重试未恢复，已记录原因并跳过该评价，继续处理其他评价";
          return "failed";
        }
        if (item.outcome === "retry_wait" || processedDraft.state === "retry_wait") {
          retryWaiting = true;
          automationStatus.currentStep = "AI 暂时不可用，已安全排队，稍后自动重试";
          return "succeeded";
        }
        if (item.outcome === "manual_action_required") {
          automationStatus.failed += 1;
          automationStatus.state = "manual_action_required";
          automationStatus.currentStep = "AI 配置或回复校验需要人工处理，请检查系统设置后继续";
          return "failed";
        }
        if (item.outcome === "paused") return "failed";
        if (item.outcome === "skipped" || item.skipped) {
          consecutiveFailures = 0;
          automationStatus.currentStep = "该评价已有其他处理动作，已跳过并继续";
          return "succeeded";
        }
        automationStatus.failed += 1;
        automationStatus.state = "manual_action_required";
        automationStatus.currentStep = "回复草稿状态无法安全确认，已暂停等待处理";
        return "failed";
      };
      const readPageWithRecovery = async (page: number, pageSize: number, phase: ReviewScanPhase) => {
        const read = () => tmallAuthDriver.readPendingReviewPageState
          ? tmallAuthDriver.readPendingReviewPageState(page, pageSize, frozenReviewScope, phase, frozenProcessingMode)
          : tmallAuthDriver.readPendingReviewPage
          ? tmallAuthDriver.readPendingReviewPage(page, pageSize, frozenReviewScope, phase, frozenProcessingMode)
          : page === 1
            ? tmallAuthDriver.readPendingReviews(pageSize, frozenReviewScope).then((items) => items.filter((item) =>
              frozenProcessingMode === "content_unanswered" || item.reviewPhase === phase,
            ))
            : Promise.resolve([]);
        const readAndValidate = async () => {
          const pageResult = await read();
          const snapshots = Array.isArray(pageResult) ? pageResult : pageResult.items;
          assertReviewSnapshotsWithinScope(snapshots, frozenReviewScope);
          return Array.isArray(pageResult) ? snapshots : { ...pageResult, items: snapshots };
        };
        let transientPageStateFailures = 0;
        let locatorRecoveryAttempted = false;
        let sessionRecoveryAttempted = false;
        while (true) {
          try {
            return await readAndValidate();
          } catch (error) {
            if (error instanceof ReviewFilterStateError || error instanceof TmallReviewPageStateError) {
              if (transientPageStateFailures < 2) {
                transientPageStateFailures += 1;
                automationStatus.currentStep = `淘宝评价页面暂时未稳定，正在重新读取（${transientPageStateFailures}/2）`;
                await new Promise((resolve) => setTimeout(resolve, 100));
                continue;
              }
              recoverablePageFailure = true;
              automationStatus.currentStep = "淘宝评价页面暂时无法读取，本轮已安全结束，可再次运行";
              audit("automation_read_recovery_failed", "tmall_review_page", "attention", "TMALL_PAGE_STATE_UNTRUSTED");
              throw error;
            }
            if (locatorRecoveryAttempted) {
              recoverablePageFailure = true;
              automationStatus.currentStep = "淘宝评价页面暂时无法读取，本轮已安全结束，可再次运行";
              audit("automation_read_recovery_failed", "tmall_review_page", "attention", "TMALL_READ_RECOVERY_FAILED");
              throw error;
            }
            if (sessionRecoveryAttempted) {
              recoverablePageFailure = true;
              automationStatus.currentStep = "淘宝评价页面暂时无法读取，本轮已安全结束，可再次运行";
              audit("automation_read_recovery_failed", "tmall_review_page", "attention", "TMALL_LOGIN_READ_RECOVERY_FAILED");
              throw error;
            }
            if (error instanceof TmallDriverOperationError) {
              const repair = await attemptLocatorRepair(error.operationKey);
              if (repair === "auto_applied") {
                locatorRecoveryAttempted = true;
                continue;
              }
              recoverablePageFailure = true;
              automationStatus.currentStep = "淘宝评价页面暂时无法读取，本轮已安全结束，可再次运行";
              audit("automation_read_recovery_failed", "tmall_review_page", "attention", "TMALL_READ_RECOVERY_FAILED");
              throw error;
            }
            if (error instanceof Error && /登录状态.*失效/u.test(error.message)) {
              automationStatus.currentStep = "登录状态已失效，正在恢复原来的处理位置";
              const recovered = await verifyTmallLogin(credentials);
              if (recovered.state === "authenticated") {
                sessionRecoveryAttempted = true;
                continue;
              }
              automationStatus.state = "manual_action_required";
              automationStatus.currentStep = recovered.message ?? "淘宝登录需要人工处理";
            }
            throw error;
          }
        }
      };
      const result = await drainPendingReviewQueue({
        scope: frozenReviewScope,
        mode: frozenProcessingMode,
        readPage: readPageWithRecovery,
        shouldStartNext: () => shouldStartNextReview(trigger),
        ...(options.interItemDelay ? { interItemDelay: options.interItemDelay } : {}),
        onPhaseChange: (phase) => {
          if (phase === "checking_for_new_reviews") automationStatus.currentStep = "正在检查新评价";
        },
        onFullScanCompleted: ({ observedSourceKeys, scope }) => {
          if (scope !== frozenReviewScope) throw new Error("本轮评价处理范围无法安全确认");
          replyRepository.recordManualHoldScanEvidence({
            storeId: "primary",
            scopeStartDate: scope.startDate,
            scopeEndDate: scope.endDate,
            seenSourceKeys: [...observedSourceKeys],
            complete: true,
            now: clockNow(),
          });
        },
        processOne: async (snapshot) => {
          automationStatus.currentReview = { sourceKey: snapshot.sourceKey, review: snapshot.review, product: snapshot.product };
          automationStatus.currentReply = null;
          automationStatus.currentStep = `正在处理：${snapshot.review.slice(0, 28)}`;
           const processed = await processor.processSnapshots([snapshot], {
             shouldContinue: shouldContinueCurrentReview,
             onProgress: (message) => { automationStatus.currentStep = message; },
           });
          automationStatus.processed += 1;
          return handleProcessedDraft(processed.items[0]);
        },
      });
      stopReason = result.stopReason === "control_requested"
        ? automationStatus.state === "paused" ? "paused" : automationStatus.state === "stopping" ? "stopped" : "window_ended"
        : "queue_empty";
      const stateAfterDrain = currentAutomationState();
      if (stateAfterDrain === "manual_action_required" || stateAfterDrain === "error") {
        finalState = stateAfterDrain;
        stopReason = stateAfterDrain === "manual_action_required" ? "manual_action_required" : "failure_circuit_open";
      } else if (stateAfterDrain === "stopping") {
        finalState = "stopped";
        automationStatus.state = "disabled";
        automationStatus.currentStep = "已停止并关闭自动计划";
      } else if (stateAfterDrain === "paused") {
        finalState = "paused";
        automationStatus.currentStep = "自动回复已暂停，需要手动继续";
      } else if (trigger === "manual") {
        finalState = "completed";
        const plan = automationRepository.getPlan();
        automationStatus.state = plan.enabled ? plan.paused ? "paused" : "waiting" : "disabled";
        automationStatus.currentStep = retryWaiting && plan.enabled && !plan.paused
          ? "AI 暂时不可用，已安全排队，等待下一次自动重试"
          : retryWaiting
            ? "AI 重试已安全排队，可立即再次处理或等待自动计划"
            : "当前队列已处理完，可随时再次运行";
      } else {
        automationStatus.state = "waiting";
        automationStatus.currentStep = retryWaiting
          ? "AI 暂时不可用，已安全排队，等待下一次自动重试"
          : stopReason === "window_ended" ? "当前时间段已结束，等待下一次运行" : "当前队列已处理完，等待下一次运行";
      }
    } catch (error) {
      if (recoverablePageFailure) {
        finalState = "error";
        stopReason = "recoverable_page_failure";
        const plan = automationRepository.getPlan();
        automationStatus.state = plan.enabled && !plan.paused ? "waiting" : "disabled";
        automationStatus.currentStep = plan.enabled && !plan.paused
          ? "淘宝评价页面暂时无法读取，本轮已安全结束，等待下一次运行"
          : "淘宝评价页面暂时无法读取，本轮已安全结束，可再次运行";
        audit("automation_run_failed", "automation_runs", "attention", "AUTOMATION_RUN_FAILED");
      } else if (automationStatus.state === "manual_action_required") {
        finalState = "manual_action_required";
        stopReason = "manual_action_required";
      } else {
        finalState = "error";
        stopReason = "run_failed";
        const plan = automationRepository.getPlan();
        if (plan.enabled && !plan.paused) {
          automationStatus.state = "waiting";
          automationStatus.currentStep = automationRunRetryMessage(error);
        } else {
          automationStatus.state = "error";
          automationStatus.currentStep = automationRunFailureMessage(automationStatus.currentStep);
        }
        audit("automation_run_failed", "automation_runs", "attention", "AUTOMATION_RUN_FAILED");
      }
    } finally {
      settleStartup();
      if (runId) {
        automationRepository.finishRun(runId, {
          state: finalState,
          processed: automationStatus.processed,
          succeeded: automationStatus.succeeded,
          manual: automationStatus.manual,
          failed: automationStatus.failed,
          stopReason,
          at: clockNow(),
        });
      }
      automationStatus.runId = null;
      automationStatus.startedAt = null;
      if (automationStatus.state === "manual_action_required") manualActionTrigger = trigger;
      automationStatus.trigger = null;
    }
  }

  function launchAutomationRun(trigger: AutomationTrigger): { launched: boolean; startup: Promise<void> } {
    if (automationClosing || automationPromise) return { launched: false, startup: Promise.resolve() };
    let resolveStartup!: () => void;
    const startup = new Promise<void>((resolve) => { resolveStartup = resolve; });
    automationControlEpoch += 1;
    manualActionTrigger = null;
    automationStatus.state = "running";
    automationStatus.trigger = trigger;
    automationStatus.currentStep = "准备开始处理";
    automationPromise = executeAutomationRun(trigger, resolveStartup).finally(async () => {
      automationPromise = null;
      if (automationStatus.state === "waiting") {
        const plan = automationRepository.getPlan();
        const timing = evaluateAutomationSchedule(plan, clockNow());
        const intervalAt = new Date(clockNowMs() + plan.intervalMinutes * 60_000);
        if (timing.insideWindow && timing.currentWindowEnd && intervalAt < timing.currentWindowEnd) scheduleAutomationWake(intervalAt);
        else await rescheduleAutomation(false);
      } else if (trigger === "manual" && automationStatus.state === "running") {
        await rescheduleAutomation(false);
      }
    });
    return { launched: true, startup };
  }

  function consumeNonce(
    reply: FastifyReply,
    input: { nonce: string | undefined; action: SecretConfirmationAction },
  ): boolean {
    try {
      nonceService.consume({
        nonce: input.nonce ?? "",
        sessionId: options.sessionToken,
        action: input.action,
      });
      return true;
    } catch {
      void reply.code(409).send({ error: "confirmation_nonce_invalid_or_expired" });
      return false;
    }
  }

  function resolvePersistedReviewScope(): { resolved: ResolvedReviewScope; revision: number } {
    const persisted = reviewScopeRepository.get();
    if (persisted.preset === "custom" && (!persisted.startDate || !persisted.endDate)) {
      throw new Error("自定义处理日期配置不完整，请重新保存日期范围");
    }
    const resolved = resolveReviewScope(
      persisted.preset === "custom"
        ? { preset: "custom", startDate: persisted.startDate!, endDate: persisted.endDate! }
        : { preset: persisted.preset },
      clockNow(),
    );
    return { resolved, revision: persisted.revision };
  }

  function currentReviewFilterMode(): ReviewFilterMode {
    return parseReviewFilterMode(settingsRepository.get<string>("review_filter_mode")) ?? "content_unanswered";
  }

  function toPublicReviewScope(
    scope: Pick<ResolvedReviewScope, "preset" | "startDate" | "endDate" | "timezone">,
    processingMode: ReviewFilterMode = currentReviewFilterMode(),
  ): PublicReviewScope {
    const resolved = {
      ...resolveReviewScope({ preset: "custom", startDate: scope.startDate, endDate: scope.endDate }, clockNow()),
      preset: scope.preset,
    };
    return {
      preset: scope.preset,
      startDate: scope.startDate,
      endDate: scope.endDate,
      timezone: scope.timezone,
      summary: formatReviewScopeSummary(resolved),
      processingMode,
    };
  }

  function reviewScopeView() {
    const persisted = reviewScopeRepository.get();
    const { resolved } = resolvePersistedReviewScope();
    return {
      ...persisted,
      effectiveStartDate: resolved.startDate,
      effectiveEndDate: resolved.endDate,
      summary: formatReviewScopeSummary(resolved),
      processingMode: currentReviewFilterMode(),
    };
  }

  function auditedMutation<T>(eventType: string, target: string, mutation: () => T): T {
    return database.transaction(() => {
      const result = mutation();
      audit(eventType, target, "success");
      return result;
    }).immediate();
  }

  function multipartErrorCode(error: unknown): string | null {
    if (typeof error !== "object" || error === null || !("code" in error)) return null;
    return typeof error.code === "string" ? error.code : null;
  }

  function errorStatusCode(error: unknown): number | null {
    if (typeof error !== "object" || error === null || !("statusCode" in error)) return null;
    return typeof error.statusCode === "number" ? error.statusCode : null;
  }

  function isMultipartClientError(error: unknown): boolean {
    const statusCode = errorStatusCode(error);
    if (statusCode !== null && statusCode >= 400 && statusCode < 500) return true;
    const code = multipartErrorCode(error);
    if (code === "FST_MP_PREMATURE_CLOSE") return true;
    if (typeof error !== "object" || error === null || !("message" in error) || typeof error.message !== "string") return false;
    return /boundary not found|unexpected end|terminated early|premature close/iu.test(error.message);
  }

  function singleQueryString(value: unknown): string | undefined | null {
    if (value === undefined) return undefined;
    return typeof value === "string" ? value : null;
  }

  function parsePositiveInteger(value: unknown): number | null {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
    if (typeof value === "string" && /^\d+$/u.test(value)) {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
    }
    return null;
  }

  function sendAutomationMutationFailure(reply: FastifyReply, error: unknown) {
    if (error instanceof AutomationPlanRevisionConflictError) {
      return reply.code(409).send({ error: "automation_plan_changed", detail: error.message, currentRevision: error.currentRevision });
    }
    return reply.code(500).send({ error: "automation_plan_update_failed", detail: "自动计划更新失败，请稍后重试" });
  }

  app.register(cookie);
  app.register(multipart, {
    limits: { files: 1, fileSize: MAX_UPLOAD_BYTES, fields: 0, parts: 1 },
    throwFileSizeLimit: true,
  });

  app.addHook("preClose", async () => {
    beginAutomationShutdown();
    await localXlsxPicker.close?.();
  });

  app.addHook("onClose", async () => {
    clearAutomationTimer();
    importPreviewStore.dispose();
    if (cleanupTimer) clearInterval(cleanupTimer);
    if (automationPromise && automationStatus.state !== "paused") {
      pausedTrigger = null;
      automationStatus.state = "stopping";
      automationStatus.currentStep = "正在完成当前评价，随后停止";
    }
    if (automationPromise) await automationPromise;
    await tmallAuthDriver.close();
    database.close();
  });

  app.addHook("onReady", async () => {
    await rescheduleAutomation(true);
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.headers.host !== options.host) return reply.code(403).send({ error: "invalid_host" });
    if (request.url === "/api/bootstrap") return;
    if (!request.url.startsWith("/api/")) return;
    if (request.cookies[SESSION_COOKIE] !== options.sessionToken) {
      return reply.code(401).send({ error: "invalid_session" });
    }
    if (isMutation(request)) {
      const validOrigin = request.headers.origin === options.origin && request.headers["sec-fetch-site"] === "same-origin";
      if (!validOrigin) return reply.code(403).send({ error: "invalid_request_origin" });
      if (request.headers["x-csrf-token"] !== options.csrfToken) return reply.code(403).send({ error: "invalid_csrf" });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (request.url.split("?", 1)[0] === "/api/manual-products/import/preview") {
      const code = multipartErrorCode(error);
      if (code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ error: "manual_product_file_too_large", detail: "文件大小不能超过 5MB" });
      }
      if (["FST_FILES_LIMIT", "FST_FIELDS_LIMIT", "FST_PARTS_LIMIT"].includes(code ?? "")) {
        return reply.code(400).send({ error: "manual_product_file_count_invalid", detail: "每次只能上传一个 .xlsx 文件" });
      }
      if (["FST_INVALID_MULTIPART_CONTENT_TYPE", "FST_ERR_CTP_INVALID_MEDIA_TYPE"].includes(code ?? "")) {
        return reply.code(400).send({ error: "manual_product_file_required", detail: "请选择一个 .xlsx 文件" });
      }
      if (isMultipartClientError(error)) {
        return reply.code(400).send({ error: "manual_product_file_required", detail: "请选择一个有效的 .xlsx 文件" });
      }
      return reply.code(500).send({ error: "manual_product_preview_failed", detail: "无法预览该名单，请稍后重试" });
    }
    const statusCode = errorStatusCode(error) ?? 500;
    if (statusCode >= 500) {
      const operationKey = error instanceof TmallDriverOperationError
        ? error.operationKey
        : tmallAuthDriver.getCurrentOperationKey?.() ?? null;
      console.error(JSON.stringify({
        event: "internal_request_failure",
        path: request.url.split("?", 1)[0],
        errorType: error instanceof Error ? error.name : "unknown",
        operationKey,
      }));
    }
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: "INVALID_REQUEST", detail: "请求格式不正确，请检查后重试" });
    }
    return reply.code(500).send({ error: "INTERNAL_ERROR", detail: "系统暂时无法完成操作，请稍后重试" });
  });

  app.get("/api/bootstrap", async (_request, reply) => {
    reply.setCookie(SESSION_COOKIE, options.sessionToken, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      secure: false,
    });
    return { csrfToken: options.csrfToken, readOnly: false };
  });

  app.post<{ Params: { sessionId: string } }>("/api/ui-sessions/:sessionId", async (request, reply) => {
    if (!uiSessionManager) return reply.code(503).send({ error: "ui_sessions_unavailable" });
    try {
      const activeCount = uiSessionManager.register(request.params.sessionId);
      if (activeCount === 1) await rescheduleAutomation(true);
      return { activeCount };
    } catch {
      return reply.code(400).send({ error: "invalid_ui_session" });
    }
  });

  app.post<{ Params: { sessionId: string } }>("/api/ui-sessions/:sessionId/heartbeat", async (request, reply) => {
    if (!uiSessionManager) return reply.code(503).send({ error: "ui_sessions_unavailable" });
    try {
      return { activeCount: uiSessionManager.heartbeat(request.params.sessionId) };
    } catch {
      return reply.code(400).send({ error: "invalid_ui_session" });
    }
  });

  app.delete<{ Params: { sessionId: string } }>("/api/ui-sessions/:sessionId", async (request, reply) => {
    if (!uiSessionManager) return reply.code(503).send({ error: "ui_sessions_unavailable" });
    try {
      return { activeCount: uiSessionManager.close(request.params.sessionId) };
    } catch {
      return reply.code(400).send({ error: "invalid_ui_session" });
    }
  });

  app.get("/api/review-scope", async () => reviewScopeView());
  app.put<{ Body: { preset?: unknown; startDate?: unknown; endDate?: unknown; processingMode?: unknown; expectedRevision?: unknown } }>(
    "/api/review-scope",
    async (request, reply) => {
      const expectedRevision = parsePositiveInteger(request.body?.expectedRevision);
      const processingMode = request.body?.processingMode === undefined
        ? currentReviewFilterMode()
        : parseReviewFilterMode(request.body.processingMode);
      let input: ReturnType<typeof validateReviewScopeInput>;
      try {
        input = validateReviewScopeInput({
          preset: request.body?.preset,
          startDate: request.body?.startDate,
          endDate: request.body?.endDate,
        });
      } catch {
        return reply.code(400).send({ error: "invalid_review_scope", detail: "请选择有效的处理日期" });
      }
      if (expectedRevision === null || processingMode === null) {
        return reply.code(400).send({ error: "invalid_review_scope", detail: "请选择有效的处理日期和评价类型" });
      }
      try {
        auditedMutation("review_scope_saved", "review_scope", () => {
          reviewScopeRepository.save(input, expectedRevision);
          settingsRepository.set("review_filter_mode", processingMode);
        });
        return reviewScopeView();
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          return reply.code(409).send({
            error: "review_scope_changed",
            detail: "处理日期已在其他页面修改，请刷新后重试",
            currentRevision: error.currentRevision,
          });
        }
        return reply.code(500).send({ error: "review_scope_save_failed", detail: "处理日期保存失败，请稍后重试" });
      }
    },
  );

  app.get<{ Querystring: { query?: unknown; page?: unknown; pageSize?: unknown } }>("/api/manual-products", async (request, reply) => {
    const query = singleQueryString(request.query.query);
    const pageValue = singleQueryString(request.query.page);
    const pageSizeValue = singleQueryString(request.query.pageSize);
    const page = pageValue === undefined ? 1 : parsePositiveInteger(pageValue);
    const pageSize = pageSizeValue === undefined ? 20 : parsePositiveInteger(pageSizeValue);
    if (query === null || pageValue === null || pageSizeValue === null || page === null || pageSize === null || pageSize > 200 || (query?.length ?? 0) > 200) {
      return reply.code(400).send({ error: "invalid_manual_product_query", detail: "请检查搜索内容和分页设置" });
    }
    return manualProductRepository.listWithStats({
      ...(query === undefined ? {} : { query }),
      page,
      pageSize,
    });
  });

  app.post<{ Body: { title?: unknown; itemId?: unknown; expectedRevision?: unknown } }>("/api/manual-products", async (request, reply) => {
    const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
    const itemId = typeof request.body?.itemId === "string" ? request.body.itemId.trim() : "";
    const expectedRevision = parsePositiveInteger(request.body?.expectedRevision);
    if (!itemId || itemId.length > 200 || title.length > 500 || expectedRevision === null) {
      return reply.code(400).send({ error: "invalid_manual_product", detail: "请填写有效的商品 ID 和名单版本" });
    }
    try {
      const result = database.transaction(() => {
        const saved = manualProductRepository.upsert({ title, itemId }, "manual", expectedRevision);
        if (!PRODUCT_UUID.test(saved.product.id)) throw new Error("invalid generated product identifier");
        audit("manual_product_saved", saved.product.id, "success");
        return saved;
      }).immediate();
      return result;
    } catch (error) {
      if (error instanceof ManualCatalogRevisionConflictError) {
        return reply.code(409).send({ error: "manual_product_catalog_changed", detail: error.message, currentRevision: error.currentRevision });
      }
      if (error instanceof ManualProductConflictError) {
        return reply.code(409).send({ error: "manual_product_identity_conflict", detail: error.message });
      }
      return reply.code(500).send({ error: "manual_product_save_failed", detail: "商品保存失败，请稍后重试" });
    }
  });

  app.delete<{ Params: { id: string }; Body: { expectedRevision?: unknown } }>("/api/manual-products/:id", async (request, reply) => {
    const expectedRevision = parsePositiveInteger(request.body?.expectedRevision);
    if (expectedRevision === null) return reply.code(400).send({ error: "invalid_manual_product_revision", detail: "名单版本无效，请刷新后重试" });
    if (!PRODUCT_UUID.test(request.params.id)) {
      return reply.code(404).send({ error: "manual_product_not_found", detail: "未找到该人工处理商品" });
    }
    try {
      const result = database.transaction(() => {
        if (!manualProductRepository.get(request.params.id)) throw new ManualProductNotFoundError();
        const removed = manualProductRepository.remove(request.params.id, expectedRevision);
        audit("manual_product_removed", request.params.id, "success");
        return removed;
      }).immediate();
      return result;
    } catch (error) {
      if (error instanceof ManualProductNotFoundError) {
        return reply.code(404).send({ error: "manual_product_not_found", detail: "未找到该人工处理商品" });
      }
      if (error instanceof ManualCatalogRevisionConflictError) {
        return reply.code(409).send({ error: "manual_product_catalog_changed", detail: error.message, currentRevision: error.currentRevision });
      }
      return reply.code(500).send({ error: "manual_product_remove_failed", detail: "商品移除失败，请稍后重试" });
    }
  });

  app.post("/api/manual-products/import/preview", async (request, reply) => {
    try {
      let upload: { filename: string; mimetype: string; buffer: Buffer } | null = null;
      for await (const part of request.parts()) {
        if (part.type !== "file" || upload) {
          if (part.type === "file") part.file.resume();
          return reply.code(400).send({ error: "manual_product_file_count_invalid", detail: "每次只能上传一个 .xlsx 文件" });
        }
        upload = { filename: part.filename, mimetype: part.mimetype, buffer: await part.toBuffer() };
      }
      if (!upload) return reply.code(400).send({ error: "manual_product_file_required", detail: "请选择一个 .xlsx 文件" });
      const previewInput = {
        sessionId: options.sessionToken,
        filename: upload.filename,
        mimetype: upload.mimetype,
        buffer: upload.buffer,
      };
      const preview = await manualProductImportService.preview(previewInput);
      const { token, ...safePreview } = preview;
      return { ...safePreview, previewId: token };
    } catch (error) {
      const code = multipartErrorCode(error);
      if (code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ error: "manual_product_file_too_large", detail: "文件大小不能超过 5MB" });
      }
      if (["FST_FILES_LIMIT", "FST_FIELDS_LIMIT", "FST_PARTS_LIMIT"].includes(code ?? "")) {
        return reply.code(400).send({ error: "manual_product_file_count_invalid", detail: "每次只能上传一个 .xlsx 文件" });
      }
      if (code === "FST_INVALID_MULTIPART_CONTENT_TYPE") {
        return reply.code(400).send({ error: "manual_product_file_required", detail: "请选择一个 .xlsx 文件" });
      }
      if (isMultipartClientError(error)) {
        return reply.code(400).send({ error: "manual_product_file_required", detail: "请选择一个有效的 .xlsx 文件" });
      }
      if (error instanceof XlsxValidationError) {
        return reply.code(422).send({ error: "invalid_manual_product_workbook", detail: error.message });
      }
      if (error instanceof ImportPreviewSupersededError) {
        return reply.code(409).send({ error: "manual_product_preview_superseded", detail: "该预览已被较新的文件选择取代" });
      }
      if (error instanceof ManualProductImportError) {
        return reply.code(422).send({ error: "manual_product_preview_failed", detail: "无法预览该名单，请重新选择文件" });
      }
      return reply.code(500).send({ error: "manual_product_preview_failed", detail: "无法预览该名单，请稍后重试" });
    }
  });

  app.post("/api/manual-products/import/select-and-preview", async (_request, reply) => {
    let selected: Awaited<ReturnType<LocalXlsxPicker["pick"]>>;
    try {
      selected = await localXlsxPicker.pick();
    } catch (error) {
      if (error instanceof LocalXlsxPickerUnavailableError) {
        return reply.code(501).send({
          error: "manual_product_local_picker_unavailable",
          detail: "当前环境无法打开系统文件选择窗口，请使用浏览器上传（备用）",
        });
      }
      return reply.code(500).send({
        error: "manual_product_local_picker_failed",
        detail: "无法打开本机文件选择窗口，请使用浏览器上传（备用）",
      });
    }
    if (selected.cancelled) return { cancelled: true };
    manualProductImportService.invalidatePreview(options.sessionToken);

    let canonicalPath: string;
    let fileInfo: Awaited<ReturnType<typeof stat>>;
    try {
      canonicalPath = await realpath(selected.path);
      fileInfo = await stat(canonicalPath);
    } catch {
      return reply.code(422).send({
        error: "manual_product_local_file_invalid",
        detail: "所选文件已不存在或无法读取，请重新选择",
      });
    }
    if (!fileInfo.isFile()) {
      return reply.code(422).send({
        error: "manual_product_local_file_invalid",
        detail: "请选择一个有效的 Excel 文件",
      });
    }
    if (extname(canonicalPath).toLowerCase() !== ".xlsx") {
      return reply.code(422).send({
        error: "invalid_manual_product_workbook",
        detail: "请选择 .xlsx 格式的 Excel 文件",
      });
    }
    if (fileInfo.size > MAX_UPLOAD_BYTES) {
      return reply.code(413).send({ error: "manual_product_file_too_large", detail: "文件大小不能超过 5MB" });
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(canonicalPath);
    } catch {
      return reply.code(422).send({
        error: "manual_product_local_file_invalid",
        detail: "所选文件无法读取，请重新选择",
      });
    }
    const displayFilename = basename(canonicalPath);
    try {
      const preview = await manualProductImportService.preview({
        sessionId: options.sessionToken,
        filename: displayFilename,
        buffer,
      });
      const { token, ...safePreview } = preview;
      return { cancelled: false, displayFilename, ...safePreview, previewId: token };
    } catch (error) {
      if (error instanceof XlsxValidationError) {
        return reply.code(422).send({ error: "invalid_manual_product_workbook", detail: error.message });
      }
      if (error instanceof ImportPreviewSupersededError) {
        return reply.code(409).send({ error: "manual_product_preview_superseded", detail: "该预览已被较新的文件选择取代" });
      }
      if (error instanceof ManualProductImportError) {
        return reply.code(422).send({ error: "manual_product_preview_failed", detail: "无法预览该名单，请重新选择文件" });
      }
      return reply.code(500).send({ error: "manual_product_preview_failed", detail: "无法预览该名单，请稍后重试" });
    }
  });

  app.post<{ Body: { previewId?: unknown } }>("/api/manual-products/import/apply", async (request, reply) => {
    const previewId = typeof request.body?.previewId === "string" ? request.body.previewId : "";
    if (!previewId) return reply.code(400).send({ error: "import_preview_required", detail: "请先选择文件，等待预览完成" });
    try {
      const result = auditedMutation("manual_product_import_applied", "manual_product_catalog", () =>
        manualProductImportService.applySync({ sessionId: options.sessionToken, token: previewId }),
      );
      return result;
    } catch (error) {
      if (error instanceof ManualProductImportError) {
        if (error.code === "PREVIEW_INVALID") {
          return reply.code(410).send({ error: "import_preview_invalid", detail: "预览已失效，请重新选择文件" });
        }
        if (error.code === "CATALOG_CHANGED") {
          return reply.code(409).send({ error: "manual_product_catalog_changed", detail: "名单已发生变化，请重新选择文件" });
        }
        return reply.code(500).send({ error: "manual_product_import_failed", detail: "名单更新失败，请重新选择文件" });
      }
      return reply.code(500).send({ error: "manual_product_import_failed", detail: "名单更新未完成，请重新选择文件后再试" });
    }
  });

  app.get("/api/automation-plan", async () => automationRepository.getPlan());
  app.get("/api/automation/preflight", async () => automationPreflight());
  app.put<{ Body: { enabled?: boolean; paused?: boolean; intervalMinutes?: number; windows?: Array<{ id?: string; start?: string; end?: string }>; expectedRevision?: unknown } }>(
    "/api/automation-plan",
    async (request, reply) => {
      const current = automationRepository.getPlan();
      const expectedRevision = parsePositiveInteger(request.body?.expectedRevision);
      if (expectedRevision === null) {
        return reply.code(400).send({ error: "invalid_automation_plan", detail: "自动计划版本无效，请刷新后重试" });
      }
      let plan: ReturnType<typeof validateAutomationPlan>;
      try {
        const validated = validateAutomationPlan({ ...request.body, paused: current.paused });
        plan = validated.enabled ? validated : { ...validated, paused: false };
      } catch (error) {
        return reply.code(400).send({ error: "invalid_automation_plan", detail: automationPlanValidationMessage(error) });
      }
      if (plan.enabled) {
        const preflight = await automationPreflight();
        if (!preflight.ready) return reply.code(409).send({ error: "automation_not_ready", detail: `请先完成：${preflight.missing.join("、")}`, missing: preflight.missing });
      }
      try {
        const saved = auditedMutation("automation_plan_saved", "automation_plan", () => automationRepository.savePlan(plan, expectedRevision));
        automationControlEpoch += 1;
        await rescheduleAutomation(true);
        return saved;
      } catch (error) {
        return sendAutomationMutationFailure(reply, error);
      }
    },
  );
  app.get("/api/automation/status", async () => automationStatusView());
  app.post("/api/automation/start-now", async (_request, reply) => {
    if (!hasActiveUiSession()) return reply.code(409).send({ error: "foreground_session_required" });
    const expectedControlEpoch = automationControlEpoch;
    const isCurrentManualStart = () => !automationClosing
      && automationControlEpoch === expectedControlEpoch
      && automationStatus.state !== "paused"
      && automationStatus.state !== "stopping";
    if (automationPromise) {
      // Never queue a second run behind an active/paused run. A terminal
      // status with a remaining promise is only housekeeping; that narrow
      // case may be awaited under the entry epoch gate below.
      if (["running", "stopping", "paused"].includes(automationStatus.state)) {
        return reply.code(409).send({ error: "automation_already_running", detail: "自动回复正在运行" });
      }
      await automationPromise;
    }
    if (!isCurrentManualStart()) return automationStatusView();
    let missing: string[];
    try {
      missing = await runtimeMissingRequirements();
    } catch (error) {
      if (error instanceof TmallCredentialReadError) {
        return reply.code(503).send({
          error: "tmall_credentials_temporarily_unavailable",
          detail: "读取已保存的淘宝登录信息失败，请再次点击“立即处理一轮”重试",
        });
      }
      throw error;
    }
    if (!isCurrentManualStart()) return automationStatusView();
    if (missing.length) return reply.code(409).send({ error: "automation_not_ready", detail: `请先完成：${missing.join("、")}`, missing });
    if (!launchAutomationRun("manual").launched) return automationStatusView();
    return automationStatusView();
  });
  app.post("/api/automation/pause", async (_request, reply) => {
    const expectedControlEpoch = automationControlEpoch;
    const planAtEntry = automationRepository.getPlan();
    const canPause = () => !automationClosing
      && automationControlEpoch === expectedControlEpoch
      && ((automationPromise !== null && automationStatus.state === "running")
        || (planAtEntry.enabled && automationStatus.state === "waiting"));
    if (!canPause()) {
      return reply.code(409).send({ error: "automation_not_active", detail: "当前没有可暂停的自动回复任务" });
    }
    try {
      auditedMutation("automation_plan_paused", "automation_plan", () => automationRepository.setPaused(true));
      automationControlEpoch += 1;
      pausedTrigger = automationStatus.trigger;
      clearAutomationTimer();
      automationStatus.state = "paused";
      tmallAuthDriver.setLaunchAllowed?.(false);
      automationStatus.nextRunAt = null;
      automationStatus.currentStep = "自动回复已暂停，需要手动继续";
      return automationStatusView();
    } catch (error) {
      return sendAutomationMutationFailure(reply, error);
    }
  });
  app.post("/api/automation/resume", async (_request, reply) => {
    const expectedControlEpoch = automationControlEpoch;
    const isCurrentResume = () => !automationClosing
      && automationControlEpoch === expectedControlEpoch
      && automationStatus.state === "paused";
    if (!isCurrentResume()) {
      return reply.code(409).send({ error: "automation_not_paused", detail: "当前任务未处于暂停状态，不能继续处理" });
    }
    const missing = await runtimeMissingRequirements();
    if (!isCurrentResume()) return automationStatusView();
    if (missing.length) return reply.code(409).send({ error: "automation_not_ready", detail: `请先完成：${missing.join("、")}`, missing });
    const currentPlan = automationRepository.getPlan();
    // A manually-triggered run can be paused while the recurring plan is
    // disabled. The persisted paused bit, not plan.enabled, is the boundary
    // that proves this resume still belongs to the same paused run.
    if (!currentPlan.paused) return automationStatusView();
    tmallAuthDriver.setLaunchAllowed?.(true);
    let plan;
    try {
      plan = auditedMutation("automation_plan_resumed", "automation_plan", () => automationRepository.setPaused(false));
      automationControlEpoch += 1;
    } catch (error) {
      return sendAutomationMutationFailure(reply, error);
    }
    const trigger = pausedTrigger;
    pausedTrigger = null;
    if (automationPromise) {
      automationStatus.state = "running";
      automationStatus.currentStep = "已继续处理当前队列";
    // A manually triggered run can survive an application restart in the
    // persisted paused state. The in-memory trigger is then unavailable, but
    // a disabled recurring plan proves that resuming must restart the manual
    // queue rather than silently falling back to schedule evaluation.
    } else if (trigger === "manual" || !plan.enabled) void launchAutomationRun("manual");
    else await rescheduleAutomation(true);
    return automationStatusView();
  });
  app.post("/api/automation/recheck-and-continue", async (_request, reply) => {
    if (automationStatus.state !== "manual_action_required") {
      return automationStatusView();
    }
    const expectedControlEpoch = automationControlEpoch;
    const isCurrentManualAction = () => automationStatus.state === "manual_action_required"
      && automationControlEpoch === expectedControlEpoch;
    if (automationPromise) await automationPromise;
    if (!isCurrentManualAction()) return automationStatusView();
    const keepManualAction = (message: string) => {
      if (!isCurrentManualAction()) return automationStatusView();
      automationStatus.state = "manual_action_required";
      automationStatus.currentStep = message;
      return automationStatusView();
    };
    const failRecheck = (message: string, errorCode: string) => {
      if (!isCurrentManualAction()) return automationStatusView();
      audit("automation_manual_recheck_failed", "automation", "attention", errorCode);
      return keepManualAction(message);
    };
    let credentials: TmallCredentials | null;
    try {
      credentials = await readTmallCredentials();
    } catch {
      return failRecheck("登录信息重新检测失败，请稍后再次检测", "MANUAL_RECHECK_CREDENTIAL_READ_FAILED");
    }
    if (!isCurrentManualAction()) return automationStatusView();
    if (!credentials) return keepManualAction("请先在系统设置中保存淘宝商家登录信息，再重新检测");
    const releaseBrowserOperation = tryBeginTmallBrowserOperation();
    if (!releaseBrowserOperation) {
      return reply.code(409).send({
        error: "tmall_browser_operation_in_progress",
        detail: "正在检测，请稍候",
      });
    }
    let login: Awaited<ReturnType<typeof verifyTmallLogin>> | undefined;
    try {
      try {
        login = await verifyTmallLogin(credentials, "continue");
      } catch {
        return failRecheck("淘宝页面重新检测失败，请保持评价管理页面打开后再次检测", "MANUAL_RECHECK_LOGIN_CHECK_FAILED");
      }
      if (!isCurrentManualAction()) return automationStatusView();
      if (login.state !== "authenticated") {
        return keepManualAction(login.message ?? "淘宝仍需要人工处理，请在已打开的窗口完成验证后重新检测");
      }
    } finally {
      releaseBrowserOperation();
    }
    if (!isCurrentManualAction()) return automationStatusView();
    let missing: string[];
    try {
      missing = await runtimeMissingRequirements();
    } catch {
      return failRecheck("系统配置重新检测失败，请稍后再次检测", "MANUAL_RECHECK_PREFLIGHT_FAILED");
    }
    if (!isCurrentManualAction()) return automationStatusView();
    if (missing.length) {
      return keepManualAction(`仍需完成：${missing.join("、")}。完成后请重新检测`);
    }
    const trigger = manualActionTrigger ?? (automationRepository.getPlan().enabled ? "scheduled" : "manual");
    if (!isCurrentManualAction()) return automationStatusView();
    manualActionTrigger = null;
    try {
      if (trigger === "manual") {
        const launched = launchAutomationRun("manual");
        if (launched.launched) {
          await launched.startup;
        }
      }
      else await rescheduleAutomation(true, expectedControlEpoch);
    } catch {
      return failRecheck("自动回复重新启动失败，请稍后再次检测", "MANUAL_RECHECK_RESUME_FAILED");
    }
    return automationStatusView();
  });
  app.post("/api/automation/stop", async (_request, reply) => {
    try {
      auditedMutation("automation_plan_stopped", "automation_plan", () => automationRepository.disable());
      automationControlEpoch += 1;
      pausedTrigger = null;
      manualActionTrigger = null;
      clearAutomationTimer();
      tmallAuthDriver.setLaunchAllowed?.(false);
      if (automationPromise && (automationStatus.state !== "paused" || submissionInFlight)) {
        automationStatus.state = "stopping";
        automationStatus.currentStep = "正在完成当前评价，随后停止";
      } else {
        automationStatus.state = "disabled";
        automationStatus.currentStep = "已停止并关闭自动计划";
        automationStatus.nextRunAt = null;
      }
      return automationStatusView();
    } catch (error) {
      return sendAutomationMutationFailure(reply, error);
    }
  });

  const publicReplyErrorMessage = (message: string | null): string | null => {
    if (!message) return null;
    if (/Target page, context or browser has been closed|(?:locator|page|browser)\.[a-z]+:/iu.test(message)) {
      return "淘宝页面连接曾中断，本条已停止提交，可在下一轮重新读取";
    }
    return message;
  };
  const replyOperatorView = (record: NonNullable<ReturnType<ReplyRepository["get"]>>) => {
    const complaint = complaintRepository.findBySource("primary", record.sourceKey);
    return {
      ...record,
      errorMessage: publicReplyErrorMessage(record.errorMessage),
      complaintErrorKind: complaint?.state === "failed" ? complaint.errorCode : null,
    };
  };

  app.get("/api/dashboard", async () => {
    const replyRecords = replyRepository.list();
    const currentScope = resolvePersistedReviewScope().resolved;
    const manualProductStats = manualProductRepository.stats();
    const latestRun = automationRepository.getLastRun();
    const toPublicReply = (record: typeof replyRecords[number]) => ({
      id: record.id,
      review: record.review,
      product: record.product,
      itemId: record.itemId,
      reviewedAt: record.reviewedAt,
      reviewPhase: record.reviewPhase,
      sentimentLabel: record.sentimentLabel,
      library: record.library,
      primaryCategory: record.primaryCategory,
      category: record.category,
      finalReply: record.finalReply,
      productAdjusted: record.productAdjusted,
      attentionReasons: record.attentionReasons,
      state: record.state,
      errorCode: record.errorCode,
      discoveredAt: record.discoveredAt,
      processedAt: record.processedAt,
      updatedAt: record.updatedAt,
    });
    const readyCount = replyRecords.filter((record) => record.state === "read_only_ready" || record.state === "needs_attention").length;
    const sources = (["good", "bad"] as const).map(sourceView);
    const appId = settingsRepository.get<string>("feishu_app_id") ?? "";
    const secretConfigured = await secretStore.has(FEISHU_SECRET_KEY);
    const deepseekConfigured = await secretStore.has(DEEPSEEK_SECRET_KEY);
    const tmallConfigured = await secretStore.has(TMALL_CREDENTIAL_KEY);
    const feishuHealth = sources.every((source) => source.health.state === "ready")
      ? "ready"
      : sources.some((source) => source.health.state === "usable_with_warning")
        ? "degraded"
        : appId && secretConfigured
          ? "configured"
          : "not_configured";
    const preflight = await automationPreflight();
    return {
      metrics: { todayRead: replyRecords.length, good: replyRecords.filter((item) => item.library === "good").length, bad: replyRecords.filter((item) => item.library === "bad").length, generated: readyCount, sent: replyRecords.filter((item) => item.state === "sent").length, failed: replyRecords.filter((item) => item.state === "failed").length, productEdits: replyRecords.filter((item) => item.productAdjusted).length },
      health: {
        tmall: state.auth.state === "authenticated" ? "authenticated" : tmallConfigured ? "configured" : "not_configured",
        feishu: feishuHealth,
        deepseek: preflight.checks.find((item) => item.key === "deepseek")?.ready ? "ready" : deepseekConfigured ? "configured" : "not_configured",
        locators: preflight.checks.find((item) => item.key === "elements")?.ready ? "healthy" : "degraded",
      },
      templates: sources.map((source) => ({
        ...source.health,
      })),
      reviewScope: toPublicReviewScope(currentScope),
      manualProducts: {
        total: manualProductStats.total,
        diverted: replyRepository.manualDiversionCount(),
      },
      latestRun: latestRun ? {
        trigger: latestRun.trigger,
        state: latestRun.state,
        processed: latestRun.processed,
        succeeded: latestRun.succeeded,
        manual: latestRun.manual,
        failed: latestRun.failed,
        stopReason: latestRun.stopReason,
        startedAt: latestRun.startedAt,
        finishedAt: latestRun.finishedAt,
        scope: latestRun.scope ? toPublicReviewScope(latestRun.scope) : null,
      } : null,
      queue: replyRecords.slice(0, 10).map(toPublicReply),
      recent: replyRecords[0] ? toPublicReply(replyRecords[0]) : null,
      readiness: {
        ready: preflight.ready,
        missing: preflight.missing,
      },
    };
  });

  app.get<{ Querystring: { page?: unknown; pageSize?: unknown; query?: unknown; filter?: unknown } }>("/api/replies", async (request, reply) => {
    const pageValue = singleQueryString(request.query.page);
    const pageSizeValue = singleQueryString(request.query.pageSize);
    const query = singleQueryString(request.query.query);
    const filterValue = singleQueryString(request.query.filter);
    const page = pageValue === undefined ? 1 : parsePositiveInteger(pageValue);
    const pageSize = pageSizeValue === undefined ? 50 : parsePositiveInteger(pageSizeValue);
    const filter = filterValue ?? "all";
    const filters = new Set<ReplyListFilter>(["all", "sent", "unsent", "good", "bad", "attention"]);
    if (
      pageValue === null || pageSizeValue === null || query === null || filterValue === null
      || page === null || pageSize === null || pageSize > 100 || (query?.length ?? 0) > 200
      || !filters.has(filter as ReplyListFilter)
    ) {
      return reply.code(400).send({ error: "invalid_reply_query", detail: "请检查搜索内容、筛选条件和分页设置" });
    }
    const result = replyRepository.listPage({
      page,
      pageSize,
      query: query ?? "",
      filter: filter as ReplyListFilter,
    });
    return { ...result, items: result.items.map(replyOperatorView) };
  });
  app.get<{ Params: { id: string } }>("/api/replies/:id", async (request, reply) => {
    const record = replyRepository.get(request.params.id);
    return record ? replyOperatorView(record) : reply.code(404).send({ error: "reply_not_found" });
  });
  app.delete<{ Params: { id: string } }>("/api/replies/:id", async (request, reply) => {
    if (automationPromise || automationStatus.state === "running" || automationStatus.state === "stopping") {
      return reply.code(409).send({ error: "automation_running", detail: "请先等待当前自动处理结束，再删除这条记录" });
    }
    try {
      const result = operatorRecordCleanup.removeReply(request.params.id);
      audit("reply_record_deleted", result.sourceKey, result.mode);
      return { removed: true, mode: result.mode, reprocessable: result.mode === "reprocess" };
    } catch (error) {
      if (error instanceof OperatorRecordCleanupNotFoundError) return reply.code(404).send({ error: "reply_not_found" });
      if (error instanceof OperatorRecordCleanupConflictError) {
        return reply.code(409).send({ error: error.code, detail: error.message });
      }
      throw error;
    }
  });

  // Complaint creation, type selection and platform submission remain available
  // only through the automation's scoped complaint executor. Operators may remove
  // local history through the guarded DELETE endpoint below; it never submits a complaint.
  // A complaint decision is made for every review before its reply is generated.
  // The merchant-facing complaint page must therefore omit ordinary "no complaint"
  // decisions: they are retained for auditing, but are not complaint records.
  // A technical/legacy hold without an official complaint type is not a
  // complaint case. Keeping it out of this list prevents ordinary reviews
  // from inflating the merchant-facing complaint count.
  const isVisibleComplaint = (record: ComplaintCaseRecord) => record.complaintType !== null || [
    "submitting", "submitted", "under_review", "upheld", "rejected", "closed", "submission_uncertain",
  ].includes(record.state);
  const toComplaintOperatorView = (record: ComplaintCaseRecord) => {
    const draft = replyRepository.getBySourceKey(record.sourceKey);
    return {
      id: record.id,
      state: record.state,
      complaintType: record.complaintType,
      quote: record.quote,
      confidence: record.confidence,
      reason: record.reason,
      description: record.description,
      factDescription: record.factDescription,
      phase: record.phase,
      errorCode: record.errorCode,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      review: draft?.review ?? null,
      product: draft?.product ?? null,
      reviewedAt: draft?.reviewedAt ?? null,
    };
  };
  app.get("/api/complaints", async () => {
    const items = complaintRepository.list().filter(isVisibleComplaint).map(toComplaintOperatorView);
    return { items, total: items.length };
  });
  app.get("/api/complaints/status-summary", async () => {
    const visible = complaintRepository.list().filter(isVisibleComplaint);
    const count = (states: readonly ComplaintCaseRecord["state"][]) => visible.filter((record) => states.includes(record.state)).length;
    return {
      total: visible.length,
      // These counts feed the merchant-facing complaint page. Ordinary
      // no-complaint decisions and technical holds stay in audit data, but
      // must not be presented as platform-complaint work.
      noComplaint: 0,
      prepared: count(["prepared"]),
      submitted: count(["submitted", "under_review", "upheld", "rejected", "closed"]),
      upheld: count(["upheld"]),
      rejected: count(["rejected"]),
      manualActionRequired: count(["manual_action_required"]),
      unresolved: count(["discovered", "analyzing", "prepared", "submitting", "submission_uncertain", "retry_wait", "manual_action_required", "failed"]),
    };
  });
  app.get<{ Params: { id: string } }>("/api/complaints/:id", async (request, reply) => {
    const record = complaintRepository.get(request.params.id);
    if (!record || !isVisibleComplaint(record)) return reply.code(404).send({ error: "complaint_not_found" });
    return toComplaintOperatorView(record);
  });
  app.delete<{ Params: { id: string } }>("/api/complaints/:id", async (request, reply) => {
    if (automationPromise || automationStatus.state === "running" || automationStatus.state === "stopping") {
      return reply.code(409).send({ error: "automation_running", detail: "请先等待当前自动处理结束，再删除这条投诉记录" });
    }
    try {
      const result = operatorRecordCleanup.removeComplaint(request.params.id);
      audit("complaint_record_deleted", result.sourceKey, result.mode);
      return { removed: true, mode: result.mode, reprocessable: result.mode === "reprocess" };
    } catch (error) {
      if (error instanceof OperatorRecordCleanupNotFoundError) return reply.code(404).send({ error: "complaint_not_found" });
      if (error instanceof OperatorRecordCleanupConflictError) {
        return reply.code(409).send({ error: error.code, detail: error.message });
      }
      throw error;
    }
  });
  app.post<{ Params: { id: string }; Body: { outcome?: "sent" | "not_sent" } }>("/api/replies/:id/resolve-uncertain", async (request, reply) => {
    if (automationPromise) return reply.code(409).send({ error: "automation_running", detail: "请先暂停自动回复，再核对提交结果" });
    if (request.body?.outcome !== "sent" && request.body?.outcome !== "not_sent") return reply.code(400).send({ error: "invalid_resolution", detail: "请选择平台已回复或平台未回复" });
    const resolved = replyAttemptRepository.resolveUncertainByDraftId(request.params.id, request.body.outcome);
    if (!resolved) return reply.code(409).send({ error: "uncertain_submission_not_found", detail: "该记录当前不需要人工核对" });
    audit("uncertain_submission_resolved", request.params.id, request.body.outcome);
    const record = replyRepository.get(request.params.id);
    return record ? replyOperatorView(record) : reply.code(404).send({ error: "reply_not_found" });
  });

  app.post<{ Params: { id: string } }>("/api/replies/:id/reprocess", async (request, reply) => {
    if (automationPromise) {
      return reply.code(409).send({ error: "automation_running", detail: "当前评价尚未处理结束，请等待本轮停止后再重新生成" });
    }
    if (automationStatus.state === "running" || automationStatus.state === "stopping") {
      return reply.code(409).send({ error: "pause_runtime_before_reprocess", detail: "请先暂停自动回复，再重新生成这条回复" });
    }
    const current = replyRepository.get(request.params.id);
    if (!current) return reply.code(404).send({ error: "reply_not_found" });
    if (["sent", "submitting", "submission_uncertain"].includes(current.state)) {
      return reply.code(409).send({ error: "reply_already_submitted", detail: "该回复已经进入提交流程，不能重新生成" });
    }
    const deepseek = await getDeepSeekClient();
    const manualProductPolicy = new ManualProductPolicyService({
      products: manualProductRepository,
      replies: replyRepository,
      ai: deepseek,
    });
    const processor = new DraftProcessor({
      replies: replyRepository,
      templates: templateRepository,
      ai: deepseek,
      manualProductPolicy,
      complaintPolicy: complaintReviewPolicyFor(deepseek),
    });
    await processor.reprocess(request.params.id);
    const record = replyRepository.get(request.params.id);
    return record ? replyOperatorView(record) : reply.code(404).send({ error: "reply_not_found" });
  });

  app.get("/api/template-sources", async () => ({
    items: (["good", "bad"] as const).map(sourceView),
  }));

  app.get("/api/template-sources/health", async () => ({
    items: (["good", "bad"] as const).map(templateHealthView),
  }));

  app.put<{ Body: { library?: string; url?: string } }>("/api/template-sources", async (request, reply) => {
    const body = request.body ?? {};
    if (Object.keys(body).some((key) => key !== "library" && key !== "url")) {
      return reply.code(400).send({ error: "only_library_and_url_are_allowed" });
    }
    const library = asLibrary(body.library ?? "");
    if (!library || typeof body.url !== "string") {
      return reply.code(400).send({ error: "invalid_template_source" });
    }
    try {
      const location = parseFeishuBaseUrl(body.url.trim());
      templateRepository.saveSource({ library, url: body.url.trim(), ...location });
      audit("template_source_saved", library, "success");
      return sourceView(library);
    } catch (error) {
      return reply.code(400).send({ error: "invalid_template_source", detail: safeErrorMessage(error) });
    }
  });

  app.post<{ Params: { library: string } }>(
    "/api/template-sources/:library/test",
    async (request, reply) => {
      const library = asLibrary(request.params.library);
      if (!library) return reply.code(404).send({ error: "invalid_library" });
      try {
        const service = new TemplateSyncService({ repository: templateRepository, client: await getFeishuClient() });
        const result = await service.test(library);
        templateRepository.recordTestResult(library, true);
        return result;
      } catch (error) {
        const detail = safeErrorMessage(error);
        templateRepository.recordTestResult(library, false, "TEMPLATE_TEST_FAILED", detail);
        return reply.code(422).send({ error: "template_test_failed", detail });
      }
    },
  );

  app.post<{ Params: { library: string } }>(
    "/api/template-sources/:library/sync",
    async (request, reply) => {
      const library = asLibrary(request.params.library);
      if (!library) return reply.code(404).send({ error: "invalid_library" });
      try {
        const service = new TemplateSyncService({ repository: templateRepository, client: await getFeishuClient() });
        return await service.sync(library);
      } catch (error) {
        return reply.code(422).send({ error: "template_sync_failed", detail: safeErrorMessage(error) });
      }
    },
  );

  app.get<{ Params: { library: string } }>(
    "/api/template-sources/:library/categories",
    async (request, reply) => {
      const library = asLibrary(request.params.library);
      if (!library) return reply.code(404).send({ error: "invalid_library" });
      return { items: templateRepository.getActiveCategories(library) };
    },
  );

  app.post<{ Params: { adapter: string } }>("/api/connections/:adapter/test", async (request, reply) => {
    if (request.params.adapter === "deepseek") {
      try {
        const result = await (await getDeepSeekClient()).testConnection();
        const deepseekModelsReady = result.checks
          ? result.checks.pro.status === "ready"
          : result.models.includes("deepseek-v4-pro");
        if (!deepseekModelsReady) {
          audit("connection_test", "deepseek", "failed", "DEEPSEEK_MODEL_VERIFICATION_FAILED");
          return {
            adapter: "deepseek",
            status: "error",
            error: "deepseek_model_verification_failed",
            ...result,
          };
        }
        const apiKey = await secretStore.read(DEEPSEEK_SECRET_KEY);
        const baseUrl = settingsRepository.get<string>("deepseek_base_url") ?? DEEPSEEK_BASE_URL;
        if (apiKey) settingsRepository.set("deepseek_verified_fingerprint", createHash("sha256").update(`${baseUrl}\0${apiKey}`, "utf8").digest("hex"));
        settingsRepository.set("deepseek_last_tested_at", clockNow().toISOString());
        settingsRepository.set("deepseek_last_latency_ms", result.latencyMs);
        const reopenedAiRetries = replyRepository.reopenAiRetryCircuitsAfterHealthCheck(clockNow());
        audit("connection_test", "deepseek", "success", reopenedAiRetries > 0 ? "AI_RETRY_CIRCUIT_REOPENED" : undefined);
        return { adapter: "deepseek", status: "ready", ...result };
      } catch (error) {
        audit("connection_test", "deepseek", "failed", "DEEPSEEK_CONNECTION_FAILED");
        return reply.code(422).send({ adapter: "deepseek", status: "error", error: "deepseek_connection_failed", detail: safeErrorMessage(error) });
      }
    }
    if (request.params.adapter !== "feishu") {
      return reply.code(404).send({ error: "unknown_connection" });
    }
    try {
      const client = await getFeishuClient();
      await client.testConnection();
      audit("connection_test", "feishu", "success");
      return { adapter: "feishu", status: "ready", message: "飞书凭据有效" };
    } catch (error) {
      audit("connection_test", "feishu", "failed", "FEISHU_CONNECTION_FAILED");
      return reply.code(422).send({
        adapter: "feishu",
        status: "error",
        error: "feishu_connection_failed",
        detail: safeErrorMessage(error),
      });
    }
  });

  app.get("/api/settings", async () => ({
    pollingIntervalSeconds: settingsRepository.get<number>("polling_interval_seconds") ?? 30,
    batchSize: settingsRepository.get<number>("batch_size") ?? 20,
    retryCount: settingsRepository.get<number>("retry_count") ?? 1,
    deepseekBaseUrl: settingsRepository.get<string>("deepseek_base_url") ?? DEEPSEEK_BASE_URL,
    dailyModel: "deepseek-v4-pro",
    repairModel: "deepseek-v4-pro",
    businessDataLimitBytes: 2 * 1024 * 1024 * 1024,
    feishuAppId: settingsRepository.get<string>("feishu_app_id") ?? "",
    feishuAppSecretConfigured: await secretStore.has(FEISHU_SECRET_KEY),
    deepseekApiKeyConfigured: await secretStore.has(DEEPSEEK_SECRET_KEY),
    deepseekLastTestedAt: settingsRepository.get<string>("deepseek_last_tested_at") ?? null,
    deepseekLastLatencyMs: settingsRepository.get<number>("deepseek_last_latency_ms") ?? null,
    complaintAutoSubmit: settingsRepository.get<boolean>("complaint_auto_submit") === true,
    adapters: {
      playwright: await secretStore.has(TMALL_CREDENTIAL_KEY) ? "configured" : "not_configured",
      feishu:
        settingsRepository.get<string>("feishu_app_id") && (await secretStore.has(FEISHU_SECRET_KEY))
          ? "configured"
          : "not_configured",
      deepseek: await secretStore.has(DEEPSEEK_SECRET_KEY) ? "configured" : "not_configured",
    },
  }));

  app.put<{ Body: { feishuAppId?: string; deepseekBaseUrl?: string; complaintAutoSubmit?: unknown } }>("/api/settings", async (request, reply) => {
    const body = request.body ?? {};
    if (Object.keys(body).some((key) => !["feishuAppId", "deepseekBaseUrl", "complaintAutoSubmit"].includes(key))) {
      return reply.code(400).send({ error: "invalid_settings" });
    }
    if (body.complaintAutoSubmit !== undefined && automationPromise) {
      return reply.code(409).send({ error: "complaint_auto_submit_change_requires_idle_automation" });
    }
    if (typeof body.feishuAppId === "string") {
      const appId = body.feishuAppId.trim();
      if (appId.length > 200 || /[\x00-\x1f]/u.test(appId)) return reply.code(400).send({ error: "invalid_feishu_app_id" });
      settingsRepository.set("feishu_app_id", appId);
      cachedClient = null;
    }
    if (typeof body.deepseekBaseUrl === "string") {
      const value = body.deepseekBaseUrl.trim();
      if (value !== DEEPSEEK_BASE_URL) return reply.code(400).send({ error: "invalid_deepseek_base_url" });
      settingsRepository.set("deepseek_base_url", value);
      cachedDeepSeekClient = null;
    }
    if (body.complaintAutoSubmit !== undefined) {
      if (typeof body.complaintAutoSubmit !== "boolean") return reply.code(400).send({ error: "invalid_complaint_auto_submit" });
      settingsRepository.set("complaint_auto_submit", body.complaintAutoSubmit);
    }
    audit("settings_updated", "connections", "success");
    return {
      feishuAppId: settingsRepository.get<string>("feishu_app_id") ?? "",
      feishuAppSecretConfigured: await secretStore.has(FEISHU_SECRET_KEY),
      deepseekBaseUrl: settingsRepository.get<string>("deepseek_base_url") ?? DEEPSEEK_BASE_URL,
      deepseekApiKeyConfigured: await secretStore.has(DEEPSEEK_SECRET_KEY),
      complaintAutoSubmit: settingsRepository.get<boolean>("complaint_auto_submit") === true,
    };
  });

  app.post<{ Body: { action?: SecretConfirmationAction } }>(
    "/api/secrets/feishu_app_secret/prepare",
    async (request, reply) => {
      const action = request.body?.action;
      if (action !== "replace" && action !== "delete") {
        return reply.code(400).send({ error: "invalid_secret_action" });
      }
      return nonceService.prepare({ sessionId: options.sessionToken, action });
    },
  );

  app.put<{ Body: { nonce?: string; secret?: string } }>(
    "/api/secrets/feishu_app_secret",
    async (request, reply) => {
      if (!consumeNonce(reply, { nonce: request.body?.nonce, action: "replace" })) return;
      const secret = request.body?.secret;
      if (typeof secret !== "string" || !secret || secret.length > 2048) {
        return reply.code(400).send({ error: "invalid_secret" });
      }
      try {
        await secretStore.write(FEISHU_SECRET_KEY, secret);
        cachedClient = null;
        audit("secret_replaced", "feishu_app_secret", "success");
        return { configured: true };
      } catch {
        audit("secret_replaced", "feishu_app_secret", "failed", "SECRET_STORE_FAILED");
        return reply.code(500).send({ error: "secret_store_failed" });
      }
    },
  );

  app.delete<{ Body: { nonce?: string } }>("/api/secrets/feishu_app_secret", async (request, reply) => {
    if (!consumeNonce(reply, { nonce: request.body?.nonce, action: "delete" })) return;
    try {
      await secretStore.delete(FEISHU_SECRET_KEY);
      cachedClient = null;
      audit("secret_deleted", "feishu_app_secret", "success");
      return { configured: false };
    } catch {
      audit("secret_deleted", "feishu_app_secret", "failed", "SECRET_DELETE_FAILED");
      return reply.code(500).send({ error: "secret_delete_failed" });
    }
  });

  app.post<{ Body: { action?: SecretConfirmationAction } }>(
    "/api/secrets/deepseek_api_key/prepare",
    async (request, reply) => {
      const action = request.body?.action;
      if (action !== "replace" && action !== "delete") return reply.code(400).send({ error: "invalid_secret_action" });
      return nonceService.prepare({ sessionId: options.sessionToken, action });
    },
  );

  app.put<{ Body: { nonce?: string; secret?: string } }>("/api/secrets/deepseek_api_key", async (request, reply) => {
    if (!consumeNonce(reply, { nonce: request.body?.nonce, action: "replace" })) return;
    const secret = request.body?.secret;
    if (typeof secret !== "string" || !secret.trim() || secret.length > 2048) return reply.code(400).send({ error: "invalid_secret" });
    try {
      await secretStore.write(DEEPSEEK_SECRET_KEY, secret.trim());
      settingsRepository.set("deepseek_verified_fingerprint", "");
      settingsRepository.set("deepseek_last_tested_at", "");
      cachedDeepSeekClient = null;
      audit("secret_replaced", "deepseek_api_key", "success");
      return { configured: true };
    } catch {
      audit("secret_replaced", "deepseek_api_key", "failed", "SECRET_STORE_FAILED");
      return reply.code(500).send({ error: "secret_store_failed" });
    }
  });

  app.delete<{ Body: { nonce?: string } }>("/api/secrets/deepseek_api_key", async (request, reply) => {
    if (!consumeNonce(reply, { nonce: request.body?.nonce, action: "delete" })) return;
    await secretStore.delete(DEEPSEEK_SECRET_KEY);
    settingsRepository.set("deepseek_verified_fingerprint", "");
    settingsRepository.set("deepseek_last_tested_at", "");
    cachedDeepSeekClient = null;
    audit("secret_deleted", "deepseek_api_key", "success");
    return { configured: false };
  });

  app.post<{ Body: { action?: SecretConfirmationAction } }>(
    "/api/tmall-auth/credentials/prepare",
    async (request, reply) => {
      const action = request.body?.action;
      if (action !== "replace" && action !== "delete") return reply.code(400).send({ error: "invalid_secret_action" });
      return nonceService.prepare({ sessionId: options.sessionToken, action });
    },
  );

  app.put<{ Body: { nonce?: string; account?: string; password?: string } }>("/api/tmall-auth/credentials", async (request, reply) => {
    if (!consumeNonce(reply, { nonce: request.body?.nonce, action: "replace" })) return;
    const account = request.body?.account?.trim() ?? "";
    const password = request.body?.password ?? "";
    if (!account || !password || account.length > 200 || password.length > 500 || /[\x00-\x1f]/u.test(account)) {
      return reply.code(400).send({ error: "invalid_tmall_credentials" });
    }
    await secretStore.write(TMALL_CREDENTIAL_KEY, JSON.stringify({ account, password } satisfies TmallCredentials));
    clearPersistedTmallVerification();
    const maskedAccount = maskAccount(account);
    settingsRepository.set("tmall_masked_account", maskedAccount);
    state.auth = { ...state.auth, state: "session_expired", configured: true, maskedAccount, lastFailure: null };
    audit("secret_replaced", "taobao_seller", "success");
    return { configured: true, maskedAccount };
  });

  app.delete<{ Body: { nonce?: string } }>("/api/tmall-auth/credentials", async (request, reply) => {
    if (!consumeNonce(reply, { nonce: request.body?.nonce, action: "delete" })) return;
    await secretStore.delete(TMALL_CREDENTIAL_KEY);
    clearPersistedTmallVerification();
    await tmallAuthDriver.clearProfile();
    settingsRepository.set("tmall_masked_account", "");
    state.auth = { ...state.auth, state: "not_configured", configured: false, maskedAccount: null, storeName: null };
    audit("tmall_login_data_cleared", "taobao_seller", "success");
    return { configured: false };
  });

  const elementHealthView = () => ({
    items: locatorRepository.list().map((item) => {
      const needsAttention = item.health === "attention";
      const conditional = !needsAttention && !item.lastSuccessAt;
      return {
        ...item,
        verificationState: needsAttention ? "attention" as const : conditional ? "conditional" as const : "verified" as const,
        statusLabel: needsAttention ? "需要处理" : conditional ? "运行时自动检测" : item.health === "recovered" ? "已自动恢复" : "正常",
      };
    }),
  });
  const locatorRepairsView = () => {
    const items = locatorRepository.listRepairs();
    return { items, total: items.length };
  };
  app.get("/api/element-health", async () => elementHealthView());
  app.get("/api/locator-repairs", async () => locatorRepairsView());
  app.post<{ Params: { id: string } }>("/api/locator-repairs/:id/approve", async (request, reply) => {
    if (automationPromise) return reply.code(409).send({ error: "automation_running", detail: "当前评价尚未处理结束，请等待本轮停止后再调整页面元素" });
    const record = locatorRepository.approveRepair(request.params.id);
    return record ?? reply.code(404).send({ error: "locator_repair_not_found", detail: "待确认的元素修复记录不存在" });
  });
  app.post<{ Params: { id: string } }>("/api/locator-repairs/:id/reject", async (request, reply) => {
    if (automationPromise) return reply.code(409).send({ error: "automation_running", detail: "当前评价尚未处理结束，请等待本轮停止后再调整页面元素" });
    const record = locatorRepository.rejectRepair(request.params.id);
    return record ?? reply.code(404).send({ error: "locator_repair_not_found", detail: "待确认的元素修复记录不存在" });
  });
  app.post<{ Params: { id: string } }>("/api/locator-repairs/:id/rollback", async (request, reply) => {
    if (automationPromise) return reply.code(409).send({ error: "automation_running", detail: "当前评价尚未处理结束，请等待本轮停止后再调整页面元素" });
    const record = locatorRepository.rollbackRepair(request.params.id);
    return record ?? reply.code(404).send({ error: "locator_repair_not_found", detail: "没有可回滚的元素版本" });
  });
  app.get("/api/locators", async () => elementHealthView());
  app.get("/api/repairs", async () => locatorRepairsView());
  async function storageView() {
    const count = (table: string): number => Number((database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number }).value);
    const complaintCounts = complaintRepository.storageCounts();
    return {
      usedBytes: Number(database.pragma("page_count", { simple: true })) * Number(database.pragma("page_size", { simple: true })),
      limitBytes: 2 * 1024 * 1024 * 1024,
      browserProfileBytes: await tmallAuthDriver.profileSizeBytes?.() ?? 0,
      nextCleanupAt: settingsRepository.get<string>("next_cleanup_at") ?? null,
      lastCleanupAt: settingsRepository.get<string>("last_cleanup_at") ?? null,
      counts: {
        reviews: count("reply_drafts"),
        submissionAudit: count("reply_attempts"),
        manualProducts: count("manual_products"),
        manualHolds: replyRepository.countByStates(["manual_product_hold"]),
        actionTombstones: count("review_action_tombstones"),
        complaintCases: complaintCounts.cases,
        complaintAttempts: complaintCounts.attempts,
        complaintEvents: complaintCounts.events,
        complaintUnresolved: complaintCounts.unresolved,
        locatorRepairs: count("locator_repairs"),
        locatorSnapshots: count("locator_snapshots"),
        runs: count("automation_runs"),
        templateVersions: count("template_versions"),
      },
      policies: RETENTION_POLICIES,
    };
  }
  app.get("/api/storage", async () => storageView());
  app.post("/api/storage/factory-reset/prepare", async () => nonceService.prepare({ sessionId: options.sessionToken, action: "factory_reset" }));
  app.post<{ Body: { nonce?: string } }>("/api/storage/factory-reset", async (request, reply) => {
    if (!consumeNonce(reply, { nonce: request.body?.nonce, action: "factory_reset" })) return;
    if (automationPromise) return reply.code(409).send({ error: "automation_running", detail: "请先停止自动回复，再恢复出厂设置" });
    try {
      clearAutomationTimer();
      await localXlsxPicker.cancel?.();
      importPreviewStore.dispose();
      await Promise.all([
        secretStore.delete(TMALL_CREDENTIAL_KEY),
        secretStore.delete(DEEPSEEK_SECRET_KEY),
        secretStore.delete(FEISHU_SECRET_KEY),
        tmallAuthDriver.clearProfile(),
      ]);
      database.transaction(() => {
        database.prepare("DELETE FROM complaint_events").run();
        database.prepare("DELETE FROM complaint_attempts").run();
        database.prepare("DELETE FROM complaint_cases").run();
        database.prepare("DELETE FROM reply_attempts").run();
        database.prepare("DELETE FROM reply_drafts").run();
        database.prepare("DELETE FROM review_action_locks").run();
        database.prepare("DELETE FROM review_action_tombstones").run();
        database.prepare("DELETE FROM manual_product_memberships").run();
        database.prepare("DELETE FROM manual_products").run();
        database.prepare("UPDATE manual_product_catalog_state SET revision = 1, last_import_at = NULL, updated_at = ? WHERE id = 1").run(clockNow().toISOString());
        database.prepare(`
          UPDATE review_scope
          SET preset = 'last7', custom_start_date = NULL, custom_end_date = NULL,
            timezone = 'Asia/Shanghai', revision = 1, updated_at = ?
          WHERE id = 1
        `).run(clockNow().toISOString());
        database.prepare("DELETE FROM locator_repairs").run();
        database.prepare("DELETE FROM locator_versions").run();
        database.prepare("DELETE FROM locator_rules").run();
        database.prepare("DELETE FROM automation_runs").run();
        database.prepare("DELETE FROM schedule_windows").run();
        database.prepare("DELETE FROM automation_plan").run();
        database.prepare("UPDATE template_sources SET active_version_id = NULL").run();
        database.prepare("DELETE FROM template_replies").run();
        database.prepare("DELETE FROM template_categories").run();
        database.prepare("DELETE FROM template_versions").run();
        database.prepare("DELETE FROM template_sources").run();
        database.prepare("DELETE FROM operation_audit").run();
        database.prepare("DELETE FROM settings").run();
      })();
      locatorRepository.ensureDefaults();
      cachedClient = null;
      cachedDeepSeekClient = null;
      Object.assign(state, createInitialState());
      state.services = { importPreviewStore, manualProductImportService };
      automationStatus = {
        state: "disabled", trigger: null, currentWindow: null, nextRunAt: null, currentStep: "自动计划未启用",
        startedAt: null, runId: null, processed: 0, succeeded: 0, manual: 0, failed: 0, reviewScope: null, currentReview: null, currentReply: null,
      };
      runLifecycleCleanup();
      return { reset: true, storage: await storageView() };
    } catch {
      return reply.code(500).send({ error: "factory_reset_failed", detail: "恢复出厂设置失败，请关闭程序后重试" });
    }
  });
  app.delete<{ Params: { segment: string }; Querystring: { scope?: unknown } }>("/api/storage/:segment", async (request, reply) => {
    if (automationPromise || automationStatus.state === "running" || automationStatus.state === "stopping") {
      return reply.code(409).send({ error: "automation_running", detail: "请先停止自动回复，再清理数据" });
    }
    let deleted = 0;
    let cleanupScope: "sent" | "unsent" | "legacy" | undefined;
    if (request.params.segment === "reviews") {
      const scope = singleQueryString(request.query.scope);
      if (scope === null || (scope !== undefined && scope !== "sent" && scope !== "unsent")) {
        return reply.code(400).send({ error: "invalid_review_cleanup_scope", detail: "请选择有效的回复记录清理范围" });
      }
      if (scope === "sent" || scope === "unsent") {
        deleted = operatorRecordCleanup.removeReplyRecords(scope);
        cleanupScope = scope;
      } else {
        deleted = database.prepare(`DELETE FROM reply_drafts WHERE state NOT IN ('discovered', 'classifying', 'template_selected', 'rewriting', 'submitting', 'submission_uncertain')`).run().changes;
        cleanupScope = "legacy";
      }
    } else if (request.params.segment === "locator-history") {
      deleted = database.transaction(() => {
        const repairs = database.prepare("DELETE FROM locator_repairs WHERE status != 'pending_approval'").run().changes;
        const snapshots = database.prepare("DELETE FROM locator_snapshots").run().changes;
        return repairs + snapshots;
      })();
    } else if (request.params.segment === "run-history") {
      deleted = database.prepare("DELETE FROM automation_runs WHERE state != 'running' AND finished_at IS NOT NULL").run().changes;
    } else {
      return reply.code(404).send({ error: "storage_segment_not_found", detail: "没有可清理的数据类型" });
    }
    audit("manual_cleanup", request.params.segment, "success");
    return { deleted, ...(cleanupScope ? { scope: cleanupScope } : {}), storage: await storageView() };
  });
  app.get("/api/tmall-auth/status", async (_request, reply) => {
    try {
      const configured = await secretStore.has(TMALL_CREDENTIAL_KEY);
      const preflight = await automationPreflight();
      const verified = preflight.checks.find((item) => item.key === "tmall")?.ready === true;
      return {
        ...state.auth,
        state: verified ? "authenticated" : state.auth.state === "not_configured" && configured ? "configured" : state.auth.state,
        configured,
        autoReloginEnabled: configured,
        maskedAccount: state.auth.maskedAccount ?? settingsRepository.get<string>("tmall_masked_account") ?? null,
        storeName: state.auth.storeName ?? settingsRepository.get<string>("tmall_verified_store_name") ?? null,
        lastLoginAt: state.auth.lastLoginAt ?? settingsRepository.get<string>("tmall_verified_at") ?? null,
      };
    } catch (error) {
      if (error instanceof TmallCredentialReadError) {
        return reply.code(503).send({
          error: "tmall_credentials_temporarily_unavailable",
          detail: "读取已保存的淘宝登录信息失败，请重新点击验证",
        });
      }
      throw error;
    }
  });
  app.get("/api/tmall-auth/popup-diagnostics", async (_request, reply) => {
    if (!tmallAuthDriver.diagnoseKnownPopups) {
      return reply.code(501).send({ error: "popup_diagnostics_unavailable", detail: "当前浏览器不支持弹窗检查" });
    }
    const releaseBrowserOperation = tryBeginTmallBrowserOperation();
    if (!releaseBrowserOperation) {
      return reply.code(409).send({ error: "tmall_browser_operation_in_progress", detail: "正在检测，请稍候" });
    }
    try {
      return await tmallAuthDriver.diagnoseKnownPopups();
    } finally {
      releaseBrowserOperation();
    }
  });

  async function executeTmallAuthenticationAction(
    mode: "open" | "continue",
    reply: FastifyReply,
  ): Promise<unknown> {
    if (automationPromise) return reply.code(409).send({ error: "pause_runtime_before_authentication", detail: "请先停止并等待当前评价处理结束，再验证淘宝登录" });
    if (tmallAuthenticationInFlight) return reply.code(409).send({ error: "tmall_authentication_in_progress", detail: "淘宝窗口正在检测，请等待当前操作完成" });
    const releaseBrowserOperation = tryBeginTmallBrowserOperation();
    if (!releaseBrowserOperation) {
      return reply.code(409).send({
        error: "tmall_browser_operation_in_progress",
        detail: "正在检测，请稍候",
      });
    }
    tmallAuthenticationInFlight = true;
    try {
      const credentials = await readTmallCredentials();
      if (!credentials && mode === "open") return reply.code(409).send({ error: "tmall_credentials_not_configured", detail: "请先保存淘宝商家账号和密码" });
      const result = await verifyTmallLogin(
        credentials,
        mode,
        Date.now() + tmallBrowserOperationDeadlineMs,
      );
      const now = clockNow().toISOString();
      const publicState = result.state === "authenticated"
        ? "authenticated"
        : result.state === "manual_verification_required"
          ? "manual_verification_required"
          : result.state === "credential_rejected"
            ? "credential_rejected"
            : result.state === "not_ready"
              ? "not_ready"
              : result.state === "identity_mismatch"
                ? "identity_mismatch"
                : result.state === "onboarding_or_safe_guide" || result.state === "manual_action_required"
                  ? "manual_action_required"
                  : "navigation_failed";
      state.auth = {
        ...state.auth,
        state: publicState,
        configured: credentials !== null,
        maskedAccount: credentials ? maskAccount(credentials.account) : state.auth.maskedAccount ?? settingsRepository.get<string>("tmall_masked_account") ?? null,
        storeName: result.storeName ?? state.auth.storeName,
        lastLoginAt: result.state === "authenticated" ? now : state.auth.lastLoginAt,
        lastSessionCheckAt: now,
        lastFailure: result.state === "authenticated" ? null : result.message ?? "淘宝窗口需要处理",
      };
      audit(
        mode === "continue" ? "tmall_continue_authentication" : "tmall_open_review_page",
        "taobao_seller",
        result.state === "authenticated" ? "success" : "attention",
        result.state === "identity_mismatch"
          ? "TMALL_IDENTITY_MISMATCH"
          : result.state === "credential_rejected"
            ? "TMALL_CREDENTIAL_REJECTED"
            : result.state === "navigation_failed" || result.state === "failed"
              ? "TMALL_NAVIGATION_NOT_READY"
              : undefined,
      );
      if (result.state === "identity_mismatch") return reply.code(409).send(result);
      if (result.state === "credential_rejected") return reply.code(422).send(result);
      return result;
    } catch (error) {
      if (error instanceof TmallCredentialReadError) {
        return reply.code(503).send({
          error: "tmall_credentials_temporarily_unavailable",
          detail: "读取已保存的淘宝登录信息失败，请重新点击验证",
        });
      }
      throw error;
    } finally {
      tmallAuthenticationInFlight = false;
      releaseBrowserOperation();
    }
  }

  app.post("/api/tmall-auth/open-review-page", async (_request, reply) => executeTmallAuthenticationAction("open", reply));
  app.post("/api/tmall-auth/continue", async (_request, reply) => executeTmallAuthenticationAction("continue", reply));
  app.post("/api/tmall-auth/runtime-preflight", async (_request, reply) => executeTmallAuthenticationAction("continue", reply));

  // Fastify invokes lifecycle hooks only after active injected/HTTP requests
  // drain.  A control preflight is itself such a request, so invalidate it at
  // the instant close() is requested rather than after the drain has finished.
  const close = app.close.bind(app);
  app.close = ((...args: unknown[]) => {
    beginAutomationShutdown();
    return Reflect.apply(close, app, args);
  }) as FastifyInstance["close"];

  return app;
}
