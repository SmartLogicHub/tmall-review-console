import { describe, expect, it } from "vitest";
import { FIXED_TEMPLATE_SCHEMAS, normalizeFixedTemplateRows, normalizeTemplateRows } from "./templates";

describe("normalizeFixedTemplateRows", () => {
  it("locks the good-review table to the approved fixed fields", () => {
    const result = normalizeFixedTemplateRows("good", [
      {
        recordId: "rec-good-1",
        fields: {
          关键词分类: "音质音效类",
          包含关键词: "音质不错、声音清晰",
          "回复话术 1": "第一条",
          "回复话术 2": "第二条",
        },
      },
      {
        recordId: "rec-good-fallback",
        fields: {
          关键词分类: "通用整体好评类",
          包含关键词: "不错",
          "回复话术 1": "通用好评",
        },
      },
    ]);

    expect(FIXED_TEMPLATE_SCHEMAS.good).toMatchObject({
      categoryField: "关键词分类",
      keywordsField: "包含关键词",
      fallbackCategory: "通用整体好评类",
    });
    expect(result.templates[0]).toEqual({
      primaryCategory: "",
      category: "音质音效类",
      keywords: ["音质不错", "声音清晰"],
      replies: [
        { sequence: 1, text: "第一条" },
        { sequence: 2, text: "第二条" },
      ],
    });
  });

  it("forward-fills blank primary categories in the fixed bad-review table", () => {
    const result = normalizeFixedTemplateRows("bad", [
      {
        recordId: "rec-bad-1",
        fields: {
          一级分类: "佩戴体验",
          二级分类: "半入耳式佩戴",
          包含关键词: "耳朵疼",
          "回复话术 1": "佩戴建议",
        },
      },
      {
        recordId: "rec-bad-2",
        fields: {
          一级分类: "",
          二级分类: "入耳式佩戴",
          包含关键词: "耳道疼",
          "回复话术 1": "耳塞建议",
        },
      },
      {
        recordId: "rec-bad-fallback",
        fields: {
          一级分类: "通用差评类",
          二级分类: "通用差评类",
          包含关键词: "",
          "回复话术 1": "通用差评",
        },
      },
    ]);

    expect(result.templates[1]?.primaryCategory).toBe("佩戴体验");
    expect(result.templates[2]?.category).toBe("通用差评类");
    expect(result.templates[2]?.primaryCategory).toBe("通用差评类");
  });

  it("requires the generic bad-review row to use the same primary category", () => {
    expect(() =>
      normalizeFixedTemplateRows("bad", [
        {
          recordId: "rec-bad-fallback",
          fields: {
            一级分类: "其他问题",
            二级分类: "通用差评类",
            "回复话术 1": "通用差评",
          },
        },
      ]),
    ).toThrow("通用差评类的一级分类也必须是“通用差评类”");
  });

  it("rejects a bad-review table whose first primary category is blank", () => {
    expect(() =>
      normalizeFixedTemplateRows("bad", [
        {
          recordId: "rec-first",
          fields: {
            一级分类: "",
            二级分类: "音量问题",
            "回复话术 1": "内容",
          },
        },
      ]),
    ).toThrow("记录 rec-first 的一级分类为空，无法沿用上一行");
  });

  it("requires the configured generic category for each library", () => {
    expect(() =>
      normalizeFixedTemplateRows("good", [
        {
          recordId: "rec-only",
          fields: { 关键词分类: "音质音效类", "回复话术 1": "内容" },
        },
      ]),
    ).toThrow("好评库缺少必需分类“通用整体好评类”");
  });

  it("rejects two fields that resolve to the same reply sequence", () => {
    expect(() =>
      normalizeFixedTemplateRows("good", [
        {
          recordId: "rec-duplicate-sequence",
          fields: {
            关键词分类: "通用整体好评类",
            "回复话术 1": "第一条",
            回复话术1: "第二条",
          },
        },
      ]),
    ).toThrow("记录 rec-duplicate-sequence 的话术序号 1 重复");
  });
});

describe("normalizeTemplateRows", () => {
  it("reads the current Feishu structure and dynamic reply columns", () => {
    const result = normalizeTemplateRows(
      [
        {
          一级分类: "佩戴体验",
          二级分类: "半入耳式佩戴",
          包含关键词: "耳朵疼、夹耳; 戴不稳\n易掉",
          "回复话术 1": "第一条",
          "回复话术 3": "第三条",
        },
      ],
      {
        primaryCategoryField: "一级分类",
        categoryField: "二级分类",
        keywordsField: "包含关键词",
        replyFieldPattern: "^回复话术\\s*([1-9]\\d*)$",
      },
    );

    expect(result.templates).toEqual([
      {
        primaryCategory: "佩戴体验",
        category: "半入耳式佩戴",
        keywords: ["耳朵疼", "夹耳", "戴不稳", "易掉"],
        replies: [
          { sequence: 1, text: "第一条" },
          { sequence: 3, text: "第三条" },
        ],
      },
    ]);
    expect(result.warnings).toContain("分类“半入耳式佩戴”的话术序号存在空洞：2");
  });

  it("supports renamed Feishu fields through mapping only", () => {
    const result = normalizeTemplateRows(
      [
        {
          问题大类: "音质体验",
          问题点: "音量问题",
          匹配词: "声音小, 音量低",
          "文案-2": "备用文案",
          "文案-1": "首选文案",
        },
      ],
      {
        primaryCategoryField: "问题大类",
        categoryField: "问题点",
        keywordsField: "匹配词",
        replyFieldPattern: "^文案-(\\d+)$",
      },
    );

    expect(result.templates[0]).toEqual({
      primaryCategory: "音质体验",
      category: "音量问题",
      keywords: ["声音小", "音量低"],
      replies: [
        { sequence: 1, text: "首选文案" },
        { sequence: 2, text: "备用文案" },
      ],
    });
  });

  it("ignores blanks, removes duplicate replies, and reports the duplicate", () => {
    const result = normalizeTemplateRows(
      [
        {
          二级分类: "通用差评类",
          包含关键词: "",
          "回复话术 1": "同一句",
          "回复话术 2": "  同一句  ",
          "回复话术 3": "   ",
        },
      ],
      {
        categoryField: "二级分类",
        keywordsField: "包含关键词",
        replyFieldPattern: "^回复话术\\s*([1-9]\\d*)$",
      },
    );

    expect(result.templates[0]?.replies).toEqual([{ sequence: 1, text: "同一句" }]);
    expect(result.warnings).toContain("分类“通用差评类”存在重复话术，已忽略序号 2");
  });

  it("rejects an empty category and an invalid reply field pattern", () => {
    expect(() =>
      normalizeTemplateRows(
        [{ 二级分类: "", "回复话术 1": "内容" }],
        {
          categoryField: "二级分类",
          keywordsField: "包含关键词",
          replyFieldPattern: "^回复话术\\s*([1-9]\\d*)$",
        },
      ),
    ).toThrow("分类字段不能为空");

    expect(() =>
      normalizeTemplateRows([], {
        categoryField: "二级分类",
        keywordsField: "包含关键词",
        replyFieldPattern: "[",
      }),
    ).toThrow("话术字段匹配规则无效");
  });
});
