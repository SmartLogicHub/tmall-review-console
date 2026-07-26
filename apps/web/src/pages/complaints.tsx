import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ClipboardList, FileSearch, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { apiFetch } from "../api/client";
import { StatusPill } from "../components/status-pill";

type ComplaintState =
  | "discovered" | "analyzing" | "no_complaint" | "prepared" | "submitting" | "submitted"
  | "under_review" | "upheld" | "rejected" | "closed" | "not_actionable"
  | "submission_uncertain" | "retry_wait" | "manual_action_required" | "failed";

type ComplaintRecord = {
  id: string;
  state: ComplaintState;
  complaintType: string | null;
  quote: string | null;
  review: string | null;
  product: string | null;
  reviewedAt: string | null;
  reason: string | null;
  factDescription: string | null;
  description: string | null;
  phase: "initial" | "followup" | null;
  createdAt: string;
  updatedAt: string;
};

type ComplaintSummary = {
  total: number;
  unresolved: number;
  submitted?: number;
  upheld?: number;
  rejected?: number;
};

const COMPLAINT_TYPE_NAMES: Record<string, string> = {
  purchase_a_review_b: "购买A商品评价B商品",
  meaningless_content: "评价内容无意义",
  insulting_content: "辱骂侮辱的评论",
  privacy_leak: "评论泄露隐私",
  advertising_content: "评价内容为广告信息",
  political_terror_sensitive: "涉政暴恐等敏感信息",
  vulgar_sexual_content: "低俗色情",
  prohibited_goods: "毒品枪支等违禁品",
  minor_harmful_content: "涉未成年人",
  extortion_for_improper_benefit: "利用中差评索取不当利益",
  fake_review_before_receipt: "未收到货但给出与商品实际不符的虚假评价",
  fake_or_online_image: "评价使用虚假或网络图片",
  competitor_malicious_review: "同行恶意中差评",
};

