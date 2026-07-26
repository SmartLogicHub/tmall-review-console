import { describe, expect, it } from "vitest";
import {
  complaintActionForPhase,
  executeComplaintBrowserFlow,
  type ComplaintDialogAdapter,
  type ComplaintTargetAdapter,
} from "./complaint-browser-flow";

const description = "该评价内容为“测试原文”。经核对，测试事实，符合“评价内容无意义”场景。请平台结合评价内容及相关信息审核，并屏蔽处理，谢谢。";

function dialog(overrides: Partial<ComplaintDialogAdapter> = {}): ComplaintDialogAdapter & { actions: string[]; description: string } {
  const actions: string[] = [];
  let currentDescription = "";
  return {
    actions,
    get description() { return currentDescription; },
    listOfficialTypes: async () => [{ id: "meaningless", label: "评价内容无意义" }],
    selectOfficialType: async (id) => { actions.push(`type:${id}`); },
    readSelectedOfficialType: async () => ({ id: "meaningless", label: "评价内容无意义" }),
    readSafetySentinels: async () => ({ chatAuthorizationChecked: false, attachmentCount: 0 }),
    fillDescription: async (value) => { actions.push("fill"); currentDescription = value; },
    readDescription: async () => currentDescription,
    listSubmitControls: async () => [{ id: "submit", label: "提交" }],
    clickSubmit: async (id) => { actions.push(`submit:${id}`); },
    readSubmissionEvidence: async () => ({ accepted: true, platformCaseId: "case-1" }),
    closeComplaintDialog: async () => { actions.push("close"); },
    ...overrides,
  };
}

function targetAdapter(expectedPhase: "initial" | "followup", targetDialog: ComplaintDialogAdapter): ComplaintTargetAdapter {
  const actions = targetDialog.actions;
  return {
    resolveVerifiedTarget: async (target) => ({
      sourceKey: target.sourceKey,
      reviewPhase: expectedPhase,
      openComplaint: async (actionLabel) => { actions.push(`open:${actionLabel}`); return targetDialog; },
    }),
  };
}

