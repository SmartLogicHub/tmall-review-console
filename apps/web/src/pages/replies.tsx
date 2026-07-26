import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, CheckCircle2, RefreshCw, Search, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { apiFetch } from "../api/client";
import { StatusPill } from "../components/status-pill";

type Reply = {
  id: string;
  sourceKey: string;
  orderId: string | null;
  review: string;
  stars?: number;
  product: string;
  reviewedAt: string | null;
  sentimentLabel: "positive" | "negative" | "neutral" | "unknown";
  library: "good" | "bad" | null;
  primaryCategory: string;
  category: string;
  classificationConfidence: number | null;
  classificationReason: string;
  templateSequence: number | null;
  originalTemplate: string;
  finalReply: string;
  productAdjusted: boolean;
  rewriteNotes: string;
  attentionReasons: string[];
  state: string;
  errorMessage: string | null;
  failedStage?: "classification" | "rewrite" | null;
  aiRetryErrorKind?: string | null;
  complaintErrorKind?: string | null;
  discoveredAt: string;
  processedAt: string | null;
};

type Filter = "all" | "sent" | "unsent" | "good" | "bad" | "attention";

type ReplyPage = {
  items: Reply[];
  total: number;
  overallTotal?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
};

export function RepliesPage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const replies = useQuery({
    queryKey: ["replies", page, filter, query],
    queryFn: () => apiFetch<ReplyPage>(replyListUrl(page, filter, query)),
    refetchInterval: 5_000,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reopenMessage, setReopenMessage] = useState<string | null>(null);
  const liveReplyData = replies.isError ? undefined : replies.data;
  const items = liveReplyData?.items ?? [];
  const overallTotal = liveReplyData?.overallTotal ?? liveReplyData?.total ?? 0;
  const currentPage = liveReplyData?.page ?? page;
  const totalPages = liveReplyData?.totalPages ?? 1;
  const selected = (liveReplyData?.items ?? []).find((item) => item.id === selectedId) ?? null;
  const reprocess = useMutation({
    mutationFn: (id: string) => apiFetch<Reply>(`/api/replies/${id}/reprocess`, { method: "POST" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["replies"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
    },
  });
  const clearCompleted = useMutation({
    mutationFn: () => apiFetch<{ deleted: number }>("/api/storage/reviews?scope=sent", { method: "DELETE" }),
    onSuccess: async () => {
      setSelectedId(null);
      setPage(1);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["replies"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["storage"] }),
      ]);
    },
  });
  const clearUnsuccessful = useMutation({
    mutationFn: () => apiFetch<{ deleted: number }>("/api/storage/reviews?scope=unsent", { method: "DELETE" }),
    onSuccess: async () => {
      setSelectedId(null);
      setPage(1);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["replies"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["storage"] }),
        queryClient.invalidateQueries({ queryKey: ["complaints"] }),
        queryClient.invalidateQueries({ queryKey: ["complaint-summary"] }),
      ]);
    },
  });
  const removeForReprocessing = useMutation({
    mutationFn: (id: string) => apiFetch<{ removed: true; mode: "reprocess" | "completed" | "reply_pending"; reprocessable: boolean }>(`/api/replies/${id}`, { method: "DELETE" }),
    onSuccess: async (result) => {
      setSelectedId(null);
      setReopenMessage(result.mode === "completed"
        ? "记录已清理，仅保留防重复标记，不会再次回复或投诉。"
        : result.mode === "reply_pending"
          ? "投诉历史已清理；该评价仍待回复，后续回复流程不受影响。"
          : "记录已删除，下次运行会重新处理该评价。");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["replies"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["storage"] }),
        queryClient.invalidateQueries({ queryKey: ["complaints"] }),
        queryClient.invalidateQueries({ queryKey: ["complaint-summary"] }),
      ]);
    },
  });
  const removeRecord = (item: Reply) => {
    const completed = item.state === "sent";
    const prompt = completed
      ? "这条回复已成功发送。清理后仅保留不可见的防重复标记，不会再次回复。确定清理吗？"
      : "确定删除这条本地处理记录吗？如果尚未成功提交，下次运行会重新读取并处理这条评价。";
    if (!window.confirm(prompt)) return;
    setReopenMessage(null);
    removeForReprocessing.mutate(item.id);
  };

  return <section className="page-content replies-page">
    <div className="page-heading"><div><p className="eyebrow">处理历史</p><h1>回复结果</h1><span>查看每条评论的分类依据、采用话术、最终回复和发送结果。</span></div><div className="page-heading-actions reply-cleanup-actions"><button className="button secondary" type="button" disabled={clearCompleted.isPending || clearUnsuccessful.isPending} onClick={() => { if (window.confirm("确定清理已完成的回复记录吗？系统会保留防重复标记，避免再次回复。")) clearCompleted.mutate(); }}><Trash2 size={15} />{clearCompleted.isPending ? "正在清理" : "清理已完成记录"}</button><button className="button secondary danger-outline" type="button" disabled={clearCompleted.isPending || clearUnsuccessful.isPending} onClick={() => { if (window.confirm("确定清理所有未成功记录吗？等待重试、待核对及处理中记录也会删除，清理后只保留发送成功记录；以后页面仍可回复的评价会重新处理。")) clearUnsuccessful.mutate(); }}><Trash2 size={15} />{clearUnsuccessful.isPending ? "正在清理" : "清理未成功记录"}</button><StatusPill tone="neutral">共 {overallTotal} 条</StatusPill></div></div>
    {replies.isError && <p className="inline-warning">回复状态暂时无法从本地服务同步，已停止显示旧状态，请稍后刷新。</p>}
    {clearCompleted.isSuccess && <p className="inline-success">已清理 {clearCompleted.data.deleted} 条已完成记录。</p>}
    {clearUnsuccessful.isSuccess && <p className="inline-success">已清理 {clearUnsuccessful.data.deleted} 条未成功记录，现在只保留发送成功记录。</p>}
    {reopenMessage && <p className="inline-success">{reopenMessage}</p>}
    {clearCompleted.error && <p className="inline-warning">清理失败，请先等待当前自动处理结束后再试。</p>}
    {clearUnsuccessful.error && <p className="inline-warning">清理失败，请先停止当前自动处理后再试。</p>}
    {removeForReprocessing.error && <p className="inline-warning">{removeForReprocessing.error.message}</p>}
    <div className="filter-bar"><label className="search-box"><Search size={18} /><input aria-label="搜索回复结果" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); setSelectedId(null); }} placeholder="搜索评论、商品、分类或回复" /></label><div className="filter-chips" aria-label="结果筛选"><FilterButton active={filter === "all"} onClick={() => { setFilter("all"); setPage(1); setSelectedId(null); }}>全部</FilterButton><FilterButton active={filter === "sent"} onClick={() => { setFilter("sent"); setPage(1); setSelectedId(null); }}>发送成功</FilterButton><FilterButton active={filter === "unsent"} onClick={() => { setFilter("unsent"); setPage(1); setSelectedId(null); }}>未发送成功</FilterButton><FilterButton active={filter === "good"} onClick={() => { setFilter("good"); setPage(1); setSelectedId(null); }}>好评</FilterButton><FilterButton active={filter === "bad"} onClick={() => { setFilter("bad"); setPage(1); setSelectedId(null); }}>差评</FilterButton><FilterButton active={filter === "attention"} onClick={() => { setFilter("attention"); setPage(1); setSelectedId(null); }}>待处理</FilterButton></div>{(filter !== "all" || query.trim()) && <span className="filter-result-count">筛选结果 {liveReplyData?.total ?? 0} 条</span>}</div>

    <div className={`replies-layout ${selected ? "has-detail" : ""}`}>
      <article className="panel table-panel reply-list-panel">
        <div className="record-table"><div className="table-head"><span>评论内容</span><span>商品</span><span>AI 类型</span><span>AI 分类</span><span>状态</span></div>{replies.isLoading ? <div className="empty-state">正在读取结果…</div> : items.length ? items.map((item) => <div className="reply-record-entry" key={item.id}><button type="button" className={`table-row reply-row ${selectedId === item.id ? "selected" : ""}`} aria-label={`查看评论详情：${item.review}`} onClick={() => setSelectedId(item.id)}><div><strong>{item.review}</strong><small>{formatDate(item.processedAt ?? item.discoveredAt)}</small></div><span>{item.product}</span><span>{item.library === "good" ? "好评" : item.library === "bad" ? "差评" : "分析中"}</span><span>{item.category || "待分类"}</span><ReplyStatus item={item} /></button><button className="record-delete-button" type="button" aria-label={`删除记录：${item.review}`} title="清理此条记录" disabled={removeForReprocessing.isPending} onClick={() => removeRecord(item)}><Trash2 size={15} /></button></div>) : <div className="empty-state polished"><Bot size={24} /><strong>{query || filter !== "all" ? "没有符合条件的结果" : "还没有回复结果"}</strong><span>{query || filter !== "all" ? "请调整搜索词或筛选条件。" : "启用自动回复或点击“立即处理一轮”后，处理结果会保存在这里。"}</span></div>}</div>
        {totalPages > 1 && <nav className="manual-pagination reply-pagination" aria-label="回复结果分页"><button className="button secondary" type="button" aria-label="上一页" disabled={currentPage <= 1 || replies.isFetching} onClick={() => { setPage(Math.max(1, currentPage - 1)); setSelectedId(null); }}>上一页</button><span>第 {currentPage} / {totalPages} 页</span><button className="button secondary" type="button" aria-label="下一页" disabled={currentPage >= totalPages || replies.isFetching} onClick={() => { setPage(Math.min(totalPages, currentPage + 1)); setSelectedId(null); }}>下一页</button></nav>}
      </article>

      {selected && <aside className="panel draft-detail" aria-label="回复详情">
        <div className="draft-detail-heading"><div><p className="eyebrow">处理记录</p><h2>回复详情</h2></div><ReplyStatus item={selected} /></div>
        <DeliveryNotice item={selected} />

        <DetailSection label="买家评论">
          <blockquote>{selected.review}</blockquote>
          <div className="detail-meta"><span>{selected.product}</span>{selected.orderId && <span>订单 {selected.orderId}</span>}{selected.reviewedAt && <span>评价时间 {selected.reviewedAt}</span>}</div>
        </DetailSection>

        <DetailSection label="分类判断">
          <div className="classification-summary"><strong>{selected.primaryCategory && selected.primaryCategory !== selected.category ? `${selected.primaryCategory} / ` : ""}{selected.category || "尚未完成"}</strong>{selected.classificationConfidence !== null && <span>{Math.round(selected.classificationConfidence * 100)}% 置信度</span>}</div>
          {selected.classificationReason && <p>{selected.classificationReason}</p>}
        </DetailSection>

        <DetailSection label={`抽中的原话术${selected.templateSequence ? ` · 第 ${selected.templateSequence} 条` : ""}`}>
          <p className="template-evidence">{selected.originalTemplate || "尚未抽取话术"}</p>
        </DetailSection>

        <DetailSection label="最终回复">
          {selected.finalReply ? <p className="final-draft"><Sparkles size={16} />{selected.finalReply}</p> : <p>{selected.errorMessage ?? pendingReplyText(selected)}</p>}
          {selected.rewriteNotes && <small>{selected.productAdjusted ? "已适配商品：" : "措辞说明："}{selected.rewriteNotes}</small>}
        </DetailSection>

        {selected.attentionReasons.length > 0 && <div className="attention-box"><AlertTriangle size={17} /><div><strong>处理说明</strong>{selected.attentionReasons.map((reason) => <span key={reason}>{reason}</span>)}</div></div>}
        {selected.errorMessage && <p className="inline-warning">{selected.errorMessage}</p>}
        {selected.state === "submission_uncertain" && <div className="attention-box"><ShieldCheck size={17} /><div><strong>已锁定等待平台同步</strong><span>系统不会重复发送；后续扫描读到平台结果后会自动更新本地状态。</span></div></div>}
        {canReprocess(selected.state) && <button className="button secondary full-button" type="button" onClick={() => reprocess.mutate(selected.id)} disabled={reprocess.isPending}><RefreshCw size={16} />{reprocess.isPending ? "正在重新生成…" : "重新生成回复"}</button>}
        <button className="button secondary full-button" type="button" disabled={removeForReprocessing.isPending} onClick={() => removeRecord(selected)}><Trash2 size={16} />{removeForReprocessing.isPending ? "正在清理…" : "清理此条记录"}</button>
        {reprocess.error && <p className="inline-warning">{reprocess.error.message}</p>}
      </aside>}
    </div>
  </section>;
}

