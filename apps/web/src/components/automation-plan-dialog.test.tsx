import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiSessionForTests } from "../api/client";
import { AutomationPlanDialog, type AutomationPlanView, validateAutomationDraft } from "./automation-plan-dialog";

const initialPlan: AutomationPlanView = {
  enabled: true,
  paused: false,
  timezone: "Asia/Shanghai",
  intervalMinutes: 15,
  windows: [{ id: "morning", start: "08:00", end: "09:00" }],
  revision: 4,
};

function setupDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  queryClient.setQueryData(["automation-plan"], initialPlan);
  queryClient.setQueryData(["automation-status"], { state: "waiting", plan: initialPlan, currentWindow: null, nextRunAt: null });
  queryClient.setQueryData(["dashboard"], { metrics: {} });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <AutomationPlanDialog open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { queryClient, onOpenChange };
}

beforeEach(() => {
  resetApiSessionForTests();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/bootstrap")) return new Response(JSON.stringify({ csrfToken: "plan-csrf" }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/api/automation-plan") && init?.method === "PUT") {
      const payload = JSON.parse(String(init.body)) as AutomationPlanView;
      return new Response(JSON.stringify({ ...initialPlan, ...payload, revision: 5 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/automation-plan")) return new Response(JSON.stringify(initialPlan), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }));
});

describe("AutomationPlanDialog", () => {
  it("opens through a real trigger and restores focus to it after Escape", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    queryClient.setQueryData(["automation-plan"], initialPlan);
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><AutomationPlanDialog open={open} onOpenChange={setOpen} trigger={<button type="button">打开自动计划</button>} /><button type="button">页面外部</button></>;
    }
    const user = userEvent.setup();
    render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    const trigger = screen.getByRole("button", { name: "打开自动计划" });
    const outside = screen.getByRole("button", { name: "页面外部" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "设置自动运行时间" })).toBeVisible();
    const planSwitch = screen.getByRole("switch", { name: "启用自动回复计划" });
    await waitFor(() => expect(planSwitch).toHaveFocus());
    await user.tab({ shift: true });
    expect(screen.getByRole("dialog", { name: "设置自动运行时间" })).toContainElement(document.activeElement as HTMLElement);
    expect(outside).not.toHaveFocus();
    const interval = screen.getByLabelText("运行间隔（分钟）");
    await user.clear(interval);
    await user.type(interval, "22");
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "设置自动运行时间" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    expect(screen.getByLabelText("运行间隔（分钟）")).toHaveValue(15);
  });

  it("validates time order, overlaps, interval and the one-to-six window limit", async () => {
    expect(validateAutomationDraft(true, 0, initialPlan.windows)).toBe("运行间隔必须在1到120分钟之间");
    expect(validateAutomationDraft(true, 15, [{ id: "x", start: "09:00", end: "08:00" }])).toBe("结束时间必须晚于开始时间");
    expect(validateAutomationDraft(true, 15, [
      { id: "a", start: "08:00", end: "10:00" },
      { id: "b", start: "09:00", end: "11:00" },
    ])).toBe("时间段不能重叠");
    expect(validateAutomationDraft(true, 15, [
      { id: "a", start: "08:00", end: "09:00" },
      { id: "b", start: "09:00", end: "10:00" },
    ])).toBeNull();

    const user = userEvent.setup();
    setupDialog();
    const add = screen.getByRole("button", { name: "添加时间段" });
    for (let count = 0; count < 5; count += 1) await user.click(add);
    expect(screen.getAllByLabelText(/时间段\d+开始时间/u)).toHaveLength(6);
    expect(add).toBeDisabled();

    const interval = screen.getByLabelText("运行间隔（分钟）");
    await user.clear(interval);
    await user.type(interval, "121");
    expect(screen.getByText("运行间隔必须在1到120分钟之间")).toBeVisible();
    expect(screen.getByRole("button", { name: "保存自动计划" })).toBeDisabled();
  });

  it("cancels without saving and persists a valid plan with its revision", async () => {
    const user = userEvent.setup();
    const { queryClient, onOpenChange } = setupDialog();
    const interval = screen.getByLabelText("运行间隔（分钟）");
    await user.clear(interval);
    await user.type(interval, "20");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith("/api/automation-plan") && init?.method === "PUT")).toBe(false);

    await user.click(screen.getByRole("button", { name: "保存自动计划" }));
    await waitFor(() => {
      const put = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).endsWith("/api/automation-plan") && init?.method === "PUT");
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({
        enabled: true,
        intervalMinutes: 20,
        windows: [{ id: "morning", start: "08:00", end: "09:00" }],
        expectedRevision: 4,
      });
    });
    expect(queryClient.getQueryData<AutomationPlanView>(["automation-plan"])?.revision).toBe(5);
    expect((queryClient.getQueryData(["automation-status"]) as { plan: AutomationPlanView }).plan.revision).toBe(5);
    expect(queryClient.getQueryState(["dashboard"])?.isInvalidated).toBe(true);
  });

  it("turns a revision conflict into a refresh instruction", async () => {
    const latestPlan: AutomationPlanView = { ...initialPlan, intervalMinutes: 30, revision: 8 };
    const putBodies: unknown[] = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return new Response(JSON.stringify({ csrfToken: "plan-csrf" }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/automation-plan") && init?.method === "PUT") {
        putBodies.push(JSON.parse(String(init.body)));
        if (putBodies.length === 1) return new Response(JSON.stringify({ error: "automation_plan_changed", detail: "自动计划已在其他页面修改，请刷新后重试", currentRevision: 8 }), { status: 409, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ ...latestPlan, intervalMinutes: 23, revision: 9 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(latestPlan), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const user = userEvent.setup();
    setupDialog();
    const interval = screen.getByLabelText("运行间隔（分钟）");
    await user.clear(interval);
    await user.type(interval, "22");
    await user.click(screen.getByRole("button", { name: "保存自动计划" }));
    expect(await screen.findByText("自动计划已在其他页面更新，请刷新后重新设置")).toBeVisible();
    expect(screen.getByRole("button", { name: "刷新最新计划" })).toBeVisible();
    expect(interval).toHaveValue(22);
    expect(screen.getByRole("button", { name: "保存自动计划" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "保存自动计划" }));
    expect(putBodies).toHaveLength(1);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith("/api/automation-plan") && init?.method === "GET")).toBe(true));
    await user.click(screen.getByRole("button", { name: "刷新最新计划" }));
    expect(interval).toHaveValue(30);
    await user.clear(interval);
    await user.type(interval, "23");
    await user.click(screen.getByRole("button", { name: "保存自动计划" }));
    await waitFor(() => expect(putBodies).toHaveLength(2));
    expect(putBodies[1]).toEqual({ enabled: true, intervalMinutes: 23, windows: initialPlan.windows, expectedRevision: 8 });
  });

  it("keeps a revision conflict locked when refreshing the latest plan fails", async () => {
    const latestPlan: AutomationPlanView = { ...initialPlan, intervalMinutes: 30, revision: 8 };
    let putCount = 0;
    let readCount = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return new Response(JSON.stringify({ csrfToken: "plan-csrf" }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/automation-plan") && init?.method === "PUT") {
        putCount += 1;
        return new Response(JSON.stringify({ error: "automation_plan_changed", currentRevision: 8 }), { status: 409, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/api/automation-plan")) {
        readCount += 1;
        if (readCount === 1) return new Response(JSON.stringify(latestPlan), { status: 200, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ error: "temporary_failure" }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    });
    const user = userEvent.setup();
    setupDialog();
    const interval = screen.getByLabelText("运行间隔（分钟）");
    await user.clear(interval);
    await user.type(interval, "22");
    const save = screen.getByRole("button", { name: "保存自动计划" });
    await user.click(save);
    expect(await screen.findByText("自动计划已在其他页面更新，请刷新后重新设置")).toBeVisible();
    await waitFor(() => expect(readCount).toBe(1));
    await user.click(screen.getByRole("button", { name: "刷新最新计划" }));
    expect(await screen.findByText("自动计划刷新失败，请重试")).toBeVisible();
    expect(save).toBeDisabled();
    await user.click(save);
    expect(putCount).toBe(1);
  });

  it("keeps windows when disabling and only clears them through the explicit clear action", async () => {
    const user = userEvent.setup();
    setupDialog();

    await user.click(screen.getByRole("switch", { name: "启用自动回复计划" }));
    await user.click(screen.getByRole("button", { name: "保存自动计划" }));
    await waitFor(() => {
      const put = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).endsWith("/api/automation-plan") && init?.method === "PUT");
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({
        enabled: false,
        intervalMinutes: 15,
        windows: [{ id: "morning", start: "08:00", end: "09:00" }],
        expectedRevision: 4,
      });
    });

    vi.mocked(fetch).mockClear();
    await user.click(screen.getByRole("button", { name: "清空全部并关闭" }));
    expect(screen.queryByLabelText("时间段1开始时间")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存自动计划" }));
    await waitFor(() => {
      const put = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).endsWith("/api/automation-plan") && init?.method === "PUT");
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({ enabled: false, intervalMinutes: 15, windows: [], expectedRevision: 5 });
    });
  });

  it("shows a readable loading state and can retry an initial read failure", async () => {
    let finishFirstRead: ((response: Response) => void) | undefined;
    let readCount = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return new Response(JSON.stringify({ csrfToken: "plan-csrf" }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/automation-plan")) {
        readCount += 1;
        if (readCount === 1) return new Promise<Response>((resolve) => { finishFirstRead = resolve; });
        return new Response(JSON.stringify(initialPlan), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const user = userEvent.setup();
    render(<QueryClientProvider client={queryClient}><AutomationPlanDialog open onOpenChange={vi.fn()} /></QueryClientProvider>);

    const dialog = screen.getByRole("dialog", { name: "设置自动运行时间" });
    expect(await screen.findByText("正在读取自动计划")).toBeVisible();
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    finishFirstRead?.(new Response(JSON.stringify({ error: "temporary_failure" }), { status: 500, headers: { "Content-Type": "application/json" } }));
    expect(await screen.findByText("自动计划读取失败，请检查本地服务后重试")).toBeVisible();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(screen.queryByRole("switch", { name: "启用自动回复计划" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("运行间隔（分钟）")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存自动计划" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "重新读取自动计划" }));
    await waitFor(() => expect(screen.queryByText("自动计划读取失败，请检查本地服务后重试")).not.toBeInTheDocument());
    expect(screen.getByLabelText("运行间隔（分钟）")).toHaveValue(15);
    expect(screen.getByRole("switch", { name: "启用自动回复计划" })).toBeChecked();
    expect(screen.getByRole("button", { name: "保存自动计划" })).toBeEnabled();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("uses a fixed Chinese fallback for an unexpected save failure", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return new Response(JSON.stringify({ csrfToken: "plan-csrf" }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/automation-plan") && init?.method === "PUT") throw new Error("ECONNRESET internal-host");
      if (url.endsWith("/api/automation-plan")) return new Response(JSON.stringify(initialPlan), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    });
    const user = userEvent.setup();
    setupDialog();

    await user.click(screen.getByRole("button", { name: "保存自动计划" }));
    expect(await screen.findByText("自动计划保存失败，请稍后重试")).toBeVisible();
    expect(screen.queryByText(/ECONNRESET|internal-host/u)).not.toBeInTheDocument();
  });
});