export function ComplaintsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  const cases = useQuery({
    queryKey: ["complaints"],
    queryFn: () => apiFetch<{ items: ComplaintRecord[]; total: number }>("/api/complaints"),
    refetchInterval: 10_000,
  });
  const summary = useQuery({
    queryKey: ["complaint-summary"],
    queryFn: () => apiFetch<ComplaintSummary>("/api/complaints/status-summary"),
    refetchInterval: 10_000,
  });
  const selected = useMemo(() => cases.data?.items.find((item) => item.id === selectedId) ?? null, [cases.data, selectedId]);
  const detail = useQuery({
    queryKey: ["complaint", selectedId],
    queryFn: () => apiFetch<ComplaintRecord>(`/api/complaints/${selectedId}`),
    enabled: Boolean(selectedId),
  });
  const record = detail.data ?? selected;
  const removeRecord = useMutation({
    mutationFn: (id: string) => apiFetch<{ removed: true; mode: "reprocess" | "completed" | "reply_pending"; reprocessable: boolean }>(`/api/complaints/${id}`, { method: "DELETE" }),
    onSuccess: async (result) => {
      setSelectedId(null);
      setCleanupMessage(result.mode === "completed"
        ? "投诉记录已清理，仅保留防重复标记，不会再次投诉。"
        : result.mode === "reply_pending"
          ? "投诉历史已清理；该评价仍待回复，后续回复流程不受影响。"
          : "投诉记录已删除，下次运行会重新判断并处理该评价。");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["complaints"] }),
        queryClient.invalidateQueries({ queryKey: ["complaint-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["replies"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["storage"] }),
      ]);
    },
  });
  const requestRemove = (item: ComplaintRecord) => {
    const completed = ["submitted", "under_review", "upheld", "rejected", "closed", "not_actionable"].includes(item.state);
    const prompt = completed
      ? "这条投诉已有平台提交或处理结果。清理后仅保留不可见的防重复标记，不会再次投诉。确定清理吗？"
      : "确定删除这条本地投诉记录吗？如果尚未成功提交，下次运行会重新判断并处理这条评价。";
    if (!window.confirm(prompt)) return;
    setCleanupMessage(null);
    removeRecord.mutate(item.id);
  };

  return <section className="page-content complaints-page">
    <div className="page-heading complaints-heading">
      <div><p className="eyebrow">平台投诉</p><h1>投诉记录</h1><span>查看已发起投诉的类型、描述和平台处理进度；本页仅供查询，不会再次提交。</span></div>
      <button className="button secondary" type="button" onClick={() => { void Promise.all([cases.refetch(), summary.refetch()]); }} disabled={cases.isFetching || summary.isFetching}>
        <RefreshCw size={16} className={cases.isFetching || summary.isFetching ? "spin" : undefined} />刷新记录
      </button>
    </div>

    {cleanupMessage && <p className="inline-success">{cleanupMessage}</p>}
    {removeRecord.error && <p className="inline-warning">{removeRecord.error.message}</p>}

    <div className="complaint-stat-grid" aria-label="投诉概览">
      <Metric label="真实投诉" value={summary.data?.total ?? cases.data?.total ?? 0} />
      <Metric label="待平台处理" value={summary.data?.unresolved ?? 0} tone="warning" />
      <Metric label="投诉成立" value={summary.data?.upheld ?? 0} tone="success" />
      <Metric label="投诉未成立" value={summary.data?.rejected ?? 0} />
    </div>

    {cases.isError ? <article className="panel complaint-failure" role="alert"><AlertTriangle size={20} /><div><strong>投诉记录暂时无法读取</strong><span>请检查本地服务后重新刷新。本页不会显示技术错误详情。</span></div></article> : <div className={`complaints-layout ${record ? "has-detail" : ""}`}>
      <article className="panel complaint-list-panel">
        <div className="complaint-list-head"><div><strong>投诉列表</strong><span>共 {cases.data?.total ?? 0} 条</span></div><span>仅显示需投诉或待核对事项</span></div>
        {cases.isLoading ? <div className="empty-state"><RefreshCw className="spin" size={22} />正在读取投诉记录…</div> : cases.data?.items.length ? <div className="complaint-record-list">
          {cases.data.items.map((item) => <div className="complaint-record-entry" key={item.id}><button type="button" className={`complaint-record-row ${selectedId === item.id ? "selected" : ""}`} onClick={() => setSelectedId(item.id)} aria-label={`查看投诉记录：${complaintSummary(item)}`}>
            <div className="complaint-record-main"><span className="complaint-phase">{phaseLabel(item.phase)}</span><strong>{complaintSummary(item)}</strong>{item.product ? <small>商品：{item.product}</small> : null}<small>更新于 {formatDate(item.updatedAt)}</small></div>
            <div className="complaint-record-type"><span>{typeName(item.complaintType)}</span><ComplaintStatus state={item.state} /></div>
          </button><button className="record-delete-button" type="button" aria-label={`删除投诉记录：${complaintSummary(item)}`} title="清理此条投诉记录" disabled={removeRecord.isPending} onClick={() => requestRemove(item)}><Trash2 size={15} /></button></div>)}
        </div> : <div className="empty-state polished complaint-empty"><ClipboardList size={26} /><strong>暂时没有投诉记录</strong><span>系统只会在评价符合投诉条件时创建记录；普通评价仍按回复流程处理。</span></div>}
      </article>

      {record && <aside className="panel complaint-detail" aria-label="投诉详情">
        {detail.isLoading ? <div className="empty-state compact">正在读取投诉详情…</div> : <>
          <div className="draft-detail-heading"><div><p className="eyebrow">平台投诉</p><h2>投诉详情</h2></div><ComplaintStatus state={record.state} /></div>
          <ComplaintNotice state={record.state} />
          <ComplaintSection title="买家评价原文"><blockquote>{record.review?.trim() || record.quote?.trim() || "评价原文暂时无法读取。"}</blockquote><div className="detail-meta"><span>{phaseLabel(record.phase)}</span>{record.reviewedAt ? <span>评价时间 {record.reviewedAt}</span> : null}<span>创建于 {formatDate(record.createdAt)}</span></div></ComplaintSection>
          <ComplaintSection title="商品信息"><p className="complaint-description">{record.product?.trim() || "商品信息暂时无法读取。"}</p></ComplaintSection>
          <ComplaintSection title="投诉判断原因"><p className="complaint-description">{record.reason?.trim() || "正在核对评价是否符合官方投诉场景。"}</p></ComplaintSection>
          <ComplaintSection title="官方投诉类型"><strong className="complaint-type-name">{typeName(record.complaintType)}</strong></ComplaintSection>
          <ComplaintSection title="投诉事实依据"><p className="complaint-description">{record.factDescription?.trim() || "正在核对可验证的客观事实。"}</p></ComplaintSection>
          <ComplaintSection title="投诉描述"><p className="complaint-description">{record.description?.trim() || "投诉描述尚未生成。"}</p></ComplaintSection>
          <ComplaintSection title="平台处理结果"><PlatformOutcome state={record.state} /><div className="detail-meta"><span>最后更新 {formatDate(record.updatedAt)}</span></div></ComplaintSection>
          <button className="button secondary full-button" type="button" disabled={removeRecord.isPending} onClick={() => requestRemove(record)}><Trash2 size={16} />{removeRecord.isPending ? "正在清理…" : "清理此条记录"}</button>
        </>}
      </aside>}
    </div>}
  </section>;
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" }) {
  return <div className={`complaint-stat ${tone ?? ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function ComplaintSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="detail-section"><h3>{title}</h3>{children}</section>;
}

function ComplaintStatus({ state }: { state: ComplaintState }) {
  if (state === "submission_uncertain") return <StatusPill tone="warning">等待平台同步</StatusPill>;
  if (state === "manual_action_required") return <StatusPill tone="warning">需要人工处理</StatusPill>;
  if (state === "upheld") return <StatusPill tone="success">投诉成立</StatusPill>;
  if (state === "rejected") return <StatusPill tone="danger">投诉未成立</StatusPill>;
  if (state === "submitted" || state === "under_review") return <StatusPill tone="neutral">平台处理中</StatusPill>;
  if (state === "failed") return <StatusPill tone="danger">暂未提交</StatusPill>;
  if (state === "no_complaint" || state === "not_actionable" || state === "closed") return <StatusPill tone="neutral">无需投诉</StatusPill>;
  return <StatusPill tone="neutral">准备中</StatusPill>;
}

function ComplaintNotice({ state }: { state: ComplaintState }) {
  const content = state === "submission_uncertain"
    ? "平台尚未返回明确结果。系统已锁定该条避免重复投诉，并会在后续扫描中自动同步平台状态。"
    : state === "manual_action_required"
      ? "当前缺少继续处理所需的安全条件，请完成页面验证后继续。"
    : state === "upheld" ? "平台已确认投诉成立。"
      : state === "rejected" ? "平台已确认该投诉未成立。"
        : state === "submitted" || state === "under_review" ? "投诉已提交，正在等待平台处理结果。"
          : "该记录仍在准备或核对中。";
  return <div className="draft-safety complaint-notice"><ShieldAlert size={17} /><div><strong>{state === "submission_uncertain" ? "已锁定等待平台同步" : state === "manual_action_required" ? "需要完成页面验证" : "处理说明"}</strong><span>{content}</span></div></div>;
}

function PlatformOutcome({ state }: { state: ComplaintState }) {
  const content = state === "upheld" ? "平台已确认投诉成立。"
    : state === "rejected" ? "平台已确认投诉未成立。"
      : state === "submission_uncertain" ? "提交结果暂未明确，系统会自动同步且不会重复提交。"
        : state === "manual_action_required" ? "等待完成页面安全验证。"
        : state === "submitted" || state === "under_review" ? "平台处理中，暂未返回最终结果。"
          : state === "failed" ? "本次尚未提交到平台。"
            : "暂无平台处理结果。";
  return <p className="complaint-outcome"><FileSearch size={16} />{content}</p>;
}

function phaseLabel(phase: ComplaintRecord["phase"]): string {
  return phase === "followup" ? "追评投诉" : "初评投诉";
}

function typeName(type: string | null): string {
  return type ? COMPLAINT_TYPE_NAMES[type] ?? "待选择官方投诉类型" : "尚未形成投诉类型";
}

function complaintSummary(item: ComplaintRecord): string {
  const value = item.review?.trim() || item.quote?.trim();
  if (!value) return "投诉评价待平台核对";
  return Array.from(value).length > 60 ? `${Array.from(value).slice(0, 60).join("")}…` : value;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
