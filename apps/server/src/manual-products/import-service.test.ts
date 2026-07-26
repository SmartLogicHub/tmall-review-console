import { describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { ImportPreviewStore, ImportPreviewSupersededError } from "./import-preview-store";
import {
  ManualProductImportError,
  ManualProductImportService,
  type ManualProductImportPreviewPayload,
} from "./import-service";
import { openDatabase, runMigrations } from "../storage/database";
import { ManualProductRepository } from "../storage/manual-product-repository";
import { ReplyRepository } from "../storage/repositories";
import { ReviewActionGate } from "../submission/review-action-gate";
import type { ManualProductIdentity } from "@tmall/domain";

function fakeParser(rows: readonly ManualProductIdentity[]) {
  return vi.fn(async () => ({ rows: structuredClone(rows), worksheetName: "Sheet1" }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function createService(rows: readonly ManualProductIdentity[], now = new Date("2026-07-15T04:00:00.000Z")) {
  const database = openDatabase(":memory:");
  runMigrations(database);
  const repository = new ManualProductRepository(database);
  const previewStore = new ImportPreviewStore<ManualProductImportPreviewPayload>();
  const service = new ManualProductImportService({
    repository,
    previewStore,
    parseWorkbook: fakeParser(rows),
    now: () => now,
  });
  return { database, repository, previewStore, service };
}

function snapshotTables(database: ReturnType<typeof openDatabase>) {
  const tables = [
    "manual_product_catalog_state",
    "manual_products",
    "manual_product_memberships",
    "reply_drafts",
    "review_action_locks",
  ];
  return Object.fromEntries(tables.map((table) => [
    table,
    database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

function addHeldDraft(
  database: ReturnType<typeof openDatabase>,
  repository: ManualProductRepository,
  productId: string,
  sourceKey: string,
) {
  const replies = new ReplyRepository(database);
  const draft = replies.discover({
    sourceKey,
    orderId: null,
    review: "一般",
    product: "人工处理商品",
    reviewedAt: "2026-07-15 08:00",
    sentimentLabel: "negative",
    itemId: null,
    reviewPhase: "initial",
  });
  replies.markManualProductHold(draft.id, {
    storeId: "primary",
    manualProductId: productId,
    catalogRevision: repository.revision(),
    matchKind: "item_id",
    reason: "人工处理商品",
  });
  return { replies, draftId: draft.id };
}

describe("ManualProductImportService", () => {
  it("invalidates the previous token when a newer preview has identity conflicts", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new ManualProductRepository(database);
    repository.upsert({ itemId: "1", title: "同名商品" }, "manual", 1);
    repository.upsert({ itemId: "2", title: "同名商品" }, "manual", 2);
    const parseWorkbook = vi.fn()
      .mockResolvedValueOnce({ rows: [{ itemId: "new", title: "新商品" }], worksheetName: "Sheet1" })
      .mockResolvedValueOnce({ rows: [{ itemId: null, title: "同名商品" }], worksheetName: "Sheet1" });
    const service = new ManualProductImportService({
      repository,
      previewStore: new ImportPreviewStore<ManualProductImportPreviewPayload>(),
      parseWorkbook,
    });
    const valid = await service.preview({ sessionId: "session-a", filename: "valid.xlsx", buffer: Buffer.from("x") });

    await expect(service.preview({ sessionId: "session-a", filename: "conflict.xlsx", buffer: Buffer.from("y") }))
      .resolves.toMatchObject({ canApply: false, token: null });
    await expect(service.apply({ sessionId: "session-a", token: valid.token! })).rejects
      .toThrowError("预览已失效，请重新选择文件");
    expect(repository.revision()).toBe(3);
    database.close();
  });

  it("invalidates the previous token before a newer preview fails parsing", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new ManualProductRepository(database);
    const parseWorkbook = vi.fn()
      .mockResolvedValueOnce({ rows: [{ itemId: "1", title: "商品 A" }], worksheetName: "Sheet1" })
      .mockRejectedValueOnce(new Error("parse failed"));
    const service = new ManualProductImportService({
      repository,
      previewStore: new ImportPreviewStore<ManualProductImportPreviewPayload>(),
      parseWorkbook,
    });
    const valid = await service.preview({ sessionId: "session-a", filename: "valid.xlsx", buffer: Buffer.from("x") });

    await expect(service.preview({ sessionId: "session-a", filename: "broken.xlsx", buffer: Buffer.from("y") }))
      .rejects.toMatchObject({ code: "PREVIEW_FAILED" });
    await expect(service.apply({ sessionId: "session-a", token: valid.token! })).rejects
      .toThrowError("预览已失效，请重新选择文件");
    expect(repository.revision()).toBe(1);
    database.close();
  });

  it("cleans active attempt markers after 5000 unique failed previews", async () => {
    const repository = {
      catalogSnapshot: vi.fn(() => ({ catalogRevision: 1, lastImportAt: null, products: [] })),
      replaceExcel: vi.fn(),
    };
    const store = new ImportPreviewStore<ManualProductImportPreviewPayload>();
    const service = new ManualProductImportService({
      repository,
      previewStore: store,
      parseWorkbook: vi.fn(async () => { throw new Error("invalid workbook"); }),
    });

    for (let index = 0; index < 5_000; index += 1) {
      await expect(service.preview({
        sessionId: `failed-${index}`,
        filename: "broken.xlsx",
        buffer: Buffer.from("x"),
      })).rejects.toMatchObject({ code: "PREVIEW_FAILED" });
    }

    expect((Reflect.get(store, "currentAttemptBySession") as Map<string, unknown>).size).toBe(0);
    expect((Reflect.get(store, "activeAttemptIds") as Set<string>).size).toBe(0);
    expect((Reflect.get(store, "entries") as Map<string, unknown>).size).toBe(0);
    expect(repository.catalogSnapshot).not.toHaveBeenCalled();
  }, 30_000);

  it("prevents an older slow preview from issuing after a newer preview fails", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const olderResult = deferred<{ rows: ManualProductIdentity[]; worksheetName: string }>();
    const parseWorkbook = vi.fn((_: Buffer, filename: string) => filename === "older.xlsx"
      ? olderResult.promise
      : Promise.reject(new Error("newer failed")));
    const store = new ImportPreviewStore<ManualProductImportPreviewPayload>();
    const service = new ManualProductImportService({
      repository: new ManualProductRepository(database), previewStore: store, parseWorkbook,
    });
    const older = service.preview({ sessionId: "session-a", filename: "older.xlsx", buffer: Buffer.from("x") });
    const newer = service.preview({ sessionId: "session-a", filename: "newer.xlsx", buffer: Buffer.from("y") });
    await expect(newer).rejects.toMatchObject({ code: "PREVIEW_FAILED" });
    olderResult.resolve({ rows: [{ itemId: "1", title: "旧商品" }], worksheetName: "Sheet1" });

    await expect(older).rejects.toBeInstanceOf(ImportPreviewSupersededError);
    expect((Reflect.get(store, "entries") as Map<string, unknown>).size).toBe(0);
    database.close();
  });

  it("keeps the newer token when two previews complete in reverse order", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new ManualProductRepository(database);
    const olderResult = deferred<{ rows: ManualProductIdentity[]; worksheetName: string }>();
    const parseWorkbook = vi.fn((_: Buffer, filename: string) => filename === "older.xlsx"
      ? olderResult.promise
      : Promise.resolve({ rows: [{ itemId: "2", title: "新商品" }], worksheetName: "Sheet1" }));
    const service = new ManualProductImportService({
      repository,
      previewStore: new ImportPreviewStore<ManualProductImportPreviewPayload>(),
      parseWorkbook,
    });
    const older = service.preview({ sessionId: "session-a", filename: "older.xlsx", buffer: Buffer.from("x") });
    const newer = await service.preview({ sessionId: "session-a", filename: "newer.xlsx", buffer: Buffer.from("y") });
    olderResult.resolve({ rows: [{ itemId: "1", title: "旧商品" }], worksheetName: "Sheet1" });

    await expect(older).rejects.toBeInstanceOf(ImportPreviewSupersededError);
    await expect(service.apply({ sessionId: "session-a", token: newer.token! })).resolves
      .toMatchObject({ catalogRevision: 2, added: 1 });
    expect(repository.list({ pageSize: 10 }).items).toEqual([
      expect.objectContaining({ itemId: "2", title: "新商品" }),
    ]);
    database.close();
  });

  it("stores a frozen normalized row set and complete preview diff with session and expiry metadata", async () => {
    const { database, previewStore, service } = createService([{ itemId: " 1 ", title: " 商品 A " }]);
    const preview = await service.preview({
      sessionId: "session-a", filename: "名单.xlsx", buffer: Buffer.from("x"),
    });
    const stored = [...(Reflect.get(previewStore, "entries") as Map<string, {
      sessionId: string;
      expiresAt: number;
      payload: ManualProductImportPreviewPayload;
    }>).values()][0]!;

    expect(stored.sessionId).toBe("session-a");
    expect(stored.expiresAt).toEqual(expect.any(Number));
    expect(stored.payload).toEqual({
      catalogRevision: 1,
      rows: [{ itemId: "1", title: "商品 A" }],
      diff: { summary: preview.summary, samples: preview.samples },
    });
    expect(Object.isFrozen(stored.payload)).toBe(true);
    expect(Object.isFrozen(stored.payload.rows)).toBe(true);
    expect(Object.isFrozen(stored.payload.diff)).toBe(true);
    expect((Reflect.get(previewStore, "currentAttemptBySession") as Map<string, unknown>).size).toBe(0);
    database.close();
  });

  it("sanitizes unknown parser errors even when they expose a code property", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const parserError = Object.assign(new Error("secret path C:\\private\\raw.xlsx"), { code: "EIO" });
    const service = new ManualProductImportService({
      repository: new ManualProductRepository(database),
      previewStore: new ImportPreviewStore<ManualProductImportPreviewPayload>(),
      parseWorkbook: vi.fn(async () => { throw parserError; }),
    });

    await expect(service.preview({ sessionId: "session-a", filename: "名单.xlsx", buffer: Buffer.from("x") }))
      .rejects.toMatchObject({
        code: "PREVIEW_FAILED",
        message: "无法预览该名单，请重新选择文件",
      });
    database.close();
  });

  it("previews additions, retained matches and removals against one frozen catalog revision", async () => {
    const { database, repository, service } = createService([
      { itemId: "1001", title: "人工商品" },
      { itemId: "1002", title: "保留 Excel 商品" },
      { itemId: "1004", title: "新增商品" },
    ]);
    repository.upsert({ itemId: "1001", title: "人工商品" }, "manual", 1);
    repository.upsert({ itemId: "1002", title: "保留 Excel 商品" }, "excel", 2);
    const removed = repository.upsert({ itemId: "1003", title: "移除 Excel 商品" }, "excel", 3).product;

    const preview = await service.preview({
      sessionId: "session-a",
      filename: "名单.xlsx",
      buffer: Buffer.from("workbook bytes"),
    });

    expect(preview).toMatchObject({
      canApply: true,
      catalogRevision: 4,
      summary: { added: 2, retained: 1, removed: 1, conflicts: 0 },
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      samples: {
        added: [
          { itemId: "1001", title: "人工商品" },
          { itemId: "1004", title: "新增商品" },
        ],
        removed: [{ id: removed.id, itemId: "1003", title: "移除 Excel 商品" }],
      },
    });
    database.close();
  });

  it("matches replaceExcel membership counts when a retained item ID has a changed title", async () => {
    const { database, repository, service } = createService([{ itemId: "id-1", title: "New" }]);
    const target = repository.upsert({ itemId: "id-1", title: "Old" }, "manual", 1).product;
    repository.upsert({ itemId: "id-1", title: "Old" }, "excel", 2);

    const preview = await service.preview({ sessionId: "session-a", filename: "名单.xlsx", buffer: Buffer.from("x") });
    expect(preview.summary).toEqual({ added: 0, retained: 1, removed: 0, conflicts: 0 });
    expect(preview.samples).toMatchObject({
      retained: [{ itemId: "id-1", title: "New" }],
    });

    const applied = await service.apply({ sessionId: "session-a", token: preview.token! });
    expect(applied).toEqual({ catalogRevision: 4, added: 0, retained: 1, removed: 0 });
    expect(repository.get(target.id)).toMatchObject({ itemId: "id-1", title: "New", sources: ["manual", "excel"] });
    database.close();
  });

  it("keeps preview and apply counts aligned across repeated same-ID title updates", async () => {
    const rows = [
      { itemId: "id-a", title: "New A" },
      { itemId: "id-b", title: "New B" },
    ];
    const { database, repository, service } = createService(rows);
    repository.upsert({ itemId: "id-a", title: "Old A" }, "manual", 1);
    repository.upsert({ itemId: "id-a", title: "Old A" }, "excel", 2);
    repository.upsert({ itemId: "id-b", title: "Old B" }, "manual", 3);
    repository.upsert({ itemId: "id-b", title: "Old B" }, "excel", 4);

    const firstPreview = await service.preview({ sessionId: "session-a", filename: "名单.xlsx", buffer: Buffer.from("x") });
    expect(firstPreview.summary).toEqual({ added: 0, retained: 2, removed: 0, conflicts: 0 });
    await expect(service.apply({ sessionId: "session-a", token: firstPreview.token! })).resolves.toMatchObject({
      added: 0, retained: 2, removed: 0,
    });

    const secondPreview = await service.preview({ sessionId: "session-a", filename: "名单.xlsx", buffer: Buffer.from("x") });
    expect(secondPreview.summary).toEqual({ added: 0, retained: 2, removed: 0, conflicts: 0 });
    await expect(service.apply({ sessionId: "session-a", token: secondPreview.token! })).resolves.toMatchObject({
      added: 0, retained: 2, removed: 0,
    });
    database.close();
  });

  it("previews 5000 new and 5000 retained identities within the indexed budget", async () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => ({
      itemId: `scale-${index}`,
      title: `规模商品 ${index}`,
    }));

    const emptyDatabase = openDatabase(":memory:");
    runMigrations(emptyDatabase);
    const emptyStore = new ImportPreviewStore<ManualProductImportPreviewPayload>();
    const emptyService = new ManualProductImportService({
      repository: new ManualProductRepository(emptyDatabase),
      previewStore: emptyStore,
      parseWorkbook: fakeParser(rows),
    });
    const emptyStartedAt = performance.now();
    const addedPreview = await emptyService.preview({
      sessionId: "empty", filename: "名单.xlsx", buffer: Buffer.from("x"),
    });
    const emptyElapsedMs = performance.now() - emptyStartedAt;
    expect(addedPreview.summary).toEqual({ added: 5_000, retained: 0, removed: 0, conflicts: 0 });
    expect(emptyElapsedMs).toBeLessThan(3_000);
    emptyStore.dispose();
    emptyDatabase.close();

    const existingDatabase = openDatabase(":memory:");
    runMigrations(existingDatabase);
    const existingRepository = new ManualProductRepository(existingDatabase);
    existingRepository.replaceExcel(rows, 1, new Date("2026-07-15T00:00:00.000Z"));
    const existingStore = new ImportPreviewStore<ManualProductImportPreviewPayload>();
    const existingService = new ManualProductImportService({
      repository: existingRepository,
      previewStore: existingStore,
      parseWorkbook: fakeParser(rows),
    });
    const existingStartedAt = performance.now();
    const retainedPreview = await existingService.preview({
      sessionId: "existing", filename: "名单.xlsx", buffer: Buffer.from("x"),
    });
    const existingElapsedMs = performance.now() - existingStartedAt;
    expect(retainedPreview.summary).toEqual({ added: 0, retained: 5_000, removed: 0, conflicts: 0 });
    expect(existingElapsedMs).toBeLessThan(3_000);
    existingStore.dispose();
    existingDatabase.close();
  }, 60_000);

  it("does not issue an apply token when catalog identities are ambiguous", async () => {
    const { database, repository, previewStore, service } = createService([{ title: "同名商品" }]);
    repository.upsert({ itemId: "1", title: "同名商品" }, "manual", 1);
    repository.upsert({ itemId: "2", title: "同名商品" }, "manual", 2);

    const preview = await service.preview({
      sessionId: "session-a", filename: "名单.xlsx", buffer: Buffer.from("x"),
    });
    expect(preview).toMatchObject({ canApply: false, token: null, summary: { conflicts: 1 } });
    expect((Reflect.get(previewStore, "entries") as Map<string, unknown>).size).toBe(0);
    database.close();
  });

  it("consumes the token before CAS apply and never retries a changed catalog", async () => {
    const { database, repository, service } = createService([{ itemId: "1", title: "商品 A" }]);
    const preview = await service.preview({
      sessionId: "session-a", filename: "名单.xlsx", buffer: Buffer.from("x"),
    });
    repository.upsert({ itemId: "other", title: "并发变更" }, "manual", 1);

    await expect(service.apply({ sessionId: "session-a", token: preview.token! })).rejects.toMatchObject({
      code: "CATALOG_CHANGED",
      message: "名单已发生变化，请重新选择文件",
    });
    await expect(service.apply({ sessionId: "session-a", token: preview.token! })).rejects
      .toThrowError("预览已失效，请重新选择文件");
    database.close();
  });

  it("stores parsed rows independently of the uploaded Buffer and never stores the filename", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new ManualProductRepository(database);
    const store = new ImportPreviewStore<ManualProductImportPreviewPayload>();
    const parseWorkbook = vi.fn(async (buffer: Buffer) => ({
      rows: [{ itemId: "1", title: buffer.toString("utf8") }],
      worksheetName: "Sheet1",
    }));
    const service = new ManualProductImportService({ repository, previewStore: store, parseWorkbook });
    const buffer = Buffer.from("不可变商品");
    const preview = await service.preview({ sessionId: "session-a", filename: "secret-name.xlsx", buffer });
    buffer.fill(0);

    await service.apply({ sessionId: "session-a", token: preview.token! });
    expect(repository.list({ pageSize: 10 }).items).toEqual([
      expect.objectContaining({ itemId: "1", title: "不可变商品", sources: ["excel"] }),
    ]);
    expect(JSON.stringify(repository.catalogSnapshot())).not.toContain("secret-name.xlsx");
    expect(JSON.stringify([...((Reflect.get(store, "entries") as Map<string, unknown>).values())])).not.toContain("secret-name.xlsx");
    database.close();
  });

  it("allows at most one concurrent apply to enter the repository", async () => {
    const repository = {
      catalogSnapshot: vi.fn(() => ({ catalogRevision: 1, lastImportAt: null, products: [] })),
      replaceExcel: vi.fn(() => ({ catalogRevision: 2, added: 1, retained: 0, removed: 0 })),
    };
    const service = new ManualProductImportService({
      repository,
      previewStore: new ImportPreviewStore<ManualProductImportPreviewPayload>(),
      parseWorkbook: fakeParser([{ itemId: "1", title: "商品 A" }]),
    });
    const preview = await service.preview({ sessionId: "session-a", filename: "名单.xlsx", buffer: Buffer.from("x") });

    const results = await Promise.allSettled([
      service.apply({ sessionId: "session-a", token: preview.token! }),
      service.apply({ sessionId: "session-a", token: preview.token! }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(repository.replaceExcel).toHaveBeenCalledTimes(1);
  });

  it("rolls back products, memberships, holds, locks and catalog state when the final state update fails", async () => {
    const { database, repository, service } = createService([{ itemId: "new", title: "新商品" }]);
    const old = repository.upsert({ itemId: "old", title: "旧商品" }, "excel", 1).product;
    addHeldDraft(database, repository, old.id, "rollback-hold");
    const before = snapshotTables(database);
    const preview = await service.preview({ sessionId: "session-a", filename: "名单.xlsx", buffer: Buffer.from("x") });
    database.exec(`
      CREATE TRIGGER fail_manual_catalog_state_update
      BEFORE UPDATE ON manual_product_catalog_state
      BEGIN
        SELECT RAISE(ABORT, 'storage failure');
      END;
    `);

    let failure: unknown;
    try {
      await service.apply({ sessionId: "session-a", token: preview.token! });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ManualProductImportError);
    expect(failure).toMatchObject({ code: "APPLY_FAILED", message: "名单更新失败，请重新选择文件" });
    expect((failure as Error).message).not.toContain("storage failure");
    expect(snapshotTables(database)).toEqual(before);
    await expect(service.apply({ sessionId: "session-a", token: preview.token! })).rejects
      .toThrowError("预览已失效，请重新选择文件");
    database.close();
  });

  it("preserves a hold when an Excel membership is removed from a dual-source product", async () => {
    const { database, repository, service } = createService([]);
    const product = repository.upsert({ itemId: "both", title: "双来源商品" }, "manual", 1).product;
    repository.upsert({ itemId: "both", title: "双来源商品" }, "excel", 2);
    const { replies, draftId } = addHeldDraft(database, repository, product.id, "dual-source-hold");
    const preview = await service.preview({ sessionId: "session-a", filename: "名单.xlsx", buffer: Buffer.from("x") });

    await service.apply({ sessionId: "session-a", token: preview.token! });
    expect(repository.get(product.id)).toMatchObject({ sources: ["manual"] });
    expect(replies.get(draftId)).toMatchObject({ state: "manual_product_hold", manualProductId: product.id });
    expect(new ReviewActionGate(database).getLock("primary", "dual-source-hold")).toMatchObject({ actionKind: "manual_hold" });
    database.close();
  });

  it("atomically clears Excel-only products, releases eligible holds and records the apply time once", async () => {
    const appliedAt = new Date("2026-07-15T05:06:07.000Z");
    const { database, repository, service } = createService([], appliedAt);
    const product = repository.upsert({ itemId: "excel-only", title: "仅 Excel 商品" }, "excel", 1).product;
    const { replies, draftId } = addHeldDraft(database, repository, product.id, "eligible-hold");
    const preview = await service.preview({ sessionId: "session-a", filename: "名单.xlsx", buffer: Buffer.from("x") });

    const applied = await service.apply({ sessionId: "session-a", token: preview.token! });
    expect(applied).toEqual({ catalogRevision: 3, added: 0, retained: 0, removed: 1 });
    expect(repository.stats()).toEqual({
      total: 0,
      manualSourceCount: 0,
      excelSourceCount: 0,
      lastImportAt: appliedAt.toISOString(),
    });
    expect(replies.get(draftId)).toMatchObject({ state: "discovered", manualProductId: null, processedAt: null });
    expect(new ReviewActionGate(database).getLock("primary", "eligible-hold")).toBeNull();
    database.close();
  });

  it("does not release protected holds with an active attempt or terminal tombstone", async () => {
    const { database, repository, service } = createService([]);
    const attemptProduct = repository.upsert({ itemId: "attempt", title: "尝试保护" }, "excel", 1).product;
    const tombstoneProduct = repository.upsert({ itemId: "tombstone", title: "终态保护" }, "excel", 2).product;
    const attemptDraft = addHeldDraft(database, repository, attemptProduct.id, "attempt-protected");
    const tombstoneDraft = addHeldDraft(database, repository, tombstoneProduct.id, "tombstone-protected");
    const now = "2026-07-15T04:00:00.000Z";
    database.prepare(`
      INSERT INTO reply_attempts(
        id, reply_draft_id, source_key, state, created_at, updated_at, action_lock_version
      ) VALUES (?, ?, ?, 'pending', ?, ?, 1)
    `).run("attempt-id", attemptDraft.draftId, "attempt-protected", now, now);
    database.prepare(`
      INSERT INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at)
      VALUES ('primary', 'tombstone-protected', 'reply_sent', ?)
    `).run(now);
    const preview = await service.preview({ sessionId: "session-a", filename: "名单.xlsx", buffer: Buffer.from("x") });

    await service.apply({ sessionId: "session-a", token: preview.token! });
    expect(attemptDraft.replies.get(attemptDraft.draftId)).toMatchObject({ state: "manual_product_hold", manualProductId: null });
    expect(tombstoneDraft.replies.get(tombstoneDraft.draftId)).toMatchObject({ state: "manual_product_hold", manualProductId: null });
    expect(new ReviewActionGate(database).getLock("primary", "attempt-protected")).not.toBeNull();
    expect(new ReviewActionGate(database).getLock("primary", "tombstone-protected")).not.toBeNull();
    database.close();
  });
});
