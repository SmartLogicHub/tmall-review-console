import { randomUUID } from "node:crypto";
import {
  normalizeManualProductTitle,
  resolveManualProductIdentity,
  type ManualProductIdentity,
} from "@tmall/domain";
import { ManualProductIdentityIndex } from "../manual-products/identity-index";
import { ReviewActionGate } from "../submission/review-action-gate";
import type { AppDatabase } from "./database";

export type ManualProductSource = "manual" | "excel";
export type ManualProductMutationOutcome = "created" | "reused" | "enriched" | "merged";
const MISSING_TITLE_SENTINEL = "__TMALL_REVIEW_CONSOLE_MISSING_PRODUCT_TITLE__";

export interface ManualProductRecord {
  id: string;
  itemId: string | null;
  title: string;
  normalizedTitle: string;
  sources: ManualProductSource[];
  createdAt: string;
  updatedAt: string;
  lastMatchedAt: string | null;
}

export interface ManualProductCatalogStats {
  total: number;
  manualSourceCount: number;
  excelSourceCount: number;
  lastImportAt: string | null;
}

export interface ManualProductCatalogSnapshot {
  catalogRevision: number;
  lastImportAt: string | null;
  products: ManualProductRecord[];
}

export class ManualProductConflictError extends Error {
  readonly code = "MANUAL_PRODUCT_IDENTITY_CONFLICT";

  constructor(message = "商品 ID 重复或不可信，请检查后重试") {
    super(message);
    this.name = "ManualProductConflictError";
  }
}

export class ManualCatalogRevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";

  constructor(readonly currentRevision: number) {
    super("名单已发生变化，请刷新后重试");
    this.name = "ManualCatalogRevisionConflictError";
  }
}

type ProductRow = {
  id: string;
  item_id: string | null;
  product_title: string;
  normalized_title: string;
  created_at: string;
  updated_at: string;
  last_matched_at: string | null;
};

type IdentityRow = ProductRow & ManualProductIdentity & { title: string; itemId: string | null };

export class ManualProductRepository {
  constructor(private readonly database: AppDatabase) {}

  revision(): number {
    return this.catalogState().revision;
  }

  catalogSnapshot(): ManualProductCatalogSnapshot {
    return this.database.transaction(() => {
      const state = this.catalogState();
      const rows = this.database.prepare(`
        SELECT p.*, m.source
        FROM manual_products p
        LEFT JOIN manual_product_memberships m ON m.product_id = p.id
        ORDER BY p.created_at, p.id,
          CASE m.source WHEN 'manual' THEN 0 WHEN 'excel' THEN 1 ELSE 2 END
      `).all() as Array<ProductRow & { source: ManualProductSource | null }>;
      const products = new Map<string, ManualProductRecord>();
      for (const row of rows) {
        const product = products.get(row.id) ?? {
          id: row.id,
          itemId: row.item_id,
          title: displayTitle(row.product_title),
          normalizedTitle: displayNormalizedTitle(row.normalized_title),
          sources: [],
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastMatchedAt: row.last_matched_at,
        };
        if (row.source && !product.sources.includes(row.source)) product.sources.push(row.source);
        products.set(row.id, product);
      }
      return {
        catalogRevision: state.revision,
        lastImportAt: state.lastImportAt,
        products: [...products.values()],
      };
    }).deferred();
  }

  get(id: string): ManualProductRecord | null {
    const row = this.database.prepare("SELECT * FROM manual_products WHERE id = ?").get(id) as ProductRow | undefined;
    return row ? this.mapProduct(row) : null;
  }

