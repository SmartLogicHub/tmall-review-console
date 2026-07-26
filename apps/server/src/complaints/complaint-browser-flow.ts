import { COMPLAINT_TYPES, type ComplaintTypeCode } from "./complaint-domain";
import type { TmallReviewPhase } from "../tmall/review-reader";

export type ComplaintActionLabel = "投诉评价" | "投诉追评";
export type ComplaintFlowMode = "prepare_only" | "submit";

export interface ComplaintFlowTarget {
  sourceKey: string;
  reviewPhase: TmallReviewPhase;
}

export interface ComplaintOfficialTypeOption {
  id: string;
  label: string;
}

export interface ComplaintSubmitControl {
  id: string;
  label: string;
}

export interface ComplaintSafetySentinels {
  chatAuthorizationChecked: boolean | null;
  attachmentCount: number | null;
}

export interface ComplaintSubmissionEvidence {
  accepted: boolean;
  /** The submit click produced no visible navigation or acceptance state. */
  remainsOnComplaintPage?: boolean;
  platformCaseId?: string | null;
  detailUrl?: string | null;
}

/**
 * A dialog adapter is deliberately limited to the complaint dialog. It has no
 * capability for chat authorization, evidence upload, or arbitrary page clicks.
 */
export interface ComplaintDialogAdapter {
  listOfficialTypes(): Promise<readonly ComplaintOfficialTypeOption[]>;
  selectOfficialType(id: string): Promise<void>;
  readSelectedOfficialType(): Promise<ComplaintOfficialTypeOption | null>;
  readSafetySentinels(): Promise<ComplaintSafetySentinels>;
  fillDescription(value: string): Promise<void>;
  readDescription(): Promise<string>;
  listSubmitControls(): Promise<readonly ComplaintSubmitControl[]>;
  /**
   * Persists the one-way submit checkpoint immediately before the single
   * platform click. It is intentionally absent from prepare-only mode.
   */
  beforeSubmitClick?(): Promise<void>;
  clickSubmit(id: string): Promise<void>;
  readSubmissionEvidence(): Promise<ComplaintSubmissionEvidence>;
  /** Closes the unchanged complaint panel before processing the next review. */
  closeComplaintDialog(): Promise<void>;
}

/**
 * The caller supplies an already target-scoped adapter. It must only resolve
 * the current review row and open the exact complaint action requested here.
 */
export interface ComplaintTargetAdapter {
  resolveVerifiedTarget(target: ComplaintFlowTarget): Promise<{
    sourceKey: string;
    reviewPhase: TmallReviewPhase;
    openComplaint(action: ComplaintActionLabel): Promise<ComplaintDialogAdapter>;
  } | null>;
}

export type ComplaintBrowserFlowResult =
  | { state: "prepared"; actionLabel: ComplaintActionLabel }
  | { state: "sent"; actionLabel: ComplaintActionLabel; platformCaseId?: string; detailUrl?: string }
  | { state: "already_handled"; actionLabel: ComplaintActionLabel; reason: string }
  | { state: "uncertain"; actionLabel: ComplaintActionLabel; reason: string }
  | { state: "failed_before_click"; actionLabel: ComplaintActionLabel; reason: string }
  | { state: "failed"; actionLabel: ComplaintActionLabel; reason: string };

export function complaintActionForPhase(reviewPhase: TmallReviewPhase): ComplaintActionLabel {
  return reviewPhase === "initial" ? "投诉评价" : "投诉追评";
}

export function officialComplaintTypeName(type: ComplaintTypeCode): string {
  const definition = COMPLAINT_TYPES.find((item) => item.code === type);
  if (!definition) throw new Error("投诉类型不在官方映射中");
  return definition.name;
}

export function isOfficialComplaintSubmitLabel(value: string): boolean {
  return value.normalize("NFKC").trim() === "提交";
}

