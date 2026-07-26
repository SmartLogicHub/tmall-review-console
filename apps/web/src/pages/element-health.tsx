import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, Check, CircleAlert, Eye, History, RefreshCw, RotateCcw, ShieldCheck, X } from "lucide-react";
import { Link } from "react-router-dom";
import { apiFetch, toUserMessage } from "../api/client";
import { StatusPill } from "../components/status-pill";

type Locator = {
  operationKey: string;
  label: string;
  health: "healthy" | "recovered" | "attention";
  risk: "low" | "high";
  lastSuccessAt: string | null;
  version: number;
  statusLabel: "正常" | "已自动恢复" | "需要处理" | "运行时自动检测";
  verificationState?: "conditional" | "verified" | "attention";
};
type Repair = {
  id: string;
  operationKey: string;
  label: string;
  risk: "low" | "high";
  status: "pending_approval" | "auto_applied" | "approved" | "rejected" | "rolled_back";
  evidenceSummary: string;
  createdAt: string;
  resolvedAt: string | null;
  canRollback: boolean;
};

const repairLabel: Record<Repair["status"], string> = {
  pending_approval: "等待确认",
  auto_applied: "已自动恢复",
  approved: "已确认使用",
  rejected: "已拒绝",
  rolled_back: "已回退",
};

