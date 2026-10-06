import {
  DeepSeekClient,
  DeepSeekConfigurationError,
  DeepSeekModelContractError,
  DeepSeekTransientError,
  type DeepSeekClientApi,
  type ReviewClassification,
  type TemplateRewriteResult,
} from "../deepseek/client";
import { describe, expect, it, vi } from "vitest";
import { ManualProductPolicyService } from "../manual-products/policy-service";
import { openDatabase, runMigrations } from "../storage/database";
import { ManualProductRepository } from "../storage/manual-product-repository";
import { ReplyAttemptRepository, ReplyRepository, TemplateRepository } from "../storage/repositories";
import { ReviewActionConflictError, ReviewActionGate } from "../submission/review-action-gate";
import type { TmallReviewSnapshot } from "../tmall/review-reader";
import { DraftProcessor } from "./processor";
import { ComplaintReviewService, createAdjudicatedComplaintEligibilityVerifier, type ComplaintReviewPolicy } from "../complaints/complaint-review-service";
import { ComplaintRepository } from "../storage/complaint-repository";
import type { ComplaintAnalysisInput } from "../complaints/deepseek-complaint-analysis";
import { createProductionComplaintReviewPolicy } from "../complaints/production-complaint-review-policy";

function seedTemplates(templates: TemplateRepository) {
  for (const library of ["good", "bad"] as const) {
    templates.saveSource({ library, url: `https://demo.feishu.cn/base/app?table=${library}`, appToken: "app", tableId: library, viewId: null });
  }
  templates.activateVersion({
    library: "good",
    contentHash: "good-v1",
    sourceRecordCount: 2,
    templates: [
      { primaryCategory: "", category: "音质音效类", keywords: ["音质"], replies: [
        { sequence: 1, text: "音质话术一" },
        { sequence: 2, text: "音质话术二" },
        { sequence: 3, text: "音质话术三" },
      ] },
      { primaryCategory: "", category: "通用整体好评类", keywords: [], replies: [{ sequence: 1, text: "通用好评" }] },
    ],
    warnings: [],
  });
  templates.activateVersion({
    library: "bad",
    contentHash: "bad-v1",
    sourceRecordCount: 2,
    templates: [
      { primaryCategory: "佩戴体验", category: "佩戴体验", keywords: ["夹耳"], replies: [{ sequence: 1, text: "佩戴体验话术" }] },
      { primaryCategory: "通用差评类", category: "通用差评类", keywords: [], replies: [{ sequence: 1, text: "通用差评话术" }] },
    ],
    warnings: [],
  });
}

function snapshot(key: string, review = "音质很好"): TmallReviewSnapshot {
  return { sourceKey: key, orderId: key, review, product: "漫步者 X1 EVO", reviewedAt: null, sentimentLabel: "positive", itemId: "960227744800", reviewPhase: "initial" };
}

function ai(classification: ReviewClassification, rewrite?: Partial<TemplateRewriteResult>): DeepSeekClientApi {
  return {
    testConnection: vi.fn(),
    determineSentiment: vi.fn(async () => ({ sentiment: "positive" as const, reason: "整体偏正面", confidence: 0.9 })),
    reviewSentiment: vi.fn(async () => ({ sentiment: "positive" as const, reason: "独立复核整体正面", confidence: 0.95 })),
    adjudicateSentiment: vi.fn(async () => ({ sentiment: "positive" as const, reason: "最终裁决整体正面", confidence: 0.95 })),
    classifyReview: vi.fn(async () => classification),
    rewriteTemplate: vi.fn(async (input) => ({
      finalReply: input.template,
      productAdjusted: false,
      needsAttention: false,
      notes: "模板原文无需修改",
      detectedTemplateProducts: [],
      unsupportedClaims: [],
      ...rewrite,
    })),
  };
}

function setup(
  client: DeepSeekClientApi,
  pickIndex = () => 0,
  withManualPolicy = false,
  runtime: { now?: () => Date; sleep?: (milliseconds: number) => Promise<void> } = {},
) {
  const database = openDatabase(":memory:");
  runMigrations(database);
  const replies = new ReplyRepository(database);
  const templates = new TemplateRepository(database);
  const products = new ManualProductRepository(database);
  seedTemplates(templates);
  const manualProductPolicy = withManualPolicy ? new ManualProductPolicyService({ products, replies, ai: client }) : undefined;
  const processor = new DraftProcessor({ replies, templates, ai: client, pickIndex, manualProductPolicy, ...runtime });
  return { database, replies, products, templates, processor };
}

