import {
  resolveManualProductIdentity,
  type ManualProductIdentity,
} from "@tmall/domain";
import {
  ManualCatalogRevisionConflictError,
  type ManualProductCatalogSnapshot,
  type ManualProductRecord,
  type ManualProductRepository,
} from "../storage/manual-product-repository";
import { ImportPreviewStore } from "./import-preview-store";
import { ManualProductIdentityIndex } from "./identity-index";
import {
  XlsxValidationError,
  parseManualProductWorkbook,
  type ParsedManualProductWorkbook,
} from "./xlsx-parser";

const SAMPLE_LIMIT = 5;

export interface ManualProductImportPreviewPayload {
  readonly catalogRevision: number;
  readonly rows: ReadonlyArray<{ itemId: string | null; title: string }>;
  readonly diff: {
    readonly summary: ManualProductImportPreviewSummary;
    readonly samples: ManualProductImportPreview["samples"];
  };
}

export interface ManualProductImportPreviewSummary {
  added: number;
  retained: number;
  removed: number;
  conflicts: number;
}

export interface ManualProductImportPreview {
  canApply: boolean;
  token: string | null;
  catalogRevision: number;
  worksheetName: string;
  summary: ManualProductImportPreviewSummary;
  samples: {
    added: Array<{ itemId: string | null; title: string }>;
    retained: Array<{ itemId: string | null; title: string }>;
    removed: Array<Pick<ManualProductRecord, "id" | "itemId" | "title">>;
    conflicts: Array<{ itemId: string | null; title: string }>;
  };
}

export class ManualProductImportError extends Error {
  constructor(readonly code: "CATALOG_CHANGED" | "PREVIEW_FAILED" | "PREVIEW_INVALID" | "APPLY_FAILED", message: string) {
    super(message);
    this.name = "ManualProductImportError";
  }
}

interface ImportRepository {
  catalogSnapshot(): ManualProductCatalogSnapshot;
  replaceExcel(
    identities: readonly ManualProductIdentity[],
    expectedRevision: number,
    importedAt: Date,
  ): { catalogRevision: number; added: number; removed: number; retained: number };
}

export interface ManualProductImportServiceOptions {
  repository: ImportRepository | ManualProductRepository;
  previewStore: ImportPreviewStore<ManualProductImportPreviewPayload>;
  parseWorkbook?: (
    buffer: Buffer,
    filename: string,
  ) => Promise<ParsedManualProductWorkbook>;
  now?: () => Date;
}

export class ManualProductImportService {
  private readonly repository: ImportRepository;
  private readonly previewStore: ImportPreviewStore<ManualProductImportPreviewPayload>;
  private readonly parseWorkbook: NonNullable<ManualProductImportServiceOptions["parseWorkbook"]>;
  private readonly now: () => Date;

  constructor(options: ManualProductImportServiceOptions) {
    this.repository = options.repository;
    this.previewStore = options.previewStore;
    this.parseWorkbook = options.parseWorkbook ?? parseManualProductWorkbook;
    this.now = options.now ?? (() => new Date());
  }

  invalidatePreview(sessionId: string): void {
    this.previewStore.invalidateSession(sessionId);
  }

  async preview(input: { sessionId: string; filename: string; buffer: Buffer }): Promise<ManualProductImportPreview> {
    const attempt = this.previewStore.beginAttempt(input.sessionId);
    try {
      let parsed: ParsedManualProductWorkbook;
      let snapshot: ManualProductCatalogSnapshot;
      try {
        parsed = await this.parseWorkbook(input.buffer, input.filename);
        snapshot = this.repository.catalogSnapshot();
      } catch (error) {
        if (error instanceof XlsxValidationError) throw error;
        throw new ManualProductImportError("PREVIEW_FAILED", "无法预览该名单，请重新选择文件");
      }

      const simulation = simulateImport(parsed.rows, snapshot);
      const canApply = simulation.summary.conflicts === 0;
      const payload: ManualProductImportPreviewPayload = {
        catalogRevision: snapshot.catalogRevision,
        rows: parsed.rows.map((row) => ({
          itemId: normalizedItemId(row.itemId),
          title: row.title.trim(),
        })),
        diff: {
          summary: simulation.summary,
          samples: simulation.samples,
        },
      };
      return {
        canApply,
        token: canApply ? this.previewStore.issue(attempt, payload) : null,
        catalogRevision: snapshot.catalogRevision,
        worksheetName: parsed.worksheetName,
        summary: simulation.summary,
        samples: simulation.samples,
      };
    } finally {
      this.previewStore.finishAttempt(input.sessionId, attempt.attemptId);
    }
  }

