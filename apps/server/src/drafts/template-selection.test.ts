import { describe, expect, it, vi } from "vitest";
import {
  applyNoUseExperienceGuard,
  applyNeutralLoudnessGuard,
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

  it("does not give in-ear ear-tip instructions to an ear-clip product", () => {
    const selected = selectReplyTemplate({
      review: "音质可以，但是戴久了会有点夹耳朵",
      product: "漫步者AuroClip耳夹式不入耳蓝牙耳机",
      replies: [
        { sequence: 1, text: "您可更换不同尺寸耳塞以贴合耳道，建议间歇佩戴。" },
      ],
      fallbackReplies: [
        { sequence: 8, text: "很抱歉佩戴体验未达到预期，如有疑问请联系我们。" },
      ],
      pickIndex: () => 0,
    });

    expect(selected).toMatchObject({ sequence: 8 });
  });

  it("uses neutral angle guidance when the product title does not identify the wearing form", () => {
    const selected = selectReplyTemplate({
      review: "戴着耳朵疼",
      product: "漫步者Zero Air真无线蓝牙耳机降噪通话运动跑步游戏2026新款",
      replies: [
        { sequence: 1, text: "非常抱歉给亲亲带来不适的佩戴体验！您可更换不同尺寸耳塞以贴合耳道。" },
        { sequence: 2, text: "非常抱歉给亲亲带来不适的佩戴体验！建议您调整佩戴角度来使耳机更稳固。" },
      ],
      fallbackReplies: [],
      pickIndex: () => 0,
    });

    expect(selected).toMatchObject({ sequence: 2 });
  });

  it("does not give replaceable-ear-tip guidance to a semi-in-ear product", () => {
    const selected = selectReplyTemplate({
      review: "戴着耳朵疼",
      product: "漫步者原子豆ANC蓝牙耳机降噪半入耳无线运动2026新款",
      replies: [
        { sequence: 1, text: "非常抱歉给亲亲带来不适的佩戴体验！您可更换不同尺寸耳塞以贴合耳道。" },
        { sequence: 2, text: "非常抱歉给亲亲带来不适的佩戴体验！建议您调整佩戴角度来使耳机更稳固。" },
      ],
      fallbackReplies: [],
      pickIndex: () => 0,
    });

    expect(selected).toMatchObject({ sequence: 2 });
  });

  it("keeps replaceable-ear-tip guidance available for an explicitly in-ear product", () => {
    const selected = selectReplyTemplate({
      review: "戴着耳朵疼",
      product: "漫步者入耳式蓝牙耳机配多尺寸耳塞",
      replies: [
        { sequence: 1, text: "非常抱歉给亲亲带来不适的佩戴体验！您可更换不同尺寸耳塞以贴合耳道。" },
        { sequence: 2, text: "非常抱歉给亲亲带来不适的佩戴体验！建议您调整佩戴角度来使耳机更稳固。" },
      ],
      fallbackReplies: [],
      pickIndex: () => 0,
    });

    expect(selected).toMatchObject({ sequence: 1 });
  });
});

