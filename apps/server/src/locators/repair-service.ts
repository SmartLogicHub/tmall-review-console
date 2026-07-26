import type { DeepSeekClientApi, LocatorRepairSuggestion } from "../deepseek/client";
import type { LocatorRepairRecord, LocatorRepository } from "../storage/repositories";

export interface SemanticElementSnapshot {
  tag: string;
  role?: string | undefined;
  name?: string | undefined;
  placeholder?: string | undefined;
  ariaLabel?: string | undefined;
  classes?: string[] | undefined;
}

export interface LocatorProbeResult {
  matches: number;
  shadowValidated: boolean;
  postconditionPassed: boolean;
}

interface LocatorRepairServiceOptions {
  repository: LocatorRepository;
  ai: Pick<DeepSeekClientApi, "suggestLocatorRepair">;
  probe: (input: { operationKey: string; strategy: string; selector: string }) => Promise<LocatorProbeResult>;
  maxCandidates?: number;
}

const ALLOWED_STRATEGIES = new Set(["role", "text", "placeholder", "css"]);
const UNSAFE_SELECTOR = /javascript:|<\/?script|evaluate\s*\(|page\.|document\.|window\.|\bclick\s*\(|\bfill\s*\(|\bpress\s*\(|\bmouse\b|\bkeyboard\b/iu;

const REQUIRED_BUSINESS_TEXT: Readonly<Record<string, readonly string[]>> = {
  "login.account": ["账号名/邮箱/手机号", "账号", "邮箱", "手机号"],
  "login.password": ["请输入登录密码", "登录密码", "密码"],
  "login.submit": ["登录"],
  "navigation.trade": ["交易"],
  "navigation.reviews": ["评价管理"],
  "review.filter.buyer": ["来自买家的评价"],
  "review.filter.content": ["有内容"],
  "review.filter.unanswered": ["未回复"],
  "review.filter.followup": ["有追评"],
  "review.date.trigger": ["评价时间", "起始日期", "结束日期"],
  "review.date.preset.today": ["今天"],
  "review.date.preset.yesterday": ["昨天"],
  "review.date.preset.last7": ["近7天"],
  "review.date.preset.last30": ["近30天"],
  "review.date.previous": ["上个月", "上一月", "向前"],
  "review.date.next": ["下个月", "下一月", "向后"],
  "review.search": ["搜索"],
  "review.pagination": ["下一页", ">"],
};

function redact(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, "[已隐藏]")
    .replace(/1[3-9]\d{9}/gu, "[已隐藏]")
    .replace(/\d{6,}/gu, "[编号]")
    .replace(/买家[^\s，。；:：]{1,12}/gu, "买家[已隐藏]")
    .replace(/(账号|密码|验证码)\s*[:：=]\s*[^\s，。；]{2,}/gu, "$1：[已隐藏]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
}

const CONTROLLED_UI_TEXT = new Set([
  "登录", "交易", "评价管理", "来自买家的评价", "有内容", "未回复", "评价时间",
  "今天", "昨天", "近7天", "近30天", "搜索", "评价回复", "追评回复", "提交",
  "确认回复", "发布", "关闭", "我知道了", "完成", "上个月", "上一月", "下个月",
  "下一月", "向前", "向后", "下一页", "已回复", "商家回复成功", "回复成功",
  "账号名/邮箱/手机号", "登录密码", "请输入登录密码", "起始日期", "结束日期",
]);

function controlledUiText(value: string): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 120);
  if (!normalized) return "";
  return CONTROLLED_UI_TEXT.has(normalized) ? normalized : "[已省略]";
}

function safeClassName(value: string): string {
  const normalized = value.normalize("NFKC").trim().slice(0, 120);
  return normalized && /^[a-z_-][a-z0-9_-]*$/iu.test(normalized) && !/\d/u.test(normalized)
    ? normalized
    : "[已省略]";
}

export function sanitizeSemanticSnapshot(elements: SemanticElementSnapshot[]): string {
  return JSON.stringify(elements.slice(0, 200).map((item) => ({
    tag: redact(String(item.tag ?? "")),
    role: redact(String(item.role ?? "")),
    name: controlledUiText(String(item.name ?? "")),
    placeholder: controlledUiText(String(item.placeholder ?? "")),
    ariaLabel: controlledUiText(String(item.ariaLabel ?? "")),
    classes: Array.isArray(item.classes) ? [...new Set(item.classes.slice(0, 8).map((value) => safeClassName(String(value))))] : [],
  }))).slice(0, 12_000);
}

function validateSuggestion(value: LocatorRepairSuggestion): LocatorRepairSuggestion {
  const strategy = value.strategy.trim().toLowerCase();
  const selector = value.selector.trim();
  if (!ALLOWED_STRATEGIES.has(strategy) || !selector || selector.length > 300 || UNSAFE_SELECTOR.test(selector)) {
    throw new Error("AI 返回的候选定位不安全，未执行任何页面操作");
  }
  return { strategy: strategy as LocatorRepairSuggestion["strategy"], selector, reason: value.reason.trim().slice(0, 300) };
}

function matchesBusinessMeaning(operationKey: string, suggestion: LocatorRepairSuggestion): boolean {
  const required = REQUIRED_BUSINESS_TEXT[operationKey];
  if (!required) return true;
  const selector = suggestion.selector.normalize("NFKC").replace(/\s+/gu, "");
  return required.some((token) => selector.includes(token.replace(/\s+/gu, "")));
}

export class LocatorRepairService {
  constructor(private readonly options: LocatorRepairServiceOptions) {}

  async repair(operationKey: string, elements: SemanticElementSnapshot[]): Promise<LocatorRepairRecord> {
    const current = this.options.repository.get(operationKey);
    if (!current) throw new Error("页面元素不存在");
    if (!this.options.ai.suggestLocatorRepair) throw new Error("DeepSeek 元素修复能力尚未启用");
    const snapshot = sanitizeSemanticSnapshot(elements);
    const rejectedCandidates: Array<{ strategy: LocatorRepairSuggestion["strategy"]; selector: string; reason: string }> = [];
    const maxCandidates = Math.min(5, Math.max(1, this.options.maxCandidates ?? 3));
    let lastRejected: LocatorRepairRecord | null = null;
    for (let attempt = 0; attempt < maxCandidates; attempt += 1) {
      const suggestion = validateSuggestion(await this.options.ai.suggestLocatorRepair({
        operationKey,
        label: current.label,
        risk: current.risk,
        currentStrategy: current.strategy,
        currentSelector: current.selector,
        sanitizedSnapshot: snapshot,
        ...(rejectedCandidates.length > 0 ? { rejectedCandidates } : {}),
      }));
      if (rejectedCandidates.some((item) => item.strategy === suggestion.strategy && item.selector === suggestion.selector)) {
        rejectedCandidates.push({ ...suggestion, reason: "AI 重复了已失败候选" });
        continue;
      }
      if (!matchesBusinessMeaning(operationKey, suggestion)) {
        rejectedCandidates.push({ ...suggestion, reason: "候选元素与当前业务步骤不一致" });
        continue;
      }
      const evidence = await this.options.probe({ operationKey, strategy: suggestion.strategy, selector: suggestion.selector });
      const validated = evidence.matches === 1 && evidence.shadowValidated && evidence.postconditionPassed;
      const repair = this.options.repository.proposeRepair({
        operationKey,
        strategy: suggestion.strategy,
        selector: suggestion.selector,
        validated,
        evidenceSummary: validated
          ? `唯一匹配；影子验证和页面后置条件均通过。${suggestion.reason}`
          : `候选未通过验证（匹配 ${evidence.matches} 个元素），未启用。`,
      });
      if (validated) return repair;
      lastRejected = repair;
      rejectedCandidates.push(suggestion);
    }
    if (lastRejected) return lastRejected;
    throw new Error("AI 未能提供新的安全定位候选，未执行任何页面操作");
  }
}
