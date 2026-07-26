export const PERSISTED_DATA_TYPES = [
  "reviews",
  "complaints",
  "complaint_audit",
  "ai_structured",
  "raw_ai",
  "screenshots",
  "redacted_snapshots",
  "runtime_logs",
  "review_scope",
  "manual_products",
  "manual_holds",
  "action_tombstones",
  "template_cache",
  "locator_history",
  "audit",
  "settings",
  "browser_profile",
  "secrets",
  "identity_salt",
] as const;

export type PersistedDataType = (typeof PERSISTED_DATA_TYPES)[number];

export interface RetentionPolicy {
  label: string;
  retentionDays: number | null;
  cleanup: "automatic" | "manual" | "factory_reset_only";
  export: "exportable" | "redacted_only" | "never";
}

export const RETENTION_POLICIES: Record<PersistedDataType, RetentionPolicy> = {
  complaints: { label: "\u6295\u8bc9\u6848\u4ef6\u4e0e\u6838\u5bf9\u7ed3\u679c", retentionDays: 90, cleanup: "automatic", export: "redacted_only" },
  complaint_audit: { label: "\u6295\u8bc9\u63d0\u4ea4\u4e0e\u5ba1\u6838\u8bb0\u5f55", retentionDays: 180, cleanup: "automatic", export: "redacted_only" },
  reviews: { label: "评论与生成结果", retentionDays: 90, cleanup: "automatic", export: "exportable" },
  ai_structured: { label: "AI结构化结果", retentionDays: 30, cleanup: "automatic", export: "redacted_only" },
  raw_ai: { label: "DeepSeek原始响应", retentionDays: 7, cleanup: "automatic", export: "redacted_only" },
  screenshots: { label: "页面截图", retentionDays: 14, cleanup: "automatic", export: "exportable" },
  redacted_snapshots: { label: "脱敏页面快照", retentionDays: 7, cleanup: "automatic", export: "redacted_only" },
  runtime_logs: { label: "运行与网络审计日志", retentionDays: 30, cleanup: "automatic", export: "redacted_only" },
  review_scope: { label: "处理日期范围", retentionDays: null, cleanup: "manual", export: "exportable" },
  manual_products: { label: "人工处理商品名单", retentionDays: null, cleanup: "manual", export: "exportable" },
  manual_holds: { label: "人工保留评价", retentionDays: 90, cleanup: "automatic", export: "redacted_only" },
  action_tombstones: { label: "评价终结记录", retentionDays: 180, cleanup: "automatic", export: "redacted_only" },
  template_cache: { label: "飞书模板缓存", retentionDays: null, cleanup: "automatic", export: "redacted_only" },
  locator_history: { label: "元素定位与修复历史", retentionDays: 30, cleanup: "automatic", export: "redacted_only" },
  audit: { label: "操作与清理审计", retentionDays: 180, cleanup: "automatic", export: "redacted_only" },
  settings: { label: "非敏感设置", retentionDays: null, cleanup: "manual", export: "exportable" },
  browser_profile: { label: "应用专属浏览器登录数据", retentionDays: null, cleanup: "manual", export: "never" },
  secrets: { label: "应用密钥与登录凭据", retentionDays: null, cleanup: "manual", export: "never" },
  identity_salt: { label: "评论身份HMAC密钥", retentionDays: null, cleanup: "factory_reset_only", export: "never" },
};
