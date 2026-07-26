import type { Locator, Page } from "patchright";
import type {
  ComplaintActionLabel,
  ComplaintDialogAdapter,
  ComplaintOfficialTypeOption,
  ComplaintSafetySentinels,
  ComplaintSubmissionEvidence,
  ComplaintSubmitControl,
  ComplaintTargetAdapter,
} from "./complaint-browser-flow";
import type { TmallReviewPhase } from "../tmall/review-reader";
import { COMPLAINT_TYPES } from "./complaint-domain";

/**
 * The Tmall review list does not expose an immutable source key in its public
 * DOM. The driver therefore supplies the identity it extracted from the same
 * row. A `data-review-source-key` is accepted only for controlled test pages
 * and future first-party markup; otherwise the adapter deliberately fails
 * closed rather than guessing from buyer-visible text.
 */
export interface TmallComplaintRowIdentity {
  sourceKey: string;
  reviewPhase: TmallReviewPhase;
}

export interface TmallComplaintDomAdapterOptions {
  identifyRow?: (scope: Locator, rowIndex: number, reviewPhase: TmallReviewPhase) => Promise<TmallComplaintRowIdentity | null>;
  /** Called only after every browser readback succeeds and immediately before submit. */
  beforeSubmitClick?: () => Promise<void>;
  click?: (locator: Locator) => Promise<void>;
  fill?: (locator: Locator, value: string) => Promise<void>;
}

const COMPLAINT_ACTIONS: Readonly<Record<TmallReviewPhase, ComplaintActionLabel>> = {
  initial: "投诉评价",
  followup: "投诉追评",
};

const CONTROL_SELECTOR = "button, a[href], [role='button'], input[type='button'], input[type='submit']";
const COMPLAINT_CLOSE_SELECTOR = ".next-dialog-close, .next-dialog-close-btn, [aria-label*='关闭'], [title*='关闭'], [data-testid*='close' i]";
const TMALL_COMPLAINT_FRAME_SELECTOR = "#shop-external-modal";
const TMALL_COMPLAINT_FRAME_CLOSE_SELECTOR = "#shop-external-modal > .modal-content > span.close";
const EDITOR_SELECTOR = "textarea, [contenteditable='true'], [role='textbox']";
const ATTACHMENT_SELECTOR = "[data-attachment], .upload-list-item, .next-upload-list-item, .next-upload-picture-card-item, [data-testid*='attachment' i]";

function normalized(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/gu, "").trim();
}

function phaseForAction(action: ComplaintActionLabel): TmallReviewPhase {
  return action === "投诉评价" ? "initial" : "followup";
}

async function visible(candidates: readonly Locator[]): Promise<Locator[]> {
  const result: Locator[] = [];
  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) result.push(candidate);
  }
  return result;
}

async function interactiveText(locator: Locator): Promise<string> {
  const [text, aria, title, value] = await Promise.all([
    locator.innerText().catch(() => ""),
    locator.getAttribute("aria-label").catch(() => null),
    locator.getAttribute("title").catch(() => null),
    locator.getAttribute("value").catch(() => null),
  ]);
  return [text, aria, title, value].find((item) => normalized(item).length > 0) ?? "";
}

async function nearestReviewScope(action: Locator): Promise<Locator | null> {
  let scope = action.locator("xpath=..");
  for (let depth = 0; depth < 10; depth += 1) {
    const isReviewScope = await scope.evaluate((element) => {
      if (element.hasAttribute("data-review-row")) return true;
      const text = (element.textContent ?? "").normalize("NFKC");
      return /订单号[:：]\s*\d{8,}/u.test(text)
        && /(投诉评价|投诉追评|评价回复|追评回复)/u.test(text);
    }).catch(() => false);
    if (isReviewScope) return scope;
    scope = scope.locator("xpath=..");
  }
  return null;
}

async function defaultIdentity(scope: Locator, _rowIndex: number, expectedPhase: TmallReviewPhase): Promise<TmallComplaintRowIdentity | null> {
  const [sourceKey, rawPhase] = await Promise.all([
    scope.getAttribute("data-review-source-key").catch(() => null),
    scope.getAttribute("data-review-phase").catch(() => null),
  ]);
  const reviewPhase = rawPhase === "initial" || rawPhase === "followup" ? rawPhase : null;
  return sourceKey && reviewPhase === expectedPhase ? { sourceKey, reviewPhase } : null;
}

