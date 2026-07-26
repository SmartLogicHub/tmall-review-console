import { describe, expect, it, vi } from "vitest";
import {
  applyNoUseExperienceGuard,
  refineFallbackCategory,
  selectReplyTemplate,
} from "./template-selection";

describe("selectReplyTemplate", () => {
  it("filters headphone-specific wording for a speaker before choosing", () => {
    const pickIndex = vi.fn(() => 0);
    const selected = selectReplyTemplate({
      review: "颜值很高，摆在家里很好看",
      product: "漫步者M285无线蓝牙音箱便携迷你音响",
      replies: [
        { sequence: 1, text: "愿这款好看的耳机陪您解锁更多美好瞬间。" },
        { sequence: 2, text: "感谢您认可产品的高颜值，愿它点亮日常生活。" },
      ],
      fallbackReplies: [{ sequence: 9, text: "感谢您的认可。" }],
      pickIndex,
    });

    expect(selected).toMatchObject({ sequence: 2 });
    expect(pickIndex).toHaveBeenCalledWith(1);
  });

  it("recognizes an amplifier and prefers its product-specific wording", () => {
    const selected = selectReplyTemplate({
      review: "声音大，上课用很方便",
      product: "漫步者无线领夹式小蜜蜂扩音器教师上课专用MF1麦克风喊话喇叭",
      replies: [
        { sequence: 1, text: "感谢您认可咱们耳机的音质。" },
        { sequence: 2, text: "感谢您认可小蜜蜂扩音器的清晰扩音效果。" },
        { sequence: 3, text: "感谢您的认可。" },
      ],
      fallbackReplies: [],
      pickIndex: () => 0,
    });

    expect(selected).toMatchObject({ sequence: 2 });
  });

  it("uses the review sub-intent inside one category instead of random selection", () => {
    const selected = selectReplyTemplate({
      review: "左耳刚好，右耳有点松，走路容易掉",
      product: "漫步者Comfo SE耳夹式蓝牙耳机",
      replies: [
        { sequence: 1, text: "您可调整耳夹位置和松紧度，如仍有疑问请联系我们。" },
        { sequence: 2, text: "建议控制佩戴时长适时放松，缓解久戴不适。" },
      ],
      fallbackReplies: [],
      pickIndex: () => 0,
    });

    expect(selected).toMatchObject({ sequence: 1 });
  });

  it("prefers safer wording when another template makes an absolute promise", () => {
    const selected = selectReplyTemplate({
      review: "签收以后发现别的平台更便宜",
      product: "漫步者蓝牙耳机",
      replies: [
        { sequence: 1, text: "店内产品价格长期一致，请联系我们咨询价格规则。" },
        { sequence: 2, text: "很抱歉价格影响体验，您可联系客服核实活动和价格规则。" },
      ],
      fallbackReplies: [],
      pickIndex: () => 0,
    });

    expect(selected).toMatchObject({ sequence: 2 });
  });

  it("uses the library fallback only when every category reply names the wrong product", () => {
    const selected = selectReplyTemplate({
      review: "颜值很高",
      product: "漫步者M285无线蓝牙音箱",
      replies: [
        { sequence: 1, text: "感谢您喜欢这款耳机。" },
        { sequence: 2, text: "愿这副耳麦陪伴您的日常。" },
      ],
      fallbackReplies: [{ sequence: 8, text: "感谢您的认可，祝您使用愉快。" }],
      pickIndex: () => 0,
    });

    expect(selected).toMatchObject({ sequence: 8 });
  });
});

describe("refineFallbackCategory", () => {
  it("promotes a concrete positive dimension when the model used the generic fallback", () => {
    const refined = refineFallbackCategory({
      library: "good",
      category: "通用整体好评类",
      fallbackCategory: "通用整体好评类",
      review: "商品品质非常有保障，使用过程中没有出现任何问题，非常满意。",
      product: "漫步者M0蓝牙音箱",
      categories: [
        { library: "good", primaryCategory: "", category: "品质体验类", keywords: ["好用", "质量很好"] },
        { library: "good", primaryCategory: "", category: "音质音效类", keywords: ["音质很好"] },
        { library: "good", primaryCategory: "", category: "通用整体好评类", keywords: ["非常满意"] },
      ],
    });

    expect(refined).toBe("品质体验类");
  });

  it("does not promote an amplifier-only category for a headphone", () => {
    const refined = refineFallbackCategory({
      library: "good",
      category: "通用整体好评类",
      fallbackCategory: "通用整体好评类",
      review: "声音很清晰，很满意",
      product: "漫步者W830NB蓝牙耳机",
      categories: [
        { library: "good", primaryCategory: "", category: "扩音器音质音效类", keywords: ["小蜜蜂扩音器声音清晰"] },
        { library: "good", primaryCategory: "", category: "音质音效类", keywords: ["声音清晰"] },
        { library: "good", primaryCategory: "", category: "通用整体好评类", keywords: ["很满意"] },
      ],
    });

    expect(refined).toBe("音质音效类");
  });
});

describe("applyNoUseExperienceGuard", () => {
  it("does not turn an unopened gift with no product problem into a bad reply", () => {
    expect(applyNoUseExperienceGuard({
      library: "bad",
      category: "通用差评类",
      confidence: 0.7,
      reason: "没有实际体验",
      needsAttention: false,
    }, "送人的，没打开，不知道咋样，好像还有个小套。", "通用整体好评类")).toMatchObject({
      library: "good",
      category: "通用整体好评类",
    });
  });

  it("keeps a concrete product problem negative even when the buyer has barely used it", () => {
    const original = {
      library: "bad" as const,
      category: "质量问题",
      confidence: 0.95,
      reason: "开箱损坏",
      needsAttention: false,
    };

    expect(applyNoUseExperienceGuard(
      original,
      "刚打开还没用，耳机盒就是坏的。",
      "通用整体好评类",
    )).toEqual(original);
  });
});