function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return <section className="detail-section"><h3>{label}</h3>{children}</section>;
}

function ReplyStatus({ item }: { item: Reply }) {
  const { state } = item;
  if (state === "sent") return <StatusPill tone="success"><CheckCircle2 size={13} />发送成功</StatusPill>;
  if (state === "submission_uncertain") return <StatusPill tone="warning">等待平台同步</StatusPill>;
  if (state === "submitting") return <StatusPill tone="neutral">正在发送</StatusPill>;
  if (state === "read_only_ready" || state === "needs_attention") return <StatusPill tone="neutral">等待发送</StatusPill>;
  if (state === "retry_wait") return <StatusPill tone="warning">等待重试</StatusPill>;
  if (state === "manual_product_hold" || state === "not_actionable") {
    return <StatusPill tone="neutral">{skippedReviewLabel(item)}</StatusPill>;
  }
  if (item.complaintErrorKind) {
    const tone = ["configuration", "model_contract", "internal"].includes(item.complaintErrorKind) ? "danger" : "warning";
    return <StatusPill tone={tone}>{complaintFailureLabel(item.complaintErrorKind)}</StatusPill>;
  }
  if (state === "discovered") return <StatusPill tone="neutral">等待分析</StatusPill>;
  if (state === "classifying") return <StatusPill tone="neutral">正在分类</StatusPill>;
  if (state === "template_selected" || state === "rewriting") return <StatusPill tone="neutral">正在生成回复</StatusPill>;
  if (state === "failed") return <StatusPill tone="danger">处理失败</StatusPill>;
  return <StatusPill tone="neutral">处理中</StatusPill>;
}

