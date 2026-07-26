import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Database, ExternalLink, RefreshCw, Save, TestTube2 } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch, toUserMessage } from "../api/client";
import { StatusPill } from "../components/status-pill";

type Library = "good" | "bad";
type Source = {
  library: Library;
  label: string;
  url: string;
  schema: {
    fields: string[];
    replyFieldPattern: string;
    fallbackCategory: string;
    primaryCategoryRule: string | null;
  };
  status: string;
  activeVersion: number | null;
  contentHash: string | null;
  categoryCount: number;
  replyCount: number;
  lastTestedAt: string | null;
  lastSyncedAt: string | null;
  warnings: string[];
  health: {
    state: "ready" | "usable_with_warning" | "not_ready";
    usable: boolean;
    activeVersion: number | null;
    latestSyncStatus: string;
    latestSyncAt: string | null;
    categoryCount: number;
    replyCount: number;
    warning: string | null;
    message: string;
  };
};

type Category = {
  primaryCategory: string;
  category: string;
  keywords: string[];
  replies: Array<{ sequence: number; text: string }>;
};

export function TemplatesPage() {
  const sources = useQuery({
    queryKey: ["template-sources"],
    queryFn: () => apiFetch<{ items: Source[] }>("/api/template-sources"),
  });
  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">回复内容</p>
          <h1>话术库</h1>
          <span>在这里填写好评和差评飞书链接。以后新增话术，只需在飞书增加“回复话术 N”列并重新同步。</span>
        </div>
        <StatusPill tone="neutral">飞书同步</StatusPill>
      </div>
      <div className="template-intro">
        <Database size={22} />
        <div>
          <strong>飞书表格格式保持不变</strong>
          <span>系统会自动识别“回复话术 1、2、3…”，不需要在控制台增加字段。</span>
          <span>每条新评价都会在命中分类中随机抽取一条话术；已处理的同一评价不会重复提交。</span>
        </div>
      </div>
      <div className="source-grid">
        {sources.isLoading ? (
          <div className="empty-state">正在读取模板配置…</div>
        ) : (
          sources.data?.items.map((source) => <SourceCard source={source} key={source.library} />)
        )}
      </div>
    </section>
  );
}

