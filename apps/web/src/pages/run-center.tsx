import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpenText, Bot, CalendarClock, Check, CircleAlert, Cloud, LogIn, Pause, Play, RotateCcw, ShieldCheck, Square, UsersRound } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, toUserMessage } from "../api/client";
import { AutomationPlanDialog } from "../components/automation-plan-dialog";
import { MetricCard } from "../components/metric-card";
import { ReviewScopeDialog, reviewProcessingModeLabel, type ReviewScopeView } from "../components/review-scope-dialog";
import { StatusPill } from "../components/status-pill";

type AutomationState = "disabled" | "waiting" | "running" | "paused" | "stopping" | "manual_action_required" | "error";
type AutomationStatus = {
  state: AutomationState;
  trigger: "scheduled" | "manual" | null;
  currentWindow: { id: string; start: string; end: string } | null;
  nextRunAt: string | null;
  currentStep: string;
  startedAt: string | null;
  processed: number;
  succeeded: number;
  manual: number;
  failed: number;
  reviewScope: { preset: string; startDate: string; endDate: string; timezone: "Asia/Shanghai"; summary: string; processingMode: ReviewScopeView["processingMode"] } | null;
  currentReview: { review: string; product: string } | null;
  currentReply: string | null;
  plan: { enabled: boolean; paused: boolean; timezone: "Asia/Shanghai"; intervalMinutes: number; windows: Array<{ id: string; start: string; end: string }>; revision: number };
  lastRun: { processed: number; succeeded: number; manual: number; failed: number; finishedAt: string | null; scope: AutomationStatus["reviewScope"] } | null;
};
type Reply = { id: string; review: string; product: string; library: "good" | "bad" | null; category: string; state: string; errorCode: string | null; finalReply: string };
type Dashboard = {
  metrics: { todayRead: number; good: number; bad: number; generated: number; sent: number; failed: number; productEdits: number };
  health: Record<string, string>;
  queue: Reply[];
  recent: Reply | null;
  templates: Array<{ library: "good" | "bad"; state: "ready" | "usable_with_warning" | "not_ready"; usable: boolean; activeVersion: number | null; categoryCount: number; replyCount: number; latestSyncStatus: string; latestSyncAt: string | null; warning: string | null; message: string }>;
  readiness: { ready: boolean; missing: string[] };
  manualProducts?: { total: number; diverted: number };
};
type LocatorRepairs = {
  items: Array<{ risk: "low" | "high"; status: string; createdAt?: string }>;
};

const stateLabel: Record<AutomationState, string> = {
  disabled: "自动计划未启用",
  waiting: "等待下一次运行",
  running: "正在处理评论",
  paused: "自动回复已暂停",
  stopping: "完成当前评论后停止",
  manual_action_required: "需要人工处理",
  error: "运行遇到问题",
};

