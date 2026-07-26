import type { ReplyAttemptRepository, ReplyAttemptState, ReplyRepository } from "../storage/repositories";
import { TmallReviewPageStateError, type TmallReviewSnapshot } from "../tmall/review-reader";
import { ReviewActionConflictError } from "./review-action-gate";

export interface SubmissionResult {
  outcome: "skipped" | "sent" | "failed" | "uncertain";
  state: ReplyAttemptState;
  skipped?: boolean;
  evidence?: string;
  failureOperationKey?: string;
  manualActionRequired?: boolean;
}

export interface ReplySubmissionDriver {
  submitReply(
    review: TmallReviewSnapshot,
    finalReply: string,
    control: { beforeSubmit(): void },
  ): Promise<{ state: "sent" | "failed" | "uncertain"; evidence: string; message?: string; failureOperationKey?: string }>;
}

export class SubmissionService {
  constructor(private readonly options: { replies: ReplyRepository; attempts: ReplyAttemptRepository; driver: ReplySubmissionDriver }) {}

  async submit(replyDraftId: string): Promise<SubmissionResult> {
    const draft = this.options.replies.get(replyDraftId);
    if (!draft) return { outcome: "failed", state: "failed" };
    let prepared: ReturnType<ReplyAttemptRepository["prepareWithReplyLock"]>;
    try {
      prepared = this.options.attempts.prepareWithReplyLock(replyDraftId, draft.sourceKey);
    } catch (error) {
      if (error instanceof ReviewActionConflictError) {
        return { outcome: "skipped", state: "failed", skipped: true, evidence: error.message };
      }
      throw error;
    }
    if (!prepared.created) return prepared.attempt.evidence
      ? { outcome: "skipped", state: prepared.attempt.state, skipped: true, evidence: prepared.attempt.evidence }
      : { outcome: "skipped", state: prepared.attempt.state, skipped: true };
    const validationError = this.#validate(draft);
    if (validationError) {
      this.options.attempts.markFailed(prepared.attempt.id, "REPLY_VALIDATION_FAILED", validationError);
      return { outcome: "failed", state: "failed" };
    }

    let result: Awaited<ReturnType<ReplySubmissionDriver["submitReply"]>>;
    try {
      result = await this.options.driver.submitReply({
        sourceKey: draft.sourceKey,
        orderId: draft.orderId,
        review: draft.review,
        product: draft.product,
        reviewedAt: draft.reviewedAt,
        sentimentLabel: draft.sentimentLabel,
        itemId: draft.itemId,
        reviewPhase: draft.reviewPhase,
      }, draft.finalReply, {
        beforeSubmit: () => this.options.attempts.markSubmitting(prepared.attempt.id),
      });
    } catch (error) {
      if (this.options.attempts.get(prepared.attempt.id)?.state === "submitting") {
        const evidence = error instanceof Error
          ? `最终提交点击边界之后浏览器操作中断：${error.message}`
          : "最终提交点击边界之后浏览器操作中断";
        this.options.attempts.markUncertain(prepared.attempt.id, evidence);
        return { outcome: "uncertain", state: "submission_uncertain", evidence };
      }
      if (error instanceof TmallReviewPageStateError) {
        const evidence = "提交前页面商品或评价阶段无法安全确认";
        this.options.attempts.markSkipped(prepared.attempt.id, "TMALL_PAGE_STATE_UNTRUSTED", error.message);
        return { outcome: "skipped", state: "failed", skipped: true, evidence };
      }
      const evidence = "回复提交前浏览器操作中断，已记录原因并跳过该条";
      this.options.attempts.markSkipped(prepared.attempt.id, "TMALL_BROWSER_OPERATION_ABORTED", evidence);
      return { outcome: "skipped", state: "failed", skipped: true, evidence };
    }
    if (result.state === "sent") {
      if (this.options.attempts.get(prepared.attempt.id)?.state === "pending") {
        this.options.attempts.markSubmitting(prepared.attempt.id);
      }
      this.options.attempts.markSent(prepared.attempt.id, result.evidence);
      return { outcome: "sent", state: "sent", evidence: result.evidence };
    }
    if (result.state === "uncertain") {
      const evidence = `已点击回复提交按钮：${result.evidence}`;
      if (this.options.attempts.get(prepared.attempt.id)?.state === "pending") {
        this.options.attempts.markSubmitting(prepared.attempt.id);
      }
      this.options.attempts.markUncertain(prepared.attempt.id, evidence);
      return { outcome: "uncertain", state: "submission_uncertain", evidence };
    }
    const evidence = result.message ?? result.evidence;
    this.options.attempts.markSkipped(prepared.attempt.id, "TMALL_SUBMISSION_FAILED", evidence);
    return { outcome: "skipped", state: "failed", skipped: true, evidence };
  }

