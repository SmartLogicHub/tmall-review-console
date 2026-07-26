import { describe, expect, it, vi } from "vitest";
import type { DeepSeekClientApi, SentimentDetermination } from "../deepseek/client";
import { openDatabase, runMigrations } from "../storage/database";
import { ManualProductRepository } from "../storage/manual-product-repository";
import { ReplyAttemptRepository, ReplyRepository } from "../storage/repositories";
import { ReviewActionGate } from "../submission/review-action-gate";
import type { TmallReviewSnapshot } from "../tmall/review-reader";
import { ManualProductPolicyService } from "./policy-service";

function review(overrides: Partial<TmallReviewSnapshot> = {}): TmallReviewSnapshot {
  return {
    sourceKey: "tmall:manual-policy",
    orderId: "1001",
    review: "还行",
    product: "新版商品标题",
    reviewedAt: "2026-07-15 10:00",
    sentimentLabel: "neutral",
    itemId: "960227744800",
    reviewPhase: "initial",
    ...overrides,
  };
}

function setup(
  determineSentiment = vi.fn<NonNullable<DeepSeekClientApi["determineSentiment"]>>(),
  reviewSentiment = vi.fn<NonNullable<DeepSeekClientApi["reviewSentiment"]>>(async () => ({
    sentiment: "positive",
    reason: "独立复核整体正面",
    confidence: 0.95,
  })),
  adjudicateSentiment = vi.fn<NonNullable<DeepSeekClientApi["adjudicateSentiment"]>>(async () => ({
    sentiment: "positive",
    reason: "最终裁决整体正面",
    confidence: 0.95,
  })),
) {
  const database = openDatabase(":memory:");
  runMigrations(database);
  const replies = new ReplyRepository(database);
  const products = new ManualProductRepository(database);
  const ai = { determineSentiment, reviewSentiment, adjudicateSentiment };
  const service = new ManualProductPolicyService({ products, replies, ai });
  return { database, replies, products, determineSentiment, reviewSentiment, adjudicateSentiment, service };
}

function addProduct(products: ManualProductRepository, itemId: string, title: string) {
  return products.upsert({ itemId, title }, "manual", products.revision()).product;
}

function discover(replies: ReplyRepository, snapshot: TmallReviewSnapshot) {
  return replies.discover(snapshot).id;
}