  async apply(input: { sessionId: string; token: string }): Promise<{
    catalogRevision: number;
    added: number;
    removed: number;
    retained: number;
  }> {
    return this.applySync(input);
  }

  applySync(input: { sessionId: string; token: string }): {
    catalogRevision: number;
    added: number;
    removed: number;
    retained: number;
  } {
    let payload: ManualProductImportPreviewPayload;
    try {
      payload = this.previewStore.consume(input.token, input.sessionId);
    } catch {
      throw new ManualProductImportError("PREVIEW_INVALID", "预览已失效，请重新选择文件");
    }
    try {
      return this.repository.replaceExcel(payload.rows, payload.catalogRevision, this.now());
    } catch (error) {
      if (error instanceof ManualCatalogRevisionConflictError) {
        throw new ManualProductImportError("CATALOG_CHANGED", "名单已发生变化，请重新选择文件");
      }
      throw new ManualProductImportError("APPLY_FAILED", "名单更新失败，请重新选择文件");
    }
  }
}

interface SimulatedProduct extends ManualProductIdentity {
  id: string;
  sources: Set<"manual" | "excel">;
}

function simulateImport(
  rows: readonly ManualProductIdentity[],
  snapshot: ManualProductCatalogSnapshot,
): Pick<ManualProductImportPreview, "summary" | "samples"> {
  const products = new Map<string, SimulatedProduct>(snapshot.products.map((product) => [product.id, {
    id: product.id,
    itemId: product.itemId,
    title: product.title,
    sources: new Set(product.sources),
  }]));
  const identityIndex = new ManualProductIdentityIndex([...products.values()]);
  const previousExcel = new Set(
    snapshot.products.filter((product) => product.sources.includes("excel")).map((product) => product.id),
  );
  const nextExcel = new Set<string>();
  const conflicts: Array<{ itemId: string | null; title: string }> = [];

  rows.forEach((incoming, index) => {
    const identity = { itemId: normalizedItemId(incoming.itemId), title: incoming.title.trim() };
    const resolution = resolveManualProductIdentity(identity, identityIndex.candidates(identity));
    if (resolution.status === "ambiguous" || resolution.status === "invalid_input") {
      conflicts.push(identity);
      return;
    }
    let target: SimulatedProduct;
    if (resolution.status === "not_matched") {
      target = {
        id: `preview-${index}`,
        itemId: resolution.patch.itemId,
        title: resolution.patch.title,
        sources: new Set(),
      };
      products.set(target.id, target);
      identityIndex.add(target);
    } else {
      target = resolution.target;
      const sources = new Set(target.sources);
      for (const candidate of resolution.mergeCandidates) {
        for (const source of candidate.sources) sources.add(source);
        products.delete(candidate.id);
        identityIndex.remove(candidate.id);
      }
      target = {
        ...target,
        itemId: resolution.patch.itemId,
        title: resolution.patch.title,
        sources,
      };
      products.set(target.id, target);
      identityIndex.replace(target);
    }
    if (nextExcel.has(target.id)) {
      conflicts.push(identity);
      return;
    }
    nextExcel.add(target.id);
    target.sources.add("excel");
  });

  const addedIds = [...nextExcel].filter((id) => !previousExcel.has(id));
  const retainedIds = [...nextExcel].filter((id) => previousExcel.has(id));
  const removed = snapshot.products.filter((product) => previousExcel.has(product.id) && !nextExcel.has(product.id));
  return {
    summary: {
      added: addedIds.length,
      retained: retainedIds.length,
      removed: removed.length,
      conflicts: conflicts.length,
    },
    samples: {
      added: addedIds.slice(0, SAMPLE_LIMIT).map((id) => productIdentity(products.get(id)!)),
      retained: retainedIds.slice(0, SAMPLE_LIMIT).map((id) => productIdentity(products.get(id)!)),
      removed: removed.slice(0, SAMPLE_LIMIT).map(({ id, itemId, title }) => ({ id, itemId, title })),
      conflicts: conflicts.slice(0, SAMPLE_LIMIT),
    },
  };
}

function productIdentity(product: SimulatedProduct): { itemId: string | null; title: string } {
  return { itemId: product.itemId ?? null, title: product.title };
}

function normalizedItemId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}
