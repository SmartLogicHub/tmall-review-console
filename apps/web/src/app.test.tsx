import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, resetAppQueryCacheForTests } from "./app";

const reviewScope = { preset: "last7", startDate: null, endDate: null, effectiveStartDate: "2026-07-10", effectiveEndDate: "2026-07-16", timezone: "Asia/Shanghai", revision: 1, summary: "近7天（2026-07-10 至 2026-07-16）" } as const;
let automationStatus = { state: "disabled", trigger: null, currentWindow: null, nextRunAt: null, currentStep: "自动计划未启用", startedAt: null, processed: 0, succeeded: 0, manual: 0, failed: 0, reviewScope: null, currentReview: null, currentReply: null, plan: { enabled: false, paused: false, timezone: "Asia/Shanghai", intervalMinutes: 15, windows: [] as Array<{ id: string; start: string; end: string }>, revision: 1 }, lastRun: null };
type DashboardTemplateFixture = {
  library: "good" | "bad";
  state: "ready" | "usable_with_warning" | "not_ready";
  usable: boolean;
  activeVersion: number | null;
  categoryCount: number;
  replyCount: number;
  latestSyncStatus: string;
  latestSyncAt: string | null;
  warning: string | null;
  message: string;
};

const dashboard = {
  metrics: { todayRead: 0, good: 0, bad: 0, generated: 0, sent: 0, failed: 0, productEdits: 0 },
  health: { tmall: "not_configured", feishu: "not_configured", deepseek: "not_configured", locators: "degraded" },
  queue: [],
  recent: null,
  templates: [] as DashboardTemplateFixture[],
  readiness: { ready: false, missing: ["淘宝商家登录", "好评话术库", "差评话术库", "DeepSeek"] },
  manualProducts: { total: 4, diverted: 12 },
};
const templateSources: { items: Array<Record<string, unknown>> } = {
  items: ["good", "bad"].map((library) => ({
    library,
    label: library === "good" ? "好评回复规则库" : "差评回复规则库",
    url: "",
    schema: {
      fields: library === "good"
        ? ["关键词分类", "包含关键词", "回复话术 1…N"]
        : ["一级分类", "二级分类", "包含关键词", "回复话术 1…N"],
      fallbackCategory: library === "good" ? "通用整体好评类" : "通用差评类",
    },
    status: "not_configured",
    activeVersion: null,
    categoryCount: 0,
    replyCount: 0,
    lastSyncedAt: null,
    warnings: [],
    health: {
      state: "not_ready",
      usable: false,
      activeVersion: null,
      latestSyncStatus: "not_synced",
      latestSyncAt: null,
      categoryCount: 0,
      replyCount: 0,
      warning: null,
      message: "尚未同步可用的话术版本，请检查链接后重新同步",
    },
  })),
};
let replyItems: Array<Record<string, unknown>> = [];
let manualProductTotal = 4;
let manualProducts: Array<{ id: string; itemId: string | null; title: string; sources: Array<"manual" | "excel">; lastMatchedAt: string | null }> = [];
let tmallConfigured = false;
let tmallAuthState = "not_configured";
let tmallAuthMessage: string | null = null;
let tmallContinueRejectOnce = false;
let automationControlFailure: Error | null = null;
let settingsMutationFailure: Error | null = null;
let complaintAutoSubmit = false;
let deepseekApiKeyConfigured = false;
let deepseekTestResponse: Record<string, unknown> = {};
let elementHealthStatus = 200;
let locatorRepairsStatus = 200;
let locatorActionFailure: Error | null = null;
let dashboardGate: Promise<void> | null = null;
let locatorRepairItems: Array<Record<string, unknown>> = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  resetAppQueryCacheForTests();
  automationStatus = { state: "disabled", trigger: null, currentWindow: null, nextRunAt: null, currentStep: "自动计划未启用", startedAt: null, processed: 0, succeeded: 0, manual: 0, failed: 0, reviewScope: null, currentReview: null, currentReply: null, plan: { enabled: false, paused: false, timezone: "Asia/Shanghai", intervalMinutes: 15, windows: [] as Array<{ id: string; start: string; end: string }>, revision: 1 }, lastRun: null };
  replyItems = [];
  manualProductTotal = 4;
  manualProducts = [];
  tmallConfigured = false;
  tmallAuthState = "not_configured";
  tmallAuthMessage = null;
  tmallContinueRejectOnce = false;
  automationControlFailure = null;
  settingsMutationFailure = null;
  complaintAutoSubmit = false;
  deepseekApiKeyConfigured = false;
  deepseekTestResponse = {
    adapter: "deepseek",
    status: "ready",
    models: ["deepseek-v4-pro"],
    latencyMs: 12,
    checks: {
      pro: { model: "deepseek-v4-pro", status: "ready", latencyMs: 12 },
    },
  };
  elementHealthStatus = 200;
  locatorRepairsStatus = 200;
  locatorActionFailure = null;
  dashboardGate = null;
  locatorRepairItems = [
    { id: "repair-1", operationKey: "reply.submit", label: "回复提交按钮", risk: "high", status: "pending_approval", evidenceSummary: "唯一匹配，影子验证通过", createdAt: "2026-07-14T02:00:00.000Z", resolvedAt: null, canRollback: false },
    { id: "repair-2", operationKey: "review.pagination", label: "列表翻页", risk: "low", status: "auto_applied", evidenceSummary: "当前正在使用", createdAt: "2026-07-14T01:00:00.000Z", resolvedAt: "2026-07-14T01:00:00.000Z", canRollback: true },
    { id: "repair-3", operationKey: "review.pagination", label: "列表翻页", risk: "low", status: "approved", evidenceSummary: "较早的历史版本", createdAt: "2026-07-13T01:00:00.000Z", resolvedAt: "2026-07-13T01:00:00.000Z", canRollback: false },
  ];
  dashboard.health = { tmall: "not_configured", feishu: "not_configured", deepseek: "not_configured", locators: "degraded" };
  dashboard.readiness.ready = false;
  window.history.pushState({}, "", "/");
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "test-csrf", readOnly: true });
      if (url.includes("/api/ui-sessions/")) return json({ activeCount: 1 });
      if (url.endsWith("/api/automation/status")) return json(automationStatus);
      if (url.endsWith("/api/automation-plan")) return init?.method === "PUT" ? json(automationStatus.plan) : json(automationStatus.plan);
      if (url.endsWith("/api/review-scope")) return json(reviewScope);
      if (url.includes("/api/automation/")) {
        if (automationControlFailure) throw automationControlFailure;
        return json(automationStatus);
      }
      if (url.endsWith("/api/dashboard")) {
        if (dashboardGate) await dashboardGate;
        return json({ ...dashboard, manualProducts: { ...dashboard.manualProducts, total: manualProductTotal } });
      }
      if (/\/api\/replies\/[^/]+\/resolve-uncertain$/u.test(url)) {
        const id = url.split("/").at(-2);
        const item = replyItems.find((candidate) => candidate.id === id);
        if (!item) return json({ error: "not_found" }, 404);
        const outcome = JSON.parse(String(init?.body ?? "{}")) as { outcome?: string };
        item.state = outcome.outcome === "sent" ? "sent" : "read_only_ready";
        item.errorMessage = null;
        return json(item);
      }
      if (/\/api\/replies\/[^/]+\/reprocess$/u.test(url)) {
        const id = url.split("/").at(-2);
        return json(replyItems.find((item) => item.id === id) ?? { error: "not_found" }, id ? 200 : 404);
      }
      if (/\/api\/replies\/[^/]+$/u.test(url)) {
        const id = url.split("/").at(-1);
        const item = replyItems.find((candidate) => candidate.id === id);
        return item ? json(item) : json({ error: "not_found" }, 404);
      }
      if (url.endsWith("/api/replies")) return json({ items: replyItems, total: replyItems.length });
      if (url.endsWith("/api/template-sources")) return init?.method === "PUT" ? json(templateSources.items[1]) : json(templateSources);
      if (url.endsWith("/api/manual-products") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { title: string; itemId: string | null };
        const product = { id: `manual-${manualProductTotal + 1}`, itemId: body.itemId, title: body.title, sources: ["manual"] as Array<"manual" | "excel">, lastMatchedAt: null };
        manualProducts.unshift(product);
        manualProductTotal += 1;
        return json({ outcome: "created", product, catalogRevision: 2 });
      }
      if (url.includes("/api/manual-products")) return json({ catalogRevision: 1, total: manualProducts.length, page: 1, pageSize: 20, items: manualProducts, stats: { total: manualProductTotal, manualSourceCount: 1 + manualProducts.length, excelSourceCount: 3, lastImportAt: null } });
      if (url.endsWith("/api/locators")) return json({ items: [] });
      if (url.endsWith("/api/repairs")) return json({ items: [], total: 0 });
      if (url.endsWith("/api/element-health")) return elementHealthStatus === 200 ? json({ items: [
        { operationKey: "review.pagination", label: "列表翻页", risk: "low", health: "recovered", version: 2, statusLabel: "已自动恢复", lastSuccessAt: "2026-07-14T02:00:00.000Z" },
        { operationKey: "reply.submit", label: "回复提交按钮", risk: "high", health: "attention", version: 1, statusLabel: "需要处理", lastSuccessAt: null },
        { operationKey: "complaint.type", label: "投诉类型", risk: "high", health: "healthy", version: 1, statusLabel: "运行时自动检测", verificationState: "conditional", lastSuccessAt: null },
      ] }) : json({ error: "element_health_unavailable" }, elementHealthStatus);
      if (url.endsWith("/api/locator-repairs")) return locatorRepairsStatus === 200 ? json({ items: locatorRepairItems, total: locatorRepairItems.length }) : json({ error: "locator_repairs_unavailable" }, locatorRepairsStatus);
      if (/\/api\/locator-repairs\/[^/]+\/(approve|reject|rollback)$/u.test(url)) {
        if (locatorActionFailure) throw locatorActionFailure;
        return json({ id: "repair-1", status: "approved" });
      }
      if (url.endsWith("/api/settings")) {
        if (init?.method === "PUT" && settingsMutationFailure) throw settingsMutationFailure;
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body ?? "{}")) as { complaintAutoSubmit?: unknown };
          if (typeof body.complaintAutoSubmit === "boolean") complaintAutoSubmit = body.complaintAutoSubmit;
        }
        return json({ pollingIntervalSeconds: 30, batchSize: 20, retryCount: 1, feishuAppId: "", feishuAppSecretConfigured: false, deepseekApiKeyConfigured, deepseekBaseUrl: "https://api.deepseek.com", dailyModel: "deepseek-v4-pro", repairModel: "deepseek-v4-pro", complaintAutoSubmit, adapters: {} });
      }
      if (url.endsWith("/api/secrets/feishu_app_secret/prepare")) return json({ nonce: "one-use-nonce", expiresAt: Date.now() + 300000 });
      if (url.endsWith("/api/secrets/feishu_app_secret")) return json({ configured: true });
      if (url.endsWith("/api/secrets/deepseek_api_key/prepare")) return json({ nonce: "deepseek-nonce", expiresAt: Date.now() + 300000 });
      if (url.endsWith("/api/secrets/deepseek_api_key")) {
        deepseekApiKeyConfigured = init?.method !== "DELETE";
        return json({ configured: deepseekApiKeyConfigured });
      }
      if (url.endsWith("/api/tmall-auth/credentials/prepare")) return json({ nonce: "tmall-nonce", expiresAt: Date.now() + 300000 });
      if (url.endsWith("/api/tmall-auth/credentials")) {
        tmallConfigured = init?.method !== "DELETE";
        return json({ configured: tmallConfigured, maskedAccount: tmallConfigured ? "te***nt" : null });
      }
      if (url.endsWith("/api/tmall-auth/open-review-page")) return json({ state: "authenticated", storeName: "测试店铺", page: "review_list" });
      if (url.endsWith("/api/tmall-auth/continue")) {
        if (tmallContinueRejectOnce) {
          tmallContinueRejectOnce = false;
          tmallAuthState = "credential_rejected";
          tmallAuthMessage = "淘宝明确提示账号或密码错误";
          return json({ state: "credential_rejected", page: "login", message: tmallAuthMessage }, 422);
        }
        tmallAuthState = "authenticated";
        tmallAuthMessage = null;
        return json({ state: "authenticated", storeName: "测试店铺", page: "review_list" });
      }
      if (url.endsWith("/api/connections/feishu/test")) return json({ adapter: "feishu", status: "ready" });
      if (url.endsWith("/api/connections/deepseek/test")) return json(deepseekTestResponse);
      if (url.endsWith("/api/storage")) return json({
        usedBytes: 4096,
        limitBytes: 2147483648,
        browserProfileBytes: 0,
        counts: { reviews: 12, submissionAudit: 8, manualProducts: 4, manualHolds: 3, actionTombstones: 6, locatorRepairs: 0, locatorSnapshots: 0, runs: 2, templateVersions: 2 },
        policies: {},
      });
      if (url.endsWith("/api/tmall-auth/status")) {
        return json({ state: tmallConfigured ? tmallAuthState === "not_configured" ? "configured" : tmallAuthState : "not_configured", configured: tmallConfigured, maskedAccount: tmallConfigured ? "te***nt" : null, autoReloginEnabled: tmallConfigured, lastFailure: tmallAuthMessage });
      }
      return json({ error: "not_found" }, 404);
    }),
  );
});

