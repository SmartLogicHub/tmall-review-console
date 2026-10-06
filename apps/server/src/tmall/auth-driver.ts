import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ResolvedReviewScope } from "@tmall/domain";
import type { BrowserContext, Frame, Locator, Page, Route } from "patchright";
import {
  createHumanActions,
  TMALL_ACTION_DELAY_RANGES,
  type HumanActions,
} from "../automation/human-delay";
import type { LocatorProbeResult, SemanticElementSnapshot } from "../locators/repair-service";
import { launchTmallBrowserContext } from "./browser-runtime";
import { applyReviewFilters, ReviewFilterStateError, verifyReviewFilters, type ReviewFilterAdapter, type ReviewFilterMode, type ReviewFilterToggle, type ReviewScanPhase } from "./review-filter";
import { isTmallProductDetailLink, parseTmallReviewRow, TmallReviewPageStateError, type TmallPhaseReviewCandidate, type TmallReviewPhase, type TmallReviewSnapshot } from "./review-reader";
import { executeComplaintBrowserFlow, type ComplaintBrowserFlowResult } from "../complaints/complaint-browser-flow";
import { createTmallComplaintDomAdapter } from "../complaints/tmall-complaint-dom-adapter";
import type { ComplaintTypeCode } from "../complaints/complaint-domain";

export interface TmallCredentials {
  account: string;
  password: string;
}

export interface TmallAuthResult {
  state:
    | "authenticated"
    | "credential_rejected"
    | "manual_verification_required"
    | "onboarding_or_safe_guide"
    | "manual_action_required"
    | "not_ready"
    | "navigation_failed"
    | "failed";
  storeName?: string | null;
  page?: "review_list" | "login";
  message?: string;
  failureOperationKey?: string;
}

export interface TmallElementVerificationResult {
  verifiedOperationKeys: string[];
  missingOperationKeys: string[];
  queueEmpty?: boolean;
}

export interface TmallComplaintExecutionInput {
  sourceKey: string;
  reviewPhase: TmallReviewPhase;
  complaintType: ComplaintTypeCode;
  description: string;
  mode: "prepare_only" | "submit";
  beforeSubmit?: () => void;
}

export type TmallComplaintExecutionResult =
  | { state: "prepared"; evidence: string }
  | ({ state: "sent"; evidence: string } & (
      | { platformCaseId: string; detailUrl?: string }
      | { platformCaseId?: string; detailUrl: string }
  ))
  | { state: "uncertain"; evidence: string; message: string }
  | { state: "already_handled"; evidence: string; message: string }
  | { state: "failed_before_click" | "failed"; evidence: string; message: string };

export function mapTmallComplaintBrowserResult(result: ComplaintBrowserFlowResult): TmallComplaintExecutionResult {
  if (result.state === "prepared") return { state: "prepared", evidence: "投诉面板已填写并校验，尚未提交" };
  if (result.state === "sent") {
    const platformCaseId = result.platformCaseId?.trim();
    const detailUrl = result.detailUrl?.trim();
    if (!platformCaseId && !detailUrl) {
      return { state: "uncertain", evidence: "投诉提交后缺少稳定案件标识", message: "投诉提交后无法确认案件状态" };
    }
    return {
      state: "sent",
      evidence: "平台已明确受理投诉",
      ...(platformCaseId ? { platformCaseId } : {}),
      ...(detailUrl ? { detailUrl } : {}),
    } as TmallComplaintExecutionResult;
  }
  if (result.state === "uncertain") return { state: "uncertain", evidence: result.reason, message: result.reason };
  if (result.state === "already_handled") return { state: "already_handled", evidence: result.reason, message: result.reason };
  if (result.state === "failed_before_click") return { state: "failed_before_click", evidence: result.reason, message: result.reason };
  return { state: "failed", evidence: result.reason, message: result.reason };
}

export function locatorCandidateMatchesOperationSemantic(
  operationKey: string,
  evidence: { text?: string | null; ariaLabel?: string | null; placeholder?: string | null; role?: string | null },
): boolean {
  const expected: Record<string, RegExp> = {
    "navigation.trade": /交易/u,
    "navigation.reviews": /评价管理/u,
    "review.filter.buyer": /来自买家的评价/u,
    "review.filter.content": /^有内容$/u,
    "review.filter.unanswered": /^未回复$/u,
    "review.filter.followup": /^有追评$/u,
    "review.search": /^搜索$/u,
    "review.date.preset.today": /^今天$/u,
    "review.date.preset.yesterday": /^昨天$/u,
    "review.date.preset.last7": /^近7天$/u,
    "review.date.preset.last30": /^近30天$/u,
  };
  const pattern = expected[operationKey];
  if (!pattern) return true;
  const values = [evidence.text, evidence.ariaLabel, evidence.placeholder]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.normalize("NFKC").replace(/\s+/gu, "").trim())
    .filter(Boolean);
  return values.some((value) => pattern.test(value));
}

export function isTmallReplySubmitLabel(value: string): boolean {
  return /^(?:提交|确认提交|确认回复|发布|回复|确认|确定)$/u.test(value.normalize("NFKC").trim());
}

export function shouldNavigateTmallSessionHome(currentUrl: string): boolean {
  try {
    const url = new URL(currentUrl);
    return url.protocol !== "https:" || url.hostname.toLowerCase() !== "myseller.taobao.com";
  } catch {
    return true;
  }
}

export function isTmallReviewSurfaceReady(currentUrl: string, filterSurfaceVisible: boolean): boolean {
  return /\/comment-manage\/list\/rateWait4PC/u.test(currentUrl) && filterSurfaceVisible;
}

export async function waitForTmallReviewSurface(input: {
  isReady: () => Promise<boolean>;
  wait: () => Promise<void>;
  maxAttempts?: number;
}): Promise<boolean> {
  const maxAttempts = input.maxAttempts ?? 40;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await input.isReady()) return true;
    if (attempt + 1 < maxAttempts) await input.wait();
  }
  return false;
}

export class TmallBrowserOperationTimeoutError extends Error {
  constructor() {
    super("淘宝页面检测超时");
    this.name = "TmallBrowserOperationTimeoutError";
  }
}

export async function withTmallOperationDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  cancel: () => Promise<void>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("浏览器操作截止时间无效");
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Settle the public deadline first. Closing or otherwise cancelling a
      // Playwright operation can synchronously reject its locator promise; if
      // cancellation ran first, that private browser error could win the race
      // and leak to the UI instead of the stable timeout contract.
      reject(new TmallBrowserOperationTimeoutError());
      void Promise.race([
        cancel().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface TmallPopupDomDiagnostic {
  location: "login" | "review_list" | "other";
  pagePath: string;
  readyState: string;
  bodyTextLength: number;
  bodyStatusSample: string;
  controlCounts: Record<string, number>;
  replySurface: { editableCount: number; nearbyButtonLabels: string[]; dialogFooterButtonLabels: string[] };
  dateInputs: Array<{ placeholder: string; value: string }>;
  visibleOverlays: Array<{
    tag: string;
    role: string | null;
    ariaModal: string | null;
    className: string;
    popupKey: TmallSafePopupKey | null;
  }>;
  popups: Array<{
    popupKey: TmallSafePopupKey;
    controls: Array<{
      tag: string;
      role: string | null;
      ariaLabel: string | null;
      title: string | null;
      className: string;
      text: string;
      parentTag: string | null;
      parentRole: string | null;
      parentClassName: string;
    }>;
  }>;
}

export interface TmallAuthDriver {
  readonly canSubmitReplies?: boolean;
  openReviewPage(credentials: TmallCredentials): Promise<TmallAuthResult>;
  continueReviewPage?(credentials?: TmallCredentials): Promise<TmallAuthResult>;
  readPendingReviews(limit: number, scope: ResolvedReviewScope): Promise<TmallReviewSnapshot[]>;
  readPendingReviewPage?(page: number, pageSize: number, scope: ResolvedReviewScope, phase?: ReviewScanPhase, mode?: ReviewFilterMode): Promise<TmallReviewSnapshot[]>;
  readPendingReviewPageState?(page: number, pageSize: number, scope: ResolvedReviewScope, phase?: ReviewScanPhase, mode?: ReviewFilterMode): Promise<{ items: TmallReviewSnapshot[]; hasNextPage: boolean }>;
  submitReply?(
    review: TmallReviewSnapshot,
    finalReply: string,
    control?: TmallReplySubmissionControl,
  ): Promise<{ state: "sent" | "failed" | "uncertain"; evidence: string; message?: string; failureOperationKey?: string }>;
  executeComplaint?(input: TmallComplaintExecutionInput): Promise<TmallComplaintExecutionResult>;
  verifyCriticalElements?(scope: ResolvedReviewScope, options?: { includeReplyControls?: boolean }): Promise<TmallElementVerificationResult>;
  diagnoseKnownPopups?(): Promise<TmallPopupDomDiagnostic>;
  getCurrentOperationKey?(): string | null;
  captureSemanticSnapshot?(): Promise<SemanticElementSnapshot[]>;
  probeLocatorCandidate?(input: { operationKey: string; strategy: string; selector: string }): Promise<LocatorProbeResult>;
  setLocatorProvider?(provider: (operationKey: string) => { strategy: string; selector: string } | null): void;
  setLaunchAllowed?(allowed: boolean): void;
  profileSizeBytes?(): Promise<number>;
  close(): Promise<void>;
  clearProfile(): Promise<void>;
}

export class UnavailableTmallAuthDriver implements TmallAuthDriver {
  readonly canSubmitReplies = false;
  async openReviewPage(): Promise<TmallAuthResult> {
    return { state: "navigation_failed", page: "login", message: "浏览器服务未启动，请重启本地控制台" };
  }
  async continueReviewPage(): Promise<TmallAuthResult> {
    return { state: "navigation_failed", page: "login", message: "浏览器服务未启动，请重启本地控制台" };
  }
  async readPendingReviews(): Promise<TmallReviewSnapshot[]> {
    throw new Error("浏览器服务未启动，请重启本地控制台");
  }
  async readPendingReviewPage(): Promise<TmallReviewSnapshot[]> {
    throw new Error("浏览器服务未启动，请重启本地控制台");
  }
  async readPendingReviewPageState(): Promise<{ items: TmallReviewSnapshot[]; hasNextPage: boolean }> {
    throw new Error("浏览器服务未启动，请重启本地控制台");
  }
  async submitReply(): Promise<{ state: "failed"; evidence: string; message: string }> {
    return { state: "failed", evidence: "浏览器服务不可用", message: "浏览器服务未启动，请重启本地控制台" };
  }
  async executeComplaint(): Promise<TmallComplaintExecutionResult> {
    return { state: "failed", evidence: "浏览器服务不可用", message: "浏览器服务未启动，请重启本地控制台" };
  }
  async close(): Promise<void> {}
  async clearProfile(): Promise<void> {}
  async profileSizeBytes(): Promise<number> { return 0; }
}

export type TmallHumanActions = HumanActions;

interface PlaywrightTmallAuthDriverOptions {
  profileDirectory: string;
  headless?: boolean;
  humanActions?: TmallHumanActions;
  browserExecutablePath?: () => string | null;
}

interface TmallReviewTargetHint {
  page: number;
  pageSize: number;
  scope: ResolvedReviewScope;
  phase: ReviewScanPhase;
  mode: ReviewFilterMode;
  nativeReplyActionIndex?: number | null;
}

interface TmallVisibleReview {
  snapshot: TmallReviewSnapshot;
  nativeReplyActionIndex: number | null;
}

const HOME_URL = "https://myseller.taobao.com/home.htm";
const TMALL_REVIEW_SURFACE_PROBE_TIMEOUT_MS = 250;

function writeTmallNavigationDiagnostic(step: string, details: Record<string, string | number | boolean | null> = {}): void {
  // This is deliberately opt-in and redacted.  Real-page diagnosis must never
  // capture credentials, review text, buyer details, order details, or query
  // parameters.  It exists only to distinguish navigation/popup/loading paths.
  if (process.env.TMALL_CONSOLE_DIAGNOSTICS !== "1") return;
  console.error(JSON.stringify({ event: "tmall_navigation_diagnostic", step, ...details }));
}

function safeTmallPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://myseller.taobao.com" ? parsed.pathname : null;
  } catch {
    return null;
  }
}

