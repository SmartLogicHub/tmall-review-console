import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiSessionForTests } from "../api/client";
import { ComplaintsPage } from "./complaints";

const complaint = {
  id: "case-1",
  state: "submission_uncertain",
  complaintType: "insulting_content",
  quote: "客服是骗子，都是垃圾",
  review: "买家完整评价：客服是骗子，都是垃圾。",
  product: "测试耳机商品",
  reviewedAt: "2026-07-17 08:00",
  reason: "评价含有针对客服人员的人格侮辱，符合官方投诉场景。",
  factDescription: "评价中存在针对具体人员的侮辱性称呼。",
  description: "该评价内容为“客服是骗子，都是垃圾”。经核对，该内容包含针对具体人员的人格侮辱或攻击，符合“辱骂侮辱的评论”场景。请平台结合评价内容及相关信息审核，并屏蔽处理，谢谢。",
  phase: "followup",
  createdAt: "2026-07-17T08:00:00.000Z",
  updatedAt: "2026-07-17T08:03:00.000Z",
  factCode: "review_attacks_person",
  modelResult: { internal: "must not render" },
  errorCode: "submission_uncertain",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ComplaintsPage /></QueryClientProvider>);
}

beforeEach(() => {
  resetApiSessionForTests();
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "test-csrf" });
    if (url.endsWith("/api/complaints")) return json({ items: [complaint], total: 1 });
    if (url.endsWith("/api/complaints/status-summary")) return json({ total: 1, unresolved: 1, submitted: 0, manualActionRequired: 0 });
    if (url.endsWith("/api/complaints/case-1")) return json(complaint);
    return json({ error: "not_found" }, 404);
  }));
});

describe("投诉记录", () => {
  it("只显示商家可理解的信息，不泄露内部模型字段", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "投诉记录" })).toBeVisible();
    expect(await screen.findByText("追评投诉")).toBeVisible();
    expect(screen.getByText("辱骂侮辱的评论")).toBeVisible();
    expect(screen.getByText("等待平台同步")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /查看投诉记录/u }));
    expect(screen.getByText(/该评价内容为/u)).toBeVisible();
    expect(screen.getByText("已锁定等待平台同步")).toBeVisible();
    expect(screen.queryByText(/review_attacks_person|submission_uncertain|must not render|modelResult|factCode/u)).not.toBeInTheDocument();
  });

  it("选择记录后显示完整只读详情", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /查看投诉记录/u }));

    expect(await screen.findByRole("heading", { name: "投诉详情" })).toBeVisible();
    expect(screen.getAllByText("买家完整评价：客服是骗子，都是垃圾。")).toHaveLength(2);
    expect(screen.getByText("测试耳机商品")).toBeVisible();
    expect(screen.getByText("评价含有针对客服人员的人格侮辱，符合官方投诉场景。")).toBeVisible();
    expect(screen.getByText("评价中存在针对具体人员的侮辱性称呼。")).toBeVisible();
    expect(screen.getByText("投诉描述")).toBeVisible();
    expect(screen.getByText("平台处理结果")).toBeVisible();
    expect(screen.getByText("平台尚未返回明确结果。系统已锁定该条避免重复投诉，并会在后续扫描中自动同步平台状态。")).toBeVisible();
    expect(screen.queryByRole("button", { name: /提交|再次投诉/u })).not.toBeInTheDocument();
  });

  it("提供友好的空状态与脱敏错误状态", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "test-csrf" });
      if (url.endsWith("/api/complaints")) return json({ items: [], total: 0 });
      if (url.endsWith("/api/complaints/status-summary")) return json({ total: 0, unresolved: 0, submitted: 0, manualActionRequired: 0 });
      return json({ error: "not_found" }, 404);
    }));
    const empty = renderPage();
    expect(await screen.findByText("暂时没有投诉记录")).toBeVisible();
    empty.unmount();

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "test-csrf" });
      if (url.endsWith("/api/complaints")) throw new Error("ECONNRESET internal server stack");
      if (url.endsWith("/api/complaints/status-summary")) return json({ total: 0, unresolved: 0, submitted: 0, manualActionRequired: 0 });
      return json({ error: "not_found" }, 404);
    }));
    renderPage();
    expect(await screen.findByText("投诉记录暂时无法读取")).toBeVisible();
    expect(screen.queryByText(/ECONNRESET|internal server stack/u)).not.toBeInTheDocument();
  });

  it("允许逐条清理未提交投诉并让下次运行重新处理", async () => {
    const failedComplaint = { ...complaint, id: "case-failed", state: "failed" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "test-csrf" });
      if (url.endsWith("/api/complaints") && method === "GET") return json({ items: [failedComplaint], total: 1 });
      if (url.endsWith("/api/complaints/status-summary")) return json({ total: 1, unresolved: 1 });
      if (url.endsWith("/api/complaints/case-failed") && method === "DELETE") return json({ removed: true, mode: "reprocess", reprocessable: true });
      return json({ error: "not_found" }, 404);
    }));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /删除投诉记录：/u }));

    expect(await screen.findByText("投诉记录已删除，下次运行会重新判断并处理该评价。")).toBeVisible();
  });
});