function SourceCard({ source }: { source: Source }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState(source.url);
  useEffect(() => setUrl(source.url), [source.url]);
  const categories = useQuery({
    queryKey: ["template-categories", source.library],
    queryFn: () => apiFetch<{ items: Category[] }>(`/api/template-sources/${source.library}/categories`),
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["template-sources"] }),
      queryClient.invalidateQueries({ queryKey: ["template-categories", source.library] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    ]);
  };
  const save = useMutation({
    mutationFn: () =>
      apiFetch<Source>("/api/template-sources", {
        method: "PUT",
        body: JSON.stringify({ library: source.library, url }),
      }),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: () =>
      apiFetch(`/api/template-sources/${source.library}/test`, { method: "POST" }),
    onSuccess: refresh,
  });
  const sync = useMutation({
    mutationFn: () =>
      apiFetch(`/api/template-sources/${source.library}/sync`, { method: "POST" }),
    onSuccess: refresh,
  });
  const working = save.isPending || test.isPending || sync.isPending;
  const fallbackPresent =
    categories.data?.items.some((item) => item.category === source.schema.fallbackCategory) ?? false;
  const actionError = save.error ?? test.error ?? sync.error;

  return (
    <article className="panel source-card">
      <div className="source-heading">
        <div>
          <span className={`source-icon ${source.library}`}><Database size={18} /></span>
          <div><p className="eyebrow">{source.library === "good" ? "正面评价" : "负面评价"}</p><h3>{source.library === "good" ? "好评话术库" : "差评话术库"}</h3></div>
        </div>
        <StatusPill tone={source.health.state === "ready" ? "success" : source.health.state === "usable_with_warning" ? "warning" : "neutral"}>
          {source.health.state === "ready" ? "正常" : source.health.state === "usable_with_warning" ? "需关注" : "不可用"}
        </StatusPill>
      </div>

      <div className="schema-contract">
        <div className="contract-heading"><strong>飞书列名</strong><span>自动识别</span></div>
        <div className="contract-fields">{source.schema.fields.map((field) => <code key={field}>{field}</code>)}</div>
        {source.library === "bad" && <p><span>一级分类空白时沿用上一行</span><br />通用差评类的一级、二级分类均填写“通用差评类”。</p>}
      </div>

      <label className="field full">
        <span>{source.library === "good" ? "好评话术库链接" : "差评话术库链接"}</span>
        <div className="input-with-icon">
          <input
            aria-label={`${source.library === "good" ? "好评" : "差评"}库飞书链接`}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://租户.feishu.cn/base/...?table=tbl..."
          />
          <ExternalLink size={16} />
        </div>
      </label>

      <div className="fallback-check">
        <span><CheckCircle2 size={15} />未匹配时使用</span>
        <strong>{source.schema.fallbackCategory}</strong>
        <StatusPill tone={fallbackPresent ? "success" : source.activeVersion ? "warning" : "neutral"}>
          {fallbackPresent ? "已存在" : source.activeVersion ? "缺失" : "待同步验证"}
        </StatusPill>
      </div>

      <div className="source-stats source-stats-four">
        <span><strong>{source.activeVersion ? `第 ${source.activeVersion} 版` : "—"}</strong> 当前版本</span>
        <span><strong>{source.categoryCount}</strong> 分类</span>
        <span><strong>{source.replyCount}</strong> 话术</span>
        <span><strong>{source.lastSyncedAt ? new Date(source.lastSyncedAt).toLocaleDateString("zh-CN") : "—"}</strong> 最近同步</span>
      </div>

      {source.health.warning && <p className="inline-warning"><span>{source.health.warning}</span>。可直接重新同步，当前自动回复不会中断。</p>}
      {actionError && <p className="inline-warning">{toUserMessage(actionError, "话术库操作未完成，请稍后重试")}</p>}
      {(save.isSuccess || test.isSuccess || sync.isSuccess) && (
        <p className="inline-success">
          {sync.isSuccess ? "同步成功，活动版本已安全切换。" : test.isSuccess ? "读取与格式校验通过。" : "链接已保存。"}
        </p>
      )}

      <div className="card-actions">
        <button className="button secondary" onClick={() => save.mutate()} disabled={working || !url.trim()}><Save size={16} />保存链接</button>
        <button className="button secondary" onClick={() => test.mutate()} disabled={working || !source.url}><TestTube2 size={16} />检查表格</button>
        <button className="button primary" onClick={() => sync.mutate()} disabled={working || !source.url}><RefreshCw size={16} />同步话术</button>
      </div>

      <CategoryPreview library={source.library} categories={categories.data?.items ?? []} />
    </article>
  );
}

function CategoryPreview({ library, categories }: { library: Library; categories: Category[] }) {
  if (categories.length === 0) return <div className="category-preview empty-preview">同步成功后在这里预览分类和话术数量。</div>;
  if (library === "good") {
    return (
      <div className="category-preview">
        <div className="preview-heading"><strong>分类预览</strong><span>{categories.length} 个</span></div>
        {categories.map((item) => <CategoryRow category={item.category} replyCount={item.replies.length} key={item.category} />)}
      </div>
    );
  }
  const groups = new Map<string, Category[]>();
  for (const item of categories) {
    const key = item.primaryCategory || "未分组";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return (
    <div className="category-preview">
      <div className="preview-heading"><strong>按一级分类预览</strong><span>{categories.length} 个二级分类</span></div>
      {[...groups.entries()].map(([primary, items]) => (
        <div className="category-group" key={primary}>
          <b>{primary}</b>
          {items.map((item) => <CategoryRow category={item.category} replyCount={item.replies.length} key={item.category} />)}
        </div>
      ))}
    </div>
  );
}

function CategoryRow({ category, replyCount }: { category: string; replyCount: number }) {
  return <div className="category-row"><span>{category}</span><small>{replyCount} 条话术</small></div>;
}
