import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { differenceInCalendarDays, format, subDays } from "date-fns";
import { zhCN } from "date-fns/locale";
import { CalendarDays, Check, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/style.css";
import { ApiError, apiFetch, toUserMessage } from "../api/client";

export type ReviewScopePreset = "today" | "yesterday" | "last7" | "last30" | "custom";
export type ReviewProcessingMode = "followup_only" | "content_unanswered";

export type ReviewScopeView = {
  preset: ReviewScopePreset;
  startDate: string | null;
  endDate: string | null;
  effectiveStartDate: string;
  effectiveEndDate: string;
  timezone: "Asia/Shanghai";
  revision: number;
  summary: string;
  processingMode: ReviewProcessingMode;
};

type ReviewScopeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: ReactElement;
};

type SelectionStep = "start" | "end" | "complete";

const shortcuts: Array<{ preset: Exclude<ReviewScopePreset, "custom">; label: string; days: number; endOffset: number }> = [
  { preset: "today", label: "今天", days: 1, endOffset: 0 },
  { preset: "yesterday", label: "昨天", days: 1, endOffset: 1 },
  { preset: "last7", label: "近7天", days: 7, endOffset: 0 },
  { preset: "last30", label: "近30天", days: 30, endOffset: 0 },
];

export const processingModeOptions: Array<{
  value: ReviewProcessingMode;
  label: string;
  description: string;
}> = [
  { value: "followup_only", label: "只处理追评", description: "仅处理仍可回复的追评" },
  { value: "content_unanswered", label: "有内容未回复", description: "处理有文字且尚未回复的初评和追评" },
];

export function reviewProcessingModeLabel(mode: ReviewProcessingMode | undefined): string {
  return processingModeOptions.find((item) => item.value === mode)?.label ?? "有内容未回复";
}

function parseCalendarDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, month! - 1, day!, 12);
}

function shanghaiToday(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
  return new Date(part("year"), part("month") - 1, part("day"), 12);
}

function formatCalendarDate(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

export function validateCustomDateRange(from: Date, to: Date): string | null {
  const inclusiveDays = Math.abs(differenceInCalendarDays(to, from)) + 1;
  return inclusiveDays > 90 ? "处理日期最多可选择90天" : null;
}

function shortcutRange(days: number, endOffset: number): DateRange {
  const end = subDays(shanghaiToday(), endOffset);
  return { from: subDays(end, days - 1), to: end };
}

function initialRange(scope: ReviewScopeView): DateRange {
  return {
    from: parseCalendarDate(scope.effectiveStartDate),
    to: parseCalendarDate(scope.effectiveEndDate),
  };
}

function useNarrowCalendar(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 820px)");
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return narrow;
}