function validStableEvidence(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safetySentinelsPass(value: ComplaintSafetySentinels): boolean {
  return value.chatAuthorizationChecked === false && value.attachmentCount === 0;
}

function selectedTypeMatches(
  expected: ComplaintOfficialTypeOption,
  selected: ComplaintOfficialTypeOption | null,
): boolean {
  return selected !== null && selected.id === expected.id && selected.label.normalize("NFKC").trim() === expected.label.normalize("NFKC").trim();
}

export async function executeComplaintBrowserFlow(input: {
  target: ComplaintFlowTarget;
  complaintType: ComplaintTypeCode;
  description: string;
  mode: ComplaintFlowMode;
  adapter: ComplaintTargetAdapter;
}): Promise<ComplaintBrowserFlowResult> {
  const actionLabel = complaintActionForPhase(input.target.reviewPhase);
  const expectedTypeLabel = officialComplaintTypeName(input.complaintType);
  if (!input.description.trim()) return { state: "failed", actionLabel, reason: "投诉描述不能为空" };

  let target: Awaited<ReturnType<ComplaintTargetAdapter["resolveVerifiedTarget"]>>;
  try {
    target = await input.adapter.resolveVerifiedTarget(input.target);
  } catch {
    return { state: "failed", actionLabel, reason: "无法确认当前投诉目标" };
  }
  if (!target || target.sourceKey !== input.target.sourceKey || target.reviewPhase !== input.target.reviewPhase) {
    return { state: "failed", actionLabel, reason: "当前评价与待投诉目标不一致" };
  }

  let dialog: ComplaintDialogAdapter;
  try {
    dialog = await target.openComplaint(actionLabel);
  } catch {
    return { state: "failed", actionLabel, reason: "无法打开投诉页面" };
  }

  let sentinels: ComplaintSafetySentinels;
  try {
    sentinels = await dialog.readSafetySentinels();
  } catch {
    return { state: "failed", actionLabel, reason: "无法确认投诉页面安全状态" };
  }
  if (!safetySentinelsPass(sentinels)) {
    return { state: "failed", actionLabel, reason: "安全哨兵未通过：聊天授权已勾选或投诉凭证不为空" };
  }

  let typeOptions: readonly ComplaintOfficialTypeOption[];
  try {
    typeOptions = await dialog.listOfficialTypes();
  } catch {
    return { state: "failed", actionLabel, reason: "无法读取官方投诉类型" };
  }
  const matchingTypes = typeOptions.filter((option) => option.label.normalize("NFKC").trim() === expectedTypeLabel.normalize("NFKC").trim());
  if (matchingTypes.length !== 1) return { state: "failed", actionLabel, reason: "官方投诉类型无法唯一识别" };
  const selectedOption = matchingTypes[0]!;

  try {
    await dialog.selectOfficialType(selectedOption.id);
    if (!selectedTypeMatches(selectedOption, await dialog.readSelectedOfficialType())) {
      return { state: "failed", actionLabel, reason: "页面投诉类型与案件类型不一致" };
    }
    await dialog.fillDescription(input.description);
    if (await dialog.readDescription() !== input.description) {
      return { state: "failed", actionLabel, reason: "投诉描述回读校验失败" };
    }
    if (!safetySentinelsPass(await dialog.readSafetySentinels())) {
      return { state: "failed", actionLabel, reason: "安全哨兵未通过：聊天授权已勾选或投诉凭证不为空" };
    }
  } catch {
    return { state: "failed", actionLabel, reason: "投诉页面填写或校验失败" };
  }

  let submitControls: readonly ComplaintSubmitControl[];
  try {
    submitControls = await dialog.listSubmitControls();
  } catch {
    return { state: "failed_before_click", actionLabel, reason: "无法读取投诉提交按钮" };
  }
  const submitCandidates = submitControls.filter((control) => isOfficialComplaintSubmitLabel(control.label));
  if (submitCandidates.length !== 1) return { state: "failed_before_click", actionLabel, reason: "投诉提交按钮无法唯一识别" };

  if (input.mode === "prepare_only") return { state: "prepared", actionLabel };

  try {
    await dialog.beforeSubmitClick?.();
  } catch {
    return { state: "failed_before_click", actionLabel, reason: "投诉提交前检查未通过" };
  }

  try {
    await dialog.clickSubmit(submitCandidates[0]!.id);
  } catch {
    return { state: "uncertain", actionLabel, reason: "提交点击后结果无法确认" };
  }

  try {
    const evidence = await dialog.readSubmissionEvidence();
    if (!evidence.accepted) {
      if (evidence.remainsOnComplaintPage !== true) return { state: "uncertain", actionLabel, reason: "平台未明确确认已受理" };
      try {
        await dialog.closeComplaintDialog();
      } catch {
        return { state: "uncertain", actionLabel, reason: "投诉提交后仍停留在投诉界面，但无法安全关闭" };
      }
      return { state: "already_handled", actionLabel, reason: "投诉提交后仍停留在投诉界面，平台可能已处理该用户违规" };
    }
    if (!validStableEvidence(evidence.platformCaseId) && !validStableEvidence(evidence.detailUrl)) {
      return { state: "uncertain", actionLabel, reason: "平台未提供稳定案件标识" };
    }
    return {
      state: "sent",
      actionLabel,
      ...(validStableEvidence(evidence.platformCaseId) ? { platformCaseId: evidence.platformCaseId } : {}),
      ...(validStableEvidence(evidence.detailUrl) ? { detailUrl: evidence.detailUrl } : {}),
    };
  } catch {
    return { state: "uncertain", actionLabel, reason: "提交点击后结果无法确认" };
  }
}