describe("refineFallbackCategory", () => {
  it("routes an unknown-form wearing complaint to the maintained neutral wearing category", () => {
    const refined = refineFallbackCategory({
      library: "bad",
      category: "入耳式佩戴",
      fallbackCategory: "通用差评类",
      review: "戴着耳朵疼",
      product: "漫步者Zero Air真无线蓝牙耳机降噪通话运动跑步游戏2026新款",
      categories: [
        {
          library: "bad",
          primaryCategory: "佩戴体验",
          category: "半入耳式佩戴",
          keywords: ["半入耳式佩戴不适", "耳朵疼"],
        },
        {
          library: "bad",
          primaryCategory: "佩戴体验",
          category: "入耳式佩戴",
          keywords: ["入耳式佩戴不适", "耳道疼", "耳塞胀痛", "耳朵疼"],
        },
        {
          library: "bad",
          primaryCategory: "佩戴体验",
          category: "标题中未提及佩戴类型",
          keywords: ["戴着耳朵疼", "夹耳", "压耳", "佩戴不适"],
        },
        {
          library: "bad",
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: ["一般"],
        },
      ],
    });

    expect(refined).toBe("标题中未提及佩戴类型");
  });

  it("keeps a semi-in-ear wearing complaint out of the in-ear category", () => {
    const refined = refineFallbackCategory({
      library: "bad",
      category: "入耳式佩戴",
      fallbackCategory: "通用差评类",
      review: "戴着耳朵疼",
      product: "漫步者原子豆ANC蓝牙耳机降噪半入耳无线运动2026新款",
      categories: [
        {
          library: "bad",
          primaryCategory: "佩戴体验",
          category: "半入耳式佩戴",
          keywords: ["半入耳式佩戴不适", "耳朵疼"],
        },
        {
          library: "bad",
          primaryCategory: "佩戴体验",
          category: "入耳式佩戴",
          keywords: ["入耳式佩戴不适", "耳道疼", "耳塞胀痛", "耳朵疼"],
        },
        {
          library: "bad",
          primaryCategory: "佩戴体验",
          category: "标题中未提及佩戴类型",
          keywords: ["戴着耳朵疼", "夹耳", "压耳", "佩戴不适"],
        },
        {
          library: "bad",
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: ["一般"],
        },
      ],
    });

    expect(refined).toBe("半入耳式佩戴");
  });

  it("preserves a valid model category when another product is only mentioned as background", () => {
    const refined = refineFallbackCategory({
      library: "good",
      category: "音质音效类",
      fallbackCategory: "通用整体好评类",
      review: "声音效果：音响很不错。买了他家的W820，降噪效果很好。音响果然也不错，音量开到70%能听两天。",
      product: "漫步者M203无线蓝牙音箱",
      categories: [
        { library: "good", primaryCategory: "", category: "音质音效类", keywords: ["音质很好", "音质不错", "声音清晰"] },
        { library: "good", primaryCategory: "降噪", category: "降噪效果类", keywords: ["降噪效果很好"] },
        { library: "good", primaryCategory: "通用", category: "通用整体好评类", keywords: [] },
      ],
    });

    expect(refined).toBe("音质音效类");
  });

  it("keeps empty platform field labels on the generic good fallback", () => {
    const refined = refineFallbackCategory({
      library: "good",
      category: "通用整体好评类",
      fallbackCategory: "通用整体好评类",
      review: "佩戴感受： 续航能力：",
      product: "漫步者Zero Air真无线蓝牙耳机",
      categories: [
        { library: "good", primaryCategory: "佩戴", category: "佩戴体验类", keywords: ["佩戴感受", "佩戴舒适"] },
        { library: "good", primaryCategory: "通用", category: "通用整体好评类", keywords: [] },
      ],
    });

    expect(refined).toBe("通用整体好评类");
  });

  it("keeps an ear-clip wearing complaint on the safe fallback when only in-ear wording exists", () => {
    const refined = refineFallbackCategory({
      library: "bad",
      category: "通用差评类",
      fallbackCategory: "通用差评类",
      review: "音质可以，但是戴久了会有点夹耳朵，性价比可以",
      product: "漫步者AuroClip耳夹式不入耳蓝牙耳机",
      categories: [
        {
          library: "bad",
          primaryCategory: "佩戴体验",
          category: "入耳式佩戴",
          keywords: ["夹耳", "戴久疼", "不舒服"],
        },
        {
          library: "bad",
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: [],
        },
      ],
    });

    expect(refined).toBe("通用差评类");
  });

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

  it("replaces a model-selected amplifier delay category for the H180Plus headphone", () => {
    const refined = refineFallbackCategory({
      library: "bad",
      category: "声音延迟/声音不同步",
      fallbackCategory: "通用差评类",
      review: "k歌不行 收不进高音 k歌软件的耳返还有延迟 换了几个软件都不行 本来就是冲着推荐买的 失败了",
      product: "漫步者H180Plus typec接口手机耳机有线半入耳hifi高音质运动通话",
      categories: [
        {
          library: "bad",
          primaryCategory: "声音异常",
          category: "声音延迟/声音不同步",
          keywords: ["小蜜蜂扩音器有一些延迟", "声音不同步", "声有延迟"],
        },
        {
          library: "bad",
          primaryCategory: "音质体验",
          category: "音质一般",
          keywords: ["音质一般", "音质不好", "声音一般", "声音闷"],
        },
        {
          library: "bad",
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: ["不太行", "就那样吧", "一般"],
        },
      ],
    });

    expect(refined).toBe("音质一般");
  });

  it("keeps the amplifier delay category for an actual amplifier product", () => {
    const refined = refineFallbackCategory({
      library: "bad",
      category: "声音延迟/声音不同步",
      fallbackCategory: "通用差评类",
      review: "小蜜蜂扩音器说话有一些延迟，声音不同步",
      product: "漫步者无线领夹式小蜜蜂扩音器教师上课专用MF1",
      categories: [
        {
          library: "bad",
          primaryCategory: "声音异常",
          category: "声音延迟/声音不同步",
          keywords: ["小蜜蜂扩音器有一些延迟", "声音不同步", "声有延迟"],
        },
        {
          library: "bad",
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: [],
        },
      ],
    });

    expect(refined).toBe("声音延迟/声音不同步");
  });

  it("prioritizes an amplifier-specific issue category over a valid generic model category", () => {
    const refined = refineFallbackCategory({
      library: "bad",
      category: "连接有延迟",
      fallbackCategory: "通用差评类",
      review: "这次入手的小蜜蜂扩音器，在实际使用中体验不太理想，蓝牙耳线连接稳定性较差，使用过程中频繁出现断连情况，影响正常使用；而切换为有线耳麦模式后，虽然连接稳定，但音频延迟明显，整体使用感受未能达到预期。",
      product: "漫步者MF1无线领夹小蜜蜂扩音器教师专用上讲课大音量导游麦克风",
      categories: [
        {
          library: "bad",
          primaryCategory: "声音异常",
          category: "声音延迟/声音不同步",
          keywords: ["小蜜蜂扩音器有一些延迟", "声音不同步", "声有延迟"],
        },
        {
          library: "bad",
          primaryCategory: "连接体验",
          category: "扩音器蓝牙连接问题",
          keywords: ["小蜜蜂扩音器蓝牙断连", "麦克风蓝牙断连", "远距离断连"],
        },
        {
          library: "bad",
          primaryCategory: "连接体验",
          category: "连接有延迟",
          keywords: ["有延迟", "通话有延迟", "讲话有延迟"],
        },
        {
          library: "bad",
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: ["一般"],
        },
      ],
    });

    expect(refined).toBe("声音延迟/声音不同步");
  });

  it("keeps a relevant generic issue when amplifier-specific categories describe other problems", () => {
    const refined = refineFallbackCategory({
      library: "bad",
      category: "客服售后",
      fallbackCategory: "通用差评类",
      review: "客服态度很差，回复也很慢",
      product: "漫步者MF1无线领夹小蜜蜂扩音器教师专用上讲课大音量导游麦克风",
      categories: [
        {
          library: "bad",
          primaryCategory: "声音异常",
          category: "声音延迟/声音不同步",
          keywords: ["小蜜蜂扩音器有一些延迟", "声音不同步"],
        },
        {
          library: "bad",
          primaryCategory: "连接体验",
          category: "扩音器蓝牙连接问题",
          keywords: ["小蜜蜂扩音器蓝牙断连", "麦克风蓝牙断连"],
        },
        {
          library: "bad",
          primaryCategory: "其他问题",
          category: "客服售后",
          keywords: ["售后差", "客服态度差", "回复慢"],
        },
        {
          library: "bad",
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: ["一般"],
        },
      ],
    });

    expect(refined).toBe("客服售后");
  });

  it("uses the safe fallback when an incompatible category has only tied replacement candidates", () => {
    const refined = refineFallbackCategory({
      library: "bad",
      category: "声音延迟/声音不同步",
      fallbackCategory: "通用差评类",
      review: "k歌不行，收不进高音，耳返还有延迟",
      product: "漫步者H180Plus typec接口手机耳机有线半入耳",
      categories: [
        {
          library: "bad",
          primaryCategory: "声音异常",
          category: "声音延迟/声音不同步",
          keywords: ["小蜜蜂扩音器有一些延迟"],
        },
        {
          library: "bad",
          primaryCategory: "音质体验",
          category: "音质一般",
          keywords: ["音质一般"],
        },
        {
          library: "bad",
          primaryCategory: "声音异常",
          category: "收音问题",
          keywords: ["声音异常"],
        },
        {
          library: "bad",
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: [],
        },
      ],
    });

    expect(refined).toBe("通用差评类");
  });

  it("routes the atomdot cycling wind-noise follow-up to environment noise", () => {
    const refined = refineFallbackCategory({
      library: "bad",
      category: "通用差评类",
      fallbackCategory: "通用差评类",
      review: "亲测需避免骑行场景使用，通勤路上骑电动车有点微风，即使开了降噪两边耳朵就是呼呼的风声被放大，简直是增噪，听书听不清楚蛮难受的，室内用用还好。",
      product: "【漫步者】atomdot降噪豆式无线蓝牙耳机入耳式运动游戏2026新款",
      categories: [
        {
          library: "bad",
          primaryCategory: "降噪体验",
          category: "环境音",
          keywords: ["风噪", "环境音大", "骑车时噪音大", "呼呼的风声", "防风噪不行"],
        },
        {
          library: "bad",
          primaryCategory: "降噪体验",
          category: "含ANC主动降噪",
          keywords: ["降噪不行", "主动降噪差", "降噪没效果"],
        },
        {
          library: "bad",
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: [],
        },
      ],
    });

    expect(refined).toBe("环境音");
  });

  it("overrides a compatible but semantically wrong bluetooth-stability category when the review explicitly reports game latency", () => {
    const refined = refineFallbackCategory({
      library: "bad",
      category: "蓝牙稳定性",
      fallbackCategory: "通用差评类",
      review: "没有主动降噪，自带的隔音还好。主要是能同时连两个设备，手机电脑能同时连接。戴久了会有点闷。延迟感觉有点高，打游戏不太行，看视频和追剧没问题。",
      product: "漫步者蓝牙耳机头戴式耳机电脑游戏无线耳麦久戴不痛超长续航调频",
      categories: [
        {
          library: "bad",
          primaryCategory: "连接体验",
          category: "蓝牙稳定性",
          keywords: ["蓝牙连接不稳定", "经常断连", "连接稳定性差"],
        },
        {
          library: "bad",
          primaryCategory: "连接体验",
          category: "连接有延迟",
          keywords: ["延迟有点高", "打游戏有延迟", "玩游戏延迟高"],
        },
        {
          library: "bad",
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: [],
        },
      ],
    });

    expect(refined).toBe("连接有延迟");
  });

  it("treats a sleep earbud as a headphone and rejects an amplifier-only category", () => {
    const refined = refineFallbackCategory({
      library: "good",
      category: "扩音器通用整体好评类",
      fallbackCategory: "通用整体好评类",
      review: "睡觉戴着挺舒服，整体不错",
      product: "漫步者 S1 睡眠耳塞侧睡专用蓝牙耳塞",
      categories: [
        {
          library: "good",
          primaryCategory: "扩音器",
          category: "扩音器通用整体好评类",
          keywords: ["小蜜蜂扩音器不错", "扩音器很好用"],
        },
        {
          library: "good",
          primaryCategory: "通用",
          category: "通用整体好评类",
          keywords: ["不错"],
        },
      ],
    });

    expect(refined).toBe("通用整体好评类");
  });

  it("does not treat the generic word 喜欢 as evidence that the product was a gift", () => {
    const refined = refineFallbackCategory({
      library: "good",
      category: "送礼反馈类",
      fallbackCategory: "通用整体好评类",
      review: "很喜欢，音质也不错",
      product: "漫步者蓝牙耳机",
      categories: [
        {
          library: "good",
          primaryCategory: "场景",
          category: "送礼反馈类",
          keywords: ["喜欢", "送人的", "送朋友"],
        },
        {
          library: "good",
          primaryCategory: "通用",
          category: "通用整体好评类",
          keywords: ["不错"],
        },
      ],
    });

    expect(refined).toBe("通用整体好评类");
  });

  it("routes a single-ear ANC availability complaint to operation rather than ANC effectiveness", () => {
    const refined = refineFallbackCategory({
      library: "bad",
      category: "含ANC主动降噪",
      fallbackCategory: "通用差评类",
      review: "还好，买来备用，单只耳机戴的话降噪不能开，必须两只都戴才可以。",
      product: "漫步者atomdot主动降噪蓝牙耳机",
      categories: [
        {
          library: "bad",
          primaryCategory: "降噪体验",
          category: "含ANC主动降噪",
          keywords: ["降噪不行", "主动降噪差", "降噪没效果"],
        },
        {
          library: "bad",
          primaryCategory: "操作体验",
          category: "操作不便",
          keywords: ["操作不方便", "功能不能开"],
        },
        {
          library: "bad",
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: [],
        },
      ],
    });

    expect(refined).toBe("操作不便");
  });

  it("routes a speaker-microphone combo product's pickup complaint to pickup instead of music sound quality", () => {
    const refined = refineFallbackCategory({
      library: "bad",
      category: "音质一般",
      fallbackCategory: "通用差评类",
      review: "声音很清晰，绿色不错，有性价比，但是收音一般。",
      product: "漫步者K歌精灵Q3蓝牙音响话筒一体麦克风儿童家用音箱",
      categories: [
        {
          library: "bad",
          primaryCategory: "音质体验",
          category: "音质一般",
          keywords: ["音质一般", "声音一般"],
        },
        {
          library: "bad",
          primaryCategory: "麦克风体验",
          category: "收音问题",
          keywords: ["收音一般", "拾音不好", "对方听不清"],
        },
        {
          library: "bad",
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: [],
        },
      ],
    });

    expect(refined).toBe("收音问题");
  });

  it("falls back safely when pickup is the problem but the catalog has only music sound-quality replies", () => {
    const refined = refineFallbackCategory({
      library: "bad",
      category: "音质一般",
      fallbackCategory: "通用差评类",
      review: "声音很清晰，绿色不错，有性价比，但是收音一般。",
      product: "漫步者K歌精灵Q3蓝牙音响话筒一体麦克风儿童家用音箱",
      categories: [
        {
          library: "bad",
          primaryCategory: "音质体验",
          category: "音质一般",
          keywords: ["音质一般", "声音一般"],
        },
        {
          library: "bad",
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: ["一般"],
        },
      ],
    });

    expect(refined).toBe("通用差评类");
  });

  it("does not mistake a pickup complaint for connection latency through a generic call keyword", () => {
    const refined = refineFallbackCategory({
      library: "bad",
      category: "音质一般",
      fallbackCategory: "通用差评类",
      review: "声音很清晰，绿色不错，有性价比，但是收音一般。",
      product: "漫步者K歌精灵Q3蓝牙音响话筒一体麦克风儿童家用音箱",
      categories: [
        {
          library: "bad",
          primaryCategory: "音质体验",
          category: "音质一般",
          keywords: ["音质一般", "声音一般"],
        },
        {
          library: "bad",
          primaryCategory: "连接体验",
          category: "连接有延迟",
          keywords: ["打游戏有延迟", "通话有延迟", "讲话有延迟"],
        },
        {
          library: "bad",
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: ["一般"],
        },
      ],
    });

    expect(refined).toBe("通用差评类");
  });
});

