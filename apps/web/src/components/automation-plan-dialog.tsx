import * as Dialog from "@radix-ui/react-dialog";
import * as Switch from "@radix-ui/react-switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, LoaderCircle, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ApiError, apiFetch, toUserMessage } from "../api/client";

export type ScheduleWindowView = { id: string; start: string; end: string };
export type AutomationPlanView = {
  enabled: boolean;
  paused: boolean;
  timezone: "Asia/Shanghai";
  intervalMinutes: number;
  windows: ScheduleWindowView[];
  revision: number;
};

type AutomationPlanDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: ReactElement;
};

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}

function minutesToTime(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function validateAutomationDraft(enabled: boolean, intervalMinutes: number, windows: readonly ScheduleWindowView[]): string | null {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 120) return "运行间隔必须在1到120分钟之间";
  if (windows.length > 6) return "每天最多可设置6个时间段";
  if (enabled && windows.length === 0) return "启用自动回复时至少需要1个时间段";
  const normalized = windows.map((window) => {
    if (!timePattern.test(window.start) || !timePattern.test(window.end)) return null;
    return { ...window, startMinute: timeToMinutes(window.start), endMinute: timeToMinutes(window.end) };
  });
  if (normalized.some((window) => window === null)) return "请填写有效的开始和结束时间";
  const complete = normalized as Array<ScheduleWindowView & { startMinute: number; endMinute: number }>;
  if (complete.some((window) => window.endMinute <= window.startMinute)) return "结束时间必须晚于开始时间";
  const sorted = [...complete].sort((left, right) => left.startMinute - right.startMinute);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.startMinute < sorted[index - 1]!.endMinute) return "时间段不能重叠";
  }
  return null;
}

function nextWindow(windows: readonly ScheduleWindowView[]): ScheduleWindowView {
  const sorted = [...windows].sort((left, right) => timeToMinutes(left.end) - timeToMinutes(right.end));
  const lastEnd = sorted.length ? timeToMinutes(sorted.at(-1)!.end) : 8 * 60;
  const startMinute = lastEnd <= 22 * 60 ? lastEnd : 8 * 60;
  return {
    id: `window-${Date.now()}-${windows.length + 1}`,
    start: minutesToTime(startMinute),
    end: minutesToTime(startMinute + 60),
  };
}