function DeliveryNotice({ item }: { item: Reply }) {
  const { state } = item;
  const content = state === "sent"
    ? ["回复已发送并确认成功", "系统已核对平台的成功状态。"]
    : state === "submission_uncertain"
      ? ["提交结果正在等待平台同步", "系统不会重复发送，后续扫描会自动更新状态。"]
      : state === "retry_wait"
        ? [aiRetryMessage(item), "本条尚未提交，下一轮会从失败阶段继续。"]
        : state === "manual_product_hold" || state === "not_actionable"
          ? [skippedReviewLabel(item), item.errorMessage ?? "本条不会回复，也不会提交投诉。"]
          : item.complaintErrorKind
            ? [complaintFailureLabel(item.complaintErrorKind), "本条未回复、未投诉；普通评价会在下一轮自动释放，疑似违规评价会继续严格核验。"]
            : state === "failed"
          ? ["本条未发送", "处理失败后已停止提交，可在排除原因后重新生成。"]
              : state === "discovered"
              ? ["评价已读取，等待分析", "尚未完成投诉预审和好差评分类。"]
              : state === "classifying"
                ? ["正在判断评价类型", "系统正在进行投诉预审或好差评分类。"]
                : state === "template_selected" || state === "rewriting"
                  ? ["正在生成回复", "分类和话术已经确定，正在生成最终回复。"]
                  : ["回复已生成，等待自动提交", "系统会在提交前再次核对店铺、评价和页面元素。"];
  return <div className="draft-safety"><ShieldCheck size={17} /><div><strong>{content[0]}</strong><span>{content[1]}</span></div></div>;
}