describe("semantic reply selection", () => {
  it("answers inadequate packaging protection without claiming the parcel was damaged", () => {
    const selected = selectReplyTemplate({
      review: "包装比较简单，里面没有什么保护，好在东西没坏。",
      product: "漫步者蓝牙耳机",
      replies: [
        { sequence: 1, text: "很抱歉包装破损影响体验，我们会与快递方沟通运输问题。" },
        { sequence: 2, text: "感谢您的反馈，我们会持续关注包装防护和内部保护体验。" },
      ],
      fallbackReplies: [],
      pickIndex: () => 0,
    });

    expect(selected.sequence).toBe(2);
  });

  it("answers microphone pickup feedback with a pickup-oriented template", () => {
    const selected = selectReplyTemplate({
      review: "耳机听歌还行，就是麦克风收音一般，对方有时听不清。",
      product: "漫步者头戴式蓝牙耳麦",
      replies: [
        { sequence: 1, text: "很抱歉音质没有达到预期，建议更换音乐音源后体验。" },
        { sequence: 2, text: "很抱歉麦克风收音影响通话，建议调整麦克风位置并检查通话权限。" },
      ],
      fallbackReplies: [],
      pickIndex: () => 0,
    });

    expect(selected.sequence).toBe(2);
  });

  it("uses the general troubleshooting operation reply for a single-ear ANC limitation", () => {
    const selected = selectReplyTemplate({
      review: "单只耳机戴的话降噪不能开，必须两只都戴才可以。",
      product: "漫步者主动降噪蓝牙耳机",
      replies: [
        { sequence: 1, text: "您可重新连接耳机或在APP调整手势动作。" },
        { sequence: 2, text: "建议擦拭触控区域并重连耳机，改善按键触控。" },
        { sequence: 3, text: "可联系客服排查使用限制，我们会及时给出合适的解决方案。" },
      ],
      fallbackReplies: [],
      pickIndex: () => 0,
    });

    expect(selected.sequence).toBe(3);
  });
});

describe("applyNeutralLoudnessGuard", () => {
  it("does not turn a neutral loudness comparison into a bad review", () => {
    expect(applyNeutralLoudnessGuard({
      library: "bad",
      category: "通用差评类",
      confidence: 0.8,
      reason: "声音大",
      needsAttention: false,
    }, "声音有点大，圆圆的，还可以，比Pro的声音大", "通用整体好评类")).toMatchObject({
      library: "good",
      category: "通用整体好评类",
    });
  });

  it("keeps loudness feedback negative when the buyer says it is uncomfortable", () => {
    const original = {
      library: "bad" as const,
      category: "通用差评类",
      confidence: 0.95,
      reason: "音量造成不适",
      needsAttention: false,
    };
    expect(applyNeutralLoudnessGuard(
      original,
      "声音太大太吵了，听着刺耳难受",
      "通用整体好评类",
    )).toEqual(original);
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
