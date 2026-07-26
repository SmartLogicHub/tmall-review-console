import { createHash } from "node:crypto";
import {
  FIXED_TEMPLATE_SCHEMAS,
  normalizeFixedTemplateRows,
  type TemplateLibrary,
  type TemplateNormalizationResult,
} from "@tmall/domain";
import type { TemplateRepository } from "../storage/repositories";
import type { FeishuClientApi, FeishuField, FeishuRecord } from "./client";

function cellToText(recordId: string, fieldName: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) return value.join("");
    if (
      value.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "text" in item &&
          typeof (item as { text?: unknown }).text === "string",
      )
    ) {
      return value.map((item) => (item as { text: string }).text).join("");
    }
  }
  if (
    typeof value === "object" &&
    "text" in value &&
    typeof (value as { text?: unknown }).text === "string"
  ) {
    return (value as { text: string }).text;
  }
  throw new Error(`记录 ${recordId} 的字段“${fieldName}”使用了不支持的单元格类型`);
}

export function normalizeFeishuTable(
  library: TemplateLibrary,
  fields: FeishuField[],
  records: FeishuRecord[],
): TemplateNormalizationResult {
  const schema = FIXED_TEMPLATE_SCHEMAS[library];
  const names = fields.map((field) => field.field_name.trim());
  const required = [schema.categoryField, schema.keywordsField];
  if (schema.primaryCategoryField) required.unshift(schema.primaryCategoryField);
  for (const fieldName of required) {
    if (!names.includes(fieldName)) throw new Error(`飞书表格缺少必需字段“${fieldName}”`);
  }

  const replyPattern = new RegExp(schema.replyFieldPattern, "u");
  const selectedFields = [...required];
  const replySequences = new Map<number, string>();
  for (const fieldName of names) {
    const match = replyPattern.exec(fieldName);
    replyPattern.lastIndex = 0;
    if (!match) continue;
    const sequence = Number(match[1]);
    const previous = replySequences.get(sequence);
    if (previous) {
      throw new Error(`飞书表格的话术序号 ${sequence} 重复：${previous}、${fieldName}`);
    }
    replySequences.set(sequence, fieldName);
    selectedFields.push(fieldName);
  }
  if (replySequences.size === 0) throw new Error("飞书表格缺少“回复话术 N”字段");

  const fixedRows = records.map((record) => {
    const normalizedFields: Record<string, unknown> = {};
    for (const fieldName of selectedFields) {
      normalizedFields[fieldName] = cellToText(record.record_id, fieldName, record.fields[fieldName]);
    }
    return { recordId: record.record_id, fields: normalizedFields };
  });
  return normalizeFixedTemplateRows(library, fixedRows);
}

export class TemplateSyncService {
  constructor(
    private readonly dependencies: {
      repository: TemplateRepository;
      client: FeishuClientApi;
    },
  ) {}

  async test(library: TemplateLibrary) {
    const loaded = await this.#load(library);
    return this.#summary(loaded.result, loaded.recordCount, false);
  }

  async sync(library: TemplateLibrary) {
    try {
      const loaded = await this.#load(library);
      const contentHash = createHash("sha256")
        .update(JSON.stringify(loaded.result.templates), "utf8")
        .digest("hex");
      const activated = this.dependencies.repository.activateVersion({
        library,
        contentHash,
        sourceRecordCount: loaded.recordCount,
        templates: loaded.result.templates,
        warnings: loaded.result.warnings,
      });
      return {
        ...this.#summary(loaded.result, loaded.recordCount, activated.changed),
        versionId: activated.versionId,
      };
    } catch (error) {
      const message = this.#safeMessage(error);
      this.dependencies.repository.recordSyncFailure(library, "TEMPLATE_SYNC_FAILED", message);
      throw new Error(message);
    }
  }

  async #load(library: TemplateLibrary) {
    const source = this.dependencies.repository.getSource(library);
    if (!source) throw new Error(`${library === "good" ? "好评" : "差评"}模板来源尚未配置`);
    const appToken = String(source.app_token ?? "");
    const tableId = String(source.table_id ?? "");
    const [fields, records] = await Promise.all([
      this.dependencies.client.listFields(appToken, tableId),
      this.dependencies.client.listRecords(appToken, tableId),
    ]);
    return { result: normalizeFeishuTable(library, fields, records), recordCount: records.length };
  }

  #summary(result: TemplateNormalizationResult, recordCount: number, changed: boolean) {
    return {
      changed,
      recordCount,
      categoryCount: result.templates.length,
      replyCount: result.templates.reduce((total, template) => total + template.replies.length, 0),
      warnings: result.warnings,
    };
  }

  #safeMessage(error: unknown) {
    const message = error instanceof Error ? error.message : "模板同步失败";
    return message
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [REDACTED]")
      .replace(/app_secret\s*[:=]\s*[^\s,}]+/giu, "app_secret=[REDACTED]")
      .slice(0, 800);
  }
}
