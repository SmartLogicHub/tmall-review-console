import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiSessionForTests } from "../api/client";
import { ReviewScopeDialog, type ReviewScopeView, validateCustomDateRange } from "./review-scope-dialog";

const initialScope: ReviewScopeView = {
  preset: "last7",
  startDate: null,
  endDate: null,
  effectiveStartDate: "2026-07-10",
  effectiveEndDate: "2026-07-16",
  timezone: "Asia/Shanghai",
  revision: 7,
  summary: "近7天（2026-07-10 至 2026-07-16）",
  processingMode: "content_unanswered",
};

function shanghaiDateLabel(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function setupDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  queryClient.setQueryData(["review-scope"], initialScope);
  queryClient.setQueryData(["automation-status"], { state: "disabled" });
  queryClient.setQueryData(["dashboard"], { metrics: {} });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <ReviewScopeDialog open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { queryClient, onOpenChange };
}

beforeEach(() => {
  resetApiSessionForTests();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/bootstrap")) return new Response(JSON.stringify({ csrfToken: "scope-csrf" }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/api/review-scope") && init?.method === "PUT") {
      const payload = JSON.parse(String(init.body)) as { preset: ReviewScopeView["preset"]; processingMode: ReviewScopeView["processingMode"]; startDate?: string; endDate?: string };
      return new Response(JSON.stringify({
        ...initialScope,
        ...payload,
        effectiveStartDate: payload.startDate ?? "2026-07-16",
        effectiveEndDate: payload.endDate ?? "2026-07-16",
        revision: 8,
        summary: payload.preset === "today" ? "今天（2026-07-16 至 2026-07-16）" : "自定义日期",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/review-scope")) return new Response(JSON.stringify(initialScope), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }));
});

describe("ReviewScopeDialog", () => {
  it("opens through a real trigger and restores focus to it after Escape", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    queryClient.setQueryData(["review-scope"], initialScope);
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><ReviewScopeDialog open={open} onOpenChange={setOpen} trigger={<button type="button">打开处理日期</button>} /><button type="button">页面外部</button></>;
    }
    const user = userEvent.setup();
    render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    const trigger = screen.getByRole("button", { name: "打开处理日期" });
    const outside = screen.getByRole("button", { name: "页面外部" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "选择处理日期" })).toBeVisible();
    const today = screen.getByRole("button", { name: "今天" });
    await waitFor(() => expect(today).toHaveFocus());
    await user.tab({ shift: true });
    expect(screen.getByRole("dialog", { name: "选择处理日期" })).toContainElement(document.activeElement as HTMLElement);
    expect(outside).not.toHaveFocus();
    await user.click(today);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "选择处理日期" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    expect(screen.getByRole("button", { name: "近7天" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "今天" })).not.toHaveClass("active");
  });

  it("offers five presets and saves a shortcut with optimistic-concurrency revision", async () => {
    const user = userEvent.setup();
    const { queryClient, onOpenChange } = setupDialog();

    expect(screen.getByRole("dialog", { name: "选择处理日期" })).toBeVisible();
    for (const label of ["今天", "昨天", "近7天", "近30天", "自定义日期"]) {
      expect(screen.getByRole("button", { name: label })).toBeVisible();
    }
    for (const label of ["只处理追评", "有内容未回复"]) {
      expect(screen.getByRole("radio", { name: label })).toBeVisible();
    }
    expect(screen.queryByRole("radio", { name: "全部" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "只处理追评" }));
    await user.click(screen.getByRole("button", { name: "今天" }));
    await user.click(screen.getByRole("button", { name: "保存处理范围" }));

    await waitFor(() => {
      const put = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).endsWith("/api/review-scope") && init?.method === "PUT");
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({ preset: "today", processingMode: "followup_only", expectedRevision: 7 });
    });
    expect(queryClient.getQueryData<ReviewScopeView>(["review-scope"])?.revision).toBe(8);
    expect(queryClient.getQueryState(["automation-status"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["dashboard"])?.isInvalidated).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps custom save disabled until a same-day or cross-month range is complete", async () => {
    const user = userEvent.setup();
    setupDialog();

    await user.click(screen.getByRole("button", { name: "自定义日期" }));
    const save = screen.getByRole("button", { name: "保存处理范围" });
    expect(save).toBeDisabled();
    expect(screen.getByText("请选择开始日期")).toBeVisible();

    await user.click(screen.getAllByRole("button", { name: "2026-07-31" })[0]!);
    expect(screen.getByText("请选择结束日期")).toBeVisible();
    expect(save).toBeDisabled();
    await user.click(screen.getAllByRole("button", { name: "2026-08-01" })[0]!);
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => {
      const put = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).endsWith("/api/review-scope") && init?.method === "PUT");
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({ preset: "custom", startDate: "2026-07-31", endDate: "2026-08-01", processingMode: "content_unanswered", expectedRevision: 7 });
    });
  });

  it("supports a same-day custom range and rejects more than 90 inclusive days", async () => {
    expect(validateCustomDateRange(new Date(2026, 0, 1), new Date(2026, 2, 31))).toBeNull();
    expect(validateCustomDateRange(new Date(2026, 0, 1), new Date(2026, 3, 1))).toBe("处理日期最多可选择90天");

    const user = userEvent.setup();
    setupDialog();
    await user.click(screen.getByRole("button", { name: "自定义日期" }));
    const today = shanghaiDateLabel();
    await user.click(screen.getByRole("button", { name: today }));
    await user.click(screen.getByRole("button", { name: today }));
    expect(screen.getByRole("button", { name: "保存处理范围" })).toBeEnabled();
  });

  it("locks saving after a revision conflict until the latest scope is explicitly loaded", async () => {
    const latestScope: ReviewScopeView = { ...initialScope, preset: "last30", revision: 8, summary: "近30天（2026-06-17 至 2026-07-16）" };
    const putBodies: unknown[] = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return new Response(JSON.stringify({ csrfToken: "scope-csrf" }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/review-scope") && init?.method === "PUT") {
        putBodies.push(JSON.parse(String(init.body)));
        if (putBodies.length === 1) return new Response(JSON.stringify({ error: "review_scope_changed", currentRevision: 8 }), { status: 409, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ ...latestScope, preset: "yesterday", revision: 9 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(latestScope), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const user = userEvent.setup();
    setupDialog();
    await user.click(screen.getByRole("button", { name: "今天" }));
    const save = screen.getByRole("button", { name: "保存处理范围" });
    await user.click(save);
    expect(await screen.findByText("处理范围已在其他页面更新，请刷新后重新选择")).toBeVisible();
    expect(save).toBeDisabled();
    await user.click(save);
    expect(putBodies).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "刷新最新日期" }));
    expect(screen.getByRole("button", { name: "近30天" })).toHaveClass("active");
    await user.click(screen.getByRole("button", { name: "昨天" }));
    await user.click(save);
    await waitFor(() => expect(putBodies).toHaveLength(2));
    expect(putBodies[1]).toEqual({ preset: "yesterday", processingMode: "content_unanswered", expectedRevision: 8 });
  });

  it("keeps a revision conflict locked when refreshing the latest scope fails", async () => {
    const latestScope: ReviewScopeView = { ...initialScope, preset: "last30", revision: 8, summary: "近30天（2026-06-17 至 2026-07-16）" };
    let putCount = 0;
    let readCount = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return new Response(JSON.stringify({ csrfToken: "scope-csrf" }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/review-scope") && init?.method === "PUT") {
        putCount += 1;
        return new Response(JSON.stringify({ error: "review_scope_changed", currentRevision: 8 }), { status: 409, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/api/review-scope")) {
        readCount += 1;
        if (readCount === 1) return new Response(JSON.stringify(latestScope), { status: 200, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ error: "temporary_failure" }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    });
    const user = userEvent.setup();
    setupDialog();
    await user.click(screen.getByRole("button", { name: "今天" }));
    const save = screen.getByRole("button", { name: "保存处理范围" });
    await user.click(save);
    expect(await screen.findByText("处理范围已在其他页面更新，请刷新后重新选择")).toBeVisible();
    await waitFor(() => expect(readCount).toBe(1));
    await user.click(screen.getByRole("button", { name: "刷新最新日期" }));
    expect(await screen.findByText("处理日期刷新失败，请重试")).toBeVisible();
    expect(save).toBeDisabled();
    await user.click(save);
    expect(putCount).toBe(1);
  });

  it("navigates across months and collapses to one month on a narrow viewport", async () => {
    const user = userEvent.setup();
    const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    setupDialog();
    expect(screen.getAllByRole("grid")).toHaveLength(2);
    expect([...document.querySelectorAll(".rdp-month_caption")].map((element) => element.textContent)).toEqual(["2026年7月", "2026年8月"]);
    await user.click(screen.getByRole("button", { name: "下个月" }));
    expect([...document.querySelectorAll(".rdp-month_caption")].map((element) => element.textContent)).toEqual(["2026年8月", "2026年9月"]);
  });

  it("renders one real calendar month when the viewport media query is narrow", async () => {
    const media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const matchMedia = vi.fn(() => media);
    vi.stubGlobal("matchMedia", matchMedia);
    setupDialog();
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 820px)");
    await waitFor(() => expect(screen.getAllByRole("grid")).toHaveLength(1));
  });

  it("shows a readable loading state and can retry an initial read failure", async () => {
    let finishFirstRead: ((response: Response) => void) | undefined;
    let readCount = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return new Response(JSON.stringify({ csrfToken: "scope-csrf" }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/review-scope")) {
        readCount += 1;
        if (readCount === 1) return new Promise<Response>((resolve) => { finishFirstRead = resolve; });
        return new Response(JSON.stringify(initialScope), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const user = userEvent.setup();
    render(<QueryClientProvider client={queryClient}><ReviewScopeDialog open onOpenChange={vi.fn()} /></QueryClientProvider>);

    const dialog = screen.getByRole("dialog", { name: "选择处理日期" });
    expect(await screen.findByText("正在读取处理日期")).toBeVisible();
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    finishFirstRead?.(new Response(JSON.stringify({ error: "temporary_failure" }), { status: 500, headers: { "Content-Type": "application/json" } }));
    expect(await screen.findByText("处理日期读取失败，请检查本地服务后重试")).toBeVisible();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(screen.queryByRole("button", { name: "自定义日期" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存处理范围" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "重新读取处理日期" }));
    await waitFor(() => expect(screen.queryByText("处理日期读取失败，请检查本地服务后重试")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "近7天" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "保存处理范围" })).toBeEnabled();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("uses a fixed Chinese fallback for an unexpected save failure", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return new Response(JSON.stringify({ csrfToken: "scope-csrf" }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/review-scope") && init?.method === "PUT") throw new Error("TypeError private-service");
      if (url.endsWith("/api/review-scope")) return new Response(JSON.stringify(initialScope), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    });
    const user = userEvent.setup();
    setupDialog();

    await user.click(screen.getByRole("button", { name: "保存处理范围" }));
    expect(await screen.findByText("处理范围保存失败，请稍后重试")).toBeVisible();
    expect(screen.queryByText(/TypeError|private-service/u)).not.toBeInTheDocument();
  });
});
