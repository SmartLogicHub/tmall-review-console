import ExcelJS from "exceljs";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  MAX_ROWS,
  MAX_WORKSHEETS,
  XlsxValidationError,
  parseManualProductWorkbook,
  type XlsxArchiveEntry,
  type XlsxArchiveEntryProvider,
} from "./xlsx-parser";

async function workbookBuffer(
  sheets: Array<{ name: string; rows: unknown[][] }>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    for (const row of sheet.rows) worksheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function expectStableError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(XlsxValidationError);
  expect(error).toMatchObject({ code });
  expect((error as Error).message).not.toMatch(/[A-Za-z]:\\|xl\/|secret|\.xml/iu);
}

function injectedEntries(entries: XlsxArchiveEntry[]): XlsxArchiveEntryProvider {
  return async function* provide() {
    for (const entry of entries) yield entry;
  };
}

function entry(
  path: string,
  chunks: Array<string | Buffer>,
  options: { declaredSize?: number; encrypted?: boolean } = {},
): XlsxArchiveEntry {
  const buffers = chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return {
    path,
    declaredUncompressedSize: options.declaredSize ?? buffers.reduce((sum, chunk) => sum + chunk.length, 0),
    encrypted: options.encrypted ?? false,
    chunks: (async function* stream() {
      for (const chunk of buffers) yield chunk;
    })(),
  };
}

function markZipEntriesEncrypted(buffer: Buffer): Buffer {
  const encrypted = Buffer.from(buffer);
  for (let offset = 0; offset <= encrypted.length - 10; offset += 1) {
    const signature = encrypted.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      encrypted.writeUInt16LE(encrypted.readUInt16LE(offset + 6) | 0x0001, offset + 6);
    } else if (signature === 0x02014b50) {
      encrypted.writeUInt16LE(encrypted.readUInt16LE(offset + 8) | 0x0001, offset + 8);
    }
  }
  return encrypted;
}