export function AutomationPlanDialog({ open, onOpenChange, trigger }: AutomationPlanDialogProps) {
  const queryClient = useQueryClient();
  const plan = useQuery({
    queryKey: ["automation-plan"],
    queryFn: () => apiFetch<AutomationPlanView>("/api/automation-plan"),
    enabled: open,
  });
  const [enabled, setEnabled] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(15);
  const [windows, setWindows] = useState<ScheduleWindowView[]>([]);
  const [dirty, setDirty] = useState(false);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [conflictLocked, setConflictLocked] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const previousOpen = useRef(open);
  const initialFocus = useRef<HTMLButtonElement>(null);

  const loadPlan = (value: AutomationPlanView) => {
    setEnabled(value.enabled);
    setIntervalMinutes(value.intervalMinutes);
    setWindows(value.windows.map((window) => ({ ...window })));
    setDirty(false);
    setBaseRevision(value.revision);
    setConflictLocked(false);
    setRefreshError(null);
  };

  useEffect(() => {
    if (open && plan.data && !dirty) loadPlan(plan.data);
  }, [open, plan.data, dirty]);

  const validationError = useMemo(() => validateAutomationDraft(enabled, intervalMinutes, windows), [enabled, intervalMinutes, windows]);
  const save = useMutation({
    mutationFn: async () => {
      if (baseRevision === null) throw new Error("自动计划尚未加载，请稍后重试");
      if (validationError) throw new Error(validationError);
      return apiFetch<AutomationPlanView>("/api/automation-plan", {
        method: "PUT",
        body: JSON.stringify({ enabled, intervalMinutes, windows, expectedRevision: baseRevision }),
      });
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData(["automation-plan"], saved);
      queryClient.setQueryData(["automation-status"], (current: unknown) => {
        if (!current || typeof current !== "object") return current;
        return { ...(current as Record<string, unknown>), plan: saved };
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["automation-status"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      setDirty(false);
      onOpenChange(false);
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === "automation_plan_changed") {
        setConflictLocked(true);
        await queryClient.invalidateQueries({ queryKey: ["automation-plan"] });
      }
    },
  });

  useEffect(() => {
    if (previousOpen.current && !open) {
      setDirty(false);
      setConflictLocked(false);
      setRefreshError(null);
      save.reset();
    }
    previousOpen.current = open;
  }, [open]);

  const conflict = conflictLocked || (save.error instanceof ApiError && save.error.code === "automation_plan_changed");
  const saveError = refreshError ?? (conflict
    ? "自动计划已在其他页面更新，请刷新后重新设置"
    : save.error ? toUserMessage(save.error, "自动计划保存失败，请稍后重试") : null);
  const canSave = baseRevision !== null && !validationError && !conflictLocked && !save.isPending;

  const edit = (callback: () => void) => {
    callback();
    setDirty(true);
    if (!conflictLocked) save.reset();
  };

  const updateWindow = (id: string, field: "start" | "end", value: string) => edit(() => {
    setWindows((current) => current.map((window) => window.id === id ? { ...window, [field]: value } : window));
  });

  const refreshLatest = async () => {
    setRefreshError(null);
    const latest = await plan.refetch();
    if (latest.isSuccess && latest.data) {
      loadPlan(latest.data);
      save.reset();
      return;
    }
    setRefreshError("自动计划刷新失败，请重试");
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!save.isPending) onOpenChange(next); }}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content automation-plan-dialog" aria-describedby="automation-plan-description" onOpenAutoFocus={(event) => {
          const target = initialFocus.current;
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}>
          <header className="dialog-header">
            <div className="dialog-title-lockup"><span><CalendarClock size={20} /></span><div><Dialog.Title>设置自动运行时间</Dialog.Title><Dialog.Description id="automation-plan-description">在每天的指定时间段内运行，每轮完成后按统一间隔再次检查。</Dialog.Description></div></div>
            <Dialog.Close asChild><button className="icon-button" type="button" aria-label="关闭自动计划设置" disabled={save.isPending}><X size={18} /></button></Dialog.Close>
          </header>
          <div className="dialog-scroll-body">
            {plan.isPending && !plan.data && (
              <div className="dialog-load-state" role="status">
                <LoaderCircle className="spin" size={18} />
                <span>正在读取自动计划</span>
              </div>
            )}
            {plan.isError && !plan.data && (
              <div className="dialog-load-state error" role="alert">
                <span>自动计划读取失败，请检查本地服务后重试</span>
                <button type="button" onClick={() => void refreshLatest()}><RefreshCw size={14} />重新读取自动计划</button>
              </div>
            )}
            {plan.data && <>
            <div className="plan-switch-row">
              <div><strong>启用自动回复计划</strong><span>关闭后保留已填写的时间段，方便以后重新启用。</span></div>
              <Switch.Root ref={initialFocus} className="switch-root" checked={enabled} onCheckedChange={(checked) => edit(() => setEnabled(checked))} aria-label="启用自动回复计划"><Switch.Thumb className="switch-thumb" /></Switch.Root>
            </div>

            <section className="plan-section" aria-labelledby="schedule-window-title">
              <div className="plan-section-heading"><div><h3 id="schedule-window-title">每日时间段</h3><p>相邻时间可以连续，时间段不能重叠，也不支持跨天。</p></div><span>{windows.length} / 6</span></div>
              <div className="schedule-window-list dialog-window-list">
                {windows.map((window, index) => (
                  <div className="schedule-window-row" key={window.id}>
                    <span className="schedule-index">{String(index + 1).padStart(2, "0")}</span>
                    <label><span>开始</span><input aria-label={`时间段${index + 1}开始时间`} type="time" value={window.start} onChange={(event) => updateWindow(window.id, "start", event.target.value)} /></label>
                    <i>至</i>
                    <label><span>结束</span><input aria-label={`时间段${index + 1}结束时间`} type="time" value={window.end} onChange={(event) => updateWindow(window.id, "end", event.target.value)} /></label>
                    <button className="icon-button" type="button" aria-label={`删除时间段${index + 1}`} onClick={() => edit(() => setWindows((current) => current.filter((item) => item.id !== window.id)))}><Trash2 size={16} /></button>
                  </div>
                ))}
                {windows.length === 0 && <div className="schedule-empty"><CalendarClock size={21} /><div><strong>没有自动运行时间</strong><span>计划关闭时仍可以在工作台立即处理一轮。</span></div></div>}
              </div>
              <div className="window-actions">
                <button className="text-button add-window" type="button" disabled={windows.length >= 6} onClick={() => edit(() => setWindows((current) => [...current, nextWindow(current)]))}><Plus size={16} />添加时间段</button>
                {windows.length > 0 && <button className="text-button quiet-clear" type="button" onClick={() => edit(() => { setWindows([]); setEnabled(false); })}><Trash2 size={15} />清空全部并关闭</button>}
              </div>
            </section>

            <section className="plan-section compact-plan-section" aria-labelledby="interval-title">
              <div><h3 id="interval-title">运行间隔</h3><p>从上一轮完整结束后开始计算，范围1至120分钟。</p></div>
              <label className="field interval-field"><span>间隔分钟数</span><input aria-label="运行间隔（分钟）" type="number" min={1} max={120} value={intervalMinutes} onChange={(event) => edit(() => setIntervalMinutes(Number(event.target.value)))} /></label>
            </section>

            <p className="dialog-note">每页20条只是淘宝分页大小。每轮会继续处理范围内全部未回复评价，并检查运行期间新进入的评价。</p>
            {(validationError || saveError) && <div className="dialog-error" role="alert"><span>{saveError ?? validationError}</span>{conflict && <button type="button" onClick={() => void refreshLatest()}><RefreshCw size={14} />刷新最新计划</button>}</div>}
            </>}
          </div>
          <footer className="dialog-footer">
            <Dialog.Close asChild><button className="button secondary" type="button" disabled={save.isPending}>取消</button></Dialog.Close>
            <button className="button primary" type="button" disabled={!canSave} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{save.isPending ? "正在保存" : "保存自动计划"}</button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
