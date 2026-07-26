import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import type { Browser, BrowserContext, Frame, Locator, Page } from "playwright";
import { chromium } from "playwright";
import * as authDriverModule from "./auth-driver";
import {
  assertTmallSubmissionTargetIdentity,
  assertUniqueTmallReviewSourceKeys,
  collectTmallAnchorDomEvidence,
  decideTmallOverlayDisposition,
  findTmallLoginFrame,
  isSafeNotificationPopup,
  isTmallLoginPage,
  isRecognizedTmallDatePickerSurface,
  isVerifiedEmptyPendingQueue,
  parseTmallReviewTotalCount,
  tmallReviewTotalPages,
  parseTmallCalendarMonth,
  readTmallDateRangeFromControl,
  readTmallActivePageEvidence,
  readTmallToggleSelectionState,
  resolveTmallCalendarDateCandidates,
  resolveTmallDateControlCandidates,
  resolveTmallLocatorWithFallback,
  locatorCandidateMatchesOperationSemantic,
  isTmallReplySubmitLabel,
  shouldNavigateTmallSessionHome,
  isTmallReviewSurfaceReady,
  waitForTmallReviewSurface,
  resolveTmallBlockingStateWithTransientOverlayRetry,
  isPassiveTmallNotificationModal,
  isTmallShopLossWarningNavigationModal,
  retryTmallTransientManualAction,
  TmallBrowserOperationTimeoutError,
  createTmallOperationActivity,
  withTmallOperationDeadline,
  resolveTmallTopLevelOverlays,
  parseTmallVisibleDateRange,
  reviewPhaseFromReplyAction,
  shouldIncludeTmallReplyActionForScan,
  selectTmallProductAnchorEvidence,
  tmallStableReviewListEvidence,
  tmallStableReviewStructureEvidence,
  readTmallNextPageAvailability,
  TmallDriverOperationError,
  TmallSessionExpiredError,
  tmallReviewPageUrl,
  tmallReviewPageUrlWithFilters,
  tmallReviewRefreshStrategy,
  tmallReviewSurfaceRecoveryStrategy,
  tmallReviewPageNavigationTargets,
  tmallReviewFilterRecoveryTargets,
  resolveTmallReviewSubmissionPageHint,
  navigateTmallReviewPageWithFallback,
  navigateTmallPageWithTransientRetry,
  publicTmallNavigationFailureMessage,
  publicTmallSubmissionFailureMessage,
  tmallSessionExpiredSubmissionFailure,
  tmallSubmissionInterruptionResult,
  tmallReplyTargetResolution,
  mapTmallComplaintBrowserResult,
  isTmallHintedReplyTarget,
  waitForTmallListEvidenceChange,
  type TmallScopeAnchorEvaluator,
  type TmallHumanActions,
} from "./auth-driver";
import type { TmallReviewSnapshot } from "./review-reader";

function snapshot(overrides: Partial<TmallReviewSnapshot> = {}): TmallReviewSnapshot {
  return {
    sourceKey: "tmall:stable",
    orderId: "1",
    review: "很好",
    product: "漫步者耳机",
    reviewedAt: null,
    sentimentLabel: "positive",
    itemId: "960227744800",
    reviewPhase: "initial",
    ...overrides,
  };
}

interface LoginGroupFixture {
  readonly frame: Frame;
  readonly account: Locator;
  readonly password: Locator;
  readonly submit: Locator;
}

function expectLoginGroup(result: unknown, frame: Frame): asserts result is LoginGroupFixture {
  expect(result).not.toBeNull();
  const group = result as LoginGroupFixture;
  expect(group.frame).toBe(frame);
  expect(group.account).toBeDefined();
  expect(group.password).toBeDefined();
  expect(group.submit).toBeDefined();
  expect(Object.isFrozen(group)).toBe(true);
}