describe("complaint browser flow", () => {
  it("uses 投诉评价 only for an initial review and stops before clicking in prepare-only mode", async () => {
    const targetDialog = dialog();
    const result = await executeComplaintBrowserFlow({
      target: { sourceKey: "tmall:1:initial", reviewPhase: "initial" },
      complaintType: "meaningless_content",
      description,
      mode: "prepare_only",
      adapter: targetAdapter("initial", targetDialog),
    });

    expect(complaintActionForPhase("initial")).toBe("投诉评价");
    expect(result).toEqual({ state: "prepared", actionLabel: "投诉评价" });
    expect(targetDialog.actions).toEqual(["open:投诉评价", "type:meaningless", "fill"]);
    expect(targetDialog.description).toBe(description);
  });

  it("requires one exact submit control during prepare-only verification without clicking it", async () => {
    const targetDialog = dialog({
      listSubmitControls: async () => [
        { id: "submit-1", label: "提交" },
        { id: "submit-2", label: "提交" },
      ],
    });
    const result = await executeComplaintBrowserFlow({
      target: { sourceKey: "tmall:1:initial", reviewPhase: "initial" },
      complaintType: "meaningless_content",
      description,
      mode: "prepare_only",
      adapter: targetAdapter("initial", targetDialog),
    });

    expect(result).toEqual({ state: "failed_before_click", actionLabel: "投诉评价", reason: "投诉提交按钮无法唯一识别" });
    expect(targetDialog.actions).not.toContain("submit:submit-1");
    expect(targetDialog.actions).not.toContain("submit:submit-2");
  });

  it("uses 投诉追评 only for a follow-up review and submits one uniquely matched official type", async () => {
    const targetDialog = dialog();
    const result = await executeComplaintBrowserFlow({
      target: { sourceKey: "tmall:1:followup", reviewPhase: "followup" },
      complaintType: "meaningless_content",
      description,
      mode: "submit",
      adapter: targetAdapter("followup", targetDialog),
    });

    expect(complaintActionForPhase("followup")).toBe("投诉追评");
    expect(result).toEqual({ state: "sent", actionLabel: "投诉追评", platformCaseId: "case-1" });
    expect(targetDialog.actions).toEqual(["open:投诉追评", "type:meaningless", "fill", "submit:submit"]);
  });

  it("closes the unchanged complaint page and skips the review after a submit click has no effect", async () => {
    const targetDialog = dialog({
      readSubmissionEvidence: async () => ({ accepted: false, remainsOnComplaintPage: true }),
      closeComplaintDialog: async () => { targetDialog.actions.push("close"); },
    });
    const result = await executeComplaintBrowserFlow({
      target: { sourceKey: "tmall:handled:initial", reviewPhase: "initial" },
      complaintType: "meaningless_content",
      description,
      mode: "submit",
      adapter: targetAdapter("initial", targetDialog),
    });

    expect(result).toEqual({
      state: "already_handled",
      actionLabel: "投诉评价",
      reason: "投诉提交后仍停留在投诉界面，平台可能已处理该用户违规",
    });
    expect(targetDialog.actions).toEqual(["open:投诉评价", "type:meaningless", "fill", "submit:submit", "close"]);
  });

  it("fails closed without mutating a pre-checked chat authorization or existing evidence", async () => {
    const targetDialog = dialog({
      readSafetySentinels: async () => ({ chatAuthorizationChecked: true, attachmentCount: 1 }),
    });
    const result = await executeComplaintBrowserFlow({
      target: { sourceKey: "tmall:2:initial", reviewPhase: "initial" },
      complaintType: "meaningless_content",
      description,
      mode: "submit",
      adapter: targetAdapter("initial", targetDialog),
    });

    expect(result).toEqual({ state: "failed", actionLabel: "投诉评价", reason: "安全哨兵未通过：聊天授权已勾选或投诉凭证不为空" });
    expect(targetDialog.actions).toEqual(["open:投诉评价"]);
  });

  it("fails before clicking when the official type is ambiguous or the description readback differs", async () => {
    const targetDialog = dialog({
      listOfficialTypes: async () => [
        { id: "one", label: "评价内容无意义" },
        { id: "two", label: "评价内容无意义" },
      ],
    });
    const result = await executeComplaintBrowserFlow({
      target: { sourceKey: "tmall:3:initial", reviewPhase: "initial" },
      complaintType: "meaningless_content",
      description,
      mode: "submit",
      adapter: targetAdapter("initial", targetDialog),
    });

    expect(result).toEqual({ state: "failed", actionLabel: "投诉评价", reason: "官方投诉类型无法唯一识别" });
    expect(targetDialog.actions).toEqual(["open:投诉评价"]);
  });

  it("marks the outcome uncertain when the click throws and never retries it", async () => {
    const targetDialog = dialog({
      clickSubmit: async () => { throw new Error("connection lost"); },
    });
    const result = await executeComplaintBrowserFlow({
      target: { sourceKey: "tmall:4:initial", reviewPhase: "initial" },
      complaintType: "meaningless_content",
      description,
      mode: "submit",
      adapter: targetAdapter("initial", targetDialog),
    });

    expect(result).toEqual({ state: "uncertain", actionLabel: "投诉评价", reason: "提交点击后结果无法确认" });
    expect(targetDialog.actions).toEqual(["open:投诉评价", "type:meaningless", "fill"]);
  });

  it("requires a stable platform case identifier or detail link after clicking", async () => {
    const targetDialog = dialog({
      readSubmissionEvidence: async () => ({ accepted: true }),
    });
    const result = await executeComplaintBrowserFlow({
      target: { sourceKey: "tmall:5:initial", reviewPhase: "initial" },
      complaintType: "meaningless_content",
      description,
      mode: "submit",
      adapter: targetAdapter("initial", targetDialog),
    });

    expect(result).toEqual({ state: "uncertain", actionLabel: "投诉评价", reason: "平台未提供稳定案件标识" });
  });
});
