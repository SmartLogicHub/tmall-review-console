import { describe, expect, it } from "vitest";
import {
  parseTmallItemId,
  platformActionEvidenceFromLabels,
  platformActionStateFromText,
  parseTmallReviewRow,
  resolveTmallItemIdCandidates,
  TmallReviewPageStateError,
} from "./review-reader";

describe("Tmall product item identity", () => {
  it.each([
    ["https://detail.tmall.com/item.htm?id=12345678901234567890", "12345678901234567890"],
    ["http://item.taobao.com/item.htm?id=42", "42"],
    ["/item.htm?id=900719925474099312345", "900719925474099312345"],
    ["//item.taobao.com/item.htm?id=77", "77"],
    ["https://DETAIL.TMALL.COM./item.htm?id=88", "88"],
    ["https://detail.tmall.com/item.htm?id=99&id=99", "99"],
    ["https://detail.tmall.com/item.htm?id=960227744800", "960227744800"],
  ])("reads a canonical decimal id from an allowlisted product link", (href, expected) => {
    expect(parseTmallItemId(href)).toBe(expected);
  });

  it.each([
    "https://detail.tmall.com/item.htm",
    "https://detail.tmall.com/item.htm?id=",
    "https://detail.tmall.com/item.htm?id=01",
    "https://detail.tmall.com/item.htm?id=0",
    "https://detail.tmall.com/item.htm?id=1.5",
    "https://detail.tmall.com/item.htm?id=1&id=2",
    "javascript:alert(1)",
    "data:text/plain,id=1",
    "file:///item.htm?id=1",
    "https://detail.tmall.com.evil.example/item.htm?id=1",
    "https://item.taobao.com@evil.example/item.htm?id=1",
    "https://user@detail.tmall.com/item.htm?id=1",
    "https://detail.tmall.com:443/item.htm?id=1",
    "https://detail.tmall.com:8443/item.htm?id=1",
    "https://detail.tmall.com../item.htm?id=1",
    "https://example.com/item.htm?id=1",
    "https://detail.tmall.com/search.htm?id=1",
    "https://detail.tmall.com/activity/promo?id=1",
    "https://item.taobao.com/anything-else?id=1",
  ])("rejects an ambiguous or unsafe product link: %s", (href) => {
    expect(parseTmallItemId(href)).toBeNull();
  });

  it("deduplicates matching candidates and fails closed on conflicting item ids", () => {
    expect(resolveTmallItemIdCandidates([
      "https://detail.tmall.com/item.htm?id=123",
      "//item.taobao.com/item.htm?id=123",
      "https://example.com/item.htm?id=999",
    ])).toBe("123");
    expect(resolveTmallItemIdCandidates([])).toBeNull();
    expect(() => resolveTmallItemIdCandidates([
      "https://detail.tmall.com/item.htm?id=123",
      "https://item.taobao.com/item.htm?id=456",
    ])).toThrow(TmallReviewPageStateError);
  });
});