describe("DraftProcessor", () => {
  it("uses the maintained neutral wearing category and explanation when the product form is absent", async () => {
    const client = ai({
      library: "bad",
      category: "入耳式佩戴",
      confidence: 0.95,
      reason: "商品看起来像半入耳式，佩戴导致耳朵疼",
      needsAttention: false,
    });
    const { database, replies, templates, processor } = setup(client);
    templates.activateVersion({
      library: "bad",
      contentHash: "bad-neutral-wearing",
      sourceRecordCount: 4,
      templates: [
        {
          primaryCategory: "佩戴体验",
          category: "半入耳式佩戴",
          keywords: ["半入耳式佩戴不适", "耳朵疼"],
          replies: [{ sequence: 1, text: "半入耳专用耳塞话术" }],
        },
        {
          primaryCategory: "佩戴体验",
          category: "入耳式佩戴",
          keywords: ["入耳式佩戴不适", "耳道疼", "耳塞胀痛", "耳朵疼"],
          replies: [{ sequence: 1, text: "入耳专用耳塞话术" }],
        },
        {
          primaryCategory: "佩戴体验",
          category: "标题中未提及佩戴类型",
          keywords: ["戴着耳朵疼", "夹耳", "压耳", "佩戴不适"],
          replies: [{ sequence: 1, text: "建议您调整佩戴角度来使耳机更稳固。" }],
        },
        {
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: ["一般"],
          replies: [{ sequence: 1, text: "通用差评话术" }],
        },
      ],
      warnings: [],
    });

    const result = await processor.processSnapshots([{
      ...snapshot("unknown-form-wearing", "戴着耳朵疼"),
      product: "漫步者Zero Air真无线蓝牙耳机降噪通话运动跑步游戏2026新款",
      sentimentLabel: "negative",
    }]);

    expect(result).toMatchObject({ processed: 1, failed: 0, skipped: 0 });
    expect(replies.getBySourceKey("unknown-form-wearing")).toMatchObject({
      category: "标题中未提及佩戴类型",
      originalTemplate: "建议您调整佩戴角度来使耳机更稳固。",
      classificationReason: "商品标题未明确佩戴类型，评价属于佩戴问题，使用中性佩戴话术。",
    });
    database.close();
  });

  it("skips an explicit celebrity or endorsement review before generating a reply", async () => {
    const client = ai({ library: "good", category: "通用整体好评类", confidence: 0.9, reason: "正面", needsAttention: false });
    const { database, replies, processor } = setup(client);

    const result = await processor.processSnapshots([
      snapshot("celebrity-explicit", "想买个有线耳机，看到没新代言人，所以还是选了漫步者，博主同款"),
    ]);

    expect(result).toMatchObject({ processed: 0, failed: 0, skipped: 1 });
    expect(result.items[0]).toMatchObject({ outcome: "skipped", skipped: true, state: "not_actionable" });
    expect(replies.getBySourceKey("celebrity-explicit")).toMatchObject({
      state: "not_actionable",
      errorCode: "CELEBRITY_REVIEW_SKIPPED",
    });
    expect(client.classifyReview).not.toHaveBeenCalled();
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    database.close();
  });

  it("does not treat an ordinary singer metaphor as a celebrity-linked review", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const { database, replies, processor } = setup(client);

    const result = await processor.processSnapshots([
      snapshot("ordinary-singer-metaphor", "音质清晰得仿佛歌手就在耳边低语"),
    ]);

    expect(result).toMatchObject({ processed: 1, failed: 0, skipped: 0 });
    expect(result.items[0]).toMatchObject({ outcome: "completed", state: "read_only_ready" });
    expect(replies.getBySourceKey("ordinary-singer-metaphor")).toMatchObject({
      library: "good",
      category: "音质音效类",
      errorCode: null,
    });
    expect(client.classifyReview).toHaveBeenCalledOnce();
    database.close();
  });

  it("uses the generic good-review fallback for a review containing only empty platform field labels", async () => {
    const client = ai({ library: "bad", category: "通用差评类", confidence: 0.91, reason: "模型把空字段误判为差评", needsAttention: false });
    const { database, replies, templates, processor } = setup(client);
    templates.activateVersion({
      library: "good",
      contentHash: "good-with-platform-field-categories",
      sourceRecordCount: 3,
      templates: [
        { primaryCategory: "佩戴", category: "佩戴体验类", keywords: ["佩戴感受", "佩戴舒适"], replies: [{ sequence: 1, text: "佩戴好评" }] },
        { primaryCategory: "续航", category: "续航表现类", keywords: ["续航能力", "续航不错"], replies: [{ sequence: 1, text: "续航好评" }] },
        { primaryCategory: "通用", category: "通用整体好评类", keywords: [], replies: [{ sequence: 1, text: "通用好评" }] },
      ],
      warnings: [],
    });

    const result = await processor.processSnapshots([
      {
        ...snapshot("empty-field-labels", "佩戴感受： 续航能力："),
        sentimentLabel: "unknown",
      },
    ]);

    expect(result).toMatchObject({ processed: 1, failed: 0, skipped: 0 });
    expect(result.items[0]).toMatchObject({ outcome: "completed", state: "read_only_ready" });
    expect(replies.getBySourceKey("empty-field-labels")).toMatchObject({
      library: "good",
      category: "通用整体好评类",
      finalReply: "通用好评",
      sentimentLabel: "positive",
    });
    database.close();
  });

  it("honors the Pro classifier when a named public figure is mentioned without a cue word", async () => {
    const semanticSkip = {
      library: "good" as const,
      category: "通用整体好评类",
      confidence: 0.96,
      reason: "评论核心内容是公众人物关联购买",
      needsAttention: false,
      skipReply: true,
      skipReason: "评论提及公众人物或其同款，不参与自动回复",
    };
    const client = ai(semanticSkip);
    const { database, replies, processor } = setup(client);

    const result = await processor.processSnapshots([
      snapshot("celebrity-semantic", "就是冲着肖战买的，终于收到了"),
    ]);

    expect(result.items[0]).toMatchObject({ outcome: "skipped", skipped: true, state: "not_actionable" });
    expect(replies.getBySourceKey("celebrity-semantic")).toMatchObject({
      state: "not_actionable",
      errorCode: "CELEBRITY_REVIEW_SKIPPED",
    });
    expect(client.classifyReview).toHaveBeenCalledTimes(1);
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    database.close();
  });

  it("pauses after classification finishes without starting independent sentiment review or recording an AI failure", async () => {
    let keepRunning = true;
    const client = ai({ library: "good", category: "通用整体好评类", confidence: 0.82, reason: "初步判断偏正面", needsAttention: false });
    vi.mocked(client.classifyReview).mockImplementation(async () => {
      keepRunning = false;
      return { library: "good", category: "通用整体好评类", confidence: 0.82, reason: "初步判断偏正面", needsAttention: false };
    });
    const { database, replies, processor } = setup(client);

    const result = await processor.processSnapshots([snapshot("pause-after-primary-classification", "外观还行，但使用感受暂时不确定")], {
      shouldContinue: () => keepRunning,
    });

    expect(result.items[0]).toMatchObject({ outcome: "paused", state: "discovered" });
    expect(client.reviewSentiment).not.toHaveBeenCalled();
    expect(client.adjudicateSentiment).not.toHaveBeenCalled();
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    expect(replies.getBySourceKey("pause-after-primary-classification")).toMatchObject({
      state: "discovered",
      consecutiveAiFailureRounds: 0,
      aiRetryErrorKind: null,
    });
    database.close();
  });

  it("pauses after independent sentiment review finishes without starting adjudication or recording an AI failure", async () => {
    let keepRunning = true;
    const client = ai({ library: "good", category: "通用整体好评类", confidence: 0.82, reason: "初步判断偏正面", needsAttention: false });
    vi.mocked(client.reviewSentiment!).mockImplementation(async () => {
      keepRunning = false;
      return { sentiment: "negative", confidence: 0.94, reason: "独立复核发现负面体验" };
    });
    const { database, replies, processor } = setup(client);

    const result = await processor.processSnapshots([snapshot("pause-after-independent-classification", "外观还行，但实际使用一直断连")], {
      shouldContinue: () => keepRunning,
    });

    expect(result.items[0]).toMatchObject({ outcome: "paused", state: "discovered" });
    expect(client.reviewSentiment).toHaveBeenCalledOnce();
    expect(client.adjudicateSentiment).not.toHaveBeenCalled();
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    expect(replies.getBySourceKey("pause-after-independent-classification")).toMatchObject({
      state: "discovered",
      consecutiveAiFailureRounds: 0,
      aiRetryErrorKind: null,
    });
    database.close();
  });

  it("pauses a listed unknown review after primary sentiment finishes without independent review, hold, retry, or complaint", async () => {
    let keepRunning = true;
    const client = ai({ library: "good", category: "通用整体好评类", confidence: 0.96, reason: "unused", needsAttention: false });
    vi.mocked(client.determineSentiment!).mockImplementation(async () => {
      keepRunning = false;
      return { sentiment: "positive", confidence: 0.82, reason: "初步判断偏正面" };
    });
    const complaintEvaluate = vi.fn<ComplaintReviewPolicy["evaluate"]>(async () => ({ action: "reply" }));
    const { database, replies, products, templates } = setup(client);
    products.upsert({ itemId: "960227744800", title: "名单商品" }, "manual", products.revision());
    const processor = new DraftProcessor({
      replies,
      templates,
      ai: client,
      manualProductPolicy: new ManualProductPolicyService({ products, replies, ai: client }),
      complaintPolicy: { evaluate: complaintEvaluate },
    });
    const input = { ...snapshot("pause-after-manual-primary", "使用感受暂时说不清楚"), sentimentLabel: "unknown" as const };

    const result = await processor.processSnapshots([input], { shouldContinue: () => keepRunning });

    expect(result.items[0]).toMatchObject({ outcome: "paused", state: "discovered" });
    expect(client.determineSentiment).toHaveBeenCalledOnce();
    expect(client.reviewSentiment).not.toHaveBeenCalled();
    expect(client.adjudicateSentiment).not.toHaveBeenCalled();
    expect(complaintEvaluate).not.toHaveBeenCalled();
    expect(replies.getBySourceKey(input.sourceKey)).toMatchObject({
      state: "discovered",
      manualCatalogRevision: null,
      consecutiveAiFailureRounds: 0,
      aiRetryErrorKind: null,
    });
    database.close();
  });

  it("pauses a listed unknown review after independent sentiment finishes without adjudication, hold, retry, or complaint", async () => {
    let keepRunning = true;
    const client = ai({ library: "good", category: "通用整体好评类", confidence: 0.96, reason: "unused", needsAttention: false });
    vi.mocked(client.determineSentiment!).mockResolvedValue({ sentiment: "positive", confidence: 0.82, reason: "初步判断偏正面" });
    vi.mocked(client.reviewSentiment!).mockImplementation(async () => {
      keepRunning = false;
      return { sentiment: "negative", confidence: 0.94, reason: "独立复核发现负面体验" };
    });
    const complaintEvaluate = vi.fn<ComplaintReviewPolicy["evaluate"]>(async () => ({ action: "reply" }));
    const { database, replies, products, templates } = setup(client);
    products.upsert({ itemId: "960227744800", title: "名单商品" }, "manual", products.revision());
    const processor = new DraftProcessor({
      replies,
      templates,
      ai: client,
      manualProductPolicy: new ManualProductPolicyService({ products, replies, ai: client }),
      complaintPolicy: { evaluate: complaintEvaluate },
    });
    const input = { ...snapshot("pause-after-manual-independent", "外观还行，但实际使用一直断连"), sentimentLabel: "unknown" as const };

    const result = await processor.processSnapshots([input], { shouldContinue: () => keepRunning });

    expect(result.items[0]).toMatchObject({ outcome: "paused", state: "discovered" });
    expect(client.determineSentiment).toHaveBeenCalledOnce();
    expect(client.reviewSentiment).toHaveBeenCalledOnce();
    expect(client.adjudicateSentiment).not.toHaveBeenCalled();
    expect(complaintEvaluate).not.toHaveBeenCalled();
    expect(replies.getBySourceKey(input.sourceKey)).toMatchObject({
      state: "discovered",
      manualCatalogRevision: null,
      consecutiveAiFailureRounds: 0,
      aiRetryErrorKind: null,
    });
    database.close();
  });

  it("skips a listed negative review before any complaint call", async () => {
    const client = ai({ library: "bad", category: "通用差评类", confidence: 0.98, reason: "存在明确问题", needsAttention: false });
    vi.mocked(client.determineSentiment!).mockResolvedValue({
      sentiment: "negative",
      reason: "正文明确描述声音断续",
      confidence: 0.97,
    });
    const complaintEvaluate = vi.fn<ComplaintReviewPolicy["evaluate"]>(async () => ({ action: "reply" }));
    const { database, replies, products, templates } = setup(client);
    products.upsert({ itemId: "960227744800", title: "名单商品" }, "manual", products.revision());
    const manualProductPolicy = new ManualProductPolicyService({ products, replies, ai: client });
    const processor = new DraftProcessor({
      replies,
      templates,
      ai: client,
      manualProductPolicy,
      complaintPolicy: { evaluate: complaintEvaluate },
    });
    const input = snapshot("listed-negative-before-complaint", "声音断断续续，很失望");
    input.sentimentLabel = "negative";

    const result = await processor.processSnapshots([input]);

    expect(result.items[0]).toMatchObject({ outcome: "completed", state: "manual_product_hold" });
    expect(complaintEvaluate).not.toHaveBeenCalled();
    expect(client.classifyReview).not.toHaveBeenCalled();
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    database.close();
  });

  it("classifies an unknown listed review before complaint and skips a final negative", async () => {
    const client = ai({ library: "bad", category: "通用差评类", confidence: 0.98, reason: "存在明确问题", needsAttention: false });
    vi.mocked(client.determineSentiment!).mockResolvedValue({
      sentiment: "negative",
      reason: "存在持续断连问题",
      confidence: 0.96,
    });
    const complaintEvaluate = vi.fn<ComplaintReviewPolicy["evaluate"]>(async () => ({ action: "reply" }));
    const { database, replies, products, templates } = setup(client);
    products.upsert({ itemId: "960227744800", title: "名单商品" }, "manual", products.revision());
    const processor = new DraftProcessor({
      replies,
      templates,
      ai: client,
      manualProductPolicy: new ManualProductPolicyService({ products, replies, ai: client }),
      complaintPolicy: { evaluate: complaintEvaluate },
    });
    const input = snapshot("listed-unknown-final-negative", "用了几天总是断连");
    input.sentimentLabel = "unknown";

    const result = await processor.processSnapshots([input]);

    expect(result.items[0]).toMatchObject({ outcome: "completed", state: "manual_product_hold" });
    expect(client.determineSentiment).toHaveBeenCalledOnce();
    expect(complaintEvaluate).not.toHaveBeenCalled();
    expect(client.classifyReview).not.toHaveBeenCalled();
    database.close();
  });

  it("continues a listed final positive review into complaint and reply handling", async () => {
    const events: string[] = [];
    const client = ai({ library: "good", category: "通用整体好评类", confidence: 0.96, reason: "整体满意", needsAttention: false });
    vi.mocked(client.determineSentiment!).mockImplementation(async () => {
      events.push("primary");
      return { sentiment: "positive", reason: "整体偏正面", confidence: 0.82 };
    });
    vi.mocked(client.reviewSentiment!).mockImplementation(async () => {
      events.push("independent");
      return { sentiment: "negative", reason: "存在风险措辞", confidence: 0.86 };
    });
    vi.mocked(client.adjudicateSentiment!).mockImplementation(async () => {
      events.push("adjudicated");
      return { sentiment: "positive", reason: "没有当前未解决问题", confidence: 0.93 };
    });
    const complaintEvaluate = vi.fn<ComplaintReviewPolicy["evaluate"]>(async () => {
      events.push("complaint");
      return { action: "reply" };
    });
    const { database, replies, products, templates } = setup(client);
    products.upsert({ itemId: "960227744800", title: "名单商品" }, "manual", products.revision());
    const processor = new DraftProcessor({
      replies,
      templates,
      ai: client,
      manualProductPolicy: new ManualProductPolicyService({ products, replies, ai: client }),
      complaintPolicy: { evaluate: complaintEvaluate },
    });
    const input = snapshot("listed-unknown-final-positive", "还行，不过目前用着没问题");
    input.sentimentLabel = "unknown";

    const result = await processor.processSnapshots([input]);

    expect(result.items[0]).toMatchObject({ outcome: "completed", state: "read_only_ready" });
    expect(events).toEqual(["primary", "independent", "adjudicated", "complaint"]);
    expect(complaintEvaluate).toHaveBeenCalledOnce();
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(client.rewriteTemplate).toHaveBeenCalledOnce();
    database.close();
  });

  it("still audits a low-confidence good classification when the list gate needed no second review", async () => {
    const client = ai({ library: "good", category: "通用整体好评类", confidence: 0.82, reason: "分类置信度不足", needsAttention: false });
    vi.mocked(client.determineSentiment!).mockResolvedValue({
      sentiment: "positive",
      reason: "评价明确称赞音质",
      confidence: 0.96,
    });
    const { database, replies, products, processor } = setup(client, () => 0, true);
    products.upsert({ itemId: "960227744800", title: "名单商品" }, "manual", products.revision());
    const input = snapshot("listed-clear-primary-low-classification", "音质很好");
    input.sentimentLabel = "unknown";

    await processor.processSnapshots([input]);

    expect(client.determineSentiment).toHaveBeenCalledOnce();
    expect(client.reviewSentiment).toHaveBeenCalledOnce();
    expect(client.adjudicateSentiment).not.toHaveBeenCalled();
    expect(replies.getBySourceKey(input.sourceKey)?.state).toBe("read_only_ready");
    database.close();
  });

  it("defers a complaint requiring manual handling without pausing the reply queue", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const templates = new TemplateRepository(database);
    seedTemplates(templates);
    const complaintPolicy: ComplaintReviewPolicy = {
      evaluate: async () => ({ action: "manual_action_required", caseId: "case-1", caseState: "prepared" }),
    };
    const processor = new DraftProcessor({ replies, templates, ai: client, complaintPolicy });

    const result = await processor.processSnapshots([snapshot("complaint-first")]);

    expect(result.items[0]).toMatchObject({ outcome: "skipped", skipped: true });
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    database.close();
  });

  it("classifies and rewrites an ordinary positive review without creating complaint work", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const templates = new TemplateRepository(database);
    const complaints = new ComplaintRepository(database);
    seedTemplates(templates);
    const analyzeComplaint = vi.fn(async () => {
      throw new Error("ordinary positive reviews must bypass complaint analysis");
    });
    const processor = new DraftProcessor({
      replies,
      templates,
      ai: client,
      complaintPolicy: createProductionComplaintReviewPolicy({
        complaints,
        complaintAutoSubmit: false,
        analyzeComplaint,
      }),
    });
    const input = snapshot("ordinary-positive-bypasses-complaint", "音质很好，佩戴也很舒服");

    const result = await processor.processSnapshots([input]);

    expect(result.items[0]).toMatchObject({ outcome: "completed", state: "read_only_ready" });
    expect(analyzeComplaint).not.toHaveBeenCalled();
    expect(complaints.findBySource("primary", input.sourceKey)).toBeNull();
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(client.rewriteTemplate).toHaveBeenCalledOnce();
    database.close();
  });

  it("skips a true complaint candidate when the current row has no complaint entrance", async () => {
    const client = ai({ library: "bad", category: "通用差评类", confidence: 0.96, reason: "含外部引流", needsAttention: false });
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const templates = new TemplateRepository(database);
    const complaints = new ComplaintRepository(database);
    seedTemplates(templates);
    const analyzeComplaint = vi.fn(async () => {
      throw new Error("a missing complaint entrance must be handled before complaint AI");
    });
    const processor = new DraftProcessor({
      replies,
      templates,
      ai: client,
      complaintPolicy: createProductionComplaintReviewPolicy({
        complaints,
        complaintAutoSubmit: true,
        analyzeComplaint,
      }),
    });
    const input = {
      ...snapshot("platform-handled-no-complaint-entry", "加微信购买课程"),
      platformComplaintEntryState: "unavailable" as const,
    };

    const result = await processor.processSnapshots([input]);

    expect(result.items[0]).toMatchObject({
      outcome: "skipped",
      skipped: true,
      state: "not_actionable",
    });
    expect(analyzeComplaint).not.toHaveBeenCalled();
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({
      state: "not_actionable",
      errorCode: "platform_already_handled",
    });
    expect(replies.getBySourceKey(input.sourceKey)).toMatchObject({
      state: "not_actionable",
      errorCode: "TMALL_PLATFORM_ALREADY_HANDLED",
    });
    database.close();
  });

  it("classifies an unknown-page ordinary review before complaint screening", async () => {
    const events: string[] = [];
    const classification = {
      library: "good" as const,
      category: "音质音效类",
      confidence: 0.96,
      reason: "评价明确称赞音质和佩戴体验",
      needsAttention: false,
    };
    const client = ai(classification);
    vi.mocked(client.classifyReview).mockImplementation(async () => {
      events.push("classification");
      return classification;
    });
    vi.mocked(client.rewriteTemplate).mockImplementation(async (input) => {
      events.push("rewrite");
      return {
        finalReply: input.template,
        productAdjusted: false,
        needsAttention: false,
        notes: "模板原文无需修改",
        detectedTemplateProducts: [],
        unsupportedClaims: [],
      };
    });
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const templates = new TemplateRepository(database);
    seedTemplates(templates);
    const complaintEvaluate = vi.fn<ComplaintReviewPolicy["evaluate"]>(async (draft) => {
      events.push(`complaint:${draft.sentimentLabel}`);
      return { action: "reply" };
    });
    const processor = new DraftProcessor({
      replies,
      templates,
      ai: client,
      complaintPolicy: { evaluate: complaintEvaluate },
    });
    const input = {
      ...snapshot("unknown-ordinary-classified-first", "音质清晰，佩戴舒服，物流也很快"),
      sentimentLabel: "unknown" as const,
    };

    const result = await processor.processSnapshots([input]);

    expect(result.items[0]).toMatchObject({ outcome: "completed", state: "read_only_ready" });
    expect(events).toEqual(["classification", "complaint:positive", "rewrite"]);
    expect(complaintEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({ sentimentLabel: "positive", library: null }),
      expect.any(Object),
    );
    database.close();
  });

  it("does not send an unknown-page ordinary positive review to complaint AI", async () => {
    const client = ai({
      library: "good",
      category: "音质音效类",
      confidence: 0.97,
      reason: "普通好评",
      needsAttention: false,
    });
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const templates = new TemplateRepository(database);
    const complaints = new ComplaintRepository(database);
    seedTemplates(templates);
    const analyzeComplaint = vi.fn(async () => {
      throw new Error("ordinary unknown-page reviews must be classified before complaint screening");
    });
    const processor = new DraftProcessor({
      replies,
      templates,
      ai: client,
      complaintPolicy: createProductionComplaintReviewPolicy({
        complaints,
        complaintAutoSubmit: false,
        analyzeComplaint,
      }),
    });
    const input = {
      ...snapshot("unknown-ordinary-bypasses-complaint", "这款音箱音质很好，操作方便，整体非常满意"),
      sentimentLabel: "unknown" as const,
    };

    const result = await processor.processSnapshots([input]);

    expect(result.items[0]).toMatchObject({ outcome: "completed", state: "read_only_ready" });
    expect(analyzeComplaint).not.toHaveBeenCalled();
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(client.rewriteTemplate).toHaveBeenCalledOnce();
    expect(complaints.findBySource("primary", input.sourceKey)).toBeNull();
    database.close();
  });

  it("releases a legacy internal complaint failure and continues ordinary reply generation in the same run", async () => {
    const client = ai({ library: "good", category: "通用整体好评类", confidence: 0.97, reason: "普通好评", needsAttention: false });
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const templates = new TemplateRepository(database);
    const complaints = new ComplaintRepository(database);
    seedTemplates(templates);
    const input = snapshot("legacy-internal-continues-reply", "做工很好，物流也很快");
    replies.discover(input);
    const legacy = complaints.discover("primary", input.sourceKey, {
      reviewId: input.sourceKey,
      contentHash: "c".repeat(64),
      canonicalizerVersion: "test-v1",
      phase: input.reviewPhase,
      imagePairs: [],
      promptVersion: "test-v1",
      ruleVersion: "test-v1",
      mappingVersion: "test-v1",
      visualVersion: "test-v1",
      platformMappingVersion: "test-v1",
      modelVersion: "test-v1",
    });
    complaints.markFailed(legacy.id, "internal");
    const analyzeComplaint = vi.fn(async () => {
      throw new Error("legacy ordinary reviews must not retry complaint analysis");
    });
    const processor = new DraftProcessor({
      replies,
      templates,
      ai: client,
      complaintPolicy: createProductionComplaintReviewPolicy({
        complaints,
        complaintAutoSubmit: false,
        analyzeComplaint,
      }),
    });

    const result = await processor.processSnapshots([input]);

    expect(result.items[0]).toMatchObject({ outcome: "completed", state: "read_only_ready" });
    expect(analyzeComplaint).not.toHaveBeenCalled();
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(client.rewriteTemplate).toHaveBeenCalledOnce();
    expect(replies.getBySourceKey(input.sourceKey)).toMatchObject({
      state: "read_only_ready",
      library: "good",
      category: "通用整体好评类",
    });
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({
      id: legacy.id,
      state: "no_complaint",
    });
    expect(new ReviewActionGate(database).getLock("primary", input.sourceKey)).toMatchObject({ actionKind: "reply" });
    database.close();
  });

  it("pauses through the circuit breaker when complaint analysis has a technical error", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const templates = new TemplateRepository(database);
    seedTemplates(templates);
    const complaintPolicy: ComplaintReviewPolicy = {
      evaluate: async () => ({ action: "error", caseId: "case-error", caseState: "failed" }),
    };
    const processor = new DraftProcessor({ replies, templates, ai: client, complaintPolicy });

    const result = await processor.processSnapshots([snapshot("complaint-technical-error")]);

    expect(result.items[0]).toMatchObject({ outcome: "circuit_breaker" });
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    database.close();
  });

  it("releases the processing claim after a complaint circuit breaker and safely resumes on the next snapshot run", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const templates = new TemplateRepository(database);
    seedTemplates(templates);
    const complaints = new ComplaintRepository(database);
    let complaintCalls = 0;
    const model = { analyzeComplaint: async () => {
      complaintCalls += 1;
      if (complaintCalls <= 2) throw new DeepSeekTransientError("network", "offline");
      return { decision: "no_complaint" as const, complaintType: "none" as const, confidence: 90, quoteStart: null, quoteEnd: null, factCode: "none" as const, reason: "无投诉依据" };
    } };
    const complaintPolicy = new ComplaintReviewService({ complaints, model, verifier: createAdjudicatedComplaintEligibilityVerifier(model, { invocations: complaints, sleep: async () => undefined }), sleep: async () => undefined });
    const processor = new DraftProcessor({ replies, templates, ai: client, complaintPolicy });
    const input = snapshot("complaint-resume-next-run", "音质很好");

    const first = await processor.processSnapshots([input]);
    expect(first.items[0]).toMatchObject({ outcome: "circuit_breaker" });
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({ state: "failed", complaintType: null });
    expect(database.prepare("SELECT ai_retry_claim_token FROM reply_drafts WHERE source_key = ?").get(input.sourceKey)).toMatchObject({ ai_retry_claim_token: null });
    expect(new ReviewActionGate(database).getLock("primary", input.sourceKey)).toMatchObject({ actionKind: "complaint" });
    expect(replies.canResumeFailedComplaintAnalysis(replies.getBySourceKey(input.sourceKey)!.id)).toBe(true);
    const probeAt = new Date();
    const probeClaim = replies.claimFailedComplaintAnalysisProcessing(replies.getBySourceKey(input.sourceKey)!.id, { at: probeAt, leaseMs: 30 * 60_000 });
    expect(probeClaim).toBeTruthy();
    expect(replies.releaseFailedComplaintAnalysisProcessingClaim(replies.getBySourceKey(input.sourceKey)!.id, { claimToken: probeClaim!, at: new Date(probeAt.getTime() + 1) })).toBe(true);

    const second = await processor.processSnapshots([input]);
    expect(second.items[0]).toMatchObject({ outcome: "completed", state: "read_only_ready" });
    expect(complaintCalls).toBe(3);
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({ state: "no_complaint" });
    database.close();
  });

  it("reclaims a safely paused discovered complaint analysis on the next snapshot run", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const templates = new TemplateRepository(database);
    seedTemplates(templates);
    const complaints = new ComplaintRepository(database);
    let keepRunning = true;
    let calls = 0;
    const model = { analyzeComplaint: async () => {
      calls += 1;
      if (calls === 1) keepRunning = false;
      return { decision: "no_complaint" as const, complaintType: "none" as const, confidence: 90, quoteStart: null, quoteEnd: null, factCode: "none" as const, reason: "无投诉依据" };
    } };
    const complaintPolicy = new ComplaintReviewService({ complaints, model, verifier: createAdjudicatedComplaintEligibilityVerifier(model, { invocations: complaints }) });
    const processor = new DraftProcessor({ replies, templates, ai: client, complaintPolicy });
    const input = snapshot("paused-primary-resumes", "音质很好");

    const first = await processor.processSnapshots([input], { shouldContinue: () => keepRunning });
    expect(first.items[0]).toMatchObject({ outcome: "paused", state: "discovered" });
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({ state: "discovered", complaintType: null });
    keepRunning = true;

    const second = await processor.processSnapshots([input], { shouldContinue: () => true });
    expect(second.items[0]).toMatchObject({ outcome: "completed", state: "read_only_ready" });
    expect(calls).toBe(2);
    expect(client.classifyReview).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("keeps a fact-backed complaint out of the reply path after a prepare rollback", async () => {
    const client = ai({ library: "good", category: "通用整体好评类", confidence: 0.96, reason: "普通评价", needsAttention: false });
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const templates = new TemplateRepository(database);
    seedTemplates(templates);
    const complaints = new ComplaintRepository(database);
    const candidate = { decision: "complaint_candidate" as const, complaintType: "advertising_content" as const, confidence: 92, quoteStart: 0, quoteEnd: 3, factCode: "review_contains_ad_diversion" as const, reason: "广告" };
    let calls = 0;
    const model = { analyzeComplaint: async () => {
      calls += 1;
      if (calls <= 2) return candidate;
      return { decision: "no_complaint" as const, complaintType: "none" as const, confidence: 90, quoteStart: null, quoteEnd: null, factCode: "none" as const, reason: "重新审核无投诉依据" };
    } };
    const complaintPolicy = new ComplaintReviewService({ complaints, model, verifier: createAdjudicatedComplaintEligibilityVerifier(model, { invocations: complaints }) });
    const processor = new DraftProcessor({ replies, templates, ai: client, complaintPolicy });
    const input = snapshot("paused-after-prepare-resumes", "加微信");
    let pauseOnPrepared = true;
    const shouldContinue = () => !pauseOnPrepared || complaints.findBySource("primary", input.sourceKey)?.state !== "prepared";

    const first = await processor.processSnapshots([input], { shouldContinue });
    expect(first.items[0]).toMatchObject({ outcome: "paused", state: "discovered" });
    const complaintCase = complaints.findBySource("primary", input.sourceKey)!;
    expect(database.prepare("SELECT COUNT(*) AS value FROM complaint_attempts WHERE complaint_case_id = ?").get(complaintCase.id)).toEqual({ value: 0 });
    pauseOnPrepared = false;

    const second = await processor.processSnapshots([input], { shouldContinue });
    expect(second.items[0]).toMatchObject({ outcome: "skipped", state: "discovered", skipped: true });
    expect(calls).toBe(2);
    expect(client.classifyReview).toHaveBeenCalledTimes(2);
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({ state: "manual_action_required" });
    database.close();
  });

  it("uses a directly proven primary complaint without requiring two more matching model passes", async () => {
    const client = ai({ library: "good", category: "通用整体好评类", confidence: 0.96, reason: "普通评价", needsAttention: false });
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const templates = new TemplateRepository(database);
    seedTemplates(templates);
    const complaints = new ComplaintRepository(database);
    const primary = { decision: "complaint_candidate" as const, complaintType: "advertising_content" as const, confidence: 90, quoteStart: 0, quoteEnd: 3, factCode: "review_contains_ad_diversion" as const, reason: "广告" };
    const independent = { decision: "no_complaint" as const, complaintType: "none" as const, confidence: 40, quoteStart: null, quoteEnd: null, factCode: "none" as const, reason: "依据不足" };
    const unmatched = {
      decision: "complaint_candidate" as const,
      complaintType: "insulting_content" as const,
      confidence: 86,
      quoteStart: 0,
      quoteEnd: 3,
      factCode: "review_attacks_person" as const,
      reason: "第三轮给出了不同投诉事实",
    };
    let complaintCalls = 0;
    const model = { analyzeComplaint: async (input: ComplaintAnalysisInput) => {
      complaintCalls += 1;
      if (input.pass === "primary") return primary;
      return input.pass === "independent_review" ? independent : unmatched;
    } };
    const complaintPolicy = new ComplaintReviewService({
      complaints,
      model,
      verifier: createAdjudicatedComplaintEligibilityVerifier(model, { invocations: complaints }),
    });
    const processor = new DraftProcessor({ replies, templates, ai: client, complaintPolicy });
    const input = snapshot("unmatched-third-continues-reply", "加微信购买");

    const result = await processor.processSnapshots([input]);

    expect(result.items[0]).toMatchObject({ outcome: "skipped", state: "discovered", skipped: true });
    expect(complaintCalls).toBe(1);
    expect(complaints.findBySource("primary", input.sourceKey)).toMatchObject({ state: "manual_action_required" });
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    database.close();
  });

  it("matches an exact category and persists the randomly selected template", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const { database, replies, processor } = setup(client, () => 1);
    const progress: string[] = [];

    const result = await processor.processSnapshots([snapshot("order-1")], { onProgress: (message) => progress.push(message) });
    const saved = replies.get(result.items[0]!.id);

    expect(saved).toMatchObject({ category: "音质音效类", templateSequence: 2, originalTemplate: "音质话术二", state: "read_only_ready" });
    expect(client.rewriteTemplate).toHaveBeenCalledWith(expect.objectContaining({ template: "音质话术二" }));
    expect(progress).toEqual(expect.arrayContaining(["正在判断评论分类", "正在选择回复话术", "正在修正商品信息", "回复草稿已生成"]));
    database.close();
  });

  it("uses negative content classification without blocking on a conflicting positive page label", async () => {
    const client = ai({ library: "bad", category: "通用差评类", confidence: 0.72, reason: "实际内容是负面反馈", needsAttention: false });
    const { database, replies, processor } = setup(client);

    const result = await processor.processSnapshots([snapshot("order-2", "质量很差")]);
    const saved = replies.get(result.items[0]!.id);

    expect(saved).toMatchObject({ library: "bad", primaryCategory: "通用差评类", category: "通用差评类", originalTemplate: "通用差评话术", state: "read_only_ready" });
    expect(saved?.attentionReasons).not.toContain("页面标记为正面评价，但评论内容被识别为差评");
    database.close();
  });

  it("uses positive content classification without blocking on a conflicting negative page label", async () => {
    const client = ai({ library: "good", category: "通用整体好评类", confidence: 0.93, reason: "正文明确满意", needsAttention: false });
    const { database, replies, processor } = setup(client);
    const input = snapshot("negative-page-positive-content", "音质很好，操作方便，非常满意");
    input.sentimentLabel = "negative";

    const result = await processor.processSnapshots([input]);
    const saved = replies.get(result.items[0]!.id);

    expect(saved).toMatchObject({ library: "good", category: "音质音效类", state: "read_only_ready" });
    expect(saved?.attentionReasons).not.toContain("页面标记为负面评价，但评论内容被识别为好评");
    database.close();
  });

  it("routes a reluctant low-price comparison to the bad template library even when the model returns good", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.91, reason: "提到品牌", needsAttention: false });
    const { database, replies, processor } = setup(client);

    const result = await processor.processSnapshots([
      snapshot("reluctant-low-price-comparison", "没有感受到与那些十几块二十块钱的区别，不过好歹也是牌子货，买就买了。"),
    ]);
    const saved = replies.get(result.items[0]!.id);

    expect(saved).toMatchObject({
      library: "bad",
      primaryCategory: "通用差评类",
      category: "通用差评类",
      originalTemplate: "通用差评话术",
    });
    expect(saved?.classificationReason).toContain("低价对比");
    database.close();
  });

  it("uses an independent negative audit before allowing an unfamiliar review into the good library", async () => {
    const client = ai({ library: "good", category: "通用整体好评类", confidence: 0.82, reason: "没有命中已知问题", needsAttention: false });
    vi.mocked(client.reviewSentiment!).mockResolvedValue({
      sentiment: "negative",
      reason: "转折后的最新结论仍表达明显不满",
      confidence: 0.94,
    });
    vi.mocked(client.adjudicateSentiment!).mockResolvedValue({
      sentiment: "negative",
      reason: "最终确认仍存在负面体验",
      confidence: 0.96,
    });
    const { database, replies, processor } = setup(client);

    const result = await processor.processSnapshots([
      snapshot("unfamiliar-negative", "外观看着还可以，但实际用下来总让我后悔，当时不该图省事。"),
    ]);
    const saved = replies.get(result.items[0]!.id);

    expect(saved).toMatchObject({
      library: "bad",
      primaryCategory: "通用差评类",
      category: "通用差评类",
      originalTemplate: "通用差评话术",
    });
    expect(saved?.classificationReason).toContain("情感最终裁决");
    expect(client.reviewSentiment).toHaveBeenCalledWith(expect.objectContaining({
      reviewPhase: "initial",
    }));
    expect(client.adjudicateSentiment).toHaveBeenCalledOnce();
    database.close();
  });

  it("keeps the selected template verbatim except for an explicit old-product substitution", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.rewriteTemplate).mockResolvedValue({
      finalReply: "感谢您选购当前商品，若有任何疑问欢迎咨询在线客服。",
      productAdjusted: true,
      needsAttention: false,
      notes: "仅替换模板中的旧商品名称",
      detectedTemplateProducts: ["旧款耳机"],
      unsupportedClaims: [],
    });
    const { database, replies, templates, processor } = setup(client, () => 0);
    templates.activateVersion({
      library: "good", contentHash: "good-product-template", sourceRecordCount: 2,
      templates: [
        { primaryCategory: "", category: "音质音效类", keywords: ["音质"], replies: [{ sequence: 1, text: "感谢您选购旧款耳机，若有任何疑问欢迎咨询在线客服。" }] },
        { primaryCategory: "", category: "通用整体好评类", keywords: [], replies: [{ sequence: 1, text: "通用好评" }] },
      ], warnings: [],
    });

    await processor.processSnapshots([{ ...snapshot("template-preserving"), product: "当前商品" }]);

    expect(replies.getBySourceKey("template-preserving")).toMatchObject({
      originalTemplate: "感谢您选购旧款耳机，若有任何疑问欢迎咨询在线客服。",
      finalReply: "感谢您选购当前商品，若有任何疑问欢迎咨询在线客服。",
      productAdjusted: true,
    });
    database.close();
  });

  it("rejects an AI rewrite that changes template wording beyond declared product spans", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.rewriteTemplate).mockResolvedValue({
      finalReply: "这是 AI 自由改写出的全新回复。",
      productAdjusted: true,
      needsAttention: false,
      notes: "不应接受",
      detectedTemplateProducts: ["不存在的旧商品"],
      unsupportedClaims: [],
    });
    const sleep = vi.fn(async () => undefined);
    const { database, replies, processor } = setup(client, () => 0, false, { sleep });

    await processor.processSnapshots([snapshot("reject-free-rewrite")]);

    expect(replies.getBySourceKey("reject-free-rewrite")).toMatchObject({
      state: "retry_wait",
      failedStage: "rewrite",
      aiRetryErrorKind: "model_contract",
    });
    expect(client.rewriteTemplate).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("gives concurrent ordinary reprocess work one persistent owner and one rewrite call", async () => {
    let releaseRewrite!: (value: TemplateRewriteResult) => void;
    let enteredRewrite!: () => void;
    const rewriteEntered = new Promise<void>((resolve) => { enteredRewrite = resolve; });
    const blockedRewrite = new Promise<TemplateRewriteResult>((resolve) => { releaseRewrite = resolve; });
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.rewriteTemplate).mockImplementationOnce(async () => {
      enteredRewrite();
      return blockedRewrite;
    });
    const { database, replies, processor } = setup(client);
    const input = snapshot("ordinary-owner-race");

    const first = processor.processSnapshots([input]);
    await rewriteEntered;
    const second = await processor.processSnapshots([input]);
    expect(second.items[0]).toMatchObject({ outcome: "skipped", skipped: true });
    expect(client.rewriteTemplate).toHaveBeenCalledTimes(1);

    releaseRewrite({
      finalReply: "音质话术一",
      productAdjusted: false,
      needsAttention: false,
      notes: "current owner",
      detectedTemplateProducts: [],
      unsupportedClaims: [],
    });
    await first;
    expect(replies.getBySourceKey(input.sourceKey)).toMatchObject({ state: "read_only_ready", rewriteNotes: "current owner" });
    database.close();
  });

  it("retries an AI adapter category outside the selected library as a model contract failure", async () => {
    const client = ai({ library: "bad", category: "通用整体好评类", confidence: 0.72, reason: "错误的跨库分类", needsAttention: false });
    const sleep = vi.fn(async () => undefined);
    const { database, replies, processor } = setup(client, () => 0, false, { sleep });

    const result = await processor.processSnapshots([snapshot("order-invalid-category", "质量很差")]);
    const saved = replies.get(result.items[0]!.id);

    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(saved).toMatchObject({
      state: "retry_wait",
      library: null,
      category: "",
      failedStage: "classification",
      aiRetryErrorKind: "model_contract",
      consecutiveAiFailureRounds: 1,
    });
    expect(client.classifyReview).toHaveBeenCalledTimes(2);
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledWith(1_000);
    database.close();
  });

  it("does not call DeepSeek twice for the same completed source key", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const { database, processor } = setup(client);

    await processor.processSnapshots([snapshot("order-3")]);
    const second = await processor.processSnapshots([snapshot("order-3")]);

    expect(client.classifyReview).toHaveBeenCalledTimes(1);
    expect(second.skipped).toBe(1);
    database.close();
  });

  it("selects a template independently for each new review and does not reroll a completed review", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const picks = [0, 2];
    const pickIndex = vi.fn(() => picks.shift() ?? 0);
    const { database, replies, processor } = setup(client, pickIndex);

    const firstPass = await processor.processSnapshots([snapshot("order-random-1"), snapshot("order-random-2")]);
    const selected = firstPass.items.map((item) => replies.get(item.id)?.templateSequence);
    await processor.processSnapshots([snapshot("order-random-1")]);

    expect(selected).toEqual([1, 3]);
    expect(pickIndex).toHaveBeenCalledTimes(2);
    expect(client.classifyReview).toHaveBeenCalledTimes(2);
    expect(client.rewriteTemplate).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("filters a headphone-only reply before selecting wording for a speaker", async () => {
    const client = ai({
      library: "good",
      category: "外观颜值类",
      confidence: 0.95,
      reason: "称赞音箱外观",
      needsAttention: false,
    });
    const { database, replies, templates, processor } = setup(client, () => 0);
    templates.activateVersion({
      library: "good",
      contentHash: "good-product-compatible-selection",
      sourceRecordCount: 2,
      templates: [
        {
          primaryCategory: "",
          category: "外观颜值类",
          keywords: ["颜值很高"],
          replies: [
            { sequence: 1, text: "愿这款好看的耳机陪您解锁更多美好瞬间。" },
            { sequence: 2, text: "感谢您认可产品的高颜值，祝您使用愉快。" },
          ],
        },
        {
          primaryCategory: "",
          category: "通用整体好评类",
          keywords: ["很好"],
          replies: [{ sequence: 1, text: "感谢您的认可。" }],
        },
      ],
      warnings: [],
    });
    const input = snapshot("speaker-template-compatibility", "颜值很高，摆在家里很好看");
    input.product = "漫步者M285无线蓝牙音箱便携迷你音响";

    const result = await processor.processSnapshots([input]);

    expect(replies.get(result.items[0]!.id)).toMatchObject({
      category: "外观颜值类",
      templateSequence: 2,
      originalTemplate: "感谢您认可产品的高颜值，祝您使用愉快。",
    });
    database.close();
  });

  it("ranks the matching sub-intent within a category before applying random rotation", async () => {
    const client = ai({
      library: "bad",
      category: "耳夹式佩戴",
      confidence: 0.95,
      reason: "耳夹佩戴不稳",
      needsAttention: false,
    });
    const pickIndex = vi.fn((length: number) => (length === 1 ? 0 : 1));
    const { database, replies, templates, processor } = setup(client, pickIndex);
    templates.activateVersion({
      library: "bad",
      contentHash: "bad-semantic-reply-selection",
      sourceRecordCount: 2,
      templates: [
        {
          primaryCategory: "佩戴体验",
          category: "耳夹式佩戴",
          keywords: ["易掉", "戴不稳"],
          replies: [
            { sequence: 1, text: "您可调整耳夹位置和松紧度，如仍有疑问请联系我们。" },
            { sequence: 2, text: "建议控制佩戴时长适时放松，缓解久戴不适。" },
          ],
        },
        {
          primaryCategory: "通用差评类",
          category: "通用差评类",
          keywords: [],
          replies: [{ sequence: 1, text: "很抱歉影响您的体验。" }],
        },
      ],
      warnings: [],
    });
    const input = snapshot("earclip-sub-intent", "左耳刚好，右耳有点松，走路容易掉");
    input.product = "漫步者Comfo SE耳夹式蓝牙耳机";

    const result = await processor.processSnapshots([input]);

    expect(replies.get(result.items[0]!.id)).toMatchObject({
      templateSequence: 1,
      originalTemplate: "您可调整耳夹位置和松紧度，如仍有疑问请联系我们。",
    });
    expect(pickIndex).toHaveBeenCalledWith(1);
    database.close();
  });

  it("promotes a concrete category when a detailed review was classified as generic", async () => {
    const client = ai({
      library: "good",
      category: "通用整体好评类",
      confidence: 0.92,
      reason: "整体满意",
      needsAttention: false,
    });
    const { database, replies, templates, processor } = setup(client, () => 0);
    templates.activateVersion({
      library: "good",
      contentHash: "good-specific-category-backstop",
      sourceRecordCount: 2,
      templates: [
        {
          primaryCategory: "",
          category: "品质体验类",
          keywords: ["好用", "质量很好"],
          replies: [{ sequence: 1, text: "感谢您对产品品质的认可。" }],
        },
        {
          primaryCategory: "",
          category: "通用整体好评类",
          keywords: ["非常满意"],
          replies: [{ sequence: 1, text: "感谢您的好评。" }],
        },
      ],
      warnings: [],
    });

    const result = await processor.processSnapshots([
      snapshot("specific-category-backstop", "商品品质非常有保障，使用过程中没有出现任何问题，非常满意。"),
    ]);

    expect(replies.get(result.items[0]!.id)).toMatchObject({
      category: "品质体验类",
      originalTemplate: "感谢您对产品品质的认可。",
    });
    database.close();
  });

  it("uses the good fallback for an unopened gift with no concrete product problem", async () => {
    const client = ai({
      library: "bad",
      category: "通用差评类",
      confidence: 0.7,
      reason: "没有实际体验",
      needsAttention: false,
    });
    const { database, replies, processor } = setup(client, () => 0);

    const result = await processor.processSnapshots([
      snapshot("unopened-gift-neutral", "送人的，没打开，不知道咋样，好像还有个小套。"),
    ]);

    expect(replies.get(result.items[0]!.id)).toMatchObject({
      library: "good",
      category: "通用整体好评类",
      originalTemplate: "通用好评",
    });
    database.close();
  });

  it("retries one transient classification failure and continues with the next review", async () => {
    let call = 0;
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.9, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.classifyReview).mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new DeepSeekTransientError("network", "safe transient failure");
      return { library: "good", category: "音质音效类", confidence: 0.9, reason: "称赞音质", needsAttention: false };
    });
    const sleep = vi.fn(async () => undefined);
    const { database, replies, processor } = setup(client, () => 0, false, { sleep });

    const result = await processor.processSnapshots([snapshot("order-4"), snapshot("order-5")]);

    expect(result).toMatchObject({ processed: 2, failed: 0 });
    expect(replies.list().map((item) => item.state).sort()).toEqual(["read_only_ready", "read_only_ready"]);
    expect(client.classifyReview).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1_000);
    database.close();
  });

  it("retries a manual-product sentiment determination once before continuing", async () => {
    const client = ai({ library: "good", category: "闊宠川闊虫晥绫?", confidence: 0.9, reason: "绉拌禐闊宠川", needsAttention: false });
    vi.mocked(client.determineSentiment)
      .mockRejectedValueOnce(new DeepSeekTransientError("network", "temporary sentiment outage"))
      .mockResolvedValueOnce({ sentiment: "positive", reason: "鏁翠綋鍋忔闈?", confidence: 0.9 });
    const sleep = vi.fn(async () => undefined);
    const { database, products, replies, templates, processor } = setup(client, () => 0, true, { sleep });
    vi.mocked(client.classifyReview).mockResolvedValue({
      library: "good",
      category: templates.getActiveCategories("good")[0]!.category,
      confidence: 0.9,
      reason: "绉拌禐闊宠川",
      needsAttention: false,
    });
    products.upsert({ itemId: "960227744800", title: "婕鑰?X1 EVO" }, "manual", products.revision());

    const input = { ...snapshot("order-manual-sentiment-retry", "杩樿"), sentimentLabel: "unknown" as const };
    const result = await processor.processSnapshots([input]);

    expect(result.items[0]).toMatchObject({ outcome: "completed", state: "read_only_ready" });
    expect(client.determineSentiment).toHaveBeenCalledTimes(2);
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1_000);
    database.close();
  });

  it("stores a classification retry when manual-product sentiment determination fails twice", async () => {
    const now = new Date("2026-07-16T04:00:00.000Z");
    const client = ai({ library: "good", category: "闊宠川闊虫晥绫?", confidence: 0.9, reason: "绉拌禐闊宠川", needsAttention: false });
    vi.mocked(client.determineSentiment).mockRejectedValue(new DeepSeekTransientError("rate_limited", "temporary sentiment outage"));
    const sleep = vi.fn(async () => undefined);
    const { database, products, replies, processor } = setup(client, () => 0, true, { now: () => now, sleep });
    products.upsert({ itemId: "960227744800", title: "婕鑰?X1 EVO" }, "manual", products.revision());
    const input = { ...snapshot("order-manual-sentiment-wait", "杩樿"), sentimentLabel: "unknown" as const };

    const result = await processor.processSnapshots([input]);

    expect(result.items[0]).toMatchObject({ state: "retry_wait", outcome: "retry_wait" });
    expect(replies.get(result.items[0]!.id)).toMatchObject({
      state: "retry_wait",
      failedStage: "classification",
      aiRetryErrorKind: "rate_limited",
      nextRetryAt: "2026-07-16T04:05:00.000Z",
      consecutiveAiFailureRounds: 1,
    });
    expect(client.determineSentiment).toHaveBeenCalledTimes(2);
    expect(client.classifyReview).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledWith(1_000);
    database.close();
  });

  it("does not retry a manual-product sentiment configuration failure", async () => {
    const client = ai({ library: "good", category: "闊宠川闊虫晥绫?", confidence: 0.9, reason: "绉拌禐闊宠川", needsAttention: false });
    vi.mocked(client.determineSentiment).mockRejectedValue(
      new DeepSeekConfigurationError("authentication", "sensitive sentiment configuration failure"),
    );
    const sleep = vi.fn(async () => undefined);
    const { database, products, replies, processor } = setup(client, () => 0, true, { sleep });
    products.upsert({ itemId: "960227744800", title: "婕鑰?X1 EVO" }, "manual", products.revision());
    const input = { ...snapshot("order-manual-sentiment-configuration", "杩樿"), sentimentLabel: "unknown" as const };

    const result = await processor.processSnapshots([input]);

    expect(result.items[0]).toMatchObject({ state: "failed", outcome: "manual_action_required" });
    expect(replies.get(result.items[0]!.id)).toMatchObject({
      state: "failed",
      errorCode: "DEEPSEEK_AUTHENTICATION_REQUIRED",
      consecutiveAiFailureRounds: 0,
    });
    expect(client.determineSentiment).toHaveBeenCalledOnce();
    expect(client.classifyReview).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    database.close();
  });

  it("fails manual-product sentiment setup immediately when the sentiment service is missing", async () => {
    const client = ai({ library: "good", category: "unused", confidence: 0.9, reason: "unused", needsAttention: false });
    client.determineSentiment = undefined;
    const sleep = vi.fn(async () => undefined);
    const { database, products, replies, processor } = setup(client, () => 0, true, { sleep });
    products.upsert({ itemId: "960227744800", title: "manual-product" }, "manual", products.revision());
    const input = { ...snapshot("order-manual-sentiment-missing", "okay"), sentimentLabel: "unknown" as const };

    const result = await processor.processSnapshots([input]);

    expect(result.items[0]).toMatchObject({ state: "failed", outcome: "manual_action_required" });
    expect(replies.get(result.items[0]!.id)).toMatchObject({
      state: "failed",
      errorCode: "DEEPSEEK_CONFIGURATION_REQUIRED",
      consecutiveAiFailureRounds: 0,
      nextRetryAt: null,
    });
    expect(client.classifyReview).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    database.close();
  });

  it("reruns manual-product sentiment policy for a claimed classification retry without a checkpoint", async () => {
    const start = new Date("2026-07-16T04:00:00.000Z");
    const due = new Date("2026-07-16T04:05:00.000Z");
    const client = ai({ library: "good", category: "闊宠川闊虫晥绫?", confidence: 0.9, reason: "绉拌禐闊宠川", needsAttention: false });
    vi.mocked(client.determineSentiment).mockRejectedValue(new DeepSeekTransientError("network", "initial sentiment outage"));
    const { database, products, replies, templates, processor } = setup(client, () => 0, true, { now: () => start, sleep: async () => undefined });
    vi.mocked(client.classifyReview).mockResolvedValue({
      library: "good",
      category: templates.getActiveCategories("good")[0]!.category,
      confidence: 0.9,
      reason: "绉拌禐闊宠川",
      needsAttention: false,
    });
    products.upsert({ itemId: "960227744800", title: "婕鑰?X1 EVO" }, "manual", products.revision());
    const input = { ...snapshot("order-manual-sentiment-claimed", "杩樿"), sentimentLabel: "unknown" as const };
    await processor.processSnapshots([input]);
    vi.mocked(client.determineSentiment).mockResolvedValue({ sentiment: "positive", reason: "鏁翠綋鍋忔闈?", confidence: 0.9 });
    const claim = replies.claimDueAiRetries({ now: due, leaseMs: 60_000 });

    const result = await processor.processClaimedRetry(claim.drafts[0]!, claim.claimToken, due);

    expect(result).toMatchObject({ state: "read_only_ready", outcome: "completed" });
    expect(client.determineSentiment).toHaveBeenCalledTimes(3);
    expect(client.classifyReview).toHaveBeenCalledOnce();
    database.close();
  });

  it("runs classification before complaint when a listed unknown sentiment retry recovers", async () => {
    const start = new Date("2026-07-16T04:00:00.000Z");
    const due = new Date("2026-07-16T04:05:00.000Z");
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.determineSentiment!).mockRejectedValue(new DeepSeekTransientError("network", "initial sentiment outage"));
    const base = setup(client, () => 0, false, { now: () => start, sleep: async () => undefined });
    base.products.upsert({ itemId: "960227744800", title: "名单商品" }, "manual", base.products.revision());
    const events: string[] = [];
    const complaintEvaluate = vi.fn<ComplaintReviewPolicy["evaluate"]>(async () => {
      events.push("complaint");
      return { action: "reply" };
    });
    const processor = new DraftProcessor({
      replies: base.replies,
      templates: base.templates,
      ai: client,
      manualProductPolicy: new ManualProductPolicyService({ products: base.products, replies: base.replies, ai: client }),
      complaintPolicy: { evaluate: complaintEvaluate },
      pickIndex: () => 0,
      now: () => start,
      sleep: async () => undefined,
    });
    const input = { ...snapshot("listed-unknown-retry-complaint-order", "音质很好"), sentimentLabel: "unknown" as const };

    const first = await processor.processSnapshots([input]);
    expect(first.items[0]).toMatchObject({ state: "retry_wait", outcome: "retry_wait" });
    expect(complaintEvaluate).not.toHaveBeenCalled();

    vi.mocked(client.determineSentiment!).mockResolvedValue({ sentiment: "positive", reason: "整体明确正面", confidence: 0.96 });
    vi.mocked(client.classifyReview).mockImplementation(async () => {
      events.push("classification");
      return { library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false };
    });
    vi.mocked(client.rewriteTemplate).mockImplementation(async (rewriteInput) => {
      events.push("rewrite");
      return {
        finalReply: rewriteInput.template,
        productAdjusted: false,
        needsAttention: false,
        notes: "模板原文无需修改",
        detectedTemplateProducts: [],
        unsupportedClaims: [],
      };
    });
    const claim = base.replies.claimDueAiRetries({ now: due, leaseMs: 60_000 });

    const recovered = await processor.processClaimedRetry(claim.drafts[0]!, claim.claimToken, due);

    expect(recovered).toMatchObject({ state: "read_only_ready", outcome: "completed" });
    expect(complaintEvaluate).toHaveBeenCalledOnce();
    expect(events).toEqual(["classification", "complaint", "rewrite"]);
    base.database.close();
  });

  it("does not run complaint until a classification retry succeeds", async () => {
    const start = new Date("2026-07-16T05:00:00.000Z");
    const due = new Date("2026-07-16T05:05:00.000Z");
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.classifyReview).mockRejectedValue(new DeepSeekTransientError("network", "classification outage"));
    const base = setup(client, () => 0, false, { now: () => start, sleep: async () => undefined });
    const complaintEvaluate = vi.fn<ComplaintReviewPolicy["evaluate"]>(async () => ({ action: "reply" }));
    const processor = new DraftProcessor({
      replies: base.replies,
      templates: base.templates,
      ai: client,
      manualProductPolicy: new ManualProductPolicyService({ products: base.products, replies: base.replies, ai: client }),
      complaintPolicy: { evaluate: complaintEvaluate },
      pickIndex: () => 0,
      now: () => start,
      sleep: async () => undefined,
    });
    const input = snapshot("post-complaint-classification-retry", "音质很好");

    const first = await processor.processSnapshots([input]);
    expect(first.items[0]).toMatchObject({ state: "retry_wait", outcome: "retry_wait" });
    expect(complaintEvaluate).not.toHaveBeenCalled();

    vi.mocked(client.classifyReview).mockResolvedValue({
      library: "good",
      category: "音质音效类",
      confidence: 0.96,
      reason: "重试后分类成功",
      needsAttention: false,
    });
    const claim = base.replies.claimDueAiRetries({ now: due, leaseMs: 60_000 });
    await processor.processClaimedRetry(claim.drafts[0]!, claim.claimToken, due);

    expect(complaintEvaluate).toHaveBeenCalledOnce();
    expect(client.classifyReview).toHaveBeenCalledTimes(3);
    base.database.close();
  });

  it("retries rewrite once without reclassifying or rerolling the template", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.rewriteTemplate)
      .mockRejectedValueOnce(new DeepSeekTransientError("timeout", "safe timeout"));
    const pickIndex = vi.fn(() => 2);
    const sleep = vi.fn(async () => undefined);
    const { database, replies, processor } = setup(client, pickIndex, false, { sleep });

    const result = await processor.processSnapshots([snapshot("order-rewrite-retry")]);
    const saved = replies.get(result.items[0]!.id);

    expect(saved).toMatchObject({
      state: "read_only_ready",
      aiCheckpointStage: "template_selected",
      templateSequence: 3,
      consecutiveAiFailureRounds: 0,
    });
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(client.rewriteTemplate).toHaveBeenCalledTimes(2);
    expect(pickIndex).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1_000);
    database.close();
  });

  it("stores a redacted five-minute classification retry after two transient failures", async () => {
    const now = new Date("2026-07-16T04:00:00.000Z");
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.classifyReview).mockRejectedValue(new DeepSeekTransientError("timeout", "upstream secret response"));
    const sleep = vi.fn(async () => undefined);
    const pickIndex = vi.fn(() => 0);
    const { database, replies, processor } = setup(client, pickIndex, false, { now: () => now, sleep });

    const result = await processor.processSnapshots([snapshot("order-classification-wait")]);
    const saved = replies.get(result.items[0]!.id);

    expect(result.items[0]).toMatchObject({ state: "retry_wait", outcome: "retry_wait" });
    expect(saved).toMatchObject({
      state: "retry_wait",
      failedStage: "classification",
      aiRetryErrorKind: "timeout",
      nextRetryAt: "2026-07-16T04:05:00.000Z",
      consecutiveAiFailureRounds: 1,
      errorCode: null,
      errorMessage: null,
    });
    expect(JSON.stringify(saved)).not.toContain("upstream secret response");
    expect(client.classifyReview).toHaveBeenCalledTimes(2);
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    expect(pickIndex).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("resumes retry_wait when the live page encounters it again even before the stored due time", async () => {
    const now = new Date("2026-07-16T05:00:00.000Z");
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.classifyReview).mockRejectedValue(new DeepSeekTransientError("network", "safe failure"));
    const { database, replies, processor } = setup(client, () => 0, false, {
      now: () => now,
      sleep: async () => undefined,
    });
    const input = snapshot("order-not-due");
    await processor.processSnapshots([input]);
    vi.mocked(client.classifyReview).mockResolvedValue({
      library: "good",
      category: "音质音效类",
      confidence: 0.98,
      reason: "页面再次遇到后已成功分类",
      needsAttention: false,
    });
    vi.mocked(client.classifyReview).mockClear();

    const repeated = await processor.processSnapshots([input]);

    expect(repeated).toMatchObject({ processed: 1, skipped: 0 });
    expect(repeated.items[0]).toMatchObject({ state: "read_only_ready", outcome: "completed" });
    expect(replies.getBySourceKey(input.sourceKey)).toMatchObject({ state: "read_only_ready" });
    expect(client.classifyReview).toHaveBeenCalledOnce();
    database.close();
  });

  it("resumes only the retry that is observed again on the live page", async () => {
    let now = new Date("2026-07-16T05:00:00.000Z");
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.classifyReview).mockRejectedValue(new DeepSeekTransientError("network", "safe failure"));
    const { database, replies, processor } = setup(client, () => 0, false, {
      now: () => now,
      sleep: async () => undefined,
    });
    const visibleAgain = snapshot("order-observed-retry");
    const importedOnly = snapshot("order-imported-retry");
    await processor.processSnapshots([visibleAgain, importedOnly]);
    vi.mocked(client.classifyReview).mockResolvedValue({
      library: "good",
      category: "音质音效类",
      confidence: 0.98,
      reason: "页面再次识别后分类成功",
      needsAttention: false,
    });
    vi.mocked(client.classifyReview).mockClear();
    now = new Date("2026-07-16T05:05:00.000Z");

    const result = await processor.processSnapshots([visibleAgain]);

    expect(result.items[0]).toMatchObject({ state: "read_only_ready", outcome: "completed" });
    expect(replies.getBySourceKey(visibleAgain.sourceKey)).toMatchObject({ state: "read_only_ready" });
    expect(replies.getBySourceKey(importedOnly.sourceKey)).toMatchObject({
      state: "retry_wait",
      consecutiveAiFailureRounds: 1,
    });
    expect(client.classifyReview).toHaveBeenCalledOnce();
    database.close();
  });

  it("continues a claimed classification retry with the same claim through checkpoint and rewrite", async () => {
    const start = new Date("2026-07-16T06:00:00.000Z");
    const due = new Date("2026-07-16T06:05:00.000Z");
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.classifyReview).mockRejectedValue(new DeepSeekTransientError("network", "safe failure"));
    const pickIndex = vi.fn(() => 1);
    const { database, replies, processor } = setup(client, pickIndex, false, {
      now: () => start,
      sleep: async () => undefined,
    });
    await processor.processSnapshots([snapshot("order-claimed-classification")]);
    vi.mocked(client.classifyReview).mockResolvedValue({
      library: "good", category: "音质音效类", confidence: 0.98, reason: "重试后分类成功", needsAttention: false,
    });
    const claim = replies.claimDueAiRetries({ now: due, leaseMs: 60_000 });

    const result = await processor.processClaimedRetry(claim.drafts[0]!, claim.claimToken, due);
    const saved = replies.get(claim.drafts[0]!.id);

    expect(result).toMatchObject({ state: "read_only_ready", outcome: "completed" });
    expect(saved).toMatchObject({
      state: "read_only_ready",
      aiCheckpointStage: "template_selected",
      templateSequence: 2,
      consecutiveAiFailureRounds: 0,
    });
    expect(client.classifyReview).toHaveBeenCalledTimes(3);
    expect(client.rewriteTemplate).toHaveBeenCalledOnce();
    expect(pickIndex).toHaveBeenCalledOnce();
    database.close();
  });

  it("resumes a claimed rewrite from its persisted checkpoint after a processor restart", async () => {
    const start = new Date("2026-07-16T07:00:00.000Z");
    const due = new Date("2026-07-16T07:05:00.000Z");
    const firstClient = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(firstClient.rewriteTemplate).mockRejectedValue(new DeepSeekTransientError("service_unavailable", "safe failure"));
    const originalPick = vi.fn(() => 2);
    const base = setup(firstClient, originalPick, false, {
      now: () => start,
      sleep: async () => undefined,
    });
    await base.processor.processSnapshots([snapshot("order-restart-rewrite")]);
    const waiting = base.replies.getBySourceKey("order-restart-rewrite")!;
    expect(waiting).toMatchObject({ state: "retry_wait", failedStage: "rewrite", templateSequence: 3 });

    const secondClient = ai({ library: "bad", category: "通用差评类", confidence: 0.1, reason: "不应调用", needsAttention: true });
    const restartedPick = vi.fn(() => 0);
    const restarted = new DraftProcessor({
      replies: base.replies,
      templates: base.templates,
      ai: secondClient,
      pickIndex: restartedPick,
      now: () => due,
      sleep: async () => undefined,
    });
    const claim = base.replies.claimDueAiRetries({ now: due, leaseMs: 60_000 });

    const result = await restarted.processClaimedRetry(claim.drafts[0]!, claim.claimToken, due);

    expect(result).toMatchObject({ state: "read_only_ready", outcome: "completed" });
    expect(secondClient.classifyReview).not.toHaveBeenCalled();
    expect(restartedPick).not.toHaveBeenCalled();
    expect(secondClient.rewriteTemplate).toHaveBeenCalledOnce();
    expect(secondClient.rewriteTemplate).toHaveBeenCalledWith(expect.objectContaining({
      category: waiting.category,
      template: waiting.originalTemplate,
    }));
    expect(base.replies.get(waiting.id)).toMatchObject({
      templateSequence: waiting.templateSequence,
      originalTemplate: waiting.originalTemplate,
      consecutiveAiFailureRounds: 0,
    });
    base.database.close();
  });

  it("opens the circuit after three actual failed rounds even when error kinds change", async () => {
    const start = new Date("2026-07-16T08:00:00.000Z");
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const failures = [
      new DeepSeekTransientError("network", "round one"),
      new DeepSeekTransientError("network", "round one"),
      new DeepSeekTransientError("rate_limited", "round two"),
      new DeepSeekTransientError("rate_limited", "round two"),
      new DeepSeekModelContractError("round three"),
      new DeepSeekModelContractError("round three"),
    ];
    vi.mocked(client.classifyReview).mockImplementation(async () => { throw failures.shift()!; });
    const sleep = vi.fn(async () => undefined);
    const { database, replies, processor } = setup(client, () => 0, false, { now: () => start, sleep });
    await processor.processSnapshots([snapshot("order-circuit")]);

    const dueRoundTwo = new Date("2026-07-16T08:05:00.000Z");
    const roundTwo = replies.claimDueAiRetries({ now: dueRoundTwo, leaseMs: 60_000 });
    await processor.processClaimedRetry(roundTwo.drafts[0]!, roundTwo.claimToken, dueRoundTwo);
    const dueRoundThree = new Date("2026-07-16T08:10:00.000Z");
    const roundThree = replies.claimDueAiRetries({ now: dueRoundThree, leaseMs: 60_000 });
    const result = await processor.processClaimedRetry(roundThree.drafts[0]!, roundThree.claimToken, dueRoundThree);

    expect(result).toMatchObject({ state: "retry_wait", outcome: "circuit_breaker" });
    expect(replies.get(roundThree.drafts[0]!.id)).toMatchObject({
      consecutiveAiFailureRounds: 3,
      failedStage: "classification",
      aiRetryErrorKind: "model_contract",
    });
    expect(replies.claimDueAiRetries({ now: new Date("2026-07-16T08:15:00.000Z"), leaseMs: 60_000 }).drafts).toEqual([]);
    expect(client.classifyReview).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledTimes(3);
    database.close();
  });

  it("fails configuration errors immediately without retrying or storing the original message", async () => {
    const now = new Date("2026-07-16T09:00:00.000Z");
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.classifyReview).mockRejectedValue(
      new DeepSeekConfigurationError("authentication", "secret upstream authentication body"),
    );
    const sleep = vi.fn(async () => undefined);
    const { database, replies, processor } = setup(client, () => 0, false, { now: () => now, sleep });

    const result = await processor.processSnapshots([snapshot("order-config")]);
    const saved = replies.get(result.items[0]!.id);

    expect(result.items[0]).toMatchObject({ state: "failed", outcome: "manual_action_required" });
    expect(saved).toMatchObject({
      state: "failed",
      errorCode: "DEEPSEEK_AUTHENTICATION_REQUIRED",
      errorMessage: "DeepSeek 连接信息无效，请在系统设置中重新保存并验证",
      consecutiveAiFailureRounds: 0,
    });
    expect(JSON.stringify(saved)).not.toContain("secret upstream authentication body");
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    database.close();
  });

  it("records an unexpected draft failure for the current review without requesting a global pause", async () => {
    const client = ai({
      library: "bad",
      category: "通用差评类",
      confidence: 0.96,
      reason: "",
      needsAttention: false,
    });
    const { database, replies, processor } = setup(client);

    const result = await processor.processSnapshots([
      snapshot("unexpected-draft-failure", "K歌收不进高音，耳返还有延迟，换了几个软件都不行"),
    ]);

    expect(result).toMatchObject({ processed: 1, failed: 1, skipped: 0 });
    expect(result.items[0]).toMatchObject({ state: "failed", outcome: "failed_continue" });
    expect(replies.getBySourceKey("unexpected-draft-failure")).toMatchObject({
      state: "failed",
      errorCode: "DRAFT_PROCESSING_FAILED",
      errorMessage: expect.stringContaining("分类与话术结果"),
    });

    vi.mocked(client.classifyReview).mockResolvedValue({
      library: "bad",
      category: "通用差评类",
      confidence: 0.96,
      reason: "买家明确反馈 K 歌收音和耳返延迟问题",
      needsAttention: false,
    });
    const repeated = await processor.processSnapshots([
      snapshot("unexpected-draft-failure", "K歌收不进高音，耳返还有延迟，换了几个软件都不行"),
    ]);

    expect(repeated.items[0]).toMatchObject({ state: "read_only_ready", outcome: "completed" });
    expect(replies.getBySourceKey("unexpected-draft-failure")).toMatchObject({
      state: "read_only_ready",
      errorCode: null,
      errorMessage: null,
    });
    database.close();
  });

  it("pauses for insufficient DeepSeek balance without retrying", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.classifyReview).mockRejectedValue(
      new DeepSeekConfigurationError("insufficient_balance", "sensitive billing response"),
    );
    const sleep = vi.fn(async () => undefined);
    const { database, replies, processor } = setup(client, () => 0, false, { sleep });

    const result = await processor.processSnapshots([snapshot("order-insufficient-balance")]);

    expect(result.items[0]).toMatchObject({ state: "failed", outcome: "manual_action_required" });
    expect(replies.getBySourceKey("order-insufficient-balance")).toMatchObject({
      errorCode: "DEEPSEEK_BALANCE_REQUIRED",
      errorMessage: "DeepSeek 账户余额不足，请充值后在系统设置中重新验证",
      consecutiveAiFailureRounds: 0,
    });
    expect(JSON.stringify(replies.getBySourceKey("order-insufficient-balance"))).not.toContain("sensitive billing response");
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    database.close();
  });

  it("pauses deterministic DeepSeek request contract errors without retrying", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.classifyReview).mockRejectedValue(
      new DeepSeekConfigurationError("request_contract", "sensitive upstream 413 response"),
    );
    const sleep = vi.fn(async () => undefined);
    const { database, replies, processor } = setup(client, () => 0, false, { sleep });

    const result = await processor.processSnapshots([snapshot("order-request-contract")]);

    expect(result.items[0]).toMatchObject({ state: "failed", outcome: "manual_action_required" });
    expect(replies.getBySourceKey("order-request-contract")).toMatchObject({
      errorCode: "DEEPSEEK_REQUEST_CONFIGURATION_REQUIRED",
      errorMessage: "DeepSeek 请求配置不可用，请在系统设置中重新验证",
      consecutiveAiFailureRounds: 0,
    });
    expect(JSON.stringify(replies.getBySourceKey("order-request-contract"))).not.toContain("sensitive upstream 413 response");
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    database.close();
  });

  it("treats a missing generic category reply as configuration requiring manual action before AI", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const { database, replies, processor } = setup(client);
    database.prepare("DELETE FROM template_replies WHERE text = ?").run("通用好评");

    const result = await processor.processSnapshots([snapshot("order-template-config")]);
    const saved = replies.get(result.items[0]!.id);

    expect(result.items[0]).toMatchObject({ state: "failed", outcome: "manual_action_required" });
    expect(saved).toMatchObject({
      errorCode: "TEMPLATE_LIBRARY_CONFIGURATION_REQUIRED",
      errorMessage: "话术库配置不完整，请检查好评和差评模板后重试",
    });
    expect(client.classifyReview).not.toHaveBeenCalled();
    database.close();
  });

  it("retries model contract failures and maps 429 and 5xx to fixed storage kinds", async () => {
    const modelClient = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(modelClient.classifyReview)
      .mockRejectedValueOnce(new DeepSeekModelContractError("unsafe raw output"));
    const model = setup(modelClient, () => 0, false, { sleep: async () => undefined });
    await model.processor.processSnapshots([snapshot("order-contract-retry")]);
    expect(modelClient.classifyReview).toHaveBeenCalledTimes(2);
    expect(model.replies.getBySourceKey("order-contract-retry")?.state).toBe("read_only_ready");
    model.database.close();

    for (const [sourceKey, failure, expectedKind] of [
      ["order-rate-limit", new DeepSeekTransientError("rate_limited", "raw 429"), "rate_limited"],
      ["order-service", new DeepSeekTransientError("service_unavailable", "raw 503"), "service_unavailable"],
    ] as const) {
      const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
      vi.mocked(client.classifyReview).mockRejectedValue(failure);
      const current = setup(client, () => 0, false, { sleep: async () => undefined });
      await current.processor.processSnapshots([snapshot(sourceKey)]);
      expect(current.replies.getBySourceKey(sourceKey)).toMatchObject({ state: "retry_wait", aiRetryErrorKind: expectedKind });
      current.database.close();
    }
  });

  it("propagates a stale retry claim conflict without overwriting the newer claim state", async () => {
    const start = new Date("2026-07-16T10:00:00.000Z");
    const due = new Date("2026-07-16T10:05:00.000Z");
    const reclaimedAt = new Date("2026-07-16T10:06:01.000Z");
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.classifyReview).mockRejectedValue(new DeepSeekTransientError("network", "safe failure"));
    const { database, replies, processor } = setup(client, () => 0, false, {
      now: () => start,
      sleep: async () => undefined,
    });
    await processor.processSnapshots([snapshot("order-stale-claim")]);
    const stale = replies.claimDueAiRetries({ now: due, leaseMs: 60_000 });
    const newer = replies.claimDueAiRetries({ now: reclaimedAt, leaseMs: 60_000 });
    vi.mocked(client.classifyReview).mockClear();
    vi.mocked(client.rewriteTemplate).mockClear();
    vi.mocked(client.determineSentiment).mockClear();
    vi.mocked(client.classifyReview).mockResolvedValue({
      library: "good", category: "音质音效类", confidence: 0.99, reason: "新领取者才能保存", needsAttention: false,
    });

    await expect(processor.processClaimedRetry(stale.drafts[0]!, stale.claimToken, reclaimedAt))
      .rejects.toBeInstanceOf(ReviewActionConflictError);

    expect(newer.drafts).toHaveLength(1);
    expect(client.classifyReview).not.toHaveBeenCalled();
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    expect(client.determineSentiment).not.toHaveBeenCalled();
    expect(replies.get(stale.drafts[0]!.id)).toMatchObject({
      state: "retry_wait",
      consecutiveAiFailureRounds: 1,
      errorCode: null,
      errorMessage: null,
      aiCheckpointStage: null,
    });
    database.close();
  });

  it("does not call manual-product sentiment AI after a claimed retry lease is taken over", async () => {
    const start = new Date("2026-07-16T10:00:00.000Z");
    const due = new Date("2026-07-16T10:05:00.000Z");
    const reclaimedAt = new Date("2026-07-16T10:05:01.001Z");
    const client = ai({ library: "good", category: "unused", confidence: 0.9, reason: "unused", needsAttention: false });
    vi.mocked(client.determineSentiment).mockRejectedValue(new DeepSeekTransientError("network", "initial sentiment outage"));
    const { database, products, replies, processor } = setup(client, () => 0, true, {
      now: () => start,
      sleep: async () => undefined,
    });
    products.upsert({ itemId: "960227744800", title: "manual-product" }, "manual", products.revision());
    const input = { ...snapshot("order-stale-manual-sentiment", "okay"), sentimentLabel: "unknown" as const };
    await processor.processSnapshots([input]);
    const stale = replies.claimDueAiRetries({ now: due, leaseMs: 1_000 });
    const newer = replies.claimDueAiRetries({ now: reclaimedAt, leaseMs: 60_000 });
    vi.mocked(client.determineSentiment).mockClear();
    vi.mocked(client.determineSentiment).mockResolvedValue({ sentiment: "positive", reason: "positive context", confidence: 0.9 });

    await expect(processor.processClaimedRetry(stale.drafts[0]!, stale.claimToken, reclaimedAt))
      .rejects.toBeInstanceOf(ReviewActionConflictError);

    expect(newer.drafts).toHaveLength(1);
    expect(client.determineSentiment).not.toHaveBeenCalled();
    database.close();
  });

  it("does not persist a stale manual hold after the sentiment call is taken over", async () => {
    const start = new Date("2026-07-16T10:10:00.000Z");
    const due = new Date("2026-07-16T10:15:00.000Z");
    const reclaimedAt = new Date("2026-07-16T10:15:01.001Z");
    let clock = start;
    let releaseSentiment!: (value: { sentiment: "negative"; reason: string; confidence: number }) => void;
    let enteredSentiment!: () => void;
    const sentimentEntered = new Promise<void>((resolve) => { enteredSentiment = resolve; });
    const blockedSentiment = new Promise<{ sentiment: "negative"; reason: string; confidence: number }>((resolve) => {
      releaseSentiment = resolve;
    });
    const client = ai({ library: "good", category: "unused", confidence: 0.9, reason: "unused", needsAttention: false });
    vi.mocked(client.determineSentiment).mockRejectedValue(new DeepSeekTransientError("network", "initial sentiment outage"));
    const { database, products, replies, templates, processor } = setup(client, () => 0, true, {
      now: () => clock,
      sleep: async () => undefined,
    });
    products.upsert({ itemId: "960227744800", title: "manual-product" }, "manual", products.revision());
    const input = { ...snapshot("order-stale-manual-decision", "okay"), sentimentLabel: "unknown" as const };
    await processor.processSnapshots([input]);
    clock = due;
    const stale = replies.claimDueAiRetries({ now: due, leaseMs: 1_000 });
    vi.mocked(client.determineSentiment).mockImplementationOnce(async () => {
      enteredSentiment();
      return blockedSentiment;
    });

    const staleRun = processor.processClaimedRetry(stale.drafts[0]!, stale.claimToken, due);
    await sentimentEntered;
    clock = reclaimedAt;
    database.prepare(`
      UPDATE reply_drafts
      SET ai_retry_claim_token = 'taken-over-token', ai_retry_claim_expires_at = ?
      WHERE id = ?
    `).run(new Date(reclaimedAt.getTime() + 60_000).toISOString(), stale.drafts[0]!.id);
    releaseSentiment({ sentiment: "negative", reason: "current issue", confidence: 0.9 });

    await expect(staleRun).rejects.toBeInstanceOf(ReviewActionConflictError);
    expect(replies.get(stale.drafts[0]!.id)).toMatchObject({
      state: "retry_wait",
      manualProductId: null,
      manualHoldReason: null,
    });
    expect(new ReviewActionGate(database).getLock("primary", input.sourceKey)).toBeNull();

    database.close();
  });

  it("honors pause after the first failed AI call without sleeping or counting a failed round", async () => {
    let continueRunning = true;
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.classifyReview).mockImplementation(async () => {
      continueRunning = false;
      throw new DeepSeekTransientError("network", "safe failure");
    });
    const sleep = vi.fn(async () => undefined);
    const { database, replies, processor } = setup(client, () => 0, false, { sleep });

    const result = await processor.processSnapshots([snapshot("order-paused-between")], {
      shouldContinue: () => continueRunning,
    });

    expect(result.items[0]).toMatchObject({ state: "discovered", outcome: "paused" });
    expect(replies.get(result.items[0]!.id)).toMatchObject({
      state: "discovered",
      consecutiveAiFailureRounds: 0,
      nextRetryAt: null,
    });
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    database.close();
  });

  it("renews a claimed classification lease across a normal slow failed model call", async () => {
    const start = new Date("2026-07-16T11:00:00.000Z");
    const due = new Date("2026-07-16T11:05:00.000Z");
    const expired = new Date("2026-07-16T11:05:02.000Z");
    let clock = start;
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.classifyReview).mockRejectedValue(new DeepSeekTransientError("network", "initial round"));
    const { database, replies, processor } = setup(client, () => 0, false, {
      now: () => clock,
      sleep: async () => undefined,
    });
    await processor.processSnapshots([snapshot("order-expired-failure-claim")]);
    clock = due;
    const claim = replies.claimDueAiRetries({ now: due, leaseMs: 1_000 });
    vi.mocked(client.classifyReview).mockClear();
    vi.mocked(client.classifyReview).mockImplementation(async () => {
      clock = expired;
      throw new DeepSeekTransientError("service_unavailable", "expired round");
    });

    await expect(processor.processClaimedRetry(claim.drafts[0]!, claim.claimToken, due))
      .resolves.toMatchObject({ state: "retry_wait", outcome: "retry_wait" });

    expect(replies.get(claim.drafts[0]!.id)).toMatchObject({
      state: "retry_wait",
      consecutiveAiFailureRounds: 2,
      aiRetryErrorKind: "service_unavailable",
      aiCheckpointStage: null,
    });
    expect(client.classifyReview).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("renews a claimed lease before the bounded second attempt after a slow retry sleep", async () => {
    const start = new Date("2026-07-16T11:30:00.000Z");
    const due = new Date("2026-07-16T11:35:00.000Z");
    const expired = new Date("2026-07-16T11:35:01.001Z");
    let clock = start;
    let expireDuringClaimedRetry = false;
    const client = ai({ library: "good", category: "unused", confidence: 0.9, reason: "unused", needsAttention: false });
    vi.mocked(client.classifyReview).mockRejectedValue(new DeepSeekTransientError("network", "initial outage"));
    const { database, replies, processor } = setup(client, () => 0, false, {
      now: () => clock,
      sleep: async () => { if (expireDuringClaimedRetry) clock = expired; },
    });
    await processor.processSnapshots([snapshot("order-expired-during-sleep")]);
    clock = due;
    const claim = replies.claimDueAiRetries({ now: due, leaseMs: 1_000 });
    expireDuringClaimedRetry = true;
    vi.mocked(client.classifyReview).mockClear();
    vi.mocked(client.classifyReview).mockRejectedValue(new DeepSeekTransientError("timeout", "claimed outage"));

    await expect(processor.processClaimedRetry(claim.drafts[0]!, claim.claimToken, due))
      .resolves.toMatchObject({ state: "retry_wait", outcome: "retry_wait" });

    expect(client.classifyReview).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("renews a claimed rewrite lease across a normal slow successful model call", async () => {
    const start = new Date("2026-07-16T12:00:00.000Z");
    const due = new Date("2026-07-16T12:05:00.000Z");
    const expired = new Date("2026-07-16T12:05:02.000Z");
    let clock = start;
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.rewriteTemplate).mockRejectedValue(new DeepSeekTransientError("timeout", "initial round"));
    const { database, replies, processor } = setup(client, () => 0, false, {
      now: () => clock,
      sleep: async () => undefined,
    });
    await processor.processSnapshots([snapshot("order-expired-complete-claim")]);
    const before = replies.getBySourceKey("order-expired-complete-claim")!;
    clock = due;
    const claim = replies.claimDueAiRetries({ now: due, leaseMs: 1_000 });
    vi.mocked(client.rewriteTemplate).mockImplementation(async () => {
      clock = expired;
      return {
        finalReply: before.originalTemplate,
        productAdjusted: false,
        needsAttention: false,
        notes: "已适配当前商品",
        detectedTemplateProducts: [],
        unsupportedClaims: [],
      };
    });

    await expect(processor.processClaimedRetry(claim.drafts[0]!, claim.claimToken, due))
      .resolves.toMatchObject({ state: "read_only_ready", outcome: "completed" });

    expect(replies.get(before.id)).toMatchObject({
      state: "read_only_ready",
      finalReply: before.originalTemplate,
      consecutiveAiFailureRounds: 0,
      templateSequence: before.templateSequence,
      originalTemplate: before.originalTemplate,
    });
    database.close();
  });

  it("resumes a frozen rewrite checkpoint even when no template version is currently active", async () => {
    const start = new Date("2026-07-16T13:00:00.000Z");
    const due = new Date("2026-07-16T13:05:00.000Z");
    const firstClient = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(firstClient.rewriteTemplate).mockRejectedValue(new DeepSeekTransientError("network", "initial round"));
    const base = setup(firstClient, () => 2, false, {
      now: () => start,
      sleep: async () => undefined,
    });
    await base.processor.processSnapshots([snapshot("order-frozen-checkpoint")]);
    const frozen = base.replies.getBySourceKey("order-frozen-checkpoint")!;
    base.database.prepare("UPDATE template_sources SET active_version_id = NULL").run();

    const secondClient = ai({ library: "bad", category: "通用差评类", confidence: 0.1, reason: "不应重新分类", needsAttention: true });
    const pickIndex = vi.fn(() => 0);
    const restarted = new DraftProcessor({
      replies: base.replies,
      templates: base.templates,
      ai: secondClient,
      pickIndex,
      now: () => due,
      sleep: async () => undefined,
    });
    const claim = base.replies.claimDueAiRetries({ now: due, leaseMs: 60_000 });

    const result = await restarted.processClaimedRetry(claim.drafts[0]!, claim.claimToken, due);

    expect(result).toMatchObject({ state: "read_only_ready", outcome: "completed" });
    expect(secondClient.classifyReview).not.toHaveBeenCalled();
    expect(pickIndex).not.toHaveBeenCalled();
    expect(secondClient.rewriteTemplate).toHaveBeenCalledWith(expect.objectContaining({
      category: frozen.category,
      template: frozen.originalTemplate,
    }));
    expect(base.replies.get(frozen.id)).toMatchObject({
      templateVersionId: frozen.templateVersionId,
      templateSequence: frozen.templateSequence,
      originalTemplate: frozen.originalTemplate,
      state: "read_only_ready",
    });
    base.database.close();
  });

  it("freezes the active template version together with categories before awaiting classification", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const base = setup(client, () => 0, false, { sleep: async () => undefined });
    const frozenVersionId = base.templates.getActiveVersionId("good");
    vi.mocked(client.classifyReview).mockImplementation(async () => {
      base.templates.activateVersion({
        library: "good",
        contentHash: "good-v2-switched-during-ai",
        sourceRecordCount: 2,
        templates: [
          {
            primaryCategory: "",
            category: "音质音效类",
            keywords: ["音质"],
            replies: [{ sequence: 1, text: "新版本音质话术" }],
          },
          {
            primaryCategory: "",
            category: "通用整体好评类",
            keywords: [],
            replies: [{ sequence: 1, text: "新版本通用好评" }],
          },
        ],
        warnings: [],
      });
      return {
        library: "good",
        category: "音质音效类",
        confidence: 0.98,
        reason: "使用分类请求时的快照",
        needsAttention: false,
      };
    });

    const result = await base.processor.processSnapshots([snapshot("order-version-switch")]);
    const saved = base.replies.get(result.items[0]!.id);

    expect(saved).toMatchObject({
      state: "read_only_ready",
      templateVersionId: frozenVersionId,
      templateSequence: 1,
      originalTemplate: "音质话术一",
    });
    expect(base.templates.getActiveVersionId("good")).not.toBe(frozenVersionId);
    expect(client.rewriteTemplate).toHaveBeenCalledWith(expect.objectContaining({ template: "音质话术一" }));
    base.database.close();
  });

  it("records rewrite model contract exhaustion as model_contract without losing the checkpoint", async () => {
    const now = new Date("2026-07-16T14:00:00.000Z");
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.rewriteTemplate).mockRejectedValue(new DeepSeekModelContractError("invalid rewrite JSON"));
    const { database, replies, processor } = setup(client, () => 1, false, {
      now: () => now,
      sleep: async () => undefined,
    });

    await processor.processSnapshots([snapshot("order-rewrite-contract")]);

    expect(replies.getBySourceKey("order-rewrite-contract")).toMatchObject({
      state: "retry_wait",
      failedStage: "rewrite",
      aiRetryErrorKind: "model_contract",
      aiCheckpointStage: "template_selected",
      templateSequence: 2,
      consecutiveAiFailureRounds: 1,
    });
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(client.rewriteTemplate).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("persists two null DeepSeek envelopes as a classification model_contract retry round", async () => {
    const fetchImpl = vi.fn(async () => new Response("null", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const client = new DeepSeekClient({ apiKey: "test-secret", fetchImpl });
    const { database, replies, processor } = setup(client, () => 0, false, { sleep: async () => undefined });

    await processor.processSnapshots([snapshot("order-null-envelope")]);

    expect(replies.getBySourceKey("order-null-envelope")).toMatchObject({
      state: "retry_wait",
      failedStage: "classification",
      aiRetryErrorKind: "model_contract",
      consecutiveAiFailureRounds: 1,
      errorCode: null,
      errorMessage: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("diverts a matched neutral review before classification, template selection or rewriting", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.determineSentiment!).mockResolvedValue({
      sentiment: "neutral",
      reason: "正文态度中性",
      confidence: 0.94,
    });
    const pickIndex = vi.fn(() => 0);
    const { database, replies, products, processor } = setup(client, pickIndex, true);
    products.upsert({ itemId: "960227744800", title: "旧标题" }, "manual", products.revision());
    const input = snapshot("order-manual-neutral", "音质一般");
    input.itemId = "960227744800";
    input.product = "已经改名的新标题";
    input.sentimentLabel = "neutral";

    const result = await processor.processSnapshots([input]);

    expect(result).toMatchObject({ processed: 1, failed: 0, skipped: 0 });
    expect(replies.get(result.items[0]!.id)).toMatchObject({ state: "manual_product_hold", finalReply: "", library: null });
    expect(client.classifyReview).not.toHaveBeenCalled();
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    expect(pickIndex).not.toHaveBeenCalled();
    database.close();
  });

  it("rechecks an existing unsubmitted draft and clears it when a new manual rule now applies", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const base = setup(client);
    const input = snapshot("order-existing-manual", "音质一般");
    input.itemId = "960227744800";
    input.sentimentLabel = "neutral";
    const first = await base.processor.processSnapshots([input]);
    expect(base.replies.get(first.items[0]!.id)?.state).toBe("read_only_ready");
    base.products.upsert({ itemId: "960227744800", title: input.product }, "manual", base.products.revision());
    vi.mocked(client.determineSentiment!).mockResolvedValue({
      sentiment: "neutral",
      reason: "正文态度中性",
      confidence: 0.94,
    });
    const policy = new ManualProductPolicyService({ products: base.products, replies: base.replies, ai: client });
    const guarded = new DraftProcessor({ replies: base.replies, templates: base.templates, ai: client, manualProductPolicy: policy });

    const second = await guarded.processSnapshots([input]);

    expect(second).toMatchObject({ processed: 1, failed: 0 });
    expect(base.replies.get(first.items[0]!.id)).toMatchObject({ state: "manual_product_hold", finalReply: "", library: null });
    expect(client.classifyReview).toHaveBeenCalledTimes(1);
    expect(client.rewriteTemplate).toHaveBeenCalledTimes(1);
    base.database.close();
  });

  it("uses the bounded classification retry when a new list rule needs sentiment for an existing draft", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const sleep = vi.fn(async () => undefined);
    const base = setup(client, () => 0, true, { sleep });
    const input = snapshot("existing-unknown-list-retry", "暂时说不清楚");
    input.sentimentLabel = "unknown";
    await base.processor.processSnapshots([input]);
    base.products.upsert({ itemId: input.itemId, title: input.product }, "manual", base.products.revision());
    vi.mocked(client.determineSentiment!).mockRejectedValue(new DeepSeekTransientError("network", "temporary network failure"));

    const result = await base.processor.processSnapshots([input]);

    expect(result.items[0]).toMatchObject({ outcome: "retry_wait", state: "retry_wait" });
    expect(client.determineSentiment).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(base.replies.getBySourceKey(input.sourceKey)).toMatchObject({
      failedStage: "classification",
      aiRetryErrorKind: "network",
    });
    base.database.close();
  });

  it("updates the frozen catalog decision for an existing completed draft without rerolling its reply", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const pickIndex = vi.fn(() => 1);
    const base = setup(client, pickIndex, true);
    const input = snapshot("order-existing-continue");
    const first = await base.processor.processSnapshots([input]);
    const original = base.replies.get(first.items[0]!.id)!;
    expect(original).toMatchObject({ state: "read_only_ready", manualCatalogRevision: 1, manualMatchKind: "not_matched" });
    base.products.upsert({ itemId: "980913413146", title: "其他商品" }, "manual", base.products.revision());
    const currentRevision = base.products.revision();

    const second = await base.processor.processSnapshots([input]);
    const unchanged = base.replies.get(first.items[0]!.id)!;

    expect(second).toMatchObject({ processed: 0, failed: 0, skipped: 1 });
    expect(unchanged).toMatchObject({
      state: "read_only_ready",
      manualCatalogRevision: currentRevision,
      manualMatchKind: "not_matched",
      templateSequence: original.templateSequence,
      finalReply: original.finalReply,
    });
    expect(pickIndex).toHaveBeenCalledTimes(1);
    expect(client.classifyReview).toHaveBeenCalledTimes(1);
    expect(client.rewriteTemplate).toHaveBeenCalledTimes(1);
    base.database.close();
  });

  it("treats an existing manual hold as processed and never resets or calls AI", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    vi.mocked(client.determineSentiment!).mockResolvedValue({
      sentiment: "negative",
      reason: "正文明确负面",
      confidence: 0.98,
    });
    const { database, replies, products, processor } = setup(client, () => 0, true);
    products.upsert({ itemId: "960227744800", title: "商品" }, "manual", products.revision());
    const input = snapshot("order-held", "不好");
    input.itemId = "960227744800";
    input.sentimentLabel = "negative";
    await processor.processSnapshots([input]);
    vi.mocked(client.classifyReview).mockClear();
    vi.mocked(client.rewriteTemplate).mockClear();
    vi.mocked(client.determineSentiment!).mockClear();

    const repeated = await processor.processSnapshots([input]);
    const reprocessed = await processor.reprocess(replies.getBySourceKey(input.sourceKey)!.id);

    expect(repeated).toMatchObject({ processed: 0, skipped: 1 });
    expect(reprocessed.state).toBe("manual_product_hold");
    expect(replies.getBySourceKey(input.sourceKey)?.state).toBe("manual_product_hold");
    expect(client.determineSentiment).not.toHaveBeenCalled();
    expect(client.classifyReview).not.toHaveBeenCalled();
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    database.close();
  });

  it("does not reset or call AI when a complaint lock or terminal action protects the review", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const { database, replies, processor } = setup(client);
    const gate = new ReviewActionGate(database);
    const locked = snapshot("order-complaint-locked");
    const terminal = snapshot("order-complaint-terminal");
    const lockedDraft = replies.discover(locked);
    const terminalDraft = replies.discover(terminal);
    gate.acquire("primary", locked.sourceKey, "complaint");
    const terminalLock = gate.acquire("primary", terminal.sourceKey, "complaint");
    gate.complete("primary", terminal.sourceKey, "complaint", terminalLock.lockVersion, "complaint_upheld");

    const result = await processor.processSnapshots([locked, terminal]);

    expect(result).toMatchObject({ processed: 0, failed: 0, skipped: 2 });
    expect(replies.get(lockedDraft.id)?.state).toBe("discovered");
    expect(replies.get(terminalDraft.id)?.state).toBe("discovered");
    await expect(processor.reprocess(lockedDraft.id)).rejects.toThrow("不能重新生成草稿");
    await expect(processor.reprocess(terminalDraft.id)).rejects.toThrow("不能重新生成草稿");
    expect(client.determineSentiment).not.toHaveBeenCalled();
    expect(client.classifyReview).not.toHaveBeenCalled();
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    database.close();
  });

  it("reconciles a platform complaint outcome before AI and records the local draft as non-actionable", async () => {
    const client = ai({ library: "bad", category: "通用差评类", confidence: 0.99, reason: "unused", needsAttention: false });
    const { database, replies, templates } = setup(client);
    const reconcilePlatformState = vi.fn<NonNullable<ComplaintReviewPolicy["reconcilePlatformState"]>>(async () => ({
      action: "skip",
      caseId: "platform-case",
      caseState: "upheld",
    }));
    const evaluate = vi.fn<ComplaintReviewPolicy["evaluate"]>();
    const processor = new DraftProcessor({
      replies,
      templates,
      ai: client,
      complaintPolicy: { evaluate, reconcilePlatformState },
    });
    const input = { ...snapshot("order-platform-upheld"), platformActionState: "complaint_upheld" as const };

    const result = await processor.processSnapshots([input]);

    expect(result).toMatchObject({ processed: 0, failed: 0, skipped: 1 });
    expect(result.items[0]).toMatchObject({ outcome: "skipped", state: "not_actionable" });
    expect(reconcilePlatformState).toHaveBeenCalledOnce();
    expect(evaluate).not.toHaveBeenCalled();
    expect(client.determineSentiment).not.toHaveBeenCalled();
    expect(client.classifyReview).not.toHaveBeenCalled();
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    expect(replies.getBySourceKey(input.sourceKey)).toMatchObject({
      state: "not_actionable",
      errorCode: "TMALL_PLATFORM_COMPLAINT_HANDLED",
    });
    database.close();
  });

  it("reopens a prior platform-marker skip when the live row is actionable again", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const { database, replies, processor } = setup(client);
    const input = snapshot("platform-marker-was-stale", "音质很好");

    await processor.processSnapshots([{
      ...input,
      platformActionState: "complaint_record",
      platformComplaintEntryState: "unavailable",
    }]);
    expect(replies.getBySourceKey(input.sourceKey)).toMatchObject({
      state: "not_actionable",
      errorCode: "TMALL_PLATFORM_COMPLAINT_HANDLED",
    });

    const second = await processor.processSnapshots([{
      ...input,
      platformActionState: "none",
      platformComplaintEntryState: "available",
    }]);

    expect(second.items[0]).toMatchObject({ outcome: "completed", state: "read_only_ready" });
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(client.rewriteTemplate).toHaveBeenCalledOnce();
    database.close();
  });

  it("processes a live actionable row even when its sent row is display-only imported history", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const { database, replies, processor } = setup(client);
    const input = snapshot("imported-display-only-sent", "音质很好");
    const imported = replies.discover(input);
    database.prepare(`
      UPDATE reply_drafts
      SET state = 'sent', processed_at = updated_at
      WHERE id = ?
    `).run(imported.id);

    const result = await processor.processSnapshots([{
      ...input,
      platformActionState: "none",
      platformComplaintEntryState: "available",
    }]);

    expect(result.items[0]).toMatchObject({ outcome: "completed", state: "read_only_ready" });
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(client.rewriteTemplate).toHaveBeenCalledOnce();
    database.close();
  });

  it("reprocesses a live actionable row after a pre-submit browser failure", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const { database, replies, processor } = setup(client);
    const attempts = new ReplyAttemptRepository(database);
    const input = snapshot("live-actionable-pre-submit-failed", "音质很好");
    const first = await processor.processSnapshots([input]);
    const draftId = first.items[0]!.id;
    const failedAttempt = attempts.prepareWithReplyLock(draftId, input.sourceKey).attempt;
    attempts.markSkipped(
      failedAttempt.id,
      "TMALL_BROWSER_OPERATION_ABORTED",
      "网络中断，提交按钮尚未点击",
    );
    expect(replies.get(draftId)).toMatchObject({ state: "failed" });
    expect(attempts.get(failedAttempt.id)).toMatchObject({
      state: "failed",
      submittedAt: null,
      verifiedAt: null,
    });
    vi.mocked(client.classifyReview).mockClear();
    vi.mocked(client.rewriteTemplate).mockClear();

    const repeated = await processor.processSnapshots([{
      ...input,
      platformActionState: "none",
      platformComplaintEntryState: "available",
    }]);

    expect(repeated).toMatchObject({ processed: 1, skipped: 0, failed: 0 });
    expect(repeated.items[0]).toMatchObject({ outcome: "completed", state: "read_only_ready" });
    expect(replies.get(draftId)).toMatchObject({
      state: "read_only_ready",
      errorCode: null,
      errorMessage: null,
    });
    expect(attempts.getBySourceKey(input.sourceKey)).toBeNull();
    expect(client.classifyReview).toHaveBeenCalledOnce();
    expect(client.rewriteTemplate).toHaveBeenCalledOnce();
    database.close();
  });

  it("returns an existing ready draft for submission when its validation failed before any browser click and the live row is still actionable", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const { database, replies, processor } = setup(client);
    const attempts = new ReplyAttemptRepository(database);
    const input = snapshot("live-actionable-validation-failed", "音质很好");
    const first = await processor.processSnapshots([input]);
    const draftId = first.items[0]!.id;
    const failedAttempt = attempts.prepareWithReplyLock(draftId, input.sourceKey).attempt;
    attempts.markFailed(failedAttempt.id, "REPLY_VALIDATION_FAILED", "旧版误拦模板中的退款退货话术");
    expect(replies.get(draftId)).toMatchObject({ state: "read_only_ready" });
    expect(attempts.get(failedAttempt.id)).toMatchObject({
      state: "failed",
      submittedAt: null,
      verifiedAt: null,
    });
    vi.mocked(client.classifyReview).mockClear();
    vi.mocked(client.rewriteTemplate).mockClear();

    const repeated = await processor.processSnapshots([{
      ...input,
      platformActionState: "none",
      platformComplaintEntryState: "available",
    }]);

    expect(repeated).toMatchObject({ processed: 1, skipped: 0, failed: 0 });
    expect(repeated.items[0]).toMatchObject({ outcome: "completed", state: "read_only_ready" });
    expect(client.classifyReview).not.toHaveBeenCalled();
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    database.close();
  });

  it("does not return an existing ready draft for submission when an old failure crossed the browser click boundary", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const { database, replies, processor } = setup(client);
    const attempts = new ReplyAttemptRepository(database);
    const input = snapshot("live-ready-post-click-protected", "音质很好");
    const first = await processor.processSnapshots([input]);
    const draftId = first.items[0]!.id;
    const failedAttempt = attempts.prepareWithReplyLock(draftId, input.sourceKey).attempt;
    attempts.markSubmitting(failedAttempt.id);
    attempts.markPreSubmitFailed(failedAttempt.id, "LEGACY_POST_SUBMIT_FAILURE", "旧版本点击提交后的结果未知");
    expect(replies.get(draftId)).toMatchObject({ state: "read_only_ready" });
    expect(attempts.get(failedAttempt.id)?.submittedAt).not.toBeNull();

    const repeated = await processor.processSnapshots([{
      ...input,
      platformActionState: "none",
      platformComplaintEntryState: "available",
    }]);

    expect(repeated).toMatchObject({ processed: 0, skipped: 1, failed: 0 });
    expect(repeated.items[0]).toMatchObject({ outcome: "skipped", state: "read_only_ready" });
    database.close();
  });

  it("does not reprocess a live actionable row when the prior failed attempt crossed the submit boundary", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const { database, replies, processor } = setup(client);
    const attempts = new ReplyAttemptRepository(database);
    const input = snapshot("live-actionable-post-submit-failed", "音质很好");
    const first = await processor.processSnapshots([input]);
    const draftId = first.items[0]!.id;
    const failedAttempt = attempts.prepareWithReplyLock(draftId, input.sourceKey).attempt;
    attempts.markSubmitting(failedAttempt.id);
    attempts.markPreSubmitFailed(failedAttempt.id, "LEGACY_POST_SUBMIT_FAILURE", "旧版本提交边界后的失败");
    database.prepare(`
      UPDATE reply_drafts
      SET state = 'failed', error_code = 'LEGACY_POST_SUBMIT_FAILURE',
          error_message = '旧版本提交边界后的失败'
      WHERE id = ?
    `).run(draftId);
    expect(attempts.get(failedAttempt.id)?.submittedAt).not.toBeNull();
    vi.mocked(client.classifyReview).mockClear();
    vi.mocked(client.rewriteTemplate).mockClear();

    const repeated = await processor.processSnapshots([{
      ...input,
      platformActionState: "none",
      platformComplaintEntryState: "available",
    }]);

    expect(repeated).toMatchObject({ processed: 0, skipped: 1, failed: 0 });
    expect(repeated.items[0]).toMatchObject({ outcome: "skipped", state: "failed" });
    expect(client.classifyReview).not.toHaveBeenCalled();
    expect(client.rewriteTemplate).not.toHaveBeenCalled();
    database.close();
  });

  it.each(["complaint", "reply", "terminal"] as const)(
    "safely skips a new draft when %s ownership wins during sentiment AI and continues the batch",
    async (owner) => {
      let releaseSentiment!: () => void;
      let signalStarted!: () => void;
      const started = new Promise<void>((resolve) => { signalStarted = resolve; });
      const blocked = new Promise<void>((resolve) => { releaseSentiment = resolve; });
      const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
      let sentimentCalls = 0;
      vi.mocked(client.determineSentiment!).mockImplementation(async () => {
        sentimentCalls += 1;
        if (sentimentCalls === 1) {
          signalStarted();
          await blocked;
          return owner === "reply"
            ? { sentiment: "positive", reason: "整体偏正面", confidence: 0.9 }
            : { sentiment: "negative", reason: "存在当前问题", confidence: 0.9 };
        }
        return { sentiment: "positive", reason: "后续评价整体偏正面", confidence: 0.9 };
      });
      const { database, replies, products, processor } = setup(client, () => 0, true);
      products.upsert({ itemId: "960227744800", title: "名单商品" }, "manual", products.revision());
      const first = snapshot(`order-race-${owner}`, "还行");
      first.itemId = "960227744800";
      first.sentimentLabel = "unknown";
      const second = snapshot(`order-after-${owner}`, "音质很好");

      const running = processor.processSnapshots([first, second]);
      await started;
      const gate = new ReviewActionGate(database);
      if (owner === "terminal") {
        const lock = gate.acquire("primary", first.sourceKey, "complaint");
        gate.complete("primary", first.sourceKey, "complaint", lock.lockVersion, "complaint_upheld");
      } else {
        gate.acquire("primary", first.sourceKey, owner);
      }
      releaseSentiment();
      const result = await running;

      expect(result).toMatchObject({ processed: 1, failed: 0, skipped: 1 });
      expect(replies.getBySourceKey(first.sourceKey)).toMatchObject({ state: "discovered", errorCode: null });
      expect(replies.getBySourceKey(second.sourceKey)?.state).toBe("read_only_ready");
      if (owner === "terminal") {
        expect(gate.getTombstone("primary", first.sourceKey)).toMatchObject({ terminalAction: "complaint_upheld" });
      } else {
        expect(gate.getLock("primary", first.sourceKey)).toMatchObject({ actionKind: owner });
      }
      database.close();
    },
  );

  it("safely skips an existing ready draft when an action lock blocks policy refresh", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const { database, replies, processor } = setup(client, () => 0, true);
    const input = snapshot("order-ready-policy-conflict");
    await processor.processSnapshots([input]);
    const before = replies.getBySourceKey(input.sourceKey)!;
    new ReviewActionGate(database).acquire("primary", input.sourceKey, "complaint");

    const result = await processor.processSnapshots([input]);

    expect(result).toMatchObject({ processed: 0, failed: 0, skipped: 1 });
    expect(replies.get(before.id)).toMatchObject({ state: before.state, finalReply: before.finalReply, errorCode: null });
    expect(client.classifyReview).toHaveBeenCalledTimes(1);
    expect(client.rewriteTemplate).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("runs sentiment-only first for a matched unknown review and classifies only after a positive result", async () => {
    const client = ai({ library: "good", category: "音质音效类", confidence: 0.96, reason: "称赞音质", needsAttention: false });
    const { database, replies, products, processor } = setup(client, () => 0, true);
    products.upsert({ itemId: "960227744800", title: "商品" }, "manual", products.revision());
    const input = snapshot("order-unknown-positive", "还行");
    input.itemId = "960227744800";
    input.sentimentLabel = "unknown";

    const result = await processor.processSnapshots([input]);

    expect(client.determineSentiment).toHaveBeenCalledTimes(1);
    expect(client.classifyReview).toHaveBeenCalledTimes(1);
    expect(client.rewriteTemplate).toHaveBeenCalledTimes(1);
    expect(replies.get(result.items[0]!.id)?.state).toBe("read_only_ready");
    database.close();
  });

  it("does not treat a missing product ID as a manual-list match", async () => {
    const client = ai({ library: "good", category: "通用整体好评类", confidence: 0.7, reason: "兜底", needsAttention: false });
    const { database, replies, processor } = setup(client, () => 0, true);
    const input = snapshot("order-identity-unsafe");
    input.product = "商品名称未识别";
    input.itemId = null;

    const result = await processor.processSnapshots([input]);

    expect(replies.get(result.items[0]!.id)?.state).toBe("needs_attention");
    expect(client.determineSentiment).not.toHaveBeenCalled();
    expect(client.classifyReview).toHaveBeenCalledOnce();
    database.close();
  });
});