describe("parseManualProductWorkbook", () => {
  it("accepts an ID-only workbook and treats titles as optional display text", async () => {
    const buffer = await workbookBuffer([{ name: "名单", rows: [
      ["商品ID"],
      ["960227744800"],
      ["980913413146"],
    ] }]);

    await expect(parseManualProductWorkbook(buffer, "products.xlsx")).resolves.toEqual({
      rows: [
        { itemId: "960227744800", title: "" },
        { itemId: "980913413146", title: "" },
      ],
      worksheetName: "名单",
    });
  });

  it("allows duplicate titles when item IDs are different", async () => {
    const buffer = await workbookBuffer([{ name: "Sheet1", rows: [
      ["商品标题", "商品 ID"],
      ["标题会变化", "960227744800"],
      ["标题会变化", "980913413146"],
    ] }]);

    await expect(parseManualProductWorkbook(buffer, "products.xlsx")).resolves.toMatchObject({
      rows: [
        { itemId: "960227744800", title: "标题会变化" },
        { itemId: "980913413146", title: "标题会变化" },
      ],
    });
  });

  it("requires exactly one item ID column and rejects a non-empty row without an ID", async () => {
    const missingHeader = await workbookBuffer([{ name: "Sheet1", rows: [["商品标题"], ["商品 A"]] }]);
    await expect(parseManualProductWorkbook(missingHeader, "missing-id.xlsx")).rejects.toMatchObject({
      code: "ITEM_ID_HEADER_REQUIRED",
    });

    const duplicateHeader = await workbookBuffer([{ name: "Sheet1", rows: [["商品ID", "商品 ID"]] }]);
    await expect(parseManualProductWorkbook(duplicateHeader, "duplicate-id-header.xlsx")).rejects.toMatchObject({
      code: "ITEM_ID_HEADER_DUPLICATED",
    });

    const missingRowId = await workbookBuffer([{ name: "Sheet1", rows: [
      ["商品ID", "商品标题"],
      [null, "有标题但没有 ID"],
    ] }]);
    await expect(parseManualProductWorkbook(missingRowId, "missing-row-id.xlsx")).rejects.toMatchObject({
      code: "EMPTY_ITEM_ID",
    });
  });

  it("parses the four-row user workbook and ignores a note sheet and a blank sheet", async () => {
    const buffer = await workbookBuffer([
      { name: "Sheet1", rows: [
        ["商品标题", "商品 ID"],
        ["漫步者 X1 EVO", "1001"],
        ["漫步者 R101V", 1002],
        ["漫步者 Atom ANC", "1003"],
        ["漫步者 Zero Air", "1004"],
        [null, null],
      ] },
      { name: "Sheet2", rows: [["说明"], ["本页不是商品名单"]] },
      { name: "Sheet3", rows: [[null, null]] },
    ]);

    await expect(parseManualProductWorkbook(buffer, "中差评剔除产品.xlsx")).resolves.toEqual({
      rows: [
        { title: "漫步者 X1 EVO", itemId: "1001" },
        { title: "漫步者 R101V", itemId: "1002" },
        { title: "漫步者 Atom ANC", itemId: "1003" },
        { title: "漫步者 Zero Air", itemId: "1004" },
      ],
      worksheetName: "Sheet1",
    });
  });

  it("accepts 商品ID and a header-only workbook as an empty replacement", async () => {
    const buffer = await workbookBuffer([{ name: "名单", rows: [["商品ID", "商品标题"]] }]);
    await expect(parseManualProductWorkbook(buffer, "products.XLSX")).resolves.toEqual({
      rows: [],
      worksheetName: "名单",
    });
  });

  it("reads non-empty rows after gaps using their real row numbers", async () => {
    const buffer = await workbookBuffer([{ name: "Sheet1", rows: [
      ["商品标题", "商品ID"],
      ["商品 A", "1"],
      [],
      ["商品 B", "2"],
    ] }]);

    await expect(parseManualProductWorkbook(buffer, "gapped.xlsx")).resolves.toMatchObject({
      rows: [
        { itemId: "1", title: "商品 A" },
        { itemId: "2", title: "商品 B" },
      ],
    });
  });

  it("reads a sparse last Excel row without iterating a million empty rows", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Sheet1");
    worksheet.getCell("A1").value = "商品ID";
    worksheet.getCell("A1048576").value = "1001";
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const startedAt = performance.now();
    const parsed = await parseManualProductWorkbook(buffer, "sparse.xlsx");
    const elapsedMs = performance.now() - startedAt;

    expect(parsed.rows).toEqual([{ itemId: "1001", title: "" }]);
    expect(elapsedMs).toBeLessThan(2_000);
  }, 10_000);

  it("stops after the second valid sparse worksheet instead of scanning all remaining sheets", async () => {
    const workbook = new ExcelJS.Workbook();
    for (let index = 0; index < 200; index += 1) {
      const worksheet = workbook.addWorksheet(`Sheet${index + 1}`);
      worksheet.getCell("A1").value = "商品ID";
      worksheet.getCell("A1048576").value = `item-${index}`;
    }
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const startedAt = performance.now();
    await expect(parseManualProductWorkbook(buffer, "many-sparse.xlsx", {
      limits: { maxWorksheets: 256 },
    })).rejects.toMatchObject({ code: "MULTIPLE_WORKSHEETS" });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_500);
  }, 120_000);

  it("rejects too many no-header worksheets with a stable user-facing error", async () => {
    const workbook = new ExcelJS.Workbook();
    for (let index = 0; index <= MAX_WORKSHEETS; index += 1) {
      workbook.addWorksheet(`说明${index + 1}`).getCell("A1").value = "说明";
    }
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(parseManualProductWorkbook(buffer, "too-many-sheets.xlsx")).rejects.toMatchObject({
      code: "TOO_MANY_WORKSHEETS",
      message: `Excel 工作表数量不能超过 ${MAX_WORKSHEETS} 个`,
    });
  }, 30_000);

  it.each(["products.xls", "products.xlsm", "products.csv", "products.xlsx.exe"])(
    "rejects unsupported filename %s",
    async (filename) => {
      await expect(parseManualProductWorkbook(Buffer.from("PK\u0003\u0004"), filename)).rejects
        .toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
    },
  );

  it("rejects oversized uploads and fake ZIP payloads before parsing", async () => {
    await expect(parseManualProductWorkbook(Buffer.alloc(5 * 1024 * 1024 + 1), "large.xlsx")).rejects
      .toMatchObject({ code: "UPLOAD_TOO_LARGE" });
    await expect(parseManualProductWorkbook(Buffer.from("not a zip"), "fake.xlsx")).rejects
      .toMatchObject({ code: "INVALID_WORKBOOK" });
  });

  it("requires exactly one populated worksheet selected by its 商品 ID header", async () => {
    const missing = await workbookBuffer([{ name: "Sheet1", rows: [["名称"], ["商品 A"]] }]);
    await expect(parseManualProductWorkbook(missing, "missing.xlsx")).rejects
      .toMatchObject({ code: "ITEM_ID_HEADER_REQUIRED" });

    const duplicateHeader = await workbookBuffer([{ name: "Sheet1", rows: [["商品ID", "商品 ID"]] }]);
    await expect(parseManualProductWorkbook(duplicateHeader, "duplicate-header.xlsx")).rejects
      .toMatchObject({ code: "ITEM_ID_HEADER_DUPLICATED" });

    const multipleSheets = await workbookBuffer([
      { name: "A", rows: [["商品ID"], ["1001"]] },
      { name: "B", rows: [["商品 ID"], ["1002"]] },
    ]);
    await expect(parseManualProductWorkbook(multipleSheets, "multiple.xlsx")).rejects
      .toMatchObject({ code: "MULTIPLE_WORKSHEETS" });
  });

  it("rejects duplicate IDs", async () => {
    const duplicateId = await workbookBuffer([{ name: "Sheet1", rows: [
      ["商品标题", "商品ID"], ["A", "1"], ["B", "1"],
    ] }]);
    await expect(parseManualProductWorkbook(duplicateId, "duplicate-id.xlsx")).rejects
      .toMatchObject({ code: "DUPLICATE_ITEM_ID" });
  });

  it("accepts a missing title when the item ID is present", async () => {
    const buffer = await workbookBuffer([{ name: "Sheet1", rows: [
      ["商品标题", "商品ID"], [null, "1001"],
    ] }]);
    await expect(parseManualProductWorkbook(buffer, "empty-title.xlsx")).resolves.toMatchObject({
      rows: [{ itemId: "1001", title: "" }],
    });
  });

  it("rejects formulas, dates, booleans, errors, rich text and unsafe integers without using display text", async () => {
    const unsafeValues: unknown[] = [
      { formula: "1+1", result: 2 },
      new Date("2026-07-15T00:00:00.000Z"),
      true,
      { error: "#VALUE!" },
      { richText: [{ text: "商品 A" }] },
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const [index, value] of unsafeValues.entries()) {
      const buffer = await workbookBuffer([{ name: "Sheet1", rows: [["商品ID"], [value]] }]);
      try {
        await parseManualProductWorkbook(buffer, `unsafe-${index}.xlsx`);
        throw new Error("expected rejection");
      } catch (error) {
        expectStableError(error, "UNSUPPORTED_CELL_VALUE");
      }
    }
  });

  it("rejects more than 5000 products", async () => {
    const rows: unknown[][] = [["商品标题", "商品ID"]];
    for (let index = 0; index <= MAX_ROWS; index += 1) rows.push([`商品 ${index}`, `${index}`]);
    const buffer = await workbookBuffer([{ name: "Sheet1", rows }]);
    await expect(parseManualProductWorkbook(buffer, "too-many.xlsx")).rejects
      .toMatchObject({ code: "TOO_MANY_ROWS" });
  }, 30_000);

  it("drains every ZIP entry and enforces actual decompressed byte limits", async () => {
    let drained = false;
    const provider = injectedEntries([
      entry("[Content_Types].xml", ["1234"], { declaredSize: 1 }),
      {
        ...entry("docProps/core.xml", ["5678"], { declaredSize: 1 }),
        chunks: (async function* stream() { drained = true; yield Buffer.from("5678"); })(),
      },
    ]);
    await expect(parseManualProductWorkbook(Buffer.from("PK\u0003\u0004"), "limits.xlsx", {
      entryProvider: provider,
      limits: { maxTotalUncompressedBytes: 7 },
    })).rejects.toMatchObject({ code: "ARCHIVE_LIMIT_EXCEEDED" });
    expect(drained).toBe(true);
  });

  it("rejects encrypted, duplicate, dangerous and macro archive entries", async () => {
    const cases: Array<{ entries: XlsxArchiveEntry[]; code: string }> = [
      { entries: [entry("safe.xml", ["x"], { encrypted: true })], code: "ENCRYPTED_WORKBOOK" },
      { entries: [entry("safe.xml", ["x"]), entry("safe.xml", ["y"])], code: "INVALID_WORKBOOK" },
      { entries: [entry("../secret.xml", ["x"])], code: "INVALID_WORKBOOK" },
      { entries: [entry("xl/vbaProject.bin", ["x"])], code: "MACRO_WORKBOOK" },
    ];
    for (const testCase of cases) {
      try {
        await parseManualProductWorkbook(Buffer.from("PK\u0003\u0004"), "unsafe.xlsx", {
          entryProvider: injectedEntries(testCase.entries),
        });
        throw new Error("expected rejection");
      } catch (error) {
        expectStableError(error, testCase.code);
      }
    }
  });

  it("detects a real yauzl encrypted entry before trying to open its stream", async () => {
    const workbook = await workbookBuffer([{ name: "Sheet1", rows: [["商品标题"], ["商品 A"]] }]);
    const encrypted = markZipEntriesEncrypted(workbook);

    await expect(parseManualProductWorkbook(encrypted, "encrypted.xlsx")).rejects.toMatchObject({
      code: "ENCRYPTED_WORKBOOK",
      message: "不支持加密的 Excel 文件",
    });
  });

  it("enforces entry count, declared size, worksheet size and cell tags split across chunks", async () => {
    const base = Buffer.from("PK\u0003\u0004");
    await expect(parseManualProductWorkbook(base, "entries.xlsx", {
      entryProvider: injectedEntries([entry("a", ["x"]), entry("b", ["y"])]),
      limits: { maxZipEntries: 1 },
    })).rejects.toMatchObject({ code: "ARCHIVE_LIMIT_EXCEEDED" });

    await expect(parseManualProductWorkbook(base, "declared.xlsx", {
      entryProvider: injectedEntries([entry("safe.xml", ["x"], { declaredSize: 9 })]),
      limits: { maxTotalUncompressedBytes: 8 },
    })).rejects.toMatchObject({ code: "ARCHIVE_LIMIT_EXCEEDED" });

    await expect(parseManualProductWorkbook(base, "worksheet.xlsx", {
      entryProvider: injectedEntries([entry("xl/worksheets/sheet1.xml", ["12345"])]),
      limits: { maxWorksheetXmlBytes: 4 },
    })).rejects.toMatchObject({ code: "ARCHIVE_LIMIT_EXCEEDED" });

    await expect(parseManualProductWorkbook(base, "cells.xlsx", {
      entryProvider: injectedEntries([entry("xl/worksheets/sheet1.xml", ["<", "c><c", " r=\"A1\">"])]),
      limits: { maxWorkbookCells: 1 },
    })).rejects.toMatchObject({ code: "ARCHIVE_LIMIT_EXCEEDED" });
  });
});