function safeTmallDiagnosticError(error: unknown): string {
  const source = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const value = source instanceof Error ? source.message : String(source);
  return value
    .replace(/https?:\/\/[^\s"']+/gu, "[URL]")
    .replace(/\b\d{6,}\b/gu, "[ID]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
}

export function isTmallPageClosedError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const message = current instanceof Error ? current.message : String(current ?? "");
    if (/Target page, context or browser has been closed/iu.test(message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

export class TmallOperationCancelledError extends Error {
  constructor() {
    super("天猫页面操作已经失效");
    this.name = "TmallOperationCancelledError";
  }
}

export interface TmallOperationActivity {
  isActive(): boolean;
  assertActive(): void;
  cancel(): Promise<void>;
}

export interface TmallReplySubmissionControl {
  beforeSubmit?(): void;
  shouldContinue?(): boolean;
}

export function createTmallOperationActivity(): TmallOperationActivity {
  let active = true;
  return Object.freeze({
    isActive: () => active,
    assertActive: () => {
      if (!active) throw new TmallOperationCancelledError();
    },
    cancel: async () => {
      active = false;
    },
  });
}

export async function acquireLiveTmallPage(
  currentContext: BrowserContext | null,
  launchContext: () => Promise<BrowserContext>,
  options: { allowLaunch?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  if (currentContext) {
    try {
      return {
        context: currentContext,
        page: currentContext.pages()[0] ?? await currentContext.newPage(),
      };
    } catch (error) {
      if (!isTmallPageClosedError(error)) throw error;
      await currentContext.close().catch(() => undefined);
    }
  }
  if (options.allowLaunch === false) {
    throw new Error("浏览器窗口已关闭，请重新点击运行或继续后再打开");
  }
  const context = await launchContext();
  return {
    context,
    page: context.pages()[0] ?? await context.newPage(),
  };
}
const TMALL_LOGIN_PROBE_TIMEOUT_MS = 1_000;
const TMALL_LOGIN_REVALIDATION_TIMEOUT_MS = 1_000;

export interface TmallLoginControlGroup {
  readonly frame: Frame;
  readonly account: Locator;
  readonly password: Locator;
  readonly submit: Locator;
}

interface TmallLoginLocatorCandidates {
  readonly registered: Locator;
  readonly fallback: Locator;
}

type TmallLoginControlSource = Locator | TmallLoginLocatorCandidates;
type TmallLoginControlResolver = (frame: Frame) => TmallLoginControlSource | Promise<TmallLoginControlSource | null>;
type TmallLocatorRequirement = "editable" | "password" | "enabled";

async function settleBeforeTmallDeadline<T>(operation: Promise<T>, deadlineAt: number, fallback: T): Promise<T> {
  if (!Number.isFinite(deadlineAt)) return operation.catch(() => fallback);
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return fallback;
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(fallback);
    }, remainingMs);
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function isTmallLoginLocatorCandidates(source: TmallLoginControlSource): source is TmallLoginLocatorCandidates {
  return "registered" in source && "fallback" in source;
}

export async function findTmallLoginFrame(
  page: Page,
  accountLocator: TmallLoginControlResolver,
  passwordLocator: TmallLoginControlResolver,
  submitLocator: TmallLoginControlResolver,
  timeoutMs = 15_000,
): Promise<TmallLoginControlGroup | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    const matches = await resolveTmallLoginGroups(
      page,
      accountLocator,
      passwordLocator,
      submitLocator,
      deadlineAt,
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) return null;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return null;
    await settleBeforeTmallDeadline(
      page.waitForTimeout(Math.min(100, remainingMs)),
      deadlineAt,
      undefined,
    );
  }
  return null;
}

async function resolveTmallLoginGroups(
  page: Page,
  accountLocator: TmallLoginControlResolver,
  passwordLocator: TmallLoginControlResolver,
  submitLocator: TmallLoginControlResolver,
  deadlineAt: number,
): Promise<TmallLoginControlGroup[]> {
  const groups = await settleBeforeTmallDeadline(
    Promise.all(page.frames().map((frame) => resolveTmallLoginGroup(
      frame,
      accountLocator,
      passwordLocator,
      submitLocator,
      deadlineAt,
    ))),
    deadlineAt,
    [] as Array<TmallLoginControlGroup | null>,
  );
  return groups.filter((group): group is TmallLoginControlGroup => group !== null);
}

async function resolveTmallLoginGroup(
  frame: Frame,
  accountLocator: TmallLoginControlResolver,
  passwordLocator: TmallLoginControlResolver,
  submitLocator: TmallLoginControlResolver,
  deadlineAt: number,
): Promise<TmallLoginControlGroup | null> {
  const [account, password, submit] = await Promise.all([
    resolveTmallLoginControl(accountLocator, frame, "editable", deadlineAt),
    resolveTmallLoginControl(passwordLocator, frame, "password", deadlineAt),
    resolveTmallLoginControl(submitLocator, frame, "enabled", deadlineAt),
  ]);
  if (!account || !password || !submit) return null;
  if (!await areTmallLoginControlsDistinct(account, password, submit, deadlineAt)) return null;
  return Object.freeze({ frame, account, password, submit });
}

async function resolveTmallLoginControl(
  resolver: TmallLoginControlResolver,
  frame: Frame,
  requirement: TmallLocatorRequirement,
  deadlineAt: number,
): Promise<Locator | null> {
  try {
    const source = await settleBeforeTmallDeadline(
      Promise.resolve(resolver(frame)),
      deadlineAt,
      null,
    );
    if (!source) return null;
    return isTmallLoginLocatorCandidates(source)
      ? resolveTmallLocatorWithFallback(source.registered, source.fallback, requirement, deadlineAt)
      : resolveTmallLocatorCandidate(source, requirement, deadlineAt);
  } catch {
    return null;
  }
}

async function resolveTmallLocatorCandidate(
  candidates: Locator,
  requirement: TmallLocatorRequirement,
  deadlineAt = Number.POSITIVE_INFINITY,
): Promise<Locator | null> {
  // Patchright can throw synchronously while constructing `locator.all()` if
  // QianNiu replaces the login iframe between locator creation and lookup.
  // Enter the call through a promise boundary so the normal fallback path
  // handles both synchronous throws and asynchronous frame-detached rejects.
  const all = await settleBeforeTmallDeadline(
    Promise.resolve().then(() => candidates.all()),
    deadlineAt,
    [] as Locator[],
  );
  const readiness = await settleBeforeTmallDeadline(
    Promise.all(all.map(async (candidate) => {
      const [visible, editable, enabled, type] = await Promise.all([
        candidate.isVisible().catch(() => false),
        requirement === "enabled" ? Promise.resolve(false) : candidate.isEditable().catch(() => false),
        requirement === "enabled" ? candidate.isEnabled().catch(() => false) : Promise.resolve(false),
        requirement === "password" ? candidate.getAttribute("type").catch(() => null) : Promise.resolve(null),
      ]);
      if (!visible) return false;
      if (requirement === "enabled") return enabled;
      if (!editable) return false;
      return requirement !== "password" || type?.toLowerCase() === "password";
    })),
    deadlineAt,
    [] as boolean[],
  );
  const ready = all.filter((_candidate, index) => readiness[index] === true);
  if (ready.length !== 1) return null;
  return ready[0] ?? null;
}

export async function resolveTmallLocatorWithFallback(
  registered: Locator,
  fallback: Locator,
  requirement: TmallLocatorRequirement,
  deadlineAt = Number.POSITIVE_INFINITY,
): Promise<Locator | null> {
  for (const candidates of [registered, fallback]) {
    const candidate = await resolveTmallLocatorCandidate(candidates, requirement, deadlineAt);
    if (candidate) return candidate;
  }
  return null;
}

async function areTmallLoginControlsDistinct(
  account: Locator,
  password: Locator,
  submit: Locator,
  deadlineAt: number,
): Promise<boolean> {
  const overlaps = await settleBeforeTmallDeadline(
    Promise.all([
      account.and(password).count(),
      account.and(submit).count(),
      password.and(submit).count(),
    ]),
    deadlineAt,
    [1, 1, 1],
  );
  return overlaps.every((count) => count === 0);
}

async function areTmallLoginGroupsIdentical(
  expected: TmallLoginControlGroup,
  current: TmallLoginControlGroup,
  deadlineAt: number,
): Promise<boolean> {
  if (expected.frame !== current.frame) return false;
  const intersections = await settleBeforeTmallDeadline(
    Promise.all([
      expected.account.and(current.account).count(),
      expected.password.and(current.password).count(),
      expected.submit.and(current.submit).count(),
    ]),
    deadlineAt,
    [0, 0, 0],
  );
  return intersections.every((count) => count === 1);
}

export async function revalidateTmallLoginControlGroup(
  page: Page,
  expected: TmallLoginControlGroup,
  accountLocator: TmallLoginControlResolver,
  passwordLocator: TmallLoginControlResolver,
  submitLocator: TmallLoginControlResolver,
  timeoutMs = TMALL_LOGIN_REVALIDATION_TIMEOUT_MS,
): Promise<TmallLoginControlGroup | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  const deadlineAt = Date.now() + timeoutMs;
  const matches = await resolveTmallLoginGroups(
    page,
    accountLocator,
    passwordLocator,
    submitLocator,
    deadlineAt,
  );
  if (matches.length !== 1) return null;
  return await areTmallLoginGroupsIdentical(expected, matches[0]!, deadlineAt) ? expected : null;
}

export async function isTmallLoginPage(
  page: Page,
  accountLocator: TmallLoginControlResolver,
  passwordLocator: TmallLoginControlResolver,
  submitLocator: TmallLoginControlResolver,
): Promise<boolean> {
  if (/login|passport/iu.test(page.url())) return true;
  const deadlineAt = Date.now() + TMALL_LOGIN_PROBE_TIMEOUT_MS;
  const matches = await resolveTmallLoginGroups(
    page,
    accountLocator,
    passwordLocator,
    submitLocator,
    deadlineAt,
  );
  return matches.length === 1;
}

export async function performTmallLoginActions(
  group: TmallLoginControlGroup,
  credentials: TmallCredentials,
  revalidate: () => Promise<boolean>,
  actions: TmallHumanActions = createHumanActions(),
): Promise<void> {
  const validBeforeFill = await revalidate().catch(() => false);
  if (!validBeforeFill) throw new TmallDriverOperationError("login.account", "登录控件组无法安全确认");
  try {
    await actions.type(group.account, credentials.account);
  } catch {
    throw new TmallDriverOperationError("login.account", "登录账号框填写失败");
  }
  await actions.delay(TMALL_ACTION_DELAY_RANGES.loginFieldGap);
  try {
    await actions.type(group.password, credentials.password);
  } catch {
    throw new TmallDriverOperationError("login.password", "登录密码框填写失败");
  }
  await actions.delay(TMALL_ACTION_DELAY_RANGES.loginSubmitBefore);
  const validBeforeSubmit = await revalidate().catch(() => false);
  if (!validBeforeSubmit) throw new TmallDriverOperationError("login.submit", "登录控件组无法安全确认");
  try {
    await actions.click(group.submit);
  } catch {
    throw new TmallDriverOperationError("login.submit", "登录按钮点击失败");
  }
  await actions.delay(TMALL_ACTION_DELAY_RANGES.loginSubmitAfter);
}

export function tmallReviewPageUrl(page: number, pageSize: number): string {
  if (!Number.isInteger(page) || page < 1) throw new Error("页码必须是大于0的整数");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("每页数量必须在1到100之间");
  return `https://myseller.taobao.com/home.htm/comment-manage/list/rateWait4PC?current=${page}&pageSize=${pageSize}`;
}

export interface FrozenTmallReviewFilters {
  startDate: string;
  endDate: string;
  phase: ReviewScanPhase;
  mode: ReviewFilterMode;
}

export function tmallReviewPageUrlWithFilters(
  currentUrl: string,
  page: number,
  pageSize: number,
  frozen?: FrozenTmallReviewFilters,
): string {
  const target = new URL(tmallReviewPageUrl(page, pageSize));
  if (frozen) {
    const followup = frozen.phase === "followup" || frozen.mode === "followup_only";
    target.searchParams.set("content", followup ? "hasAppend" : "hasContent");
    if (!followup) target.searchParams.set("explain", "notExplain");
    target.searchParams.set(
      "dateRange",
      `${frozen.startDate.replaceAll("-", "")},${frozen.endDate.replaceAll("-", "")}`,
    );
    return target.toString();
  }
  try {
    const current = new URL(currentUrl);
    if (current.origin !== target.origin || current.pathname !== target.pathname) return target.toString();
    const content = current.searchParams.get("content");
    if (["hasContent", "hasAppend"].includes(content ?? "")) target.searchParams.set("content", content!);
    const explain = current.searchParams.get("explain");
    if (explain === "notExplain") target.searchParams.set("explain", explain);
    const dateRange = current.searchParams.get("dateRange");
    if (/^\d{8},\d{8}$/u.test(dateRange ?? "")) target.searchParams.set("dateRange", dateRange!);
    return target.toString();
  } catch {
    return target.toString();
  }
}

export function tmallReviewRefreshStrategy(input: {
  targetPage: number;
  activeContextMatches: boolean;
  requestedPageMatches: boolean;
}): "reuse" | "navigate" {
  return input.targetPage === 1 && input.activeContextMatches && input.requestedPageMatches
    ? "reuse"
    : "navigate";
}

export function tmallReviewSurfaceRecoveryStrategy(
  currentUrl: string,
  surfaceReady: boolean,
): "reuse" | "reload_review" | "enter_review" {
  if (surfaceReady) return "reuse";
  try {
    const parsed = new URL(currentUrl);
    return parsed.origin === "https://myseller.taobao.com"
      && parsed.pathname === "/home.htm/comment-manage/list/rateWait4PC"
      ? "reload_review"
      : "enter_review";
  } catch {
    return "enter_review";
  }
}

export async function navigateTmallReviewPageWithFallback(input: {
  navigateByMenu(): Promise<void>;
  navigateDirect(url: string): Promise<void>;
  isReviewPageReady(): Promise<boolean>;
}): Promise<"menu" | "direct"> {
  let directError: unknown;
  try {
    await input.navigateDirect(tmallReviewPageUrl(1, 20));
    if (await input.isReviewPageReady()) return "direct";
  } catch (error) {
    directError = error;
  }

  let menuError: unknown;
  try {
    await input.navigateByMenu();
    if (await input.isReviewPageReady()) return "menu";
  } catch (error) {
    menuError = error;
  }
  if (menuError) throw menuError;
  if (directError) throw directError;
  throw new TmallDriverOperationError("navigation.reviews", "评价管理页面无法进入");
}

export async function navigateTmallPageWithTransientRetry(
  navigate: () => Promise<unknown>,
  beforeRetry: () => Promise<void>,
): Promise<void> {
  try {
    await navigate();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/interrupted by another navigation[\s\S]*about:blank|ERR_ABORTED/iu.test(message)) throw error;
    await beforeRetry();
    await navigate();
  }
}

export function publicTmallNavigationFailureMessage(
  error: unknown,
  fallback = "淘宝页面暂时无法进入评价管理，请在已打开的窗口处理后继续检测",
): string {
  return error instanceof TmallDriverOperationError || error instanceof TmallReviewPageStateError
    ? error.message
    : fallback;
}

export type TmallSafePopupKey = "important_messages" | "feature_upgrade" | "new_user_guide";

const TMALL_UNSAFE_POPUP_TEXT = /验证码|短信(?:验证|校验|确认)|电话(?:验证|校验|核验)|扫码(?:验证|确认)|二维码(?:验证|确认)|安全验证|身份验证|设备验证|风险验证|滑块|确认操作|是否确认|确认提交|业务确认|删除/u;
const TMALL_BUSINESS_ACTION_TEXT = /处理|确认|同意|拒绝|退款|退货|投诉|申诉|处罚|赔付|提交|下一步|授权/u;
const TMALL_SECURITY_OR_CONFIRMATION_TEXT = /验证码|短信(?:验证|校验|确认)|电话(?:验证|校验|核验)|扫码(?:验证|确认)|二维码(?:验证|确认)|安全验证|身份验证|设备验证|风险验证|滑块|确认操作|是否确认|确认提交|业务确认|删除/u;
const TMALL_HARD_CLOSE_CONTROL_SELECTOR = "button, [role='button'], [aria-label='关闭'], [title='关闭'], .next-dialog-close, .next-icon-close_blod";
export const TMALL_TOP_LEVEL_OVERLAY_SELECTOR = "[role='dialog'], [aria-modal='true'], .next-dialog, [class*='dialog'], [class*='popover'], [class*='guide'], [class*='drawer'], [class*='modal'], [class*='mask']";
const TMALL_TOP_LEVEL_OVERLAY_ANCESTOR = "xpath=ancestor::*[@role='dialog' or @aria-modal='true' or contains(@class,'dialog') or contains(@class,'popover') or contains(@class,'guide') or contains(@class,'drawer') or contains(@class,'modal') or contains(@class,'mask')][1]";

const TMALL_SAFE_POPUP_RULES: ReadonlyArray<{
  key: TmallSafePopupKey;
  matches: (text: string) => boolean;
}> = Object.freeze([
  {
    key: "important_messages",
    matches: (text) => /重要消息/u.test(text)
      && /预警通知/u.test(text),
  },
  {
    key: "feature_upgrade",
    matches: (text) => /功能升级/u.test(text)
      && /评价智能分析上线|新版评价管理已上线/u.test(text),
  },
  {
    key: "new_user_guide",
    matches: (text) => /新手引导/u.test(text),
  },
]);

export function tmallSafePopupKey(text: string): TmallSafePopupKey | null {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || TMALL_UNSAFE_POPUP_TEXT.test(normalized)) return null;
  for (const rule of TMALL_SAFE_POPUP_RULES) {
    if (rule.matches(normalized)) return rule.key;
  }
  return null;
}

export function isSafeNotificationPopup(text: string): boolean {
  return tmallSafePopupKey(text) !== null;
}

export function isPassiveTmallNotificationModal(input: {
  className: string;
  text: string;
  controlLabels: readonly string[];
  editableCount: number;
  hardCloseCount: number;
}): boolean {
  const classTokens = input.className.split(/\s+/u).filter(Boolean);
  const text = input.text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return classTokens.includes("tbd-modal")
    && input.hardCloseCount === 1
    && input.editableCount === 0
    && !TMALL_SECURITY_OR_CONFIRMATION_TEXT.test(text)
    && !input.controlLabels.some((label) => TMALL_BUSINESS_ACTION_TEXT.test(label.normalize("NFKC")));
}

export function isTmallShopLossWarningNavigationModal(input: {
  className: string;
  text: string;
  controlLabels: readonly string[];
  editableCount: number;
}): boolean {
  const classTokens = input.className.split(/\s+/u).filter(Boolean);
  const text = input.text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const labels = input.controlLabels.map((label) => label.normalize("NFKC").replace(/\s+/gu, " ").trim());
  // The merchant explicitly approved this one navigation-only exception.  It
  // must remain narrower than a generic business-action rule: no text entry,
  // no verification/confirmation language, exactly one action, and a fixed
  // title/button pair.  Anything else remains manual.
  return classTokens.includes("tbd-modal")
    && input.editableCount === 0
    && /店铺资损预警/u.test(text)
    && !TMALL_SECURITY_OR_CONFIRMATION_TEXT.test(text)
    && labels.length === 1
    && labels[0] === "立即处理";
}

export async function resolveTmallHardCloseControls(candidates: readonly Locator[]): Promise<Locator[]> {
  const controls: Locator[] = [];
  for (const candidate of candidates) {
    if (!await candidate.isVisible().catch(() => false)) continue;
    const [ariaLabel, title, className, visibleText] = await Promise.all([
      candidate.getAttribute("aria-label").catch(() => null),
      candidate.getAttribute("title").catch(() => null),
      candidate.getAttribute("class").catch(() => null),
      candidate.innerText().catch(() => ""),
    ]);
    const normalizedAria = (ariaLabel ?? "").normalize("NFKC").trim();
    const normalizedTitle = (title ?? "").normalize("NFKC").trim();
    const normalizedVisibleText = visibleText.normalize("NFKC").trim();
    const classTokens = (className ?? "").split(/\s+/u).filter(Boolean);
    const hasHardCloseSemantic = normalizedAria === "关闭"
      || normalizedTitle === "关闭"
      || classTokens.includes("next-dialog-close")
      || classTokens.includes("next-icon-close_blod")
      || /^(?:×|✕|关闭)$/u.test(normalizedVisibleText);
    if (!hasHardCloseSemantic) continue;
    const actionText = `${normalizedAria} ${normalizedTitle} ${normalizedVisibleText}`.trim();
    if (TMALL_BUSINESS_ACTION_TEXT.test(actionText)) continue;
    controls.push(candidate);
  }
  return controls;
}

/** The live notification head is safer than a text-derived ancestor scope. */
export async function resolveTmallImportantMessageCloseControls(scope: Page | Locator): Promise<Locator[]> {
  return resolveTmallHardCloseControls(await scope.locator(
    "[class*='notify_headRight'] .next-icon-close_blod, [class*='notify_headRight'] [aria-label='关闭'], [class*='notify_headRight'] [title='关闭']",
  ).all());
}

/** The feature-upgrade guide is a top-level overlay and must be cleared first. */
export async function resolveTmallFeatureUpgradeAcknowledgement(scope: Page | Locator): Promise<Locator[]> {
  const controls: Locator[] = [];
  for (const dialog of await scope.locator(".upgrade-analysis-dialog").all()) {
    if (!await dialog.isVisible().catch(() => false)) continue;
    for (const candidate of await dialog.getByRole("button", { name: "我知道了", exact: true }).all()) {
      if (await candidate.isVisible().catch(() => false)) controls.push(candidate);
    }
  }
  return controls;
}

/** Only dismisses the already identified reply dialog; it never touches other business dialogs. */
export async function resolveTmallReplyDismissControls(scope: Page | Locator): Promise<Locator[]> {
  const controls: Locator[] = [];
  for (const candidate of await scope.getByRole("button", { name: "取消", exact: true }).all()) {
    if (await candidate.isVisible().catch(() => false)) controls.push(candidate);
  }
  if (controls.length > 0) return controls;
  for (const candidate of await scope.getByRole("button", { name: "关闭", exact: true }).all()) {
    if (await candidate.isVisible().catch(() => false)) controls.push(candidate);
  }
  return controls;
}

/**
 * The platform's notification panel exposes a stable, local close icon. Use
 * that live control first: a saved repair can refer to an ancestor from a
 * previous popup and otherwise make a harmless close attempt wait 30 seconds.
 */
export async function resolveTmallPopupCloseControls(input: {
  liveCandidates: readonly Locator[];
  repairedCandidates?: () => Promise<readonly Locator[]>;
}): Promise<Locator[]> {
  const live = await resolveTmallHardCloseControls(input.liveCandidates);
  if (live.length > 0) return live;
  if (!input.repairedCandidates) return [];
  return resolveTmallHardCloseControls(await input.repairedCandidates());
}

export async function withTmallReadOnlyNetworkGuard<T>(
  page: Pick<Page, "route" | "unroute">,
  action: () => Promise<T>,
): Promise<T> {
  const handler = async (route: Route): Promise<void> => {
    const method = route.request().method().toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  };
  await page.route("**/*", handler);
  try {
    return await action();
  } finally {
    await page.unroute("**/*", handler).catch(() => undefined);
  }
}

export function tmallSafePopupPageIdentity(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://myseller.taobao.com"
      ? `${parsed.origin}${parsed.pathname}`
      : null;
  } catch {
    return null;
  }
}

export async function probeTmallSafePopupCloseControl(input: {
  page: Pick<Page, "route" | "unroute" | "url" | "title">;
  candidate: Locator;
  click: (candidate: Locator) => Promise<void>;
  afterClick: () => Promise<void>;
}): Promise<boolean> {
  const controls = await resolveTmallHardCloseControls([input.candidate]);
  if (controls.length !== 1) return false;
  const control = controls[0]!;
  const overlay = control.locator(TMALL_TOP_LEVEL_OVERLAY_ANCESTOR).first();
  if (!await overlay.isVisible().catch(() => false)) return false;
  if (!isSafeNotificationPopup(await overlay.innerText().catch(() => ""))) return false;
  return withTmallReadOnlyNetworkGuard(input.page, async () => {
    const identityBefore = tmallSafePopupPageIdentity(input.page.url());
    if (!identityBefore) return false;
    await input.click(control);
    await input.afterClick();
    const hidden = !await overlay.isVisible().catch(() => false);
    const identityAfter = tmallSafePopupPageIdentity(input.page.url());
    return hidden && identityAfter === identityBefore;
  });
}

export function selectTmallAuthenticationPage<T extends { isClosed(): boolean }>(
  pages: readonly T[],
  pinned: T | null,
): T | null {
  const openPages = pages.filter((page) => !page.isClosed());
  if (openPages.length === 0) return null;
  if (!pinned || pinned.isClosed()) return openPages.at(-1) ?? null;
  const pinnedIndex = openPages.indexOf(pinned);
  if (pinnedIndex < 0) return openPages.at(-1) ?? null;
  return openPages.slice(pinnedIndex + 1).at(-1) ?? pinned;
}

export interface TmallSafePopupAdapter {
  isVisible(): Promise<boolean>;
  text(): Promise<string>;
  actions(popupKey: TmallSafePopupKey): Promise<Array<{ click(): Promise<void> }>>;
  waitUntilHidden(): Promise<boolean>;
  pageIdentity?(): Promise<string>;
}

export type TmallSafePopupDismissal = "absent" | "closed" | "manual_action_required";