function skippedReviewLabel(item: Reply): string {
  const reason = item.errorMessage ?? "";
  if (/没有可用投诉入口|平台已处理|平台未受理本次投诉/.test(reason)) return "平台已处理，无需投诉";
  if (/公众人物|明星/.test(reason)) return "公众人物评价已跳过";
  if (/已有回复|回复记录/.test(reason)) return "平台已有回复";
  if (/超期|过期|不可回复|已关闭/.test(reason)) return "平台当前不可回复";
  return "本条已跳过";
}

function complaintFailureLabel(kind: string): string {
  if (kind === "timeout") return "投诉预审超时";
  if (kind === "network") return "投诉预审连接失败";
  if (kind === "model_contract") return "投诉预审结果格式异常";
  if (kind === "configuration") return "投诉服务配置异常";
  return "投诉预审内部失败";
}

function aiRetryMessage(item: Reply): string {
  const stage = item.failedStage === "rewrite" ? "回复生成" : "评价分类";
  const reason = item.aiRetryErrorKind === "timeout"
    ? "超时"
    : item.aiRetryErrorKind === "model_contract"
      ? "返回格式不完整"
      : "暂时失败";
  return `${stage}${reason}，等待下一轮自动重试`;
}

function pendingReplyText(item: Reply): string {
  if (item.state === "retry_wait") return item.failedStage === "rewrite" ? "回复等待重新生成" : "分类尚未完成，暂未生成回复";
  if (item.state === "manual_product_hold" || item.state === "not_actionable") return item.errorMessage ?? "本条已跳过";
  if (item.complaintErrorKind) return `${complaintFailureLabel(item.complaintErrorKind)}，尚未生成回复`;
  if (item.state === "discovered" || item.state === "classifying") return "尚未生成回复";
  return "回复正在生成";
}

function canReprocess(state: string): boolean {
  return state === "failed" || state === "read_only_ready" || state === "needs_attention";
}

function replyListUrl(page: number, filter: Filter, query: string): string {
  const normalizedQuery = query.trim();
  if (page === 1 && filter === "all" && !normalizedQuery) return "/api/replies";
  const params = new URLSearchParams({
    page: String(page),
    pageSize: "50",
    filter,
    query: normalizedQuery,
  });
  return `/api/replies?${params.toString()}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={`chip ${active ? "active" : ""}`} onClick={onClick}>{children}</button>;
}