describe("merchant console", () => {
  it("registers the foreground browser console from the application root", async () => {
    render(<App />);

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) =>
      String(url).includes("/api/ui-sessions/") && init?.method === "POST",
    )).toBe(true));
  });

  it("keeps complaint auto-submit opt-in and saves an explicit change", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/settings");
    render(<App />);

    const autoSubmit = await screen.findByRole("checkbox", { name: "投诉自动提交" });
    expect(autoSubmit).not.toBeChecked();
    expect(autoSubmit).toHaveClass("complaint-auto-submit-input");
    expect(screen.getByTestId("complaint-auto-submit-control")).toHaveTextContent("已关闭");
    expect(screen.getByText("默认关闭；开启后仅对已通过全部校验的投诉自动提交。" )).toBeVisible();

    await user.click(autoSubmit);

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) =>
      String(url).endsWith("/api/settings")
      && init?.method === "PUT"
      && String(init.body).includes('"complaintAutoSubmit":true'),
    )).toBe(true));
    expect(await screen.findByRole("checkbox", { name: "投诉自动提交", checked: true })).toBeVisible();
    expect(screen.getByTestId("complaint-auto-submit-control")).toHaveTextContent("已开启");
  });

  it("does not describe the active review scope as locked", async () => {
    automationStatus = {
      ...automationStatus,
      state: "running",
      startedAt: "2026-07-19T08:00:00.000Z",
      currentStep: "正在检查淘宝登录",
      reviewScope: { ...reviewScope, processingMode: "content_unanswered" },
    } as unknown as typeof automationStatus;
    render(<App />);

    const toolbar = await screen.findByLabelText("本轮处理范围");
    expect(within(toolbar).queryByText(/锁定/u)).not.toBeInTheDocument();
    expect(await within(toolbar).findByText("当前运行使用此范围；修改将在下一次运行生效")).toBeVisible();
  });

  it("presents one clear merchant workflow and hides engineering diagnostics from primary navigation", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "评论处理工作台" })).toBeVisible();
    expect(await screen.findByText("启用前还需完成必要配置")).toBeVisible();
    expect(screen.getByText("评论助手")).toBeVisible();
    expect(screen.getByText("自动回复控制台")).toBeVisible();
    for (const label of ["工作台", "回复结果", "投诉记录", "话术库", "自动跳过商品", "设置"]) {
      expect(screen.getByRole("link", { name: label })).toBeVisible();
    }
    expect(screen.queryByText("漫步者")).not.toBeInTheDocument();
    expect(screen.queryByText("漫步者官方旗舰店")).not.toBeInTheDocument();
    expect(screen.queryByText("天猫评论助手")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "元素健康" })).not.toBeInTheDocument();
    expect(screen.queryByText(/LOCAL WORKSPACE|AUTOMATION|骨架|适配器/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /提交回复/ })).not.toBeInTheDocument();
    expect(screen.queryByText("试运行模式")).not.toBeInTheDocument();
  });

  it("shows the real queue outcome instead of labeling every non-sent row as generated", async () => {
    (dashboard.queue as Array<Record<string, unknown>>).push(
      {
        id: "retry-row",
        review: "颜值很好看",
        product: "漫步者蓝牙音箱",
        library: "good",
        category: "外观颜值类",
        state: "retry_wait",
        errorCode: null,
        finalReply: "",
      },
      {
        id: "platform-row",
        review: "平台已经处理",
        product: "漫步者耳机",
        library: null,
        category: "",
        state: "not_actionable",
        errorCode: "TMALL_PLATFORM_COMPLAINT_HANDLED",
        finalReply: "",
      },
    );

    render(<App />);

    expect(await screen.findByText("等待重试")).toBeVisible();
    expect(screen.getByText("平台已处理")).toBeVisible();
    expect(screen.queryByText("已生成")).not.toBeInTheDocument();
  });

  it("describes login recovery without claiming that a store identity was checked", async () => {
    dashboard.health.tmall = "authenticated";
    render(<App />);

    expect(await screen.findByText("登录已验证，掉线自动恢复")).toBeVisible();
    expect(screen.getByText("单条异常自动跳过")).toBeVisible();
    expect(screen.queryByText(/目标店铺身份/u)).not.toBeInTheDocument();
    expect(screen.queryByText("不确定时自动暂停")).not.toBeInTheDocument();
  });

  it("keeps normal page-element checks out of the daily configuration area", async () => {
    dashboard.health.locators = "healthy";
    render(<App />);

    await screen.findByRole("heading", { name: "评论处理工作台" });
    expect(screen.queryByText("页面元素")).not.toBeInTheDocument();
    expect(screen.queryByText(/关键元素.*实页验证/u)).not.toBeInTheDocument();
    expect(await screen.findByText("启用前还需完成必要配置")).toBeVisible();
  });

  it("does not show an element exception for an unverified baseline before a run", async () => {
    dashboard.health.locators = "degraded";
    locatorRepairsStatus = 500;
    render(<App />);

    await screen.findByRole("heading", { name: "评论处理工作台" });
    await waitFor(() => {
      expect(vi.mocked(global.fetch).mock.calls.some(([request]) => String(request).endsWith("/api/locator-repairs"))).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText("页面检查提醒")).not.toBeInTheDocument();
  });

  it("shows neutral connection checks instead of false configuration failures while dashboard data is loading", async () => {
    dashboardGate = new Promise(() => undefined);
    render(<App />);

    expect(screen.queryByText("启用前还需完成必要配置")).not.toBeInTheDocument();
    expect(screen.queryByText("不可用")).not.toBeInTheDocument();
    expect(screen.queryByText("去配置")).not.toBeInTheDocument();
    expect(screen.getAllByText("检测中").length).toBeGreaterThanOrEqual(4);
  });

  it("keeps completed automatic element repairs in records instead of the daily workbench", async () => {
    locatorRepairItems = locatorRepairItems.filter((item) => item.status !== "pending_approval");
    render(<App />);
    await screen.findByRole("heading", { name: "评论处理工作台" });
    await waitFor(() => expect(vi.mocked(global.fetch).mock.calls.some(([request]) => String(request).endsWith("/api/locator-repairs"))).toBe(true));
    expect(screen.queryByText("页面检查提醒")).not.toBeInTheDocument();
  });

  it("treats saved Tmall credentials as ready while page checks remain automatic", async () => {
    dashboard.health.tmall = "configured";
    dashboard.readiness.ready = true;
    dashboard.readiness.missing = [];
    render(<App />);

    await waitFor(() => {
      const detail = screen.getByText("账号已保存，运行时自动检查");
      expect(detail.closest(".readiness-card")).toHaveClass("ready");
    });
  });

  it("makes the formal run-once action obvious but blocks it until required connections are ready", async () => {
    render(<App />);
    const start = await screen.findByRole("button", { name: "立即处理一轮" });
    expect(start).toBeDisabled();
    expect(await screen.findByText("完成配置后即可开始")).toBeVisible();
    expect(screen.queryByText("安全试运行")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始试运行" })).not.toBeInTheDocument();
  });

  it("turns the immediate run action into a dedicated automation command", async () => {
    render(<App />);

    expect(await screen.findByLabelText("自动化控制区")).toBeVisible();
    expect(screen.getByRole("button", { name: "立即处理一轮" })).toHaveClass("automation-launch-button");
    expect(screen.getByText("投诉仅在已开启自动提交且通过全部校验后才会提交。")).toBeVisible();
    expect(screen.getByRole("button", { name: "设置自动时间" })).toBeVisible();
  });

  it("opens the real review-scope and automation-plan dialogs from the workbench", async () => {
    const user = userEvent.setup();
    render(<App />);
    const scopeTrigger = await screen.findByRole("button", { name: "修改本轮处理范围" });
    await user.click(scopeTrigger);
    expect(screen.getByRole("dialog", { name: "选择处理日期" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(scopeTrigger).toHaveFocus();
    const planTextTrigger = screen.getByRole("button", { name: "设置自动时间" });
    await user.click(planTextTrigger);
    expect(screen.getByRole("dialog", { name: "设置自动运行时间" })).toBeVisible();
    const interval = screen.getByLabelText("运行间隔（分钟）");
    await user.clear(interval);
    await user.type(interval, "22");
    await user.keyboard("{Escape}");
    expect(planTextTrigger).toHaveFocus();
    const planSummaryTrigger = screen.getByRole("button", { name: "编辑自动计划" });
    await user.click(planSummaryTrigger);
    expect(screen.getByRole("dialog", { name: "设置自动运行时间" })).toBeVisible();
    expect(screen.getByLabelText("运行间隔（分钟）")).toHaveValue(15);
    await user.keyboard("{Escape}");
    expect(planSummaryTrigger).toHaveFocus();
  });

  it("places the real manual-product count beside the date selector rather than in health cards", async () => {
    const user = userEvent.setup();
    render(<App />);

    const scopeToolbar = await screen.findByLabelText("本轮处理范围");
    const manualEntry = await within(scopeToolbar).findByRole("link", { name: "自动跳过商品 · 4" });
    expect(manualEntry).toBeVisible();
    expect(within(scopeToolbar).getByRole("button", { name: "修改本轮处理范围" })).toBeVisible();
    expect(screen.getAllByRole("link", { name: /自动跳过商品/u })).toHaveLength(2);
    expect(screen.queryByText("4 个商品正在生效")).not.toBeInTheDocument();
    await user.click(manualEntry);
    expect(await screen.findByRole("heading", { name: "自动跳过商品" })).toBeVisible();
    expect(screen.getByText("命中的中差评自动跳过，不回复、不投诉；好评继续自动处理")).toBeVisible();
  });

  it("refreshes the workbench total immediately after a manual product is added", async () => {
    const user = userEvent.setup();
    render(<App />);
    const scopeToolbar = await screen.findByLabelText("本轮处理范围");
    await user.click(await within(scopeToolbar).findByRole("link", { name: "自动跳过商品 · 4" }));
    await user.click(await screen.findByRole("button", { name: "手工添加商品" }));
    await user.type(screen.getByLabelText("商品 ID（必填）"), "900000000000100");
    await user.type(screen.getByLabelText("商品标题（选填，仅用于辨认）"), "新增后刷新工作台的商品");
    await user.click(screen.getByRole("button", { name: "添加到名单" }));
    expect(await screen.findByText("商品已添加到自动跳过名单")).toBeVisible();

    await user.click(screen.getByRole("link", { name: "工作台" }));
    const refreshedToolbar = await screen.findByLabelText("本轮处理范围");
    expect(await within(refreshedToolbar).findByRole("link", { name: "自动跳过商品 · 5" })).toBeVisible();
  });

  it("keeps settings as a plan summary and sends editing back to the workbench", async () => {
    automationStatus.plan = { enabled: true, paused: false, timezone: "Asia/Shanghai", intervalMinutes: 15, windows: [{ id: "morning", start: "08:00", end: "09:00" }], revision: 2 };
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "设置" }));
    expect(await screen.findByRole("heading", { name: "自动回复时间" })).toBeVisible();
    expect(screen.getByText("08:00—09:00")).toBeVisible();
    expect(screen.getByText("15 分钟")).toBeVisible();
    expect(screen.getByRole("link", { name: "前往工作台修改" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("button", { name: "添加时间段" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("运行间隔（分钟）")).not.toBeInTheDocument();
  });

  it("shows a paused automation plan before the enabled state in settings", async () => {
    automationStatus.plan = { enabled: true, paused: true, timezone: "Asia/Shanghai", intervalMinutes: 15, windows: [{ id: "morning", start: "08:00", end: "09:00" }], revision: 2 };
    window.history.pushState({}, "", "/settings");
    render(<App />);

    expect(await screen.findByText("计划已暂停")).toBeVisible();
    expect(screen.queryByText("计划已启用")).not.toBeInTheDocument();
  });

  it("explains manual-product lifecycle in data management without offering rule cleanup", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "设置" }));
    await user.click(await screen.findByText("高级设置与诊断"));

    const storagePanel = (await screen.findByRole("heading", { name: "存储与自动清理" })).closest("article");
    expect(storagePanel).not.toBeNull();
    expect(within(storagePanel!).getByText("自动跳过商品")).toBeVisible();
    expect(within(storagePanel!).getByText("4 条")).toBeVisible();
    expect(within(storagePanel!).getByText("已自动跳过评价")).toBeVisible();
    expect(within(storagePanel!).getByText("3 条")).toBeVisible();
    expect(within(storagePanel!).getByText("回复提交记录")).toBeVisible();
    expect(within(storagePanel!).getByText("防重复处理记录")).toBeVisible();
    expect(within(storagePanel!).getByText("页面检查记录")).toBeVisible();
    expect(within(storagePanel!).queryByText("提交审计")).not.toBeInTheDocument();
    expect(within(storagePanel!).queryByText("终结记录")).not.toBeInTheDocument();
    expect(within(storagePanel!).queryByText("脱敏页面快照")).not.toBeInTheDocument();
    expect(within(storagePanel!).getByText(/恢复出厂设置会清空自动跳过商品名单和处理日期/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: /清理.*规则|清理.*名单/u })).not.toBeInTheDocument();
  });

  it("shows user-facing element health and approval controls without exposing selectors", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "设置" }));
    await user.click(await screen.findByRole("link", { name: /自动修复与页面诊断/u }));

    expect(await screen.findByRole("heading", { name: "自动修复与页面诊断" })).toBeVisible();
    expect(screen.getAllByText("已自动恢复").length).toBeGreaterThan(0);
    expect(screen.getAllByText("需要处理").length).toBeGreaterThan(0);
    expect(screen.getByText("运行时自动检测")).toBeVisible();
    expect(screen.getByText("仅在实际进入投诉流程时按需检测，不会阻止正常评价处理")).toBeVisible();
    expect(screen.getByRole("heading", { name: "回复控件发生变化，需要确认" })).toBeVisible();
    expect(screen.getByRole("button", { name: "确认新的识别方式" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "确认使用新定位" })).not.toBeInTheDocument();
    const technicalDetails = screen.getByText("查看技术验证详情");
    expect(screen.getByText("唯一匹配，影子验证通过")).not.toBeVisible();
    await user.click(technicalDetails);
    expect(screen.getByText("唯一匹配，影子验证通过")).toBeVisible();
    expect(screen.getByText(/退款、投诉和处罚的纯通知浮层会自动关闭/u)).toBeVisible();
    expect(screen.getByText(/不会点击“处理、确认、同意、拒绝、退款、申诉”等业务按钮/u)).toBeVisible();
    expect(screen.getAllByRole("button", { name: "回退" })).toHaveLength(1);
    expect(screen.queryByText("button[name='评价回复']")).not.toBeInTheDocument();
  });

  it("shows the fixed good and bad template contracts without editable field mappings", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "话术库" }));

    expect(await screen.findByRole("heading", { name: "好评话术库" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "差评话术库" })).toBeVisible();
    expect(screen.getByLabelText("好评库飞书链接")).toBeVisible();
    expect(screen.getByLabelText("差评库飞书链接")).toBeVisible();
    expect(screen.getAllByText("通用差评类").length).toBeGreaterThan(0);
    expect(screen.getByText("一级分类空白时沿用上一行")).toBeVisible();
    expect(screen.getByText("每条新评价都会在命中分类中随机抽取一条话术；已处理的同一评价不会重复提交。")).toBeVisible();
    expect(screen.queryByLabelText("差评库二级分类字段")).not.toBeInTheDocument();
  });

  it("sends the Feishu secret once, clears the input, and never uses browser storage", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "设置" }));

    const appId = await screen.findByLabelText("飞书 App ID");
    const secret = screen.getByLabelText("飞书 App Secret");
    await user.type(appId, "cli_test_app");
    await user.type(secret, "one-time-secret");
    await user.click(screen.getByRole("button", { name: "保存飞书凭据" }));

    await waitFor(() => expect(secret).toHaveValue(""));
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    const calls = vi.mocked(fetch).mock.calls;
    const secretCall = calls.find(([url]) => String(url).endsWith("/api/secrets/feishu_app_secret"));
    expect(String(secretCall?.[1]?.body)).toContain("one-time-secret");
  });

  it("sends the DeepSeek key once, clears it, and exposes a real connection action", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "设置" }));

    const key = await screen.findByLabelText("DeepSeek API Key");
    await user.type(key, "one-time-deepseek-key");
    await user.click(screen.getByRole("button", { name: "保存 DeepSeek" }));

    await waitFor(() => expect(key).toHaveValue(""));
    expect(screen.getByRole("button", { name: "测试 DeepSeek" })).toBeVisible();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("shows the single Pro validation result, then clears an old model failure after saving a new key", async () => {
    deepseekApiKeyConfigured = true;
    deepseekTestResponse = {
      adapter: "deepseek",
      status: "error",
      models: [],
      latencyMs: 18,
      checks: {
        pro: { model: "deepseek-v4-pro", status: "error", detail: "DeepSeek 服务暂时不可用，请稍后重试" },
      },
    };
    const user = userEvent.setup();
    window.history.pushState({}, "", "/settings");
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "测试 DeepSeek" }));
    expect(await screen.findByText("Pro 验证失败：DeepSeek 服务暂时不可用，请稍后重试")).toBeVisible();
    expect(screen.queryByText(/Flash/u)).not.toBeInTheDocument();

    const key = screen.getByLabelText("DeepSeek API Key");
    await user.type(key, "replacement-deepseek-key");
    await user.click(screen.getByRole("button", { name: "保存 DeepSeek" }));

    expect(await screen.findByText("DeepSeek 已保存，待验证。")).toBeVisible();
    expect(screen.queryByText("Pro 验证失败：DeepSeek 服务暂时不可用，请稍后重试")).not.toBeInTheDocument();
  });

  it("never persists Tmall account or password input in browser storage", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "设置" }));

    const account = await screen.findByLabelText("淘宝商家账号");
    const password = screen.getByLabelText("淘宝商家密码");
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "new-password");

    await user.type(account, "test-account");
    await user.type(password, "test-password");
    await user.click(screen.getByRole("button", { name: "保存并验证登录" }));
    await waitFor(() => expect(password).toHaveValue(""));
    await waitFor(() => expect(screen.getByText("登录已验证，可以开始处理评论。")).toBeVisible());
    await waitFor(() => {
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
    });
  });

  it("shows a non-blocking Feishu warning when an active template remains usable after sync failure", async () => {
    dashboard.readiness.ready = true;
    dashboard.readiness.missing = [];
    dashboard.templates = [{
      library: "good",
      state: "usable_with_warning",
      usable: true,
      activeVersion: 4,
      categoryCount: 13,
      replyCount: 39,
      latestSyncStatus: "failed",
      latestSyncAt: "2026-07-16T09:00:00.000Z",
      warning: "最近一次同步未完成，当前仍使用已验证的话术版本",
      message: "最近一次同步未完成，当前仍使用已验证的话术版本",
    }];
    templateSources.items[0] = {
      ...templateSources.items[0],
      status: "error",
      activeVersion: 4,
      categoryCount: 13,
      replyCount: 39,
      health: { ...dashboard.templates[0] },
    };

    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText("最近一次同步未完成，当前仍使用已验证的话术版本")).toBeVisible();
    expect(screen.getByText("需关注")).toBeVisible();
    await user.click(screen.getByRole("link", { name: "话术库" }));
    expect(await screen.findByText("最近一次同步未完成，当前仍使用已验证的话术版本")).toBeVisible();
    expect(screen.queryByText("页面结构正常")).not.toBeInTheDocument();
  });

  it("revalidates a saved Tmall login without asking for the credentials again", async () => {
    tmallConfigured = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "设置" }));

    const verify = await screen.findByRole("button", { name: "验证并进入评价页" });
    await user.click(verify);

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/api/tmall-auth/open-review-page"))).toBe(true));
    expect(screen.getByLabelText("淘宝商家账号")).toHaveValue("");
    expect(screen.getByLabelText("淘宝商家密码")).toHaveValue("");
  });

  it("keeps manual verification actionable and continues the existing browser session", async () => {
    tmallConfigured = true;
    tmallAuthState = "manual_verification_required";
    tmallAuthMessage = "请在已打开的淘宝窗口完成短信、电话、扫码或安全验证";
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "设置" }));

    expect(await screen.findByText("请在已打开的淘宝窗口完成短信、电话、扫码或安全验证")).toBeVisible();
    expect(screen.queryByText(/10分钟|检查账号密码/u)).not.toBeInTheDocument();
    expect(screen.getByText("完成验证码、短信验证或新手引导后，点击此按钮继续登录与页面检查。")).toBeVisible();
    const continueButton = screen.getByRole("button", { name: "已处理淘宝页面，重新检测" });
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/api/tmall-auth/continue"))).toBe(true));
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/api/tmall-auth/open-review-page"))).toBe(false);
    await waitFor(() => expect(screen.getByText("登录已验证，可以开始处理评论。")).toBeVisible());
  });

  it("uses recheck-and-continue instead of paused resume for an automation manual-action state", async () => {
    dashboard.readiness.ready = true;
    dashboard.readiness.missing = [];
    automationStatus = {
      ...automationStatus,
      state: "manual_action_required",
      currentStep: "请在淘宝窗口完成验证后重新检测",
    };
    const user = userEvent.setup();
    render(<App />);

    const recheck = await screen.findByRole("button", { name: "重新检测并继续" });
    await user.click(recheck);

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/api/automation/recheck-and-continue"))).toBe(true));
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/api/automation/resume"))).toBe(false);
  });

  it("refreshes a rejected continuation and lets the next click start a new login attempt", async () => {
    tmallConfigured = true;
    tmallAuthState = "manual_verification_required";
    tmallAuthMessage = "请在已打开的淘宝窗口完成短信验证";
    tmallContinueRejectOnce = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "设置" }));

    await user.click(await screen.findByRole("button", { name: "已处理淘宝页面，重新检测" }));
    await waitFor(() => expect(screen.getAllByText("淘宝明确提示账号或密码错误").length).toBeGreaterThan(0));
    const retry = await screen.findByRole("button", { name: "验证并进入评价页" });
    vi.mocked(fetch).mockClear();
    await user.click(retry);

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/api/tmall-auth/open-review-page"))).toBe(true));
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/api/tmall-auth/continue"))).toBe(false);
  });

  it.each([
    ["manual_action_required", "请关闭淘宝窗口中的新手引导后继续检测"],
    ["not_ready", "淘宝页面尚未完成登录，请继续操作后再检测"],
    ["navigation_failed", "淘宝页面暂时无法进入评价管理，请处理当前页面后继续检测"],
  ])("shows a recoverable %s state without a password-failure lock", async (state, message) => {
    tmallConfigured = true;
    tmallAuthState = state;
    tmallAuthMessage = message;
    render(<App />);
    await userEvent.setup().click(screen.getByRole("link", { name: "设置" }));

    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.getByRole("button", { name: "已处理淘宝页面，重新检测" })).toBeEnabled();
    expect(screen.queryByText(/10分钟/u)).not.toBeInTheDocument();
  });

  it("shows an inspectable read-only draft with classification and template evidence", async () => {
    replyItems = [{
      id: "draft-1",
      sourceKey: "tmall:order:one",
      orderId: "3309081924709001",
      review: "音质还可以，但是戴着有点夹耳朵",
      stars: 5,
      product: "漫步者 X1 EVO 真无线蓝牙耳机",
      reviewedAt: "2026-07-14 08:00",
      sentimentLabel: "positive",
      library: "bad",
      primaryCategory: "佩戴体验",
      category: "佩戴体验",
      classificationConfidence: 0.91,
      classificationReason: "买家明确反馈夹耳朵",
      templateSequence: 2,
      originalTemplate: "非常抱歉给您带来不适的佩戴体验。",
      finalReply: "非常抱歉给您带来不适的佩戴体验，建议调整 X1 EVO 的佩戴角度。若使用过程中有任何疑问可咨询漫步者客服，祝您生活愉快！",
      productAdjusted: true,
      rewriteNotes: "已将模板产品指代改为当前商品",
      attentionReasons: ["页面标记为正面评价，但评论内容被识别为差评"],
      state: "needs_attention",
      errorMessage: null,
      discoveredAt: "2026-07-14T08:01:00.000Z",
      processedAt: "2026-07-14T08:01:02.000Z",
    }];
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "回复结果" }));
    await user.click(await screen.findByRole("button", { name: /查看评论详情：音质还可以/u }));

    expect(screen.getByRole("heading", { name: "回复详情" })).toBeVisible();
    expect(screen.getByText("买家明确反馈夹耳朵")).toBeVisible();
    expect(screen.getByText("非常抱歉给您带来不适的佩戴体验。")).toBeVisible();
    expect(screen.getByText(/建议调整 X1 EVO 的佩戴角度/u)).toBeVisible();
    expect(screen.getByText("回复已生成，等待自动提交")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^(发送回复|提交回复|批量回复)$/u })).not.toBeInTheDocument();
  });

  it("shows a complaint timeout as a complaint-stage failure instead of a generic AI retry", async () => {
    replyItems = [{
      id: "complaint-timeout-1", sourceKey: "tmall:complaint-timeout-1", orderId: "1",
      review: "耳机不错，颜值也挺高", product: "漫步者耳机", reviewedAt: "2026-07-20 10:43",
      sentimentLabel: "positive", library: null, primaryCategory: "", category: "",
      classificationConfidence: null, classificationReason: "", templateSequence: null, originalTemplate: "",
      finalReply: "", productAdjusted: false, rewriteNotes: "", attentionReasons: [],
      state: "discovered", errorMessage: null, complaintErrorKind: "timeout",
      discoveredAt: "2026-07-20T02:43:02.000Z", processedAt: null,
    }];
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "回复结果" }));
    await user.click(await screen.findByRole("button", { name: /查看评论详情：耳机不错/u }));

    expect(screen.getAllByText("投诉预审超时").length).toBeGreaterThan(0);
    expect(screen.queryByText("等待重试")).not.toBeInTheDocument();
    expect(screen.getByText("本条未回复、未投诉；普通评价会在下一轮自动释放，疑似违规评价会继续严格核验。")).toBeVisible();
    expect(screen.queryByText("回复已生成，等待自动提交")).not.toBeInTheDocument();
  });

  it("shows the failed AI stage for a retry-wait draft", async () => {
    replyItems = [{
      id: "rewrite-timeout-1", sourceKey: "tmall:rewrite-timeout-1", orderId: "2",
      review: "音质非常得劲，不会炸耳，挺好的", product: "漫步者耳机", reviewedAt: "2026-07-20 10:43",
      sentimentLabel: "positive", library: "good", primaryCategory: "", category: "音质音效类",
      classificationConfidence: 0.95, classificationReason: "明确称赞音质", templateSequence: 1, originalTemplate: "感谢您的认可",
      finalReply: "", productAdjusted: false, rewriteNotes: "", attentionReasons: [],
      state: "retry_wait", errorMessage: null, failedStage: "rewrite", aiRetryErrorKind: "timeout",
      discoveredAt: "2026-07-20T02:43:46.000Z", processedAt: null,
    }];
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "回复结果" }));
    await user.click(await screen.findByRole("button", { name: /查看评论详情：音质非常得劲/u }));

    expect(screen.getAllByText("等待重试").length).toBeGreaterThan(0);
    expect(screen.getByText("回复生成超时，等待下一轮自动重试")).toBeVisible();
    expect(screen.queryByText("回复已生成，等待自动提交")).not.toBeInTheDocument();
  });

  it("offers a clear recovery action when the automatic run fails", async () => {
    automationStatus = { ...automationStatus, state: "error", currentStep: "评论列表结构需要检查" };
    render(<App />);

    expect(await screen.findByText("评论列表结构需要检查")).toBeVisible();
    expect(screen.getByRole("button", { name: "立即处理一轮" })).toBeVisible();
  });

  it("lets the merchant stop an enabled plan directly while waiting", async () => {
    automationStatus = {
      ...automationStatus,
      state: "waiting",
      currentStep: "等待下一次运行",
      plan: { enabled: true, paused: false, timezone: "Asia/Shanghai", intervalMinutes: 15, windows: [{ id: "morning", start: "08:00", end: "09:00" }], revision: 2 },
    };
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "停止并关闭计划" }));
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/api/automation/stop"))).toBe(true);
  });

  it("shows diverted reviews in the primary run metrics instead of product-edit internals", async () => {
    automationStatus = { ...automationStatus, state: "running", processed: 8, succeeded: 4, manual: 3, failed: 1 };
    render(<App />);

    const diverted = (await screen.findByText("名单跳过")).closest("article");
    expect(diverted).not.toBeNull();
    expect(await within(diverted!).findByText("3")).toBeVisible();
    expect(within(diverted!).getByText("不回复、不投诉")).toBeVisible();
    expect(screen.queryByText("商品修正")).not.toBeInTheDocument();
  });

  it("uses a fixed merchant-facing fallback for an unexpected run-control failure", async () => {
    automationControlFailure = new Error("ECONNRESET private-host");
    dashboard.readiness.ready = true;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "立即处理一轮" }));

    expect(await screen.findByText("自动回复操作失败，请稍后重试")).toBeVisible();
    expect(screen.queryByText(/ECONNRESET|private-host/u)).not.toBeInTheDocument();
  });

  it("uses a fixed merchant-facing fallback for an unexpected settings failure", async () => {
    settingsMutationFailure = new Error("ECONNREFUSED secret-host");
    const user = userEvent.setup();
    window.history.pushState({}, "", "/settings");
    render(<App />);
    const key = await screen.findByLabelText("DeepSeek API Key");
    await user.type(key, "temporary-key");
    await user.click(screen.getByRole("button", { name: "保存 DeepSeek" }));

    expect(await screen.findByText("DeepSeek 保存失败，请稍后重试")).toBeVisible();
    expect(screen.queryByText(/ECONNREFUSED|secret-host/u)).not.toBeInTheDocument();
  });

  it.each([
    [503, 200],
    [200, 503],
    [503, 503],
  ])("never reports page health as normal when health requests fail (%s/%s)", async (healthStatus, repairsStatus) => {
    elementHealthStatus = healthStatus;
    locatorRepairsStatus = repairsStatus;
    window.history.pushState({}, "", "/health");
    render(<App />);

    expect((await screen.findAllByText("页面状态无法确认")).length).toBeGreaterThan(0);
    expect(screen.queryByText("页面结构正常")).not.toBeInTheDocument();
  });

  it("uses a fixed merchant-facing fallback for an unexpected repair action failure", async () => {
    locatorActionFailure = new Error("TypeError raw-selector-details");
    const user = userEvent.setup();
    window.history.pushState({}, "", "/health");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "确认新的识别方式" }));

    expect(await screen.findByText("页面修复操作失败，请稍后重试")).toBeVisible();
    expect(screen.queryByText(/raw-selector-details/u)).not.toBeInTheDocument();
  });

  it("locks an uncertain submission and waits for automatic platform synchronization", async () => {
    replyItems = [{
      id: "uncertain-1", sourceKey: "tmall:uncertain-1", orderId: "1", review: "音质一般", product: "漫步者 X1",
      reviewedAt: "2026-07-14 08:00", sentimentLabel: "negative", library: "bad", primaryCategory: "音质", category: "音质一般",
      classificationConfidence: 0.9, classificationReason: "音质反馈", templateSequence: 1, originalTemplate: "非常抱歉没有达到您的预期。",
      finalReply: "非常抱歉没有达到您的预期，若有任何疑问欢迎咨询在线客服。", productAdjusted: false, rewriteNotes: "无需修改", attentionReasons: [],
      state: "submission_uncertain", errorMessage: "提交结果无法确认", discoveredAt: "2026-07-14T08:00:00.000Z", processedAt: "2026-07-14T08:01:00.000Z",
    }];
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "回复结果" }));
    await user.click(await screen.findByRole("button", { name: /查看评论详情：音质一般/u }));

    expect(screen.getByText("提交结果正在等待平台同步")).toBeVisible();
    expect(screen.getByText("已锁定等待平台同步")).toBeVisible();
    expect(screen.queryByRole("button", { name: "平台已显示回复" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认平台未回复" })).not.toBeInTheDocument();
  });
});
