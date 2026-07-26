import type { AuthState, ElementHealthState, ReplyState, RuntimeState, TemplateFieldMapping } from "@tmall/domain";
import type { ImportPreviewStore } from "./manual-products/import-preview-store";
import type { ManualProductImportPreviewPayload, ManualProductImportService } from "./manual-products/import-service";

export interface AppRuntimeServices {
  importPreviewStore: ImportPreviewStore<ManualProductImportPreviewPayload>;
  manualProductImportService: ManualProductImportService;
}

export interface TemplateSourceState {
  library: "good" | "bad";
  label: string;
  url: string;
  mapping: TemplateFieldMapping;
  fallbackCategory: string;
  status: "not_configured" | "ready" | "warning";
  categoryCount: number;
  replyCount: number;
  lastSyncedAt: string | null;
  warnings: string[];
}

export interface ReplyRecord {
  id: string;
  review: string;
  stars: number;
  product: string;
  library: "good" | "bad";
  category: string;
  state: ReplyState;
  originalTemplate: string;
  finalReply: string;
  processedAt: string;
}

export interface AppState {
  services: AppRuntimeServices | null;
  runtime: {
    state: RuntimeState;
    readOnly: true;
    mode: "automatic_read_only";
    currentStep: string;
    startedAt: string | null;
  };
  replies: ReplyRecord[];
  templateSources: Record<"good" | "bad", TemplateSourceState>;
  auth: {
    state: AuthState;
    configured: boolean;
    maskedAccount: string | null;
    storeName: string | null;
    autoReloginEnabled: boolean;
    lastLoginAt: string | null;
    lastSessionCheckAt: string | null;
    lastFailure: string | null;
  };
  locators: Array<{
    operationKey: string;
    label: string;
    strategy: string;
    health: ElementHealthState;
    risk: "normal" | "observed_high_risk";
    lastSuccessAt: string | null;
    version: number;
  }>;
}

const defaultMapping: TemplateFieldMapping = {
  primaryCategoryField: "一级分类",
  categoryField: "二级分类",
  keywordsField: "包含关键词",
  replyFieldPattern: "^回复话术\\s*([1-9]\\d*)$",
};

export function createInitialState(): AppState {
  return {
    services: null,
    runtime: {
      state: "stopped",
      readOnly: true,
      mode: "automatic_read_only",
      currentStep: "等待开始",
      startedAt: null,
    },
    replies: [],
    templateSources: {
      good: {
        library: "good",
        label: "好评回复规则库",
        url: "",
        mapping: { ...defaultMapping },
        fallbackCategory: "通用整体好评类",
        status: "not_configured",
        categoryCount: 0,
        replyCount: 0,
        lastSyncedAt: null,
        warnings: [],
      },
      bad: {
        library: "bad",
        label: "差评回复规则库",
        url: "",
        mapping: { ...defaultMapping },
        fallbackCategory: "通用差评类",
        status: "not_configured",
        categoryCount: 0,
        replyCount: 0,
        lastSyncedAt: null,
        warnings: [],
      },
    },
    auth: {
      state: "not_configured",
      configured: false,
      maskedAccount: null,
      storeName: null,
      autoReloginEnabled: false,
      lastLoginAt: null,
      lastSessionCheckAt: null,
      lastFailure: null,
    },
    locators: [
      { operationKey: "review.list", label: "评论列表", strategy: "role: row", health: "healthy", risk: "normal", lastSuccessAt: null, version: 1 },
      { operationKey: "review.text", label: "评论文本", strategy: "scoped text", health: "healthy", risk: "normal", lastSuccessAt: null, version: 1 },
      { operationKey: "reply.editor", label: "回复输入框（只观察）", strategy: "role: textbox", health: "degraded", risk: "observed_high_risk", lastSuccessAt: null, version: 1 },
      { operationKey: "reply.submit", label: "回复按钮（只观察）", strategy: "role: button", health: "paused", risk: "observed_high_risk", lastSuccessAt: null, version: 1 },
    ],
  };
}