export async function dismissTmallSafePopup(adapter: TmallSafePopupAdapter): Promise<TmallSafePopupDismissal> {
  if (!await adapter.isVisible()) return "absent";
  const text = await adapter.text();
  const popupKey = tmallSafePopupKey(text);
  if (!popupKey) return "manual_action_required";
  const actions = await adapter.actions(popupKey);
  if (actions.length !== 1) return "manual_action_required";
  const identityBefore = await adapter.pageIdentity?.();
  await actions[0]!.click();
  if (!await adapter.waitUntilHidden()) return "manual_action_required";
  const identityAfter = await adapter.pageIdentity?.();
  return identityBefore === undefined || identityAfter === identityBefore ? "closed" : "manual_action_required";
}

export type TmallAuthenticationPageState =
  | "credential_rejected"
  | "manual_verification_required"
  | "onboarding_or_safe_guide"
  | "manual_action_required"
  | "not_ready";

export async function resolveTmallBlockingStateAfterSafeDismissal(input: {
  dismiss(): Promise<TmallSafePopupDismissal>;
  readState(): Promise<TmallAuthenticationPageState | null>;
}): Promise<{ dismissal: TmallSafePopupDismissal; state: TmallAuthenticationPageState | null }> {
  const dismissal = await input.dismiss();
  if (dismissal === "manual_action_required") {
    return { dismissal, state: "manual_action_required" };
  }
  return { dismissal, state: await input.readState() };
}

export async function resolveTmallBlockingStateWithTransientOverlayRetry(input: {
  dismiss(): Promise<TmallSafePopupDismissal>;
  readState(): Promise<TmallAuthenticationPageState | null>;
  wait(): Promise<void>;
  maxAttempts?: number;
}): Promise<{ dismissal: TmallSafePopupDismissal; state: TmallAuthenticationPageState | null }> {
  const maxAttempts = input.maxAttempts ?? 20;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await resolveTmallBlockingStateAfterSafeDismissal(input);
    if (result.dismissal !== "manual_action_required") return result;

    // A blank loading mask can be visible while Tmall replaces the page body.
    // Only retry when the page itself has no security or business-confirmation
    // signal; explicit action-required states must remain fail-closed.
    const state = await input.readState();
    if (state !== null) return { dismissal: result.dismissal, state };
    if (attempt + 1 < maxAttempts) await input.wait();
  }
  return { dismissal: "manual_action_required", state: "manual_action_required" };
}

export async function retryTmallTransientManualAction<T extends { state: string }>(input: {
  run(): Promise<T>;
  readState(): Promise<TmallAuthenticationPageState | null>;
  wait(): Promise<void>;
}): Promise<T> {
  const first = await input.run();
  if (first.state !== "manual_action_required") return first;
  if (await input.readState() !== null) return first;
  await input.wait();
  return input.run();
}

export function classifyTmallAuthenticationText(input: {
  bodyText: string;
  loginPageVisible: boolean;
}): TmallAuthenticationPageState | null {
  const text = input.bodyText.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (/重要消息|新手引导|功能升级|评价智能分析上线/u.test(text)) {
    return isSafeNotificationPopup(text) ? "onboarding_or_safe_guide" : "manual_action_required";
  }
  if (!input.loginPageVisible && /退款|退货|投诉|申诉|处罚|赔付|确认操作|是否确认|确认提交|业务确认/u.test(text)) {
    return "manual_action_required";
  }
  const explicitVerification = /短信(?:验证码|验证|校验|确认)|(?:电话|手机号|手机号码|手机)(?:验证|校验|核验|确认)|(?:验证|校验|核验|确认)(?:电话|手机号|手机号码|手机)|(?:安全|身份|设备|风险|二次|人脸)(?:验证|校验|核验|确认)|滑块|验证码/u;
  const requestedVerification = /(?:请|需要|需|完成|进行|使用|通过|前往|打开).{0,20}(?:扫码(?:验证|确认|登录)?|二维码(?:验证|确认|登录)?|短信登录)|(?:请|需要|需|完成|进行|输入|获取).{0,20}(?:验证码|短信验证码)/u;
  if (explicitVerification.test(text) || requestedVerification.test(text)) {
    return "manual_verification_required";
  }
  if (/账号(?:名)?或(?:登录)?密码(?:错误|不正确)|用户名或(?:登录)?密码(?:错误|不正确)|(?:登录)?密码(?:错误|不正确)|(?:该)?(?:账号|账户|帐号)(?:名)?(?:不存在|未注册|无效|错误|已被锁定|已锁定|已冻结|已被禁用)/u.test(text)) {
    return "credential_rejected";
  }
  return input.loginPageVisible ? "not_ready" : null;
}

export function isVerifiedEmptyPendingQueue(text: string): boolean {
  const normalized = text.replace(/\s+/gu, " ");
  const counts = Array.from(normalized.matchAll(/共\s*(\d+)\s*条/gu), (match) => Number(match[1]));
  return /评价内容/u.test(normalized)
    && /商品信息/u.test(normalized)
    && /买家信息/u.test(normalized)
    && counts.length === 1
    && counts[0] === 0;
}

export function parseTmallReviewTotalCount(text: string): number | null {
  const counts = Array.from(text.replace(/\s+/gu, " ").matchAll(/共\s*(\d+)\s*条/gu), (match) => Number(match[1]));
  const unique = [...new Set(counts.filter((count) => Number.isSafeInteger(count) && count >= 0))];
  return unique.length === 1 ? unique[0]! : null;
}

export function tmallReviewTotalPages(totalCount: number, pageSize: number): number {
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) throw new Error("评价总数必须是非负整数");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error("每页数量必须是正整数");
  return Math.max(1, Math.ceil(totalCount / pageSize));
}

export function tmallReviewPageNavigationTargets(currentPage: number, requestedPage: number): number[] {
  if (!Number.isInteger(currentPage) || currentPage < 1 || !Number.isInteger(requestedPage) || requestedPage < 1) {
    throw new Error("页码必须是大于0的整数");
  }
  return [requestedPage];
}

export function tmallReviewFilterRecoveryTargets(filtersChanged: boolean, requestedPage: number): number[] {
  if (!Number.isInteger(requestedPage) || requestedPage < 1) throw new Error("页码必须是大于0的整数");
  return filtersChanged ? [requestedPage] : [];
}

export function resolveTmallReviewSubmissionPageHint(
  hints: ReadonlyMap<string, number>,
  sourceKey: string,
): number | null {
  const page = hints.get(sourceKey);
  return Number.isSafeInteger(page) && (page ?? 0) >= 1 ? page! : null;
}

export function reviewPhaseFromReplyAction(actionText: string): TmallReviewPhase {
  const normalized = actionText.replace(/\s+/gu, "").trim();
  if (["评价回复", "投诉评价记录", "评价回复记录"].includes(normalized)) return "initial";
  if (["追评回复", "投诉追评记录", "追评回复记录"].includes(normalized)) return "followup";
  throw new Error("评价阶段无法识别");
}

export function shouldIncludeTmallReplyActionForScan(
  actionText: string,
  phase: ReviewScanPhase,
  mode: ReviewFilterMode,
): boolean {
  const actionPhase = reviewPhaseFromReplyAction(actionText);
  // Tmall mixes both action labels inside the real “有内容 + 未回复” result
  // set. The other two modes keep their phase-specific scans.
  return mode === "content_unanswered" || actionPhase === phase;
}

export interface TmallAnchorDomEvidence {
  text: string;
  href: string;
  ancestorTexts: string[];
}

export interface TmallScopeAnchorEvaluator {
  evaluate(pageFunction: (scopeElement: HTMLElement) => TmallAnchorDomEvidence[]): Promise<TmallAnchorDomEvidence[]>;
}

export function collectTmallAnchorDomEvidence(scope: TmallScopeAnchorEvaluator): Promise<TmallAnchorDomEvidence[]> {
  return scope.evaluate((scopeElement) => Array.from(scopeElement.querySelectorAll("a")).map((anchor) => {
    const ancestorTexts: string[] = [];
    let region = anchor.parentElement;
    while (region && region !== scopeElement) {
      ancestorTexts.push(region.innerText.replace(/\s+/gu, " ").trim());
      region = region.parentElement;
    }
    return { text: anchor.innerText, href: anchor.getAttribute("href") ?? "", ancestorTexts };
  }));
}

export function selectTmallProductAnchorEvidence(
  anchors: readonly TmallAnchorDomEvidence[],
): Array<{ text: string; href: string }> {
  const candidates = anchors.flatMap((anchor) => {
    const text = anchor.text.replace(/\s+/gu, " ").trim();
    if (!text || /^订单(?:号|详情)/u.test(text)) return [];
    if (/^复制(?:链接|商品|标题)?$/u.test(text) || /优惠|活动|领券|优惠券|查看更多/u.test(text)) return [];
    const orderRegion = anchor.ancestorTexts.find((candidate) => /订单号\s*[:：]\s*\d{8,}/u.test(candidate));
    if (!orderRegion || /(评价回复|追评回复|投诉评价|投诉追评)/u.test(orderRegion)) return [];
    return [{ text, href: anchor.href }];
  });
  return candidates.filter((candidate) => !candidate.href.trim() || isTmallProductDetailLink(candidate.href));
}

export function assertTmallSubmissionTargetIdentity(expected: TmallReviewSnapshot, current: TmallReviewSnapshot): void {
  if (expected.sourceKey !== current.sourceKey) throw new TmallReviewPageStateError("提交前评价唯一标识已改变");
  if (expected.reviewPhase !== current.reviewPhase) throw new TmallReviewPageStateError("提交前评价阶段已改变");
  if (expected.itemId && current.itemId !== expected.itemId) {
    throw new TmallReviewPageStateError("提交前商品ID缺失或已改变");
  }
}

export function parseTmallVisibleDateRange(text: string): { startDate: string | null; endDate: string | null } {
  const dates = text.match(/\d{4}-\d{2}-\d{2}/gu) ?? [];
  return {
    startDate: dates[0] ?? null,
    endDate: dates[1] ?? null,
  };
}