export function ReviewScopeDialog({ open, onOpenChange, trigger }: ReviewScopeDialogProps) {
  const queryClient = useQueryClient();
  const narrow = useNarrowCalendar();
  const scope = useQuery({
    queryKey: ["review-scope"],
    queryFn: () => apiFetch<ReviewScopeView>("/api/review-scope"),
    enabled: open,
  });
  const [preset, setPreset] = useState<ReviewScopePreset>("last7");
  const [processingMode, setProcessingMode] = useState<ReviewProcessingMode>("content_unanswered");
  const [range, setRange] = useState<DateRange | undefined>();
  const [selectionStep, setSelectionStep] = useState<SelectionStep>("complete");
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => shanghaiToday());
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [conflictLocked, setConflictLocked] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const previousOpen = useRef(open);
  const initialFocus = useRef<HTMLButtonElement>(null);

  const loadScope = (value: ReviewScopeView) => {
    const nextRange = initialRange(value);
    setPreset(value.preset);
    setProcessingMode(value.processingMode ?? "content_unanswered");
    setRange(nextRange);
    setVisibleMonth(nextRange.from ?? shanghaiToday());
    setSelectionStep("complete");
    setRangeError(null);
    setDirty(false);
    setBaseRevision(value.revision);
    setConflictLocked(false);
    setRefreshError(null);
  };

  useEffect(() => {
    if (open && scope.data && !dirty) loadScope(scope.data);
  }, [open, scope.data, dirty]);

  const save = useMutation({
    mutationFn: async () => {
      if (baseRevision === null) throw new Error("处理日期尚未加载，请稍后重试");
      const custom = preset === "custom" && range?.from && range.to
        ? { startDate: formatCalendarDate(range.from), endDate: formatCalendarDate(range.to) }
        : {};
      return apiFetch<ReviewScopeView>("/api/review-scope", {
        method: "PUT",
        body: JSON.stringify({ preset, ...custom, processingMode, expectedRevision: baseRevision }),
      });
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData(["review-scope"], saved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["automation-status"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      setDirty(false);
      onOpenChange(false);
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === "review_scope_changed") {
        setConflictLocked(true);
        await queryClient.invalidateQueries({ queryKey: ["review-scope"] });
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

  const conflict = conflictLocked || (save.error instanceof ApiError && save.error.code === "review_scope_changed");
  const errorMessage = refreshError ?? (conflict
    ? "处理范围已在其他页面更新，请刷新后重新选择"
    : save.error ? toUserMessage(save.error, "处理范围保存失败，请稍后重试") : rangeError);
  const customComplete = preset !== "custom" || Boolean(range?.from && range.to && !rangeError);
  const canSave = baseRevision !== null && customComplete && !conflictLocked && !save.isPending;
  const selectionMessage = useMemo(() => {
    if (preset !== "custom") return range?.from && range.to ? `${formatCalendarDate(range.from)} 至 ${formatCalendarDate(range.to)}` : "请选择处理日期";
    if (selectionStep === "start") return "请选择开始日期";
    if (selectionStep === "end") return "请选择结束日期";
    return range?.from && range.to ? `${formatCalendarDate(range.from)} 至 ${formatCalendarDate(range.to)}` : "请选择开始日期";
  }, [preset, range, selectionStep]);

  const chooseShortcut = (item: (typeof shortcuts)[number]) => {
    const nextRange = shortcutRange(item.days, item.endOffset);
    setPreset(item.preset);
    setRange(nextRange);
    setVisibleMonth(nextRange.from ?? shanghaiToday());
    setSelectionStep("complete");
    setRangeError(null);
    setDirty(true);
    if (!conflictLocked) save.reset();
  };

  const chooseCustom = () => {
    setPreset("custom");
    setRange(undefined);
    setVisibleMonth(shanghaiToday());
    setSelectionStep("start");
    setRangeError(null);
    setDirty(true);
    if (!conflictLocked) save.reset();
  };

  const chooseDay = (day: Date) => {
    setPreset("custom");
    setDirty(true);
    if (!conflictLocked) save.reset();
    if (selectionStep !== "end" || !range?.from) {
      setRange({ from: day, to: undefined });
      setSelectionStep("end");
      setRangeError(null);
      return;
    }
    const from = day < range.from ? day : range.from;
    const to = day < range.from ? range.from : day;
    const validation = validateCustomDateRange(from, to);
    if (validation) {
      setRangeError(validation);
      return;
    }
    setRange({ from, to });
    setSelectionStep("complete");
    setRangeError(null);
  };

  const refreshLatest = async () => {
    setRefreshError(null);
    const latest = await scope.refetch();
    if (latest.isSuccess && latest.data) {
      loadScope(latest.data);
      save.reset();
      return;
    }
    setRefreshError("处理日期刷新失败，请重试");
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!save.isPending) onOpenChange(next); }}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content review-scope-dialog" aria-describedby="review-scope-description" onOpenAutoFocus={(event) => {
          const target = initialFocus.current;
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}>
          <header className="dialog-header">
            <div className="dialog-title-lockup"><span><CalendarDays size={20} /></span><div><Dialog.Title>选择处理日期</Dialog.Title><Dialog.Description id="review-scope-description">按中国标准时间筛选本轮需要处理的未回复评价。</Dialog.Description></div></div>
            <Dialog.Close asChild><button className="icon-button" type="button" aria-label="关闭日期设置" disabled={save.isPending}><X size={18} /></button></Dialog.Close>
          </header>
          <div className="dialog-scroll-body">
            {scope.isPending && !scope.data && (
              <div className="dialog-load-state" role="status">
                <LoaderCircle className="spin" size={18} />
                <span>正在读取处理日期</span>
              </div>
            )}
            {scope.isError && !scope.data && (
              <div className="dialog-load-state error" role="alert">
                <span>处理日期读取失败，请检查本地服务后重试</span>
                <button type="button" onClick={() => void refreshLatest()}><RefreshCw size={14} />重新读取处理日期</button>
              </div>
            )}
            {scope.data && <>
            <section className="scope-mode-section" aria-labelledby="scope-mode-title">
              <div className="scope-mode-heading">
                <strong id="scope-mode-title">处理评价类型</strong>
                <span>选择后，手动运行和自动计划都会使用此范围</span>
              </div>
              <div className="scope-mode-options" role="radiogroup" aria-label="处理评价类型">
                {processingModeOptions.map((item) => (
                  <button
                    key={item.value}
                    className={processingMode === item.value ? "scope-mode-option active" : "scope-mode-option"}
                    type="button"
                    role="radio"
                    aria-label={item.label}
                    aria-checked={processingMode === item.value}
                    onClick={() => {
                      setProcessingMode(item.value);
                      setDirty(true);
                      setRefreshError(null);
                    }}
                  >
                    <span>{item.label}</span>
                    <small>{item.description}</small>
                  </button>
                ))}
              </div>
            </section>
            <div className="scope-shortcuts" aria-label="日期快捷选项">
              {shortcuts.map((item) => <button ref={item.preset === "today" ? initialFocus : undefined} key={item.preset} className={preset === item.preset ? "scope-chip active" : "scope-chip"} type="button" onClick={() => chooseShortcut(item)}>{item.label}</button>)}
              <button className={preset === "custom" ? "scope-chip active" : "scope-chip"} type="button" onClick={chooseCustom}>自定义日期</button>
            </div>
            <div className="scope-selection-status" aria-live="polite"><span>{selectionMessage}</span><small>最长90天 · 中国标准时间</small></div>
            <DayPicker
              key={`${narrow ? 1 : 2}`}
              className="scope-calendar"
              mode="range"
              month={visibleMonth}
              onMonthChange={setVisibleMonth}
              numberOfMonths={narrow ? 1 : 2}
              selected={range}
              onDayClick={chooseDay}
              max={89}
              locale={zhCN}
              showOutsideDays
              labels={{
                labelDayButton: (date) => formatCalendarDate(date),
                labelNext: () => "下个月",
                labelPrevious: () => "上个月",
              }}
            />
            <p className="dialog-note">自动回复正在运行时，新的评价类型和处理日期会从下一轮开始生效，本轮范围不会改变。</p>
            {errorMessage && <div className="dialog-error" role="alert"><span>{errorMessage}</span>{conflict && <button type="button" onClick={() => void refreshLatest()}><RefreshCw size={14} />刷新最新日期</button>}</div>}
            </>}
          </div>
          <footer className="dialog-footer">
            <Dialog.Close asChild><button className="button secondary" type="button" disabled={save.isPending}>取消</button></Dialog.Close>
            <button className="button primary" type="button" disabled={!canSave} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{save.isPending ? "正在保存" : "保存处理范围"}</button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