interface ComplaintCloseTarget {
  closeControls: Locator;
  closureScope: Locator;
}

interface ComplaintSurface extends ComplaintCloseTarget {
  dialog: Locator;
}

async function visibleDialog(page: Page): Promise<ComplaintSurface | null> {
  const complaintFrames = page.frames().filter((frame) => {
    try {
      const parsed = new URL(frame.url());
      return parsed.protocol === "https:"
        && parsed.hostname === "ss.taobao.com"
        && parsed.pathname === "/complaint";
    } catch {
      return false;
    }
  });
  if (complaintFrames.length > 1) return null;
  if (complaintFrames.length === 1) {
    const body = complaintFrames[0]!.locator("body");
    if (await body.isVisible().catch(() => false)) {
      for (const definition of COMPLAINT_TYPES) {
        const labels = await visible(await body.getByText(definition.name, { exact: true }).all());
        if (labels.length === 1) {
          // Tmall renders the complaint form in an iframe, but the close ×
          // belongs to the host page's #shop-external-modal. The iframe's
          // bottom “取消” is deliberately never a close fallback.
          return {
            dialog: body,
            closeControls: page.locator(TMALL_COMPLAINT_FRAME_CLOSE_SELECTOR),
            closureScope: page.locator(TMALL_COMPLAINT_FRAME_SELECTOR),
          };
        }
      }
    }
  }
  const dialogs = await visible(await page.locator("[role='dialog'], [aria-modal='true'], .next-dialog, .next-overlay-wrapper").all());
  if (dialogs.length !== 1) return null;
  return {
    dialog: dialogs[0]!,
    closeControls: dialogs[0]!.locator(COMPLAINT_CLOSE_SELECTOR),
    closureScope: dialogs[0]!,
  };
}

async function controlCandidates(scope: Locator, exactLabel: string): Promise<Locator[]> {
  const controls = await visible(await scope.locator(CONTROL_SELECTOR).all());
  const matches: Locator[] = [];
  for (const control of controls) {
    const enabled = await control.isEnabled().catch(() => false);
    if (enabled && normalized(await interactiveText(control)) === normalized(exactLabel)) matches.push(control);
  }
  return matches;
}

async function editableCandidates(scope: Locator): Promise<Locator[]> {
  const candidates = await visible(await scope.locator(EDITOR_SELECTOR).all());
  const editable: Locator[] = [];
  for (const candidate of candidates) {
    if (await candidate.isEditable().catch(() => false)) editable.push(candidate);
  }
  return editable;
}