function formatMoment(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function queueStatus(item: Reply): {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger" | "rose";
} {
  if (item.state === "sent") return { label: "已回复", tone: "success" };
  if (item.state === "retry_wait") return { label: "等待重试", tone: "warning" };
  if (item.state === "failed") return { label: "已跳过", tone: "warning" };
  if (item.state === "manual_product_hold") return { label: "名单跳过", tone: "rose" };
  if (item.state === "not_actionable") {
    if (item.errorCode === "TMALL_REPLY_ALREADY_RECORDED") {
      return { label: "平台已回复", tone: "success" };
    }
    if (item.errorCode?.includes("PLATFORM")) {
      return { label: "平台已处理", tone: "success" };
    }
    return { label: "无需处理", tone: "neutral" };
  }
  if (item.state === "submitting" || item.state === "submission_uncertain") {
    return { label: item.state === "submitting" ? "正在提交" : "提交待核对", tone: "warning" };
  }
  if (item.state === "read_only_ready" || item.state === "needs_attention") {
    return { label: item.state === "read_only_ready" ? "待提交" : "待核验", tone: "neutral" };
  }
  return { label: "处理中", tone: "neutral" };
}

export function RunCenter() {
  const queryClient = useQueryClient();
  const [scopeDialogOpen, setScopeDialogOpen] = useState(false);
  const [planDialogSource, setPlanDialogSource] = useState<"action" | "summary" | null>(null);
  const runtime = useQuery({ queryKey: ["automation-status"], queryFn: () => apiFetch<AutomationStatus>("/api/automation/status"), refetchInterval: 3_000 });
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: () => apiFetch<Dashboard>("/api/dashboard"), refetchInterval: 3_000 });
  const reviewScope = useQuery({ queryKey: ["review-scope"], queryFn: () => apiFetch<ReviewScopeView>("/api/review-scope") });
  const locatorRepairs = useQuery({ queryKey: ["locator-repairs-summary"], queryFn: () => apiFetch<LocatorRepairs>("/api/locator-repairs"), refetchInterval: 10_000 });
  const control = useMutation({
    mutationFn: (action: "start-now" | "pause" | "resume" | "recheck-and-continue" | "stop") => apiFetch<AutomationStatus>(`/api/automation/${action}`, { method: "POST" }),
    onSuccess: async (data) => {
      queryClient.setQueryData(["automation-status"], data);
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const status = runtime.data;
  const current = status?.state ?? "disabled";
  const metrics = dashboard.data?.metrics;
  const dashboardLoading = dashboard.isLoading && !dashboard.data;
  const ready = dashboard.data?.readiness.ready ?? false;
  const missing = dashboard.data?.readiness.missing ?? [];
  const isRunning = current === "running" || current === "stopping";
  const activeRunScope = ["running", "paused", "stopping", "manual_action_required"].includes(current)
    && status?.startedAt
    && status.reviewScope
    ? status.reviewScope
    : null;
  const displayedScope = activeRunScope ?? reviewScope.data;
  const runtimeNeedsElementHelp = current === "manual_action_required"
    && /页面元素|回复控件|识别方式/u.test(status?.currentStep ?? "");
  const elementException = locatorRepairs.data?.items.some((item) => item.risk === "high" && item.status === "pending_approval")
    ? "approval"
    : runtimeNeedsElementHelp
      ? "attention"
      : null;

  return (
    <section className="page-content workbench-page">
      <div className="page-heading">
        <div><p className="eyebrow">自动回复</p><h1>评论处理工作台</h1><span>按计划自动处理完整的未回复队列，也可以随时手动运行一轮。</span></div>
        <StatusPill tone={current === "running" ? "success" : current === "error" || current === "manual_action_required" ? "warning" : "neutral"}>{stateLabel[current]}</StatusPill>
      </div>

      {!dashboardLoading && !ready && (
        <article className="setup-banner">
          <div className="setup-copy"><span className="setup-icon"><CircleAlert size={20} /></span><div><strong>启用前还需完成必要配置</strong><p>{missing.length ? `${missing.join("、")} 尚未就绪。` : "正在检查配置状态。"}完成后即可启用自动回复。</p></div></div>
          <Link className="button primary" to={missing.some((item) => item.includes("话术")) ? "/templates" : "/settings"}>去完成配置 <ArrowRight size={16} /></Link>
        </article>
      )}

      {dashboard.data?.templates.filter((item) => item.state === "usable_with_warning").map((item) => (
        <article className="inline-warning template-health-warning" key={item.library}>
          <CircleAlert size={16} /><span>{item.warning ?? "最近一次同步未完成，当前仍使用已验证的话术版本"}</span>。可前往话术库重新同步。
        </article>
      ))}

      <article className="scope-toolbar" aria-label="本轮处理范围">
        <div className="scope-toolbar-copy">
          <span className="scope-toolbar-icon"><CalendarClock size={19} /></span>
          <div><strong>本轮处理范围</strong><small>{activeRunScope ? "当前运行使用此范围；修改将在下一次运行生效" : "手动运行和自动计划共用此范围"}</small></div>
        </div>
        <div className="scope-toolbar-actions">
          <Link className="manual-product-scope-link" to="/manual-products" aria-label={`自动跳过商品 · ${dashboard.data?.manualProducts?.total ?? 0}`}>
            <UsersRound size={17} /><span>自动跳过商品</span><strong>· {dashboard.data?.manualProducts?.total ?? 0}</strong>
          </Link>
          <ReviewScopeDialog
            open={scopeDialogOpen}
            onOpenChange={setScopeDialogOpen}
            trigger={<button type="button" className="scope-summary-button" aria-label="修改本轮处理范围"><span>评价范围</span><strong>{displayedScope ? `${reviewProcessingModeLabel(displayedScope.processingMode)} · ${displayedScope.summary}` : "正在读取…"}</strong><ArrowRight size={16} /></button>}
          />
        </div>
      </article>

      <article className="hero-control product-hero automation-hero" aria-label="自动化控制区">
        <div className="hero-copy">
          <span className="hero-kicker"><ShieldCheck size={16} />自动回复控制</span>
          <h2>{stateLabel[current]}</h2>
          <p>{current === "disabled" ? (dashboardLoading ? "正在检查淘宝、话术库和 DeepSeek…" : ready ? "可立即处理一轮，或前往设置添加自动运行时间。" : "完成配置后即可开始") : status?.currentStep}</p>
          <div className="automation-command-panel">
            <div className="automation-command-actions">
              {["disabled", "waiting", "error"].includes(current) && <button className="automation-launch-button" aria-label="立即处理一轮" onClick={() => control.mutate("start-now")} disabled={control.isPending || !ready}><span className="automation-launch-icon"><Play size={20} fill="currentColor" /></span><span><strong>立即处理一轮</strong><small>{ready ? "开始自动处理未回复评价" : "完成必要配置后即可启动"}</small></span><ArrowRight size={19} /></button>}
              {current === "running" && <button className="automation-launch-button running" aria-label="暂停处理" onClick={() => control.mutate("pause")} disabled={control.isPending}><span className="automation-launch-icon"><Pause size={20} fill="currentColor" /></span><span><strong>暂停处理</strong><small>会在安全边界暂停当前流程</small></span><ArrowRight size={19} /></button>}
              {current === "paused" && <button className="automation-launch-button" aria-label="继续处理" onClick={() => control.mutate("resume")} disabled={control.isPending || !ready}><span className="automation-launch-icon"><RotateCcw size={20} /></span><span><strong>继续处理</strong><small>从已暂停的安全位置继续</small></span><ArrowRight size={19} /></button>}
              {current === "manual_action_required" && <button className="automation-launch-button warning" aria-label="重新检测并继续" onClick={() => control.mutate("recheck-and-continue")} disabled={control.isPending}><span className="automation-launch-icon"><RotateCcw size={20} /></span><span><strong>重新检测并继续</strong><small>核对异常后恢复自动处理</small></span><ArrowRight size={19} /></button>}
              {(["running", "paused", "stopping", "manual_action_required"].includes(current) || (current === "waiting" && Boolean(status?.plan.enabled))) && <button className="automation-stop-button" onClick={() => control.mutate("stop")} disabled={control.isPending || current === "stopping"}><Square size={15} />停止并关闭计划</button>}
            </div>
            <div className="automation-command-footer">
              <span className="automation-safety-note"><ShieldCheck size={15} />投诉仅在已开启自动提交且通过全部校验后才会提交。</span>
              <AutomationPlanDialog
                open={planDialogSource === "action"}
                onOpenChange={(open) => setPlanDialogSource(open ? "action" : null)}
                trigger={<button className="automation-plan-command" type="button" aria-label="设置自动时间"><CalendarClock size={16} />设置自动时间</button>}
              />
            </div>
          </div>
          {/* A previous button request can fail while the scheduled run has
              already started. Do not leave that stale generic error beside a
              live status; the current step is the authoritative message. */}
          {control.error && !isRunning && <p className="inline-warning"><CircleAlert size={16} />{toUserMessage(control.error, "自动回复操作失败，请稍后重试")}</p>}
        </div>
        <AutomationPlanDialog
          open={planDialogSource === "summary"}
          onOpenChange={(open) => setPlanDialogSource(open ? "summary" : null)}
          trigger={<button type="button" className="automation-summary" aria-label="编辑自动计划">
            <div><span>当前时间段</span><strong>{status?.currentWindow ? `${status.currentWindow.start}–${status.currentWindow.end}` : "暂无"}</strong></div>
            <div><span>下次运行</span><strong>{formatMoment(status?.nextRunAt ?? null)}</strong></div>
            <div><span>运行间隔</span><strong>{status?.plan.intervalMinutes ?? 15} 分钟</strong></div>
          </button>}
        />
      </article>

      {status?.currentReview && ["running", "stopping", "paused", "manual_action_required"].includes(current) && <article className="panel current-review-panel"><div><p className="eyebrow">当前评价</p><h3>{status.currentReview.review}</h3><span>{status.currentReview.product}</span></div><div><p className="eyebrow">生成回复</p><p>{status.currentReply || "正在生成并进行安全校验…"}</p></div></article>}

      <div className="readiness-grid">
      <ReadinessCard loading={dashboardLoading} icon={<LogIn size={18} />} label="淘宝商家" detail={dashboardLoading ? "正在检查登录状态" : dashboard.data?.health.tmall === "authenticated" ? "登录已验证，掉线自动恢复" : "账号已保存，运行时自动检查"} ready={["authenticated", "configured"].includes(dashboard.data?.health.tmall ?? "")} to="/settings" />
        <ReadinessCard loading={dashboardLoading} icon={<BookOpenText size={18} />} label="好评话术库" detail={dashboardLoading ? "正在读取话术库状态" : templateDetail(dashboard.data?.templates, "good")} ready={templateUsable(dashboard.data?.templates, "good")} stateText={dashboardLoading ? "检测中" : templateStateText(dashboard.data?.templates, "good")} to="/templates" />
        <ReadinessCard loading={dashboardLoading} icon={<Cloud size={18} />} label="差评话术库" detail={dashboardLoading ? "正在读取话术库状态" : templateDetail(dashboard.data?.templates, "bad")} ready={templateUsable(dashboard.data?.templates, "bad")} stateText={dashboardLoading ? "检测中" : templateStateText(dashboard.data?.templates, "bad")} to="/templates" />
        <ReadinessCard loading={dashboardLoading} icon={<Bot size={18} />} label="DeepSeek" detail={dashboardLoading ? "正在检查连接状态" : "评论分类与商品信息修正"} ready={dashboard.data?.health.deepseek === "ready"} to="/settings" />
        {elementException && <ElementExceptionCard state={elementException} />}
      </div>

      <div className="metric-grid">
        <MetricCard label={isRunning || status?.lastRun ? "最近一轮处理" : "累计处理"} value={isRunning ? status?.processed ?? 0 : status?.lastRun?.processed ?? metrics?.todayRead ?? "—"} detail="条评论" tone="ink" />
        <MetricCard label="发送成功" value={isRunning ? status?.succeeded ?? 0 : status?.lastRun?.succeeded ?? metrics?.sent ?? "—"} detail="已确认回复" />
        <MetricCard label="处理失败" value={isRunning ? status?.failed ?? 0 : status?.lastRun?.failed ?? metrics?.failed ?? "—"} detail="已安全跳过" />
        <MetricCard label="名单跳过" value={isRunning ? status?.manual ?? 0 : status?.lastRun?.manual ?? dashboard.data?.manualProducts?.diverted ?? "—"} detail="不回复、不投诉" tone="rose" />
      </div>

      <article className="panel queue-panel">
        <div className="panel-heading"><div><p className="eyebrow">处理记录</p><h3>最近评论</h3></div><Link className="text-button" to="/replies">查看全部 <ArrowRight size={15} /></Link></div>
        {dashboard.isLoading ? <div className="empty-state">正在读取处理状态…</div> : dashboard.data?.queue.length ? (
          <div className="queue-list">{dashboard.data.queue.map((item) => {
            const status = queueStatus(item);
            return <div className="queue-row" key={item.id}><span className={`library-mark ${item.library ?? "neutral"}`} /><div className="queue-review"><strong>{item.review}</strong><span>{item.product}</span></div><div><small>{item.category}</small><StatusPill tone={status.tone}>{status.label}</StatusPill></div></div>;
          })}</div>
        ) : <div className="empty-state polished"><Bot size={24} /><strong>还没有处理记录</strong><span>{dashboardLoading ? "正在检查运行条件…" : ready ? "点击“立即处理一轮”，新评论会显示在这里。" : "完成登录、话术库和 DeepSeek 配置后即可开始。"}</span></div>}
      </article>
    </section>
  );
}

function templateDetail(items: Dashboard["templates"] | undefined, library: "good" | "bad") {
  const item = items?.find((candidate) => candidate.library === library);
  if (!item?.usable) return "链接与内容尚未同步";
  return item.state === "usable_with_warning"
    ? `${item.categoryCount} 个分类 · ${item.replyCount} 条话术 · 最近同步需关注`
    : `${item.categoryCount} 个分类 · ${item.replyCount} 条话术`;
}

function templateUsable(items: Dashboard["templates"] | undefined, library: "good" | "bad") {
  return items?.find((item) => item.library === library)?.usable ?? false;
}

function templateStateText(items: Dashboard["templates"] | undefined, library: "good" | "bad") {
  const state = items?.find((item) => item.library === library)?.state;
  return state === "ready" ? "正常" : state === "usable_with_warning" ? "需关注" : "不可用";
}

function ReadinessCard({ icon, label, detail, ready, loading = false, to, notReadyLabel = "去配置", stateText }: { icon: React.ReactNode; label: string; detail: string; ready: boolean; loading?: boolean; to: string; notReadyLabel?: string; stateText?: string }) {
  return <Link className={`readiness-card ${ready ? "ready" : ""} ${loading ? "loading" : ""}`} to={to}><span className="readiness-icon">{icon}</span><div><strong>{label}</strong><small>{detail}</small></div><span className="readiness-state">{loading ? "检测中" : stateText ?? (ready ? <><Check size={15} />已就绪</> : <>{notReadyLabel} <ArrowRight size={14} /></>)}</span></Link>;
}

function ElementExceptionCard({ state }: { state: "approval" | "attention" }) {
  const content = state === "approval"
    ? { detail: "回复控件发生变化，需要确认新的识别方式", action: "去确认" }
    : { detail: "自动检查发现页面变化，已暂停等待处理", action: "查看处理" };
  return <Link className={`readiness-card element-exception ${state}`} to="/health"><span className="readiness-icon"><ShieldCheck size={18} /></span><div><strong>页面检查提醒</strong><small>{content.detail}</small></div><span className="readiness-state">{content.action} <ArrowRight size={14} /></span></Link>;
}
