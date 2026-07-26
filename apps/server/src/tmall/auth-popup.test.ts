import { describe, expect, it, vi } from "vitest";
import {
  dismissTmallSafePopup,
  isTmallPageClosedError,
  resolveTmallBlockingStateAfterSafeDismissal,
  selectTmallAuthenticationPage,
  type TmallSafePopupAdapter,
  withTmallReadOnlyNetworkGuard,
} from "./auth-driver";

function popup(input: {
  visible?: boolean;
  text: string;
  actionCount?: number;
  hiddenAfterClick?: boolean;
  identityAfterClick?: string;
}): { adapter: TmallSafePopupAdapter; click: ReturnType<typeof vi.fn> } {
  const click = vi.fn(async () => undefined);
  const actions = Array.from({ length: input.actionCount ?? 1 }, () => ({ click }));
  let identityReads = 0;
  return {
    click,
    adapter: {
      isVisible: async () => input.visible ?? true,
      text: async () => input.text,
      actions: async () => actions,
      waitUntilHidden: async () => input.hiddenAfterClick ?? true,
      pageIdentity: async () => identityReads++ === 0 ? "https://myseller.taobao.com/home.htm" : input.identityAfterClick ?? "https://myseller.taobao.com/home.htm",
    },
  };
}

describe("known safe Tmall popup dismissal", () => {
  it("recognizes a closed page reported beneath a safe click error", () => {
    const closedPage = new Error("locator.click: Target page, context or browser has been closed");
    const safeClickError = new Error("页面点击操作失败", { cause: closedPage });

    expect(isTmallPageClosedError(safeClickError)).toBe(true);
  });

  it("dismisses a recognized notification before classifying the remaining page", async () => {
    const order: string[] = [];
    let notificationVisible = true;

    const result = await resolveTmallBlockingStateAfterSafeDismissal({
      dismiss: async () => {
        order.push("dismiss");
        notificationVisible = false;
        return "closed";
      },
      readState: async () => {
        order.push("classify");
        return notificationVisible ? "manual_action_required" : null;
      },
    });

    expect(order).toEqual(["dismiss", "classify"]);
    expect(result).toEqual({ dismissal: "closed", state: null });
  });

  it.each([
    "功能升级 评价智能分析上线",
    "重要消息 预警通知 发货异常提醒 预计赔付金额494.21元 请尽快处理",
    "重要消息 预警通知 退款投诉处罚提醒（子账号只关闭通知）",
    "新手引导",
  ])("closes the known optional popup and verifies it disappeared: %s", async (text) => {
    const candidate = popup({ text });

    await expect(dismissTmallSafePopup(candidate.adapter)).resolves.toBe("closed");
    expect(candidate.click).toHaveBeenCalledTimes(1);
  });

  it("treats an absent optional popup as a normal page", async () => {
    const candidate = popup({ text: "功能升级", visible: false });

    await expect(dismissTmallSafePopup(candidate.adapter)).resolves.toBe("absent");
    expect(candidate.click).not.toHaveBeenCalled();
  });

  it.each([
    "安全验证：请输入短信验证码",
    "退款投诉处罚业务确认",
    "重要消息 退款投诉处罚处理提醒",
    "一个从未登记过的营销弹窗",
  ])("does not close dangerous or unknown popup content: %s", async (text) => {
    const candidate = popup({ text });

    await expect(dismissTmallSafePopup(candidate.adapter)).resolves.toBe("manual_action_required");
    expect(candidate.click).not.toHaveBeenCalled();
  });

  it("requires manual action when the close target is ambiguous", async () => {
    const candidate = popup({ text: "重要消息 预警通知 退款投诉处罚提醒", actionCount: 2 });

    await expect(dismissTmallSafePopup(candidate.adapter)).resolves.toBe("manual_action_required");
    expect(candidate.click).not.toHaveBeenCalled();
  });

  it("requires manual action when the popup remains after clicking", async () => {
    const candidate = popup({ text: "功能升级 评价智能分析上线", hiddenAfterClick: false });

    await expect(dismissTmallSafePopup(candidate.adapter)).resolves.toBe("manual_action_required");
    expect(candidate.click).toHaveBeenCalledTimes(1);
  });

  it("requires manual action when dismissing the popup changes the page identity", async () => {
    const candidate = popup({ text: "功能升级 评价智能分析上线", identityAfterClick: "https://example.invalid/changed" });

    await expect(dismissTmallSafePopup(candidate.adapter)).resolves.toBe("manual_action_required");
    expect(candidate.click).toHaveBeenCalledTimes(1);
  });

  it("blocks every write request while a safe popup is being dismissed", async () => {
    let routeHandler: ((route: never) => Promise<void>) | null = null;
    const unroute = vi.fn(async () => undefined);
    const page = {
      route: vi.fn(async (_pattern: string, handler: (route: never) => Promise<void>) => { routeHandler = handler; }),
      unroute,
    };
    const get = { request: () => ({ method: () => "GET" }), continue: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    const post = { request: () => ({ method: () => "POST" }), continue: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };

    await withTmallReadOnlyNetworkGuard(page as never, async () => {
      expect(routeHandler).not.toBeNull();
      await routeHandler!(get as never);
      await routeHandler!(post as never);
    });

    expect(get.continue).toHaveBeenCalledTimes(1);
    expect(get.abort).not.toHaveBeenCalled();
    expect(post.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(post.continue).not.toHaveBeenCalled();
    expect(unroute).toHaveBeenCalledTimes(1);
  });

  it("continues on a newly opened verification tab and ignores closed tabs", () => {
    const first = { id: "password", isClosed: () => false };
    const verification = { id: "verification", isClosed: () => false };
    expect(selectTmallAuthenticationPage([first, verification], first)).toBe(verification);

    const closedVerification = { id: "verification", isClosed: () => true };
    expect(selectTmallAuthenticationPage([first, closedVerification], closedVerification)).toBe(first);
  });
});