describe("Tmall review pagination", () => {
  it("rejects locator repairs that point a review filter at a different control", () => {
    expect(locatorCandidateMatchesOperationSemantic("review.filter.content", {
      text: "搜索",
      ariaLabel: "",
      placeholder: "",
      role: "button",
    })).toBe(false);
    expect(locatorCandidateMatchesOperationSemantic("review.filter.content", {
      text: "有内容",
      ariaLabel: "",
      placeholder: "",
      role: "button",
    })).toBe(true);
    expect(locatorCandidateMatchesOperationSemantic("review.filter.followup", {
      text: "有追评",
      ariaLabel: "",
      placeholder: "",
      role: "button",
    })).toBe(true);
  });

  it("recognizes the bounded reply confirmation labels used by the inline reply panel", () => {
    for (const label of ["提交", "确认提交", "确认回复", "发布", "回复", "确认", "确定"]) {
      expect(isTmallReplySubmitLabel(label)).toBe(true);
    }
    for (const label of ["投诉评价", "投诉追评", "退款", "下一步", "批量回复"]) {
      expect(isTmallReplySubmitLabel(label)).toBe(false);
    }
  });

  it("reopens the seller home only when a restored browser has no usable seller page", () => {
    expect(shouldNavigateTmallSessionHome("about:blank")).toBe(true);
    expect(shouldNavigateTmallSessionHome("chrome://newtab/")).toBe(true);
    expect(shouldNavigateTmallSessionHome("https://example.com/")).toBe(true);
    expect(shouldNavigateTmallSessionHome("https://myseller.taobao.com/home.htm")).toBe(false);
    expect(shouldNavigateTmallSessionHome("https://myseller.taobao.com/home.htm/comment-manage/list/rateWait4PC")).toBe(false);
  });

  it("does not trust a restored review URL until the filter surface is visible", () => {
    const reviewUrl = "https://myseller.taobao.com/home.htm/comment-manage/list/rateWait4PC?current=1";
    expect(isTmallReviewSurfaceReady(reviewUrl, false)).toBe(false);
    expect(isTmallReviewSurfaceReady(reviewUrl, true)).toBe(true);
    expect(isTmallReviewSurfaceReady("https://myseller.taobao.com/home.htm", true)).toBe(false);
  });

  it("waits for the asynchronously loaded review filters instead of treating the first empty render as a navigation failure", async () => {
    let checks = 0;
    let waits = 0;
    await expect(waitForTmallReviewSurface({
      isReady: async () => {
        checks += 1;
        return checks === 3;
      },
      wait: async () => { waits += 1; },
      maxAttempts: 5,
    })).resolves.toBe(true);
    expect(checks).toBe(3);
    expect(waits).toBe(2);
  });

  it("rechecks a semantically empty loading overlay before requiring manual action", async () => {
    let dismissals = 0;
    let waits = 0;
    await expect(resolveTmallBlockingStateWithTransientOverlayRetry({
      dismiss: async () => {
        dismissals += 1;
        return dismissals === 1 ? "manual_action_required" : "absent";
      },
      readState: async () => null,
      wait: async () => { waits += 1; },
      maxAttempts: 3,
    })).resolves.toEqual({ dismissal: "absent", state: null });
    expect(dismissals).toBe(2);
    expect(waits).toBe(1);
  });

  it("allows only the explicitly approved shop-loss warning navigation", () => {
    expect(isTmallShopLossWarningNavigationModal({
      className: "tbd-modal css-vra8h",
      text: "店铺资损预警 请尽快处理",
      controlLabels: ["立即处理"],
      editableCount: 0,
    })).toBe(true);
    expect(isTmallShopLossWarningNavigationModal({
      className: "tbd-modal css-vra8h",
      text: "店铺资损预警",
      controlLabels: ["立即处理", "确认退款"],
      editableCount: 0,
    })).toBe(false);
    expect(isTmallShopLossWarningNavigationModal({
      className: "tbd-modal css-vra8h",
      text: "店铺资损预警 请完成短信验证",
      controlLabels: ["立即处理"],
      editableCount: 0,
    })).toBe(false);
  });

  it("keeps checking a slow-loading empty overlay long enough for the review application to mount", async () => {
    let dismissals = 0;
    await expect(resolveTmallBlockingStateWithTransientOverlayRetry({
      dismiss: async () => {
        dismissals += 1;
        return dismissals <= 6 ? "manual_action_required" : "absent";
      },
      readState: async () => null,
      wait: async () => undefined,
    })).resolves.toEqual({ dismissal: "absent", state: null });
    expect(dismissals).toBe(7);
  });

  it("accepts a passive child-account notification but rejects verification and business-confirmation modals", () => {
    expect(isPassiveTmallNotificationModal({
      className: "tbd-modal css-vra8h popover--notice",
      text: "重要提醒 发货异常提醒",
      controlLabels: ["查看详情"],
      editableCount: 0,
      hardCloseCount: 1,
    })).toBe(true);
    expect(isPassiveTmallNotificationModal({
      className: "tbd-modal",
      text: "请完成短信验证码验证",
      controlLabels: ["确认"],
      editableCount: 1,
      hardCloseCount: 1,
    })).toBe(false);
    expect(isPassiveTmallNotificationModal({
      className: "tbd-modal",
      text: "退款处理提醒",
      controlLabels: ["确认退款"],
      editableCount: 0,
      hardCloseCount: 1,
    })).toBe(false);
  });

  it("retries one manual-action result only when a second page-state read has no risk semantic", async () => {
    let runs = 0;
    let waits = 0;
    await expect(retryTmallTransientManualAction({
      run: async () => ({ state: runs++ === 0 ? "manual_action_required" : "authenticated" }),
      readState: async () => null,
      wait: async () => { waits += 1; },
    })).resolves.toEqual({ state: "authenticated" });
    expect(runs).toBe(2);
    expect(waits).toBe(1);

    runs = 0;
    await expect(retryTmallTransientManualAction({
      run: async () => {
        runs += 1;
        return { state: "manual_action_required" };
      },
      readState: async () => "manual_verification_required",
      wait: async () => { waits += 1; },
    })).resolves.toEqual({ state: "manual_action_required" });
    expect(runs).toBe(1);
  });

  it("cancels a browser operation that exceeds its overall deadline", async () => {
    let cancelled = 0;
    await expect(withTmallOperationDeadline(
      new Promise<never>(() => undefined),
      20,
      async () => { cancelled += 1; },
    )).rejects.toBeInstanceOf(TmallBrowserOperationTimeoutError);
    expect(cancelled).toBe(1);
  });

  it("reports the stable timeout even when cancellation makes the in-flight locator reject", async () => {
    let rejectOperation!: (error: Error) => void;
    const operation = new Promise<never>((_resolve, reject) => { rejectOperation = reject; });

    await expect(withTmallOperationDeadline(
      operation,
      20,
      async () => {
        rejectOperation(new Error("locator.all: Target page, context or browser has been closed"));
      },
    )).rejects.toBeInstanceOf(TmallBrowserOperationTimeoutError);
  });

  it("invalidates a timed-out operation before it can cross a later click checkpoint", async () => {
    const activity = createTmallOperationActivity();
    let releaseOperation!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseOperation = resolve; });
    let clickCount = 0;
    const operation = (async () => {
      await blocked;
      activity.assertActive();
      clickCount += 1;
    })();

    await expect(withTmallOperationDeadline(
      operation,
      20,
      activity.cancel,
    )).rejects.toBeInstanceOf(TmallBrowserOperationTimeoutError);

    releaseOperation();
    await expect(operation).rejects.toMatchObject({ name: "TmallOperationCancelledError" });
    expect(clickCount).toBe(0);
  });

  it("maps session expiry at any pre-submit checkpoint to login recovery", () => {
    expect(tmallSessionExpiredSubmissionFailure(new Error("unrelated"))).toBeNull();
    expect(tmallSessionExpiredSubmissionFailure({ name: "TmallSessionExpiredError" })).toBeNull();
    expect(tmallSessionExpiredSubmissionFailure(new TmallSessionExpiredError())).toEqual({
      state: "failed",
      evidence: "登录状态已失效",
      message: "淘宝登录状态已失效",
      failureOperationKey: "session.login",
    });
    expect(tmallSubmissionInterruptionResult(new TmallSessionExpiredError(), true)).toEqual({
      state: "uncertain",
      evidence: "点击提交后页面操作中断",
      message: "淘宝登录状态已失效",
      failureOperationKey: "reply.success",
    });
  });

  it("maps a prepared complaint and pre-click failure without pretending a platform submission happened", () => {
    expect(mapTmallComplaintBrowserResult({ state: "prepared", actionLabel: "投诉评价" })).toEqual({
      state: "prepared",
      evidence: "投诉面板已填写并校验，尚未提交",
    });
    expect(mapTmallComplaintBrowserResult({ state: "failed_before_click", actionLabel: "投诉追评", reason: "投诉提交前检查未通过" })).toEqual({
      state: "failed_before_click",
      evidence: "投诉提交前检查未通过",
      message: "投诉提交前检查未通过",
    });
  });

  it("keeps a missing live reply target out of the failed queue", () => {
    expect(tmallReplyTargetResolution(0)).toEqual({
      state: "uncertain",
      evidence: "提交前目标评价已从未回复列表消失",
      message: "目标评价已不在未回复列表中，等待平台记录确认",
      failureOperationKey: "reply.open",
    });
    expect(tmallReplyTargetResolution(1)).toBeNull();
    expect(tmallReplyTargetResolution(2)).toEqual({
      state: "failed",
      evidence: "目标评价匹配数量：2",
      message: "目标评价无法唯一识别",
      failureOperationKey: "reply.open",
    });
  });

  it("never exposes raw Playwright page-closed errors in reply or complaint status", () => {
    const error = new Error("locator.all: Target page, context or browser has been closed");

    expect(publicTmallSubmissionFailureMessage(error)).toBe("淘宝页面连接已中断，本条已安全跳过，将在下一轮重新读取");
    expect(tmallSubmissionInterruptionResult(error, true)).toMatchObject({
      state: "uncertain",
      message: "提交后的平台结果暂时无法确认，已禁止自动重复提交",
    });
    expect(JSON.stringify(tmallSubmissionInterruptionResult(error, true))).not.toContain("Target page");
  });

  it("maps an unchanged complaint page to the platform-already-handled result", () => {
    expect(mapTmallComplaintBrowserResult({
      state: "already_handled",
      actionLabel: "投诉评价",
      reason: "投诉提交后仍停留在投诉界面，平台可能已处理该用户违规",
    })).toEqual({
      state: "already_handled",
      evidence: "投诉提交后仍停留在投诉界面，平台可能已处理该用户违规",
      message: "投诉提交后仍停留在投诉界面，平台可能已处理该用户违规",
    });
  });

  it("accepts one stable platform complaint identifier without inventing the missing one", () => {
    expect(mapTmallComplaintBrowserResult({ state: "sent", actionLabel: "投诉评价", platformCaseId: "case-1" })).toEqual({
      state: "sent",
      evidence: "平台已明确受理投诉",
      platformCaseId: "case-1",
    });
  });

  it("derives the review phase only from the row reply action", () => {
    expect(reviewPhaseFromReplyAction("评价回复")).toBe("initial");
    expect(reviewPhaseFromReplyAction("追评回复")).toBe("followup");
    expect(reviewPhaseFromReplyAction("投诉评价记录")).toBe("initial");
    expect(reviewPhaseFromReplyAction("投诉追评记录")).toBe("followup");
    expect(reviewPhaseFromReplyAction("评价回复记录")).toBe("initial");
    expect(reviewPhaseFromReplyAction("追评回复记录")).toBe("followup");
    expect(() => reviewPhaseFromReplyAction("投诉评价")).toThrow("评价阶段");
  });

  it("resumes a distant scan cursor with one direct verified navigation", () => {
    expect(tmallReviewPageNavigationTargets(1, 828)).toEqual([828]);
    expect(tmallReviewPageNavigationTargets(828, 828)).toEqual([828]);
    expect(tmallReviewPageNavigationTargets(828, 2)).toEqual([2]);
    expect(tmallReviewFilterRecoveryTargets(true, 828)).toEqual([828]);
    expect(tmallReviewFilterRecoveryTargets(false, 828)).toEqual([]);
  });

  it("restores the page that last exposed a cached submission target", () => {
    const hints = new Map([["tmall:a", 2], ["tmall:b", 828]]);
    expect(resolveTmallReviewSubmissionPageHint(hints, "tmall:b")).toBe(828);
    expect(resolveTmallReviewSubmissionPageHint(hints, "tmall:missing")).toBeNull();
  });

  it("keeps the full visible product title without requiring an href and excludes review and order links", () => {
    const selected = selectTmallProductAnchorEvidence([
      {
        text: "漫步者 R206BT 有源台式电脑音箱 蓝牙低音炮",
        href: "",
        ancestorTexts: ["漫步者 R206BT 有源台式电脑音箱 蓝牙低音炮", "漫步者 R206BT 有源台式电脑音箱 蓝牙低音炮 订单号：3311174462787005669"],
      },
      {
        text: "订单详情",
        href: "https://trade.taobao.com/order/3311174462787005669",
        ancestorTexts: ["订单详情 订单号：3311174462787005669"],
      },
      {
        text: "正文里的商品链接",
        href: "https://detail.tmall.com/item.htm?id=999",
        ancestorTexts: ["正文里的商品链接", "这里是买家评价 订单号：3311174462787005669 评价回复 投诉评价"],
      },
      {
        text: "查看更多优惠活动，领取限时优惠券",
        href: "https://detail.tmall.com/item.htm?id=999",
        ancestorTexts: ["查看更多优惠活动，领取限时优惠券", "漫步者 R206BT 订单号：3311174462787005669 查看更多优惠活动"],
      },
    ]);

    expect(selected).toEqual([{
      text: "漫步者 R206BT 有源台式电脑音箱 蓝牙低音炮",
      href: "",
    }]);
  });

  it("ignores promotional item-detail links even when they appear before the product title", () => {
    const selected = selectTmallProductAnchorEvidence([
      {
        text: "复制",
        href: "",
        ancestorTexts: ["复制", "复制 订单号：3311174462787005669"],
      },
      {
        text: "查看更多优惠活动，立即领券",
        href: "https://detail.tmall.com/item.htm?id=999",
        ancestorTexts: ["查看更多优惠活动，立即领券", "查看更多优惠活动 订单号：3311174462787005669"],
      },
      {
        text: "漫步者 R206BT 有源台式电脑音箱 蓝牙低音炮",
        href: "https://detail.tmall.com/item.htm?id=960227744800",
        ancestorTexts: [
          "漫步者 R206BT 有源台式电脑音箱 蓝牙低音炮",
          "漫步者 R206BT 有源台式电脑音箱 蓝牙低音炮 订单号：3311174462787005669",
        ],
      },
    ]);

    expect(selected).toEqual([{
      text: "漫步者 R206BT 有源台式电脑音箱 蓝牙低音炮",
      href: "https://detail.tmall.com/item.htm?id=960227744800",
    }]);
  });

  it("preserves every plausible product detail candidate so conflicting item IDs fail closed downstream", () => {
    expect(selectTmallProductAnchorEvidence([
      {
        text: "漫步者 R206BT 有源台式电脑音箱",
        href: "https://detail.tmall.com/item.htm?id=960227744800",
        ancestorTexts: ["漫步者 R206BT 有源台式电脑音箱 订单号：3311174462787005669"],
      },
      {
        text: "漫步者 R206BT 商品候选链接",
        href: "https://item.taobao.com/item.htm?id=980913413146",
        ancestorTexts: ["漫步者 R206BT 商品候选链接 订单号：3311174462787005669"],
      },
    ])).toEqual([
      {
        text: "漫步者 R206BT 有源台式电脑音箱",
        href: "https://detail.tmall.com/item.htm?id=960227744800",
      },
      {
        text: "漫步者 R206BT 商品候选链接",
        href: "https://item.taobao.com/item.htm?id=980913413146",
      },
    ]);
  });

  it("collects anchor evidence through the scope itself without allocating an element handle", async () => {
    let evaluateCalls = 0;
    const evidence = [{ text: "商品标题", href: "", ancestorTexts: ["商品标题 订单号：12345678"] }];
    const scope: TmallScopeAnchorEvaluator = {
      evaluate: async () => {
        evaluateCalls += 1;
        return evidence;
      },
    };

    await expect(collectTmallAnchorDomEvidence(scope)).resolves.toEqual(evidence);
    expect(evaluateCalls).toBe(1);
  });

  it.each([
    ["different item ID", snapshot(), snapshot({ itemId: "980913413146" })],
    ["missing current item ID", snapshot(), snapshot({ itemId: null })],
    ["different review phase", snapshot(), snapshot({ reviewPhase: "followup" })],
  ])("fails before clicking for the same source key with %s", (_name, expected, current) => {
    let clicks = 0;
    expect(() => {
      assertTmallSubmissionTargetIdentity(expected, current);
      clicks += 1;
    }).toThrow("页面状态不可信");
    expect(clicks).toBe(0);
  });

  it("accepts a current item ID when the original snapshot did not have one", () => {
    expect(() => assertTmallSubmissionTargetIdentity(
      snapshot({ itemId: null }),
      snapshot({ itemId: "960227744800" }),
    )).not.toThrow();
  });

  it("builds an allowlisted pending-review URL for every 20-item page", () => {
    expect(tmallReviewPageUrl(40, 20)).toBe("https://myseller.taobao.com/home.htm/comment-manage/list/rateWait4PC?current=40&pageSize=20");
    expect(() => tmallReviewPageUrl(0, 20)).toThrow("页码");
    expect(() => tmallReviewPageUrl(1, 101)).toThrow("每页数量");
  });

  it("uses one unambiguous total count to recognize a requested page beyond the queue", () => {
    expect(parseTmallReviewTotalCount("共14条 1/1")).toBe(14);
    expect(parseTmallReviewTotalCount("共 33 条 1/2")).toBe(33);
    expect(parseTmallReviewTotalCount("共14条 共15条")).toBeNull();
    expect(parseTmallReviewTotalCount("尚未加载数量")).toBeNull();
  });

  it("derives the real page count before attempting another page", () => {
    expect(tmallReviewTotalPages(0, 20)).toBe(1);
    expect(tmallReviewTotalPages(10, 20)).toBe(1);
    expect(tmallReviewTotalPages(20, 20)).toBe(1);
    expect(tmallReviewTotalPages(21, 20)).toBe(2);
    expect(tmallReviewTotalPages(785, 20)).toBe(40);
  });

  it("restores pagination with only the verified review filters from the current page", () => {
    expect(tmallReviewPageUrlWithFilters(
      "https://myseller.taobao.com/home.htm/comment-manage/list/rateWait4PC?current=1&pageSize=20&content=hasContent&explain=notExplain&dateRange=20260711%2C20260717&unexpected=drop-me",
      2,
      20,
    )).toBe("https://myseller.taobao.com/home.htm/comment-manage/list/rateWait4PC?current=2&pageSize=20&content=hasContent&explain=notExplain&dateRange=20260711%2C20260717");
    expect(tmallReviewPageUrlWithFilters(
      "https://myseller.taobao.com/home.htm/comment-manage/list/rateWait4PC?current=1&pageSize=20&content=hasAppend",
      3,
      20,
    )).toContain("content=hasAppend");
    expect(tmallReviewPageUrlWithFilters("https://evil.example/?content=hasContent", 2, 20)).toBe(tmallReviewPageUrl(2, 20));
  });

  it("reconstructs the frozen date and processing filters when a refresh loses the query string", () => {
    expect(tmallReviewPageUrlWithFilters(
      "https://myseller.taobao.com/home.htm/comment-manage/list/rateWait4PC?current=1&pageSize=20",
      1,
      20,
      {
        startDate: "2026-07-12",
        endDate: "2026-07-18",
        phase: "initial",
        mode: "content_unanswered",
      },
    )).toBe("https://myseller.taobao.com/home.htm/comment-manage/list/rateWait4PC?current=1&pageSize=20&content=hasContent&explain=notExplain&dateRange=20260712%2C20260718");
  });

  it("reuses a verified first-page context and navigates only when it changed", () => {
    expect(tmallReviewRefreshStrategy({
      targetPage: 1,
      activeContextMatches: true,
      requestedPageMatches: true,
    })).toBe("reuse");
    expect(tmallReviewRefreshStrategy({
      targetPage: 2,
      activeContextMatches: true,
      requestedPageMatches: true,
    })).toBe("navigate");
    expect(tmallReviewRefreshStrategy({
      targetPage: 1,
      activeContextMatches: false,
      requestedPageMatches: true,
    })).toBe("navigate");
    expect(tmallReviewRefreshStrategy({
      targetPage: 1,
      activeContextMatches: true,
      requestedPageMatches: false,
    })).toBe("navigate");
  });

  it("uses the allowlisted review URL first and keeps the merchant menu as fallback", async () => {
    const calls: string[] = [];

    const route = await navigateTmallReviewPageWithFallback({
      navigateByMenu: async () => { calls.push("menu"); },
      navigateDirect: async (url) => {
        calls.push(url);
      },
      isReviewPageReady: async () => calls.some((item) => item.includes("/comment-manage/list/rateWait4PC")),
    });

    expect(route).toBe("direct");
    expect(calls).toEqual([tmallReviewPageUrl(1, 20)]);
  });

  it("retries one browser-startup navigation interrupted by about:blank", async () => {
    let attempts = 0;
    await navigateTmallPageWithTransientRetry(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("page.goto: Navigation to 'https://myseller.taobao.com/home.htm' is interrupted by another navigation to 'about:blank'");
      }
    }, async () => undefined);

    expect(attempts).toBe(2);
  });

  it("does not retry unrelated navigation failures", async () => {
    let attempts = 0;
    await expect(navigateTmallPageWithTransientRetry(async () => {
      attempts += 1;
      throw new Error("certificate failure");
    }, async () => undefined)).rejects.toThrow("certificate failure");

    expect(attempts).toBe(1);
  });

  it("never exposes raw browser navigation errors to the workbench", () => {
    expect(publicTmallNavigationFailureMessage(new Error("page.goto: Navigation interrupted Call log: private browser details"))).toBe(
      "淘宝页面暂时无法进入评价管理，请在已打开的窗口处理后继续检测",
    );
  });

  it("reads only an explicit ISO date range from the live date control", () => {
    expect(parseTmallVisibleDateRange("评价时间 2026-07-09 - 2026-07-15")).toEqual({
      startDate: "2026-07-09",
      endDate: "2026-07-15",
    });
    expect(parseTmallVisibleDateRange("评价时间 起始日期 - 结束日期")).toEqual({
      startDate: null,
      endDate: null,
    });
    expect(parseTmallVisibleDateRange("评价时间 2026-07-15")).toEqual({
      startDate: "2026-07-15",
      endDate: null,
    });
  });

  it("normalizes visible calendar month headings and rejects ambiguous text", () => {
    expect(parseTmallCalendarMonth("2026年 7月")).toBe("2026-07");
    expect(parseTmallCalendarMonth(" 2026年12月 ")).toBe("2026-12");
    expect(parseTmallCalendarMonth("2026年13月")).toBeNull();
    expect(parseTmallCalendarMonth("2026年7月 - 2026年8月")).toBeNull();
  });

  it("closes known notification popups but never security or business-confirmation dialogs", () => {
    expect(isSafeNotificationPopup("重要消息 发货异常提醒 查看详情")).toBe(false);
    expect(isSafeNotificationPopup("重要消息 预警通知 发货异常提醒 预计赔付金额494.21元")).toBe(true);
    expect(isSafeNotificationPopup("重要消息 预警通知 退款投诉处罚提醒")).toBe(true);
    expect(isSafeNotificationPopup("功能升级 新版评价管理已上线")).toBe(true);
    expect(isSafeNotificationPopup("重要消息 安全验证 请完成验证码")).toBe(false);
    expect(isSafeNotificationPopup("重要消息 退款操作 是否确认提交")).toBe(false);
    expect(isSafeNotificationPopup("投诉处罚申诉确认")).toBe(false);
  });

  it("accepts an empty queue as verified without pretending reply controls were inspected", () => {
    expect(isVerifiedEmptyPendingQueue("评价内容 商品信息 买家信息 共0条 暂无数据")).toBe(true);
    expect(isVerifiedEmptyPendingQueue("评价内容 商品信息 买家信息 共12条")).toBe(false);
    expect(isVerifiedEmptyPendingQueue("评价内容 商品信息 买家信息 共12条 侧栏通知 共0条")).toBe(false);
    expect(isVerifiedEmptyPendingQueue("侧栏通知 共0条")).toBe(false);
    expect(isVerifiedEmptyPendingQueue("页面仍在加载")).toBe(false);
  });

});

