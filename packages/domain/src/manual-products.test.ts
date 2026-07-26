import { describe, expect, it } from "vitest";
import {
  matchManualProduct,
  normalizeManualProductTitle,
  resolveManualProductIdentity,
} from "./manual-products";

interface ProductFixture {
  recordId: string;
  itemId: string | null;
  title: string;
  normalizedTitle?: string;
}

describe("normalizeManualProductTitle", () => {
  it("applies NFKC and lowercases Latin text", () => {
    expect(normalizeManualProductTitle("Ｃａｆｅ\u0301 １２３")).toBe("café123");
  });

  it("removes zero-width characters", () => {
    expect(normalizeManualProductTitle("商\u200B品\u200C名\u200D\uFEFF\u2060")).toBe("商品名");
  });

  it("removes Unicode whitespace, punctuation, and symbols", () => {
    expect(normalizeManualProductTitle("  Pro-Max／新款✨【红色】  ")).toBe("promax新款红色");
  });
});

describe("resolveManualProductIdentity", () => {
  it("reuses an entity with the same item ID and resolves its updated title", () => {
    const existing: ProductFixture[] = [
      { recordId: "row-1", itemId: "1001", title: "旧标题", normalizedTitle: "旧标题" },
    ];

    expect(resolveManualProductIdentity({ itemId: "1001", title: "全新标题" }, existing)).toEqual({
      status: "matched",
      matchedBy: "item_id",
      target: existing[0],
      patch: { itemId: "1001", title: "全新标题", normalizedTitle: "全新标题" },
      mergeCandidates: [],
    });
    expect(existing[0]!.title).toBe("旧标题");
  });

  it("keeps same-title entities with different item IDs distinct", () => {
    const existing: ProductFixture[] = [
      { recordId: "row-1", itemId: "1001", title: "明星商品" },
      { recordId: "row-2", itemId: "1002", title: "明星商品" },
    ];

    expect(resolveManualProductIdentity({ itemId: "1003", title: "明星商品" }, existing)).toEqual({
      status: "not_matched",
      patch: { itemId: "1003", title: "明星商品", normalizedTitle: "明星商品" },
    });
  });

});

describe("matchManualProduct", () => {
  it("fails closed when a review has no trusted item ID, even if its title matches", () => {
    const products: ProductFixture[] = [
      { recordId: "row-1", itemId: "1001", title: "明星商品" },
    ];

    expect(matchManualProduct({ itemId: null, title: "明星商品" }, products)).toEqual({
      status: "identity_untrusted",
    });
  });

  it("does not allow a legacy title-only row to match a review", () => {
    const products: ProductFixture[] = [
      { recordId: "legacy", itemId: null, title: "明星商品" },
    ];

    expect(matchManualProduct({ itemId: "1001", title: "明星商品" }, products)).toEqual({
      status: "not_matched",
    });
    expect(matchManualProduct({ itemId: null, title: "明星商品" }, products)).toEqual({
      status: "identity_untrusted",
    });
  });

  it("does not fall back by title when a review and product have different IDs", () => {
    const products: ProductFixture[] = [
      { recordId: "row-1", itemId: "1001", title: "明星商品" },
    ];

    expect(matchManualProduct({ itemId: "9999", title: "明星商品" }, products)).toEqual({
      status: "not_matched",
    });
  });

  it("never falls back to a title-only product when the review has an item ID", () => {
    const products: ProductFixture[] = [
      { recordId: "row-1", itemId: null, title: "明星 商品" },
    ];

    expect(matchManualProduct({ itemId: "960227744800", title: "明星商品" }, products)).toEqual({
      status: "not_matched",
    });
  });

  it("uses a 12-digit item ID authoritatively even when the title changes", () => {
    const products: ProductFixture[] = [
      { recordId: "row-id", itemId: "960227744800", title: "旧标题" },
      { recordId: "row-other", itemId: "980913413146", title: "新标题" },
    ];

    expect(matchManualProduct({ itemId: "960227744800", title: "新标题" }, products)).toMatchObject({
      status: "matched",
      matchedBy: "item_id",
      product: { recordId: "row-id" },
    });
    expect(matchManualProduct({ itemId: "811060563195", title: "新标题" }, products)).toEqual({ status: "not_matched" });
    expect(matchManualProduct({ itemId: null, title: "新 标题" }, products)).toEqual({
      status: "identity_untrusted",
    });
  });
});

describe("stable manual-product identity", () => {
  it("requires a non-empty item ID for every new identity", () => {
    expect(resolveManualProductIdentity({ itemId: null, title: "仅旧标题" }, [])).toEqual({
      status: "invalid_input",
      reason: "missing_item_id",
    });
  });

  it("reuses only the same item ID and keeps an existing title when the new title is empty", () => {
    const existing: ProductFixture[] = [
      { recordId: "row-1", itemId: "1001", title: "原商品标题" },
      { recordId: "row-2", itemId: "1002", title: "相同展示标题" },
    ];

    expect(resolveManualProductIdentity({ itemId: " 1001 ", title: "" }, existing)).toMatchObject({
      status: "matched",
      matchedBy: "item_id",
      target: existing[0],
      patch: { itemId: "1001", title: "原商品标题" },
      mergeCandidates: [],
    });
    expect(resolveManualProductIdentity({ itemId: "1003", title: "相同展示标题" }, existing)).toMatchObject({
      status: "not_matched",
      patch: { itemId: "1003", title: "相同展示标题" },
    });
  });
});