  list(input: { query?: string; page?: number; pageSize?: number } = {}): {
    catalogRevision: number;
    total: number;
    page: number;
    pageSize: number;
    items: ManualProductRecord[];
  } {
    return this.database.transaction(() => {
      const page = Math.max(1, Math.trunc(input.page ?? 1));
      const pageSize = Math.max(1, Math.min(200, Math.trunc(input.pageSize ?? 20)));
      const query = input.query?.trim() ?? "";
      const normalizedQuery = normalizeManualProductTitle(query);
      const pattern = `%${escapeLike(query)}%`;
      const normalizedPattern = `%${escapeLike(normalizedQuery)}%`;
      const where = query.length === 0
        ? ""
        : `WHERE (product_title <> ? AND product_title LIKE ? ESCAPE '\\')
            OR COALESCE(item_id, '') LIKE ? ESCAPE '\\'
            OR (normalized_title <> ? AND normalized_title LIKE ? ESCAPE '\\')`;
      const parameters = query.length === 0
        ? []
        : [MISSING_TITLE_SENTINEL, pattern, pattern, MISSING_TITLE_SENTINEL, normalizedPattern];
      const total = (this.database.prepare(`SELECT COUNT(*) AS value FROM manual_products ${where}`).get(...parameters) as { value: number }).value;
      const rows = this.database.prepare(`
        SELECT * FROM manual_products ${where}
        ORDER BY updated_at DESC, product_title ASC, COALESCE(item_id, '') ASC, id ASC
        LIMIT ? OFFSET ?
      `).all(...parameters, pageSize, (page - 1) * pageSize) as ProductRow[];
      return {
        catalogRevision: this.revision(),
        total,
        page,
        pageSize,
        items: rows.map((row) => this.mapProduct(row)),
      };
    }).deferred();
  }

  listWithStats(input: { query?: string; page?: number; pageSize?: number } = {}): ReturnType<ManualProductRepository["list"]> & {
    stats: ManualProductCatalogStats;
  } {
    return this.database.transaction(() => ({
      ...this.list(input),
      stats: this.stats(),
    })).deferred();
  }

