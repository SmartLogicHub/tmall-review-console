import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiSessionForTests } from "../api/client";
import { RepliesPage } from "./replies";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><RepliesPage /></QueryClientProvider>);
}

function complaintFailureReply(kind: string) {
  return {
    id: `complaint-failure-${kind}`,
    sourceKey: `tmall:complaint-failure-${kind}`,
    orderId: null,
    review: "测试评价",
    product: "测试商品",
    reviewedAt: null,
    sentimentLabel: "positive",
    library: null,
    primaryCategory: "",
    category: "",
    classificationConfidence: null,
    classificationReason: "",
    templateSequence: null,
    originalTemplate: "",
    finalReply: "",
    productAdjusted: false,
    rewriteNotes: "",
    attentionReasons: [],
    state: "discovered",
    errorMessage: null,
    failedStage: null,
    aiRetryErrorKind: null,
    complaintErrorKind: kind,
    discoveredAt: "2026-07-21T01:00:00.000Z",
    processedAt: null,
  };
}

beforeEach(() => {
  resetApiSessionForTests();
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "test-csrf" });
    if (url.endsWith("/api/replies")) return json({ items: [], total: 0 });
    if (url.includes("/api/storage/reviews") && method === "DELETE") {
      return json({ deleted: 3, storage: { counts: { reviews: 0 } } });
    }
    return json({ error: "not_found" }, 404);
  }));
});