describe("Tmall review filter DOM contracts", () => {
  const loginFrameFixtureTimeoutMs = 2_000;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    const executablePath = [
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
    page = await browser.newPage();
  });

  it("finds the password-login controls inside the current QianNiu iframe", async () => {
    await page.setContent("<iframe></iframe>");
    const expected = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    await expected.setContent(`
      <input placeholder="账号名/邮箱/手机号" />
      <input placeholder="请输入登录密码" type="password" />
      <button>登录</button>
    `);

    const group = await findTmallLoginFrame(
      page,
      (candidate) => candidate.getByPlaceholder(/账号名|邮箱|手机号/u),
      (candidate) => candidate.getByPlaceholder(/登录密码/u),
      (candidate) => candidate.getByRole("button", { name: "登录", exact: true }),
      loginFrameFixtureTimeoutMs,
    );
    expectLoginGroup(group, expected);
  });

  it("finds a complete login control group on the main page", async () => {
    await page.setContent(`
      <input placeholder="账号名/邮箱/手机号" />
      <input placeholder="请输入登录密码" type="password" />
      <button>登录</button>
    `);

    const group = await findTmallLoginFrame(
      page,
      (candidate) => candidate.getByPlaceholder(/账号名|邮箱|手机号/u),
      (candidate) => candidate.getByPlaceholder(/登录密码/u),
      (candidate) => candidate.getByRole("button", { name: "登录", exact: true }),
      loginFrameFixtureTimeoutMs,
    );
    expectLoginGroup(group, page.mainFrame());
  });

  it("finds a complete login control group in a nested iframe", async () => {
    await page.setContent("<iframe></iframe>");
    const outer = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    await outer.setContent("<iframe></iframe>");
    const expected = page.frames().find((candidate) => candidate.parentFrame() === outer)!;
    await expected.setContent(`
      <input placeholder="账号名/邮箱/手机号" />
      <input placeholder="请输入登录密码" type="password" />
      <button>登录</button>
    `);

    const group = await findTmallLoginFrame(
      page,
      (candidate) => candidate.getByPlaceholder(/账号名|邮箱|手机号/u),
      (candidate) => candidate.getByPlaceholder(/登录密码/u),
      (candidate) => candidate.getByRole("button", { name: "登录", exact: true }),
      loginFrameFixtureTimeoutMs,
    );
    expectLoginGroup(group, expected);
  });

  it("classifies an iframe-only complete control group as a login page", async () => {
    await page.setContent("<iframe></iframe>");
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    await frame.setContent(`
      <input placeholder="账号名/邮箱/手机号" />
      <input placeholder="请输入登录密码" type="password" />
      <button>登录</button>
    `);
    await expect(isTmallLoginPage(
      page,
      (candidate) => candidate.getByPlaceholder(/账号名|邮箱|手机号/u),
      (candidate) => candidate.getByPlaceholder(/登录密码/u),
      (candidate) => candidate.getByRole("button", { name: "登录", exact: true }),
    )).resolves.toBe(true);
  });

  it("does not compose account, password, and submit controls across frames", async () => {
    await page.setContent(`
      <input placeholder="账号名/邮箱/手机号" />
      <iframe></iframe>
    `);
    const outer = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    await outer.setContent(`
      <input placeholder="请输入登录密码" type="password" />
      <iframe></iframe>
    `);
    const nested = page.frames().find((candidate) => candidate.parentFrame() === outer)!;
    await nested.setContent("<button>登录</button>");

    await expect(findTmallLoginFrame(
      page,
      (candidate) => candidate.getByPlaceholder(/账号名|邮箱|手机号/u),
      (candidate) => candidate.getByPlaceholder(/登录密码/u),
      (candidate) => candidate.getByRole("button", { name: "登录", exact: true }),
      50,
    )).resolves.toBeNull();
  });

  it("rejects two frames that each contain a complete login control group", async () => {
    await page.setContent("<iframe></iframe><iframe></iframe>");
    const frames = page.frames().filter((candidate) => candidate !== page.mainFrame());
    for (const frame of frames) {
      await frame.setContent(`
        <input placeholder="账号名/邮箱/手机号" />
        <input placeholder="请输入登录密码" type="password" />
        <button>登录</button>
      `);
    }

    await expect(findTmallLoginFrame(
      page,
      (candidate) => candidate.getByPlaceholder(/账号名|邮箱|手机号/u),
      (candidate) => candidate.getByPlaceholder(/登录密码/u),
      (candidate) => candidate.getByRole("button", { name: "登录", exact: true }),
      loginFrameFixtureTimeoutMs,
    )).resolves.toBeNull();
  });

  it("returns the sole complete group while ignoring partial groups in other frames", async () => {
    await page.setContent(`
      <input placeholder="账号名/邮箱/手机号" />
      <iframe></iframe>
    `);
    const expected = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    await expected.setContent(`
      <input placeholder="账号名/邮箱/手机号" />
      <input placeholder="请输入登录密码" type="password" />
      <button>登录</button>
    `);

    const group = await findTmallLoginFrame(
      page,
      (candidate) => candidate.getByPlaceholder(/账号名|邮箱|手机号/u),
      (candidate) => candidate.getByPlaceholder(/登录密码/u),
      (candidate) => candidate.getByRole("button", { name: "登录", exact: true }),
      loginFrameFixtureTimeoutMs,
    );
    expectLoginGroup(group, expected);
  });

  it("uses safe registered locator resolutions while discovering the unique login frame", async () => {
    await page.setContent("<iframe></iframe>");
    const expected = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    await expected.setContent(`
      <input data-login-account />
      <input data-login-password type="password" />
      <button data-login-submit>继续</button>
    `);

    const group = await findTmallLoginFrame(
      page,
      (candidate) => resolveTmallLocatorWithFallback(
        candidate.locator("[data-login-account]"),
        candidate.getByPlaceholder(/账号名|邮箱|手机号/u),
        "editable",
      ),
      (candidate) => resolveTmallLocatorWithFallback(
        candidate.locator("[data-login-password]"),
        candidate.getByPlaceholder(/登录密码/u),
        "password",
      ),
      (candidate) => resolveTmallLocatorWithFallback(
        candidate.locator("[data-login-submit]"),
        candidate.getByRole("button", { name: "登录", exact: true }),
        "enabled",
      ),
      loginFrameFixtureTimeoutMs,
    );
    expectLoginGroup(group, expected);
  });

  it("rejects a control group whose account and password resolve to the same element", async () => {
    await page.setContent(`
      <input id="shared-control" type="password" />
      <button>登录</button>
    `);

    await expect(findTmallLoginFrame(
      page,
      (candidate) => candidate.locator("#shared-control"),
      (candidate) => candidate.locator("#shared-control"),
      (candidate) => candidate.getByRole("button", { name: "登录", exact: true }),
      50,
    )).resolves.toBeNull();
  });

  it("returns within one hard deadline when a login resolver never settles", async () => {
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        findTmallLoginFrame(
          page,
          () => new Promise<Locator | null>(() => undefined),
          (candidate) => candidate.locator("#missing-password"),
          (candidate) => candidate.locator("#missing-submit"),
          30,
        ).then((value) => ({ kind: "resolved" as const, value })),
        new Promise<{ kind: "test_timeout" }>((resolve) => {
          watchdog = setTimeout(() => resolve({ kind: "test_timeout" }), 250);
        }),
      ]);

      expect(outcome).toEqual({ kind: "resolved", value: null });
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
    }
  });

  it("revalidates the full frame tree before actions when a second complete group appears", async () => {
    await page.setContent(`
      <input placeholder="账号名/邮箱/手机号" />
      <input placeholder="请输入登录密码" type="password" />
      <button>登录</button>
    `);
    const group = await findTmallLoginFrame(
      page,
      (candidate) => candidate.getByPlaceholder(/账号名|邮箱|手机号/u),
      (candidate) => candidate.getByPlaceholder(/登录密码/u),
      (candidate) => candidate.getByRole("button", { name: "登录", exact: true }),
      loginFrameFixtureTimeoutMs,
    ) as unknown as LoginGroupFixture | null;
    expectLoginGroup(group, page.mainFrame());

    await page.locator("body").evaluate((body) => body.insertAdjacentHTML("beforeend", "<iframe></iframe>"));
    const second = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    await second.setContent(`
      <input placeholder="账号名/邮箱/手机号" />
      <input placeholder="请输入登录密码" type="password" />
      <button>登录</button>
    `);

    const module = authDriverModule as unknown as {
      revalidateTmallLoginControlGroup?: (
        candidatePage: Page,
        expected: LoginGroupFixture,
        account: Parameters<typeof findTmallLoginFrame>[1],
        password: Parameters<typeof findTmallLoginFrame>[2],
        submit: Parameters<typeof findTmallLoginFrame>[3],
        timeoutMs?: number,
      ) => Promise<LoginGroupFixture | null>;
      performTmallLoginActions?: (
        expected: LoginGroupFixture,
        credentials: { account: string; password: string },
        revalidate: () => Promise<boolean>,
      ) => Promise<void>;
    };
    expect(module.revalidateTmallLoginControlGroup).toBeTypeOf("function");
    expect(module.performTmallLoginActions).toBeTypeOf("function");
    if (!module.revalidateTmallLoginControlGroup || !module.performTmallLoginActions) return;

    await expect(module.performTmallLoginActions(
      group,
      { account: "sensitive-account", password: "sensitive-password" },
      async () => await module.revalidateTmallLoginControlGroup!(
        page,
        group,
        (candidate) => candidate.getByPlaceholder(/账号名|邮箱|手机号/u),
        (candidate) => candidate.getByPlaceholder(/登录密码/u),
        (candidate) => candidate.getByRole("button", { name: "登录", exact: true }),
        200,
      ) !== null,
    )).rejects.toMatchObject({
      operationKey: "login.account",
      message: "登录控件组无法安全确认",
    });
    expect(await group.account.inputValue()).toBe("");
  });

  it.each([
    ["account", "login.account", "登录账号框填写失败"],
    ["password", "login.password", "登录密码框填写失败"],
    ["submit", "login.submit", "登录按钮点击失败"],
  ] as const)("normalizes and redacts %s action failures", async (stage, operationKey, message) => {
    const performTmallLoginActions = (authDriverModule as unknown as {
      performTmallLoginActions?: (
        expected: LoginGroupFixture,
        credentials: { account: string; password: string },
        revalidate: () => Promise<boolean>,
      ) => Promise<void>;
    }).performTmallLoginActions;
    expect(performTmallLoginActions).toBeTypeOf("function");
    if (!performTmallLoginActions) return;

    const account = "sensitive-account";
    const password = "sensitive-password";
    const rawError = `raw DOM adapter error ${account} ${password}`;
    const fail = async (): Promise<void> => { throw new Error(rawError); };
    const group = Object.freeze({
      frame: page.mainFrame(),
      account: {} as Locator,
      password: {} as Locator,
      submit: {} as Locator,
    });
    const humanActions: TmallHumanActions = {
      type: async (locator) => locator === group.account && stage === "account"
        ? fail()
        : locator === group.password && stage === "password" ? fail() : undefined,
      click: async () => stage === "submit" ? fail() : undefined,
      delay: async () => undefined,
    };

    let caught: unknown;
    try {
      await performTmallLoginActions(group, { account, password }, async () => true, humanActions);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TmallDriverOperationError);
    expect(caught).toMatchObject({ operationKey, message });
    const exposed = `${String(caught)} ${JSON.stringify(caught)}`;
    expect(exposed).not.toContain(rawError);
    expect(exposed).not.toContain(account);
    expect(exposed).not.toContain(password);
  });

  it("uses the human action adapter and approved gaps while preserving both revalidation checkpoints", async () => {
    const performTmallLoginActions = (authDriverModule as unknown as {
      performTmallLoginActions?: (
        expected: LoginGroupFixture,
        credentials: { account: string; password: string },
        revalidate: () => Promise<boolean>,
        actions: TmallHumanActions,
      ) => Promise<void>;
    }).performTmallLoginActions;
    expect(performTmallLoginActions).toBeTypeOf("function");
    if (!performTmallLoginActions) return;

    const group = Object.freeze({
      frame: page.mainFrame(),
      account: {} as Locator,
      password: {} as Locator,
      submit: {} as Locator,
    });
    const events: string[] = [];
    let revalidations = 0;
    const actions: TmallHumanActions = {
      type: async (locator, value) => { events.push(`type:${locator === group.account ? "account" : "password"}:${value}`); },
      click: async () => { events.push("click:submit"); },
      delay: async (range) => { events.push(`delay:${range.join("-")}`); },
    };

    await performTmallLoginActions(group, { account: "merchant", password: "secret" }, async () => {
      revalidations += 1;
      events.push("revalidate");
      return true;
    }, actions);

    expect(events).toEqual([
      "revalidate",
      "type:account:merchant",
      "delay:300-800",
      "type:password:secret",
      "delay:500-1200",
      "revalidate",
      "click:submit",
      "delay:1500-3000",
    ]);
    expect(revalidations).toBe(2);
  });

  it("falls back to the verified live control when a saved low-risk locator is stale", async () => {
    await page.setContent('<input placeholder="请输入登录密码" type="password" />');
    const password = await resolveTmallLocatorWithFallback(
      page.getByPlaceholder("登录密码", { exact: true }),
      page.getByPlaceholder(/登录密码/u),
      "password",
    );
    expect(password).not.toBeNull();
    expect(await password!.getAttribute("placeholder")).toBe("请输入登录密码");
  });

  it("falls back without crashing when a refreshed login frame throws synchronously", async () => {
    await page.setContent('<input id="live-password" placeholder="请输入登录密码" type="password" />');
    const detached = {
      all: () => {
        throw new Error("locator.all: Frame was detached");
      },
    } as unknown as Locator;

    const password = await resolveTmallLocatorWithFallback(
      detached,
      page.locator("#live-password"),
      "password",
    );

    expect(password).not.toBeNull();
    expect(await password!.getAttribute("id")).toBe("live-password");
  });

  it("rejects multiple fallback password controls", async () => {
    await page.setContent(`
      <input placeholder="请输入登录密码" type="password" />
      <input placeholder="再次输入登录密码" type="password" />
    `);
    await expect(resolveTmallLocatorWithFallback(
      page.locator("#missing-password"),
      page.locator('input[type="password"]'),
      "password",
    )).resolves.toBeNull();
  });

  it("rejects a hidden fallback password control", async () => {
    await page.setContent('<input placeholder="请输入登录密码" type="password" hidden />');
    await expect(resolveTmallLocatorWithFallback(
      page.locator("#missing-password"),
      page.getByPlaceholder(/登录密码/u),
      "password",
    )).resolves.toBeNull();
  });

  it("accepts the sole visible ready password when another fallback match is hidden", async () => {
    await page.setContent(`
      <input placeholder="请输入登录密码" type="password" hidden />
      <input id="live-password" placeholder="请输入登录密码" type="password" />
    `);
    const password = await resolveTmallLocatorWithFallback(
      page.locator("#missing-password"),
      page.getByPlaceholder(/登录密码/u),
      "password",
    );

    expect(password).not.toBeNull();
    expect(await password!.getAttribute("id")).toBe("live-password");
  });

  it("rejects a readonly fallback password control", async () => {
    await page.setContent('<input placeholder="请输入登录密码" type="password" readonly />');
    await expect(resolveTmallLocatorWithFallback(
      page.locator("#missing-password"),
      page.getByPlaceholder(/登录密码/u),
      "password",
    )).resolves.toBeNull();
  });

  it("rejects a fallback password control whose input type is not password", async () => {
    await page.setContent('<input placeholder="请输入登录密码" type="text" />');
    await expect(resolveTmallLocatorWithFallback(
      page.locator("#missing-password"),
      page.getByPlaceholder(/登录密码/u),
      "password",
    )).resolves.toBeNull();
  });

  it("rejects a disabled fallback login button", async () => {
    await page.setContent("<button disabled>登录</button>");
    await expect(resolveTmallLocatorWithFallback(
      page.locator("#missing-login"),
      page.getByRole("button", { name: "登录", exact: true }),
      "enabled",
    )).resolves.toBeNull();
  });

  it("rejects multiple fallback login buttons", async () => {
    await page.setContent("<button>登录</button><button>登录</button>");
    await expect(resolveTmallLocatorWithFallback(
      page.locator("#missing-login"),
      page.getByRole("button", { name: "登录", exact: true }),
      "enabled",
    )).resolves.toBeNull();
  });

  it("allows the verified reply dialog even when the quoted review mentions complaints", () => {
    expect(decideTmallOverlayDisposition({
      containsAllowedReplyControls: true,
      recognizedDatePicker: false,
      text: "买家评价原文：想退款并投诉客服",
    })).toBe("allow_reply");
    expect(decideTmallOverlayDisposition({
      containsAllowedReplyControls: false,
      recognizedDatePicker: false,
      text: "退款操作，是否确认提交",
    })).toBe("manual_action");
  });

  it("builds list evidence only from stable review identity fields", () => {
    const identifying = snapshot({ sentimentLabel: "unknown" });
    expect(tmallStableReviewListEvidence([identifying])).toBe(
      tmallStableReviewListEvidence([{ ...identifying, sentimentLabel: "positive" }]),
    );
    expect(tmallStableReviewListEvidence([identifying])).not.toBe(
      tmallStableReviewListEvidence([{ ...identifying, reviewPhase: "followup" }]),
    );
  });

  it("builds loading evidence from structural row identity without requiring product parsing", () => {
    expect(tmallStableReviewStructureEvidence([
      { orderId: "3309081924709001", reviewPhase: "initial", phaseMarker: "2026-07-17 17:25" },
      { orderId: "3309081924709002", reviewPhase: "followup", phaseMarker: "收货后5天" },
    ])).toBeTruthy();
    expect(tmallStableReviewStructureEvidence([
      { orderId: null, reviewPhase: "initial", phaseMarker: "2026-07-17 17:25" },
    ])).toBeNull();
  });

  afterAll(async () => browser.close());

  it("resolves the registered date label to the two-input control and reads each live value exactly once", async () => {
    await page.setContent(`
      <section>
        <span>评价时间</span>
        <div class="date-control">
          <input readonly placeholder="起始日期" value="2026-07-09" />
          <span>-</span>
          <input readonly placeholder="结束日期" value="2026-07-15" />
        </div>
      </section>
    `);
    const controls = await resolveTmallDateControlCandidates(await page.getByText("评价时间", { exact: true }).all());
    expect(controls).toHaveLength(1);
    await expect(readTmallDateRangeFromControl(controls[0]!)).resolves.toEqual({ startDate: "2026-07-09", endDate: "2026-07-15" });
  });

  it("filters a broad registered calendar rule down to the exact requested ISO date", async () => {
    await page.setContent(`
      <button aria-label="关闭">x</button>
      <button title="帮助">?</button>
      <button data-value="2026-07-13">13</button>
      <button data-value="2026-07-14">14</button>
      <button data-value="2026-07-15">15</button>
    `);
    const broad = await page.locator("[data-value], [data-date], [title], [aria-label]").all();
    const exact = await resolveTmallCalendarDateCandidates(broad, "2026-07-14");
    expect(exact).toHaveLength(1);
    expect(await exact[0]!.textContent()).toBe("14");
  });

  it("returns unknown instead of inheriting a generic active state from the filter group", async () => {
    await page.setContent(`
      <div class="filter-group active">
        <button id="selected" aria-pressed="true">有内容</button>
        <button id="unselected" aria-pressed="false">未回复</button>
        <span id="unknown" class="chip-a1">来自买家的评价</span>
      </div>
    `);
    await expect(readTmallToggleSelectionState(page.locator("#selected"))).resolves.toBe(true);
    await expect(readTmallToggleSelectionState(page.locator("#unselected"))).resolves.toBe(false);
    await expect(readTmallToggleSelectionState(page.locator("#unknown"))).resolves.toBeNull();
  });

  it("reads exactly one active pagination marker and rejects ambiguous markers", async () => {
    await page.setContent(`
      <nav class="next-pagination">
        <button class="next-pagination-item">1</button>
        <button class="next-pagination-item next-current" aria-current="page">2</button>
        <button class="next-pagination-item">3</button>
      </nav>
    `);
    await expect(readTmallActivePageEvidence(await page.locator("[aria-current='page'], .next-current").all())).resolves.toEqual({
      matches: 1,
      pageNumber: 2,
    });

    await page.locator("button").nth(2).evaluate((element) => element.setAttribute("aria-current", "page"));
    await expect(readTmallActivePageEvidence(await page.locator("[aria-current='page'], .next-current").all())).resolves.toEqual({
      matches: 2,
      pageNumber: null,
    });
  });

  it("treats one disabled next-page button as a verified dynamic end", async () => {
    await page.setContent(`
      <button id="enabled">下一页</button>
      <button id="disabled" disabled>下一页</button>
    `);
    await expect(readTmallNextPageAvailability([page.locator("#enabled")])).resolves.toBe("available");
    await expect(readTmallNextPageAvailability([page.locator("#disabled")])).resolves.toBe("end");
    await expect(readTmallNextPageAvailability([page.locator("#enabled"), page.locator("#disabled")])).resolves.toBe("untrusted");
  });

  it("recognizes only a real calendar surface and leaves unknown popups blocked", async () => {
    await page.setContent(`
      <div id="unknown" class="popover">新的业务提醒<button>继续</button></div>
      <div id="calendar" class="popover">
        <h3>2026年 7月</h3>
        ${Array.from({ length: 7 }, (_, index) => `<button data-value="2026-07-${String(index + 1).padStart(2, "0")}">${index + 1}</button>`).join("")}
      </div>
    `);
    await expect(isRecognizedTmallDatePickerSurface(page.locator("#unknown"))).resolves.toBe(false);
    await expect(isRecognizedTmallDatePickerSurface(page.locator("#calendar"))).resolves.toBe(true);
  });

  it("keeps only the exact notification close control when business actions share the popup", async () => {
    const resolveHardCloseControls = (authDriverModule as unknown as {
      resolveTmallHardCloseControls?: (candidates: Locator[]) => Promise<Locator[]>;
    }).resolveTmallHardCloseControls;
    expect(resolveHardCloseControls).toBeTypeOf("function");
    if (!resolveHardCloseControls) return;

    await page.setContent(`
      <div id="notice" role="dialog">
        <h2>重要消息</h2><p>预警通知 退款投诉处罚提醒</p>
        <button id="close" aria-label="关闭">×</button>
        <button id="process">处理</button>
        <button id="refund">退款</button>
        <button id="appeal">申诉</button>
        <button id="misleading" aria-label="关闭">确认退款</button>
      </div>
    `);

    const controls = await resolveHardCloseControls(await page.locator("#notice button").all());
    expect(await Promise.all(controls.map((control) => control.getAttribute("id")))).toEqual(["close"]);
  });

  it("accepts the exact multiplication-sign close button used by the important-message panel", async () => {
    const resolveHardCloseControls = (authDriverModule as unknown as {
      resolveTmallHardCloseControls?: (candidates: Locator[]) => Promise<Locator[]>;
    }).resolveTmallHardCloseControls;
    expect(resolveHardCloseControls).toBeTypeOf("function");
    if (!resolveHardCloseControls) return;

    await page.setContent(`
      <div id="notice" role="dialog">
        <h2>重要消息</h2><p>预警通知 商品质量分违规提醒</p>
        <button id="close">×</button>
        <button id="process">处理</button>
      </div>
    `);

    const controls = await resolveHardCloseControls(await page.locator("#notice button").all());
    expect(await Promise.all(controls.map((control) => control.getAttribute("id")))).toEqual(["close"]);
  });

  it("accepts the exact icon class used by the live important-message panel", async () => {
    const resolveHardCloseControls = (authDriverModule as unknown as {
      resolveTmallHardCloseControls?: (candidates: Locator[]) => Promise<Locator[]>;
    }).resolveTmallHardCloseControls;
    expect(resolveHardCloseControls).toBeTypeOf("function");
    if (!resolveHardCloseControls) return;

    await page.setContent(`
      <div id="notice">
        <h2>重要消息</h2><p>预警通知 发货异常提醒</p>
        <i id="close" class="next-icon next-icon-close_blod next-medium" style="display:inline-block;width:20px;height:20px"></i>
        <button id="details">查看详情</button>
      </div>
    `);

    const controls = await resolveHardCloseControls(await page.locator("#notice i, #notice button").all());
    expect(await Promise.all(controls.map((control) => control.getAttribute("id")))).toEqual(["close"]);
  });

  it("finds the close icon inside the live important-message notification panel", async () => {
    const resolveImportantMessageCloseControls = (authDriverModule as unknown as {
      resolveTmallImportantMessageCloseControls?: (scope: Page | Locator) => Promise<Locator[]>;
    }).resolveTmallImportantMessageCloseControls;
    expect(resolveImportantMessageCloseControls).toBeTypeOf("function");
    if (!resolveImportantMessageCloseControls) return;

    await page.setContent(`
      <section class="notify_headRight__XdjnE"><i id="close" class="next-icon next-icon-close_blod next-medium" style="display:inline-block;width:20px;height:20px"></i></section>
      <button id="details">查看详情</button>
    `);

    const controls = await resolveImportantMessageCloseControls(page);
    expect(await Promise.all(controls.map((control) => control.getAttribute("id")))).toEqual(["close"]);
  });

  it("finds the acknowledgement inside the topmost feature-upgrade dialog before background notifications", async () => {
    const resolveFeatureUpgradeAcknowledgement = (authDriverModule as unknown as {
      resolveTmallFeatureUpgradeAcknowledgement?: (scope: Page | Locator) => Promise<Locator[]>;
    }).resolveTmallFeatureUpgradeAcknowledgement;
    expect(resolveFeatureUpgradeAcknowledgement).toBeTypeOf("function");
    if (!resolveFeatureUpgradeAcknowledgement) return;

    await page.setContent(`
      <aside class="notify_headRight__XdjnE"><i class="next-icon-close_blod"></i></aside>
      <div class="next-dialog upgrade-analysis-dialog" role="dialog"><button id="acknowledge">我知道了</button></div>
    `);

    const controls = await resolveFeatureUpgradeAcknowledgement(page);
    expect(await Promise.all(controls.map((control) => control.getAttribute("id")))).toEqual(["acknowledge"]);
  });

  it("uses the visible live close control before consulting a repaired popup locator", async () => {
    const resolvePopupCloseControls = (authDriverModule as unknown as {
      resolveTmallPopupCloseControls?: (input: {
        liveCandidates: Locator[];
        repairedCandidates?: () => Promise<Locator[]>;
      }) => Promise<Locator[]>;
    }).resolveTmallPopupCloseControls;
    expect(resolvePopupCloseControls).toBeTypeOf("function");
    if (!resolvePopupCloseControls) return;

    await page.setContent(`
      <div id="notice"><i id="close" class="next-icon next-icon-close_blod" style="display:inline-block;width:20px;height:20px"></i></div>
    `);
    let repairedLocatorCalled = false;
    const staleRepairedLocator = async () => {
      repairedLocatorCalled = true;
      throw new Error("a stale repair must not be queried when the live control is present");
    };

    const controls = await resolvePopupCloseControls({
      liveCandidates: await page.locator("#notice i").all(),
      repairedCandidates: staleRepairedLocator,
    });

    expect(repairedLocatorCalled).toBe(false);
    expect(await Promise.all(controls.map((control) => control.getAttribute("id")))).toEqual(["close"]);
  });

  it("keeps popup-close identity stable while the page title or query string finishes loading", () => {
    const pageIdentity = (authDriverModule as unknown as {
      tmallSafePopupPageIdentity?: (url: string) => string | null;
    }).tmallSafePopupPageIdentity;
    expect(pageIdentity).toBeTypeOf("function");
    if (!pageIdentity) return;

    expect(pageIdentity("https://myseller.taobao.com/home.htm/QnworkbenchHome/?loading=1")).toBe(
      pageIdentity("https://myseller.taobao.com/home.htm/QnworkbenchHome/"),
    );
    expect(pageIdentity("https://myseller.taobao.com/home.htm/comment-manage/list/rateWait4PC")).not.toBe(
      pageIdentity("https://myseller.taobao.com/home.htm/QnworkbenchHome/"),
    );
    expect(pageIdentity("https://example.invalid/home.htm")).toBeNull();
  });

  it("guards writes while probing the exact notification close control", async () => {
    const probeCloseControl = (authDriverModule as unknown as {
      probeTmallSafePopupCloseControl?: (input: {
        page: Page;
        candidate: Locator;
        click: (candidate: Locator) => Promise<void>;
        afterClick: () => Promise<void>;
      }) => Promise<boolean>;
    }).probeTmallSafePopupCloseControl;
    expect(probeCloseControl).toBeTypeOf("function");
    if (!probeCloseControl) return;

    let leakedWrites = 0;
    await page.route("**/*", async (route) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) leakedWrites += 1;
      await route.fulfill({ status: 204, body: "" });
    });
    await page.setContent(`
      <div id="notice" role="dialog">
        <h2>重要消息</h2><p>预警通知 退款投诉处罚提醒</p>
        <button id="process">处理</button>
        <button id="close" aria-label="关闭" onclick="fetch('https://write.invalid/close', { method: 'POST' }).catch(() => {}); this.closest('[role=dialog]').remove()">×</button>
      </div>
    `);
    const guardedPage = {
      route: page.route.bind(page),
      unroute: page.unroute.bind(page),
      url: () => "https://myseller.taobao.com/home.htm/comment-manage/list/rateWait4PC",
      title: page.title.bind(page),
    } as unknown as Page;

    let businessClicks = 0;
    await expect(probeCloseControl({
      page: guardedPage,
      candidate: page.locator("#process"),
      click: async () => { businessClicks += 1; },
      afterClick: async () => undefined,
    })).resolves.toBe(false);
    expect(businessClicks).toBe(0);

    await expect(probeCloseControl({
      page: guardedPage,
      candidate: page.locator("#close"),
      click: async (candidate) => candidate.click(),
      afterClick: async () => page.waitForTimeout(25),
    })).resolves.toBe(true);
    expect(leakedWrites).toBe(0);
    await page.unroute("**/*");
  });

  it("uses one top-level overlay selector for guides, drawers and unknown masks", async () => {
    const selector = (authDriverModule as unknown as { TMALL_TOP_LEVEL_OVERLAY_SELECTOR?: string }).TMALL_TOP_LEVEL_OVERLAY_SELECTOR;
    expect(selector).toBeTypeOf("string");
    if (!selector) return;
    await page.setContent(`
      <div id="dialog" role="dialog">dialog</div>
      <div id="aria" aria-modal="true">aria modal</div>
      <div id="popover" class="business-popover">popover</div>
      <div id="guide" class="new-user-guide">guide</div>
      <div id="drawer" class="business-drawer">drawer</div>
      <div id="modal" class="business-modal">modal</div>
      <div id="mask" class="unknown-mask" style="position:fixed;inset:0">mask</div>
      <div id="card-mask" class="AlimmCard_mask__EfICy" style="position:absolute;width:240px;height:120px">card mask</div>
      <div id="ordinary">ordinary</div>
    `);
    const roots = await resolveTmallTopLevelOverlays(await page.locator(selector).all());
    expect(await Promise.all(roots.map((root) => root.getAttribute("id")))).toEqual([
      "dialog", "aria", "popover", "guide", "drawer", "modal", "mask",
    ]);
  });

  it("keeps only the outer reply dialog while preserving an unknown sibling overlay", async () => {
    await page.setContent(`
      <div id="reply" class="next-dialog" role="dialog">
        <div class="next-dialog-body"><textarea>回复内容</textarea></div>
        <div class="next-dialog-footer"><button>提交</button></div>
      </div>
      <div id="unknown" class="next-dialog">未知业务提醒</div>
    `);
    const selector = (authDriverModule as unknown as { TMALL_TOP_LEVEL_OVERLAY_SELECTOR?: string }).TMALL_TOP_LEVEL_OVERLAY_SELECTOR;
    expect(selector).toBeTypeOf("string");
    if (!selector) return;
    const roots = await resolveTmallTopLevelOverlays(await page.locator(selector).all());
    expect(await Promise.all(roots.map((root) => root.getAttribute("id")))).toEqual(["reply", "unknown"]);
  });

  it("uses a cached native reply index only when the target identity still matches", () => {
    const expected = snapshot();
    expect(isTmallHintedReplyTarget(expected, snapshot())).toBe(true);
    expect(isTmallHintedReplyTarget(expected, snapshot({ sourceKey: "tmall:moved" }))).toBe(false);
    expect(() => isTmallHintedReplyTarget(expected, snapshot({ reviewPhase: "followup" }))).toThrow("页面状态不可信");
  });

  it("fails closed when one scan exposes the same source key more than once", () => {
    expect(() => assertUniqueTmallReviewSourceKeys([
      snapshot(),
      snapshot({ review: "重复行" }),
    ])).toThrow("重复");
  });

  it("never returns to the merchant menu when an already-open review page is briefly unready", () => {
    const reviewUrl = "https://myseller.taobao.com/home.htm/comment-manage/list/rateWait4PC?current=1&pageSize=20&content=hasContent&explain=notExplain";
    expect(tmallReviewSurfaceRecoveryStrategy(reviewUrl, true)).toBe("reuse");
    expect(tmallReviewSurfaceRecoveryStrategy(reviewUrl, false)).toBe("reload_review");
    expect(tmallReviewSurfaceRecoveryStrategy("https://myseller.taobao.com/home.htm", false)).toBe("enter_review");
  });

  it("reads initial and follow-up reply actions together under 有内容 + 未回复", () => {
    expect(shouldIncludeTmallReplyActionForScan("评价回复", "initial", "content_unanswered")).toBe(true);
    expect(shouldIncludeTmallReplyActionForScan("追评回复", "initial", "content_unanswered")).toBe(true);
    expect(shouldIncludeTmallReplyActionForScan("评价回复", "followup", "followup_only")).toBe(false);
    expect(shouldIncludeTmallReplyActionForScan("追评回复", "followup", "followup_only")).toBe(true);
    expect(shouldIncludeTmallReplyActionForScan("投诉评价记录", "initial", "content_unanswered")).toBe(true);
    expect(shouldIncludeTmallReplyActionForScan("投诉追评记录", "followup", "followup_only")).toBe(true);
  });

  it("finds only a safe cancel control for an opened reply dialog", async () => {
    await page.setContent(`
      <div id="reply" role="dialog">
        <h2>评价回复</h2>
        <textarea placeholder="请输入您的回复内容"></textarea>
        <button id="submit">确认提交</button>
        <button id="cancel">取消</button>
      </div>
      <div id="security" role="dialog"><button id="verify">确认验证</button></div>
    `);
    const resolveReplyDismissControls = (authDriverModule as unknown as {
      resolveTmallReplyDismissControls?: (scope: Page | Locator) => Promise<Locator[]>;
    }).resolveTmallReplyDismissControls;
    expect(resolveReplyDismissControls).toBeTypeOf("function");
    if (!resolveReplyDismissControls) return;
    const controls = await resolveReplyDismissControls(page.getByRole("dialog").filter({ hasText: "评价回复" }));
    expect(await Promise.all(controls.map((control) => control.getAttribute("id")))).toEqual(["cancel"]);
  });

  it("waits for delayed page rows to differ from the previous page and remain stable", async () => {
    const samples = ["old-page", "old-page", "new-page-partial", "new-page", "new-page", "new-page"];
    let waits = 0;
    await expect(waitForTmallListEvidenceChange({
      previousEvidence: "old-page",
      sample: async () => samples.shift() ?? "new-page",
      wait: async () => { waits += 1; },
      maxAttempts: 10,
    })).resolves.toBe("new-page");
    expect(waits).toBe(5);
  });
});
it("does not recreate Chrome after the window closes unless a new explicit action permits launch", async () => {
  const stale = {
    pages: () => { throw new Error("Target page, context or browser has been closed"); },
    close: async () => undefined,
  } as unknown as BrowserContext;
  const page = { url: () => "about:blank" } as unknown as Page;
  const fresh = {
    pages: () => [page],
    newPage: async () => page,
  } as unknown as BrowserContext;
  let launches = 0;
  const acquire = (authDriverModule as typeof authDriverModule & {
    acquireLiveTmallPage?: (
      current: BrowserContext | null,
      launch: () => Promise<BrowserContext>,
      options?: { allowLaunch?: boolean },
    ) => Promise<{ context: BrowserContext; page: Page }>;
  }).acquireLiveTmallPage;

  expect(acquire).toBeTypeOf("function");
  await expect(acquire!(stale, async () => { launches += 1; return fresh; }, { allowLaunch: false }))
    .rejects.toThrow("浏览器窗口已关闭，请重新点击运行或继续后再打开");
  expect(launches).toBe(0);
  await expect(acquire!(null, async () => { launches += 1; return fresh; }, { allowLaunch: true }))
    .resolves.toEqual({ context: fresh, page });
  expect(launches).toBe(1);
});