describe("ManualProductPolicyService", () => {
  it("continues the normal pipeline when the product is not in the frozen catalog", async () => {
    const { database, replies, determineSentiment, service } = setup();
    const id = discover(replies, review());

    await expect(service.evaluate(id)).resolves.toMatchObject({ action: "continue", catalogRevision: 1 });
    expect(determineSentiment).not.toHaveBeenCalled();
    expect(replies.get(id)).toMatchObject({
      state: "discovered",
      manualProductId: null,
      manualCatalogRevision: 1,
      manualMatchKind: "not_matched",
    });
    database.close();
  });

  it("matches by the stable 12-digit item ID despite a changed title and atomically holds a neutral review", async () => {
    const determineSentiment = vi.fn(async (): Promise<SentimentDetermination> => ({
      sentiment: "neutral",
      reason: "正文态度中性",
      confidence: 0.93,
    }));
    const { database, replies, products, service } = setup(determineSentiment);
    const product = addProduct(products, "960227744800", "旧版商品标题");
    const frozenRevision = products.revision();
    const id = discover(replies, review({ product: "完全不同的新标题", sentimentLabel: "neutral" }));

    await expect(service.evaluate(id)).resolves.toMatchObject({
      action: "manual_hold",
      matchedBy: "item_id",
      productId: product.id,
      sentiment: "neutral",
      catalogRevision: frozenRevision,
    });
    expect(determineSentiment).toHaveBeenCalledOnce();
    expect(replies.get(id)).toMatchObject({
      state: "manual_product_hold",
      manualProductId: product.id,
      manualCatalogRevision: frozenRevision,
      manualMatchKind: "item_id",
      finalReply: "",
    });
    expect(new ReviewActionGate(database).getLock("primary", review().sourceKey)).toMatchObject({ actionKind: "manual_hold" });
    expect(new ReplyAttemptRepository(database).list()).toHaveLength(0);
    database.close();
  });

  it("does not use a matching title when the review carries a different item ID", async () => {
    const { database, replies, products, service } = setup();
    addProduct(products, "980913413146", "同一标题");
    const id = discover(replies, review({ itemId: "960227744800", product: "同一标题", sentimentLabel: "negative" }));

    await expect(service.evaluate(id)).resolves.toMatchObject({ action: "continue" });
    expect(replies.get(id)?.state).toBe("discovered");
    database.close();
  });

  it("does not match by title when the review item ID is missing", async () => {
    const { database, replies, products, determineSentiment, service } = setup();
    addProduct(products, "960227744800", "相同标题");
    const id = discover(replies, review({ itemId: null, product: "相同标题", sentimentLabel: "positive" }));

    await expect(service.evaluate(id)).resolves.toMatchObject({ action: "continue", matchedBy: "not_matched", productId: null });
    expect(determineSentiment).not.toHaveBeenCalled();
    expect(replies.get(id)?.state).toBe("discovered");
    database.close();
  });


  it("ignores a positive page label when content analysis proves a matched review is negative", async () => {
    const determineSentiment = vi.fn(async (): Promise<SentimentDetermination> => ({
      sentiment: "negative",
      reason: "正文明确描述持续断连",
      confidence: 0.97,
    }));
    const { database, replies, products, service } = setup(determineSentiment);
    addProduct(products, "960227744800", "商品标题");
    const id = discover(replies, review({
      sentimentLabel: "positive",
      review: "用了两天一直断连，完全无法正常使用",
    }));

    await expect(service.evaluate(id)).resolves.toMatchObject({
      action: "manual_hold",
      sentiment: "negative",
      matchedBy: "item_id",
    });
    expect(determineSentiment).toHaveBeenCalledOnce();
    expect(replies.get(id)?.state).toBe("manual_product_hold");
    database.close();
  });

  it("ignores a negative page label when content analysis proves a matched review is positive", async () => {
    const determineSentiment = vi.fn(async (): Promise<SentimentDetermination> => ({
      sentiment: "positive",
      reason: "正文明确表达满意",
      confidence: 0.97,
    }));
    const { database, replies, products, service } = setup(determineSentiment);
    const product = addProduct(products, "960227744800", "商品标题");
    const frozenRevision = products.revision();
    const id = discover(replies, review({
      sentimentLabel: "negative",
      review: "音质很好，佩戴舒服，整体非常满意",
    }));

    await expect(service.evaluate(id)).resolves.toMatchObject({ action: "continue", sentiment: "positive", matchedBy: "item_id" });
    expect(determineSentiment).toHaveBeenCalledOnce();
    expect(replies.get(id)).toMatchObject({
      state: "discovered",
      manualProductId: product.id,
      manualCatalogRevision: frozenRevision,
      manualMatchKind: "item_id",
    });
    database.close();
  });

  it("uses only sentiment determination for an unknown matched review and continues only when it is positive", async () => {
    const determineSentiment = vi.fn(async (): Promise<SentimentDetermination> => ({
      sentiment: "positive",
      reason: "没有具体问题，整体偏正面",
      confidence: 0.82,
    }));
    const { database, replies, products, service } = setup(determineSentiment);
    addProduct(products, "960227744800", "商品标题");
    const id = discover(replies, review({ sentimentLabel: "unknown", review: "还行" }));

    await expect(service.evaluate(id)).resolves.toMatchObject({ action: "continue", sentiment: "positive", matchedBy: "item_id" });
    expect(determineSentiment).toHaveBeenCalledWith({ review: "还行", product: "新版商品标题", reviewPhase: "initial" });
    expect(replies.get(id)).toMatchObject({
      state: "discovered",
      manualProductId: expect.any(String),
      manualCatalogRevision: products.revision(),
      manualMatchKind: "item_id",
    });
    database.close();
  });

  it("uses independent review and final adjudication before continuing a risky unknown positive", async () => {
    const determineSentiment = vi.fn(async (): Promise<SentimentDetermination> => ({
      sentiment: "positive",
      reason: "整体偏正面",
      confidence: 0.82,
    }));
    const reviewSentiment = vi.fn(async (): Promise<SentimentDetermination> => ({
      sentiment: "negative",
      reason: "转折措辞可能包含当前问题",
      confidence: 0.88,
    }));
    const adjudicateSentiment = vi.fn(async () => ({
      sentiment: "negative" as const,
      reason: "存在当前未解决问题",
      confidence: 0.94,
    }));
    const { database, replies, products, service } = setup(determineSentiment, reviewSentiment, adjudicateSentiment);
    addProduct(products, "960227744800", "商品标题");
    const id = discover(replies, review({ sentimentLabel: "unknown", review: "外观还行，但是每天都会断连" }));

    await expect(service.evaluate(id)).resolves.toMatchObject({ action: "manual_hold", sentiment: "negative" });
    expect(determineSentiment).toHaveBeenCalledOnce();
    expect(reviewSentiment).toHaveBeenCalledOnce();
    expect(adjudicateSentiment).toHaveBeenCalledOnce();
    expect(replies.get(id)?.state).toBe("manual_product_hold");
    database.close();
  });

  it("persists the frozen continue decision when the catalog changes during sentiment AI", async () => {
    let products!: ManualProductRepository;
    const determineSentiment = vi.fn(async (): Promise<SentimentDetermination> => {
      addProduct(products, "980913413146", "后加入的商品");
      return { sentiment: "positive", reason: "整体偏正面", confidence: 0.9 };
    });
    const initialized = setup(determineSentiment);
    products = initialized.products;
    const firstProduct = addProduct(products, "960227744800", "原商品");
    const frozenRevision = products.revision();
    const firstId = discover(initialized.replies, review({ sentimentLabel: "unknown" }));

    await initialized.service.evaluate(firstId);
    expect(initialized.replies.get(firstId)).toMatchObject({
      state: "discovered",
      manualProductId: firstProduct.id,
      manualCatalogRevision: frozenRevision,
      manualMatchKind: "item_id",
    });

    const secondId = discover(initialized.replies, review({
      sourceKey: "tmall:positive-next-review",
      itemId: "980913413146",
      product: "后加入的商品",
      sentimentLabel: "positive",
    }));
    await initialized.service.evaluate(secondId);
    expect(initialized.replies.get(secondId)).toMatchObject({
      state: "discovered",
      manualCatalogRevision: frozenRevision + 1,
      manualMatchKind: "item_id",
    });
    initialized.database.close();
  });

  it.each(["neutral", "negative"] as const)("holds an unknown matched review when AI determines %s", async (sentiment) => {
    const determineSentiment = vi.fn(async (): Promise<SentimentDetermination> => ({
      sentiment,
      reason: sentiment === "neutral" ? "整体中性" : "存在当前问题",
      confidence: 0.88,
    }));
    const { database, replies, products, service } = setup(determineSentiment);
    addProduct(products, "960227744800", "商品标题");
    const id = discover(replies, review({ sourceKey: `tmall:${sentiment}`, sentimentLabel: "unknown" }));

    await expect(service.evaluate(id)).resolves.toMatchObject({ action: "manual_hold", sentiment });
    expect(replies.get(id)?.state).toBe("manual_product_hold");
    database.close();
  });

  it("propagates sentiment technical failures without converting them to a manual hold", async () => {
    const determineSentiment = vi.fn(async () => { throw new Error("service unavailable"); });
    const { database, replies, products, service } = setup(determineSentiment);
    addProduct(products, "960227744800", "商品标题");
    const id = discover(replies, review({ sentimentLabel: "unknown" }));

    await expect(service.evaluate(id)).rejects.toThrow("service unavailable");
    expect(replies.get(id)).toMatchObject({ state: "discovered", manualHoldReason: null });
    database.close();
  });

  it("does not match a title-only identity even when multiple titles are equal", async () => {
    const { database, replies, products, determineSentiment, service } = setup();
    addProduct(products, "960227744800", "相同标题");
    addProduct(products, "980913413146", "相同标题");
    const id = discover(replies, review({ itemId: null, product: "相 同 标题", sentimentLabel: "positive" }));

    await expect(service.evaluate(id)).resolves.toMatchObject({ action: "continue", matchedBy: "not_matched", productId: null });
    expect(determineSentiment).not.toHaveBeenCalled();
    expect(replies.get(id)?.state).toBe("discovered");
    database.close();
  });

  it("continues an unrecognized identity when no imported item ID can match it", async () => {
    const { database, replies, determineSentiment, service } = setup();
    const id = discover(replies, review({ itemId: null, product: "商品名称未识别", sentimentLabel: "positive" }));

    await expect(service.evaluate(id)).resolves.toMatchObject({ action: "continue", matchedBy: "not_matched", productId: null });
    expect(determineSentiment).not.toHaveBeenCalled();
    database.close();
  });

  it("freezes one catalog snapshot so a mid-decision catalog change only affects the next review", async () => {
    let products!: ManualProductRepository;
    const determineSentiment = vi.fn(async (): Promise<SentimentDetermination> => {
      addProduct(products, "980913413146", "后加入的商品");
      return { sentiment: "negative", reason: "存在问题", confidence: 0.9 };
    });
    const initialized = setup(determineSentiment);
    products = initialized.products;
    addProduct(products, "960227744800", "原商品");
    const frozenRevision = products.revision();
    const firstId = discover(initialized.replies, review({ sentimentLabel: "unknown" }));

    await initialized.service.evaluate(firstId);
    expect(initialized.replies.get(firstId)).toMatchObject({ state: "manual_product_hold", manualCatalogRevision: frozenRevision });

    const secondId = discover(initialized.replies, review({
      sourceKey: "tmall:next-review",
      itemId: "980913413146",
      product: "后加入的商品",
      sentimentLabel: "negative",
    }));
    await expect(initialized.service.evaluate(secondId)).resolves.toMatchObject({ action: "manual_hold", catalogRevision: frozenRevision + 1 });
    initialized.database.close();
  });

  it("keeps the frozen manual decision when the matched product is deleted during AI and stores a null foreign key", async () => {
    let products!: ManualProductRepository;
    let matchedProductId = "";
    const determineSentiment = vi.fn(async (): Promise<SentimentDetermination> => {
      products.remove(matchedProductId, products.revision());
      return { sentiment: "negative", reason: "存在当前问题", confidence: 0.91 };
    });
    const initialized = setup(determineSentiment);
    products = initialized.products;
    matchedProductId = addProduct(products, "960227744800", "即将移出的商品").id;
    const frozenRevision = products.revision();
    const id = discover(initialized.replies, review({ sentimentLabel: "unknown" }));

    await expect(initialized.service.evaluate(id)).resolves.toMatchObject({
      action: "manual_hold",
      catalogRevision: frozenRevision,
      matchedBy: "item_id",
      productId: null,
      sentiment: "negative",
    });
    expect(initialized.replies.get(id)).toMatchObject({
      state: "manual_product_hold",
      manualProductId: null,
      manualCatalogRevision: frozenRevision,
      manualMatchKind: "item_id",
    });
    initialized.database.close();
  });

  it("keeps a positive frozen decision when the matched product is deleted during AI", async () => {
    let products!: ManualProductRepository;
    let matchedProductId = "";
    const determineSentiment = vi.fn(async (): Promise<SentimentDetermination> => {
      products.remove(matchedProductId, products.revision());
      return { sentiment: "positive", reason: "整体偏正面", confidence: 0.91 };
    });
    const initialized = setup(determineSentiment);
    products = initialized.products;
    matchedProductId = addProduct(products, "960227744800", "即将移出的商品").id;
    const frozenRevision = products.revision();
    const id = discover(initialized.replies, review({ sentimentLabel: "unknown" }));

    await expect(initialized.service.evaluate(id)).resolves.toMatchObject({
      action: "continue",
      catalogRevision: frozenRevision,
      matchedBy: "item_id",
      productId: null,
      sentiment: "positive",
    });
    expect(initialized.replies.get(id)).toMatchObject({
      state: "discovered",
      manualProductId: null,
      manualCatalogRevision: frozenRevision,
      manualMatchKind: "item_id",
    });
    initialized.database.close();
  });

  it("returns an existing manual hold idempotently without overwriting its frozen metadata", async () => {
    const determineSentiment = vi.fn(async (): Promise<SentimentDetermination> => ({
      sentiment: "negative",
      reason: "正文明确负面",
      confidence: 0.96,
    }));
    const { database, replies, products, service } = setup(determineSentiment);
    const product = addProduct(products, "960227744800", "商品标题");
    const id = discover(replies, review({ sentimentLabel: "negative" }));
    const first = await service.evaluate(id);
    const persisted = replies.get(id)!;
    products.upsert({ itemId: "980913413146", title: "新名单商品" }, "manual", products.revision());

    const replay = await service.evaluate(id);

    expect(replay).toMatchObject({
      action: "manual_hold",
      catalogRevision: first.catalogRevision,
      matchedBy: "item_id",
      productId: product.id,
    });
    expect(replies.get(id)).toMatchObject({
      manualProductId: persisted.manualProductId,
      manualCatalogRevision: persisted.manualCatalogRevision,
      manualMatchKind: persisted.manualMatchKind,
      manualHoldReason: persisted.manualHoldReason,
      updatedAt: persisted.updatedAt,
    });
    database.close();
  });
});