describe("回复结果数据闭环", () => {
  it("does not present untrusted page sentiment as a reply classification", async () => {
    const unknown = { ...complaintFailureReply("internal"), id: "unknown-page-label", complaintErrorKind: null, sentimentLabel: "unknown" };
    const positive = { ...complaintFailureReply("internal"), id: "positive-page-label", complaintErrorKind: null, sentimentLabel: "positive" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "test-csrf" });
      if (url.endsWith("/api/replies")) return json({ items: [unknown, positive], total: 2 });
      return json({ error: "not_found" }, 404);
    }));

    renderPage();

    expect(await screen.findByText("共 2 条")).toBeVisible();
    expect(screen.queryByText(/页面未提供可靠评价标签/)).not.toBeInTheDocument();
    expect(screen.queryByText(/页面标签：正面/)).not.toBeInTheDocument();
    expect(screen.queryByText("页面情感待识别")).not.toBeInTheDocument();
  });

  it.each([
    ["timeout", "投诉预审超时"],
    ["network", "投诉预审连接失败"],
    ["model_contract", "投诉预审结果格式异常"],
    ["configuration", "投诉服务配置异常"],
    ["internal", "投诉预审内部失败"],
  ])("shows complaint failure kind %s instead of the generic retry status", async (kind, label) => {
    const item = complaintFailureReply(kind);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "test-csrf" });
      if (url.endsWith("/api/replies")) return json({ items: [item], total: 1 });
      return json({ error: "not_found" }, 404);
    }));
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText(label)).toBeVisible();
    expect(screen.queryByText("等待重试")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看评论详情：测试评价" }));
    expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("本条未回复、未投诉；普通评价会在下一轮自动释放，疑似违规评价会继续严格核验。")).toBeVisible();
  });

  it("shows the current retry state instead of a stale historical complaint failure", async () => {
    const item = {
      ...complaintFailureReply("network"),
      state: "retry_wait",
      failedStage: "classification",
      aiRetryErrorKind: "model_contract",
      errorMessage: "评价分类返回格式不完整，下一轮重新处理",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "test-csrf" });
      if (url.endsWith("/api/replies")) return json({ items: [item], total: 1 });
      return json({ error: "not_found" }, 404);
    }));

    renderPage();

    expect(await screen.findByText("等待重试")).toBeVisible();
    expect(screen.queryByText("投诉预审连接失败")).not.toBeInTheDocument();
  });

  it("shows the exact persisted business reason for a skipped review", async () => {
    const item = {
      ...complaintFailureReply("internal"),
      complaintErrorKind: null,
      state: "not_actionable",
      errorMessage: "当前评价没有可用投诉入口，平台已处理，无需重复投诉",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "test-csrf" });
      if (url.endsWith("/api/replies")) return json({ items: [item], total: 1 });
      return json({ error: "not_found" }, 404);
    }));

    renderPage();

    expect(await screen.findByText("平台已处理，无需投诉")).toBeVisible();
    expect(screen.queryByText("已按规则跳过")).not.toBeInTheDocument();
  });

  it("lets the user safely clear completed reply history from the results page", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "清理已完成记录" }));

    expect(await screen.findByText("已清理 3 条已完成记录。")).toBeVisible();
  });

  it("loads every reply through server pagination and sends status and search filters to the API", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "test-csrf" });
      if (url.split("?")[0]?.endsWith("/api/replies")) {
        requests.push(url);
        const params = new URL(url, "http://local").searchParams;
        const page = Number(params.get("page") ?? 1);
        const filter = params.get("filter") ?? "all";
        return json({
          items: [],
          total: filter === "sent" ? 48 : 75,
          overallTotal: 75,
          page,
          pageSize: 50,
          totalPages: page === 2 ? 2 : 2,
        });
      }
      return json({ error: "not_found" }, 404);
    }));
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("共 75 条")).toBeVisible();
    expect(screen.getByText("第 1 / 2 页")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(requests.some((url) => url.includes("page=2"))).toBe(true));

    await user.click(screen.getByRole("button", { name: "发送成功" }));
    await waitFor(() => expect(requests.some((url) => url.includes("filter=sent"))).toBe(true));
    expect(await screen.findByText("筛选结果 48 条")).toBeVisible();

    await user.type(screen.getByRole("textbox", { name: "搜索回复结果" }), "耳机");
    await waitFor(() => expect(requests.some((url) => url.includes(`query=${encodeURIComponent("耳机")}`))).toBe(true));
  });

  it("keeps completed cleanup and separately clears every unsuccessful record", async () => {
    const cleanupRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "test-csrf" });
      if (url.split("?")[0]?.endsWith("/api/replies") && method === "GET") {
        return json({ items: [], total: 6, overallTotal: 10, page: 1, pageSize: 50, totalPages: 1 });
      }
      if (url.includes("/api/storage/reviews") && method === "DELETE") {
        cleanupRequests.push(url);
        return json({ deleted: url.includes("scope=unsent") ? 4 : 2 });
      }
      return json({ error: "not_found" }, 404);
    }));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "清理已完成记录" }));
    expect(await screen.findByText("已清理 2 条已完成记录。")).toBeVisible();
    expect(cleanupRequests).toContain("/api/storage/reviews?scope=sent");

    await user.click(screen.getByRole("button", { name: "清理未成功记录" }));
    expect(await screen.findByText("已清理 4 条未成功记录，现在只保留发送成功记录。")).toBeVisible();
    expect(cleanupRequests).toContain("/api/storage/reviews?scope=unsent");
  });

  it("deletes a never-submitted mistake and tells the user it will be processed again", async () => {
    const failedReply = {
      id: "failed-1",
      sourceKey: "tmall:failed-1",
      orderId: "order-1",
      review: "客服能不能专业点",
      product: "测试商品",
      reviewedAt: "2026-07-19 09:50",
      sentimentLabel: "negative",
      library: "bad",
      primaryCategory: "服务类",
      category: "客服服务",
      classificationConfidence: 0.95,
      classificationReason: "评价明确指出客服不专业",
      templateSequence: 1,
      originalTemplate: "非常抱歉没有达到您的预期。",
      finalReply: "非常抱歉给您带来不好的体验。",
      productAdjusted: false,
      rewriteNotes: "",
      attentionReasons: [],
      state: "failed",
      errorMessage: "平台未提交",
      discoveredAt: "2026-07-19T01:50:00.000Z",
      processedAt: "2026-07-19T01:51:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "test-csrf" });
      if (url.endsWith("/api/replies") && method === "GET") return json({ items: [failedReply], total: 1 });
      if (url.endsWith("/api/replies/failed-1") && method === "DELETE") return json({ removed: true, mode: "reprocess", reprocessable: true });
      return json({ error: "not_found" }, 404);
    }));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "删除记录：客服能不能专业点" }));

    expect(await screen.findByText("记录已删除，下次运行会重新处理该评价。")).toBeVisible();
  });

  it("cleans one completed reply while retaining only its anti-duplicate marker", async () => {
    const sentReply = {
      id: "sent-1", sourceKey: "tmall:sent-1", orderId: null, review: "非常好用", product: "测试商品",
      reviewedAt: null, sentimentLabel: "positive", library: "good", primaryCategory: "好评", category: "整体好评",
      classificationConfidence: 0.99, classificationReason: "明确好评", templateSequence: 1, originalTemplate: "感谢支持",
      finalReply: "感谢您的支持。", productAdjusted: false, rewriteNotes: "", attentionReasons: [], state: "sent",
      errorMessage: null, discoveredAt: "2026-07-20T01:00:00.000Z", processedAt: "2026-07-20T01:01:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "test-csrf" });
      if (url.endsWith("/api/replies") && method === "GET") return json({ items: [sentReply], total: 1 });
      if (url.endsWith("/api/replies/sent-1") && method === "DELETE") return json({ removed: true, mode: "completed", reprocessable: false });
      return json({ error: "not_found" }, 404);
    }));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "查看评论详情：非常好用" }));
    await user.click(screen.getByRole("button", { name: "清理此条记录" }));

    expect(await screen.findByText("记录已清理，仅保留防重复标记，不会再次回复或投诉。")).toBeVisible();
  });
});