function dialogAdapter(
  dialog: Locator,
  options: TmallComplaintDomAdapterOptions,
  closeTarget: ComplaintCloseTarget = {
    closeControls: dialog.locator(COMPLAINT_CLOSE_SELECTOR),
    closureScope: dialog,
  },
): ComplaintDialogAdapter {
  const click = options.click ?? (async (locator: Locator) => locator.click());
  const fill = options.fill ?? (async (locator: Locator, value: string) => locator.fill(value));
  let selectedId: string | null = null;
  let selectedOption: ComplaintOfficialTypeOption | null = null;
  let submitClicked = false;

  const typeOptions = async (): Promise<Array<{ option: ComplaintOfficialTypeOption; control: Locator }>> => {
    const candidates = await visible(await dialog.locator("input[type='radio'], [role='radio'], label").all());
    const optionsFound: Array<{ option: ComplaintOfficialTypeOption; control: Locator }> = [];
    for (const candidate of candidates) {
      const isRadio = await candidate.evaluate((element) => element instanceof HTMLInputElement && element.type === "radio").catch(() => false);
      const control = isRadio ? candidate : candidate.locator("input[type='radio']").first();
      if (!await control.count().catch(() => 0)) continue;
      const id = await control.getAttribute("value").catch(() => null)
        ?? await control.getAttribute("id").catch(() => null);
      const label = normalized(await candidate.innerText().catch(() => ""));
      if (id && label) optionsFound.push({ option: { id, label }, control });
    }
    if (optionsFound.length > 0) return optionsFound;

    for (const definition of COMPLAINT_TYPES) {
      const matches = await visible(await dialog.getByText(definition.name, { exact: true }).all());
      if (matches.length === 1) {
        optionsFound.push({
          option: { id: definition.code, label: definition.name },
          control: matches[0]!,
        });
      }
    }
    return optionsFound;
  };

  return {
    listOfficialTypes: async () => (await typeOptions()).map(({ option }) => option),
    selectOfficialType: async (id) => {
      const matches = (await typeOptions()).filter(({ option }) => option.id === id);
      if (matches.length !== 1) throw new Error("官方投诉类型无法唯一识别");
      await click(matches[0]!.control);
      if ((await editableCandidates(dialog)).length === 0) {
        const nextControls = await controlCandidates(dialog, "提交");
        if (nextControls.length !== 1) throw new Error("投诉类型确认按钮无法唯一识别");
        await click(nextControls[0]!);
        let editorReady = false;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if ((await editableCandidates(dialog)).length === 1) {
            editorReady = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!editorReady) throw new Error("投诉描述页面未加载完成");
      }
      selectedId = id;
      selectedOption = matches[0]!.option;
    },
    readSelectedOfficialType: async () => {
      const types = await typeOptions();
      for (const { option, control } of types) {
        if (await control.isChecked().catch(() => false)) return option;
      }
      if (selectedId !== null && selectedOption && (await editableCandidates(dialog)).length === 1) return selectedOption;
      return selectedId === null ? null : types.find(({ option }) => option.id === selectedId)?.option ?? null;
    },
    readSafetySentinels: async (): Promise<ComplaintSafetySentinels> => {
      const chatControls = await visible(await dialog.locator("input[type='checkbox']").all());
      for (const checkbox of chatControls) {
        const [name, aria, title, parentText] = await Promise.all([
          checkbox.getAttribute("name").catch(() => null),
          checkbox.getAttribute("aria-label").catch(() => null),
          checkbox.getAttribute("title").catch(() => null),
          checkbox.locator("xpath=..").innerText().catch(() => ""),
        ]);
        if (/聊天|旺旺|授权|chat|authorization/ui.test([name, aria, title, parentText].filter(Boolean).join(" "))) {
          return {
            chatAuthorizationChecked: await checkbox.isChecked().catch(() => null),
            attachmentCount: (await visible(await dialog.locator(ATTACHMENT_SELECTOR).all())).length,
          };
        }
      }
      return {
        chatAuthorizationChecked: false,
        attachmentCount: (await visible(await dialog.locator(ATTACHMENT_SELECTOR).all())).length,
      };
    },
    fillDescription: async (value) => {
      const editors = await editableCandidates(dialog);
      if (editors.length !== 1) throw new Error("投诉描述输入框无法唯一识别");
      await fill(editors[0]!, value);
    },
    readDescription: async () => {
      const editors = await editableCandidates(dialog);
      if (editors.length !== 1) throw new Error("投诉描述输入框无法唯一识别");
      const value = await editors[0]!.inputValue().catch(async () => editors[0]!.textContent().catch(() => ""));
      return value ?? "";
    },
    listSubmitControls: async (): Promise<ComplaintSubmitControl[]> => {
      const controls = await controlCandidates(dialog, "提交");
      return Promise.all(controls.map(async (control, index) => ({
        id: (await control.getAttribute("data-complaint-submit-id").catch(() => null)) ?? `submit:${index}`,
        label: await interactiveText(control),
      })));
    },
    ...(options.beforeSubmitClick ? { beforeSubmitClick: options.beforeSubmitClick } : {}),
    clickSubmit: async (id) => {
      const controls = await controlCandidates(dialog, "提交");
      const indexed = await Promise.all(controls.map(async (control, index) => ({
        id: (await control.getAttribute("data-complaint-submit-id").catch(() => null)) ?? `submit:${index}`,
        control,
      })));
      const matches = indexed.filter((item) => item.id === id);
      if (matches.length !== 1) throw new Error("投诉提交按钮无法唯一识别");
      submitClicked = true;
      await click(matches[0]!.control);
    },
    readSubmissionEvidence: async (): Promise<ComplaintSubmissionEvidence> => {
      if (!submitClicked) return { accepted: false };
      const text = await dialog.innerText().catch(() => "");
      const caseId = text.match(/(?:投诉|案件)(?:编号|单号)?[:：\s]*([A-Za-z0-9-]{4,})/u)?.[1] ?? null;
      const detailLinks = await dialog.locator("a[href*='complaint']").all();
      const detail = detailLinks.length === 1 ? await detailLinks[0]!.getAttribute("href").catch(() => null) : null;
      const accepted = /(?:提交成功|投诉成功|已受理)/u.test(text);
      const remainsOnComplaintPage = !accepted
        && await dialog.isVisible().catch(() => false)
        && (await editableCandidates(dialog)).length === 1;
      return {
        accepted,
        ...(remainsOnComplaintPage ? { remainsOnComplaintPage: true } : {}),
        platformCaseId: caseId,
        detailUrl: detail,
      };
    },
    closeComplaintDialog: async () => {
      const closeControls = await visible(await closeTarget.closeControls.all());
      if (closeControls.length !== 1) throw new Error("投诉界面关闭按钮无法唯一识别");
      await click(closeControls[0]!);
      if (await closeTarget.closureScope.isVisible().catch(() => true)) throw new Error("投诉界面未关闭");
    },
  };
}