export function parseTmallCalendarMonth(text: string): string | null {
  const match = text.replace(/\s+/gu, "").match(/^(\d{4})年(\d{1,2})月$/u);
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${match[1]}-${String(month).padStart(2, "0")}` : null;
}

const TMALL_ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export async function resolveTmallDateControlCandidates(seeds: readonly Locator[]): Promise<Locator[]> {
  const controls: Locator[] = [];
  for (const seed of seeds) {
    if (!await seed.isVisible().catch(() => false)) continue;
    const candidates = await seed.locator(
      "xpath=self::*[count(.//input[not(@type='hidden')])=2] | ancestor::*[count(.//input[not(@type='hidden')])=2][1]",
    ).all();
    for (const candidate of candidates) {
      if (!await candidate.isVisible().catch(() => false)) continue;
      const inputs = candidate.locator("input:not([type='hidden'])");
      if (await inputs.count() === 2) controls.push(candidate);
    }
  }
  return controls;
}

export async function readTmallDateRangeFromControl(control: Locator): Promise<{ startDate: string | null; endDate: string | null }> {
  const inputs = await control.locator("input:not([type='hidden'])").all();
  const visibleInputs: Locator[] = [];
  for (const input of inputs) {
    if (await input.isVisible().catch(() => false)) visibleInputs.push(input);
  }
  if (visibleInputs.length !== 2) return { startDate: null, endDate: null };
  const values = await Promise.all(visibleInputs.map((input) => input.inputValue().catch(() => "")));
  return {
    startDate: TMALL_ISO_DATE_PATTERN.test(values[0] ?? "") ? values[0]! : null,
    endDate: TMALL_ISO_DATE_PATTERN.test(values[1] ?? "") ? values[1]! : null,
  };
}

export async function resolveTmallCalendarDateCandidates(candidates: readonly Locator[], date: string): Promise<Locator[]> {
  if (!TMALL_ISO_DATE_PATTERN.test(date)) return [];
  const exact: Locator[] = [];
  for (const candidate of candidates) {
    if (!await candidate.isVisible().catch(() => false)) continue;
    const matches = await candidate.evaluate((element, expected) => (
      ["data-value", "data-date", "title", "aria-label"]
        .some((attribute) => element.getAttribute(attribute) === expected)
    ), date).catch(() => false);
    if (matches) exact.push(candidate);
  }
  return exact;
}

export async function readTmallToggleSelectionState(locator: Locator): Promise<boolean | null> {
  return locator.evaluate((element) => {
    const explicitSelector = "button, label, input, [role='button'], [role='tab'], [aria-selected], [aria-pressed], [aria-checked], [data-state]";
    const explicit = element.matches(explicitSelector) ? element : element.closest(explicitSelector);
    const candidates = [...new Set([element, explicit].filter((candidate): candidate is Element => candidate !== null))];
    for (const candidate of candidates) {
      if (candidate instanceof HTMLInputElement && ["checkbox", "radio"].includes(candidate.type)) return candidate.checked;
      const booleanAttributes = ["aria-selected", "aria-pressed", "aria-checked"]
        .map((attribute) => candidate.getAttribute(attribute))
        .filter((value): value is string => value !== null);
      if (booleanAttributes.length > 0) {
        const states = new Set(booleanAttributes.map((value) => value.toLowerCase()));
        if (states.size !== 1) return null;
        if (states.has("true")) return true;
        if (states.has("false")) return false;
        return null;
      }
      const dataState = candidate.getAttribute("data-state")?.toLowerCase();
      if (["active", "selected", "checked", "on"].includes(dataState ?? "")) return true;
      if (["inactive", "unselected", "unchecked", "off"].includes(dataState ?? "")) return false;
      const classTokens = `${candidate.getAttribute("class") ?? ""}`.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
      if (classTokens.some((token) => ["active", "selected", "checked", "current"].includes(token))) return true;
      if (classTokens.some((token) => ["inactive", "unselected", "unchecked"].includes(token))) return false;
    }
    return null;
  }).catch(() => null);
}

export async function readTmallActivePageEvidence(candidates: readonly Locator[]): Promise<{ matches: number; pageNumber: number | null }> {
  const visible: Locator[] = [];
  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
  }
  if (visible.length !== 1) return { matches: visible.length, pageNumber: null };
  const text = (await visible[0]!.innerText().catch(() => "")).trim();
  const pageNumber = /^\d+$/u.test(text) ? Number(text) : Number.NaN;
  return {
    matches: 1,
    pageNumber: Number.isSafeInteger(pageNumber) && pageNumber >= 1 ? pageNumber : null,
  };
}

export async function readTmallNextPageAvailability(
  candidates: readonly Locator[],
): Promise<"available" | "end" | "untrusted"> {
  const visible: Locator[] = [];
  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
  }
  if (visible.length !== 1) return "untrusted";
  return await visible[0]!.isDisabled().catch(() => false) ? "end" : "available";
}

export async function isRecognizedTmallDatePickerSurface(surface: Locator): Promise<boolean> {
  const monthHeadings = await surface.getByText(/^\s*\d{4}年\s*\d{1,2}月\s*$/u).count().catch(() => 0);
  const dateCells = await surface.locator("[data-value], [data-date], [title^='20'], [aria-label^='20']").count().catch(() => 0);
  return monthHeadings >= 1 && monthHeadings <= 2 && dateCells >= 7;
}

export async function waitForTmallListEvidenceChange(options: {
  previousEvidence: string | null;
  sample: () => Promise<string | null>;
  wait: () => Promise<void>;
  maxAttempts?: number;
  stableReads?: number;
}): Promise<string | null> {
  let candidate: string | null = null;
  let stableReads = 0;
  const requiredStableReads = options.stableReads ?? 3;
  for (let attempt = 0; attempt < (options.maxAttempts ?? 50); attempt += 1) {
    const evidence = await options.sample();
    if (evidence === null || (options.previousEvidence !== null && evidence === options.previousEvidence)) {
      candidate = null;
      stableReads = 0;
    } else if (candidate === evidence) {
      stableReads += 1;
    } else {
      candidate = evidence;
      stableReads = 1;
    }
    if (candidate !== null && stableReads >= requiredStableReads) return candidate;
    await options.wait();
  }
  return null;
}

export class TmallSessionExpiredError extends Error {
  constructor() {
    super("淘宝登录状态已失效");
    this.name = "TmallSessionExpiredError";
  }
}

type TmallReplySubmissionResult = {
  state: "sent" | "failed" | "uncertain";
  evidence: string;
  message?: string;
  failureOperationKey?: string;
};

export function tmallReplyTargetResolution(matchCount: number): TmallReplySubmissionResult | null {
  if (matchCount === 1) return null;
  if (matchCount === 0) {
    return {
      state: "uncertain",
      evidence: "提交前目标评价已从未回复列表消失",
      message: "目标评价已不在未回复列表中，等待平台记录确认",
      failureOperationKey: "reply.open",
    };
  }
  return {
    state: "failed",
    evidence: `目标评价匹配数量：${matchCount}`,
    message: "目标评价无法唯一识别",
    failureOperationKey: "reply.open",
  };
}

export function tmallSessionExpiredSubmissionFailure(error: unknown): TmallReplySubmissionResult | null {
  return error instanceof TmallSessionExpiredError
    ? {
        state: "failed",
        evidence: "登录状态已失效",
        message: error.message,
        failureOperationKey: "session.login",
      }
    : null;
}

export function tmallSubmissionInterruptionResult(
  error: unknown,
  submissionAttempted: boolean,
): TmallReplySubmissionResult | null {
  if (submissionAttempted) {
    return {
      state: "uncertain",
      evidence: "点击提交后页面操作中断",
      message: error instanceof TmallSessionExpiredError
        ? error.message
        : "提交后的平台结果暂时无法确认，已禁止自动重复提交",
      failureOperationKey: "reply.success",
    };
  }
  return tmallSessionExpiredSubmissionFailure(error);
}

export function isTmallHintedReplyTarget(expected: TmallReviewSnapshot, current: TmallReviewSnapshot | null): boolean {
  if (!current || expected.sourceKey !== current.sourceKey) return false;
  assertTmallSubmissionTargetIdentity(expected, current);
  return true;
}

export function assertUniqueTmallReviewSourceKeys(reviews: readonly TmallReviewSnapshot[]): void {
  const seen = new Set<string>();
  for (const review of reviews) {
    if (seen.has(review.sourceKey)) {
      throw new TmallReviewPageStateError("页面状态不可信：同一评价在当前页面重复出现");
    }
    seen.add(review.sourceKey);
  }
}

export function publicTmallSubmissionFailureMessage(error: unknown): string {
  if (error instanceof TmallSessionExpiredError) return error.message;
  if (error instanceof TmallBrowserOperationTimeoutError) return "淘宝页面操作超时，本条已安全跳过，将在下一轮重新读取";
  if (isTmallPageClosedError(error)) return "淘宝页面连接已中断，本条已安全跳过，将在下一轮重新读取";
  if (error instanceof TmallReviewPageStateError || error instanceof TmallDriverOperationError) return error.message;
  return "淘宝页面操作未完成，本条已安全跳过，将在下一轮重新读取";
}

export function tmallStableReviewListEvidence(reviews: readonly TmallReviewSnapshot[]): string | null {
  if (reviews.length === 0) return null;
  return reviews.map((review) => JSON.stringify([
    review.sourceKey,
    review.reviewPhase,
    review.itemId,
    review.orderId,
  ])).join("\u001e");
}

export function tmallStableReviewStructureEvidence(rows: readonly {
  orderId: string | null;
  reviewPhase: TmallReviewPhase;
  phaseMarker: string | null;
}[]): string | null {
  if (rows.length === 0 || rows.some((row) => !/^\d{8,}$/u.test(row.orderId ?? "") || !row.phaseMarker?.trim())) return null;
  return rows.map((row) => JSON.stringify([
    row.orderId,
    row.reviewPhase,
    row.phaseMarker,
  ])).join("\u001e");
}

export async function resolveTmallTopLevelOverlays(candidates: readonly Locator[]): Promise<Locator[]> {
  const unique: Array<{ locator: Locator; handle: Awaited<ReturnType<Locator["elementHandle"]>> }> = [];
  try {
    for (const locator of candidates) {
      if (!await locator.isVisible().catch(() => false)) continue;
      const blocksPage = await locator.evaluate((element) => {
        const className = typeof (element as HTMLElement).className === "string"
          ? (element as HTMLElement).className.toLowerCase()
          : "";
        if (!className.includes("mask")) return true;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
        const coverage = Math.max(0, rect.width) * Math.max(0, rect.height) / viewportArea;
        return (style.position === "fixed" || style.position === "absolute") && coverage >= 0.25;
      }).catch(() => false);
      if (!blocksPage) continue;
      const handle = await locator.elementHandle().catch(() => null);
      if (!handle) continue;
      let duplicate = false;
      for (const existing of unique) {
        if (await existing.locator.evaluate((element, other) => element === other, handle).catch(() => false)) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) await handle.dispose();
      else unique.push({ locator, handle });
    }

    const roots: Locator[] = [];
    for (const [index, candidate] of unique.entries()) {
      let nested = false;
      for (const [otherIndex, possibleParent] of unique.entries()) {
        if (index === otherIndex) continue;
        if (await possibleParent.locator.evaluate(
          (parent, child) => parent !== child && parent.contains(child as Node),
          candidate.handle,
        ).catch(() => false)) {
          nested = true;
          break;
        }
      }
      if (!nested) roots.push(candidate.locator);
    }
    return roots;
  } finally {
    await Promise.all(unique.map(({ handle }) => handle?.dispose().catch(() => undefined)));
  }
}

export function decideTmallOverlayDisposition(input: {
  containsAllowedReplyControls: boolean;
  recognizedDatePicker: boolean;
  text: string;
}): "allow_reply" | "allow_date_picker" | "manual_action" {
  if (input.containsAllowedReplyControls) return "allow_reply";
  if (input.recognizedDatePicker) return "allow_date_picker";
  return "manual_action";
}

export class TmallDriverOperationError extends Error {
  constructor(readonly operationKey: string, message: string) {
    super(message);
    this.name = "TmallDriverOperationError";
  }
}

function roleNameOptions(name: string | undefined): { name: string | RegExp; exact?: boolean } | undefined {
  if (!name) return undefined;
  const alternatives = name.split("|").map((item) => item.trim()).filter(Boolean);
  if (alternatives.length <= 1) return { name, exact: true };
  const escaped = alternatives.map((item) => item.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return { name: new RegExp(`^(?:${escaped.join("|")})$`, "u") };
}

export class PlaywrightTmallAuthDriver implements TmallAuthDriver {
  readonly canSubmitReplies = true;
  readonly #profileDirectory: string;
  readonly #headless: boolean;
  readonly #humanActions: TmallHumanActions;
  readonly #browserExecutablePath: () => string | null;
  #context: BrowserContext | null = null;
  #authenticationPage: Page | null = null;
  #locatorProvider: ((operationKey: string) => { strategy: string; selector: string } | null) | null = null;
  #lastVerifiedNavigationAt: number | null = null;
  #lastReviewScope: ResolvedReviewScope | null = null;
  #lastReviewPageSize: number | null = null;
  #currentOperationKey: string | null = null;
  readonly #reviewPageHints = new Map<string, number>();
  readonly #reviewTargetHints = new Map<string, TmallReviewTargetHint>();
  #activeReviewContext: TmallReviewTargetHint | null = null;
  #knownReviewPageCount: { contextKey: string; totalPages: number } | null = null;
  #launchAllowed = true;

  constructor(options: PlaywrightTmallAuthDriverOptions) {
    this.#profileDirectory = resolve(options.profileDirectory);
    if (basename(this.#profileDirectory).toLowerCase() !== "browser-profile") {
      throw new Error("浏览器资料目录必须使用专用 browser-profile 目录");
    }
    this.#headless = options.headless ?? false;
    this.#humanActions = options.humanActions ?? createHumanActions();
    this.#browserExecutablePath = options.browserExecutablePath ?? (() => null);
  }

  setLocatorProvider(provider: (operationKey: string) => { strategy: string; selector: string } | null): void {
    this.#locatorProvider = provider;
  }

  setLaunchAllowed(allowed: boolean): void {
    this.#launchAllowed = allowed;
  }

  getCurrentOperationKey(): string | null {
    return this.#currentOperationKey;
  }

  async #page(): Promise<Page> {
    const previousContext = this.#context;
    const acquired = await acquireLiveTmallPage(this.#context, async () => {
      await mkdir(this.#profileDirectory, { recursive: true });
      return launchTmallBrowserContext({
        profileDirectory: this.#profileDirectory,
        headless: this.#headless,
        executablePath: this.#browserExecutablePath(),
      });
    }, { allowLaunch: this.#launchAllowed });
    if (acquired.context !== previousContext) {
      this.#context = acquired.context;
      const liveContext = acquired.context;
      liveContext.once("close", () => {
        if (this.#context !== liveContext) return;
        this.#context = null;
        this.#authenticationPage = null;
        this.#activeReviewContext = null;
        this.#knownReviewPageCount = null;
        this.#launchAllowed = false;
      });
    }
    return acquired.page;
  }

  async #replacementAuthenticationPage(): Promise<Page> {
    await this.#context?.close().catch(() => undefined);
    this.#context = null;
    this.#authenticationPage = null;
    const page = await this.#page();
    this.#authenticationPage = page;
    await page.bringToFront();
    return page;
  }

  async openReviewPage(credentials: TmallCredentials): Promise<TmallAuthResult> {
    this.#launchAllowed = true;
    this.#lastVerifiedNavigationAt = null;
    const page = await this.#page();
    this.#authenticationPage = page;
    const startedAt = Date.now();
    try {
      writeTmallNavigationDiagnostic("open.home.start", { path: safeTmallPath(page.url()) });
      await navigateTmallPageWithTransientRetry(
        () => page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }),
        () => this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.successPoll),
      );
      writeTmallNavigationDiagnostic("open.home.ready", { path: safeTmallPath(page.url()), elapsedMs: Date.now() - startedAt });
      await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.directNavigationAfter);
      if (await this.#isLoginPage(page)) {
        writeTmallNavigationDiagnostic("open.login.detected", { elapsedMs: Date.now() - startedAt });
        const initialState = await this.#readAuthenticationPageState(page);
        if (initialState === "manual_verification_required" || initialState === "manual_action_required") {
          await page.bringToFront();
          return this.#authenticationResult(initialState);
        }
        if (initialState === "onboarding_or_safe_guide") {
          const dismissal = await this.#closeKnownPopup(page);
          if (dismissal === "manual_action_required") {
            await page.bringToFront();
            return this.#authenticationResult("manual_action_required");
          }
        }
        await this.#login(page, credentials);
        const outcome = await this.#waitForAuthenticationOutcome(page);
        if (outcome && outcome !== "onboarding_or_safe_guide") {
          await page.bringToFront();
          return this.#authenticationResult(outcome);
        }
      }
      const result = await this.#continueFromCurrentPageWithTransientRetry(page, credentials);
      writeTmallNavigationDiagnostic("open.complete", { state: result.state, path: safeTmallPath(page.url()), elapsedMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      writeTmallNavigationDiagnostic("open.failed", {
        errorType: error instanceof Error ? error.name : "unknown",
        operationKey: error instanceof TmallDriverOperationError ? error.operationKey : null,
        path: safeTmallPath(page.url()),
        elapsedMs: Date.now() - startedAt,
      });
      await page.bringToFront().catch(() => undefined);
      return {
        state: "navigation_failed",
        page: await this.#isLoginPage(page).catch(() => false) ? "login" : "review_list",
        message: publicTmallNavigationFailureMessage(error),
        ...(error instanceof TmallDriverOperationError ? { failureOperationKey: error.operationKey } : {}),
      };
    }
  }

  async continueReviewPage(credentials?: TmallCredentials): Promise<TmallAuthResult> {
    this.#launchAllowed = true;
    const fallback = await this.#page();
    const page = selectTmallAuthenticationPage(
      this.#context?.pages() ?? [fallback],
      this.#authenticationPage ?? fallback,
    ) ?? fallback;
    this.#authenticationPage = page;
    const startedAt = Date.now();
    try {
      await page.bringToFront();
      writeTmallNavigationDiagnostic("continue.start", { path: safeTmallPath(page.url()) });
      if (shouldNavigateTmallSessionHome(page.url())) {
        await navigateTmallPageWithTransientRetry(
          () => page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }),
          () => this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.successPoll),
        );
        await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.directNavigationAfter);
      }
      const result = await this.#continueFromCurrentPageWithTransientRetry(page, credentials);
      writeTmallNavigationDiagnostic("continue.complete", { state: result.state, path: safeTmallPath(page.url()), elapsedMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      writeTmallNavigationDiagnostic("continue.failed", {
        errorType: error instanceof Error ? error.name : "unknown",
        operationKey: error instanceof TmallDriverOperationError ? error.operationKey : null,
        path: safeTmallPath(page.url()),
        elapsedMs: Date.now() - startedAt,
      });
      await page.bringToFront().catch(() => undefined);
      const state = await this.#readAuthenticationPageState(page).catch(() => null);
      if (state) return this.#authenticationResult(state);
      return {
        state: "navigation_failed",
        page: await this.#isLoginPage(page).catch(() => false) ? "login" : "review_list",
        message: publicTmallNavigationFailureMessage(error, "淘宝页面暂时无法进入评价管理，请处理当前页面后继续检测"),
        ...(error instanceof TmallDriverOperationError ? { failureOperationKey: error.operationKey } : {}),
      };
    }
  }

  async readPendingReviews(limit: number, scope: ResolvedReviewScope): Promise<TmallReviewSnapshot[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("评论读取数量必须在 1 到 100 之间");
    return this.readPendingReviewPage(1, limit, scope);
  }

  async readPendingReviewPage(pageNumber: number, pageSize: number, scope: ResolvedReviewScope, phase: ReviewScanPhase = "initial", mode: ReviewFilterMode = "content_unanswered"): Promise<TmallReviewSnapshot[]> {
    return (await this.readPendingReviewPageState(pageNumber, pageSize, scope, phase, mode)).items;
  }

  async readPendingReviewPageState(pageNumber: number, pageSize: number, scope: ResolvedReviewScope, phase: ReviewScanPhase = "initial", mode: ReviewFilterMode = "content_unanswered"): Promise<{ items: TmallReviewSnapshot[]; hasNextPage: boolean }> {
    tmallReviewPageUrl(pageNumber, pageSize);
    const contextKey = this.#reviewContextKey(pageSize, scope, phase, mode);
    if (this.#knownReviewPageCount?.contextKey === contextKey && pageNumber > this.#knownReviewPageCount.totalPages) {
      return { items: [], hasNextPage: false };
    }
    const page = await this.#page();
    if (await this.#isLoginPage(page)) throw new TmallSessionExpiredError();
    const currentPage = this.#requestedPageFromUrl(page.url(), pageSize) ?? 1;
    let navigation: "ready" | "end" = "ready";
    for (const targetPage of tmallReviewPageNavigationTargets(currentPage, pageNumber)) {
      navigation = await this.#openReviewDataPage(page, targetPage, pageSize, scope, phase, mode);
    }
    if (navigation === "end") return { items: [], hasNextPage: false };

    const visibleReviews = await this.#readVisiblePendingReviews(pageSize, phase, mode);
    const snapshots = visibleReviews.map((item) => item.snapshot);
    const totalCount = await this.#reviewTotalCount(page);
    this.#knownReviewPageCount = totalCount === null
      ? null
      : { contextKey, totalPages: tmallReviewTotalPages(totalCount, pageSize) };
    const nextPageAvailability = totalCount === null ? await this.#nextReviewPageAvailability(page) : null;
    if (totalCount === null && nextPageAvailability === "untrusted") {
      throw new TmallDriverOperationError("review.pagination", "评价列表下一页状态无法安全确认");
    }
    const hasNextPage = totalCount === null
      ? nextPageAvailability === "available"
      : pageNumber < tmallReviewTotalPages(totalCount, pageSize);
    this.#lastReviewScope = scope;
    this.#lastReviewPageSize = pageSize;
    for (const { snapshot, nativeReplyActionIndex } of visibleReviews) {
      this.#reviewPageHints.set(snapshot.sourceKey, pageNumber);
      this.#reviewTargetHints.set(snapshot.sourceKey, { page: pageNumber, pageSize, scope, phase, mode, nativeReplyActionIndex });
    }
    return { items: snapshots, hasNextPage };
  }

  async verifyCriticalElements(
    scope: ResolvedReviewScope,
    options: { includeReplyControls?: boolean } = {},
  ): Promise<TmallElementVerificationResult> {
    const page = await this.#page();
    this.#currentOperationKey = "review.date.trigger";
    const navigationKeys = ["navigation.trade", "navigation.reviews"];
    const filterKeys = [
      "review.filter.buyer",
      "review.filter.content",
      "review.filter.unanswered",
      "review.filter.followup",
      "review.date.trigger",
      "review.search",
    ];
    const rowKeys = options.includeReplyControls
      ? ["review.list", "review.product", "reply.open", "reply.editor", "reply.submit"]
      : ["review.list", "review.product", "reply.open"];
    const navigationWasJustVerified = this.#lastVerifiedNavigationAt !== null
      && Date.now() - this.#lastVerifiedNavigationAt < 2 * 60_000
      && /\/comment-manage\/list\/rateWait4PC/u.test(page.url());
    const verified = new Set<string>(navigationWasJustVerified ? navigationKeys : []);
    const navigationMissing = navigationKeys.filter((key) => !verified.has(key));
    try {
      await this.#waitForReviewFilterSurface(page);
      await this.#applyReviewScope(page, scope);
      this.#currentOperationKey = "review.search";
      for (const key of filterKeys.filter((key) => key !== "review.search")) verified.add(key);
      const search = await this.#visibleLocators(await this.#registeredLocator(
        page,
        "review.search",
        () => page.getByRole("button", { name: "搜索", exact: true }),
      ).all());
      if (search.length === 1) verified.add("review.search");
    } catch {
      return {
        verifiedOperationKeys: [...verified],
        // The filter surface failed before a review row was inspected. Row
        // and reply controls are conditional here, not known failures.
        missingOperationKeys: [...navigationMissing, ...filterKeys],
      };
    }
    if (!verified.has("review.search")) {
      return {
        verifiedOperationKeys: [...verified],
        missingOperationKeys: [...navigationMissing, "review.search", ...rowKeys],
      };
    }
    this.#currentOperationKey = "reply.open";
    const actions = await this.#registeredLocator(page, "reply.open", () => page.getByText(/^(评价回复|追评回复)$/u)).all();
    if (actions.length === 0) {
      const pendingQueueText = await this.#pendingQueueRegionText(page);
      if (navigationMissing.length === 0 && pendingQueueText && isVerifiedEmptyPendingQueue(pendingQueueText)) {
        return { verifiedOperationKeys: [...verified], missingOperationKeys: [], queueEmpty: true };
      }
      return { verifiedOperationKeys: [...verified], missingOperationKeys: [...navigationMissing, ...rowKeys] };
    }
    this.#currentOperationKey = "review.list";
    const reviewRowScope = await this.#findReviewScope(actions[0]!);
    if (!reviewRowScope) return { verifiedOperationKeys: [...verified], missingOperationKeys: [...navigationMissing, ...rowKeys] };
    this.#currentOperationKey = "review.product";
    await this.#snapshotFromScope(reviewRowScope, 0, reviewPhaseFromReplyAction(await actions[0]!.innerText()));
    verified.add("review.list");
    verified.add("review.product");
    verified.add("reply.open");
    if (!options.includeReplyControls) {
      this.#currentOperationKey = null;
      const required = [...navigationKeys, ...filterKeys, ...rowKeys];
      return { verifiedOperationKeys: [...verified], missingOperationKeys: required.filter((key) => !verified.has(key)) };
    }
    this.#currentOperationKey = "reply.open";
    await this.#humanActions.click(actions[0]!);
    await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.replyOpenAfter);
    const dialog = page.getByRole("dialog").last();
    this.#currentOperationKey = "reply.editor";
    let visibleEditors = await this.#resolveReplyEditors([reviewRowScope, dialog]);
    this.#currentOperationKey = "reply.submit";
    let visibleButtons = await this.#resolveReplySubmitButtons([reviewRowScope, dialog], false);
    if (visibleEditors.length !== 1 || visibleButtons.length !== 1) {
      const discovered = await this.#resolveUniqueOpenedReplySurface(page, false);
      visibleEditors = discovered.editors;
      visibleButtons = discovered.buttons;
    }
    if (visibleEditors.length === 1) verified.add("reply.editor");
    if (visibleButtons.length === 1) verified.add("reply.submit");
    const required = [...navigationKeys, ...filterKeys, ...rowKeys];
    const missingOperationKeys = required.filter((key) => !verified.has(key));
    // Keep the opened reply surface available only when a high-risk control
    // is missing so the runtime repair snapshot is captured from the exact
    // failing state. Successful verification closes the read-only surface.
    if (!missingOperationKeys.includes("reply.editor") && !missingOperationKeys.includes("reply.submit")) {
      await page.keyboard.press("Escape").catch(() => undefined);
    }
    this.#currentOperationKey = null;
    return { verifiedOperationKeys: [...verified], missingOperationKeys };
  }

  async #readVisiblePendingReviews(limit: number, phase: ReviewScanPhase, mode: ReviewFilterMode): Promise<TmallVisibleReview[]> {
    const page = await this.#page();
    // Include phase-specific platform history markers as row anchors. They
    // are read-only reconciliation evidence: submitReply still resolves only
    // the real 评价回复/追评回复 controls, so a history marker can never be clicked.
    const actions = await this.#visibleLocators(await page.getByText(
      /^(评价回复|追评回复|投诉评价记录|投诉追评记录|评价回复记录|追评回复记录)$/u,
    ).all());
    if (actions.length === 0) {
      const pendingQueueText = await this.#pendingQueueRegionText(page);
      if (!pendingQueueText) throw new TmallDriverOperationError("review.list", "无法确认未回复评价列表是否为空");
      const countMatch = pendingQueueText.match(/共\s*(\d+)\s*条/u);
      if (!countMatch) throw new TmallDriverOperationError("review.list", "无法确认未回复评价数量");
      const pendingCount = Number(countMatch[1]);
      if (pendingCount > 0) {
        const nativeReplyActions = await page.getByText(/^(评价回复|追评回复)$/u).count().catch(() => 0);
        if (nativeReplyActions > 0) throw new TmallDriverOperationError("reply.open", "评价回复入口无法识别");
        const nonReplyableMarkers = await page.getByText(/^(投诉评价记录|投诉追评记录|评价回复记录|追评回复记录|已回复|已超过回复期限|回复已关闭)$/u).count().catch(() => 0);
        if (nonReplyableMarkers === 0) throw new TmallDriverOperationError("review.list", "当前页评价状态无法安全确认");
      }
    }
    const visibleReviews: TmallVisibleReview[] = [];
    let nativeReplyActionIndex = -1;

    for (const [rowIndex, action] of actions.slice(0, limit).entries()) {
      const scope = await this.#findReviewScope(action);
      if (!scope) throw new TmallDriverOperationError("review.list", `第 ${rowIndex + 1} 条评论的页面区域无法唯一识别`);
      const actionText = await action.innerText();
      const isNativeReplyAction = /^(评价回复|追评回复)$/u.test(actionText.trim());
      if (isNativeReplyAction) nativeReplyActionIndex += 1;
      const reviewPhase = reviewPhaseFromReplyAction(actionText);
      if (!shouldIncludeTmallReplyActionForScan(actionText, phase, mode)) continue;
      const snapshot = await this.#snapshotFromScope(scope, rowIndex, reviewPhase).catch((error: unknown) => {
        if (error instanceof TmallReviewPageStateError) throw error;
        throw new TmallDriverOperationError("review.product", `第 ${rowIndex + 1} 条评论的商品或评价信息无法识别`);
      });
      visibleReviews.push({
        snapshot,
        nativeReplyActionIndex: isNativeReplyAction ? nativeReplyActionIndex : null,
      });
    }
    assertUniqueTmallReviewSourceKeys(visibleReviews.map((item) => item.snapshot));
    return visibleReviews;
  }

  async submitReply(
    review: TmallReviewSnapshot,
    finalReply: string,
    control: TmallReplySubmissionControl = {},
  ): Promise<TmallReplySubmissionResult> {
    const assertActive = () => {
      if (control.shouldContinue?.() === false) throw new TmallOperationCancelledError();
    };
    assertActive();
    const page = await this.#page();
    assertActive();
    if (await this.#isLoginPage(page)) return { state: "failed", evidence: "登录状态已失效", message: "淘宝登录状态已失效", failureOperationKey: "session.login" };
    if (!finalReply.trim()) return { state: "failed", evidence: "回复内容为空", message: "回复内容为空" };
    try {
      const hint = this.#reviewTargetHints.get(review.sourceKey) ?? null;
      if (hint && !this.#isActiveReviewContext(hint)) {
        assertActive();
        const navigation = await this.#openReviewDataPage(page, hint.page, hint.pageSize, hint.scope, hint.phase, hint.mode);
        if (navigation === "end") {
          return { state: "failed", evidence: "目标评价所在分页已经变化", message: "目标评价所在分页已经变化，将在下一轮重新获取" };
        }
      }
      assertActive();
      await this.#assertSafeReviewPage(page);
    } catch (error) {
      const sessionFailure = tmallSessionExpiredSubmissionFailure(error);
      if (sessionFailure) return sessionFailure;
      throw error;
    }
    assertActive();
    assertActive();
    await this.#closeKnownPopup(page);
    assertActive();
    const actions = await this.#registeredLocator(page, "reply.open", () => page.getByText(/^(评价回复|追评回复)$/u)).all();
    const matches: Array<{ action: Locator; scope: Locator }> = [];
    const hint = this.#reviewTargetHints.get(review.sourceKey) ?? null;
    const hintedIndex = hint?.nativeReplyActionIndex;
    if (hint && this.#isActiveReviewContext(hint) && typeof hintedIndex === "number" && hintedIndex >= 0) {
      assertActive();
      const action = actions[hintedIndex];
      if (action) {
        const scope = await this.#findReviewScope(action);
        if (scope) {
          const candidate = await this.#snapshotFromScope(
            scope,
            hintedIndex,
            reviewPhaseFromReplyAction(await action.innerText()),
          ).catch((error: unknown) => {
            if (error instanceof TmallReviewPageStateError) throw error;
            return null;
          });
          if (isTmallHintedReplyTarget(review, candidate)) matches.push({ action, scope });
        }
      }
    }
    if (matches.length === 0) {
      for (const [rowIndex, action] of actions.entries()) {
        assertActive();
        const scope = await this.#findReviewScope(action);
        if (!scope) continue;
        const candidate = await this.#snapshotFromScope(scope, rowIndex, reviewPhaseFromReplyAction(await action.innerText())).catch((error: unknown) => {
          if (error instanceof TmallReviewPageStateError) throw error;
          return null;
        });
        if (candidate?.sourceKey === review.sourceKey) {
          assertTmallSubmissionTargetIdentity(review, candidate);
          matches.push({ action, scope });
        }
      }
    }
    const targetResolution = tmallReplyTargetResolution(matches.length);
    if (targetResolution) return targetResolution;

    const target = matches[0]!;
    let clickedSubmit = false;
    let openedReplyDialog: Locator | null = null;
    try {
      assertActive();
      await this.#humanActions.click(target.action);
      await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.replyOpenAfter);
      assertActive();
      if (await this.#isLoginPage(page)) throw new TmallSessionExpiredError();
      if (await this.#needsManualVerification(page)) throw new TmallReviewPageStateError("页面需要验证码或安全验证");
      const dialog = page.getByRole("dialog").last();
      openedReplyDialog = dialog;
      let editors = await this.#resolveReplyEditors([target.scope, dialog]);
      let buttons = await this.#resolveReplySubmitButtons([target.scope, dialog]);
      if (editors.length !== 1 || buttons.length !== 1) {
        const discovered = await this.#resolveUniqueOpenedReplySurface(page);
        editors = discovered.editors;
        buttons = discovered.buttons;
      }
      if (editors.length !== 1) return { state: "failed", evidence: `可见回复框数量：${editors.length}`, message: "回复输入框无法唯一识别", failureOperationKey: "reply.editor" };
      assertActive();
      await this.#humanActions.click(editors[0]!);
      await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.editorFocusAfter);
      assertActive();
      await editors[0]!.fill(finalReply);
      await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.replyFillAfter);
      assertActive();

      if (buttons.length !== 1) return { state: "failed", evidence: `可见提交按钮数量：${buttons.length}`, message: "回复提交按钮无法唯一识别", failureOperationKey: "reply.submit" };
      await this.#assertSafeReviewPage(page, [editors[0]!, buttons[0]!]);
      assertActive();
      control.beforeSubmit?.();
      assertActive();
      // The reply text and the exact platform submit control are already
      // verified above. Submit immediately instead of adding another
      // artificial pre-click pause that makes the dialog look stuck.
      clickedSubmit = true;
      await buttons[0]!.click();
      await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.submitAfter);
      this.#reviewPageHints.delete(review.sourceKey);
      this.#reviewTargetHints.delete(review.sourceKey);
      if (hint && typeof hintedIndex === "number") {
        const contextKey = this.#reviewContextKey(hint.pageSize, hint.scope, hint.phase, hint.mode);
        for (const targetHint of this.#reviewTargetHints.values()) {
          if (targetHint.page !== hint.page) continue;
          if (this.#reviewContextKey(targetHint.pageSize, targetHint.scope, targetHint.phase, targetHint.mode) !== contextKey) continue;
          if (typeof targetHint.nativeReplyActionIndex === "number" && targetHint.nativeReplyActionIndex > hintedIndex) {
            targetHint.nativeReplyActionIndex -= 1;
          }
        }
      }
      return { state: "sent", evidence: "已点击回复提交按钮" };
    } catch (error) {
      const interruption = tmallSubmissionInterruptionResult(error, clickedSubmit);
      if (interruption) return interruption;
      const sessionFailure = await this.#isLoginPage(page).catch(() => false)
        ? tmallSessionExpiredSubmissionFailure(new TmallSessionExpiredError())
        : null;
      if (sessionFailure) return sessionFailure;
      if (!clickedSubmit && await this.#needsManualVerification(page).catch(() => false)) {
        throw new TmallReviewPageStateError("页面需要验证码或安全验证");
      }
      if (error instanceof TmallReviewPageStateError && !clickedSubmit) throw error;
      const message = publicTmallSubmissionFailureMessage(error);
      return { state: "failed", evidence: "提交前页面操作失败", message };
    } finally {
      // A pre-submit failure must not leave the reply modal covering the list;
      // otherwise the next batch read stops at “checking for new reviews”.
      if (!clickedSubmit && openedReplyDialog && control.shouldContinue?.() !== false) {
        const controls = await resolveTmallReplyDismissControls(openedReplyDialog).catch(() => []);
        if (controls.length === 1) await controls[0]!.click({ timeout: 3_000 }).catch(() => undefined);
      }
    }
  }

  async executeComplaint(input: TmallComplaintExecutionInput): Promise<TmallComplaintExecutionResult> {
    if (!input.sourceKey || !input.description.trim()) {
      return { state: "failed", evidence: "投诉目标或描述不能为空", message: "投诉信息不完整，未进入提交页面" };
    }
    const page = await this.#page();
    try {
      const hint = this.#reviewTargetHints.get(input.sourceKey) ?? null;
      if (hint && !this.#isActiveReviewContext(hint)) {
        const navigation = await this.#openReviewDataPage(page, hint.page, hint.pageSize, hint.scope, hint.phase, hint.mode);
        if (navigation === "end") {
          return { state: "failed", evidence: "目标评价所在分页已经变化", message: "目标评价所在分页已经变化，将在下一轮重新获取" };
        }
      }
      await this.#assertSafeReviewPage(page);
    } catch (error) {
      const message = publicTmallSubmissionFailureMessage(error);
      return { state: "failed", evidence: "投诉前页面检查未通过", message };
    }
    const adapter = createTmallComplaintDomAdapter(page, {
      identifyRow: async (scope, rowIndex, phase) => {
        const snapshot = await this.#snapshotFromScope(scope, rowIndex, phase).catch(() => null);
        return snapshot ? { sourceKey: snapshot.sourceKey, reviewPhase: snapshot.reviewPhase } : null;
      },
      click: async (locator) => {
        await this.#humanActions.click(locator);
        await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.replyOpenAfter);
      },
      fill: async (locator, value) => {
        await this.#humanActions.click(locator);
        await locator.fill(value);
        await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.replyFillAfter);
      },
      beforeSubmitClick: async () => {
        // The DOM adapter has just re-read sourceKey/phase, official type,
        // description and both safety sentinels. Only now perform the final
        // session/store check and save the durable click checkpoint.
        if (await this.#isLoginPage(page)) throw new TmallSessionExpiredError();
        if (await this.#needsManualVerification(page)) throw new TmallReviewPageStateError("页面需要验证码或安全验证");
        input.beforeSubmit?.();
      },
    });

    try {
      const result = await executeComplaintBrowserFlow({
        target: { sourceKey: input.sourceKey, reviewPhase: input.reviewPhase },
        complaintType: input.complaintType,
        description: input.description,
        mode: input.mode,
        adapter,
      });
      return mapTmallComplaintBrowserResult(result);
    } catch (error) {
      if (error instanceof TmallSessionExpiredError) {
        return { state: "failed", evidence: "登录状态已失效", message: "淘宝登录状态已失效，投诉未提交" };
      }
      const message = publicTmallSubmissionFailureMessage(error);
      return { state: "failed", evidence: "投诉页面操作失败", message };
    }
  }

  async diagnoseKnownPopups(): Promise<TmallPopupDomDiagnostic> {
    const fallback = await this.#page();
    const page = selectTmallAuthenticationPage(
      this.#context?.pages() ?? [fallback],
      this.#authenticationPage ?? fallback,
    ) ?? fallback;
    const headings = await this.#visibleLocators(await page.getByText(/^(重要消息|新手引导|功能升级|评价智能分析上线)$/u).all());
    const popups: TmallPopupDomDiagnostic["popups"] = [];
    for (const heading of headings) {
      let scope = heading.locator("..");
      for (let level = 0; level < 7; level += 1) {
        const popupKey = tmallSafePopupKey(await scope.innerText().catch(() => ""));
        if (popupKey) {
          const controls = await scope.locator("button, [role], [aria-label], [title], [class*='close' i], svg").evaluateAll((elements) => elements.slice(0, 50).map((element) => {
            const html = element as HTMLElement;
            const parent = html.parentElement;
            return {
              tag: html.tagName.toLowerCase(),
              role: html.getAttribute("role"),
              ariaLabel: html.getAttribute("aria-label"),
              title: html.getAttribute("title"),
              className: typeof html.className === "string" ? html.className.slice(0, 200) : "",
              text: (html.innerText ?? html.textContent ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 20),
              parentTag: parent?.tagName.toLowerCase() ?? null,
              parentRole: parent?.getAttribute("role") ?? null,
              parentClassName: typeof parent?.className === "string" ? parent.className.slice(0, 200) : "",
            };
          }));
          popups.push({ popupKey, controls });
          break;
        }
        scope = scope.locator("..");
      }
    }
    const diagnosticBodyText = await page.locator("body").innerText().catch(() => "");
    const replyEditors = await this.#visibleEditableLocators(await page.locator(
      "textarea, [contenteditable='true'], [role='textbox']",
    ).all());
    const nearbyButtonLabels: string[] = [];
    if (replyEditors.length === 1) {
      let container = replyEditors[0]!.locator("xpath=..");
      for (let depth = 0; depth < 8 && nearbyButtonLabels.length === 0; depth += 1) {
        const labels = await container.locator("button, [role='button'], input[type='button'], input[type='submit']")
          .evaluateAll((elements) => elements.map((element) => {
            const html = element as HTMLElement;
            return (html.innerText || html.getAttribute("aria-label") || html.getAttribute("title")
              || (element as HTMLInputElement).value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
          }).filter(Boolean).slice(0, 20));
        nearbyButtonLabels.push(...labels.filter((label) =>
          Array.from(label).length <= 16 && /回复|提交|确认|发布|发送|保存|完成|取消|关闭/u.test(label)));
        container = container.locator("xpath=..");
      }
    }
    return {
      location: await this.#isLoginPage(page)
        ? "login"
        : /\/comment-manage\/list\/rateWait4PC/u.test(page.url()) ? "review_list" : "other",
      pagePath: (() => { try { return new URL(page.url()).pathname; } catch { return ""; } })(),
      readyState: await page.evaluate(() => document.readyState).catch(() => "unavailable"),
      bodyTextLength: Array.from(diagnosticBodyText).length,
      bodyStatusSample: diagnosticBodyText.normalize("NFKC").replace(/[A-Za-z0-9_-]{2,}/gu, "[已省略]").replace(/\s+/gu, " ").trim().slice(0, 300),
      controlCounts: {
        buyer: await page.getByText("来自买家的评价", { exact: true }).count(),
        content: await page.getByText("有内容", { exact: true }).count(),
        followup: await page.getByText("有追评", { exact: true }).count(),
        unanswered: await page.getByText("未回复", { exact: true }).count(),
        search: await page.getByRole("button", { name: "搜索", exact: true }).count(),
        initialReply: await page.getByText("评价回复", { exact: true }).count(),
        followupReply: await page.getByText("追评回复", { exact: true }).count(),
      },
      replySurface: {
        editableCount: replyEditors.length,
        nearbyButtonLabels: [...new Set(nearbyButtonLabels)],
        dialogFooterButtonLabels: await page.locator(".next-dialog-footer button")
          .evaluateAll((elements) => elements.slice(0, 6).map((element) =>
            ((element as HTMLElement).innerText || element.getAttribute("aria-label") || "")
              .normalize("NFKC").replace(/\s+/gu, " ").trim()).filter((label) => Array.from(label).length <= 16)),
      },
      dateInputs: await page.locator("input").evaluateAll((inputs) => inputs.map((input) => ({
        placeholder: input.getAttribute("placeholder") ?? "",
        value: (input as HTMLInputElement).value,
      })).filter((input) => /日期/u.test(input.placeholder) || /^\d{4}-\d{2}-\d{2}$/u.test(input.value)).slice(0, 10)),
      visibleOverlays: await Promise.all((await this.#visibleLocators(
        await page.locator(TMALL_TOP_LEVEL_OVERLAY_SELECTOR).all(),
      )).slice(0, 30).map(async (overlay) => ({
        ...(await overlay.evaluate((element) => ({
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          ariaModal: element.getAttribute("aria-modal"),
          className: typeof (element as HTMLElement).className === "string"
            ? (element as HTMLElement).className.slice(0, 300)
            : "",
        }))),
        popupKey: tmallSafePopupKey(await overlay.innerText().catch(() => "")),
      }))),
      popups,
    };
  }

  async captureSemanticSnapshot(): Promise<SemanticElementSnapshot[]> {
    const page = await this.#page();
    return page.locator("input, button, a, [role], [aria-label], [placeholder]").evaluateAll((elements) => elements.slice(0, 200).map((element) => {
      const html = element as HTMLElement;
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? undefined,
        name: ["BUTTON", "A"].includes(element.tagName) ? (html.innerText ?? "").trim().slice(0, 120) : undefined,
        placeholder: element.getAttribute("placeholder") ?? undefined,
        ariaLabel: element.getAttribute("aria-label") ?? undefined,
        classes: Array.from(element.classList).slice(0, 8),
      };
    }));
  }

  async probeLocatorCandidate(input: { operationKey: string; strategy: string; selector: string }): Promise<LocatorProbeResult> {
    const page = await this.#page();
    let candidate: Locator;
    if (input.strategy === "text") candidate = page.getByText(input.selector, { exact: true });
    else if (input.strategy === "placeholder") candidate = page.getByPlaceholder(input.selector, { exact: true });
    else if (input.strategy === "css") candidate = page.locator(input.selector);
    else {
      const separator = input.selector.indexOf(":");
      const role = separator > 0 ? input.selector.slice(0, separator) : input.selector;
      const name = separator > 0 ? input.selector.slice(separator + 1) : undefined;
      candidate = page.getByRole(role as Parameters<Page["getByRole"]>[0], roleNameOptions(name));
    }
    const count = await candidate.count().catch(() => 0);
    const uniqueVisible = count === 1 && await candidate.first().isVisible().catch(() => false);
    const semanticEvidence = uniqueVisible
      ? await candidate.first().evaluate((element) => ({
        text: (element as HTMLElement).innerText ?? element.textContent ?? "",
        ariaLabel: element.getAttribute("aria-label"),
        placeholder: element.getAttribute("placeholder"),
        role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
      })).catch(() => null)
      : null;
    const semanticValid = semanticEvidence !== null
      && locatorCandidateMatchesOperationSemantic(input.operationKey, semanticEvidence);
    const unique = uniqueVisible && semanticValid;
    const enabled = unique && await candidate.first().isEnabled().catch(() => false);
    const editable = unique && await candidate.first().isEditable().catch(() => false);
    let postconditionPassed = input.operationKey === "reply.editor" || input.operationKey === "login.account" || input.operationKey === "login.password" ? editable : enabled;
    if (unique && enabled && input.operationKey === "navigation.trade") {
      await this.#humanActions.click(candidate.first());
      await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.tradeNavigationAfter);
      postconditionPassed = await this.#registeredLocator(page, "navigation.reviews", () => page.getByText("评价管理", { exact: true })).first().isVisible({ timeout: 5_000 }).catch(() => false);
    } else if (unique && enabled && input.operationKey === "navigation.reviews") {
      await this.#humanActions.click(candidate.first());
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
      await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.reviewNavigationAfter);
      postconditionPassed = /comment-manage\/list/iu.test(page.url())
        || await page.getByText("有内容", { exact: true }).first().isVisible({ timeout: 5_000 }).catch(() => false);
    } else if (unique && enabled && ["review.filter.content", "review.filter.unanswered", "review.filter.followup"].includes(input.operationKey)) {
      await this.#humanActions.click(candidate.first());
      await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.filterAfter);
      postconditionPassed = /comment-manage\/list/iu.test(page.url())
        && await page.getByText("有内容", { exact: true }).first().isVisible().catch(() => false)
        && await page.getByText("未回复", { exact: true }).first().isVisible().catch(() => false)
        && await page.getByText("有追评", { exact: true }).first().isVisible().catch(() => false);
    } else if (unique && enabled && input.operationKey === "review.pagination") {
      const before = page.url();
      await this.#humanActions.click(candidate.first());
      await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.paginationAfter);
      postconditionPassed = page.url() !== before || await candidate.first().getAttribute("aria-disabled").catch(() => null) === "true";
    } else if (unique && enabled && input.operationKey === "popup.notice.close") {
      postconditionPassed = await probeTmallSafePopupCloseControl({
        page,
        candidate: candidate.first(),
        click: (control) => this.#humanActions.click(control),
        afterClick: () => this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.successPoll),
      });
    }
    return { matches: semanticValid ? count : 0, shadowValidated: unique, postconditionPassed };
  }

  async #pendingQueueRegionText(page: Page): Promise<string | null> {
    if (!/\/comment-manage\/list\/rateWait4PC/u.test(page.url())) return null;
    const reviewHeader = page.getByText("评价内容", { exact: true }).first();
    if (!await reviewHeader.isVisible({ timeout: 2_000 }).catch(() => false)) return null;
    let scope = reviewHeader.locator("..");
    for (let level = 0; level < 9; level += 1) {
      const text = await scope.innerText().catch(() => "");
      const countMatches = Array.from(text.matchAll(/共\s*(\d+)\s*条/gu));
      if (/评价内容/u.test(text) && /商品信息/u.test(text) && /买家信息/u.test(text) && countMatches.length === 1) return text;
      scope = scope.locator("..");
    }
    return null;
  }

  async #snapshotFromScope(scope: Locator, rowIndex: number, reviewPhase: TmallReviewPhase): Promise<TmallReviewSnapshot> {
    let reviewContentScope = scope;
    let rawText = await scope.innerText();
    if (reviewPhase === "followup") {
      const expandedRows = await scope.locator(
        "xpath=following-sibling::tr[1][contains(concat(' ', normalize-space(@class), ' '), ' next-table-expanded-row ')]",
      ).all();
      const visibleExpandedRows = await this.#visibleLocators(expandedRows);
      if (visibleExpandedRows.length !== 1) {
        throw new TmallReviewPageStateError("追评正文所在的相邻展开行无法唯一确认");
      }
      reviewContentScope = visibleExpandedRows[0]!;
      rawText = `${rawText}\n${await reviewContentScope.innerText()}`;
    }
    const platformActionLabels = await this.#visiblePlatformActionLabels(scope);
    const anchorEvidence = await collectTmallAnchorDomEvidence(scope);
    const productAnchors = selectTmallProductAnchorEvidence(anchorEvidence);
    const productCandidates = productAnchors.map((candidate) => candidate.text);
    const productLinkCandidates = productAnchors.map((candidate) => candidate.href);
    const reviewSelector = [
      "[class*='comment-content']",
      "[class*='rate-content']",
      "[class*='review-content']",
      "[class*='evaluation-content']",
      "[class*='commentText']",
      "[class*='rateText']",
    ].join(",");
    const reviewCandidates = await reviewContentScope.locator(reviewSelector).allTextContents();
    const phaseReviewCandidates = await reviewContentScope.evaluate((scopeElement, input) => {
      const { selector, reviewPhase } = input;
      const candidates: TmallPhaseReviewCandidate[] = [];
      for (const element of Array.from(scopeElement.querySelectorAll(selector))) {
        if (element.querySelector(selector)) continue;
        const text = (element as HTMLElement).innerText.replace(/\s+/gu, " ").trim();
        if (!text || /(?:初次评价|追评|追加评价)[:：]\s*(?:\d{4}-\d{2}-\d{2}|收货后\d+天)/u.test(text)) continue;
        let region = element.parentElement;
        let matched = false;
        while (region && region !== scopeElement) {
          const context = region.innerText.replace(/\s+/gu, " ").trim();
          const initial = context.match(/初次评价[:：]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/u)?.[1] ?? null;
          const followup = context.match(/(?:追评|追加评价)[:：]\s*((?:\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})|(?:收货后\s*\d+\s*天))/u)?.[1]
            ?? context.match(/收货后\s*\d+\s*天/u)?.[0]
            ?? null;
          if ((initial === null) !== (followup === null)) {
            candidates.push({ text, reviewPhase: initial ? "initial" : "followup", reviewedAt: initial ?? followup! });
            matched = true;
            break;
          }
          region = region.parentElement;
        }
        // On rare rows Tmall omits the visible receipt-age label. The scope is
        // still the exact adjacent expanded row and contains one innermost
        // review body, so that structural relationship is sufficient evidence.
        if (!matched && reviewPhase === "followup") {
          candidates.push({ text, reviewPhase: "followup", reviewedAt: "追加评价" });
        }
      }
      return candidates;
    }, { selector: reviewSelector, reviewPhase });
    return parseTmallReviewRow({
      rawText,
      platformActionLabels,
      productCandidates,
      reviewCandidates,
      phaseReviewCandidates,
      productLinkCandidates,
      reviewPhase,
      rowIndex,
    });
  }

  async #visiblePlatformActionLabels(scope: Locator): Promise<string[]> {
    const candidates = await scope.getByText(
      /^(?:评价回复|追评回复|投诉评价|投诉追评|投诉评价记录|投诉追评记录|评价回复记录|追评回复记录|投诉成立|投诉已成立|判定投诉成立|投诉成功|投诉处理成功|投诉已成功|投诉不成立|投诉未通过|投诉驳回|投诉已驳回|投诉处理中|投诉审核中|平台审核中|等待平台审核|已超过回复期限|回复已关闭|无法回复)$/u,
    ).all();
    const labels: string[] = [];
    for (const candidate of await this.#visibleLocators(candidates)) {
      const label = (await candidate.innerText().catch(() => "")).replace(/\s+/gu, " ").trim();
      if (label) labels.push(label);
    }
    return [...new Set(labels)];
  }

  async #findReviewScope(action: Locator): Promise<Locator | null> {
    let scope = action.locator("..");
    for (let level = 0; level < 9; level += 1) {
      const text = await scope.innerText().catch(() => "");
      if (/订单号[:：]/u.test(text) && /初次评价[:：]/u.test(text)) return scope;
      scope = scope.locator("..");
    }
    return null;
  }

  async #isLoginPage(page: Page): Promise<boolean> {
    const controls = this.#loginControlResolvers();
    return isTmallLoginPage(page, controls.account, controls.password, controls.submit);
  }

  #authenticationResult(state: TmallAuthenticationPageState): TmallAuthResult {
    const messages: Record<TmallAuthenticationPageState, string> = {
      credential_rejected: "淘宝提示账号或密码错误，请确认后可立即重新登录",
      manual_verification_required: "请在已打开的淘宝窗口完成短信、电话、扫码或安全验证",
      onboarding_or_safe_guide: "淘宝窗口显示引导或通知，请完成或关闭后继续检测",
      manual_action_required: "淘宝窗口存在需要您确认的页面，请处理后继续检测",
      not_ready: "淘宝页面尚未完成登录，请在已打开的窗口继续操作后再检测",
    };
    return {
      state,
      page: state === "onboarding_or_safe_guide" || state === "manual_action_required" ? "review_list" : "login",
      message: messages[state],
    };
  }

  async #authenticationBodyText(page: Page): Promise<string> {
    const parts: string[] = [];
    for (const frame of page.frames()) {
      const text = await frame.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
      if (text) parts.push(text.slice(0, 20_000));
    }
    return parts.join("\n");
  }

  async #visibleOverlayText(page: Page): Promise<string> {
    const overlays = await page.locator(TMALL_TOP_LEVEL_OVERLAY_SELECTOR).all();
    const parts: string[] = [];
    for (const overlay of overlays.slice(0, 20)) {
      if (!await overlay.isVisible().catch(() => false)) continue;
      const text = await overlay.innerText().catch(() => "");
      if (text) parts.push(text.slice(0, 4_000));
    }
    return parts.join("\n");
  }

  async #readAuthenticationPageState(page: Page): Promise<TmallAuthenticationPageState | null> {
    const loginPageVisible = await this.#isLoginPage(page);
    const bodyText = loginPageVisible
      ? await this.#authenticationBodyText(page)
      : await this.#visibleOverlayText(page);
    return classifyTmallAuthenticationText({ bodyText, loginPageVisible });
  }

  async #waitForAuthenticationOutcome(page: Page, timeoutMs = 30_000): Promise<TmallAuthenticationPageState | null> {
    const deadlineAt = Date.now() + timeoutMs;
    while (Date.now() < deadlineAt) {
      const state = await this.#readAuthenticationPageState(page);
      if (state && state !== "not_ready") return state;
      if (!await this.#isLoginPage(page)) return null;
      await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.successPoll);
    }
    return await this.#isLoginPage(page) ? "not_ready" : null;
  }

  async #continueFromCurrentPageWithTransientRetry(page: Page, credentials?: TmallCredentials): Promise<TmallAuthResult> {
    return retryTmallTransientManualAction({
      run: () => this.#continueFromCurrentPage(page, credentials),
      readState: () => this.#readAuthenticationPageState(page),
      wait: () => page.waitForTimeout(1_000),
    });
  }

  async #continueFromCurrentPage(page: Page, credentials?: TmallCredentials, closedPageRecoveryAttempt = 0): Promise<TmallAuthResult> {
    const startedAt = Date.now();
    const loginPageVisible = await this.#isLoginPage(page);
    writeTmallNavigationDiagnostic("review.inspect.start", { loginPageVisible, path: safeTmallPath(page.url()) });
    const initialInspection = loginPageVisible
      ? { dismissal: "absent" as const, state: await this.#readAuthenticationPageState(page) }
      : await resolveTmallBlockingStateWithTransientOverlayRetry({
        dismiss: () => this.#closeKnownPopup(page),
        readState: () => this.#readAuthenticationPageState(page),
        wait: () => page.waitForTimeout(250),
      });
    const initialState = initialInspection.state;
    writeTmallNavigationDiagnostic("review.inspect.complete", {
      popup: initialInspection.dismissal,
      state: initialState,
      path: safeTmallPath(page.url()),
      elapsedMs: Date.now() - startedAt,
    });
    if (initialState && initialState !== "onboarding_or_safe_guide" && !(initialState === "not_ready" && credentials)) {
      await page.bringToFront();
      return this.#authenticationResult(initialState);
    }

    if (loginPageVisible && initialState === "not_ready" && credentials) {
      await this.#login(page, credentials);
      const outcome = await this.#waitForAuthenticationOutcome(page);
      if (outcome && outcome !== "onboarding_or_safe_guide") {
        await page.bringToFront();
        return this.#authenticationResult(outcome);
      }
    }

    if (initialState === "onboarding_or_safe_guide") {
      const dismissal = await this.#closeKnownPopup(page);
      if (dismissal === "manual_action_required") {
        await page.bringToFront();
        return this.#authenticationResult("manual_action_required");
      }
      const remainingState = await this.#readAuthenticationPageState(page);
      if (remainingState) {
        await page.bringToFront();
        return this.#authenticationResult(remainingState);
      }
    }

    if (await this.#isLoginPage(page)) {
      await page.bringToFront();
      return this.#authenticationResult("not_ready");
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
    const popupAfterLoad = await this.#closeKnownPopup(page);
    writeTmallNavigationDiagnostic("review.popup.after_load", { result: popupAfterLoad, path: safeTmallPath(page.url()), elapsedMs: Date.now() - startedAt });
    if (popupAfterLoad === "manual_action_required") {
      await page.bringToFront();
      return this.#authenticationResult("manual_action_required");
    }
    const reviewSurfaceVisible = async () => isTmallReviewSurfaceReady(
      page.url(),
      await page.getByText("有内容", { exact: true }).first().isVisible({ timeout: TMALL_REVIEW_SURFACE_PROBE_TIMEOUT_MS }).catch(() => false),
    );
    const waitForReviewSurface = async () => waitForTmallReviewSurface({
      isReady: reviewSurfaceVisible,
      wait: () => page.waitForTimeout(250),
    });
    const initialSurfaceReady = await waitForReviewSurface();
    writeTmallNavigationDiagnostic("review.surface.initial", { ready: initialSurfaceReady, path: safeTmallPath(page.url()), elapsedMs: Date.now() - startedAt });
    const recoveryStrategy = tmallReviewSurfaceRecoveryStrategy(page.url(), initialSurfaceReady);
    let surfaceReadyAfterRecovery = initialSurfaceReady;
    if (recoveryStrategy === "reload_review") {
      const currentReviewUrl = page.url();
      writeTmallNavigationDiagnostic("review.reload.start", { path: safeTmallPath(currentReviewUrl) });
      await navigateTmallPageWithTransientRetry(
        () => page.goto(currentReviewUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }),
        () => this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.successPoll),
      );
      await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.directNavigationAfter);
      surfaceReadyAfterRecovery = await waitForReviewSurface();
      writeTmallNavigationDiagnostic("review.reload.complete", { ready: surfaceReadyAfterRecovery, path: safeTmallPath(page.url()), elapsedMs: Date.now() - startedAt });
      if (!surfaceReadyAfterRecovery) {
        throw new TmallDriverOperationError("review.list", "评价管理页面刷新后仍未加载完成，请稍后重试");
      }
    }
    if (recoveryStrategy === "enter_review" && !surfaceReadyAfterRecovery) {
      writeTmallNavigationDiagnostic("review.navigate.start", { path: safeTmallPath(page.url()) });
      await navigateTmallReviewPageWithFallback({
        navigateByMenu: () => this.#navigateByMenu(page),
        navigateDirect: async (url) => {
          await navigateTmallPageWithTransientRetry(
            () => page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }),
            () => this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.successPoll),
          );
          await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.reviewNavigationAfter);
        },
        isReviewPageReady: waitForReviewSurface,
      });
      writeTmallNavigationDiagnostic("review.navigate.complete", { path: safeTmallPath(page.url()), elapsedMs: Date.now() - startedAt });
    }
    let popupAfterNavigate: TmallSafePopupDismissal;
    try {
      popupAfterNavigate = await this.#closeKnownPopup(page);
    } catch (error) {
      writeTmallNavigationDiagnostic("review.popup.after_navigate.failed", {
        errorName: error instanceof Error ? error.name : typeof error,
        error: safeTmallDiagnosticError(error),
        errorBase64: Buffer.from(safeTmallDiagnosticError(error), "utf8").toString("base64"),
        path: safeTmallPath(page.url()),
        elapsedMs: Date.now() - startedAt,
      });
      if (closedPageRecoveryAttempt === 0 && isTmallPageClosedError(error)) {
        writeTmallNavigationDiagnostic("review.popup.after_navigate.recover", {
          path: safeTmallPath(page.url()),
          elapsedMs: Date.now() - startedAt,
        });
        const replacement = await this.#replacementAuthenticationPage();
        await navigateTmallPageWithTransientRetry(
          () => replacement.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }),
          () => this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.successPoll),
        );
        await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.directNavigationAfter);
        return this.#continueFromCurrentPage(replacement, credentials, 1);
      }
      throw error;
    }
    writeTmallNavigationDiagnostic("review.popup.after_navigate", { result: popupAfterNavigate, path: safeTmallPath(page.url()), elapsedMs: Date.now() - startedAt });
    if (popupAfterNavigate === "manual_action_required") {
      await page.bringToFront();
      return this.#authenticationResult("manual_action_required");
    }

    const blockingState = await this.#readAuthenticationPageState(page);
    if (blockingState) {
      await page.bringToFront();
      return this.#authenticationResult(blockingState);
    }

    this.#lastVerifiedNavigationAt = Date.now();
    await page.bringToFront();
    return { state: "authenticated", page: "review_list" };
  }

  async #login(page: Page, credentials: TmallCredentials): Promise<void> {
    const controls = this.#loginControlResolvers();
    const group = await findTmallLoginFrame(
      page,
      controls.account,
      controls.password,
      controls.submit,
    );
    if (!group) throw new TmallDriverOperationError("login.account", "登录控件组无法安全确认");
    await performTmallLoginActions(group, credentials, async () => await revalidateTmallLoginControlGroup(
      page,
      group,
      controls.account,
      controls.password,
      controls.submit,
    ) !== null, this.#humanActions);
  }

  #loginControlResolvers(): {
    account: TmallLoginControlResolver;
    password: TmallLoginControlResolver;
    submit: TmallLoginControlResolver;
  } {
    return {
      account: (frame) => ({
        registered: this.#registeredLocator(frame, "login.account", () => frame.getByPlaceholder(/账号名|邮箱|手机号/u)),
        fallback: frame.getByPlaceholder(/账号名|邮箱|手机号/u),
      }),
      password: (frame) => ({
        registered: this.#registeredLocator(frame, "login.password", () => frame.getByPlaceholder(/登录密码/u)),
        fallback: frame.getByPlaceholder(/登录密码/u),
      }),
      submit: (frame) => ({
        registered: this.#registeredLocator(frame, "login.submit", () => frame.getByRole("button", { name: "登录", exact: true })),
        fallback: frame.getByRole("button", { name: "登录", exact: true }),
      }),
    };
  }

  async #needsManualVerification(page: Page): Promise<boolean> {
    const state = classifyTmallAuthenticationText({
      bodyText: await this.#authenticationBodyText(page),
      loginPageVisible: await this.#isLoginPage(page),
    });
    return state === "manual_verification_required";
  }

  async #navigateByMenu(page: Page): Promise<void> {
    if (await this.#closeKnownPopup(page) === "manual_action_required") {
      throw new TmallReviewPageStateError("淘宝页面存在需要人工处理的弹窗");
    }
    const trade = this.#registeredLocator(page, "navigation.trade", () => page.getByText("交易", { exact: true })).first();
    await trade.waitFor({ state: "visible", timeout: 8_000 }).catch(() => { throw new TmallDriverOperationError("navigation.trade", "交易菜单无法识别"); });
    await this.#humanActions.click(trade);
    await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.tradeNavigationAfter);
    if (await this.#closeKnownPopup(page) === "manual_action_required") {
      throw new TmallReviewPageStateError("淘宝页面存在需要人工处理的弹窗");
    }
    const reviews = this.#registeredLocator(page, "navigation.reviews", () => page.getByText("评价管理", { exact: true })).first();
    await reviews.waitFor({ state: "visible", timeout: 8_000 }).catch(() => { throw new TmallDriverOperationError("navigation.reviews", "评价管理入口无法识别"); });
    await this.#humanActions.click(reviews);
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
    await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.reviewNavigationAfter);
  }

  async #applyReviewScope(page: Page, scope: ResolvedReviewScope, phase: ReviewScanPhase = "initial", mode: ReviewFilterMode = "content_unanswered"): Promise<boolean> {
    try {
      return await applyReviewFilters(this.#reviewFilterAdapter(page), scope, phase, mode);
    } catch (error) {
      if (error instanceof ReviewFilterStateError) {
        throw new TmallDriverOperationError(error.operationKey, error.message);
      }
      throw error;
    }
  }

  async #verifyReviewScope(page: Page, scope: ResolvedReviewScope, phase: ReviewScanPhase = "initial", mode: ReviewFilterMode = "content_unanswered"): Promise<void> {
    try {
      await verifyReviewFilters(this.#reviewFilterAdapter(page), scope, phase, mode);
    } catch (error) {
      if (error instanceof ReviewFilterStateError) {
        throw new TmallDriverOperationError(error.operationKey, error.message);
      }
      throw error;
    }
  }

  async #waitForReviewFilterSurface(page: Page): Promise<void> {
    if (await this.#isLoginPage(page)) throw new TmallSessionExpiredError();
    if (await this.#needsManualVerification(page)) throw new TmallReviewPageStateError("页面需要验证码或安全验证");
    const trigger = this.#registeredLocator(page, "review.date.trigger", () => page.getByText("评价时间", { exact: true })).first();
    try {
      await trigger.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      if (await this.#isLoginPage(page)) throw new TmallSessionExpiredError();
      if (await this.#needsManualVerification(page)) throw new TmallReviewPageStateError("页面需要验证码或安全验证");
      throw new TmallDriverOperationError("review.date.trigger", "评价日期筛选尚未加载完成");
    }
  }

  async #readActiveReviewPage(page: Page, pageSize: number): Promise<number | null> {
    const candidates = await this.#registeredLocator(
      page,
      "review.pagination.current",
      () => page.locator("[aria-current='page'], .next-pagination-item.next-current, .next-pagination-item.current"),
    ).all();
    const evidence = await readTmallActivePageEvidence(candidates);
    if (evidence.matches > 1 || (evidence.matches === 1 && evidence.pageNumber === null)) {
      throw new TmallDriverOperationError("review.pagination.current", "评价列表当前页码标识不唯一或无法读取");
    }
    if (evidence.pageNumber !== null) {
      // The visible selected page is authoritative. When a requested page is
      // beyond the last page, Tmall can keep `current=2` in the URL while the
      // pagination control correctly remains on page 1. Returning the unique
      // visible value lets the caller verify that “下一页” is disabled and
      // safely conclude that the scan reached the end.
      return evidence.pageNumber;
    }

    const pagination = await this.#visibleLocators(await page.locator(".next-pagination, [class*='pagination'], nav[aria-label*='分页']").all());
    return pagination.length === 0 && this.#isRequestedReviewPage(page.url(), 1, pageSize) ? 1 : null;
  }

  async #waitForActiveReviewPage(page: Page, expected: number | null, pageSize: number): Promise<number> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await this.#assertSafeReviewPage(page);
      const current = await this.#readActiveReviewPage(page, pageSize);
      if (current !== null && (expected === null || current === expected)) return current;
      await page.waitForTimeout(100);
    }
    throw new TmallDriverOperationError("review.pagination.current", expected === null
      ? "评价列表当前页码无法安全确认"
      : `评价列表未切换到第 ${expected} 页`);
  }

  async #nextReviewPageAvailability(page: Page): Promise<"available" | "end" | "untrusted"> {
    const candidates = await this.#visibleLocators(await this.#registeredLocator(
      page,
      "review.pagination",
      () => page.getByRole("button", { name: /下一页|>/u }),
    ).all());
    return readTmallNextPageAvailability(candidates);
  }

  async #reviewTotalCount(page: Page): Promise<number | null> {
    const labels = await this.#visibleLocators(await page.getByText(/^共\s*\d+\s*条$/u).all());
    const values: number[] = [];
    for (const label of labels) {
      const value = parseTmallReviewTotalCount(await label.innerText().catch(() => ""));
      if (value !== null) values.push(value);
    }
    const unique = [...new Set(values)];
    if (unique.length === 1) return unique[0]!;
    const queueText = await this.#pendingQueueRegionText(page);
    return queueText ? parseTmallReviewTotalCount(queueText) : null;
  }

  async #readPendingReviewListEvidence(page: Page): Promise<string | null> {
    const actions = await this.#visibleLocators(await this.#registeredLocator(
      page,
      "reply.open",
      () => page.getByText(/^(评价回复|追评回复)$/u),
    ).all());
    if (actions.length === 0) return null;
    const rows: Array<{ orderId: string | null; reviewPhase: TmallReviewPhase; phaseMarker: string | null }> = [];
    for (const action of actions) {
      const scope = await this.#findReviewScope(action);
      if (!scope) return null;
      const reviewPhase = reviewPhaseFromReplyAction(await action.innerText().catch(() => ""));
      const rawText = await scope.innerText().catch(() => "");
      const orderId = rawText.match(/订单号[:：]\s*(\d{8,})/u)?.[1] ?? null;
      // Loading evidence only proves that the main table row is stable. The
      // follow-up body intentionally lives in the adjacent expanded row and
      // is validated later by #snapshotFromScope.
      const phaseMarker = rawText.match(/初次评价[:：]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/u)?.[1] ?? null;
      rows.push({ orderId, reviewPhase, phaseMarker });
    }
    return tmallStableReviewStructureEvidence(rows);
  }

  async #waitForPendingReviewList(page: Page, previousEvidence: string | null = null): Promise<void> {
    const evidence = await waitForTmallListEvidenceChange({
      previousEvidence,
      sample: async () => {
        await this.#assertSafeReviewPage(page);
        const current = await this.#readPendingReviewListEvidence(page);
        if (current !== null) return current;
        const text = await this.#pendingQueueRegionText(page);
        if (text && isVerifiedEmptyPendingQueue(text)) return "__verified_empty__";

        // “有内容未回复”会把已经投诉、已经留下记录但当前不能再回复的
        // 评价混在结果中。这些行没有回复按钮，但页面本身已经稳定加载完成，
        // 不能因此一直等待到超时。
        const nativeReplyActions = await page.getByText(/^(评价回复|追评回复)$/u).count().catch(() => 0);
        if (nativeReplyActions > 0) return null;
        const nonReplyableMarkers = await page
          .getByText(/^(投诉评价记录|投诉追评记录|评价回复记录|追评回复记录|已回复|已超过回复期限|回复已关闭)$/u)
          .count()
          .catch(() => 0);
        const totalCount = text ? parseTmallReviewTotalCount(text) : null;
        return nonReplyableMarkers > 0 && totalCount !== null
          ? `__verified_non_replyable__:${totalCount}:${nonReplyableMarkers}`
          : null;
      },
      wait: () => page.waitForTimeout(100),
    });
    if (evidence === null) throw new TmallDriverOperationError("review.list", "评价列表未在安全时限内加载完成");
  }

  #reviewFilterAdapter(page: Page): ReviewFilterAdapter {
    const toggleDetails: Record<ReviewFilterToggle, { operationKey: string; label: string }> = {
      buyer: { operationKey: "review.filter.buyer", label: "来自买家的评价" },
      content: { operationKey: "review.filter.content", label: "有内容" },
      unanswered: { operationKey: "review.filter.unanswered", label: "未回复" },
      followup: { operationKey: "review.filter.followup", label: "有追评" },
    };
    const toggleCandidates = async (toggle: ReviewFilterToggle) => {
      const details = toggleDetails[toggle];
      const registered = await this.#visibleLocators(await this.#registeredLocator(
        page,
        details.operationKey,
        () => page.getByText(details.label, { exact: true }),
      ).all());
      const semanticMatches: Locator[] = [];
      for (const candidate of registered) {
        const text = (await candidate.innerText().catch(() => "")).normalize("NFKC").replace(/\s+/gu, "").trim();
        if (text === details.label.replace(/\s+/gu, "")) semanticMatches.push(candidate);
      }
      if (semanticMatches.length === 1) return semanticMatches;
      return this.#visibleLocators(await page.getByText(details.label, { exact: true }).all());
    };
    const dateCandidates = async () => resolveTmallDateControlCandidates(await this.#registeredLocator(
      page,
      "review.date.trigger",
      () => page.getByText("评价时间", { exact: true }),
    ).all());
    const uniqueClick = async (operationKey: string, locator: Locator, message: string) => {
      const visible = await this.#visibleLocators(await locator.all());
      if (visible.length !== 1) throw new TmallDriverOperationError(operationKey, message);
      await this.#humanActions.click(visible[0]!);
      await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.filterAfter);
    };
    const visibleCalendarMonths = async () => {
      const values = await page.getByText(/^\s*\d{4}年\s*\d{1,2}月\s*$/u).allTextContents();
      return [...new Set(values.map(parseTmallCalendarMonth).filter((value): value is string => value !== null))];
    };

    return {
      assertSafePage: async () => this.#assertSafeReviewPage(page),
      readToggle: async (toggle) => {
        const visible = await toggleCandidates(toggle);
        if (visible.length !== 1) return { matches: visible.length, selected: null };
        const selected = await readTmallToggleSelectionState(visible[0]!);
        return { matches: 1, selected };
      },
      clickToggle: async (toggle) => {
        const visible = await toggleCandidates(toggle);
        if (visible.length !== 1) throw new TmallDriverOperationError(toggleDetails[toggle].operationKey, `${toggleDetails[toggle].label}筛选项无法唯一识别`);
        await this.#humanActions.click(visible[0]!);
        await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.filterAfter);
      },
      readDateRange: async () => {
        const visible = await dateCandidates();
        if (visible.length !== 1) return { matches: visible.length, startDate: null, endDate: null };
        return { matches: 1, ...await readTmallDateRangeFromControl(visible[0]!) };
      },
      selectPreset: async (preset) => {
        const date = await dateCandidates();
        if (date.length !== 1) throw new TmallDriverOperationError("review.date.trigger", "评价日期筛选无法唯一识别");
        const labels = { today: "今天", yesterday: "昨天", last7: "近7天", last30: "近30天" } as const;
        const operationKey = `review.date.preset.${preset}`;
        const options = async () => this.#visibleLocators(await this.#registeredLocator(
          page,
          operationKey,
          () => page.getByText(labels[preset], { exact: true }),
        ).all());
        let visible = await options();
        if (visible.length === 0) {
          await this.#humanActions.click(date[0]!.locator("input:not([type='hidden'])").first());
          await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.filterAfter);
          visible = await options();
        }
        if (visible.length !== 1) throw new TmallDriverOperationError(operationKey, `${labels[preset]}快捷日期无法唯一识别`);
        await this.#humanActions.click(visible[0]!);
        await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.filterAfter);
      },
      openCustomCalendar: async () => {
        if ((await visibleCalendarMonths()).length > 0) return;
        const date = await dateCandidates();
        if (date.length !== 1) throw new TmallDriverOperationError("review.date.trigger", "评价日期筛选无法唯一识别");
        await this.#humanActions.click(date[0]!.locator("input:not([type='hidden'])").first());
        await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.filterAfter);
        if ((await visibleCalendarMonths()).length === 0) {
          throw new TmallDriverOperationError("review.date.trigger", "评价日期日历未打开");
        }
      },
      closeDatePicker: async () => {
        if ((await visibleCalendarMonths()).length === 0) return;
        await page.keyboard.press("Escape");
        await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.filterAfter);
        if ((await visibleCalendarMonths()).length > 0) {
          // Some Tmall builds use a toggle-only picker that does not react to
          // Escape. Toggling the same date input is a safe, non-business action.
          const date = await dateCandidates();
          if (date.length !== 1) throw new TmallDriverOperationError("review.date.trigger", "评价日期筛选无法唯一识别");
          await this.#humanActions.click(date[0]!.locator("input:not([type='hidden'])").first());
          await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.filterAfter);
        }
        if ((await visibleCalendarMonths()).length > 0) {
          throw new TmallDriverOperationError("review.date.trigger", "评价日期面板无法安全关闭");
        }
      },
      readVisibleCalendarMonths: visibleCalendarMonths,
      moveCalendar: async (direction) => {
        const operationKey = `review.date.${direction}`;
        const label = direction === "previous" ? /上个月|上一月|向前/u : /下个月|下一月|向后/u;
        await uniqueClick(
          operationKey,
          this.#registeredLocator(page, operationKey, () => page.getByRole("button", { name: label })),
          direction === "previous" ? "日历上个月按钮无法唯一识别" : "日历下个月按钮无法唯一识别",
        );
      },
      selectCalendarDate: async (date) => {
        // Calendar dates are dynamic. A persisted generic selector such as
        // `[title]` can match hundreds of unrelated controls and make a real
        // run appear frozen. Resolve the requested date directly instead.
        const exactCandidates = await page.locator(
          `[data-value='${date}'], [data-date='${date}'], [title='${date}'], [aria-label='${date}']`,
        ).all();
        let exact = await resolveTmallCalendarDateCandidates(exactCandidates, date);
        if (exact.length === 0) {
          exact = await resolveTmallCalendarDateCandidates(
            await page.getByText(String(Number(date.slice(-2))), { exact: true }).all(),
            date,
          );
        }
        if (exact.length !== 1) throw new TmallDriverOperationError("review.date.day", `日期 ${date} 无法唯一识别`);
        await this.#humanActions.click(exact[0]!);
        await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.filterAfter);
      },
      clickSearch: async () => uniqueClick(
        "review.search",
        this.#registeredLocator(page, "review.search", () => page.getByRole("button", { name: "搜索", exact: true })),
        "评价搜索按钮无法唯一识别",
      ),
    };
  }

  async #assertSafeReviewPage(page: Page, allowedOverlayContents: readonly Locator[] = []): Promise<void> {
    if (await this.#isLoginPage(page)) throw new TmallSessionExpiredError();
    if (await this.#needsManualVerification(page)) throw new TmallReviewPageStateError("页面需要验证码或安全验证");
    await this.#closeKnownPopup(page);
    const dialogs = await resolveTmallTopLevelOverlays(await page.locator(TMALL_TOP_LEVEL_OVERLAY_SELECTOR).all());
    for (const dialog of dialogs) {
      const text = await dialog.innerText().catch(() => "");
      const disposition = decideTmallOverlayDisposition({
        containsAllowedReplyControls: allowedOverlayContents.length > 0
          && await this.#overlayContainsAll(dialog, allowedOverlayContents),
        recognizedDatePicker: await isRecognizedTmallDatePickerSurface(dialog),
        text,
      });
      if (disposition !== "manual_action") continue;
      if (/验证码|扫码验证|安全验证|身份验证|退款|退货|投诉|申诉|处罚|赔付|确认操作|是否确认|确认提交/u.test(text)) {
        throw new TmallReviewPageStateError("页面存在需要人工处理的安全或业务弹窗");
      }
      throw new TmallReviewPageStateError("页面存在无法确认用途的安全或业务弹窗，需要人工处理");
    }
  }

  async #overlayContainsAll(overlay: Locator, contents: readonly Locator[]): Promise<boolean> {
    for (const content of contents) {
      const handle = await content.elementHandle().catch(() => null);
      if (!handle) return false;
      try {
        const contains = await overlay.evaluate((element, child) => element === child || element.contains(child as Node), handle).catch(() => false);
        if (!contains) return false;
      } finally {
        await handle.dispose();
      }
    }
    return true;
  }

  #requestedPageFromUrl(url: string, pageSize: number): number | null {
    try {
      const parsed = new URL(url);
      const current = Number(parsed.searchParams.get("current"));
      return parsed.origin === "https://myseller.taobao.com"
        && parsed.pathname === "/home.htm/comment-manage/list/rateWait4PC"
        && parsed.searchParams.get("pageSize") === String(pageSize)
        && Number.isSafeInteger(current)
        && current >= 1
        ? current
        : null;
    } catch {
      return null;
    }
  }

  async #openReviewDataPage(
    page: Page,
    targetPage: number,
    pageSize: number,
    scope: ResolvedReviewScope,
    phase: ReviewScanPhase = "initial",
    mode: ReviewFilterMode = "content_unanswered",
  ): Promise<"ready" | "end"> {
    const target = { page: targetPage, pageSize, scope, phase, mode };
    const refreshStrategy = tmallReviewRefreshStrategy({
      targetPage,
      activeContextMatches: this.#isActiveReviewContext(target),
      requestedPageMatches: this.#isRequestedReviewPage(page.url(), targetPage, pageSize),
    });
    if (refreshStrategy === "reuse") {
      try {
        await this.#verifyReviewScope(page, scope, phase, mode);
        // Re-read the same filtered page through Tmall's own Search button.
        // This removes rows just replied to and lets newly backfilled rows enter
        // before the drainer decides whether it should advance a page.
        await this.#reviewFilterAdapter(page).clickSearch(scope);
        await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.filterAfter);
        if (await this.#closeKnownPopup(page) === "manual_action_required") {
          throw new TmallReviewPageStateError("评价页面存在需要人工处理的弹窗");
        }
        await this.#verifyReviewScope(page, scope, phase, mode);
        return "ready";
      } catch (error) {
        if (error instanceof TmallSessionExpiredError || error instanceof TmallReviewPageStateError) throw error;
        // Reuse is an optimization. If the current context cannot be verified,
        // fall back to the allowlisted review URL and rebuild the frozen filters.
        this.#activeReviewContext = null;
      }
    }

    // Keep the already-applied date/content/reply filters while paging. Tmall
    // exposes them in the review-list URL, so carrying the allowlisted query
    // values forward avoids reopening the calendar on every page. The filter
    // adapter below still verifies the frozen scope and only changes it when
    // the requested processing mode really changed.
    const navigationUrl = tmallReviewPageUrlWithFilters(page.url(), targetPage, pageSize, {
      startDate: scope.startDate,
      endDate: scope.endDate,
      phase,
      mode,
    });
    await page.goto(navigationUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.directNavigationAfter);
    if (await this.#closeKnownPopup(page) === "manual_action_required") {
      throw new TmallReviewPageStateError("评价页面存在需要人工处理的弹窗");
    }
    await this.#waitForReviewFilterSurface(page);
    if (await this.#closeKnownPopup(page) === "manual_action_required") {
      throw new TmallReviewPageStateError("评价页面存在需要人工处理的弹窗");
    }
    const filtersChanged = await this.#applyReviewScope(page, scope, phase, mode);

    // Selecting filters and clicking search can reset Tmall to page one. A
    // single recovery navigation restores the cursor; the second pass only
    // verifies the frozen filters and never enters a navigation loop.
    for (const recoveryTarget of tmallReviewFilterRecoveryTargets(filtersChanged, targetPage)) {
      const recoveryUrl = tmallReviewPageUrlWithFilters(page.url(), recoveryTarget, pageSize, {
        startDate: scope.startDate,
        endDate: scope.endDate,
        phase,
        mode,
      });
      await page.goto(recoveryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.directNavigationAfter);
      if (await this.#closeKnownPopup(page) === "manual_action_required") {
        throw new TmallReviewPageStateError("评价页面存在需要人工处理的弹窗");
      }
      await this.#waitForReviewFilterSurface(page);
      if (await this.#closeKnownPopup(page) === "manual_action_required") {
        throw new TmallReviewPageStateError("评价页面存在需要人工处理的弹窗");
      }
      await this.#verifyReviewScope(page, scope, phase, mode);
    }

    const currentPage = await this.#waitForActiveReviewPage(page, null, pageSize);
    if (currentPage !== targetPage) {
      if (currentPage < targetPage) {
        const totalCount = await this.#reviewTotalCount(page);
        const requestedPageIsBeyondTotal = totalCount !== null && targetPage > Math.max(1, Math.ceil(totalCount / pageSize));
        if (requestedPageIsBeyondTotal || await this.#nextReviewPageAvailability(page) === "end") {
          await this.#verifyReviewScope(page, scope, phase, mode);
          // Tmall may keep an impossible `current` query value while showing
          // the last real page. Do not let a later reply/complaint trust the
          // stale cached context; it must restore its own sourceKey hint.
          this.#activeReviewContext = null;
          return "end";
        }
      }
      throw new TmallDriverOperationError("review.pagination.current", `评价列表无法安全直达第 ${targetPage} 页`);
    }
    if (!this.#isRequestedReviewPage(page.url(), targetPage, pageSize)) {
      throw new TmallDriverOperationError("review.pagination.current", "评价列表当前页码无法安全确认");
    }
    await this.#waitForPendingReviewList(page);
    await this.#verifyReviewScope(page, scope, phase, mode);
    this.#activeReviewContext = { page: targetPage, pageSize, scope, phase, mode };
    return "ready";
  }

  #isActiveReviewContext(target: TmallReviewTargetHint): boolean {
    const active = this.#activeReviewContext;
    return active !== null
      && active.page === target.page
      && active.pageSize === target.pageSize
      && active.phase === target.phase
      && active.mode === target.mode
      && active.scope.startDate === target.scope.startDate
      && active.scope.endDate === target.scope.endDate;
  }

  #reviewContextKey(pageSize: number, scope: ResolvedReviewScope, phase: ReviewScanPhase, mode: ReviewFilterMode): string {
    return `${pageSize}|${scope.startDate}|${scope.endDate}|${phase}|${mode}`;
  }

  #isRequestedReviewPage(url: string, pageNumber: number, pageSize: number): boolean {
    try {
      const parsed = new URL(url);
      return parsed.origin === "https://myseller.taobao.com"
        && parsed.pathname === "/home.htm/comment-manage/list/rateWait4PC"
        && parsed.searchParams.get("current") === String(pageNumber)
        && parsed.searchParams.get("pageSize") === String(pageSize);
    } catch {
      return false;
    }
  }

  async #closeKnownPopup(page: Page): Promise<TmallSafePopupDismissal> {
    let closedAny = false;
    const knownHeading = /^(重要消息|新手引导|功能升级|评价智能分析上线)$/u;

    for (let pass = 0; pass < 5; pass += 1) {
      const featureUpgradeAcknowledgements = await resolveTmallFeatureUpgradeAcknowledgement(page);
      if (featureUpgradeAcknowledgements.length > 0) {
        const acknowledgement = featureUpgradeAcknowledgements[0]!;
        const closed = await withTmallReadOnlyNetworkGuard(page, async () => {
          const identityBefore = tmallSafePopupPageIdentity(page.url());
          if (!identityBefore) return false;
          await this.#humanActions.click(acknowledgement);
          await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.successPoll);
          await acknowledgement.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => undefined);
          return !await acknowledgement.isVisible().catch(() => false)
            && tmallSafePopupPageIdentity(page.url()) === identityBefore;
        });
        if (!closed) return "manual_action_required";
        closedAny = true;
        continue;
      }
      const notificationCloseControls = await resolveTmallImportantMessageCloseControls(page);
      if (notificationCloseControls.length > 0) {
        const closeControl = notificationCloseControls[0]!;
        const closed = await withTmallReadOnlyNetworkGuard(page, async () => {
          const identityBefore = tmallSafePopupPageIdentity(page.url());
          if (!identityBefore) return false;
          await this.#humanActions.click(closeControl);
          await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.successPoll);
          await closeControl.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => undefined);
          return !await closeControl.isVisible().catch(() => false)
            && tmallSafePopupPageIdentity(page.url()) === identityBefore;
        });
        if (!closed) return "manual_action_required";
        closedAny = true;
        continue;
      }
      let scope: Locator | null = null;
      let passiveNotification = false;
      let shopLossWarningNavigation = false;
      const headings = await this.#visibleLocators(await page.getByText(knownHeading).all());
      for (const heading of headings) {
        let candidate = heading.locator("..");
        for (let level = 0; level < 7; level += 1) {
          const text = await candidate.innerText().catch(() => "");
          const iconActions = await this.#safePopupIconActions(candidate);
          const acknowledgementActions = await this.#visibleLocators(await candidate.getByRole("button", { name: /^(我知道了|完成|关闭)$/u }).all());
          if (await this.#safePopupKey(candidate, text) && (iconActions.length > 0 || acknowledgementActions.length > 0)) {
            scope = candidate;
            break;
          }
          candidate = candidate.locator("..");
        }
        if (scope) break;
      }

      if (!scope) {
        const dialogs = await this.#visibleLocators(await page.locator(TMALL_TOP_LEVEL_OVERLAY_SELECTOR).all());
        const recognized: Array<{ locator: Locator; textLength: number }> = [];
        for (const dialog of dialogs) {
          const text = await dialog.innerText().catch(() => "");
          if (await this.#safePopupKey(dialog, text)) recognized.push({ locator: dialog, textLength: text.length });
        }
        recognized.sort((left, right) => left.textLength - right.textLength);
        scope = recognized[0]?.locator ?? null;

        if (!scope) {
          for (const dialog of dialogs) {
            const [className, text, closeActions, editors, controlLabels] = await Promise.all([
              dialog.getAttribute("class").catch(() => ""),
              dialog.innerText().catch(() => ""),
              this.#safePopupIconActions(dialog, true),
              this.#visibleEditableLocators(await dialog.locator("textarea, [contenteditable='true'], [role='textbox']").all()),
              dialog.locator("button, [role='button'], input[type='button'], input[type='submit']").evaluateAll((elements) => elements.map((element) => (
                (element as HTMLElement).innerText || element.getAttribute("aria-label") || element.getAttribute("title")
                  || (element as HTMLInputElement).value || ""
              ).normalize("NFKC").replace(/\s+/gu, " ").trim()).filter(Boolean)).catch(() => [] as string[]),
            ]);
            if (!isPassiveTmallNotificationModal({
              className: className ?? "",
              text,
              controlLabels,
              editableCount: editors.length,
              hardCloseCount: closeActions.length,
            })) {
              if (!isTmallShopLossWarningNavigationModal({
                className: className ?? "",
                text,
                controlLabels,
                editableCount: editors.length,
              })) continue;
              scope = dialog;
              shopLossWarningNavigation = true;
              break;
            }
            scope = dialog;
            passiveNotification = true;
            break;
          }
        }
      }

      if (!scope) {
        const unknownDialogs = await resolveTmallTopLevelOverlays(await page.locator(TMALL_TOP_LEVEL_OVERLAY_SELECTOR).all());
        return unknownDialogs.length > 0 ? "manual_action_required" : closedAny ? "closed" : "absent";
      }

      if (shopLossWarningNavigation) {
        const actions = await this.#visibleLocators(await scope.getByRole("button", { name: "立即处理", exact: true }).all());
        if (actions.length !== 1) return "manual_action_required";
        const pathBefore = safeTmallPath(page.url());
        await this.#humanActions.click(actions[0]!);
        await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.successPoll);
        await Promise.race([
          scope.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => undefined),
          page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined),
        ]);
        const hidden = !await scope.isVisible().catch(() => false);
        const navigated = safeTmallPath(page.url()) !== pathBefore;
        if (!hidden && !navigated) return "manual_action_required";
        closedAny = true;
        continue;
      }

      if (passiveNotification) {
        const actions = await this.#safePopupIconActions(scope, true);
        if (actions.length !== 1) return "manual_action_required";
        const closed = await withTmallReadOnlyNetworkGuard(page, async () => {
          const identityBefore = tmallSafePopupPageIdentity(page.url());
          if (!identityBefore) return false;
          await this.#humanActions.click(actions[0]!);
          await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.successPoll);
          await scope!.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => undefined);
          return !await scope!.isVisible().catch(() => false)
            && tmallSafePopupPageIdentity(page.url()) === identityBefore;
        });
        if (!closed) return "manual_action_required";
        closedAny = true;
        continue;
      }

      const result = await withTmallReadOnlyNetworkGuard(page, async () => dismissTmallSafePopup({
        isVisible: () => scope!.isVisible().catch(() => false),
        text: async () => {
          const text = await scope!.innerText().catch(() => "");
          const popupKey = await this.#safePopupKey(scope!, text);
          return popupKey === "feature_upgrade" && !tmallSafePopupKey(text)
            ? `${text} 功能升级 评价智能分析上线`
            : text;
        },
        actions: async (popupKey) => {
          const iconActions = await this.#safePopupIconActions(scope!, true);
          const acknowledgementActions = await this.#visibleLocators(await scope!.getByRole("button", { name: /^我知道了$/u }).all());
          const completionActions = await this.#visibleLocators(await scope!.getByRole("button", { name: /^完成$/u }).all());
          const selected = popupKey === "important_messages"
            ? iconActions
            : popupKey === "new_user_guide"
              ? completionActions.length === 1 ? completionActions : acknowledgementActions
              : acknowledgementActions.length === 1 ? acknowledgementActions : iconActions;
          return selected.map((action) => ({
            click: async () => {
              await this.#humanActions.click(action);
              await this.#humanActions.delay(TMALL_ACTION_DELAY_RANGES.successPoll);
            },
          }));
        },
        waitUntilHidden: async () => {
          await scope!.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => undefined);
          return !await scope!.isVisible().catch(() => false);
        },
        pageIdentity: async () => tmallSafePopupPageIdentity(page.url()) ?? "untrusted-page",
      }));
      if (result === "manual_action_required") return result;
      if (result === "absent") return closedAny ? "closed" : "absent";
      closedAny = true;
    }

    return "manual_action_required";
  }

  async #safePopupIconActions(scope: Locator, useRegisteredLocator = false): Promise<Locator[]> {
    const repairedCandidates = useRegisteredLocator
      ? async () => this.#registeredLocator(
        scope,
        "popup.notice.close",
        () => scope.locator(TMALL_HARD_CLOSE_CONTROL_SELECTOR),
      ).all()
      : null;
    const actions = await resolveTmallPopupCloseControls({
      liveCandidates: await scope.locator(TMALL_HARD_CLOSE_CONTROL_SELECTOR).all(),
      ...(repairedCandidates ? { repairedCandidates } : {}),
    });
    if (actions.length > 0) return actions;
    return resolveTmallHardCloseControls(await scope.getByText(/^(?:×|✕)$/u, { exact: true }).all());
  }

  async #safePopupKey(scope: Locator, text: string): Promise<TmallSafePopupKey | null> {
    const byText = tmallSafePopupKey(text);
    if (byText) return byText;
    if (TMALL_UNSAFE_POPUP_TEXT.test(text.normalize("NFKC"))) return null;
    const className = await scope.getAttribute("class").catch(() => null);
    const classTokens = (className ?? "").split(/\s+/u).filter(Boolean);
    return classTokens.includes("upgrade-analysis-dialog") && /评价|分析|升级|上线/u.test(text)
      ? "feature_upgrade"
      : null;
  }

  #registeredLocator(scope: Page | Frame | Locator, operationKey: string, fallback: () => Locator): Locator {
    const rule = this.#locatorProvider?.(operationKey);
    if (!rule) return fallback();
    try {
      if (rule.strategy === "css") return scope.locator(rule.selector);
      if (rule.strategy === "placeholder") return scope.getByPlaceholder(rule.selector, { exact: true });
      if (rule.strategy === "text") {
        const alternatives = rule.selector.split("|").map((item) => item.trim()).filter(Boolean);
        if (alternatives.length > 1) {
          const escaped = alternatives.map((item) => item.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
          return scope.getByText(new RegExp(`^(?:${escaped.join("|")})$`, "u"));
        }
        return scope.getByText(rule.selector, { exact: true });
      }
      if (rule.strategy === "role") {
        const separator = rule.selector.indexOf(":");
        const role = separator > 0 ? rule.selector.slice(0, separator) : rule.selector;
        const name = separator > 0 ? rule.selector.slice(separator + 1) : undefined;
        return scope.getByRole(role as Parameters<Page["getByRole"]>[0], roleNameOptions(name));
      }
    } catch {
      return fallback();
    }
    return fallback();
  }

  async #visibleLocators(candidates: Locator[]): Promise<Locator[]> {
    const states = await Promise.all(candidates.map((candidate) => candidate.isVisible().catch(() => false)));
    return candidates.filter((_candidate, index) => states[index] === true);
  }

  async #resolveReplyEditors(scopes: readonly Locator[]): Promise<Locator[]> {
    for (const scope of scopes) {
      const registered = await this.#visibleEditableLocators(await this.#registeredLocator(
        scope,
        "reply.editor",
        () => scope.locator("textarea, [contenteditable='true'], [role='textbox']"),
      ).all());
      if (registered.length === 1) return registered;

      // A saved locator may be stale. The fallback remains strictly inside
      // the selected review row or its reply dialog and never scans the page.
      const live = await this.#visibleEditableLocators(await scope.locator(
        "textarea, [contenteditable='true'], [role='textbox']",
      ).all());
      if (live.length === 1) return live;
    }
    return [];
  }

  async #resolveReplySubmitButtons(scopes: readonly Locator[], allowBroadFallback = true): Promise<Locator[]> {
    for (const scope of scopes) {
      const registered = await this.#replySubmitCandidates(await this.#registeredLocator(
        scope,
        "reply.submit",
        () => scope.getByRole("button", { name: /^(?:提交|确认提交|确认回复|发布|回复|确认|确定)$/u }),
      ).all());
      if (registered.length === 1) return registered;

      // Older persisted built-ins did not include the labels “回复 / 确认 /
      // 确定”. Try the complete exact semantic allow-list before any broad
      // button scan so a normal reply surface stays fast and deterministic.
      const semantic = await this.#replySubmitCandidates(await scope.getByRole(
        "button",
        { name: /^(?:提交|确认提交|确认回复|发布|回复|确认|确定)$/u },
      ).all());
      if (semantic.length === 1) return semantic;
      if (!allowBroadFallback) continue;

      // Complaint, refund and navigation controls are rejected by the exact
      // label allow-list even if they share the same visual button style.
      const live = await this.#replySubmitCandidates(await scope.locator(
        "button, [role='button'], input[type='button'], input[type='submit']",
      ).all());
      if (live.length === 1) return live;
    }
    return [];
  }

  async #resolveUniqueOpenedReplySurface(page: Page, allowBroadFallback = true): Promise<{ editors: Locator[]; buttons: Locator[] }> {
    // Some Tmall versions render the reply form through a portal outside both
    // the review row and an ARIA dialog. Discovery is allowed only after the
    // exact target row's reply action was clicked, and only when one editable
    // reply field is visible on the whole page. No control is clicked here.
    const editors = await this.#visibleEditableLocators(await page.locator(
      "textarea, [contenteditable='true'], [role='textbox']",
    ).all());
    if (editors.length !== 1) return { editors: [], buttons: [] };

    let container = editors[0]!.locator("xpath=..");
    for (let depth = 0; depth < 10; depth += 1) {
      const buttonLocator = allowBroadFallback
        ? container.locator("button, [role='button'], input[type='button'], input[type='submit']")
        : container.getByRole("button", { name: /^(?:提交|确认提交|确认回复|发布|回复|确认|确定)$/u });
      const buttons = await this.#replySubmitCandidates(await buttonLocator.all());
      if (buttons.length === 1) return { editors, buttons };
      if (buttons.length > 1) return { editors, buttons: [] };
      container = container.locator("xpath=..");
    }
    return { editors, buttons: [] };
  }

  async #visibleEditableLocators(candidates: readonly Locator[]): Promise<Locator[]> {
    const states = await Promise.all(candidates.map(async (candidate) => {
      const [visible, editable] = await Promise.all([
        candidate.isVisible().catch(() => false),
        candidate.isEditable().catch(() => false),
      ]);
      return visible && editable;
    }));
    return candidates.filter((_candidate, index) => states[index] === true);
  }

  async #replySubmitCandidates(candidates: readonly Locator[]): Promise<Locator[]> {
    const states = await Promise.all(candidates.map(async (candidate) => {
      const [visible, enabled, text, ariaLabel, title, value] = await Promise.all([
        candidate.isVisible().catch(() => false),
        candidate.isEnabled().catch(() => false),
        candidate.innerText().catch(() => ""),
        candidate.getAttribute("aria-label").catch(() => null),
        candidate.getAttribute("title").catch(() => null),
        candidate.getAttribute("value").catch(() => null),
      ]);
      return visible && enabled
        && [text, ariaLabel, title, value].some((label) => typeof label === "string" && isTmallReplySubmitLabel(label));
    }));
    return candidates.filter((_candidate, index) => states[index] === true);
  }

  async close(): Promise<void> {
    this.#launchAllowed = false;
    await this.#context?.close();
    this.#context = null;
    this.#authenticationPage = null;
    this.#lastVerifiedNavigationAt = null;
  }

  async clearProfile(): Promise<void> {
    await this.close();
    await rm(this.#profileDirectory, { recursive: true, force: true });
  }

  async profileSizeBytes(): Promise<number> {
    const walk = async (directory: string): Promise<number> => {
      let total = 0;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) total += await walk(path);
        else if (entry.isFile()) total += (await stat(path)).size;
      }
      return total;
    };
    return walk(this.#profileDirectory).catch(() => 0);
  }
}
