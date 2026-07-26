import ExcelJS from "exceljs";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { type ManualProductIdentity } from "@tmall/domain";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 5_000;
export const MAX_ZIP_ENTRIES = 1_000;
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_WORKSHEET_XML_BYTES = 8 * 1024 * 1024;
export const MAX_WORKBOOK_CELLS = 100_000;
export const MAX_WORKSHEETS = 64;

export interface XlsxParserLimits {
  maxUploadBytes: number;
  maxRows: number;
  maxZipEntries: number;
  maxTotalUncompressedBytes: number;
  maxWorksheetXmlBytes: number;
  maxWorkbookCells: number;
  maxWorksheets: number;
}

export interface XlsxArchiveEntry {
  path: string;
  declaredUncompressedSize: number;
  encrypted: boolean;
  chunks: AsyncIterable<Uint8Array>;
}

export type XlsxArchiveEntryProvider = (buffer: Buffer) => AsyncIterable<XlsxArchiveEntry>;

export interface XlsxParserOptions {
  limits?: Partial<XlsxParserLimits>;
  entryProvider?: XlsxArchiveEntryProvider;
}

export interface ParsedManualProductWorkbook {
  rows: ManualProductIdentity[];
  worksheetName: string;
}

export type XlsxValidationErrorCode =
  | "UNSUPPORTED_FILE_TYPE"
  | "UPLOAD_TOO_LARGE"
  | "INVALID_WORKBOOK"
  | "ARCHIVE_LIMIT_EXCEEDED"
  | "ENCRYPTED_WORKBOOK"
  | "MACRO_WORKBOOK"
  | "UNSUPPORTED_CELL_VALUE"
  | "MULTIPLE_WORKSHEETS"
  | "ITEM_ID_HEADER_REQUIRED"
  | "ITEM_ID_HEADER_DUPLICATED"
  | "EMPTY_ITEM_ID"
  | "TITLE_HEADER_REQUIRED"
  | "TITLE_HEADER_DUPLICATED"
  | "EMPTY_TITLE"
  | "DUPLICATE_ITEM_ID"
  | "DUPLICATE_TITLE"
  | "TOO_MANY_ROWS"
  | "TOO_MANY_WORKSHEETS";

const MESSAGES: Record<XlsxValidationErrorCode, string> = {
  UNSUPPORTED_FILE_TYPE: "仅支持 .xlsx 格式文件",
  UPLOAD_TOO_LARGE: "文件大小不能超过 5MB",
  INVALID_WORKBOOK: "文件不是有效的 Excel 工作簿",
  ARCHIVE_LIMIT_EXCEEDED: "Excel 文件内容过大或过于复杂",
  ENCRYPTED_WORKBOOK: "不支持加密的 Excel 文件",
  MACRO_WORKBOOK: "不支持含宏的 Excel 文件",
  UNSUPPORTED_CELL_VALUE: "表格中含有不支持的单元格内容",
  MULTIPLE_WORKSHEETS: "文件中只能有一个包含数据的工作表",
  ITEM_ID_HEADER_REQUIRED: "表格必须包含一个“商品 ID”列",
  ITEM_ID_HEADER_DUPLICATED: "表格中只能有一个“商品 ID”列",
  EMPTY_ITEM_ID: "每条商品数据都必须填写商品 ID",
  TITLE_HEADER_REQUIRED: "表格必须包含一个“商品标题”列",
  TITLE_HEADER_DUPLICATED: "表格中只能有一个“商品标题”列",
  EMPTY_TITLE: "商品标题不能为空",
  DUPLICATE_ITEM_ID: "表格中存在重复的商品 ID",
  DUPLICATE_TITLE: "表格中存在重复的商品标题",
  TOO_MANY_ROWS: "商品数量不能超过 5000 条",
  TOO_MANY_WORKSHEETS: `Excel 工作表数量不能超过 ${MAX_WORKSHEETS} 个`,
};

export class XlsxValidationError extends Error {
  constructor(readonly code: XlsxValidationErrorCode) {
    super(MESSAGES[code]);
    this.name = "XlsxValidationError";
  }
}

const DEFAULT_LIMITS: XlsxParserLimits = {
  maxUploadBytes: MAX_UPLOAD_BYTES,
  maxRows: MAX_ROWS,
  maxZipEntries: MAX_ZIP_ENTRIES,
  maxTotalUncompressedBytes: MAX_TOTAL_UNCOMPRESSED_BYTES,
  maxWorksheetXmlBytes: MAX_WORKSHEET_XML_BYTES,
  maxWorkbookCells: MAX_WORKBOOK_CELLS,
  maxWorksheets: MAX_WORKSHEETS,
};

export async function parseManualProductWorkbook(
  buffer: Buffer,
  filename: string,
  options: XlsxParserOptions = {},
): Promise<ParsedManualProductWorkbook> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  validateInput(buffer, filename, limits);
  await inspectArchive(buffer, options.entryProvider ?? yauzlEntryProvider, limits);

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (error) {
    if (error instanceof XlsxValidationError) throw error;
    throw new XlsxValidationError("INVALID_WORKBOOK");
  }
  if (workbook.worksheets.length > limits.maxWorksheets) {
    throw new XlsxValidationError("TOO_MANY_WORKSHEETS");
  }
  return parseWorkbook(workbook, limits);
}