  #validate(draft: ReturnType<ReplyRepository["get"]>): string | null {
    if (!draft) return "回复草稿不存在";
    if (!["read_only_ready", "needs_attention"].includes(draft.state)) return "回复尚未完成生成或已经处理";
    if (draft.product === "商品名称未识别") return "商品名称无法确认";
    const reply = draft.finalReply.trim();
    if (reply.length < 10 || reply.length > 1000) return "回复长度不符合要求";
    if (/退款|退货|赔偿|补偿|无条件|保证给您|承诺给您/u.test(reply)) return "回复包含未经允许的售后承诺";
    if (draft.unsupportedClaims.length > 0) return `回复包含未经模板支持的商品描述：“${draft.unsupportedClaims[0]!.slice(0, 80)}”`;
    const currentProduct = draft.product.toLowerCase();
    const finalReply = reply.toLowerCase();
    const ignoredTerms = new Set(["app", "pet", "tws", "usb", "type", "bluetooth", "codec", "audio"]);
    const templateProductNames = [...draft.detectedTemplateProducts, ...Array.from(draft.originalTemplate.matchAll(/\b([A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z][A-Za-z0-9-]*)*|[A-Za-z]+\d+[A-Za-z0-9-]*)\b/gu), (match) => match[1]!.trim())]
      .filter((name) => {
        const normalized = name.toLowerCase();
        if (ignoredTerms.has(normalized) || /^[A-Z]{2,6}$/u.test(name)) return false;
        return /\d/u.test(name) || name.includes(" ") || name.length >= 5;
      });
    const residual = templateProductNames.find((name) => !currentProduct.includes(name.toLowerCase()) && finalReply.includes(name.toLowerCase()));
    if (residual) return `回复仍包含模板中的旧商品名称“${residual}”`;
    const factPattern = /采用|配备|搭载|具备|续航|振膜|音腔|芯片|防水|蓝牙|单元|材质|结构|功率|延迟|专利|支持(?=.{0,16}(?:连接|协议|模式|功能|编码|充电|降噪|[A-Za-z0-9]))/iu;
    const normalizeClaim = (value: string): string => {
      let normalized = value.toLowerCase().replace(/[\s，。；、：:！!（）()【】\[\]]+/gu, "");
      for (const productName of [draft.product, ...templateProductNames].sort((a, b) => b.length - a.length)) {
        const token = productName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        normalized = normalized.replace(new RegExp(token.replace(/\\ /gu, "\\s*"), "gu"), "[product]");
      }
      return normalized;
    };
    const normalizedTemplate = normalizeClaim(draft.originalTemplate);
    const unsupportedClaim = reply.split(/[。！？；\n]/u)
      .map((claim) => claim.trim())
      .filter((claim) => claim && factPattern.test(claim))
      .find((claim) => !normalizedTemplate.includes(normalizeClaim(claim)));
    if (unsupportedClaim) return `回复包含未经话术支持的商品参数或功能描述：“${unsupportedClaim.slice(0, 80)}”`;
    return null;
  }
}
