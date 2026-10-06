import { describe, expect, it, vi } from "vitest";
import { openDatabase, runMigrations } from "../storage/database";
import { ReplyAttemptRepository, ReplyRepository } from "../storage/repositories";
import { SubmissionService } from "./service";
import { TmallReviewPageStateError } from "../tmall/review-reader";
import { ReviewActionGate } from "./review-action-gate";

function readyDraft(replies: ReplyRepository, sourceKey: string) {
  const { id } = replies.discover({ sourceKey, orderId: "1001", review: "音质很好", product: "漫步者耳机", reviewedAt: null, sentimentLabel: "positive", itemId: null, reviewPhase: "initial" });
  replies.complete(id, { finalReply: "感谢您对漫步者耳机音质的认可，若有任何疑问欢迎咨询在线客服，感谢您的支持！", productAdjusted: true, needsAttention: false, notes: "已适配商品", attentionReasons: [] });
  return id;
}

describe("safe reply submission", () => {
  it("uses only the atomic prepareWithReplyLock gate", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const id = readyDraft(replies, "tmall:atomic-prepare");
    const legacyPrepare = vi.spyOn(attempts, "prepare");
    const atomicPrepare = vi.spyOn(attempts, "prepareWithReplyLock");
    const service = new SubmissionService({ replies, attempts, driver: { submitReply: async () => ({ state: "sent", evidence: "列表显示已回复" }) } });

    await expect(service.submit(id)).resolves.toMatchObject({ state: "sent", outcome: "sent" });
    expect(legacyPrepare).not.toHaveBeenCalled();
    expect(atomicPrepare).toHaveBeenCalledTimes(1);
    database.close();
  });

  it.each(["manual_hold", "complaint", "terminal"] as const)("does not create an attempt or touch the browser behind a %s gate", async (gateKind) => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const sourceKey = `tmall:blocked:${gateKind}`;
    const id = readyDraft(replies, sourceKey);
    const gate = new ReviewActionGate(database);
    if (gateKind === "manual_hold") {
      replies.markManualProductHold(id, {
        storeId: "primary",
        manualProductId: null,
        catalogRevision: 1,
        matchKind: "identity_untrusted",
        reason: "人工处理",
      });
    } else {
      const lock = gate.acquire("primary", sourceKey, "complaint");
      if (gateKind === "terminal") gate.complete("primary", sourceKey, "complaint", lock.lockVersion, "complaint_upheld");
    }
    const driver = vi.fn(async () => ({ state: "sent" as const, evidence: "不应提交" }));
    const service = new SubmissionService({ replies, attempts, driver: { submitReply: driver } });

    await expect(service.submit(id)).resolves.toMatchObject({ state: "failed", outcome: "skipped", skipped: true });
    expect(driver).not.toHaveBeenCalled();
    expect(attempts.list()).toHaveLength(0);
    database.close();
  });

  it("does not reuse a failed attempt when another action owns the current version", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const sourceKey = "tmall:version-conflict";
    const id = readyDraft(replies, sourceKey);
    const failed = attempts.prepareWithReplyLock(id, sourceKey).attempt;
    attempts.markFailed(failed.id, "PRECHECK_FAILED", "验证失败");
    new ReviewActionGate(database).acquire("primary", sourceKey, "complaint");
    const driver = vi.fn(async () => ({ state: "sent" as const, evidence: "不应提交" }));
    const service = new SubmissionService({ replies, attempts, driver: { submitReply: driver } });

    await expect(service.submit(id)).resolves.toMatchObject({ state: "failed", outcome: "skipped", skipped: true });
    expect(driver).not.toHaveBeenCalled();
    expect(attempts.list()).toHaveLength(1);
    expect(attempts.get(failed.id)?.state).toBe("failed");
    database.close();
  });

  it("marks an explicitly verified submission as sent", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const id = readyDraft(replies, "tmall:sent");
    const service = new SubmissionService({ replies, attempts, driver: { submitReply: async () => ({ state: "sent", evidence: "列表显示已回复" }) } });

    await expect(service.submit(id)).resolves.toMatchObject({ state: "sent" });
    expect(replies.get(id)?.state).toBe("sent");
    database.close();
  });

  it("keeps the attempt pending until the driver writes the final-click checkpoint", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const sourceKey = "tmall:final-click-checkpoint";
    const id = readyDraft(replies, sourceKey);
    const service = new SubmissionService({
      replies,
      attempts,
      driver: {
        submitReply: async (_review, _reply, control) => {
          expect(attempts.getBySourceKey(sourceKey)?.state).toBe("pending");
          expect(replies.get(id)?.state).toBe("read_only_ready");
          control.beforeSubmit();
          expect(attempts.getBySourceKey(sourceKey)?.state).toBe("submitting");
          expect(replies.get(id)?.state).toBe("submitting");
          return { state: "sent", evidence: "已点击回复提交按钮" };
        },
      },
    });

    await expect(service.submit(id)).resolves.toMatchObject({ outcome: "sent", state: "sent" });
    expect(attempts.getBySourceKey(sourceKey)?.state).toBe("sent");
    expect(replies.get(id)?.state).toBe("sent");
    database.close();
  });

  it("locks a post-checkpoint interruption as submission uncertain instead of failed", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const sourceKey = "tmall:post-click-checkpoint-timeout";
    const id = readyDraft(replies, sourceKey);
    const service = new SubmissionService({
      replies,
      attempts,
      driver: {
        submitReply: async (_review, _reply, control) => {
          control.beforeSubmit();
          throw new Error("deadline after final click checkpoint");
        },
      },
    });

    await expect(service.submit(id)).resolves.toMatchObject({
      outcome: "uncertain",
      state: "submission_uncertain",
    });
    expect(attempts.getBySourceKey(sourceKey)).toMatchObject({
      state: "submission_uncertain",
      errorCode: "SUBMISSION_UNCERTAIN",
    });
    expect(replies.get(id)?.state).toBe("submission_uncertain");
    expect(new ReviewActionGate(database).getLock("primary", sourceKey)?.actionKind).toBe("reply");
    database.close();
  });

  it("locks a confirmed submit-button click as uncertain until platform evidence arrives", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const id = readyDraft(replies, "tmall:uncertain");
    let calls = 0;
    const service = new SubmissionService({ replies, attempts, driver: { submitReply: async () => { calls += 1; return { state: "uncertain", evidence: "点击后页面连接中断" }; } } });

    await expect(service.submit(id)).resolves.toMatchObject({ state: "submission_uncertain", outcome: "uncertain" });
    await expect(service.submit(id)).resolves.toMatchObject({ state: "submission_uncertain", skipped: true });
    expect(calls).toBe(1);
    expect(replies.get(id)?.state).toBe("submission_uncertain");
    expect(new ReviewActionGate(database).getLock("primary", "tmall:uncertain")?.actionKind).toBe("reply");
    database.close();
  });

  it("records a browser interruption before a confirmed click and skips that review", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const id = readyDraft(replies, "tmall:driver-threw");
    let calls = 0;
    const service = new SubmissionService({
      replies,
      attempts,
      driver: {
        submitReply: async () => {
          calls += 1;
          throw new Error("page closed");
        },
      },
    });

    await expect(service.submit(id)).resolves.toMatchObject({ state: "failed", outcome: "skipped", skipped: true });
    await expect(service.submit(id)).resolves.toMatchObject({ state: "failed", outcome: "skipped", skipped: true });
    expect(calls).toBe(1);
    expect(attempts.getBySourceKey("tmall:driver-threw")).toMatchObject({
      state: "failed",
      errorCode: "TMALL_BROWSER_OPERATION_ABORTED",
    });
    expect(replies.get(id)?.state).toBe("failed");
    database.close();
  });

  it("records an untrusted pre-submit page as skipped without requiring manual action", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const id = readyDraft(replies, "tmall:page-state");
    const service = new SubmissionService({
      replies,
      attempts,
      driver: {
        submitReply: async () => { throw new TmallReviewPageStateError("提交前商品ID发生变化"); },
      },
    });

    const result = await service.submit(id);
    expect(result).toEqual({ outcome: "skipped", state: "failed", skipped: true, evidence: "提交前页面商品或评价阶段无法安全确认" });
    expect(attempts.getBySourceKey("tmall:page-state")).toMatchObject({ state: "failed", errorCode: "TMALL_PAGE_STATE_UNTRUSTED" });
    expect(replies.get(id)?.state).toBe("failed");
    database.close();
  });

  it("fails closed before touching the page when the generated reply is unsafe", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const { id } = replies.discover({ sourceKey: "tmall:unsafe", orderId: null, review: "不好", product: "商品名称未识别", reviewedAt: null, sentimentLabel: "negative", itemId: null, reviewPhase: "initial" });
    replies.complete(id, { finalReply: "我们保证给您退款赔偿。", productAdjusted: false, needsAttention: true, notes: "", attentionReasons: [] });
    let calls = 0;
    const service = new SubmissionService({ replies, attempts, driver: { submitReply: async () => { calls += 1; return { state: "sent", evidence: "" }; } } });

    await expect(service.submit(id)).resolves.toMatchObject({ state: "failed" });
    expect(calls).toBe(0);
    expect(new ReviewActionGate(database).getLock("primary", "tmall:unsafe")).toBeNull();
    database.close();
  });

  it("allows after-sales wording that is preserved from the merchant-approved original template", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const sourceKey = "tmall:approved-after-sales-template";
    const template = "很抱歉没有达到您的预期，如符合平台售后规则，我们支持全额退款退货，请联系在线客服协助处理。";
    const { id } = replies.discover({
      sourceKey,
      orderId: null,
      review: "这个价格不值",
      product: "漫步者耳机",
      reviewedAt: null,
      sentimentLabel: "negative",
      itemId: null,
      reviewPhase: "initial",
    });
    replies.saveClassification(id, {
      library: "bad",
      primaryCategory: "性价比",
      category: "性价比一般",
      confidence: 0.95,
      reason: "明确表达价格不值",
      needsAttention: false,
    });
    database.prepare("UPDATE reply_drafts SET original_template = ?, state = 'rewriting' WHERE id = ?").run(template, id);
    replies.complete(id, {
      finalReply: template,
      productAdjusted: false,
      needsAttention: false,
      notes: "保持商家批准话术原文",
      attentionReasons: [],
      detectedTemplateProducts: [],
      unsupportedClaims: [],
    });
    let calls = 0;
    const service = new SubmissionService({
      replies,
      attempts,
      driver: {
        submitReply: async (_review, _reply, control) => {
          calls += 1;
          control.beforeSubmit();
          return { state: "sent", evidence: "平台显示回复成功" };
        },
      },
    });

    await expect(service.submit(id)).resolves.toMatchObject({ outcome: "sent", state: "sent" });
    expect(calls).toBe(1);
    database.close();
  });

  it("blocks an after-sales promise added outside the selected merchant template", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const sourceKey = "tmall:invented-after-sales-promise";
    const template = "很抱歉没有达到您的预期，请联系在线客服协助处理。";
    const { id } = replies.discover({
      sourceKey,
      orderId: null,
      review: "这个价格不值",
      product: "漫步者耳机",
      reviewedAt: null,
      sentimentLabel: "negative",
      itemId: null,
      reviewPhase: "initial",
    });
    replies.saveClassification(id, {
      library: "bad",
      primaryCategory: "性价比",
      category: "性价比一般",
      confidence: 0.95,
      reason: "明确表达价格不值",
      needsAttention: false,
    });
    database.prepare("UPDATE reply_drafts SET original_template = ?, state = 'rewriting' WHERE id = ?").run(template, id);
    replies.complete(id, {
      finalReply: `${template} 我们保证给您全额退款退货。`,
      productAdjusted: false,
      needsAttention: false,
      notes: "模型错误新增承诺",
      attentionReasons: [],
      detectedTemplateProducts: [],
      unsupportedClaims: [],
    });
    let calls = 0;
    const service = new SubmissionService({
      replies,
      attempts,
      driver: { submitReply: async () => { calls += 1; return { state: "sent", evidence: "" }; } },
    });

    await expect(service.submit(id)).resolves.toMatchObject({ outcome: "failed", state: "failed" });
    expect(calls).toBe(0);
    expect(attempts.getBySourceKey(sourceKey)?.errorMessage).toContain("未经允许");
    database.close();
  });

  it("records a verified pre-click failure as skipped and does not reopen that review", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const sourceKey = "tmall:pre-click-failure";
    const id = readyDraft(replies, sourceKey);
    const service = new SubmissionService({
      replies,
      attempts,
      driver: { submitReply: async () => ({ state: "failed", evidence: "目标评价已不在列表", message: "提交前校验失败", failureOperationKey: "reply.open" }) },
    });

    await expect(service.submit(id)).resolves.toMatchObject({ state: "failed", outcome: "skipped", skipped: true });
    expect(attempts.getBySourceKey(sourceKey)?.state).toBe("failed");
    expect(replies.get(id)?.state).toBe("failed");
    expect(new ReviewActionGate(database).getLock("primary", sourceKey)).toBeNull();
    database.close();
  });

  it("keeps the reply lock when the driver reports that the submit button was clicked", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const sourceKey = "tmall:manual-not-sent";
    const id = readyDraft(replies, sourceKey);
    const uncertain = new SubmissionService({
      replies,
      attempts,
      driver: { submitReply: async () => ({ state: "uncertain", evidence: "点击后响应丢失" }) },
    });
    await expect(uncertain.submit(id)).resolves.toMatchObject({ outcome: "uncertain", state: "submission_uncertain" });
    expect(new ReviewActionGate(database).getLock("primary", sourceKey)?.actionKind).toBe("reply");
    expect(attempts.getBySourceKey(sourceKey)?.state).toBe("submission_uncertain");
    expect(replies.get(id)?.state).toBe("submission_uncertain");
    database.close();
  });

  it("blocks a reply that still contains an old product name from its template", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const { id } = replies.discover({ sourceKey: "tmall:old-product", orderId: null, review: "质量不好", product: "漫步者 Atom ANC", reviewedAt: null, sentimentLabel: "negative", itemId: null, reviewPhase: "initial" });
    replies.saveClassification(id, { library: "bad", primaryCategory: "质量", category: "质量", confidence: 0.9, reason: "质量反馈", needsAttention: false });
    database.prepare("UPDATE reply_drafts SET original_template = ?, state = 'rewriting' WHERE id = ?").run("Zero Air 采用稳定结构设计，若使用过程中有任何疑问可咨询漫步者客服。", id);
    replies.complete(id, { finalReply: "非常抱歉，Zero Air 采用稳定结构设计，若使用过程中有任何疑问可咨询漫步者客服。", productAdjusted: false, needsAttention: false, notes: "未修改", attentionReasons: [] });
    let calls = 0;
    const service = new SubmissionService({ replies, attempts, driver: { submitReply: async () => { calls += 1; return { state: "sent", evidence: "" }; } } });

    await expect(service.submit(id)).resolves.toMatchObject({ state: "failed" });
    expect(calls).toBe(0);
    expect(attempts.getBySourceKey("tmall:old-product")?.errorMessage).toContain("旧商品名称");
    database.close();
  });

  it("blocks a single-word legacy product name such as atomanc", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const { id } = replies.discover({ sourceKey: "tmall:atomanc", orderId: null, review: "质量不好", product: "漫步者 X1", reviewedAt: null, sentimentLabel: "negative", itemId: null, reviewPhase: "initial" });
    replies.saveClassification(id, { library: "bad", primaryCategory: "质量", category: "质量", confidence: 0.9, reason: "质量反馈", needsAttention: false });
    database.prepare("UPDATE reply_drafts SET original_template = ?, state = 'rewriting' WHERE id = ?").run("atomanc 采用稳定结构设计，若使用过程中有任何疑问可咨询漫步者客服。", id);
    replies.complete(id, { finalReply: "非常抱歉，atomanc 采用稳定结构设计，若使用过程中有任何疑问可咨询漫步者客服。", productAdjusted: false, needsAttention: false, notes: "未修改", attentionReasons: [] });
    let calls = 0;
    const service = new SubmissionService({ replies, attempts, driver: { submitReply: async () => { calls += 1; return { state: "sent", evidence: "" }; } } });

    await expect(service.submit(id)).resolves.toMatchObject({ state: "failed" });
    expect(calls).toBe(0);
    expect(attempts.getBySourceKey("tmall:atomanc")?.errorMessage).toContain("atomanc");
    database.close();
  });

  it("blocks product parameters that were invented outside the selected template", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const { id } = replies.discover({ sourceKey: "tmall:invented-claim", orderId: null, review: "续航不好", product: "漫步者 X1", reviewedAt: null, sentimentLabel: "negative", itemId: null, reviewPhase: "initial" });
    replies.saveClassification(id, { library: "bad", primaryCategory: "质量", category: "续航", confidence: 0.9, reason: "续航反馈", needsAttention: false });
    database.prepare("UPDATE reply_drafts SET original_template = ?, state = 'rewriting' WHERE id = ?").run("非常抱歉没有达到您的预期，我们会持续优化产品。", id);
    replies.complete(id, { finalReply: "非常抱歉没有达到您的预期，漫步者 X1 支持99小时续航，我们会持续优化产品。", productAdjusted: true, needsAttention: false, notes: "已修改", attentionReasons: [] });
    let calls = 0;
    const service = new SubmissionService({ replies, attempts, driver: { submitReply: async () => { calls += 1; return { state: "sent", evidence: "" }; } } });

    await expect(service.submit(id)).resolves.toMatchObject({ state: "failed" });
    expect(calls).toBe(0);
    expect(attempts.getBySourceKey("tmall:invented-claim")?.errorMessage).toContain("未经话术支持");
    database.close();
  });

  it("blocks a Chinese legacy product entity returned by structured AI analysis", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const { id } = replies.discover({ sourceKey: "tmall:chinese-product", orderId: null, review: "佩戴不好", product: "漫步者 X1", reviewedAt: null, sentimentLabel: "negative", itemId: null, reviewPhase: "initial" });
    replies.complete(id, {
      finalReply: "非常抱歉，花再耳机采用舒适佩戴结构，若有任何疑问欢迎咨询在线客服。",
      productAdjusted: false,
      needsAttention: false,
      notes: "未修改",
      attentionReasons: [],
      detectedTemplateProducts: ["花再耳机"],
      unsupportedClaims: [],
    });
    let calls = 0;
    const service = new SubmissionService({ replies, attempts, driver: { submitReply: async () => { calls += 1; return { state: "sent", evidence: "" }; } } });

    await expect(service.submit(id)).resolves.toMatchObject({ state: "failed" });
    expect(calls).toBe(0);
    expect(attempts.getBySourceKey("tmall:chinese-product")?.errorMessage).toContain("花再耳机");
    database.close();
  });

  it.each(["failed", "submitting", "submission_uncertain"] as const)(
    "reconciles a local %s attempt to sent when Tmall exposes a reply record",
    (localState) => {
      const database = openDatabase(":memory:");
      runMigrations(database);
      const replies = new ReplyRepository(database);
      const attempts = new ReplyAttemptRepository(database);
      const sourceKey = `tmall:platform-reply:${localState}`;
      const id = readyDraft(replies, sourceKey);
      const prepared = attempts.prepareWithReplyLock(id, sourceKey).attempt;
      if (localState === "failed") {
        attempts.markSkipped(prepared.id, "TMALL_BROWSER_OPERATION_ABORTED", "点击前连接中断");
      } else {
        attempts.markSubmitting(prepared.id);
        if (localState === "submission_uncertain") attempts.markUncertain(prepared.id, "点击后连接中断");
      }

      expect(replies.markPlatformActionObserved(id, "reply_record").state).toBe("sent");
      expect(replies.markPlatformActionObserved(id, "reply_record").state).toBe("sent");
      expect(attempts.getBySourceKey(sourceKey)?.state).toBe("sent");
      expect(new ReviewActionGate(database).getLock("primary", sourceKey)).toBeNull();
      expect(new ReviewActionGate(database).getTombstone("primary", sourceKey)?.terminalAction).toBe("reply_sent");
      database.close();
    },
  );
});