export function ElementHealthPage() {
  const queryClient = useQueryClient();
  const locators = useQuery({ queryKey: ["element-health"], queryFn: () => apiFetch<{ items: Locator[] }>("/api/element-health") });
  const repairs = useQuery({ queryKey: ["locator-repairs"], queryFn: () => apiFetch<{ items: Repair[]; total: number }>("/api/locator-repairs") });
  const action = useMutation({
    mutationFn: ({ id, command }: { id: string; command: "approve" | "reject" | "rollback" }) => apiFetch<Repair>(`/api/locator-repairs/${id}/${command}`, { method: "POST" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["element-health"] }),
        queryClient.invalidateQueries({ queryKey: ["locator-repairs"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
    },
  });
  const operationalCount = locators.data?.items.filter((item) => item.health !== "attention").length ?? 0;
  const recoveredCount = locators.data?.items.filter((item) => item.health === "recovered").length ?? 0;
  const needsAttention = locators.data?.items.filter((item) => item.verificationState === "attention").length ?? 0;
  const pending = repairs.data?.items.filter((item) => item.status === "pending_approval") ?? [];
  const healthUnavailable = locators.isError || repairs.isError;

  return <section className="page-content">
    <Link className="inline-link" to="/settings"><ArrowLeft size={15} />返回设置</Link>
    <div className="page-heading diagnostic-heading"><div><p className="eyebrow">异常处理中心</p><h1>自动修复与页面诊断</h1><span>平时无需配置。只有运行中识别失败时才会修复；回复框、投诉描述框和提交按钮的新识别方式需要你确认一次。</span></div><StatusPill tone={healthUnavailable || needsAttention ? "warning" : "success"}>{healthUnavailable ? "页面状态无法确认" : needsAttention ? `${needsAttention} 项需要处理` : "页面结构正常"}</StatusPill></div>
    <div className="health-summary-grid"><article className="health-summary dark"><Activity size={19} /><strong>{healthUnavailable ? "—" : `${operationalCount}/${locators.data?.items.length ?? 0}`}</strong><span>可正常识别</span></article><article className="health-summary"><Eye size={19} /><strong>{healthUnavailable ? "—" : recoveredCount}</strong><span>已自动恢复</span></article><article className="health-summary"><History size={19} /><strong>{repairs.isError ? "—" : repairs.data?.total ?? 0}</strong><span>修复记录</span></article></div>
      <div className="safety-callout"><ShieldCheck size={20} /><div><strong>单条异常不阻断后续处理</strong><span>退款、投诉和处罚的纯通知浮层会自动关闭；不会点击“处理、确认、同意、拒绝、退款、申诉”等业务按钮。验证码和安全验证仍由你完成。</span></div></div>

    {healthUnavailable && <div className="health-unavailable" role="alert"><CircleAlert size={19} /><div><strong>页面状态无法确认</strong><span>部分页面检查信息读取失败，自动回复不会把未知状态当作正常。</span></div><button className="button secondary compact" type="button" onClick={() => void Promise.all([locators.refetch(), repairs.refetch()])}><RefreshCw size={15} />重新检测</button></div>}

    {pending.length > 0 && <article className="panel approval-panel">
      <div className="panel-heading"><div><p className="eyebrow">需要你的确认</p><h3>回复控件发生变化，需要确认</h3></div><StatusPill tone="warning">{pending.length} 项待确认</StatusPill></div>
      <div className="repair-list">{pending.map((repair) => <div className="repair-row" key={repair.id}><span className="health-icon"><CircleAlert size={17} /></span><div><strong>{repair.label}</strong><small>系统已在真实页面完成安全检查，请确认这是当前页面的正确操作位置。</small><details className="repair-technical-details"><summary>查看技术验证详情</summary><small>{repair.evidenceSummary}</small></details></div><div className="repair-actions"><button className="button primary compact" type="button" onClick={() => action.mutate({ id: repair.id, command: "approve" })}><Check size={15} />确认新的识别方式</button><button className="button secondary compact" type="button" onClick={() => action.mutate({ id: repair.id, command: "reject" })}><X size={15} />暂不使用</button></div></div>)}</div>
      {action.error && <p className="inline-warning"><CircleAlert size={16} />{toUserMessage(action.error, "页面修复操作失败，请稍后重试")}</p>}
    </article>}

    <article className="panel locator-panel"><div className="panel-heading"><div><p className="eyebrow">页面识别</p><h3>当前检查项</h3></div><span className="panel-note">未出现的弹窗和投诉控件属于正常状态，系统会在真正需要时检测。</span></div><div className="diagnostic-list">{locators.isLoading ? <div className="empty-state">正在检查页面识别状态…</div> : locators.isError ? <div className="empty-state">页面检查信息暂时无法读取，请重新检测。</div> : locators.data?.items.map((item) => {
      const conditional = item.verificationState === "conditional";
      return <div className="diagnostic-row" key={item.operationKey}><span className="health-icon">{item.verificationState === "attention" ? <CircleAlert size={17} /> : conditional ? <Eye size={17} /> : <ShieldCheck size={17} />}</span><div><strong>{item.label}</strong><small>{item.lastSuccessAt ? `最近识别：${new Date(item.lastSuccessAt).toLocaleString("zh-CN")}` : conditional && item.operationKey.startsWith("complaint.") ? "仅在实际进入投诉流程时按需检测，不会阻止正常评价处理" : conditional ? "将在实际运行到这一步时自动检测" : "尚无最近识别时间"}</small></div><StatusPill tone={item.verificationState === "attention" ? "warning" : conditional ? "neutral" : "success"}>{item.statusLabel}</StatusPill></div>;
    })}</div></article>

    {repairs.data?.items.some((item) => item.status !== "pending_approval") && <article className="panel repair-history"><div className="panel-heading"><div><p className="eyebrow">历史记录</p><h3>最近修复</h3></div></div><div className="diagnostic-list">{repairs.data.items.filter((item) => item.status !== "pending_approval").map((repair) => <div className="diagnostic-row" key={repair.id}><span className="health-icon"><History size={17} /></span><div><strong>{repair.label}</strong><small>{repair.evidenceSummary}</small></div><div className="history-action"><StatusPill tone={repair.status === "rejected" ? "neutral" : "success"}>{repairLabel[repair.status]}</StatusPill>{repair.canRollback && <button className="text-button" type="button" onClick={() => action.mutate({ id: repair.id, command: "rollback" })}><RotateCcw size={14} />回退</button>}</div></div>)}</div></article>}
  </section>;
}
