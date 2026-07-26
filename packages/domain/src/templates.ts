export type TemplateRow = Record<string, unknown>;
export type TemplateLibrary = "good" | "bad";

export interface FixedTemplateRow {
  recordId: string;
  fields: TemplateRow;
}

export interface TemplateFieldMapping {
  primaryCategoryField?: string;
  categoryField: string;
  keywordsField: string;
  replyFieldPattern: string;
}

export interface NormalizedReply {
  sequence: number;
  text: string;
}

export interface NormalizedTemplate {
  primaryCategory: string;
  category: string;
  keywords: string[];
  replies: NormalizedReply[];
}

export interface TemplateNormalizationResult {
  templates: NormalizedTemplate[];
  warnings: string[];
}

export interface FixedTemplateSchema extends TemplateFieldMapping {
  label: string;
  fallbackCategory: string;
}

export const FIXED_TEMPLATE_SCHEMAS: Record<TemplateLibrary, FixedTemplateSchema> = {
  good: {
    label: "好评库",
    categoryField: "关键词分类",
    keywordsField: "包含关键词",
    replyFieldPattern: "^回复话术\\s*([1-9]\\d*)$",
    fallbackCategory: "通用整体好评类",
  },
  bad: {
    label: "差评库",
    primaryCategoryField: "一级分类",
    categoryField: "二级分类",
    keywordsField: "包含关键词",
    replyFieldPattern: "^回复话术\\s*([1-9]\\d*)$",
    fallbackCategory: "通用差评类",
  },
};

function asTrimmedText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function splitKeywords(value: unknown): string[] {
  const items = asTrimmedText(value)
    .split(/[、，,；;\n\r]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(items)];
}

function compileReplyPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "u");
  } catch {
    throw new Error("话术字段匹配规则无效");
  }
}

export function normalizeTemplateRows(
  rows: TemplateRow[],
  mapping: TemplateFieldMapping,
): TemplateNormalizationResult {
  const replyPattern = compileReplyPattern(mapping.replyFieldPattern);
  const warnings: string[] = [];
  const templates: NormalizedTemplate[] = [];
  const categories = new Set<string>();

  for (const row of rows) {
    const category = asTrimmedText(row[mapping.categoryField]);
    if (!category) throw new Error("分类字段不能为空");
    if (categories.has(category)) throw new Error(`分类“${category}”重复`);
    categories.add(category);

    const replyCandidates: NormalizedReply[] = [];
    for (const [fieldName, rawValue] of Object.entries(row)) {
      const match = replyPattern.exec(fieldName.trim());
      replyPattern.lastIndex = 0;
      if (!match) continue;

      const sequence = Number(match[1]);
      const text = asTrimmedText(rawValue);
      if (!Number.isInteger(sequence) || sequence < 1 || !text) continue;
      replyCandidates.push({ sequence, text });
    }

    replyCandidates.sort((left, right) => left.sequence - right.sequence);
    const replies: NormalizedReply[] = [];
    const seenText = new Set<string>();
    for (const reply of replyCandidates) {
      if (seenText.has(reply.text)) {
        warnings.push(`分类“${category}”存在重复话术，已忽略序号 ${reply.sequence}`);
        continue;
      }
      seenText.add(reply.text);
      replies.push(reply);
    }

    if (replies.length === 0) throw new Error(`分类“${category}”没有可用话术`);
    const maxSequence = Math.max(...replies.map((reply) => reply.sequence));
    const sequenceSet = new Set(replies.map((reply) => reply.sequence));
    const gaps = Array.from({ length: maxSequence }, (_, index) => index + 1).filter(
      (sequence) => !sequenceSet.has(sequence),
    );
    if (gaps.length > 0) {
      warnings.push(`分类“${category}”的话术序号存在空洞：${gaps.join("、")}`);
    }

    templates.push({
      primaryCategory: mapping.primaryCategoryField
        ? asTrimmedText(row[mapping.primaryCategoryField])
        : "",
      category,
      keywords: splitKeywords(row[mapping.keywordsField]),
      replies,
    });
  }

  return { templates, warnings };
}

export function normalizeFixedTemplateRows(
  library: TemplateLibrary,
  rows: FixedTemplateRow[],
): TemplateNormalizationResult {
  const schema = FIXED_TEMPLATE_SCHEMAS[library];
  const replyPattern = compileReplyPattern(schema.replyFieldPattern);
  let previousPrimaryCategory = "";

  const preparedRows = rows.map(({ recordId, fields }) => {
    const prepared = { ...fields };
    if (schema.primaryCategoryField) {
      const current = asTrimmedText(prepared[schema.primaryCategoryField]);
      if (current) previousPrimaryCategory = current;
      if (!previousPrimaryCategory) {
        throw new Error(`记录 ${recordId} 的一级分类为空，无法沿用上一行`);
      }
      prepared[schema.primaryCategoryField] = previousPrimaryCategory;
    }

    const sequences = new Set<number>();
    for (const fieldName of Object.keys(prepared)) {
      const match = replyPattern.exec(fieldName.trim());
      replyPattern.lastIndex = 0;
      if (!match) continue;
      const sequence = Number(match[1]);
      if (sequences.has(sequence)) {
        throw new Error(`记录 ${recordId} 的话术序号 ${sequence} 重复`);
      }
      sequences.add(sequence);
    }
    return prepared;
  });

  const result = normalizeTemplateRows(preparedRows, schema);
  if (!result.templates.some((template) => template.category === schema.fallbackCategory)) {
    throw new Error(`${schema.label}缺少必需分类“${schema.fallbackCategory}”`);
  }
  if (library === "bad") {
    const fallback = result.templates.find((template) => template.category === schema.fallbackCategory);
    if (fallback?.primaryCategory !== schema.fallbackCategory) {
      throw new Error("通用差评类的一级分类也必须是“通用差评类”");
    }
  }
  return result;
}
