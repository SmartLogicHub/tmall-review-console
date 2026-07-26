import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "../storage/database";
import { ManualProductRepository } from "../storage/manual-product-repository";
import { ImportPreviewStore } from "./import-preview-store";
import {
  ManualProductImportService,
  type ManualProductImportPreviewPayload,
} from "./import-service";

const workbookPath = process.env.MANUAL_PRODUCTS_WORKBOOK;

describe("real manual-product workbook acceptance", () => {
  it.skipIf(!workbookPath)("previews the selected workbook without applying it", async () => {
    if (!workbookPath) throw new Error("MANUAL_PRODUCTS_WORKBOOK is required");
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new ManualProductRepository(database);
    const service = new ManualProductImportService({
      repository,
      previewStore: new ImportPreviewStore<ManualProductImportPreviewPayload>(),
    });

    try {
      const preview = await service.preview({
        sessionId: "real-workbook-read-only-acceptance",
        filename: basename(workbookPath),
        buffer: await readFile(workbookPath),
      });

      expect(preview).toMatchObject({
        canApply: true,
        worksheetName: "Sheet1",
        catalogRevision: 1,
        summary: { added: 4, retained: 0, removed: 0, conflicts: 0 },
      });
      expect(preview.samples.added.map((product) => product.itemId)).toEqual([
        "960227744800",
        "980913413146",
        "700451080604",
        "811060563195",
      ]);
      expect(repository.catalogSnapshot()).toMatchObject({
        catalogRevision: 1,
        products: [],
      });
    } finally {
      database.close();
    }
  });
});