describe("Tmall review row parser", () => {
  it("derives complaint availability only from the current phase visible labels", () => {
    expect(platformActionEvidenceFromLabels(
      ["评价回复", "投诉评价", "投诉追评记录"],
      "initial",
    )).toEqual({
      platformActionState: "none",
      complaintEntryState: "available",
    });
    expect(platformActionEvidenceFromLabels(
      ["评价回复", "投诉追评记录"],
      "initial",
    )).toEqual({
      platformActionState: "none",
      complaintEntryState: "unavailable",
    });
    expect(platformActionEvidenceFromLabels(
      ["追评回复", "投诉追评记录", "投诉评价"],
      "followup",
    )).toEqual({
      platformActionState: "complaint_record",
      complaintEntryState: "unavailable",
    });
  });

  it("reads platform complaint outcomes only from the current review phase surface", () => {
    expect(platformActionStateFromText("投诉成立", "initial")).toBe("complaint_upheld");
    expect(platformActionStateFromText("投诉成功", "initial")).toBe("complaint_upheld");
    expect(platformActionStateFromText("投诉处理成功", "followup")).toBe("complaint_upheld");
    expect(platformActionStateFromText("投诉评价记录", "initial")).toBe("complaint_record");
    expect(platformActionStateFromText("投诉追评记录", "followup")).toBe("complaint_record");
    expect(platformActionStateFromText("评价回复记录", "initial")).toBe("reply_record");
    expect(platformActionStateFromText("追评回复记录", "followup")).toBe("reply_record");
    expect(platformActionStateFromText("投诉评价记录", "followup")).toBe("none");
    expect(platformActionStateFromText("投诉追评记录", "initial")).toBe("none");
  });

  it("persists an upheld platform complaint on the parsed snapshot", () => {
    const parsed = parseTmallReviewRow({
      rawText: "中性评价\n无意义字符\n初次评价：2026-07-14 15:58\n漫步者耳机\n订单号：3311951916351849850\n投诉成立\n评价回复",
      platformActionText: "投诉成立\n评价回复",
      productCandidates: ["漫步者耳机"],
      reviewCandidates: ["无意义字符"],
      productLinkCandidates: [],
      phaseReviewCandidates: [],
      reviewPhase: "initial",
      rowIndex: 0,
    });

    expect(parsed.platformActionState).toBe("complaint_upheld");
  });

  it("extracts a pending review and creates a stable source key", () => {
    const input = {
      rawText: [
        "正面评价",
        "这款蓝牙耳机音质还可以，就是戴上有点夹耳朵",
        "初次评价：2026-07-13 11:45",
        "漫步者 X1 EVO 真无线蓝牙耳机",
        "订单号：3309081924709001",
        "王**",
        "还有30天可回复",
        "评价回复",
        "投诉评价",
      ].join("\n"),
      productCandidates: ["漫步者 X1 EVO 真无线蓝牙耳机"],
      reviewCandidates: ["这款蓝牙耳机音质还可以，就是戴上有点夹耳朵"],
      productLinkCandidates: ["https://detail.tmall.com/item.htm?id=900719925474099312345"],
      phaseReviewCandidates: [],
      reviewPhase: "initial" as const,
      rowIndex: 0,
    };

    const first = parseTmallReviewRow(input);
    const second = parseTmallReviewRow(input);

    expect(first).toMatchObject({
      orderId: "3309081924709001",
      review: "这款蓝牙耳机音质还可以，就是戴上有点夹耳朵",
      product: "漫步者 X1 EVO 真无线蓝牙耳机",
      reviewedAt: "2026-07-13 11:45",
      sentimentLabel: "positive",
      itemId: "900719925474099312345",
      reviewPhase: "initial",
    });
    expect(first.sourceKey).toBe("tmall:3309081924709001:f0dae0d8cc6968f9a3d215b6");
    expect(first.sourceKey).toBe(second.sourceKey);
    expect(first.sourceKey).not.toContain(first.review);
  });

  it("rejects a row when the review text cannot be identified uniquely", () => {
    expect(() => parseTmallReviewRow({
      rawText: "正面评价\n订单号：3309081924709001\n初次评价：2026-07-13 11:45\n评价回复",
      productCandidates: [],
      reviewCandidates: [],
      productLinkCandidates: [],
      phaseReviewCandidates: [],
      reviewPhase: "initial",
      rowIndex: 3,
    })).toThrow("第 4 条评论无法识别评论内容");
  });

  it("does not mistake a broad review container for the comment itself", () => {
    const rawText = "正面评价\n质量很好，物流也快\n初次评价：2026-07-14 09:10\n漫步者 H180 Plus 有线耳机\n订单号：5123324557935010\n评价回复";
    const parsed = parseTmallReviewRow({
      rawText,
      productCandidates: ["漫步者 H180 Plus 有线耳机"],
      reviewCandidates: [rawText],
      productLinkCandidates: [],
      phaseReviewCandidates: [],
      reviewPhase: "initial",
      rowIndex: 0,
    });

    expect(parsed.review).toBe("质量很好，物流也快");
    expect(parsed).toMatchObject({ product: "漫步者 H180 Plus 有线耳机", itemId: null });
  });

  it("keeps item identity outside the source key while separating initial and follow-up reviews", () => {
    const base = {
      rawText: "正面评价\n好用\n初次评价：2026-07-14 09:10\n漫步者耳机\n订单号：5123324557935010\n评价回复",
      productCandidates: ["漫步者耳机"],
      reviewCandidates: ["好用"],
      rowIndex: 0,
    };
    const initial = parseTmallReviewRow({
      ...base,
      productLinkCandidates: ["https://detail.tmall.com/item.htm?id=111"],
      phaseReviewCandidates: [],
      reviewPhase: "initial",
    });
    const followup = parseTmallReviewRow({
      ...base,
      productLinkCandidates: ["https://detail.tmall.com/item.htm?id=222"],
      phaseReviewCandidates: [{ text: "好用", reviewPhase: "followup", reviewedAt: "2026-07-14 09:10" }],
      reviewPhase: "followup",
    });

    expect(initial.sourceKey).not.toBe(followup.sourceKey);
    expect(initial.itemId).toBe("111");
    expect(followup).toMatchObject({ itemId: "222", reviewPhase: "followup" });
  });

  it("does not infer item identity from a URL inside buyer review text", () => {
    const parsed = parseTmallReviewRow({
      rawText: "正面评价\n正文含 https://detail.tmall.com/item.htm?id=999 也不应该猜商品\n初次评价：2026-07-14 09:10\n漫步者耳机\n订单号：5123324557935010\n评价回复",
      productCandidates: ["漫步者耳机"],
      reviewCandidates: ["正文含 https://detail.tmall.com/item.htm?id=999 也不应该猜商品"],
      productLinkCandidates: [],
      phaseReviewCandidates: [],
      reviewPhase: "initial",
      rowIndex: 0,
    });

    expect(parsed.itemId).toBeNull();
  });

  it("uses the follow-up body and time when both phases are present in one row", () => {
    const initialReview = "初评正文很长，这段内容不得被追评处理误选";
    const followupReview = "追评后表示一般";
    const parsed = parseTmallReviewRow({
      rawText: [
        "中性评价",
        initialReview,
        "初次评价：2026-07-13 20:13",
        followupReview,
        "追评：2026-07-15 08:30",
        "漫步者 GM260Plus 耳机",
        "订单号：5123377190269101301",
        "追评回复",
      ].join("\n"),
      productCandidates: ["漫步者 GM260Plus 耳机"],
      reviewCandidates: [initialReview, followupReview],
      phaseReviewCandidates: [
        { text: initialReview, reviewPhase: "initial", reviewedAt: "2026-07-13 20:13" },
        { text: followupReview, reviewPhase: "followup", reviewedAt: "2026-07-15 08:30" },
      ],
      productLinkCandidates: ["https://detail.tmall.com/item.htm?id=700451080604"],
      reviewPhase: "followup",
      rowIndex: 0,
    });

    expect(parsed).toMatchObject({
      review: followupReview,
      reviewedAt: "2026-07-15 08:30",
      reviewPhase: "followup",
    });
  });

  it("uses a relative append marker while retaining the initial absolute time for scope checks", () => {
    const parsed = parseTmallReviewRow({
      rawText: [
        "正面评价",
        "初评很好",
        "初次评价：2026-07-17 10:06",
        "追加后仍然满意",
        "追加评价：收货后5天",
        "漫步者 H180Plus 耳机",
        "订单号：5122653267155016718",
        "追评回复",
      ].join("\n"),
      productCandidates: ["漫步者 H180Plus 耳机"],
      reviewCandidates: ["初评很好", "追加后仍然满意"],
      phaseReviewCandidates: [
        { text: "初评很好", reviewPhase: "initial", reviewedAt: "2026-07-17 10:06" },
        { text: "追加后仍然满意", reviewPhase: "followup", reviewedAt: "收货后5天" },
      ],
      productLinkCandidates: ["https://detail.tmall.com/item.htm?id=700451080604"],
      reviewPhase: "followup",
      rowIndex: 0,
    });

    expect(parsed).toMatchObject({
      review: "追加后仍然满意",
      reviewedAt: "2026-07-17 10:06",
      reviewPhase: "followup",
    });
  });

  it("accepts a uniquely scoped expanded follow-up body when Tmall omits the receipt-age label", () => {
    const parsed = parseTmallReviewRow({
      rawText: "初评正文\n初次评价：2026-07-17 10:06\n唯一追评正文\n订单号：5122653267155016718\n追评回复",
      productCandidates: ["漫步者耳机"],
      reviewCandidates: ["唯一追评正文"],
      phaseReviewCandidates: [{ text: "唯一追评正文", reviewPhase: "followup", reviewedAt: "追加评价" }],
      productLinkCandidates: ["https://detail.tmall.com/item.htm?id=700451080604"],
      reviewPhase: "followup",
      rowIndex: 0,
    });

    expect(parsed).toMatchObject({
      review: "唯一追评正文",
      reviewedAt: "2026-07-17 10:06",
      reviewPhase: "followup",
    });
  });

  it("fails closed when a follow-up row has no phase-specific body and time evidence", () => {
    expect(() => parseTmallReviewRow({
      rawText: "初评内容\n初次评价：2026-07-13 20:13\n追评内容\n漫步者耳机\n订单号：5123377190269101301\n追评回复",
      productCandidates: ["漫步者耳机"],
      reviewCandidates: ["初评内容", "追评内容"],
      phaseReviewCandidates: [],
      productLinkCandidates: [],
      reviewPhase: "followup",
      rowIndex: 0,
    })).toThrow("追评正文和时间无法安全确认");
  });
});
