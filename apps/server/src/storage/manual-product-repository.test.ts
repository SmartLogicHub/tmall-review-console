import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "./database";
import { ManualProductConflictError, ManualProductRepository } from "./manual-product-repository";
import { ReplyAttemptRepository, ReplyRepository } from "./repositories";
import { ReviewActionGate } from "../submission/review-action-gate";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function createRepository() {
  const database = openDatabase(":memory:");
  runMigrations(database);
  return { database, repository: new ManualProductRepository(database) };
}

describe("ManualProductRepository", () => {
  it("requires an item ID, keys records only by ID, and never clears a known title with an empty update", () => {
    const { database, repository } = createRepository();

    expect(() => repository.upsert({ itemId: null, title: "仅标题" }, "manual", 1))
      .toThrowError(/商品 ID/);
    const created = repository.upsert({ itemId: " 960227744800 ", title: "原标题" }, "manual", 1);
    const updated = repository.upsert({ itemId: "960227744800", title: "" }, "excel", 2);
    const sameTitleDifferentId = repository.upsert({ itemId: "980913413146", title: "原标题" }, "manual", 3);

    expect(updated).toMatchObject({
      outcome: "reused",
      product: { id: created.product.id, itemId: "960227744800", title: "原标题", sources: ["manual", "excel"] },
    });
    expect(sameTitleDifferentId.product.id).not.toBe(created.product.id);
    expect(repository.stats().total).toBe(2);
    database.close();
  });

  it("keeps the private no-title storage marker out of records and search results", () => {
    const { database, repository } = createRepository();
    const created = repository.upsert({ itemId: "id-only-product", title: "" }, "manual", 1);

    expect(created.product).toMatchObject({ itemId: "id-only-product", title: "", normalizedTitle: "" });
    expect(repository.get(created.product.id)).toMatchObject({ title: "", normalizedTitle: "" });
    expect(repository.list().items).toEqual([expect.objectContaining({ title: "", normalizedTitle: "" })]);
    expect(repository.list({ query: "TMALL_REVIEW_CONSOLE_MISSING_PRODUCT_TITLE" })).toMatchObject({ total: 0, items: [] });

    const titled = repository.upsert({ itemId: "id-only-product", title: "当前商品标题" }, "manual", 2);
    expect(titled.product).toMatchObject({ itemId: "id-only-product", title: "当前商品标题" });
    database.close();
  });

  it("loads revision, products and memberships in one catalog snapshot", () => {
    const { database, repository } = createRepository();
    const manual = repository.upsert({ itemId: "1001", title: "人工商品" }, "manual", 1).product;
    repository.upsert({ itemId: "1001", title: "人工商品" }, "excel", 2);
    const excel = repository.upsert({ itemId: "1002", title: "Excel 商品" }, "excel", 3).product;

    const snapshot = repository.catalogSnapshot();
    expect(snapshot).toMatchObject({ catalogRevision: 4, lastImportAt: null });
    expect(snapshot.products).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: manual.id, sources: ["manual", "excel"] }),
      expect.objectContaining({ id: excel.id, sources: ["excel"] }),
    ]));
    database.close();
  });

  it("creates and reuses the same item ID while preserving memberships", () => {
    const { database, repository } = createRepository();
    const created = repository.upsert({ itemId: "1001", title: "漫步者 X1 EVO" }, "manual", 1);
    expect(created).toMatchObject({ outcome: "created", catalogRevision: 2, product: { itemId: "1001", sources: ["manual"] } });

    const reused = repository.upsert({ itemId: "1001", title: "漫步者 X1 EVO" }, "excel", 2);
    expect(reused).toMatchObject({ outcome: "reused", catalogRevision: 3, product: { id: created.product.id, itemId: "1001", sources: ["manual", "excel"] } });

    const updated = repository.upsert({ itemId: "1001", title: "漫步者 X1 EVO 新款" }, "manual", 3);
    expect(updated).toMatchObject({ outcome: "reused", catalogRevision: 4, product: { id: created.product.id, title: "漫步者 X1 EVO 新款" } });
    expect(repository.stats()).toEqual({ total: 1, manualSourceCount: 1, excelSourceCount: 1, lastImportAt: null });
    database.close();
  });

  it("keeps different item ids with the same title and rejects an id-less ambiguous input", () => {
    const { database, repository } = createRepository();
    repository.upsert({ itemId: "1", title: "同名商品" }, "manual", 1);
    repository.upsert({ itemId: "2", title: "同名商品" }, "manual", 2);
    database.prepare("UPDATE manual_products SET updated_at = '2026-07-15T00:00:00.000Z'").run();

    expect(() => repository.upsert({ title: "同名商品" }, "excel", 3)).toThrowError(ManualProductConflictError);
    expect(repository.list({ query: "同名", page: 1, pageSize: 1 })).toMatchObject({
      catalogRevision: 3,
      total: 2,
      page: 1,
      pageSize: 1,
      items: [{ itemId: "1" }],
    });
    database.close();
  });

  it("lists newest updates first with stable pagination when timestamps are identical", () => {
    const { database, repository } = createRepository();
    const alpha = repository.upsert({ itemId: "2", title: "Alpha" }, "manual", 1).product;
    const beta = repository.upsert({ itemId: "1", title: "Beta" }, "manual", 2).product;
    const gamma = repository.upsert({ itemId: "3", title: "Gamma" }, "manual", 3).product;
    database.prepare("UPDATE manual_products SET updated_at = '2026-07-15T00:00:00.000Z' WHERE id IN (?, ?)")
      .run(alpha.id, beta.id);
    database.prepare("UPDATE manual_products SET updated_at = '2026-07-14T00:00:00.000Z' WHERE id = ?")
      .run(gamma.id);

    for (let pass = 0; pass < 12; pass += 1) {
      const first = repository.list({ page: 1, pageSize: 2 });
      const second = repository.list({ page: 2, pageSize: 2 });
      expect(first.items.map((item) => item.id)).toEqual([alpha.id, beta.id]);
      expect(second.items.map((item) => item.id)).toEqual([gamma.id]);
      expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
      expect(first.catalogRevision).toBe(second.catalogRevision);
    }

    database.prepare("UPDATE manual_products SET updated_at = '2026-07-16T00:00:00.000Z' WHERE id = ?")
      .run(gamma.id);
    expect(repository.list({ page: 1, pageSize: 3 }).items.map((item) => item.id))
      .toEqual([gamma.id, alpha.id, beta.id]);
    database.close();
  });

  it("uses catalog revision CAS for removal and removes every source on explicit removal", () => {
    const { database, repository } = createRepository();
    const result = repository.upsert({ itemId: "1", title: "商品" }, "manual", 1);
    repository.upsert({ itemId: "1", title: "商品" }, "excel", 2);

    expect(() => repository.remove(result.product.id, 2)).toThrowError(/名单已发生变化/);
    expect(repository.remove(result.product.id, 3)).toMatchObject({ removed: true, catalogRevision: 4 });
    expect(repository.stats().total).toBe(0);
    database.close();
  });

  it("replaces only Excel membership and preserves manual membership", () => {
    const { database, repository } = createRepository();
    const both = repository.upsert({ itemId: "1", title: "双来源" }, "manual", 1);
    repository.upsert({ itemId: "1", title: "双来源" }, "excel", 2);
    repository.upsert({ itemId: "2", title: "仅 Excel" }, "excel", 3);

    const replaced = repository.replaceExcel([{ itemId: "3", title: "新 Excel" }], 4, new Date("2026-07-15T00:00:00.000Z"));
    expect(replaced).toMatchObject({ catalogRevision: 5, added: 1, removed: 2 });
    expect(repository.get(both.product.id)).toMatchObject({ sources: ["manual"] });
    expect(repository.stats()).toEqual({
      total: 2,
      manualSourceCount: 1,
      excelSourceCount: 1,
      lastImportAt: "2026-07-15T00:00:00.000Z",
    });
    database.close();
  });

  it("preserves a historical title-only row without allowing a new ID to merge into it by title", () => {
    const { database, repository } = createRepository();
    database.prepare(`
      INSERT INTO manual_products(id, item_id, product_title, normalized_title, created_at, updated_at)
      VALUES ('legacy-title-only', NULL, '同一标题', '同一标题', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO manual_product_memberships(product_id, source, created_at)
      VALUES ('legacy-title-only', 'manual', '2026-07-15T00:00:00.000Z')
    `).run();

    const created = repository.upsert({ itemId: "1001", title: "同一标题" }, "manual", 1);
    expect(created).toMatchObject({ outcome: "created", product: { itemId: "1001", title: "同一标题" } });
    expect(created.product.id).not.toBe("legacy-title-only");
    expect(repository.get("legacy-title-only")).toMatchObject({ itemId: null, title: "同一标题" });
    database.close();
  });

  it("updates same-ID titles, keeps same-title IDs distinct and rolls back duplicate IDs during Excel replacement", () => {
    const { database, repository } = createRepository();
    const idEntity = repository.upsert({ itemId: "merge-1", title: "旧标题" }, "manual", 1).product;
    const second = repository.upsert({ itemId: "enriched-1", title: "补 ID 商品" }, "manual", 2).product;

    expect(repository.replaceExcel([
      { itemId: "merge-1", title: "合并标题" },
      { itemId: "enriched-1", title: "补 ID 商品" },
      { itemId: "same-title-1", title: "同名商品" },
      { itemId: "same-title-2", title: "同名商品" },
    ], 3, new Date("2026-07-15T00:00:00.000Z"))).toMatchObject({
      catalogRevision: 4,
      added: 4,
      removed: 0,
      retained: 0,
    });
    expect(repository.get(idEntity.id)).toMatchObject({ itemId: "merge-1", title: "合并标题", sources: ["manual", "excel"] });
    expect(repository.get(second.id)).toMatchObject({ itemId: "enriched-1", sources: ["manual", "excel"] });
    expect(repository.list({ query: "同名商品", pageSize: 10 }).items.map((item) => item.itemId).sort())
      .toEqual(["same-title-1", "same-title-2"]);

    const revisionBeforeDuplicate = repository.revision();
    const rowsBeforeDuplicate = database.prepare(`
      SELECT p.id, p.item_id, p.product_title, m.source
      FROM manual_products p
      LEFT JOIN manual_product_memberships m ON m.product_id = p.id
      ORDER BY p.id, m.source
    `).all();
    expect(() => repository.replaceExcel([
      { itemId: "duplicate-1", title: "重复商品" },
      { itemId: "duplicate-1", title: "重复商品新标题" },
    ], revisionBeforeDuplicate, new Date("2026-07-16T00:00:00.000Z"))).toThrowError(ManualProductConflictError);
    expect(repository.revision()).toBe(revisionBeforeDuplicate);
    expect(database.prepare(`
      SELECT p.id, p.item_id, p.product_title, m.source
      FROM manual_products p
      LEFT JOIN manual_product_memberships m ON m.product_id = p.id
      ORDER BY p.id, m.source
    `).all()).toEqual(rowsBeforeDuplicate);
    database.close();
  });

  it("replaces 5000 Excel products within the bounded import budget", () => {
    const { database, repository } = createRepository();
    const identities = Array.from({ length: 5_000 }, (_, index) => ({
      itemId: `scale-${index}`,
      title: `规模商品 ${index}`,
    }));

    const startedAt = performance.now();
    const result = repository.replaceExcel(identities, 1, new Date("2026-07-15T00:00:00.000Z"));
    const elapsedMs = performance.now() - startedAt;

    expect(result).toMatchObject({ catalogRevision: 2, added: 5_000, removed: 0, retained: 0 });
    expect(repository.stats()).toMatchObject({ total: 5_000, excelSourceCount: 5_000 });
    expect(elapsedMs).toBeLessThan(15_000);
    database.close();
  }, 60_000);

  it("allows a safe failed audit to enter manual hold and releases that hold when the product leaves the list", () => {
    const { database, repository } = createRepository();
    const product = repository.upsert({ itemId: "failed-audit-item", title: "人工商品" }, "manual", 1).product;
    const replies = new ReplyRepository(database);
    const draft = replies.discover({
      sourceKey: "failed-audit-hold", orderId: null, review: "一般", product: "人工商品",
      reviewedAt: "2026-07-15 08:00", sentimentLabel: "negative",
      itemId: null, reviewPhase: "initial",
    });
    replies.complete(draft.id, {
      finalReply: "待提交草稿", productAdjusted: false, needsAttention: false, notes: "", attentionReasons: [],
    });
    const attempts = new ReplyAttemptRepository(database);
    const attempt = attempts.prepareWithReplyLock(draft.id, "failed-audit-hold").attempt;
    attempts.markFailed(attempt.id, "SAFE_PRE_CLICK", "确认未点击平台按钮");
    replies.markManualProductHold(draft.id, {
      storeId: "primary", manualProductId: product.id, catalogRevision: 2,
      matchKind: "item_id", reason: "人工商品中差评",
    });
    expect(replies.get(draft.id)?.processedAt).not.toBeNull();

    expect(repository.remove(product.id, 2)).toMatchObject({ removed: true, catalogRevision: 3 });
    expect(replies.get(draft.id)).toMatchObject({ state: "discovered", manualProductId: null, processedAt: null });
    expect(new ReviewActionGate(database).getLock("primary", "failed-audit-hold")).toBeNull();
    expect(attempts.get(attempt.id)).toMatchObject({ state: "failed", replyDraftId: draft.id });
    database.close();
  });

  it("serializes competing catalog writes across two connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "manual-product-concurrency-"));
    cleanup.push(directory);
    const path = join(directory, "console.sqlite");
    const firstDb = openDatabase(path);
    runMigrations(firstDb);
    const secondDb = openDatabase(path);
    runMigrations(secondDb);
    const first = new ManualProductRepository(firstDb);
    const second = new ManualProductRepository(secondDb);

    first.upsert({ itemId: "1", title: "A" }, "manual", 1);
    expect(() => second.upsert({ itemId: "2", title: "B" }, "manual", 1)).toThrowError(/名单已发生变化/);
    expect(second.list({ page: 1, pageSize: 20 }).total).toBe(1);
    firstDb.close();
    secondDb.close();
  });
});