function validateInput(buffer: Buffer, filename: string, limits: XlsxParserLimits): void {
  if (!/\.xlsx$/iu.test(filename) || filename.trim().toLowerCase().endsWith(".xlsm")) {
    throw new XlsxValidationError("UNSUPPORTED_FILE_TYPE");
  }
  if (buffer.byteLength > limits.maxUploadBytes) throw new XlsxValidationError("UPLOAD_TOO_LARGE");
  if (buffer.byteLength < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
    throw new XlsxValidationError("INVALID_WORKBOOK");
  }
}

async function inspectArchive(
  buffer: Buffer,
  provider: XlsxArchiveEntryProvider,
  limits: XlsxParserLimits,
): Promise<void> {
  let entries = 0;
  let declaredTotal = 0;
  let actualTotal = 0;
  let workbookCells = 0;
  const paths = new Set<string>();
  try {
    for await (const archiveEntry of provider(buffer)) {
      entries += 1;
      if (entries > limits.maxZipEntries) throw new XlsxValidationError("ARCHIVE_LIMIT_EXCEEDED");
      validateArchivePath(archiveEntry.path, paths);
      if (archiveEntry.encrypted) throw new XlsxValidationError("ENCRYPTED_WORKBOOK");
      if (isMacroPath(archiveEntry.path)) throw new XlsxValidationError("MACRO_WORKBOOK");
      if (!Number.isSafeInteger(archiveEntry.declaredUncompressedSize) || archiveEntry.declaredUncompressedSize < 0) {
        throw new XlsxValidationError("INVALID_WORKBOOK");
      }
      declaredTotal += archiveEntry.declaredUncompressedSize;
      if (declaredTotal > limits.maxTotalUncompressedBytes) {
        throw new XlsxValidationError("ARCHIVE_LIMIT_EXCEEDED");
      }

      const worksheet = isWorksheetPath(archiveEntry.path);
      let worksheetBytes = 0;
      let xmlTail = "";
      for await (const rawChunk of archiveEntry.chunks) {
        const chunk = Buffer.from(rawChunk);
        actualTotal += chunk.byteLength;
        if (actualTotal > limits.maxTotalUncompressedBytes) {
          throw new XlsxValidationError("ARCHIVE_LIMIT_EXCEEDED");
        }
        if (worksheet) {
          worksheetBytes += chunk.byteLength;
          if (worksheetBytes > limits.maxWorksheetXmlBytes) {
            throw new XlsxValidationError("ARCHIVE_LIMIT_EXCEEDED");
          }
          const counted = countCellTags(xmlTail, chunk.toString("utf8"));
          workbookCells += counted.count;
          xmlTail = counted.tail;
          if (workbookCells > limits.maxWorkbookCells) {
            throw new XlsxValidationError("ARCHIVE_LIMIT_EXCEEDED");
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof XlsxValidationError) throw error;
    throw new XlsxValidationError("INVALID_WORKBOOK");
  }
}

function validateArchivePath(path: string, paths: Set<string>): void {
  const canonical = path.toLowerCase();
  const segments = path.split("/");
  if (
    !path || path.includes("\\") || path.includes("\0") || path.startsWith("/")
    || /^[A-Za-z]:/u.test(path) || segments.some((segment) => segment === "." || segment === "..")
    || paths.has(canonical)
  ) {
    throw new XlsxValidationError("INVALID_WORKBOOK");
  }
  paths.add(canonical);
}

function isMacroPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized.includes("vbaproject") || normalized.includes("macrosheet") || normalized.endsWith(".bin");
}

function isWorksheetPath(path: string): boolean {
  return /^xl\/worksheets\/[^/]+\.xml$/iu.test(path);
}

function countCellTags(previousTail: string, current: string): { count: number; tail: string } {
  const combined = previousTail + current;
  let count = 0;
  const pattern = /<c(?=[\s>])/gu;
  for (const match of combined.matchAll(pattern)) {
    if ((match.index ?? 0) + 2 >= previousTail.length) count += 1;
  }
  return { count, tail: combined.slice(-2) };
}

async function* yauzlEntryProvider(buffer: Buffer): AsyncIterable<XlsxArchiveEntry> {
  const zipFile = await openZip(buffer);
  try {
    while (true) {
      const entry = await readNextEntry(zipFile);
      if (!entry) break;
      yield {
        path: entry.fileName,
        declaredUncompressedSize: entry.uncompressedSize,
        encrypted: entry.isEncrypted(),
        chunks: openEntryChunks(zipFile, entry),
      };
    }
  } finally {
    zipFile.close();
  }
}

async function* openEntryChunks(zipFile: ZipFile, entry: Entry): AsyncIterable<Buffer> {
  const stream = await openEntryStream(zipFile, entry);
  for await (const chunk of stream) yield Buffer.from(chunk);
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, {
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true,
      decodeStrings: true,
      autoClose: false,
    }, (error, zipFile) => error ? reject(error) : resolve(zipFile));
  });
}