/**
 * Creates a target-scoped adapter for Tmall's portal-rendered complaint panel.
 * It never traverses from a matched target to a different review row.
 */
export function createTmallComplaintDomAdapter(page: Page, options: TmallComplaintDomAdapterOptions = {}): ComplaintTargetAdapter {
  const identify = options.identifyRow ?? defaultIdentity;
  const click = options.click ?? (async (locator: Locator) => locator.click());
  return {
    resolveVerifiedTarget: async (target) => {
      const actionLabel = COMPLAINT_ACTIONS[target.reviewPhase];
      const exactActions: Locator[] = [];
      for (const control of await visible(await page.locator(CONTROL_SELECTOR).all())) {
        if (normalized(await interactiveText(control)) === normalized(actionLabel)) exactActions.push(control);
      }
      const matches: Array<{ scope: Locator; identity: TmallComplaintRowIdentity }> = [];
      for (const [index, action] of exactActions.entries()) {
        const scope = await nearestReviewScope(action);
        if (!scope) continue;
        const identity = await identify(scope, index, phaseForAction(actionLabel));
        if (identity?.sourceKey === target.sourceKey && identity.reviewPhase === target.reviewPhase) {
          matches.push({ scope, identity });
        }
      }
      if (matches.length !== 1) return null;
      const targetRow = matches[0]!;
      return {
        ...targetRow.identity,
        openComplaint: async (requestedAction) => {
          if (requestedAction !== actionLabel) throw new Error("投诉入口与评价阶段不一致");
          const visibleActions: Locator[] = [];
          for (const control of await visible(await targetRow.scope.locator(CONTROL_SELECTOR).all())) {
            if (normalized(await interactiveText(control)) === normalized(requestedAction)) visibleActions.push(control);
          }
          if (visibleActions.length !== 1) throw new Error("投诉入口无法唯一识别");
          await click(visibleActions[0]!);
          let complaintSurface: ComplaintSurface | null = null;
          for (let attempt = 0; attempt < 50 && !complaintSurface; attempt += 1) {
            complaintSurface = await visibleDialog(page);
            if (!complaintSurface) await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (!complaintSurface) throw new Error("投诉页面无法唯一识别");
          return dialogAdapter(complaintSurface.dialog, {
            ...options,
            beforeSubmitClick: async () => {
              // Re-read the exact target immediately before the irreversible
              // click. A portal re-render or list refresh must never let a
              // prepared complaint migrate to another buyer review.
              const current = await identify(targetRow.scope, 0, target.reviewPhase);
              if (!current || current.sourceKey !== target.sourceKey || current.reviewPhase !== target.reviewPhase) {
                throw new Error("投诉目标在提交前已改变");
              }
              await options.beforeSubmitClick?.();
            },
          }, complaintSurface);
        },
      };
    },
  };
}