  stats(): ManualProductCatalogStats {
    const row = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM manual_products) AS total,
        (SELECT COUNT(*) FROM manual_product_memberships WHERE source = 'manual') AS manual_count,
        (SELECT COUNT(*) FROM manual_product_memberships WHERE source = 'excel') AS excel_count,
        (SELECT last_import_at FROM manual_product_catalog_state WHERE id = 1) AS last_import_at
    `).get() as { total: number; manual_count: number; excel_count: number; last_import_at: string | null };
    return {
      total: row.total,
      manualSourceCount: row.manual_count,
      excelSourceCount: row.excel_count,
      lastImportAt: row.last_import_at,
    };
  }

  upsert(
    identity: ManualProductIdentity,
    source: ManualProductSource,
    expectedRevision: number,
  ): { outcome: ManualProductMutationOutcome; product: ManualProductRecord; catalogRevision: number } {
    return this.database.transaction(() => {
      this.assertRevision(expectedRevision);
      const result = this.upsertInside(identity, source, new Date().toISOString());
      const catalogRevision = this.incrementRevision(expectedRevision);
      return { outcome: result.outcome, product: this.get(result.productId)!, catalogRevision };
    }).immediate();
  }

  remove(productId: string, expectedRevision: number): { removed: boolean; catalogRevision: number } {
    return this.database.transaction(() => {
      this.assertRevision(expectedRevision);
      const exists = this.database.prepare("SELECT 1 FROM manual_products WHERE id = ?").get(productId);
      if (exists) {
        this.releaseEligibleHoldsForProducts([productId]);
        this.database.prepare("DELETE FROM manual_product_memberships WHERE product_id = ?").run(productId);
        this.database.prepare("DELETE FROM manual_products WHERE id = ?").run(productId);
      }
      return { removed: Boolean(exists), catalogRevision: this.incrementRevision(expectedRevision) };
    }).immediate();
  }

  replaceExcel(
    identities: readonly ManualProductIdentity[],
    expectedRevision: number,
    importedAt = new Date(),
  ): { catalogRevision: number; added: number; removed: number; retained: number } {
    return this.database.transaction(() => {
      this.assertRevision(expectedRevision);
      const previous = new Set(
        (this.database.prepare("SELECT product_id FROM manual_product_memberships WHERE source = 'excel'").all() as Array<{ product_id: string }>)
          .map((row) => row.product_id),
      );
      const next = new Set<string>();
      const now = importedAt.toISOString();
      const identityIndex = new ManualProductIdentityIndex(this.identityRows());
      for (const identity of identities) {
        const result = this.upsertInside(identity, "excel", now, identityIndex);
        if (next.has(result.productId)) {
          throw new ManualProductConflictError("导入内容存在重复或冲突商品，请修正后重试");
        }
        next.add(result.productId);
      }

      const removedIds = [...previous].filter((id) => !next.has(id));
      for (const productId of removedIds) {
        this.database.prepare("DELETE FROM manual_product_memberships WHERE product_id = ? AND source = 'excel'").run(productId);
      }
      const orphaned = removedIds.filter((productId) => !this.database.prepare(
        "SELECT 1 FROM manual_product_memberships WHERE product_id = ? LIMIT 1",
      ).get(productId));
      this.releaseEligibleHoldsForProducts(orphaned);
      for (const productId of orphaned) {
        this.database.prepare("DELETE FROM manual_products WHERE id = ?").run(productId);
      }

      const catalogRevision = this.incrementRevision(expectedRevision, now, now);
      return {
        catalogRevision,
        added: [...next].filter((id) => !previous.has(id)).length,
        removed: removedIds.length,
        retained: [...next].filter((id) => previous.has(id)).length,
      };
    }).immediate();
  }

  private upsertInside(
    identity: ManualProductIdentity,
    source: ManualProductSource,
    now: string,
    identityIndex?: ManualProductIdentityIndex<IdentityRow>,
  ): { outcome: ManualProductMutationOutcome; productId: string } {
    const existing = identityIndex?.candidates(identity) ?? this.identityRows();
    const resolution = resolveManualProductIdentity(identity, existing);
    if (resolution.status === "ambiguous") throw new ManualProductConflictError();
    if (resolution.status === "invalid_input") throw new ManualProductConflictError("商品 ID 不能为空");

    let productId: string;
    let outcome: ManualProductMutationOutcome;
    if (resolution.status === "not_matched") {
      productId = randomUUID();
      this.database.prepare(`
        INSERT INTO manual_products(
          id, item_id, product_title, normalized_title, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        productId,
        resolution.patch.itemId,
        storedTitle(resolution.patch.title),
        storedNormalizedTitle(resolution.patch.normalizedTitle),
        now,
        now,
      );
      identityIndex?.add(toIdentityRow({
        id: productId,
        item_id: resolution.patch.itemId,
        product_title: storedTitle(resolution.patch.title),
        normalized_title: storedNormalizedTitle(resolution.patch.normalizedTitle),
        created_at: now,
        updated_at: now,
        last_matched_at: null,
      }));
      outcome = "created";
    } else {
      productId = resolution.target.id;
      const enriched = resolution.target.itemId === null && resolution.patch.itemId !== null;
      for (const candidate of resolution.mergeCandidates) {
        this.database.prepare(`
          INSERT OR IGNORE INTO manual_product_memberships(product_id, source, created_at)
          SELECT ?, source, created_at FROM manual_product_memberships WHERE product_id = ?
        `).run(productId, candidate.id);
        this.database.prepare(`
          UPDATE reply_drafts SET manual_product_id = ?, updated_at = ?
          WHERE manual_product_id = ? AND state = 'manual_product_hold'
        `).run(productId, now, candidate.id);
        this.database.prepare("DELETE FROM manual_products WHERE id = ?").run(candidate.id);
        identityIndex?.remove(candidate.id);
      }
      this.database.prepare(`
        UPDATE manual_products
        SET item_id = ?, product_title = ?, normalized_title = ?, updated_at = ?
        WHERE id = ?
      `).run(
        resolution.patch.itemId,
        storedTitle(resolution.patch.title),
        storedNormalizedTitle(resolution.patch.normalizedTitle),
        now,
        productId,
      );
      identityIndex?.replace(toIdentityRow({
        ...resolution.target,
        item_id: resolution.patch.itemId,
        product_title: storedTitle(resolution.patch.title),
        normalized_title: storedNormalizedTitle(resolution.patch.normalizedTitle),
        updated_at: now,
      }));
      outcome = resolution.mergeCandidates.length > 0 ? "merged" : enriched ? "enriched" : "reused";
    }

    this.database.prepare(`
      INSERT OR IGNORE INTO manual_product_memberships(product_id, source, created_at)
      VALUES (?, ?, ?)
    `).run(productId, source, now);
    return { outcome, productId };
  }

  private identityRows(): IdentityRow[] {
    return (this.database.prepare("SELECT * FROM manual_products ORDER BY created_at, id").all() as ProductRow[]).map(toIdentityRow);
  }

  private mapProduct(row: ProductRow): ManualProductRecord {
    const sources = (this.database.prepare(`
      SELECT source FROM manual_product_memberships WHERE product_id = ?
      ORDER BY CASE source WHEN 'manual' THEN 0 ELSE 1 END
    `).all(row.id) as Array<{ source: ManualProductSource }>).map((item) => item.source);
    return {
      id: row.id,
      itemId: row.item_id,
      title: displayTitle(row.product_title),
      normalizedTitle: displayNormalizedTitle(row.normalized_title),
      sources,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMatchedAt: row.last_matched_at,
    };
  }

  private catalogState(): { revision: number; lastImportAt: string | null } {
    const row = this.database.prepare(`
      SELECT revision, last_import_at FROM manual_product_catalog_state WHERE id = 1
    `).get() as { revision: number; last_import_at: string | null } | undefined;
    if (!row) throw new Error("人工处理商品名单尚未初始化");
    return { revision: row.revision, lastImportAt: row.last_import_at };
  }

  private assertRevision(expectedRevision: number): void {
    const current = this.revision();
    if (!Number.isSafeInteger(expectedRevision) || current !== expectedRevision) {
      throw new ManualCatalogRevisionConflictError(current);
    }
  }

  private incrementRevision(expectedRevision: number, now = new Date().toISOString(), lastImportAt?: string): number {
    const result = this.database.prepare(`
      UPDATE manual_product_catalog_state
      SET revision = revision + 1,
          last_import_at = CASE WHEN ? IS NULL THEN last_import_at ELSE ? END,
          updated_at = ?
      WHERE id = 1 AND revision = ?
    `).run(lastImportAt ?? null, lastImportAt ?? null, now, expectedRevision);
    if (result.changes !== 1) throw new ManualCatalogRevisionConflictError(this.revision());
    return expectedRevision + 1;
  }

  private releaseEligibleHoldsForProducts(productIds: readonly string[]): void {
    if (productIds.length === 0) return;
    const placeholders = productIds.map(() => "?").join(",");
    const holds = this.database.prepare(`
      SELECT d.source_key, l.store_id, l.lock_version
      FROM reply_drafts d
      JOIN review_action_locks l ON l.source_key = d.source_key AND l.action_kind = 'manual_hold'
      LEFT JOIN reply_attempts a
        ON a.source_key = d.source_key
       AND a.state IN ('pending', 'submitting', 'sent', 'submission_uncertain')
      LEFT JOIN review_action_tombstones t ON t.store_id = l.store_id AND t.source_key = d.source_key
      WHERE d.manual_product_id IN (${placeholders})
        AND d.state = 'manual_product_hold'
        AND a.id IS NULL AND t.source_key IS NULL
    `).all(...productIds) as Array<{ source_key: string; store_id: string; lock_version: number }>;
    const gate = new ReviewActionGate(this.database);
    for (const hold of holds) {
      gate.releaseManualHold(hold.store_id, hold.source_key, hold.lock_version);
    }
  }
}

function normalizedItemId(value: string | null | undefined): string | null {
  const itemId = value?.trim() ?? "";
  return itemId.length > 0 ? itemId : null;
}

function toIdentityRow(row: ProductRow): IdentityRow {
  return {
    ...row,
    title: displayTitle(row.product_title),
    itemId: row.item_id,
  };
}

function storedTitle(value: string): string {
  return value.trim() || MISSING_TITLE_SENTINEL;
}

function storedNormalizedTitle(value: string): string {
  return value.trim() || MISSING_TITLE_SENTINEL;
}

function displayTitle(value: string): string {
  return value === MISSING_TITLE_SENTINEL ? "" : value;
}

function displayNormalizedTitle(value: string): string {
  return value === MISSING_TITLE_SENTINEL ? "" : value;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}