function readNextEntry(zipFile: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zipFile.off("entry", onEntry);
      zipFile.off("end", onEnd);
      zipFile.off("error", onError);
    };
    const onEntry = (entry: Entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(null); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    zipFile.once("entry", onEntry);
    zipFile.once("end", onEnd);
    zipFile.once("error", onError);
    zipFile.readEntry();
  });
}

function openEntryStream(zipFile: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream & AsyncIterable<Buffer>> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream as NodeJS.ReadableStream & AsyncIterable<Buffer>);
    });
  });
}

function parseWorkbook(workbook: ExcelJS.Workbook, limits: XlsxParserLimits): ParsedManualProductWorkbook {
  let worksheet: ExcelJS.Worksheet | null = null;
  for (const candidate of workbook.worksheets) {
    const firstRow = firstNonEmptyRow(candidate);
    if (!firstRow || !rowHasItemIdHeader(firstRow)) continue;
    if (worksheet) throw new XlsxValidationError("MULTIPLE_WORKSHEETS");
    worksheet = candidate;
  }
  if (!worksheet) throw new XlsxValidationError("ITEM_ID_HEADER_REQUIRED");
  const populatedRows = nonEmptyRows(worksheet);

  validateWorksheetCellValues(worksheet);
  const headerRow = populatedRows[0]!;
  const titleColumns: number[] = [];
  const itemIdColumns: number[] = [];
  headerRow.eachCell((cell, column) => {
    const value = cell.value;
    if (typeof value !== "string") throw new XlsxValidationError("UNSUPPORTED_CELL_VALUE");
    const header = normalizeHeader(value);
    if (header === "商品标题") titleColumns.push(column);
    if (header === "商品ID" || header === "商品 ID") itemIdColumns.push(column);
  });
  if (titleColumns.length > 1) throw new XlsxValidationError("TITLE_HEADER_DUPLICATED");
  if (itemIdColumns.length === 0) throw new XlsxValidationError("ITEM_ID_HEADER_REQUIRED");
  if (itemIdColumns.length > 1) throw new XlsxValidationError("ITEM_ID_HEADER_DUPLICATED");

  const titleColumn = titleColumns[0];
  const itemIdColumn = itemIdColumns[0]!;
  const rows: ManualProductIdentity[] = [];
  const itemIds = new Set<string>();
  for (const row of populatedRows) {
    if (row.number <= headerRow.number) continue;
    const itemId = primitiveText(row.getCell(itemIdColumn).value);
    if (!itemId) throw new XlsxValidationError("EMPTY_ITEM_ID");
    if (itemIds.has(itemId)) throw new XlsxValidationError("DUPLICATE_ITEM_ID");
    itemIds.add(itemId);
    const title = titleColumn === undefined ? "" : (primitiveText(row.getCell(titleColumn).value) ?? "");
    rows.push({ title, itemId });
    if (rows.length > limits.maxRows) throw new XlsxValidationError("TOO_MANY_ROWS");
  }
  return { rows, worksheetName: worksheet.name };
}

function firstNonEmptyRow(worksheet: ExcelJS.Worksheet): ExcelJS.Row | null {
  const rowFound = Symbol("row-found");
  let first: ExcelJS.Row | null = null;
  try {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      if (!rowHasValues(row)) return;
      first = row;
      throw rowFound;
    });
  } catch (error) {
    if (error !== rowFound) throw error;
  }
  return first;
}

function rowHasItemIdHeader(row: ExcelJS.Row): boolean {
  let found = false;
  row.eachCell((cell) => {
    if (typeof cell.value !== "string") return;
    const header = normalizeHeader(cell.value);
    if (header === "商品ID" || header === "商品 ID") found = true;
  });
  return found;
}

function normalizeHeader(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function validateWorksheetCellValues(worksheet: ExcelJS.Worksheet): void {
  worksheet.eachRow((row) => {
    row.eachCell((cell) => {
      const value = cell.value;
      if (value === null || value === undefined || typeof value === "string") return;
      if (typeof value === "number" && Number.isSafeInteger(value)) return;
      throw new XlsxValidationError("UNSUPPORTED_CELL_VALUE");
    });
  });
}

function nonEmptyRows(worksheet: ExcelJS.Worksheet): ExcelJS.Row[] {
  const rows: ExcelJS.Row[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    if (rowHasValues(row)) rows.push(row);
  });
  return rows;
}

function rowHasValues(row: ExcelJS.Row): boolean {
  let found = false;
  row.eachCell((cell) => {
    const value = cell.value;
    if (value !== null && value !== undefined && (typeof value !== "string" || value.trim() !== "")) found = true;
  });
  return found;
}

function primitiveText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new XlsxValidationError("UNSUPPORTED_CELL_VALUE");
}
