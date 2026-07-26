import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import type { ResolvedReviewScope } from "@tmall/domain";
import { DEFAULT_TMALL_BROWSER_OPERATION_DEADLINE_MS, buildApp } from "./app";
import { InMemorySecretStore } from "./security/credential-store";
import { openDatabase, runMigrations } from "./storage/database";
import { AutomationRepository, LocatorRepository, ReplyAttemptRepository, ReplyRepository, SettingsRepository, TemplateRepository } from "./storage/repositories";
import { ManualProductRepository } from "./storage/manual-product-repository";
import { ComplaintRepository } from "./storage/complaint-repository";
import { parseManualProductWorkbook, type ParsedManualProductWorkbook } from "./manual-products/xlsx-parser";
import { ReviewActionGate } from "./submission/review-action-gate";
import { TmallReviewPageStateError, type TmallReviewSnapshot } from "./tmall/review-reader";
import { TmallDriverOperationError } from "./tmall/auth-driver";
import { TmallBrowserLaunchError } from "./tmall/browser-runtime";
import { DeepSeekTransientError, type DeepSeekClientApi, type DeepSeekConnectionResult } from "./deepseek/client";
import { UiSessionManager } from "./ui-session-manager";
import type { ComplaintReviewDecision, ComplaintReviewPolicy } from "./complaints/complaint-review-service";

const host = "127.0.0.1:4300";
const origin = `http://${host}`;
const sessionToken = "test-session-token";
const csrfToken = "test-csrf-token";

it("allows enough time for a verified popup recovery to recreate the browser page", () => {
  expect(DEFAULT_TMALL_BROWSER_OPERATION_DEADLINE_MS).toBe(180_000);
});

function buildMultipart(
  boundary: string,
  files: Array<{ name: string; filename: string; mimetype: string; body: Buffer }>,
  fields: Record<string, string> = {},
): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.mimetype}\r\n\r\n`));
    chunks.push(file.body, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function expectPublicAutomationStatus(value: unknown): void {
  expect(value).toBeTypeOf("object");
  const forbiddenKeys = /^(?:runId|sourceKey|lockVersion|scopeRevision|catalogRevision|manualCatalogRevision|manualMatchKind|actionLockVersion)$/iu;
  const visit = (node: unknown, path: string[] = []): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      const childPath = [...path, key];
      expect(key, `internal automation field leaked at ${childPath.join(".")}`).not.toMatch(forbiddenKeys);
      if (/revision$/iu.test(key)) {
        expect(childPath.join("."), `internal revision leaked at ${childPath.join(".")}`).toBe("plan.revision");
      }
      visit(child, childPath);
    }
  };
  visit(value);
}

function snapshotManualCatalogMutationTables(database: ReturnType<typeof openDatabase>) {
  const tables = [
    "manual_product_catalog_state",
    "manual_products",
    "manual_product_memberships",
    "reply_drafts",
    "review_action_locks",
  ];
  return Object.fromEntries(tables.map((table) => [
    table,
    database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

describe("formal automation API", () => {
  let app: FastifyInstance;
  let cookie: string;
  let tmallOpenCount: number;
  let tmallContinueCount: number;
  let tmallContinueCredentials: { account: string; password: string } | null | undefined;
  let tmallOpenGate: ReturnType<typeof deferred<void>> | null;
  let tmallCriticalVerificationGate: ReturnType<typeof deferred<void>> | null;
  let tmallCurrentOperationKey: string | null;
  let tmallCloseCount: number;
  let tmallAuthFailure: string | null;
  let tmallOpenError: Error | null;
  let tmallSubmitCount: number;
  let tmallStoreName: string | null;
  let tmallSubmitState: "sent" | "failed" | "uncertain";
  let tmallSubmitFailureOperationKey: string | null;
  let tmallSessionExpiresOnFirstSubmit: boolean;
  let tmallSubmitDelayMs: number;
  let tmallSubmitGate: ReturnType<typeof deferred<void>> | null;
  let tmallSubmitPageStateError: boolean;
  let tmallMissingElements: string[];
  let tmallMissingElementSequence: string[][] | null;
  let tmallQueueEmpty: boolean;
  let tmallSnapshots: TmallReviewSnapshot[] | null;
  let tmallSnapshotReads: TmallReviewSnapshot[][] | null;
  let tmallReadScopes: ResolvedReviewScope[];
  let tmallVerifiedScopes: ResolvedReviewScope[];
  let tmallVerifyReplyControls: boolean[];
  let tmallReadFailures: Array<Error | null>;
  let tmallVerificationFailures: Array<Error | null>;
  let runtimeReadinessError: Error | null;
  let runtimeReadinessCheckCount: number;
  let runtimeReadinessGate: ReturnType<typeof deferred<void>> | null;
  let runtimeReadinessGateCall: number | null;
  let deepseekClassificationFailures: number;
  let deepseekClassificationCalls: number;
  let deepseekSentimentAlwaysFails: boolean;
  let deepseekSentimentCalls: number;
  let deepseekSentimentResolver: NonNullable<DeepSeekClientApi["determineSentiment"]>;
  let deepseekRewriteCalls: number;
  let deepseekRewriteGate: ReturnType<typeof deferred<void>> | null;
  let deepseekConnectionResult: DeepSeekConnectionResult;
  let locatorRepository: LocatorRepository;
  let localPickerPick: () => Promise<{ cancelled: true } | { cancelled: false; path: string }>;
  let localPickerCancelCount: number;
  let localPickerCloseCount: number;
  let localPickerCancel: () => Promise<void>;
  let localPickerClose: () => Promise<void>;
  let manualProductParser: (buffer: Buffer, filename: string) => Promise<ParsedManualProductWorkbook>;
  let now: Date;
  let database: ReturnType<typeof openDatabase>;
  let secretStore: InMemorySecretStore;
  let uiSessionManager: UiSessionManager;
  let complaintAutoSubmitFactoryValues: boolean[];
  let complaintDecisionResolver: (
    draft: Parameters<ComplaintReviewPolicy["evaluate"]>[0],
  ) => Promise<ComplaintReviewDecision>;

  beforeEach(async () => {
    now = new Date("2026-07-15T00:30:00.000Z");
    tmallOpenCount = 0;
    tmallContinueCount = 0;
    tmallContinueCredentials = null;
    tmallOpenGate = null;
    tmallCriticalVerificationGate = null;
    tmallCurrentOperationKey = null;
    tmallCloseCount = 0;
    tmallAuthFailure = null;
    tmallOpenError = null;
    tmallSubmitCount = 0;
    tmallStoreName = "测试店铺";
    tmallSubmitState = "sent";
    tmallSubmitFailureOperationKey = null;
    tmallSessionExpiresOnFirstSubmit = false;
    tmallSubmitDelayMs = 0;
    tmallSubmitGate = null;
    tmallSubmitPageStateError = false;
    tmallMissingElements = [];
    tmallMissingElementSequence = null;
    tmallQueueEmpty = false;
    tmallSnapshots = null;
    tmallSnapshotReads = null;
    tmallReadScopes = [];
    tmallVerifiedScopes = [];
    tmallVerifyReplyControls = [];
    tmallReadFailures = [];
    tmallVerificationFailures = [];
    runtimeReadinessError = null;
    runtimeReadinessCheckCount = 0;
    runtimeReadinessGate = null;
    runtimeReadinessGateCall = null;
    deepseekClassificationFailures = 0;
    deepseekClassificationCalls = 0;
    deepseekSentimentAlwaysFails = false;
    deepseekSentimentCalls = 0;
    deepseekSentimentResolver = async () => ({ sentiment: "positive", reason: "整体明确正面", confidence: 0.95 });
    deepseekRewriteCalls = 0;
    deepseekRewriteGate = null;
    deepseekConnectionResult = {
      models: ["deepseek-v4-pro"],
      latencyMs: 12,
      checks: {
        pro: { model: "deepseek-v4-pro", status: "ready", latencyMs: 12 },
      },
    };
    localPickerPick = async () => ({ cancelled: true });
    localPickerCancelCount = 0;
    localPickerCloseCount = 0;
    localPickerCancel = async () => { localPickerCancelCount += 1; };
    localPickerClose = async () => { localPickerCloseCount += 1; };
    manualProductParser = (buffer, filename) => parseManualProductWorkbook(buffer, filename);
    complaintAutoSubmitFactoryValues = [];
    complaintDecisionResolver = async (draft) => ({
      action: "reply",
      caseId: draft.id,
      caseState: "no_complaint",
    });
    secretStore = new InMemorySecretStore();
    uiSessionManager = new UiSessionManager({ leaseMs: 60_000, onIdle: () => undefined });
    uiSessionManager.register("test-console");
    await secretStore.write("taobao_seller", JSON.stringify({ account: "test-merchant", password: "test-password" }));
    await secretStore.write("deepseek_api_key", "test-deepseek-key");
    database = openDatabase(":memory:");
    runMigrations(database);
    const templates = new TemplateRepository(database);
    const settings = new SettingsRepository(database);
    settings.set("tmall_verified_credential_fingerprint", createHash("sha256").update("test-merchant", "utf8").digest("hex"));
    settings.set("tmall_verified_store_name", "测试店铺");
    settings.set("tmall_verified_at", new Date().toISOString());
    settings.set("deepseek_verified_fingerprint", createHash("sha256").update("https://api.deepseek.com\0test-deepseek-key", "utf8").digest("hex"));
    locatorRepository = new LocatorRepository(database);
    locatorRepository.ensureDefaults();
    for (const operationKey of ["navigation.trade", "navigation.reviews", "review.filter.buyer", "review.filter.content", "review.filter.unanswered", "review.date.trigger", "review.search", "review.list", "review.product", "reply.open", "reply.editor", "reply.submit"]) locatorRepository.markSuccess(operationKey);
    templates.saveSource({ library: "good", url: "https://demo.feishu.cn/base/app?table=good", appToken: "app", tableId: "good", viewId: null });
    templates.saveSource({ library: "bad", url: "https://demo.feishu.cn/base/app?table=bad", appToken: "app", tableId: "bad", viewId: null });
    templates.activateVersion({
      library: "good",
      contentHash: "app-good",
      sourceRecordCount: 1,
      templates: [{ primaryCategory: "", category: "通用整体好评类", keywords: [], replies: [{ sequence: 1, text: "感谢您选购测试商品！若有任何疑问欢迎咨询在线客服，感谢您的支持！" }] }],
      warnings: [],
    });
    templates.activateVersion({
      library: "bad",
      contentHash: "app-bad",
      sourceRecordCount: 1,
      templates: [{ primaryCategory: "通用差评类", category: "通用差评类", keywords: [], replies: [{ sequence: 1, text: "非常抱歉没有达到您的预期。" }] }],
      warnings: [],
    });
    app = buildApp({
      host,
      origin,
      sessionToken,
      csrfToken,
      database,
      secretStore,
      uiSessionManager,
      tmallBrowserOperationDeadlineMs: 100,
      runtimeReadinessCheck: async () => {
        runtimeReadinessCheckCount += 1;
        if (runtimeReadinessGate && runtimeReadinessGateCall === runtimeReadinessCheckCount) {
          await runtimeReadinessGate.promise;
        }
        if (runtimeReadinessError) throw runtimeReadinessError;
        return [];
      },
      now: () => new Date(now),
      interItemDelay: async () => undefined,
      localXlsxPicker: {
        pick: () => localPickerPick(),
        cancel: () => localPickerCancel(),
        close: () => localPickerClose(),
      },
      manualProductWorkbookParser: (buffer, filename) => manualProductParser(buffer, filename),
      complaintReviewPolicyFactory: ({ complaintAutoSubmit }) => {
        complaintAutoSubmitFactoryValues.push(complaintAutoSubmit);
        return {
          evaluate: (draft) => complaintDecisionResolver(draft),
        };
      },
      feishuClientFactory: () => ({
        testConnection: async () => undefined,
        listFields: async () => [
          { field_name: "关键词分类" },
          { field_name: "包含关键词" },
          { field_name: "回复话术 1" },
        ],
        listRecords: async () => [
          {
            record_id: "rec-1",
            fields: { 关键词分类: "音质好评", 包含关键词: "音质好", "回复话术 1": "感谢认可" },
          },
          {
            record_id: "rec-2",
            fields: { 关键词分类: "通用整体好评类", 包含关键词: "", "回复话术 1": "感谢支持" },
          },
        ],
      }),
      deepseekClientFactory: () => ({
        testConnection: async () => deepseekConnectionResult,
        analyzeComplaint: async () => ({
          decision: "no_complaint" as const,
          complaintType: "none" as const,
          confidence: 98,
          quoteStart: null,
          quoteEnd: null,
          factCode: "none" as const,
          reason: "测试评价不符合官方投诉类型",
        }),
        reviewSentiment: async () => ({ sentiment: "positive" as const, reason: "独立复核整体正面", confidence: 0.95 }),
        adjudicateSentiment: async () => ({ sentiment: "positive" as const, reason: "最终裁决整体正面", confidence: 0.95 }),
        determineSentiment: async (input) => {
          deepseekSentimentCalls += 1;
          if (deepseekSentimentAlwaysFails) {
            throw new DeepSeekTransientError("network", "temporary sentiment outage");
          }
          return await deepseekSentimentResolver(input);
        },
        classifyReview: async () => {
          deepseekClassificationCalls += 1;
          if (deepseekClassificationFailures > 0) {
            deepseekClassificationFailures -= 1;
            throw new DeepSeekTransientError("network", "temporary test network failure");
          }
          return { library: "good", category: "通用整体好评类", confidence: 0.95, reason: "买家表达认可", needsAttention: false };
        },
        rewriteTemplate: async (input) => {
          deepseekRewriteCalls += 1;
          if (deepseekRewriteGate) await deepseekRewriteGate.promise;
          return {
            finalReply: input.template,
            productAdjusted: false,
            needsAttention: false,
            notes: "模板无需修改",
            detectedTemplateProducts: [],
            unsupportedClaims: [],
          };
        },
        suggestLocatorRepair: async () => ({ strategy: "text" as const, selector: "商品信息", reason: "商品列标题稳定" }),
      }),
      tmallAuthDriver: {
        canSubmitReplies: true,
        openReviewPage: async () => {
          tmallOpenCount += 1;
          if (tmallOpenGate) await tmallOpenGate.promise;
          if (tmallOpenError) throw tmallOpenError;
          if (tmallAuthFailure) return { state: "failed" as const, message: tmallAuthFailure, page: "login" as const };
          return { state: "authenticated", storeName: tmallStoreName, page: "review_list" };
        },
        continueReviewPage: async (credentials) => {
          tmallContinueCount += 1;
          tmallContinueCredentials = credentials;
          if (tmallOpenGate) await tmallOpenGate.promise;
          if (tmallAuthFailure) return { state: "failed" as const, message: tmallAuthFailure, page: "login" as const };
          return { state: "authenticated", storeName: tmallStoreName, page: "review_list" };
        },
        readPendingReviews: async (_limit, scope) => {
          tmallReadScopes.push(scope);
          const failure = tmallReadFailures.shift();
          if (failure) throw failure;
          if (tmallQueueEmpty) return [];
          if (tmallSnapshotReads) return tmallSnapshotReads.shift() ?? [];
          return tmallSnapshots ?? [{
          sourceKey: "tmall:test-order:one",
          orderId: "test-order",
          review: "音质很好，使用方便",
          product: "漫步者测试耳机",
          reviewedAt: "2026-07-14 08:00",
          sentimentLabel: "positive" as const,
          itemId: "test-item-1",
          reviewPhase: "initial" as const,
        }];
        },
        submitReply: async () => {
          tmallSubmitCount += 1;
          if (tmallSubmitPageStateError) throw new TmallReviewPageStateError("提交前商品ID发生变化");
          if (tmallSubmitGate) await tmallSubmitGate.promise;
          if (tmallSubmitDelayMs) await new Promise((resolve) => setTimeout(resolve, tmallSubmitDelayMs));
          if (tmallSessionExpiresOnFirstSubmit && tmallSubmitCount === 1) return { state: "failed" as const, evidence: "登录状态已失效", message: "淘宝登录状态已失效", failureOperationKey: "session.login" };
          if (tmallSubmitFailureOperationKey && tmallSubmitCount === 1) {
            return { state: "failed" as const, evidence: "当前定位无法匹配", message: "页面元素发生变化", failureOperationKey: tmallSubmitFailureOperationKey };
          }
          return { state: tmallSubmitState, evidence: tmallSubmitState === "sent" ? "评价列表显示已回复" : "提交后无法确认" };
        },
        captureSemanticSnapshot: async () => [{ tag: "a", role: "link", name: "商品信息" }],
        probeLocatorCandidate: async () => ({ matches: 1, shadowValidated: true, postconditionPassed: true }),
        verifyCriticalElements: async (scope, options) => {
          tmallVerifiedScopes.push(scope);
          tmallVerifyReplyControls.push(options?.includeReplyControls === true);
          if (tmallCriticalVerificationGate) await tmallCriticalVerificationGate.promise;
          const failure = tmallVerificationFailures.shift();
          if (failure) throw failure;
          const missingOperationKeys = tmallQueueEmpty
            ? []
            : tmallMissingElementSequence?.shift() ?? tmallMissingElements;
          return ({
          verifiedOperationKeys: ["navigation.trade", "navigation.reviews", "review.filter.buyer", "review.filter.content", "review.filter.unanswered", "review.filter.followup", "review.date.trigger", "review.search", "review.list", "review.product", "reply.open", "reply.editor", "reply.submit"].filter((key) => !missingOperationKeys.includes(key)),
          missingOperationKeys,
          queueEmpty: tmallQueueEmpty,
          });
        },
        getCurrentOperationKey: () => tmallCurrentOperationKey,
        close: async () => { tmallCloseCount += 1; },
        clearProfile: async () => undefined,
      },
    });
    await app.ready();
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host } });
    cookie = bootstrap.cookies[0]?.value ?? "";
  });

  afterEach(async () => {
    await app.close();
    uiSessionManager.dispose();
  });

  it("returns the complete formal product data surface", async () => {
    const paths = [
      "/api/dashboard",
      "/api/replies",
      "/api/template-sources",
      "/api/locators",
      "/api/repairs",
      "/api/element-health",
      "/api/locator-repairs",
      "/api/settings",
      "/api/storage",
      "/api/tmall-auth/status",
    ];

    for (const path of paths) {
      const response = await app.inject({
        method: "GET",
        url: path,
        headers: { host, cookie: `tmall_console_session=${cookie}` },
      });
      expect(response.statusCode, path).toBe(200);
      expect(response.headers["cache-control"], path).toBe("no-store");
    }
  });

  it("tracks browser console sessions through protected API endpoints", async () => {
    const headers = {
      host,
      origin,
      "sec-fetch-site": "same-origin",
      "x-csrf-token": csrfToken,
      cookie: `tmall_console_session=${cookie}`,
    };

    const closed = await app.inject({ method: "DELETE", url: "/api/ui-sessions/test-console", headers });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toEqual({ activeCount: 0 });

    const manualStartWithoutConsole = await app.inject({ method: "POST", url: "/api/automation/start-now", headers });
    expect(manualStartWithoutConsole.statusCode).toBe(409);
    expect(manualStartWithoutConsole.json()).toEqual({ error: "foreground_session_required" });

    const registered = await app.inject({ method: "POST", url: "/api/ui-sessions/reopened-console", headers });
    expect(registered.statusCode).toBe(200);
    expect(registered.json()).toEqual({ activeCount: 1 });
  });

  it("keeps complaint auto-submit disabled by default and saves an explicit opt-in", async () => {
    const readHeaders = { host, cookie: `tmall_console_session=${cookie}` };
    const mutationHeaders = {
      ...readHeaders,
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    };

    const initial = await app.inject({ method: "GET", url: "/api/settings", headers: readHeaders });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ complaintAutoSubmit: false });

    const enabled = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: mutationHeaders,
      payload: { complaintAutoSubmit: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ complaintAutoSubmit: true });

    const persisted = await app.inject({ method: "GET", url: "/api/settings", headers: readHeaders });
    expect(persisted.json()).toMatchObject({ complaintAutoSubmit: true });

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: mutationHeaders,
      payload: { complaintAutoSubmit: "yes" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "invalid_complaint_auto_submit" });
  });

  it("rejects complaint auto-submit changes while automation is active", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    tmallOpenGate = deferred<void>();

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && tmallOpenCount === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(tmallOpenCount).toBe(1);

    const changedDuringRun = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { ...headers, "content-type": "application/json" },
      payload: { complaintAutoSubmit: true },
    });
    expect(changedDuringRun.statusCode).toBe(409);
    expect(changedDuringRun.json()).toEqual({ error: "complaint_auto_submit_change_requires_idle_automation" });

    tmallOpenGate.resolve();
  });

  it("passes the complaint auto-submit setting to each newly created complaint policy", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const replies = new ReplyRepository(database);
    const first = replies.discover({
      sourceKey: "complaint-toggle-first", orderId: "complaint-toggle-first", review: "First review", product: "Test product",
      reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "complaint-toggle-first", reviewPhase: "initial",
    });

    expect((await app.inject({ method: "POST", url: `/api/replies/${first.id}/reprocess`, headers })).statusCode).toBe(200);
    expect(complaintAutoSubmitFactoryValues).toEqual([false]);

    expect((await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { ...headers, "content-type": "application/json" },
      payload: { complaintAutoSubmit: true },
    })).statusCode).toBe(200);

    const second = replies.discover({
      sourceKey: "complaint-toggle-second", orderId: "complaint-toggle-second", review: "Second review", product: "Test product",
      reviewedAt: "2026-07-14 08:01", sentimentLabel: "positive", itemId: "complaint-toggle-second", reviewPhase: "initial",
    });
    expect((await app.inject({ method: "POST", url: `/api/replies/${second.id}/reprocess`, headers })).statusCode).toBe(200);
    expect(complaintAutoSubmitFactoryValues).toEqual([false, true]);
  });

  it("exposes a failed complaint-analysis reason with its reply record", async () => {
    const replies = new ReplyRepository(database);
    const draft = replies.discover({
      sourceKey: "complaint-timeout-view",
      orderId: "complaint-timeout-order",
      review: "耳机不错，颜值也挺高",
      product: "漫步者耳机",
      reviewedAt: "2026-07-20 10:43",
      sentimentLabel: "positive",
      itemId: "complaint-timeout-item",
      reviewPhase: "initial",
    });
    const complaints = new ComplaintRepository(database);
    const complaint = complaints.discover("primary", "complaint-timeout-view", {
      reviewId: "complaint-timeout-view",
      contentHash: "0".repeat(64),
      canonicalizerVersion: "review-content-v1",
      phase: "initial",
      imagePairs: [],
      promptVersion: "test-prompt",
      ruleVersion: "test-rule",
      mappingVersion: "test-mapping",
      visualVersion: "test-visual",
      platformMappingVersion: "test-platform",
      modelVersion: "test-model",
    });
    complaints.markFailed(complaint.id, "timeout");

    const response = await app.inject({
      method: "GET",
      url: "/api/replies",
      headers: { host, cookie: `tmall_console_session=${cookie}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toContainEqual(expect.objectContaining({
      id: draft.id,
      state: "discovered",
      complaintErrorKind: "timeout",
    }));
  });

  it("sanitizes historical Playwright errors before returning reply records to the frontend", async () => {
    const replies = new ReplyRepository(database);
    const draft = replies.discover({
      sourceKey: "historical-page-closed-error",
      orderId: "historical-page-closed-error",
      review: "测试评价",
      product: "测试商品",
      reviewedAt: "2026-07-20 10:43",
      sentimentLabel: "unknown",
      itemId: "historical-page-closed-error",
      reviewPhase: "initial",
    });
    replies.fail(
      draft.id,
      "TMALL_SUBMISSION_FAILED",
      "locator.all: Target page, context or browser has been closed",
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/replies",
      headers: { host, cookie: `tmall_console_session=${cookie}` },
    });
    const item = response.json().items.find((candidate: { id: string }) => candidate.id === draft.id);

    expect(item).toMatchObject({ errorMessage: "淘宝页面连接曾中断，本条已停止提交，可在下一轮重新读取" });
    expect(JSON.stringify(item)).not.toContain("Target page");
  });

  it("returns server-paginated reply results with a true total and database-wide filters", async () => {
    const replies = new ReplyRepository(database);
    for (let index = 0; index < 65; index += 1) {
      const draft = replies.discover({
        sourceKey: `api-reply-page-${index}`,
        orderId: String(index),
        review: `API searchable review ${index}`,
        product: `Product ${index}`,
        reviewedAt: "2026-07-20 10:43",
        sentimentLabel: index % 2 === 0 ? "positive" : "negative",
        itemId: String(index),
        reviewPhase: "initial",
      });
      database.prepare(`
        UPDATE reply_drafts
        SET state = ?, library = ?, discovered_at = ?
        WHERE id = ?
      `).run(
        index % 2 === 0 ? "sent" : "failed",
        index % 2 === 0 ? "good" : "bad",
        new Date(Date.UTC(2026, 6, 20, 0, index)).toISOString(),
        draft.id,
      );
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/replies?page=2&pageSize=25&filter=unsent&query=searchable",
      headers: { host, cookie: `tmall_console_session=${cookie}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total: 32,
      overallTotal: 65,
      page: 2,
      pageSize: 25,
      totalPages: 2,
    });
    expect(response.json().items).toHaveLength(7);
    expect(response.json().items.every((item: { state: string }) => item.state !== "sent")).toBe(true);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/replies?page=0&pageSize=25&filter=all",
      headers: { host, cookie: `tmall_console_session=${cookie}` },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "invalid_reply_query" });
  });

  it("clears every non-sent reply result through the explicit unsent scope", async () => {
    const replies = new ReplyRepository(database);
    const states = ["sent", "failed", "retry_wait", "submitting", "submission_uncertain", "needs_attention"] as const;
    for (const state of states) {
      const draft = replies.discover({
        sourceKey: `api-bulk-unsent-${state}`,
        orderId: state,
        review: `Review ${state}`,
        product: "Test product",
        reviewedAt: "2026-07-20 10:43",
        sentimentLabel: "unknown",
        itemId: state,
        reviewPhase: "initial",
      });
      database.prepare("UPDATE reply_drafts SET state = ? WHERE id = ?").run(state, draft.id);
    }

    const response = await app.inject({
      method: "DELETE",
      url: "/api/storage/reviews?scope=unsent",
      headers: {
        host,
        origin,
        "sec-fetch-site": "same-origin",
        "x-csrf-token": csrfToken,
        cookie: `tmall_console_session=${cookie}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ deleted: states.length - 1, scope: "unsent" });
    expect(database.prepare("SELECT source_key, state FROM reply_drafts").all()).toEqual([
      { source_key: "api-bulk-unsent-sent", state: "sent" },
    ]);
  });

  it("applies the list-first rule when an operator reprocesses an existing review", async () => {
    deepseekSentimentResolver = async () => ({ sentiment: "negative", reason: "正文明确描述持续断连", confidence: 0.98 });
    const replies = new ReplyRepository(database);
    const discovered = replies.discover({
      sourceKey: "operator-reprocess-listed-negative",
      orderId: "operator-reprocess-order",
      review: "使用时一直断连，体验很差",
      product: "已改名的名单商品",
      reviewedAt: "2026-07-15 08:00",
      sentimentLabel: "negative",
      itemId: "960227744800",
      reviewPhase: "initial",
    });
    const headers = {
      host,
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      cookie: `tmall_console_session=${cookie}`,
    };
    const added = await app.inject({
      method: "POST",
      url: "/api/manual-products",
      headers,
      payload: { title: "名单中的旧商品标题", itemId: "960227744800", expectedRevision: 1 },
    });
    expect(added.statusCode).toBe(200);

    const reprocessed = await app.inject({
      method: "POST",
      url: `/api/replies/${discovered.id}/reprocess`,
      headers: {
        host,
        origin,
        "sec-fetch-site": "same-origin",
        "x-csrf-token": csrfToken,
        cookie: `tmall_console_session=${cookie}`,
      },
    });

    expect(reprocessed.statusCode).toBe(200);
    expect(reprocessed.json()).toMatchObject({ state: "manual_product_hold", finalReply: "", library: null });
    expect(new ComplaintRepository(database).list()).toHaveLength(0);
    expect(new ReplyAttemptRepository(database).list()).toHaveLength(0);
    expect(new ReviewActionGate(database).getLock("primary", "operator-reprocess-listed-negative")).toMatchObject({
      actionKind: "manual_hold",
    });
  });

  it("never submits an old ready reply when a new list decision enters sentiment retry behind a complaint reply lock", async () => {
    const snapshot: TmallReviewSnapshot = {
      sourceKey: "listed-ready-retry-with-reply-lock",
      orderId: "listed-ready-retry-order",
      review: "暂时说不清楚使用感受",
      product: "后来加入名单的商品",
      reviewedAt: "2026-07-14 08:00",
      sentimentLabel: "unknown",
      itemId: "960227744800",
      reviewPhase: "initial",
    };
    const replies = new ReplyRepository(database);
    const draft = replies.discover(snapshot);
    const complaints = new ComplaintRepository(database);
    const complaint = complaints.discover("primary", snapshot.sourceKey, {
      reviewId: draft.id,
      contentHash: "c".repeat(64),
      canonicalizerVersion: "canonical-v1",
      phase: "initial",
      imagePairs: [],
      promptVersion: "p1",
      ruleVersion: "r1",
      mappingVersion: "m1",
      visualVersion: "v1",
      platformMappingVersion: "platform-v1",
      modelVersion: "m1",
    });
    complaints.finalizeNoComplaint(complaint.id, 96, "普通使用反馈，不符合官方投诉类型", { reviewStillReplyable: true });
    const templates = new TemplateRepository(database);
    const activeVersion = templates.getActiveVersionId("good")!;
    replies.saveManualProductDecision(draft.id, {
      storeId: "primary",
      manualProductId: null,
      catalogRevision: new ManualProductRepository(database).revision(),
      matchKind: "not_matched",
    });
    replies.saveAiCheckpoint(draft.id, {
      library: "good",
      primaryCategory: "",
      category: "通用整体好评类",
      confidence: 0.95,
      reason: "旧分类结果",
      needsAttention: false,
      templateVersionId: activeVersion,
      templateSequence: 1,
      originalTemplate: "感谢您选购测试商品！若有任何疑问欢迎咨询在线客服，感谢您的支持！",
    });
    replies.markRewriting(draft.id);
    replies.complete(draft.id, {
      finalReply: "这是一条旧回复，名单重新判断失败时绝不能提交。",
      productAdjusted: false,
      needsAttention: false,
      notes: "旧草稿",
      attentionReasons: [],
      detectedTemplateProducts: [],
      unsupportedClaims: [],
    });
    const products = new ManualProductRepository(database);
    products.upsert({ itemId: snapshot.itemId, title: "名单商品旧标题" }, "manual", products.revision());
    deepseekSentimentAlwaysFails = true;
    tmallSnapshots = [snapshot];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running" && status.state !== "stopping") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(deepseekSentimentCalls).toBe(2);
    expect(tmallSubmitCount).toBe(0);
    expect(replies.get(draft.id)).toMatchObject({
      state: "retry_wait",
      failedStage: "classification",
      finalReply: "",
    });
    expect(new ReviewActionGate(database).getLock("primary", snapshot.sourceKey)).toMatchObject({ actionKind: "reply" });
    expect(new ReplyAttemptRepository(database).list()).toHaveLength(0);
  });

  it("persists a revisioned review scope and resolves presets with the injected Shanghai clock", async () => {
    const readHeaders = { host, cookie: `tmall_console_session=${cookie}` };
    const writeHeaders = { ...readHeaders, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, "content-type": "application/json" };
    const initial = await app.inject({ method: "GET", url: "/api/review-scope", headers: readHeaders });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      preset: "last7",
      startDate: null,
      endDate: null,
      effectiveStartDate: "2026-07-09",
      effectiveEndDate: "2026-07-15",
      timezone: "Asia/Shanghai",
      processingMode: "content_unanswered",
      revision: 1,
      summary: "最近7天（2026-07-09 至 2026-07-15）",
    });

    const saved = await app.inject({
      method: "PUT",
      url: "/api/review-scope",
      headers: writeHeaders,
      payload: { preset: "custom", startDate: "2026-07-01", endDate: "2026-07-14", processingMode: "followup_only", expectedRevision: 1 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      preset: "custom",
      startDate: "2026-07-01",
      endDate: "2026-07-14",
      effectiveStartDate: "2026-07-01",
      effectiveEndDate: "2026-07-14",
      processingMode: "followup_only",
      revision: 2,
      summary: "自定义（2026-07-01 至 2026-07-14）",
    });

    const stale = await app.inject({
      method: "PUT",
      url: "/api/review-scope",
      headers: writeHeaders,
      payload: { preset: "today", expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      error: "review_scope_changed",
      detail: "处理日期已在其他页面修改，请刷新后重试",
      currentRevision: 2,
    });

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/review-scope",
      headers: writeHeaders,
      payload: { preset: "custom", startDate: "C:\\secret\\db.sqlite", endDate: "2026-07-14", expectedRevision: 2 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "invalid_review_scope", detail: "请选择有效的处理日期" });
    expect(invalid.body).not.toMatch(/secret|sqlite|stack|UPDATE/iu);

    const invalidMode = await app.inject({
      method: "PUT",
      url: "/api/review-scope",
      headers: writeHeaders,
      payload: { preset: "today", processingMode: "untrusted", expectedRevision: 2 },
    });
    expect(invalidMode.statusCode).toBe(400);
    expect(invalidMode.json()).toEqual({ error: "invalid_review_scope", detail: "请选择有效的处理日期和评价类型" });
  });

  it("uses compare-and-swap revisions for automation plans and rejects the stale client", async () => {
    const readHeaders = { host, cookie: `tmall_console_session=${cookie}` };
    const writeHeaders = { ...readHeaders, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, "content-type": "application/json" };
    const initial = await app.inject({ method: "GET", url: "/api/automation-plan", headers: readHeaders });
    expect(initial.json()).toMatchObject({ revision: 1 });
    const payload = { enabled: true, intervalMinutes: 20, windows: [{ id: "morning", start: "08:00", end: "09:00" }], expectedRevision: 1 };
    const first = await app.inject({ method: "PUT", url: "/api/automation-plan", headers: writeHeaders, payload });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ revision: 2, enabled: true });
    const stale = await app.inject({ method: "PUT", url: "/api/automation-plan", headers: writeHeaders, payload });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: "automation_plan_changed", detail: "自动计划已在其他页面修改，请刷新后重试", currentRevision: 2 });
    expect((await app.inject({ method: "GET", url: "/api/automation-plan", headers: readHeaders })).json()).toMatchObject({ revision: 2, enabled: true });
  });

  it("does not expose storage failures from internal automation controls", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({
      method: "PUT", url: "/api/automation-plan", headers,
      payload: { enabled: true, intervalMinutes: 15, windows: [{ id: "morning", start: "09:00", end: "10:00" }], expectedRevision: 1 },
    })).statusCode).toBe(200);
    database.prepare(`
      CREATE TRIGGER fail_automation_pause
      BEFORE UPDATE ON automation_plan
      BEGIN SELECT RAISE(ABORT, 'C:\\private\\automation-secret.sqlite'); END
    `).run();
    const response = await app.inject({ method: "POST", url: "/api/automation/pause", headers });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "automation_plan_update_failed", detail: "自动计划更新失败，请稍后重试" });
    expect(response.body).not.toMatch(/private|secret|sqlite|stack/iu);
    database.prepare("DROP TRIGGER fail_automation_pause").run();
  });

  it("creates, enriches, searches, pages and removes manual products with catalog revisions", async () => {
    const readHeaders = { host, cookie: `tmall_console_session=${cookie}` };
    const writeHeaders = { ...readHeaders, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, "content-type": "application/json" };
    const empty = await app.inject({ method: "GET", url: "/api/manual-products?page=1&pageSize=10", headers: readHeaders });
    expect(empty.json()).toEqual({
      catalogRevision: 1,
      total: 0,
      page: 1,
      pageSize: 10,
      items: [],
      stats: { total: 0, manualSourceCount: 0, excelSourceCount: 0, lastImportAt: null },
    });
    const created = await app.inject({
      method: "POST", url: "/api/manual-products", headers: writeHeaders,
      payload: { title: "", itemId: "1003", expectedRevision: 1 },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ outcome: "created", catalogRevision: 2, product: { title: "", itemId: "1003", sources: ["manual"] } });
    const productId = created.json().product.id as string;
    const enriched = await app.inject({
      method: "POST", url: "/api/manual-products", headers: writeHeaders,
      payload: { title: "漫步者 Atom ANC", itemId: "1003", expectedRevision: 2 },
    });
    expect(enriched.statusCode).toBe(200);
    expect(enriched.json()).toMatchObject({ outcome: "reused", catalogRevision: 3, product: { id: productId, itemId: "1003", title: "漫步者 Atom ANC" } });
    const list = await app.inject({ method: "GET", url: "/api/manual-products?query=1003&page=1&pageSize=1", headers: readHeaders });
    expect(list.json()).toMatchObject({ catalogRevision: 3, total: 1, page: 1, pageSize: 1, items: [{ id: productId }], stats: { total: 1, manualSourceCount: 1, excelSourceCount: 0 } });
    const stale = await app.inject({ method: "DELETE", url: `/api/manual-products/${productId}`, headers: writeHeaders, payload: { expectedRevision: 2 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ currentRevision: 3 });
    const removed = await app.inject({ method: "DELETE", url: `/api/manual-products/${productId}`, headers: writeHeaders, payload: { expectedRevision: 3 } });
    expect(removed.json()).toEqual({ removed: true, catalogRevision: 4 });
    expect(database.prepare(`
      SELECT event_type, target FROM operation_audit
      WHERE event_type IN ('manual_product_saved', 'manual_product_removed')
      ORDER BY id
    `).all()).toEqual([
      { event_type: "manual_product_saved", target: productId },
      { event_type: "manual_product_saved", target: productId },
      { event_type: "manual_product_removed", target: productId },
    ]);
  });

  it("previews and applies one xlsx through a server-bound one-use session token", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRows([["商品标题", "商品ID"], ["漫步者 X1 EVO", "1001"], ["漫步者 R101V", "1002"]]);
    const workbookBytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const boundary = "----tmall-review-test-boundary";
    const multipart = buildMultipart(boundary, [{ name: "file", filename: "products.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: workbookBytes }]);
    const headers = {
      host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken,
      cookie: `tmall_console_session=${cookie}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "x-session-id": "attacker-session",
    };
    const preview = await app.inject({ method: "POST", url: "/api/manual-products/import/preview", headers, payload: multipart });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ canApply: true, previewId: expect.any(String), catalogRevision: 1, summary: { added: 2, retained: 0, removed: 0, conflicts: 0 } });
    expect(preview.body).not.toContain("attacker-session");
    const applyHeaders = { ...headers, "content-type": "application/json" };
    const applied = await app.inject({ method: "POST", url: "/api/manual-products/import/apply", headers: applyHeaders, payload: { previewId: preview.json().previewId } });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toEqual({ catalogRevision: 2, added: 2, removed: 0, retained: 0 });
    const list = await app.inject({ method: "GET", url: "/api/manual-products", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(list.json()).toMatchObject({ catalogRevision: 2, stats: { total: 2, manualSourceCount: 0, excelSourceCount: 2, lastImportAt: "2026-07-15T00:30:00.000Z" } });
    expect(database.prepare("SELECT target FROM operation_audit WHERE event_type = 'manual_product_import_applied'").get()).toEqual({ target: "manual_product_catalog" });
    const replay = await app.inject({ method: "POST", url: "/api/manual-products/import/apply", headers: applyHeaders, payload: { previewId: preview.json().previewId } });
    expect(replay.statusCode).toBe(410);
    expect(replay.json()).toEqual({ error: "import_preview_invalid", detail: "预览已失效，请重新选择文件" });
  });

  it("returns stable multipart errors without exposing uploaded content or parser internals", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const noFileBoundary = "----empty-boundary";
    const missing = await app.inject({
      method: "POST", url: "/api/manual-products/import/preview",
      headers: { ...headers, "content-type": `multipart/form-data; boundary=${noFileBoundary}` },
      payload: buildMultipart(noFileBoundary, [], {}),
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ error: "manual_product_file_required", detail: "请选择一个 .xlsx 文件" });

    const badBoundary = "----bad-boundary";
    const marker = "C:\\private\\secret.xml";
    const bad = await app.inject({
      method: "POST", url: "/api/manual-products/import/preview",
      headers: { ...headers, "content-type": `multipart/form-data; boundary=${badBoundary}` },
      payload: buildMultipart(badBoundary, [{ name: "file", filename: "malicious.xlsx", mimetype: "application/octet-stream", body: Buffer.from(marker) }]),
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toEqual({ error: "invalid_manual_product_workbook", detail: "文件不是有效的 Excel 工作簿" });
    expect(bad.body).not.toMatch(/private|secret|xml|stack|ZIP|SQLite/iu);

    const multipleBoundary = "----multiple-boundary";
    const multiple = await app.inject({
      method: "POST", url: "/api/manual-products/import/preview",
      headers: { ...headers, "content-type": `multipart/form-data; boundary=${multipleBoundary}` },
      payload: buildMultipart(multipleBoundary, [
        { name: "file", filename: "one.xlsx", mimetype: "application/octet-stream", body: Buffer.from("PK\u0003\u0004one") },
        { name: "file", filename: "two.xlsx", mimetype: "application/octet-stream", body: Buffer.from("PK\u0003\u0004two") },
      ]),
    });
    expect(multiple.statusCode).toBe(400);
    expect(multiple.json()).toEqual({ error: "manual_product_file_count_invalid", detail: "每次只能上传一个 .xlsx 文件" });
  });

  it("returns a stable 400 for multipart requests with a missing boundary or truncated body", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const missingBoundary = await app.inject({
      method: "POST", url: "/api/manual-products/import/preview",
      headers: { ...headers, "content-type": "multipart/form-data" },
      payload: "C:\\private\\missing-boundary.xlsx",
    });
    expect(missingBoundary.statusCode).toBe(400);
    expect(missingBoundary.json()).toEqual({ error: "manual_product_file_required", detail: "请选择一个有效的 .xlsx 文件" });
    expect(missingBoundary.body).not.toMatch(/private|boundary|stack|multipart|FST_/iu);

    const boundary = "----truncated-client-body";
    const truncated = await app.inject({
      method: "POST", url: "/api/manual-products/import/preview",
      headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\nPK\u0003\u0004truncated`),
    });
    expect(truncated.statusCode).toBe(400);
    expect(truncated.json()).toEqual({ error: "manual_product_file_required", detail: "请选择一个有效的 .xlsx 文件" });
    expect(truncated.body).not.toMatch(/private|truncated|stack|multipart|FST_/iu);
  });

  it("rejects repeated manual product query and pagination parameters before repository access", async () => {
    const headers = { host, cookie: `tmall_console_session=${cookie}` };
    database.prepare("ALTER TABLE manual_products RENAME TO manual_products_validation_guard").run();
    try {
      for (const url of [
        "/api/manual-products?query=first&query=second",
        "/api/manual-products?page=1&page=2",
        "/api/manual-products?pageSize=10&pageSize=20",
      ]) {
        const response = await app.inject({ method: "GET", url, headers });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid_manual_product_query", detail: "请检查搜索内容和分页设置" });
        expect(response.body).not.toMatch(/SQLite|SELECT|stack|Internal Server Error/iu);
      }
    } finally {
      database.prepare("ALTER TABLE manual_products_validation_guard RENAME TO manual_products").run();
    }
  });

  it("uses the injected application clock for audit, schedule and confirmation nonce expiry", async () => {
    const mutationHeaders = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}`, "content-type": "application/json" };
    const created = await app.inject({
      method: "POST", url: "/api/manual-products", headers: mutationHeaders,
      payload: { title: "固定时钟商品", itemId: "clock-item", expectedRevision: 1 },
    });
    expect(created.statusCode).toBe(200);
    expect(database.prepare("SELECT created_at FROM operation_audit WHERE event_type = 'manual_product_saved'").get()).toEqual({ created_at: now.toISOString() });

    const plan = await app.inject({
      method: "PUT", url: "/api/automation-plan", headers: mutationHeaders,
      payload: { enabled: true, intervalMinutes: 15, windows: [{ id: "morning", start: "09:00", end: "10:00" }], expectedRevision: 1 },
    });
    expect(plan.statusCode).toBe(200);
    const status = await app.inject({ method: "GET", url: "/api/automation/status", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(status.json()).toMatchObject({ state: "waiting", currentWindow: null, nextRunAt: "2026-07-15T01:00:00.000Z" });

    const prepared = await app.inject({ method: "POST", url: "/api/secrets/deepseek_api_key/prepare", headers: mutationHeaders, payload: { action: "replace" } });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toMatchObject({ expiresAt: now.getTime() + 5 * 60 * 1000 });
  });

  it("expires previews, consumes revision-conflicted previews, and keeps every mutation behind request guards", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Sheet1").addRows([["商品ID", "商品标题"], ["expiry-item", "到期商品"]]);
    const workbookBytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const boundary = "----expiry-boundary";
    const body = buildMultipart(boundary, [{ name: "file", filename: "products.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: workbookBytes }]);
    const uploadHeaders = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}`, "content-type": `multipart/form-data; boundary=${boundary}` };
    const preview = await app.inject({ method: "POST", url: "/api/manual-products/import/preview", headers: uploadHeaders, payload: body });
    now = new Date(now.getTime() + 10 * 60 * 1000);
    const jsonHeaders = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}`, "content-type": "application/json" };
    const expired = await app.inject({ method: "POST", url: "/api/manual-products/import/apply", headers: jsonHeaders, payload: { previewId: preview.json().previewId } });
    expect(expired.statusCode).toBe(410);

    now = new Date("2026-07-15T00:30:00.000Z");
    const fresh = await app.inject({ method: "POST", url: "/api/manual-products/import/preview", headers: uploadHeaders, payload: body });
    await app.inject({ method: "POST", url: "/api/manual-products", headers: jsonHeaders, payload: { title: "并发商品", itemId: "concurrent-item", expectedRevision: 1 } });
    const conflicted = await app.inject({ method: "POST", url: "/api/manual-products/import/apply", headers: jsonHeaders, payload: { previewId: fresh.json().previewId } });
    expect(conflicted.statusCode).toBe(409);
    expect(conflicted.json()).toEqual({ error: "manual_product_catalog_changed", detail: "名单已发生变化，请重新选择文件" });
    const consumed = await app.inject({ method: "POST", url: "/api/manual-products/import/apply", headers: jsonHeaders, payload: { previewId: fresh.json().previewId } });
    expect(consumed.statusCode).toBe(410);

    const guarded = await app.inject({ method: "POST", url: "/api/manual-products", headers: { host, cookie: `tmall_console_session=${cookie}`, "content-type": "application/json" }, payload: { title: "越权商品", itemId: "guarded-item", expectedRevision: 2 } });
    expect(guarded.statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/reviews/arbitrary/reply", headers: jsonHeaders, payload: { review: "任意文本" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/complaints/arbitrary/submit", headers: jsonHeaders, payload: { review: "任意文本" } })).statusCode).toBe(404);
  });

  it("does not consume a valid preview on a wrong cookie and invalidates it during factory reset", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Sheet1").addRows([["商品ID", "商品标题"], ["session-item", "会话绑定商品"]]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const boundary = "----session-boundary";
    const mutationHeaders = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const preview = await app.inject({
      method: "POST", url: "/api/manual-products/import/preview",
      headers: { ...mutationHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: buildMultipart(boundary, [{ name: "file", filename: "products.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: bytes }]),
    });
    const previewId = preview.json().previewId as string;
    const wrongCookie = await app.inject({
      method: "POST", url: "/api/manual-products/import/apply",
      headers: { ...mutationHeaders, cookie: "tmall_console_session=wrong", "content-type": "application/json" },
      payload: { previewId },
    });
    expect(wrongCookie.statusCode).toBe(401);

    const prepared = await app.inject({ method: "POST", url: "/api/storage/factory-reset/prepare", headers: mutationHeaders });
    const reset = await app.inject({
      method: "POST", url: "/api/storage/factory-reset",
      headers: { ...mutationHeaders, "content-type": "application/json" },
      payload: { nonce: prepared.json().nonce },
    });
    expect(reset.statusCode).toBe(200);
    expect(localPickerCancelCount).toBe(1);
    const afterReset = await app.inject({
      method: "POST", url: "/api/manual-products/import/apply",
      headers: { ...mutationHeaders, "content-type": "application/json" },
      payload: { previewId },
    });
    expect(afterReset.statusCode).toBe(410);
  });

  it("keeps the dialog flow open when the local Windows picker is cancelled", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const response = await app.inject({ method: "POST", url: "/api/manual-products/import/select-and-preview", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cancelled: true });
  });

  it("aborts a pending local picker before application shutdown waits for active requests", async () => {
    const started = deferred<void>();
    let rejectPicker!: (reason: unknown) => void;
    localPickerPick = () => {
      started.resolve();
      return new Promise((_resolve, reject) => { rejectPicker = reject; });
    };
    localPickerClose = async () => {
      localPickerCloseCount += 1;
      rejectPicker(new Error("application closing"));
    };
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const pending = app.inject({ method: "POST", url: "/api/manual-products/import/select-and-preview", headers });
    await started.promise;

    await app.close();
    const response = await pending;

    expect(response.statusCode).toBe(500);
    expect(localPickerCloseCount).toBe(1);
    await app.close();
    expect(localPickerCloseCount).toBe(1);
  }, 2_000);

  it("previews a locally selected workbook without returning or persisting its full path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tmall-local-picker-"));
    const filePath = join(directory, "中差评剔除产品.xlsx");
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Sheet1").addRows([["商品ID", "商品标题"], ["960227744800", "测试商品"]]);
    await writeFile(filePath, Buffer.from(await workbook.xlsx.writeBuffer()));
    localPickerPick = async () => ({ cancelled: false, path: filePath });
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    try {
      const response = await app.inject({ method: "POST", url: "/api/manual-products/import/select-and-preview", headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        cancelled: false,
        displayFilename: "中差评剔除产品.xlsx",
        canApply: true,
        summary: { added: 1, retained: 0, removed: 0, conflicts: 0 },
      });
      expect(response.json().previewId).toEqual(expect.any(String));
      expect(response.body).not.toContain(directory);
      expect(JSON.stringify(database.prepare("SELECT * FROM operation_audit").all())).not.toContain(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

    it("rejects unsafe local picker results and contains picker process failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tmall-local-picker-invalid-"));
    const wrongExtension = join(directory, "private-source.xls");
    const tooLarge = join(directory, "private-large.xlsx");
    await writeFile(wrongExtension, Buffer.from("not an xlsx"));
    await writeFile(tooLarge, Buffer.alloc(5 * 1024 * 1024 + 1, 0x41));
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    try {
      for (const [path, statusCode, error] of [
        [wrongExtension, 422, "invalid_manual_product_workbook"],
        [directory, 422, "manual_product_local_file_invalid"],
        [join(directory, "missing-private.xlsx"), 422, "manual_product_local_file_invalid"],
        [tooLarge, 413, "manual_product_file_too_large"],
      ] as const) {
        localPickerPick = async () => ({ cancelled: false, path });
        const response = await app.inject({ method: "POST", url: "/api/manual-products/import/select-and-preview", headers });
        expect(response.statusCode, response.body).toBe(statusCode);
        expect(response.json().error).toBe(error);
        expect(response.body).not.toContain(directory);
      }

      localPickerPick = async () => { throw new Error(`PowerShell failed at ${directory}\\secret.xlsx`); };
      const failed = await app.inject({ method: "POST", url: "/api/manual-products/import/select-and-preview", headers });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({ error: "manual_product_local_picker_failed", detail: "无法打开本机文件选择窗口，请使用浏览器上传（备用）" });
      expect(failed.body).not.toContain(directory);
      expect(failed.body).not.toMatch(/PowerShell|secret\.xlsx|stack/iu);
    } finally {
      await rm(directory, { recursive: true, force: true });
      }
    });

    it("invalidates the previous preview before validating a newly selected local file", async () => {
      const directory = await mkdtemp(join(tmpdir(), "tmall-local-picker-replace-"));
      const valid = join(directory, "valid.xlsx");
      const invalid = join(directory, "invalid.xls");
      const oversized = join(directory, "oversized.xlsx");
      const missing = join(directory, "missing.xlsx");
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet("Sheet1").addRows([["商品ID"], ["960227744800"]]);
      await writeFile(valid, Buffer.from(await workbook.xlsx.writeBuffer()));
      await writeFile(invalid, Buffer.from("not an xlsx"));
      await writeFile(oversized, Buffer.alloc(5 * 1024 * 1024 + 1, 0x41));
      const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
      try {
        for (const [replacement, expectedStatus] of [[invalid, 422], [oversized, 413], [missing, 422]] as const) {
          localPickerPick = async () => ({ cancelled: false, path: valid });
          const first = await app.inject({ method: "POST", url: "/api/manual-products/import/select-and-preview", headers });
          expect(first.statusCode, first.body).toBe(200);
          const previewId = first.json().previewId as string;

          localPickerPick = async () => ({ cancelled: false, path: replacement });
          const rejected = await app.inject({ method: "POST", url: "/api/manual-products/import/select-and-preview", headers });
          expect(rejected.statusCode).toBe(expectedStatus);

          const staleApply = await app.inject({
            method: "POST",
            url: "/api/manual-products/import/apply",
            headers,
            payload: { previewId },
          });
          expect(staleApply.statusCode).toBe(410);
          expect(staleApply.json().error).toBe("import_preview_invalid");
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("keeps the previous preview when the picker is cancelled or cannot open", async () => {
      const directory = await mkdtemp(join(tmpdir(), "tmall-local-picker-preserve-"));
      const valid = join(directory, "valid.xlsx");
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet("Sheet1").addRows([["商品ID"], ["960227744800"]]);
      await writeFile(valid, Buffer.from(await workbook.xlsx.writeBuffer()));
      const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
      try {
        localPickerPick = async () => ({ cancelled: false, path: valid });
        const first = await app.inject({ method: "POST", url: "/api/manual-products/import/select-and-preview", headers });
        expect(first.statusCode, first.body).toBe(200);
        const previewId = first.json().previewId as string;

        localPickerPick = async () => ({ cancelled: true });
        const cancelled = await app.inject({ method: "POST", url: "/api/manual-products/import/select-and-preview", headers });
        expect(cancelled.json()).toEqual({ cancelled: true });

        localPickerPick = async () => { throw new Error("picker unavailable"); };
        const unavailable = await app.inject({ method: "POST", url: "/api/manual-products/import/select-and-preview", headers });
        expect(unavailable.statusCode).toBe(500);

        const apply = await app.inject({
          method: "POST",
          url: "/api/manual-products/import/apply",
          headers,
          payload: { previewId },
        });
        expect(apply.statusCode, apply.body).toBe(200);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("returns a stable conflict when a slow preview is replaced by a newer file", async () => {
      const olderStarted = deferred<void>();
      const olderResult = deferred<ParsedManualProductWorkbook>();
      manualProductParser = async (_buffer, filename) => {
        if (filename === "older.xlsx") {
          olderStarted.resolve();
          return olderResult.promise;
        }
        return { worksheetName: "Sheet1", rows: [{ itemId: "newer-id", title: "新文件商品" }] };
      };
      const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
      const olderBoundary = "----older-preview-boundary";
      const newerBoundary = "----newer-preview-boundary";
      const older = app.inject({
        method: "POST",
        url: "/api/manual-products/import/preview",
        headers: { ...headers, "content-type": `multipart/form-data; boundary=${olderBoundary}` },
        payload: buildMultipart(olderBoundary, [{
          name: "file",
          filename: "older.xlsx",
          mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          body: Buffer.from("older"),
        }]),
      });
      await olderStarted.promise;

      const newer = await app.inject({
        method: "POST",
        url: "/api/manual-products/import/preview",
        headers: { ...headers, "content-type": `multipart/form-data; boundary=${newerBoundary}` },
        payload: buildMultipart(newerBoundary, [{
          name: "file",
          filename: "newer.xlsx",
          mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          body: Buffer.from("newer"),
        }]),
      });
      expect(newer.statusCode, newer.body).toBe(200);
      olderResult.resolve({ worksheetName: "Sheet1", rows: [{ itemId: "older-id", title: "旧文件商品" }] });

      const superseded = await older;
      expect(superseded.statusCode).toBe(409);
      expect(superseded.json()).toEqual({
        error: "manual_product_preview_superseded",
        detail: "该预览已被较新的文件选择取代",
      });
    });

  it("rejects non-multipart, extra fields and a file larger than 5 MiB with stable errors", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const nonMultipart = await app.inject({ method: "POST", url: "/api/manual-products/import/preview", headers, payload: "not multipart" });
    expect(nonMultipart.statusCode, nonMultipart.body).toBe(400);
    expect(nonMultipart.json()).toEqual({ error: "manual_product_file_required", detail: "请选择一个 .xlsx 文件" });

    const fieldsBoundary = "----fields-boundary";
    const field = await app.inject({
      method: "POST", url: "/api/manual-products/import/preview",
      headers: { ...headers, "content-type": `multipart/form-data; boundary=${fieldsBoundary}` },
      payload: buildMultipart(fieldsBoundary, [], { sessionId: "do-not-trust-me" }),
    });
    expect(field.statusCode).toBe(400);
    expect(field.json()).toEqual({ error: "manual_product_file_count_invalid", detail: "每次只能上传一个 .xlsx 文件" });

    const largeBoundary = "----large-boundary";
    const tooLarge = await app.inject({
      method: "POST", url: "/api/manual-products/import/preview",
      headers: { ...headers, "content-type": `multipart/form-data; boundary=${largeBoundary}` },
      payload: buildMultipart(largeBoundary, [{
        name: "file", filename: "large.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: Buffer.alloc(5 * 1024 * 1024 + 1, 0x41),
      }]),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toEqual({ error: "manual_product_file_too_large", detail: "文件大小不能超过 5MB" });
  });

  it("contains unexpected preview failures and does not leak SQLite or uploaded metadata", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Sheet1").addRows([["商品ID", "商品标题"], ["sensitive-item", "高度敏感标题"]]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const boundary = "----unknown-error-boundary";
    database.prepare("ALTER TABLE manual_product_catalog_state RENAME TO manual_product_catalog_state_backup").run();
    try {
      const response = await app.inject({
        method: "POST", url: "/api/manual-products/import/preview",
        headers: { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}`, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: buildMultipart(boundary, [{ name: "file", filename: "secret-filename.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: bytes }]),
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: "manual_product_preview_failed", detail: "无法预览该名单，请重新选择文件" });
      expect(response.body).not.toMatch(/SQLite|secret-filename|高度敏感标题|stack/iu);
    } finally {
      database.prepare("ALTER TABLE manual_product_catalog_state_backup RENAME TO manual_product_catalog_state").run();
    }
  });

  it("rolls back a catalog mutation when its audit insertion fails and exposes no sensitive payload", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}`, "content-type": "application/json" };
    database.prepare(`
      CREATE TRIGGER fail_manual_product_audit
      BEFORE INSERT ON operation_audit
      WHEN NEW.event_type = 'manual_product_saved'
      BEGIN SELECT RAISE(ABORT, 'C:\\private\\audit-secret.sqlite'); END
    `).run();
    const saved = await app.inject({ method: "POST", url: "/api/manual-products", headers, payload: { title: "绝密商品完整标题", itemId: "private-100", expectedRevision: 1 } });
    expect(saved.statusCode).toBe(500);
    expect(saved.json()).toEqual({ error: "manual_product_save_failed", detail: "商品保存失败，请稍后重试" });
    expect(saved.body).not.toMatch(/private|绝密商品|SQLite|audit-secret|stack/iu);
    database.prepare("DROP TRIGGER fail_manual_product_audit").run();
    const list = await app.inject({ method: "GET", url: "/api/manual-products?query=private-100", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(list.json()).toMatchObject({ catalogRevision: 1, total: 0, items: [] });
    const audits = database.prepare("SELECT event_type, target, result, error_code FROM operation_audit").all();
    expect(JSON.stringify(audits)).not.toMatch(/绝密商品完整标题|private-100|\.xlsx|preview|Buffer/iu);
  });

  it("rolls back scope and plan revisions when their audit insertion fails", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}`, "content-type": "application/json" };
    database.prepare(`
      CREATE TRIGGER fail_scope_audit
      BEFORE INSERT ON operation_audit
      WHEN NEW.event_type = 'review_scope_saved'
      BEGIN SELECT RAISE(ABORT, 'private scope audit'); END
    `).run();
    const scope = await app.inject({ method: "PUT", url: "/api/review-scope", headers, payload: { preset: "yesterday", expectedRevision: 1 } });
    expect(scope.statusCode).toBe(500);
    expect(scope.json()).toEqual({ error: "review_scope_save_failed", detail: "处理日期保存失败，请稍后重试" });
    database.prepare("DROP TRIGGER fail_scope_audit").run();
    expect((await app.inject({ method: "GET", url: "/api/review-scope", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json()).toMatchObject({ preset: "last7", revision: 1 });

    database.prepare(`
      CREATE TRIGGER fail_plan_audit
      BEFORE INSERT ON operation_audit
      WHEN NEW.event_type = 'automation_plan_saved'
      BEGIN SELECT RAISE(ABORT, 'private plan audit'); END
    `).run();
    const plan = await app.inject({
      method: "PUT", url: "/api/automation-plan", headers,
      payload: { enabled: false, intervalMinutes: 30, windows: [{ id: "morning", start: "08:00", end: "09:00" }], expectedRevision: 1 },
    });
    expect(plan.statusCode).toBe(500);
    expect(plan.json()).toEqual({ error: "automation_plan_update_failed", detail: "自动计划更新失败，请稍后重试" });
    database.prepare("DROP TRIGGER fail_plan_audit").run();
    expect((await app.inject({ method: "GET", url: "/api/automation-plan", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json()).toMatchObject({ revision: 1, intervalMinutes: 15, windows: [] });
  });

  it("rolls back pause, resume and stop when their audit insertion fails", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const readPlan = async () => (await app.inject({ method: "GET", url: "/api/automation-plan", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json();

    expect((await app.inject({
      method: "PUT", url: "/api/automation-plan", headers,
      payload: { enabled: true, intervalMinutes: 15, windows: [{ id: "morning", start: "09:00", end: "10:00" }], expectedRevision: 1 },
    })).statusCode).toBe(200);

    database.prepare(`
      CREATE TRIGGER fail_pause_audit BEFORE INSERT ON operation_audit
      WHEN NEW.event_type = 'automation_plan_paused'
      BEGIN SELECT RAISE(ABORT, 'private pause audit'); END
    `).run();
    const failedPause = await app.inject({ method: "POST", url: "/api/automation/pause", headers });
    expect(failedPause.statusCode).toBe(500);
    expect(await readPlan()).toMatchObject({ revision: 2, paused: false });
    database.prepare("DROP TRIGGER fail_pause_audit").run();

    expect((await app.inject({ method: "POST", url: "/api/automation/pause", headers })).statusCode).toBe(200);
    expect(await readPlan()).toMatchObject({ revision: 3, paused: true });
    database.prepare(`
      CREATE TRIGGER fail_resume_audit BEFORE INSERT ON operation_audit
      WHEN NEW.event_type = 'automation_plan_resumed'
      BEGIN SELECT RAISE(ABORT, 'private resume audit'); END
    `).run();
    const failedResume = await app.inject({ method: "POST", url: "/api/automation/resume", headers });
    expect(failedResume.statusCode).toBe(500);
    expect(await readPlan()).toMatchObject({ revision: 3, paused: true });
    database.prepare("DROP TRIGGER fail_resume_audit").run();

    expect((await app.inject({ method: "POST", url: "/api/automation/resume", headers })).statusCode).toBe(200);
    expect(await readPlan()).toMatchObject({ revision: 4, paused: false });
    const enabled = await app.inject({
      method: "PUT", url: "/api/automation-plan", headers,
      payload: { enabled: true, intervalMinutes: 15, windows: [{ id: "morning", start: "09:00", end: "10:00" }], expectedRevision: 4 },
    });
    expect(enabled.statusCode).toBe(200);
    expect(await readPlan()).toMatchObject({ revision: 5, enabled: true });
    database.prepare(`
      CREATE TRIGGER fail_stop_audit BEFORE INSERT ON operation_audit
      WHEN NEW.event_type = 'automation_plan_stopped'
      BEGIN SELECT RAISE(ABORT, 'private stop audit'); END
    `).run();
    const failedStop = await app.inject({ method: "POST", url: "/api/automation/stop", headers });
    expect(failedStop.statusCode).toBe(500);
    expect(await readPlan()).toMatchObject({ revision: 5, enabled: true, paused: false });
    database.prepare("DROP TRIGGER fail_stop_audit").run();
  });

  it("rolls back imported products, memberships, catalog time, held draft and lock when import audit fails", async () => {
    const repository = new ManualProductRepository(database);
    const old = repository.upsert({ itemId: "old-item", title: "旧名单商品" }, "excel", 1).product;
    const replies = new ReplyRepository(database);
    const draft = replies.discover({
      sourceKey: "import-audit-rollback-hold",
      orderId: null,
      review: "一般",
      product: "旧名单商品",
      reviewedAt: "2026-07-15 08:00",
      sentimentLabel: "negative",
      itemId: null,
      reviewPhase: "initial",
    });
    replies.markManualProductHold(draft.id, {
      storeId: "primary",
      manualProductId: old.id,
      catalogRevision: repository.revision(),
      matchKind: "item_id",
      reason: "人工处理商品",
    });
    const before = snapshotManualCatalogMutationTables(database);

    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Sheet1").addRows([["商品标题", "商品ID"], ["新名单商品", "new-item"]]);
    const boundary = "----atomic-import-boundary";
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const preview = await app.inject({
      method: "POST", url: "/api/manual-products/import/preview",
      headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: buildMultipart(boundary, [{
        name: "file", filename: "sensitive-catalog.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: Buffer.from(await workbook.xlsx.writeBuffer()),
      }]),
    });
    expect(preview.statusCode).toBe(200);
    database.prepare(`
      CREATE TRIGGER fail_import_audit BEFORE INSERT ON operation_audit
      WHEN NEW.event_type = 'manual_product_import_applied'
      BEGIN SELECT RAISE(ABORT, 'C:\\private\\import-audit.sqlite'); END
    `).run();
    const applyHeaders = { ...headers, "content-type": "application/json" };
    const failed = await app.inject({
      method: "POST", url: "/api/manual-products/import/apply", headers: applyHeaders,
      payload: { previewId: preview.json().previewId },
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "manual_product_import_failed", detail: "名单更新未完成，请重新选择文件后再试" });
    expect(failed.body).not.toMatch(/sensitive|private|SQLite|audit|stack/iu);
    expect(snapshotManualCatalogMutationTables(database)).toEqual(before);
    database.prepare("DROP TRIGGER fail_import_audit").run();
    const replay = await app.inject({
      method: "POST", url: "/api/manual-products/import/apply", headers: applyHeaders,
      payload: { previewId: preview.json().previewId },
    });
    expect(replay.statusCode).toBe(410);
    expect(replay.json()).toEqual({ error: "import_preview_invalid", detail: "预览已失效，请重新选择文件" });
  });

  it("contains unexpected non-import storage failures behind one stable internal error", async () => {
    database.prepare("ALTER TABLE manual_products RENAME TO manual_products_private_secret").run();
    try {
      const response = await app.inject({ method: "GET", url: "/api/manual-products", headers: { host, cookie: `tmall_console_session=${cookie}` } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "INTERNAL_ERROR", detail: "系统暂时无法完成操作，请稍后重试" });
      expect(response.body).not.toMatch(/manual_products|private_secret|SQLite|SELECT|stack/iu);
    } finally {
      database.prepare("ALTER TABLE manual_products_private_secret RENAME TO manual_products").run();
    }
  });

  it("rejects invalid and missing manual product ids without changing revision or audit", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}`, "content-type": "application/json" };
    const invalid = await app.inject({ method: "DELETE", url: "/api/manual-products/not-a-product-id", headers, payload: { expectedRevision: 1 } });
    expect(invalid.statusCode).toBe(404);
    expect(invalid.json()).toEqual({ error: "manual_product_not_found", detail: "未找到该人工处理商品" });
    const missing = await app.inject({ method: "DELETE", url: "/api/manual-products/00000000-0000-4000-8000-000000000000", headers, payload: { expectedRevision: 1 } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "manual_product_not_found", detail: "未找到该人工处理商品" });
    const list = await app.inject({ method: "GET", url: "/api/manual-products", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(list.json()).toMatchObject({ catalogRevision: 1, total: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM operation_audit WHERE event_type = 'manual_product_removed'").get()).toEqual({ count: 0 });
  });

  it("rolls back an existing product removal and its hold release when removal audit fails", async () => {
    const repository = new ManualProductRepository(database);
    const product = repository.upsert({ itemId: "delete-rollback", title: "删除回滚商品" }, "manual", 1).product;
    const replies = new ReplyRepository(database);
    const draft = replies.discover({
      sourceKey: "delete-audit-rollback-hold",
      orderId: null,
      review: "一般",
      product: "删除回滚商品",
      reviewedAt: "2026-07-15 08:00",
      sentimentLabel: "negative",
      itemId: null,
      reviewPhase: "initial",
    });
    replies.markManualProductHold(draft.id, {
      storeId: "primary",
      manualProductId: product.id,
      catalogRevision: repository.revision(),
      matchKind: "item_id",
      reason: "人工处理商品",
    });
    const before = snapshotManualCatalogMutationTables(database);
    database.prepare(`
      CREATE TRIGGER fail_remove_audit BEFORE INSERT ON operation_audit
      WHEN NEW.event_type = 'manual_product_removed'
      BEGIN SELECT RAISE(ABORT, 'private remove audit'); END
    `).run();
    const response = await app.inject({
      method: "DELETE", url: `/api/manual-products/${product.id}`,
      headers: { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}`, "content-type": "application/json" },
      payload: { expectedRevision: 2 },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "manual_product_remove_failed", detail: "商品移除失败，请稍后重试" });
    expect(snapshotManualCatalogMutationTables(database)).toEqual(before);
    database.prepare("DROP TRIGGER fail_remove_audit").run();
  });

  it("restores scope and plan after restart while invalidating the old process preview", async () => {
    await app.close();
    const directory = await mkdtemp(join(tmpdir(), "tmall-task5-"));
    const databasePath = join(directory, "app.sqlite");
    const fixedNow = new Date("2026-07-15T00:30:00.000Z");
    const firstDatabase = openDatabase(databasePath);
    const first = buildApp({ host, origin, sessionToken: "first-session", csrfToken, database: firstDatabase, now: () => fixedNow });
    await first.ready();
    const firstBootstrap = await first.inject({ method: "GET", url: "/api/bootstrap", headers: { host } });
    const firstCookie = firstBootstrap.cookies[0]!.value;
    const firstHeaders = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${firstCookie}`, "content-type": "application/json" };
    await first.inject({ method: "PUT", url: "/api/review-scope", headers: firstHeaders, payload: { preset: "yesterday", expectedRevision: 1 } });
    await first.inject({ method: "PUT", url: "/api/automation-plan", headers: firstHeaders, payload: { enabled: false, intervalMinutes: 30, windows: [{ id: "morning", start: "08:00", end: "09:00" }], expectedRevision: 1 } });
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Sheet1").addRows([["商品ID", "商品标题"], ["restart-item", "重启前商品"]]);
    const boundary = "----restart-boundary";
    const preview = await first.inject({
      method: "POST", url: "/api/manual-products/import/preview",
      headers: { ...firstHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: buildMultipart(boundary, [{ name: "file", filename: "products.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: Buffer.from(await workbook.xlsx.writeBuffer()) }]),
    });
    const oldPreviewId = preview.json().previewId as string;
    await first.close();

    const secondDatabase = openDatabase(databasePath);
    const second = buildApp({ host, origin, sessionToken: "second-session", csrfToken, database: secondDatabase, now: () => fixedNow });
    app = second;
    await second.ready();
    const secondBootstrap = await second.inject({ method: "GET", url: "/api/bootstrap", headers: { host } });
    const secondCookie = secondBootstrap.cookies[0]!.value;
    const readHeaders = { host, cookie: `tmall_console_session=${secondCookie}` };
    expect((await second.inject({ method: "GET", url: "/api/review-scope", headers: readHeaders })).json()).toMatchObject({ preset: "yesterday", revision: 2, effectiveStartDate: "2026-07-14" });
    expect((await second.inject({ method: "GET", url: "/api/automation-plan", headers: readHeaders })).json()).toMatchObject({ revision: 2, intervalMinutes: 30, windows: [{ id: "morning" }] });
    const stalePreview = await second.inject({
      method: "POST", url: "/api/manual-products/import/apply",
      headers: { ...readHeaders, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, "content-type": "application/json" },
      payload: { previewId: oldPreviewId },
    });
    expect(stalePreview.statusCode).toBe(410);
    await second.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("exposes persisted locator health and approval actions without engineering-only labels", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const health = await app.inject({ method: "GET", url: "/api/element-health", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(health.statusCode).toBe(200);
    expect(health.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ operationKey: "reply.submit", statusLabel: "正常" })]));
    expect(health.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operationKey: "complaint.type",
        health: "healthy",
        verificationState: "conditional",
        statusLabel: "运行时自动检测",
      }),
      expect.objectContaining({
        operationKey: "complaint.description",
        health: "healthy",
        verificationState: "conditional",
        statusLabel: "运行时自动检测",
      }),
      expect.objectContaining({
        operationKey: "complaint.submit",
        health: "healthy",
        verificationState: "conditional",
        statusLabel: "运行时自动检测",
      }),
    ]));

    const repairs = await app.inject({ method: "GET", url: "/api/locator-repairs", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(repairs.statusCode).toBe(200);
    expect(repairs.json()).toMatchObject({ items: [], total: 0 });

    const missing = await app.inject({ method: "POST", url: "/api/locator-repairs/missing/approve", headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "locator_repair_not_found" });
  });

  it("returns an explicit invalid_csrf error for an expired mutation token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tmall-auth/credentials/prepare",
      headers: {
        host,
        origin,
        "sec-fetch-site": "same-origin",
        "x-csrf-token": "expired-token",
        cookie: `tmall_console_session=${cookie}`,
      },
      payload: { action: "replace" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "invalid_csrf" });
  });

  it("persists and controls a multi-window automation plan through the formal API", async () => {
    now = new Date("2026-07-15T02:30:00.000Z");
    const mutationHeaders = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const jsonHeaders = { ...mutationHeaders, "content-type": "application/json" };
    const initial = await app.inject({ method: "GET", url: "/api/automation-plan", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(initial.json()).toMatchObject({ enabled: false, paused: false, timezone: "Asia/Shanghai", intervalMinutes: 15, windows: [] });

    const saved = await app.inject({
      method: "PUT",
      url: "/api/automation-plan",
      headers: jsonHeaders,
      payload: { enabled: true, intervalMinutes: 20, windows: [{ id: "morning", start: "08:00", end: "09:00" }, { id: "evening", start: "23:00", end: "23:30" }], expectedRevision: 1 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ enabled: true, intervalMinutes: 20, windows: [{ id: "morning" }, { id: "evening" }] });

    expect((await app.inject({ method: "POST", url: "/api/automation/pause", headers: mutationHeaders })).json()).toMatchObject({ state: "paused" });
    const editedWhilePaused = await app.inject({
      method: "PUT",
      url: "/api/automation-plan",
      headers: jsonHeaders,
      payload: { enabled: true, intervalMinutes: 25, windows: [{ id: "morning", start: "08:00", end: "09:30" }], expectedRevision: 3 },
    });
    expect(editedWhilePaused.json()).toMatchObject({ enabled: true, paused: true, intervalMinutes: 25 });
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers: mutationHeaders })).json()).toMatchObject({ state: "paused" });
    expect((await app.inject({ method: "POST", url: "/api/automation/resume", headers: mutationHeaders })).json()).toMatchObject({ state: "waiting" });
    expect((await app.inject({ method: "POST", url: "/api/automation/stop", headers: mutationHeaders })).json()).toMatchObject({ state: "disabled" });
    expect((await app.inject({ method: "GET", url: "/api/automation-plan", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json()).toMatchObject({ enabled: false });
  });

  it("reports every formal activation preflight check in user-facing language", async () => {
    const response = await app.inject({ method: "GET", url: "/api/automation/preflight", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ready: true });
    expect(response.json().checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "tmall", label: "淘宝商家账号", ready: true }),
      expect.objectContaining({ key: "good_templates", label: "好评话术库", ready: true }),
      expect.objectContaining({ key: "bad_templates", label: "差评话术库", ready: true }),
      expect.objectContaining({ key: "deepseek", label: "DeepSeek", ready: true }),
      expect.objectContaining({ key: "browser", label: "自动回复浏览器", ready: true }),
      expect.objectContaining({ key: "database", label: "本地数据", ready: true }),
    ]));
    expect(response.json().checks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "elements" }),
    ]));
  });

  it("deletes a never-submitted local reply record so the same review can be discovered again", async () => {
    const snapshot: TmallReviewSnapshot = {
      sourceKey: "tmall:reopen:local-failure",
      orderId: "reopen-order",
      review: "客服能不能专业点",
      product: "测试商品",
      reviewedAt: "2026-07-14 08:00",
      sentimentLabel: "negative",
      itemId: "reopen-item",
      reviewPhase: "initial",
    };
    const replies = new ReplyRepository(database);
    const draft = replies.discover(snapshot);
    database.prepare("UPDATE reply_drafts SET state = 'read_only_ready' WHERE id = ?").run(draft.id);
    const attempts = new ReplyAttemptRepository(database);
    const attempt = attempts.prepare(draft.id, snapshot.sourceKey).attempt;
    attempts.markSkipped(attempt.id, "REPLY_CONTROL_NOT_FOUND", "平台回复按钮未找到，尚未提交");

    const response = await app.inject({
      method: "DELETE",
      url: `/api/replies/${draft.id}`,
      headers: { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ removed: true, mode: "reprocess", reprocessable: true });
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_drafts WHERE source_key = ?").get(snapshot.sourceKey)).toEqual({ value: 0 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_attempts WHERE source_key = ?").get(snapshot.sourceKey)).toEqual({ value: 0 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM complaint_cases WHERE source_key = ?").get(snapshot.sourceKey)).toEqual({ value: 0 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM review_action_locks WHERE source_key = ?").get(snapshot.sourceKey)).toEqual({ value: 0 });
    expect(replies.discover(snapshot)).toMatchObject({ created: true });
  });

  it("cleans a sent reply to its tombstone but refuses to delete an uncertain submission", async () => {
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const createReady = (sourceKey: string) => {
      const draft = replies.discover({
        sourceKey, orderId: sourceKey, review: "很好", product: "测试商品",
        reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: sourceKey, reviewPhase: "initial",
      });
      database.prepare("UPDATE reply_drafts SET state = 'read_only_ready' WHERE id = ?").run(draft.id);
      return draft;
    };
    const sent = createReady("tmall:reopen:sent");
    const sentAttempt = attempts.prepare(sent.id, "tmall:reopen:sent").attempt;
    attempts.markSubmitting(sentAttempt.id);
    attempts.markSent(sentAttempt.id, "platform-success");
    const uncertain = createReady("tmall:reopen:uncertain");
    const uncertainAttempt = attempts.prepare(uncertain.id, "tmall:reopen:uncertain").attempt;
    attempts.markSubmitting(uncertainAttempt.id);
    attempts.markUncertain(uncertainAttempt.id, "platform-result-unknown");

    const sentResponse = await app.inject({
      method: "DELETE",
      url: `/api/replies/${sent.id}`,
      headers: { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` },
    });
    expect(sentResponse.statusCode).toBe(200);
    expect(sentResponse.json()).toMatchObject({ removed: true, mode: "completed", reprocessable: false });
    expect(replies.get(sent.id)).toBeNull();
    expect(database.prepare("SELECT terminal_action FROM review_action_tombstones WHERE source_key = ?").get("tmall:reopen:sent"))
      .toEqual({ terminal_action: "reply_sent" });

    const uncertainResponse = await app.inject({
      method: "DELETE",
      url: `/api/replies/${uncertain.id}`,
      headers: { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` },
    });
    expect(uncertainResponse.statusCode).toBe(409);
    expect(uncertainResponse.json()).toMatchObject({ error: "submission_uncertain" });
    expect(replies.get(uncertain.id)).toMatchObject({ state: "submission_uncertain" });
  });

  it("shows lifecycle counts and rejects unknown cleanup categories", async () => {
    const response = await app.inject({ method: "GET", url: "/api/storage", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      counts: {
        reviews: 0,
        submissionAudit: 0,
        manualProducts: 0,
        manualHolds: 0,
        actionTombstones: 0,
        complaintCases: 0,
        complaintAttempts: 0,
        complaintEvents: 0,
        complaintUnresolved: 0,
        locatorRepairs: 0,
        runs: 0,
        templateVersions: 2,
      },
    });
    expect(response.json().lastCleanupAt).toEqual(expect.any(String));
    expect(response.json().nextCleanupAt).toEqual(expect.any(String));

    const unknown = await app.inject({
      method: "DELETE",
      url: "/api/storage/unknown",
      headers: { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ detail: "没有可清理的数据类型" });
  });

  it("requires a dedicated one-time confirmation before factory reset", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const products = new ManualProductRepository(database);
    products.upsert({ itemId: "factory-reset-product", title: "Factory reset product" }, "manual", products.revision());
    const complaints = new ComplaintRepository(database);
    const complaint = complaints.discover("primary", "factory-reset-complaint", {
      reviewId: "factory-reset-review", contentHash: "f".repeat(64), canonicalizerVersion: "canonical-v1", phase: "initial", imagePairs: [],
      promptVersion: "p1", ruleVersion: "r1", mappingVersion: "m1", visualVersion: "visual-v1", platformMappingVersion: "platform-v1", modelVersion: "model-v1",
    });
    database.prepare(`
      INSERT INTO complaint_attempts(
        id, complaint_case_id, store_id, source_key, state, action_lock_version,
        intent_saved_at, created_at, updated_at
      ) VALUES (?, ?, 'primary', 'factory-reset-complaint', 'intent_saved', 1, ?, ?, ?)
    `).run("factory-reset-complaint-attempt", complaint.id, now.toISOString(), now.toISOString(), now.toISOString());
    database.prepare(`
      UPDATE review_scope
      SET preset = 'custom', custom_start_date = '2026-07-01', custom_end_date = '2026-07-14', revision = 2
      WHERE id = 1
    `).run();
    const prepared = await app.inject({ method: "POST", url: "/api/storage/factory-reset/prepare", headers });
    expect(prepared.statusCode).toBe(200);
    const reset = await app.inject({ method: "POST", url: "/api/storage/factory-reset", headers: { ...headers, "content-type": "application/json" }, payload: { nonce: prepared.json().nonce } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ reset: true, storage: { counts: {
      reviews: 0, submissionAudit: 0, complaintCases: 0, complaintAttempts: 0, complaintEvents: 0, complaintUnresolved: 0,
      locatorRepairs: 0, runs: 0, templateVersions: 0,
    } } });
    for (const table of ["complaint_cases", "complaint_attempts", "complaint_events"]) {
      expect(database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get()).toEqual({ value: 0 });
    }
    expect((await app.inject({ method: "GET", url: "/api/tmall-auth/status", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json()).toMatchObject({ configured: false });
    expect((await app.inject({ method: "GET", url: "/api/manual-products", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json()).toMatchObject({ total: 0, catalogRevision: 1 });
    expect((await app.inject({ method: "GET", url: "/api/review-scope", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json()).toMatchObject({ preset: "last7", revision: 1 });

    const replay = await app.inject({ method: "POST", url: "/api/storage/factory-reset", headers: { ...headers, "content-type": "application/json" }, payload: { nonce: prepared.json().nonce } });
    expect(replay.statusCode).toBe(409);
  });

  it("returns a Chinese validation error for overlapping automation windows", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const response = await app.inject({
      method: "PUT",
      url: "/api/automation-plan",
      headers,
      payload: { enabled: true, intervalMinutes: 15, windows: [{ id: "a", start: "08:00", end: "10:00" }, { id: "b", start: "09:00", end: "11:00" }], expectedRevision: 1 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_automation_plan", detail: "时间段不能重叠" });
  });

  it("keeps a validated active Feishu template usable after the latest sync fails and exposes only a safe warning", async () => {
    const templates = new TemplateRepository(database);
    templates.recordTestResult("good", false, "UPSTREAM_503", "https://private.example/token=should-never-leak");
    const headers = { host, cookie: `tmall_console_session=${cookie}` };

    const preflight = await app.inject({ method: "GET", url: "/api/automation/preflight", headers });
    expect(preflight.statusCode).toBe(200);
    expect(preflight.json()).toMatchObject({ ready: true });
    expect(preflight.json().checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "good_templates", ready: true }),
    ]));

    const health = await app.inject({ method: "GET", url: "/api/template-sources/health", headers });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          library: "good",
          state: "usable_with_warning",
          usable: true,
          activeVersion: expect.any(Number),
          categoryCount: 1,
          replyCount: 1,
          warning: "最近一次同步未完成，当前仍使用已验证的话术版本",
        }),
      ]),
    });
    expect(health.body).not.toContain("private.example");
    expect(health.body).not.toContain("should-never-leak");
    expect(health.body).not.toMatch(/app_token|table_id|last_error/iu);
  });

  it("does not process an imported AI retry when the live Tmall page is empty", async () => {
    const replies = new ReplyRepository(database);
    const retry = replies.discover({
      sourceKey: "tmall:due-ai-retry:one",
      orderId: "due-ai-retry-one",
      review: "The sound quality is very good.",
      product: "Retry product",
      reviewedAt: "2026-07-14 08:00",
      sentimentLabel: "positive",
      itemId: "due-ai-retry-item",
      reviewPhase: "initial",
    });
    replies.recordAiRetryRoundFailure(retry.id, {
      failedStage: "classification",
      errorKind: "network",
      nextRetryAt: new Date(now),
      at: new Date(now),
    });
    tmallQueueEmpty = true;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(tmallSubmitCount).toBe(0);
    expect(replies.get(retry.id)).toMatchObject({ state: "retry_wait" });
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_attempts WHERE source_key = ?").get("tmall:due-ai-retry:one")).toEqual({ value: 0 });
  });

  it("resumes an imported AI retry only after the live Tmall page observes the same review", async () => {
    const replies = new ReplyRepository(database);
    const liveSnapshot: TmallReviewSnapshot = {
      sourceKey: "tmall:observed-ai-retry:one",
      orderId: "observed-ai-retry-one",
      review: "The sound quality is very good.",
      product: "Retry product",
      reviewedAt: "2026-07-14 08:00",
      sentimentLabel: "positive",
      itemId: "observed-ai-retry-item",
      reviewPhase: "initial",
    };
    const retry = replies.discover(liveSnapshot);
    replies.recordAiRetryRoundFailure(retry.id, {
      failedStage: "classification",
      errorKind: "network",
      nextRetryAt: new Date(now),
      at: new Date(now),
    });
    tmallSnapshots = [liveSnapshot];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(tmallSubmitCount).toBe(1);
    expect(replies.get(retry.id)).toMatchObject({ state: "sent" });
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_attempts WHERE source_key = ?").get(liveSnapshot.sourceKey)).toEqual({ value: 1 });
  });

  it("does not drain a batch of imported retries when none are visible on the live page", async () => {
    const replies = new ReplyRepository(database);
    for (let index = 0; index < 26; index += 1) {
      const retry = replies.discover({
        sourceKey: `tmall:due-ai-retry:batch:${index}`,
        orderId: `due-ai-retry-batch-${index}`,
        review: "The sound quality is very good.",
        product: "Retry product",
        reviewedAt: "2026-07-14 08:00",
        sentimentLabel: "positive",
        itemId: `due-ai-retry-batch-${index}`,
        reviewPhase: "initial",
      });
      replies.recordAiRetryRoundFailure(retry.id, {
        failedStage: "classification", errorKind: "network", nextRetryAt: new Date(now), at: new Date(now),
      });
    }
    tmallQueueEmpty = true;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(tmallSubmitCount).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_drafts WHERE state = 'retry_wait'").get()).toEqual({ value: 26 });
  });

  it("does not let an unseen imported retry outside the frozen range block the live-page run", async () => {
    const replies = new ReplyRepository(database);
    const retry = replies.discover({
      sourceKey: "tmall:due-ai-retry:outside-scope", orderId: "outside-scope", review: "The sound quality is very good.",
      product: "Retry product", reviewedAt: "2026-07-01 08:00", sentimentLabel: "positive", itemId: "outside-scope", reviewPhase: "initial",
    });
    replies.recordAiRetryRoundFailure(retry.id, {
      failedStage: "classification", errorKind: "network", nextRetryAt: new Date(now), at: new Date(now),
    });
    tmallQueueEmpty = true;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
    expect(status).not.toMatchObject({ state: "manual_action_required" });
    expect(tmallSubmitCount).toBe(0);
    expect(replies.get(retry.id)).toMatchObject({ state: "retry_wait" });
  });

  it("continues to the next review when complaint handling is deferred", async () => {
    complaintDecisionResolver = async (draft) => draft.sourceKey === "tmall:complaint-deferred"
      ? { action: "manual_action_required", caseId: "complaint-case-deferred", caseState: "prepared" }
      : { action: "reply", caseId: draft.id, caseState: "no_complaint" };
    tmallSnapshots = [
      {
        sourceKey: "tmall:complaint-deferred",
        orderId: "complaint-deferred",
        review: "加微信购买课程",
        product: "测试耳机",
        reviewedAt: "2026-07-14 08:00",
        sentimentLabel: "positive",
        itemId: "complaint-deferred",
        reviewPhase: "initial",
      },
      {
        sourceKey: "tmall:reply-after-deferred-complaint",
        orderId: "reply-after-deferred-complaint",
        review: "音质很好，连接也很快",
        product: "测试耳机",
        reviewedAt: "2026-07-14 08:01",
        sentimentLabel: "positive",
        itemId: "reply-after-deferred-complaint",
        reviewPhase: "initial",
      },
    ];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", currentStep: "" };
    for (let attempt = 0; attempt < 120 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
    }

    expect(status.state).not.toBe("manual_action_required");
    expect(tmallSubmitCount).toBe(1);
    expect(new ReplyRepository(database).getBySourceKey("tmall:reply-after-deferred-complaint")).toMatchObject({ state: "sent" });
  });

  it("continues to the next review when complaint analysis fails for one review", async () => {
    complaintDecisionResolver = async (draft) => draft.sourceKey === "tmall:complaint-analysis-failed"
      ? { action: "error", caseId: "complaint-case-failed", caseState: "failed" }
      : { action: "reply", caseId: draft.id, caseState: "no_complaint" };
    tmallSnapshots = [
      {
        sourceKey: "tmall:complaint-analysis-failed",
        orderId: "complaint-analysis-failed",
        review: "加微信购买课程",
        product: "测试耳机",
        reviewedAt: "2026-07-14 08:00",
        sentimentLabel: "positive",
        itemId: "complaint-analysis-failed",
        reviewPhase: "initial",
      },
      {
        sourceKey: "tmall:reply-after-complaint-analysis-failure",
        orderId: "reply-after-complaint-analysis-failure",
        review: "音质很好，连接也很稳定",
        product: "测试耳机",
        reviewedAt: "2026-07-14 08:01",
        sentimentLabel: "positive",
        itemId: "reply-after-complaint-analysis-failure",
        reviewPhase: "initial",
      },
    ];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running" };
    for (let attempt = 0; attempt < 180 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
    }

    expect(status.state).not.toBe("manual_action_required");
    expect(tmallSubmitCount).toBe(1);
    expect(new ReplyRepository(database).getBySourceKey("tmall:reply-after-complaint-analysis-failure"))
      .toMatchObject({ state: "sent" });
  });

  it("ignores action-locked and tombstoned AI retry diagnostics without releasing their protection", async () => {
    const replies = new ReplyRepository(database);
    const gate = new ReviewActionGate(database);
    const locked = replies.discover({
      sourceKey: "tmall:locked-ai-circuit", orderId: "locked-ai-circuit", review: "The sound quality is very good.",
      product: "Retry product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "locked-ai-circuit", reviewPhase: "initial",
    });
    const tombstoned = replies.discover({
      sourceKey: "tmall:tombstoned-ai-circuit", orderId: "tombstoned-ai-circuit", review: "The sound quality is very good.",
      product: "Retry product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "tombstoned-ai-circuit", reviewPhase: "initial",
    });
    for (const draft of [locked, tombstoned]) {
      database.prepare(`
        UPDATE reply_drafts
        SET state = 'retry_wait', failed_stage = 'classification', ai_retry_error_kind = 'network',
            next_retry_at = ?, consecutive_ai_failure_rounds = 3
        WHERE id = ?
      `).run(now.toISOString(), draft.id);
    }
    gate.acquire("primary", "tmall:locked-ai-circuit", "complaint");
    const tombstoneLock = gate.acquire("primary", "tmall:tombstoned-ai-circuit", "complaint");
    gate.complete("primary", "tmall:tombstoned-ai-circuit", "complaint", tombstoneLock.lockVersion, "complaint_upheld", now);
    tmallQueueEmpty = true;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    const health = await app.inject({ method: "POST", url: "/api/connections/deepseek/test", headers });
    expect(health.statusCode).toBe(200);
    expect(replies.get(locked.id)).toMatchObject({ consecutiveAiFailureRounds: 3 });
    expect(replies.get(tombstoned.id)).toMatchObject({ consecutiveAiFailureRounds: 3 });
    expect(gate.getLock("primary", "tmall:locked-ai-circuit")).toMatchObject({ actionKind: "complaint" });
    expect(gate.getTombstone("primary", "tmall:tombstoned-ai-circuit")).toMatchObject({ terminalAction: "complaint_upheld" });
  });

  it("does not let an action-locked out-of-scope AI retry block the current run", async () => {
    const replies = new ReplyRepository(database);
    const sourceKey = "tmall:locked-outside-scope-ai-retry";
    const retry = replies.discover({
      sourceKey, orderId: "locked-outside-scope", review: "The sound quality is very good.",
      product: "Retry product", reviewedAt: "2026-07-01 08:00", sentimentLabel: "positive", itemId: "locked-outside-scope", reviewPhase: "initial",
    });
    replies.recordAiRetryRoundFailure(retry.id, {
      failedStage: "classification", errorKind: "network", nextRetryAt: new Date(now), at: new Date(now),
    });
    new ReviewActionGate(database).acquire("primary", sourceKey, "complaint");
    tmallQueueEmpty = true;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).not.toMatchObject({ state: "manual_action_required" });
  });

  it("does not let an unseen imported AI retry circuit block a live-page run", async () => {
    const replies = new ReplyRepository(database);
    const retry = replies.discover({
      sourceKey: "tmall:ai-circuit-open", orderId: "ai-circuit-open", review: "The sound quality is very good.",
      product: "Retry product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "ai-circuit-open", reviewPhase: "initial",
    });
    database.prepare(`
      UPDATE reply_drafts
      SET state = 'retry_wait', failed_stage = 'classification', ai_retry_error_kind = 'network',
          next_retry_at = ?, consecutive_ai_failure_rounds = 3
      WHERE id = ?
    `).run(now.toISOString(), retry.id);
    tmallQueueEmpty = true;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const response = await app.inject({ method: "POST", url: "/api/automation/start-now", headers });
    expect(response.statusCode).toBe(200);
    expect(tmallSubmitCount).toBe(0);
    expect(replies.get(retry.id)).toMatchObject({ state: "retry_wait", consecutiveAiFailureRounds: 3 });
  });

  it("resets a network retry circuit after an explicit successful DeepSeek health check", async () => {
    const replies = new ReplyRepository(database);
    const retry = replies.discover({
      sourceKey: "tmall:ai-circuit-health-recovery", orderId: "ai-circuit-health-recovery", review: "The sound quality is very good.",
      product: "Retry product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "ai-circuit-health-recovery", reviewPhase: "initial",
    });
    database.prepare(`
      UPDATE reply_drafts
      SET state = 'retry_wait', failed_stage = 'classification', ai_retry_error_kind = 'network',
          next_retry_at = ?, consecutive_ai_failure_rounds = 3
      WHERE id = ?
    `).run(now.toISOString(), retry.id);
    tmallQueueEmpty = true;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    const health = await app.inject({ method: "POST", url: "/api/connections/deepseek/test", headers });
    expect(health.statusCode).toBe(200);
    expect(replies.get(retry.id)).toMatchObject({ state: "retry_wait", consecutiveAiFailureRounds: 0, nextRetryAt: now.toISOString() });
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
  });

  it("keeps a model-contract retry unchanged without letting it block a live-page run", async () => {
    const replies = new ReplyRepository(database);
    const retry = replies.discover({
      sourceKey: "tmall:ai-circuit-contract", orderId: "ai-circuit-contract", review: "The sound quality is very good.",
      product: "Retry product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "ai-circuit-contract", reviewPhase: "initial",
    });
    database.prepare(`
      UPDATE reply_drafts
      SET state = 'retry_wait', failed_stage = 'classification', ai_retry_error_kind = 'model_contract',
          next_retry_at = ?, consecutive_ai_failure_rounds = 3
      WHERE id = ?
    `).run(now.toISOString(), retry.id);
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/connections/deepseek/test", headers })).statusCode).toBe(200);
    expect(replies.get(retry.id)).toMatchObject({ state: "retry_wait", aiRetryErrorKind: "model_contract", consecutiveAiFailureRounds: 3 });
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
  });

  it("cannot resume a plan after stop has disabled it", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/stop", headers })).statusCode).toBe(200);
    const resumed = await app.inject({ method: "POST", url: "/api/automation/resume", headers });
    expect(resumed.statusCode).toBe(409);
    expect(resumed.json()).toEqual({ error: "automation_not_paused", detail: "当前任务未处于暂停状态，不能继续处理" });
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "disabled", plan: { enabled: false } });
    expect(tmallSubmitCount).toBe(0);
  });

  it("rejects a stale pause after stop without changing the disabled plan", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/stop", headers })).statusCode).toBe(200);
    const stalePause = await app.inject({ method: "POST", url: "/api/automation/pause", headers });

    expect(stalePause.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "disabled", plan: { enabled: false, paused: false } });
  });

  it("rechecks a manual-action state without using paused resume or bypassing an unresolved login", async () => {
    tmallAuthFailure = "Manual verification is still required";
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "manual_action_required" });

    const unresolved = await app.inject({ method: "POST", url: "/api/automation/recheck-and-continue", headers });
    expect(unresolved.statusCode).toBe(200);
    expect(unresolved.json()).toMatchObject({ state: "manual_action_required" });
    expect(tmallOpenCount).toBe(1);
    expect(tmallContinueCount).toBe(1);
    expect(tmallContinueCredentials).toEqual({ account: "test-merchant", password: "test-password" });
    expect(tmallSubmitCount).toBe(0);

    tmallAuthFailure = null;
    tmallQueueEmpty = true;
    const resumed = await app.inject({ method: "POST", url: "/api/automation/recheck-and-continue", headers });
    expect(resumed.statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).not.toMatchObject({ state: "manual_action_required" });
    expect(tmallOpenCount).toBe(2);
    expect(tmallContinueCount).toBe(2);
    expect(tmallSubmitCount).toBe(0);
  });

  it("rejects an explicit Tmall check while a manual recheck owns the browser page", async () => {
    tmallAuthFailure = "Manual verification is still required";
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "manual_action_required" });

    tmallAuthFailure = null;
    tmallQueueEmpty = true;
    tmallOpenGate = deferred<void>();
    const recheck = app.inject({ method: "POST", url: "/api/automation/recheck-and-continue", headers });
    for (let attempt = 0; attempt < 100 && tmallContinueCount < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(tmallContinueCount).toBe(1);
    const auth = app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const opensWhileRechecking = tmallOpenCount;
    tmallOpenGate.resolve();

    expect(opensWhileRechecking).toBe(1);
    expect((await auth).statusCode).toBe(409);
    expect((await recheck).statusCode).toBe(200);
  });

  it("rejects a second manual recheck while the first recheck owns the browser page", async () => {
    tmallAuthFailure = "Manual verification is still required";
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "manual_action_required" });

    tmallAuthFailure = null;
    tmallQueueEmpty = true;
    tmallOpenGate = deferred<void>();
    const firstRecheck = app.inject({ method: "POST", url: "/api/automation/recheck-and-continue", headers });
    for (let attempt = 0; attempt < 100 && tmallContinueCount < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(tmallContinueCount).toBe(1);
    const secondRecheck = app.inject({ method: "POST", url: "/api/automation/recheck-and-continue", headers });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const opensWhileRechecking = tmallOpenCount;
    tmallOpenGate.resolve();

    expect(opensWhileRechecking).toBe(1);
    expect((await secondRecheck).statusCode).toBe(409);
    expect((await firstRecheck).statusCode).toBe(200);
  });

  it("lets recheck-and-continue immediately process a safely queued retry without waiting for its next retry time", async () => {
    tmallAuthFailure = "Manual verification is still required";
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const replies = new ReplyRepository(database);
    const retry = replies.discover({
      sourceKey: "tmall:manual-recheck-immediate-retry", orderId: "manual-recheck-immediate-retry", review: "The sound quality is very good.",
      product: "Retry product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "manual-recheck-immediate-retry", reviewPhase: "initial",
    });
    replies.recordAiRetryRoundFailure(retry.id, {
      failedStage: "classification", errorKind: "network", nextRetryAt: new Date(now.getTime() + 5 * 60_000), at: new Date(now),
    });
    tmallAuthFailure = null;
    tmallQueueEmpty = false;
    tmallSnapshots = [{
      sourceKey: "tmall:manual-recheck-immediate-retry", orderId: "manual-recheck-immediate-retry", review: "The sound quality is very good.",
      product: "Retry product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "manual-recheck-immediate-retry", reviewPhase: "initial",
    }];

    expect((await app.inject({ method: "POST", url: "/api/automation/recheck-and-continue", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && tmallSubmitCount === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tmallSubmitCount).toBe(1);
    expect(replies.get(retry.id)).toMatchObject({ state: "sent" });
  });

  it("does not open a reply box just to verify high-risk reply controls", async () => {
    tmallMissingElements = ["reply.submit"];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "disabled" });
    expect(tmallVerifyReplyControls).not.toContain(true);
    expect(tmallSubmitCount).toBe(1);
  });

  it("does not run a separate runtime element verification before submitting", async () => {
    tmallMissingElementSequence = [["reply.submit"], []];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 150 && tmallSubmitCount === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(tmallVerifyReplyControls).toEqual([]);
    expect(tmallSubmitCount).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "disabled" });
  });

  it("does not restart automation when stop wins a concurrent recheck-and-continue", async () => {
    tmallAuthFailure = "Manual verification is still required";
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "manual_action_required" });

    tmallAuthFailure = null;
    tmallOpenGate = deferred<void>();
    const recheck = app.inject({ method: "POST", url: "/api/automation/recheck-and-continue", headers });
    for (let attempt = 0; attempt < 100 && tmallContinueCount < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(tmallContinueCount).toBe(1);
    expect((await app.inject({ method: "POST", url: "/api/automation/stop", headers })).statusCode).toBe(200);
    tmallOpenGate.resolve();

    expect((await recheck).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "disabled", plan: { enabled: false } });
    expect(tmallOpenCount).toBe(1);
    expect(tmallSubmitCount).toBe(0);
  });

  it("does not launch a stale scheduled recheck after stop wins its deferred preflight", async () => {
    tmallAuthFailure = "Manual verification is still required";
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({
      method: "PUT", url: "/api/automation-plan", headers: { ...headers, "content-type": "application/json" },
      payload: { enabled: true, intervalMinutes: 15, windows: [{ id: "current", start: "08:00", end: "09:00" }], expectedRevision: 1 },
    })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running" && status.state !== "waiting") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "manual_action_required" });

    tmallAuthFailure = null;
    tmallQueueEmpty = true;
    const runsBefore = (database.prepare("SELECT COUNT(*) AS value FROM automation_runs").get() as { value: number }).value;
    runtimeReadinessGate = deferred<void>();
    runtimeReadinessGateCall = runtimeReadinessCheckCount + 2;
    const recheck = app.inject({ method: "POST", url: "/api/automation/recheck-and-continue", headers });
    for (let attempt = 0; attempt < 100 && runtimeReadinessCheckCount < runtimeReadinessGateCall; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(tmallOpenCount).toBe(1);
    expect(tmallContinueCount).toBe(1);
    expect(runtimeReadinessCheckCount).toBe(runtimeReadinessGateCall);
    expect((await app.inject({ method: "POST", url: "/api/automation/stop", headers })).statusCode).toBe(200);
    runtimeReadinessGate.resolve();

    expect((await recheck).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "disabled", plan: { enabled: false } });
    expect(database.prepare("SELECT COUNT(*) AS value FROM automation_runs").get()).toEqual({ value: runsBefore });
    expect(tmallSubmitCount).toBe(0);
  });

  it("does not launch a manual start when stop wins its deferred preflight", async () => {
    tmallQueueEmpty = true;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    runtimeReadinessGate = deferred<void>();
    runtimeReadinessGateCall = runtimeReadinessCheckCount + 1;
    const start = app.inject({ method: "POST", url: "/api/automation/start-now", headers });

    for (let attempt = 0; attempt < 100 && runtimeReadinessCheckCount < runtimeReadinessGateCall; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtimeReadinessCheckCount).toBe(runtimeReadinessGateCall);
    expect((await app.inject({ method: "POST", url: "/api/automation/stop", headers })).statusCode).toBe(200);
    runtimeReadinessGate.resolve();

    expect((await start).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "disabled", plan: { enabled: false } });
    expect(database.prepare("SELECT COUNT(*) AS value FROM automation_runs").get()).toEqual({ value: 0 });
    expect(tmallSubmitCount).toBe(0);
  });

  it("rejects a second start immediately while an active run is still processing", async () => {
    tmallQueueEmpty = true;
    tmallOpenGate = deferred<void>();
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && tmallOpenCount === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(tmallOpenCount).toBe(1);

    const secondStart = app.inject({ method: "POST", url: "/api/automation/start-now", headers });
    const earlyResponse = await Promise.race([
      secondStart,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20)),
    ]);
    tmallOpenGate.resolve();
    const response = earlyResponse ?? await secondStart;
    expect(response.statusCode).toBe(409);
    expect(database.prepare("SELECT COUNT(*) AS value FROM automation_runs").get()).toEqual({ value: 1 });
    expect(tmallSubmitCount).toBe(0);
  });

  it("waits for terminal housekeeping and does not relaunch when stop wins while waiting", async () => {
    tmallQueueEmpty = true;
    tmallOpenGate = deferred<void>();
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && tmallOpenCount === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(tmallOpenCount).toBe(1);
    expect((await app.inject({ method: "POST", url: "/api/automation/pause", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/automation/stop", headers })).statusCode).toBe(200);
    const secondStart = app.inject({ method: "POST", url: "/api/automation/start-now", headers });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await app.inject({ method: "POST", url: "/api/automation/stop", headers })).statusCode).toBe(200);
    tmallOpenGate.resolve();

    expect((await secondStart).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state === "disabled") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(database.prepare("SELECT COUNT(*) AS value FROM automation_runs").get()).toEqual({ value: 1 });
    expect(tmallSubmitCount).toBe(0);
  });

  it("does not launch a scheduled run when closing wins its deferred preflight", async () => {
    tmallQueueEmpty = true;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}`, "content-type": "application/json" };
    runtimeReadinessGate = deferred<void>();
    runtimeReadinessGateCall = runtimeReadinessCheckCount + 2;
    const savePlan = app.inject({
      method: "PUT", url: "/api/automation-plan", headers,
      payload: { enabled: true, intervalMinutes: 15, windows: [{ id: "current", start: "08:00", end: "09:00" }], expectedRevision: 1 },
    });

    for (let attempt = 0; attempt < 100 && runtimeReadinessCheckCount < runtimeReadinessGateCall; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtimeReadinessCheckCount).toBe(runtimeReadinessGateCall);
    const closing = app.close();
    runtimeReadinessGate.resolve();
    expect((await savePlan).statusCode).toBe(200);
    await closing;

    expect(tmallOpenCount).toBe(0);
    expect(tmallSubmitCount).toBe(0);
  });

  it("does not launch after a deferred scheduled preflight crosses the window end", async () => {
    tmallQueueEmpty = true;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}`, "content-type": "application/json" };
    runtimeReadinessGate = deferred<void>();
    runtimeReadinessGateCall = runtimeReadinessCheckCount + 2;
    const savePlan = app.inject({
      method: "PUT", url: "/api/automation-plan", headers,
      payload: { enabled: true, intervalMinutes: 15, windows: [{ id: "short", start: "08:00", end: "08:31" }], expectedRevision: 1 },
    });

    for (let attempt = 0; attempt < 100 && runtimeReadinessCheckCount < runtimeReadinessGateCall; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtimeReadinessCheckCount).toBe(runtimeReadinessGateCall);
    now = new Date("2026-07-15T00:31:00.000Z");
    runtimeReadinessGate.resolve();

    expect((await savePlan).statusCode).toBe(200);
    expect(tmallOpenCount).toBe(0);
    expect(tmallSubmitCount).toBe(0);
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "waiting" });
  });

  it("rechecks login and resumes without invoking the removed element verification", async () => {
    tmallAuthFailure = "Manual verification is still required";
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    tmallAuthFailure = null;
    tmallMissingElements = ["review.list"];
    tmallVerificationFailures = [null, new Error("private second verification failure")];

    const recheck = await app.inject({ method: "POST", url: "/api/automation/recheck-and-continue", headers });
    expect(recheck.statusCode).toBe(200);
    expect(recheck.json()).toMatchObject({ state: "running" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(tmallVerifiedScopes).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "disabled" });
  });

  it("keeps manual action with a fixed message when full preflight throws", async () => {
    tmallAuthFailure = "Manual verification is still required";
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    tmallAuthFailure = null;
    tmallQueueEmpty = true;
    runtimeReadinessError = new Error("private readiness provider failure");

    const recheck = await app.inject({ method: "POST", url: "/api/automation/recheck-and-continue", headers });
    expect(recheck.statusCode).toBe(200);
    expect(recheck.json()).toMatchObject({ state: "manual_action_required", currentStep: "系统配置重新检测失败，请稍后再次检测" });
    expect(recheck.body).not.toContain("private readiness provider failure");
    expect(database.prepare(`
      SELECT error_code AS errorCode FROM operation_audit
      WHERE event_type = 'automation_manual_recheck_failed' ORDER BY rowid DESC LIMIT 1
    `).get()).toEqual({ errorCode: "MANUAL_RECHECK_PREFLIGHT_FAILED" });
  });

  it("does not create a submission attempt while a newly processed draft is waiting for its AI retry", async () => {
    deepseekClassificationFailures = 2;
    tmallSnapshots = [{
      sourceKey: "tmall:retry-wait-no-submit",
      orderId: "retry-wait-no-submit",
      review: "The sound quality is very good.",
      product: "Retry wait product",
      reviewedAt: "2026-07-14 08:00",
      sentimentLabel: "positive",
      itemId: "retry-wait-item",
      reviewPhase: "initial",
    }];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const replies = new ReplyRepository(database);
    const draft = replies.list().find((item) => item.sourceKey === "tmall:retry-wait-no-submit");
    expect(draft).toMatchObject({ state: "retry_wait", failedStage: "classification" });
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_attempts WHERE source_key = ?").get("tmall:retry-wait-no-submit")).toEqual({ value: 0 });
    expect(tmallSubmitCount).toBe(0);
  });

  it("lets an explicit immediate run safely process an in-scope retry without waiting for its scheduled backoff", async () => {
    const replies = new ReplyRepository(database);
    const retry = replies.discover({
      sourceKey: "tmall:manual-immediate-retry", orderId: "manual-immediate-retry", review: "The sound quality is very good.",
      product: "Retry product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "manual-immediate-retry", reviewPhase: "initial",
    });
    replies.recordAiRetryRoundFailure(retry.id, {
      failedStage: "classification", errorKind: "network", nextRetryAt: new Date(now.getTime() + 5 * 60_000), at: new Date(now),
    });
    tmallQueueEmpty = false;
    tmallSnapshots = [{
      sourceKey: "tmall:manual-immediate-retry", orderId: "manual-immediate-retry", review: "The sound quality is very good.",
      product: "Retry product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "manual-immediate-retry", reviewPhase: "initial",
    }];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && tmallSubmitCount === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));

    expect(tmallSubmitCount).toBe(1);
    expect(replies.get(retry.id)).toMatchObject({ state: "sent" });
  });

  it("records a third AI failure round and continues with later reviews", async () => {
    const replies = new ReplyRepository(database);
    const retry = replies.discover({
      sourceKey: "tmall:current-run-ai-circuit", orderId: "current-run-ai-circuit", review: "The sound quality is very good.",
      product: "Retry product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "current-run-ai-circuit", reviewPhase: "initial",
    });
    replies.recordAiRetryRoundFailure(retry.id, {
      failedStage: "classification", errorKind: "network", nextRetryAt: new Date(now), at: new Date(now),
    });
    database.prepare("UPDATE reply_drafts SET consecutive_ai_failure_rounds = 2 WHERE id = ?").run(retry.id);
    deepseekClassificationFailures = 2;
    tmallSnapshots = [
      {
        sourceKey: "tmall:current-run-ai-circuit", orderId: "current-run-ai-circuit", review: "The sound quality is very good.",
        product: "Retry product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "current-run-ai-circuit", reviewPhase: "initial",
      },
      {
        sourceKey: "tmall:must-not-run-after-circuit", orderId: "must-not-run-after-circuit", review: "A later review must not be handled.",
        product: "Later product", reviewedAt: "2026-07-14 08:01", sentimentLabel: "positive", itemId: "must-not-run-after-circuit", reviewPhase: "initial",
      },
    ];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", currentStep: "" };
    for (let attempt = 0; attempt < 180 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
    }

    expect(status.state).not.toBe("error");
    expect(deepseekClassificationCalls).toBe(3);
    expect(tmallSubmitCount).toBe(1);
    expect(replies.get(retry.id)).toMatchObject({ state: "retry_wait", consecutiveAiFailureRounds: 3 });
    expect(replies.list().find((item) => item.sourceKey === "tmall:must-not-run-after-circuit")).toMatchObject({ state: "sent" });
  });

  it("keeps a scheduled run in waiting status when AI work is safely requeued", async () => {
    deepseekClassificationFailures = 2;
    tmallSnapshots = [{
      sourceKey: "tmall:scheduled-retry-wait",
      orderId: "scheduled-retry-wait",
      review: "The sound quality is very good.",
      product: "Scheduled retry product",
      reviewedAt: "2026-07-15 08:30",
      sentimentLabel: "positive",
      itemId: "scheduled-retry-item",
      reviewPhase: "initial",
    }];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, "content-type": "application/json", cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({
      method: "PUT",
      url: "/api/automation-plan",
      headers,
      payload: { enabled: true, intervalMinutes: 15, windows: [{ id: "morning", start: "08:00", end: "09:00" }], expectedRevision: 1 },
    })).statusCode).toBe(200);

    let status = { state: "running", currentStep: "" };
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
      if (status.state !== "running") break;
    }

    expect(status).toMatchObject({ state: "waiting", currentStep: "AI 暂时不可用，已安全排队，等待下一次自动重试" });
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_attempts WHERE source_key = ?").get("tmall:scheduled-retry-wait")).toEqual({ value: 0 });
  });

  it("pauses an in-flight AI retry before its second model call and never submits it", async () => {
    deepseekClassificationFailures = 2;
    tmallSnapshots = [{
      sourceKey: "tmall:pause-ai-retry",
      orderId: "pause-ai-retry",
      review: "The sound quality is very good.",
      product: "Pause retry product",
      reviewedAt: "2026-07-14 08:00",
      sentimentLabel: "positive",
      itemId: "pause-retry-item",
      reviewPhase: "initial",
    }];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && deepseekClassificationCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(deepseekClassificationCalls).toBe(1);
    expect((await app.inject({ method: "POST", url: "/api/automation/pause", headers })).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(deepseekClassificationCalls).toBe(1);
    expect(tmallSubmitCount).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_attempts WHERE source_key = ?").get("tmall:pause-ai-retry")).toEqual({ value: 0 });
  });

  it("does not resume a paused run when stop wins its deferred resume preflight", async () => {
    deepseekClassificationFailures = 1;
    tmallSnapshots = [{
      sourceKey: "tmall:resume-stop-race", orderId: "resume-stop-race", review: "The sound quality is very good.",
      product: "Resume race product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive",
      itemId: "resume-stop-race-item", reviewPhase: "initial",
    }];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && deepseekClassificationCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(deepseekClassificationCalls).toBe(1);
    expect((await app.inject({ method: "POST", url: "/api/automation/pause", headers })).statusCode).toBe(200);

    runtimeReadinessGate = deferred<void>();
    runtimeReadinessGateCall = runtimeReadinessCheckCount + 1;
    const resume = app.inject({ method: "POST", url: "/api/automation/resume", headers });
    for (let attempt = 0; attempt < 100 && runtimeReadinessCheckCount < runtimeReadinessGateCall; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtimeReadinessCheckCount).toBe(runtimeReadinessGateCall);
    expect((await app.inject({ method: "POST", url: "/api/automation/stop", headers })).statusCode).toBe(200);
    runtimeReadinessGate.resolve();

    expect((await resume).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "disabled", plan: { enabled: false, paused: false } });
    expect(deepseekClassificationCalls).toBe(1);
    expect(tmallSubmitCount).toBe(0);
  });

  it("does not submit a rewrite result that returns after pause, then safely continues once", async () => {
    tmallSnapshots = [{
      sourceKey: "tmall:pause-rewrite", orderId: "pause-rewrite", review: "The sound quality is very good.",
      product: "Paused rewrite product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive",
      itemId: "pause-rewrite-item", reviewPhase: "initial",
    }];
    deepseekRewriteGate = deferred<void>();
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && deepseekRewriteCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(deepseekRewriteCalls).toBe(1);
    expect((await app.inject({ method: "POST", url: "/api/automation/pause", headers })).statusCode).toBe(200);
    deepseekRewriteGate.resolve();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state === "paused") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(tmallSubmitCount).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_attempts WHERE source_key = ?").get("tmall:pause-rewrite")).toEqual({ value: 0 });

    expect((await app.inject({ method: "POST", url: "/api/automation/resume", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && tmallSubmitCount === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(tmallSubmitCount).toBe(1);
    expect(new ReplyRepository(database).list().find((item) => item.sourceKey === "tmall:pause-rewrite")).toMatchObject({ state: "sent", templateSequence: 1 });
  });

  it("keeps stopping while a submitted reply is awaiting its final delivery evidence", async () => {
    tmallSubmitGate = deferred<void>();
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && tmallSubmitCount === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(tmallSubmitCount).toBe(1);
    expect((await app.inject({ method: "POST", url: "/api/automation/pause", headers })).statusCode).toBe(200);
    const stop = await app.inject({ method: "POST", url: "/api/automation/stop", headers });
    const stopState = stop.json<{ state: string }>().state;
    tmallSubmitGate.resolve();

    expect(stopState).toBe("stopping");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state === "disabled") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "disabled" });
    expect(tmallSubmitCount).toBe(1);
  });

  it("rejects pause after stop while a submitted reply is still awaiting delivery evidence", async () => {
    tmallSubmitGate = deferred<void>();
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && tmallSubmitCount === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(tmallSubmitCount).toBe(1);

    const stopped = await app.inject({ method: "POST", url: "/api/automation/stop", headers });
    expect(stopped.json()).toMatchObject({ state: "stopping", plan: { enabled: false } });
    const paused = await app.inject({ method: "POST", url: "/api/automation/pause", headers });
    const pausedStatus = paused.statusCode;
    const stateWhileStopping = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();

    tmallSubmitGate.resolve();
    expect(pausedStatus).toBe(409);
    expect(stateWhileStopping).toMatchObject({ state: "stopping", plan: { enabled: false, paused: false } });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state === "disabled" || status.state === "manual_action_required") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "disabled" });
    expect(tmallSubmitCount).toBe(1);
  });

  it("closes by finishing only the active review and never starts a later review", async () => {
    tmallSubmitDelayMs = 80;
    tmallSnapshots = [
      {
        sourceKey: "tmall:close-active-first", orderId: "close-active-first", review: "The first review is good.",
        product: "First product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "close-active-first", reviewPhase: "initial",
      },
      {
        sourceKey: "tmall:close-active-later", orderId: "close-active-later", review: "The later review must not start.",
        product: "Later product", reviewedAt: "2026-07-14 08:01", sentimentLabel: "positive", itemId: "close-active-later", reviewPhase: "initial",
      },
    ];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && tmallSubmitCount === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(tmallSubmitCount).toBe(1);

    await expect(Promise.race([
      app.close(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("close did not resolve after the active review")), 1_000)),
    ])).resolves.toBeUndefined();

    expect(deepseekClassificationCalls).toBe(1);
    expect(tmallSubmitCount).toBe(1);
  });

  it("keeps a paused retry paused while closing and never makes its second AI call", async () => {
    deepseekClassificationFailures = 1;
    tmallSnapshots = [{
      sourceKey: "tmall:close-paused-retry", orderId: "close-paused-retry", review: "The sound quality is very good.",
      product: "Close paused retry product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive",
      itemId: "close-paused-retry-item", reviewPhase: "initial",
    }];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && deepseekClassificationCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(deepseekClassificationCalls).toBe(1);
    expect((await app.inject({ method: "POST", url: "/api/automation/pause", headers })).statusCode).toBe(200);

    await expect(Promise.race([
      app.close(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("close did not resolve while paused")), 1_500)),
    ])).resolves.toBeUndefined();
    expect(deepseekClassificationCalls).toBe(1);
    expect(tmallSubmitCount).toBe(0);
  });

  it("stops after the current review completes its bounded AI retry and never starts a later review", async () => {
    deepseekClassificationFailures = 1;
    tmallSnapshots = [
      {
        sourceKey: "tmall:stop-retry-first", orderId: "stop-retry-first", review: "The first review is good.",
        product: "First product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "stop-retry-first", reviewPhase: "initial",
      },
      {
        sourceKey: "tmall:stop-retry-later", orderId: "stop-retry-later", review: "The later review must not start.",
        product: "Later product", reviewedAt: "2026-07-14 08:01", sentimentLabel: "positive", itemId: "stop-retry-later", reviewPhase: "initial",
      },
    ];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && deepseekClassificationCalls === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(deepseekClassificationCalls).toBe(1);
    expect((await app.inject({ method: "POST", url: "/api/automation/stop", headers })).statusCode).toBe(200);

    for (let attempt = 0; attempt < 180; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running" && status.state !== "stopping") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const replies = new ReplyRepository(database);
    expect(deepseekClassificationCalls).toBe(2);
    expect(tmallSubmitCount).toBe(1);
    expect(replies.list().find((item) => item.sourceKey === "tmall:stop-retry-first")).toMatchObject({ state: "sent" });
    expect(replies.list().find((item) => item.sourceKey === "tmall:stop-retry-later")).toBeUndefined();
  });

  it("finishes the active retry at a schedule boundary and does not start a later review", async () => {
    deepseekClassificationFailures = 1;
    tmallSnapshots = [
      {
        sourceKey: "tmall:window-retry-first", orderId: "window-retry-first", review: "The first review is good.",
        product: "First product", reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "window-retry-first", reviewPhase: "initial",
      },
      {
        sourceKey: "tmall:window-retry-later", orderId: "window-retry-later", review: "The later review must not start.",
        product: "Later product", reviewedAt: "2026-07-14 08:01", sentimentLabel: "positive", itemId: "window-retry-later", reviewPhase: "initial",
      },
    ];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, "content-type": "application/json", cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({
      method: "PUT", url: "/api/automation-plan", headers,
      payload: { enabled: true, intervalMinutes: 15, windows: [{ id: "current", start: "08:00", end: "08:31" }], expectedRevision: 1 },
    })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && deepseekClassificationCalls === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(deepseekClassificationCalls).toBe(1);

    now = new Date("2026-07-15T00:31:00.000Z");
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running" && status.state !== "stopping") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const replies = new ReplyRepository(database);
    expect(deepseekClassificationCalls).toBe(2);
    expect(tmallSubmitCount).toBe(1);
    expect(replies.list().find((item) => item.sourceKey === "tmall:window-retry-first")).toMatchObject({ state: "sent" });
    expect(replies.list().find((item) => item.sourceKey === "tmall:window-retry-later")).toBeUndefined();
  });

  it("releases a paused claimed retry so immediate resume can safely continue without waiting for its lease", async () => {
    const replies = new ReplyRepository(database);
    const retry = replies.discover({
      sourceKey: "tmall:pause-claimed-retry",
      orderId: "pause-claimed-retry",
      review: "The sound quality is very good.",
      product: "Paused claimed retry product",
      reviewedAt: "2026-07-14 08:00",
      sentimentLabel: "positive",
      itemId: "pause-claimed-retry-item",
      reviewPhase: "initial",
    });
    replies.recordAiRetryRoundFailure(retry.id, {
      failedStage: "classification",
      errorKind: "network",
      nextRetryAt: new Date(now),
      at: new Date(now),
    });
    deepseekClassificationFailures = 2;
    tmallQueueEmpty = false;
    tmallSnapshots = [{
      sourceKey: "tmall:pause-claimed-retry",
      orderId: "pause-claimed-retry",
      review: "The sound quality is very good.",
      product: "Paused claimed retry product",
      reviewedAt: "2026-07-14 08:00",
      sentimentLabel: "positive",
      itemId: "pause-claimed-retry-item",
      reviewPhase: "initial",
    }];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && deepseekClassificationCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(deepseekClassificationCalls).toBe(1);
    expect((await app.inject({ method: "POST", url: "/api/automation/pause", headers })).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(tmallSubmitCount).toBe(0);
    expect(replies.get(retry.id)).toMatchObject({ state: "retry_wait" });

    deepseekClassificationFailures = 0;
    expect((await app.inject({ method: "POST", url: "/api/automation/resume", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(tmallSubmitCount).toBe(1);
    expect(replies.get(retry.id)).toMatchObject({ state: "sent" });
  });

  it("safely schedules an automatic retry after an unexpected startup error without exposing the raw exception", async () => {
    tmallReadFailures = [new Error("SQLITE_BUSY at C:\\private\\tmall-review.sqlite Bearer test-secret")];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    database.prepare(`
      INSERT INTO automation_plan(id, enabled, paused, timezone, interval_minutes, revision, updated_at)
      VALUES (1, 1, 0, 'Asia/Shanghai', 15, 1, '2026-07-15T00:30:00.000Z')
    `).run();
    database.prepare("INSERT INTO schedule_windows(id, plan_id, start_minute, end_minute, sort_order) VALUES (?, 1, 480, 540, 1)").run("retry-window");

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", currentStep: "" };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
      if (status.state !== "running") break;
    }

    expect(status).toMatchObject({
      state: "waiting",
      currentStep: "淘宝页面暂时未准备好，已安排下一次自动重试",
    });
    expect(status.nextRunAt).toEqual(expect.any(String));
    expect(JSON.stringify(status)).not.toMatch(/SQLITE|private|test-secret|Bearer/iu);
    expect(database.prepare("SELECT error_code AS errorCode FROM operation_audit WHERE event_type = 'automation_run_failed' ORDER BY rowid DESC LIMIT 1").get())
      .toEqual({ errorCode: "AUTOMATION_RUN_FAILED" });
  });

  it("shows an actionable safe message when the dedicated Chrome window cannot start", async () => {
    tmallOpenError = new TmallBrowserLaunchError({
      cause: new Error("EPERM C:\\private\\copied-profile Bearer secret-token"),
    });
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    database.prepare(`
      INSERT INTO automation_plan(id, enabled, paused, timezone, interval_minutes, revision, updated_at)
      VALUES (1, 1, 0, 'Asia/Shanghai', 15, 1, '2026-07-15T00:30:00.000Z')
    `).run();
    database.prepare("INSERT INTO schedule_windows(id, plan_id, start_minute, end_minute, sort_order) VALUES (?, 1, 480, 540, 1)").run("browser-launch-retry-window");

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", currentStep: "" };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
      if (status.state !== "running") break;
    }

    expect(status).toMatchObject({
      state: "waiting",
      currentStep: "专用淘宝浏览器启动失败。请确认已安装 Chrome，并关闭影刀RPA等正在调试 Chrome 的工具后重试；已安排下一次自动重试",
    });
    expect(JSON.stringify(status)).not.toMatch(/private|Bearer|secret-token|EPERM/iu);
  });

  it("shows the failed stage and allows a fresh manual run after one ordinary error", async () => {
    tmallReadFailures = [new Error("one-time private browser read failure")];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", currentStep: "" };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
    }
    expect(status.state).toBe("error");
    expect(status.currentStep).toContain("正在检查新评价");
    expect(status.currentStep).toContain("可再次点击“立即处理一轮”");
    expect(status.currentStep).not.toContain("private browser read failure");

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(status).toMatchObject({ state: "disabled", currentStep: "当前队列已处理完，可随时再次运行" });
    expect(tmallSubmitCount).toBe(1);
  });

  it("does not run the obsolete global element verification before processing a live review", async () => {
    tmallVerificationFailures = [new Error("transient half-loaded reply controls")];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", failed: 0 };
    for (let attempt = 0; attempt < 160 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
    }

    expect(tmallVerifiedScopes).toHaveLength(0);
    expect(tmallSubmitCount).toBe(1);
    expect(status.failed).toBe(0);
  });

  it("re-reads a temporarily untrusted Tmall page instead of stopping immediately", async () => {
    tmallReadFailures = [new TmallReviewPageStateError("评价列表仍在加载")];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", failed: 0 };
    for (let attempt = 0; attempt < 160 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
    }

    expect(tmallReadScopes.length).toBeGreaterThanOrEqual(2);
    expect(tmallSubmitCount).toBe(1);
    expect(status.failed).toBe(0);
  });

  it("retries a transient Windows credential read before opening and logging into Taobao", async () => {
    const originalRead = secretStore.read.bind(secretStore);
    let remainingFailures = 2;
    secretStore.read = async (key) => {
      if (key === "taobao_seller" && remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("temporary Windows credential helper failure");
      }
      return originalRead(key);
    };
    tmallQueueEmpty = true;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running" };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
    }

    expect(remainingFailures).toBe(0);
    expect(tmallOpenCount).toBe(1);
    expect(status.state).toBe("disabled");
  });

  it("reports an unreadable saved Taobao login clearly and permits the next click to retry", async () => {
    const originalRead = secretStore.read.bind(secretStore);
    secretStore.read = async (key) => {
      if (key === "taobao_seller") throw new Error("private Windows credential failure");
      return originalRead(key);
    };
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    const failed = await app.inject({ method: "POST", url: "/api/automation/start-now", headers });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({
      error: "tmall_credentials_temporarily_unavailable",
      detail: "读取已保存的淘宝登录信息失败，请再次点击“立即处理一轮”重试",
    });
    expect(failed.body).not.toContain("private Windows credential failure");

    secretStore.read = originalRead;
    tmallQueueEmpty = true;
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
  });

  it("ends the current cycle without manual pause when page reading still fails after recovery", async () => {
    tmallReadFailures = [
      new TmallDriverOperationError("review.list", "review list selector no longer matches"),
      new Error("SQLITE_BUSY C:\\private\\retry-recovery.sqlite Bearer retry-secret"),
    ];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", currentStep: "" };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
    }

    expect(status).toMatchObject({ state: "disabled", currentStep: "淘宝评价页面暂时无法读取，本轮已安全结束，可再次运行" });
    expect(JSON.stringify(status)).not.toMatch(/SQLITE|private|retry-secret|Bearer/iu);
    expect(database.prepare("SELECT error_code AS errorCode FROM operation_audit WHERE event_type = 'automation_read_recovery_failed' ORDER BY rowid DESC LIMIT 1").get())
      .toEqual({ errorCode: "TMALL_READ_RECOVERY_FAILED" });
    expect(tmallSubmitCount).toBe(0);
  });

  it("runs the formal automation pipeline through generation, one safe submission and durable idempotency", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let state = "running";
    for (let attempt = 0; attempt < 100 && state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = (await app.inject({ method: "GET", url: "/api/automation/status", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json<{ state: string }>().state;
    }
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json()).toMatchObject({
      state: "disabled",
      currentStep: "当前队列已处理完，可随时再次运行",
    });
    expect(tmallSubmitCount).toBe(1);
    const replies = await app.inject({ method: "GET", url: "/api/replies", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(replies.json().items[0]).toMatchObject({ state: "sent" });
    const reprocessSent = await app.inject({ method: "POST", url: `/api/replies/${replies.json().items[0].id}/reprocess`, headers });
    expect(reprocessSent.statusCode).toBe(409);
    expect(reprocessSent.json()).toMatchObject({ error: "reply_already_submitted", detail: "该回复已经进入提交流程，不能重新生成" });

    await app.inject({ method: "POST", url: "/api/automation/start-now", headers });
    for (let attempt = 0; attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(tmallSubmitCount).toBe(1);
  });

  it("records a failed pre-submit locator and continues without reopening the review", async () => {
    tmallSubmitFailureOperationKey = "review.product";
    const before = locatorRepository.get("review.product");
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", succeeded: 0, failed: 0 };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
    }

    expect(status).toMatchObject({ state: "disabled", succeeded: 0, failed: 0 });
    expect(tmallSubmitCount).toBe(1);
    expect(locatorRepository.get("review.product")?.version).toBe(before?.version);
    expect(locatorRepository.listRepairs()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ operationKey: "review.product", status: "auto_applied" }),
    ]));
  });

  it("compacts expired manual holds, prunes old tombstones and preserves operator rules", async () => {
    const lifecycleDatabase = openDatabase(":memory:");
    runMigrations(lifecycleDatabase);
    const replies = new ReplyRepository(lifecycleDatabase);
    const products = new ManualProductRepository(lifecycleDatabase);
    products.upsert({ itemId: "keep-product-id", title: "Keep manual product" }, "manual", products.revision());
    lifecycleDatabase.prepare(`
      UPDATE review_scope
      SET preset = 'custom', custom_start_date = '2026-07-01', custom_end_date = '2026-07-14', revision = 2
      WHERE id = 1
    `).run();

    const expired = replies.discover({
      sourceKey: "tmall:lifecycle:expired-hold", orderId: "expired-hold", review: "Expired hold",
      product: "Expired manual product", reviewedAt: "2026-04-01 08:00", sentimentLabel: "negative",
      itemId: "expired-hold", reviewPhase: "initial",
    });
    replies.markManualProductHold(expired.id, {
      storeId: "primary", manualProductId: null, catalogRevision: 1, matchKind: "item_id", reason: "manual",
    });
    lifecycleDatabase.prepare("UPDATE reply_drafts SET discovered_at = '2026-04-01T00:00:00.000Z' WHERE id = ?").run(expired.id);

    const active = replies.discover({
      sourceKey: "tmall:lifecycle:active-hold", orderId: "active-hold", review: "Active hold",
      product: "Active manual product", reviewedAt: "2026-07-01 08:00", sentimentLabel: "negative",
      itemId: "active-hold", reviewPhase: "initial",
    });
    replies.markManualProductHold(active.id, {
      storeId: "primary", manualProductId: null, catalogRevision: 1, matchKind: "item_id", reason: "manual",
    });

    const uncertain = replies.discover({
      sourceKey: "tmall:lifecycle:uncertain", orderId: "uncertain", review: "Uncertain submission",
      product: "Uncertain product", reviewedAt: "2025-12-01 08:00", sentimentLabel: "positive",
      itemId: "uncertain", reviewPhase: "initial",
    });
    lifecycleDatabase.prepare("UPDATE reply_drafts SET state = 'read_only_ready', discovered_at = '2025-12-01T00:00:00.000Z' WHERE id = ?").run(uncertain.id);
    const attempts = new ReplyAttemptRepository(lifecycleDatabase);
    const attempt = attempts.prepare(uncertain.id, "tmall:lifecycle:uncertain").attempt;
    attempts.markSubmitting(attempt.id);
    attempts.markUncertain(attempt.id, "network result unknown");
    lifecycleDatabase.prepare("UPDATE reply_attempts SET created_at = '2025-12-01T00:00:00.000Z' WHERE id = ?").run(attempt.id);

    lifecycleDatabase.prepare(`
      INSERT INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at)
      VALUES ('primary', 'tmall:lifecycle:old-tombstone', 'not_actionable', '2025-12-01T00:00:00.000Z')
    `).run();

    const lifecycleApp = buildApp({ host, origin, sessionToken: "lifecycle-session", csrfToken: "lifecycle-csrf", database: lifecycleDatabase, now: () => new Date(now) });
    await lifecycleApp.ready();

    expect(replies.get(expired.id)).toBeNull();
    expect(new ReviewActionGate(lifecycleDatabase).getTombstone("primary", "tmall:lifecycle:expired-hold")).toMatchObject({ terminalAction: "manual_hold_expired" });
    expect(replies.get(active.id)).toMatchObject({ state: "manual_product_hold" });
    expect(new ReviewActionGate(lifecycleDatabase).getLock("primary", "tmall:lifecycle:active-hold")).toMatchObject({ actionKind: "manual_hold" });
    expect(replies.get(uncertain.id)).toMatchObject({ state: "submission_uncertain" });
    expect(attempts.get(attempt.id)).toMatchObject({ state: "submission_uncertain" });
    expect(new ReviewActionGate(lifecycleDatabase).getTombstone("primary", "tmall:lifecycle:old-tombstone")).toBeNull();
    expect(products.stats().total).toBe(1);
    expect(lifecycleDatabase.prepare("SELECT preset, custom_start_date, custom_end_date FROM review_scope WHERE id = 1").get()).toEqual({
      preset: "custom", custom_start_date: "2026-07-01", custom_end_date: "2026-07-14",
    });
    await lifecycleApp.close();
  });

  it("marks an interrupted submitting attempt for manual reconciliation during startup", async () => {
    const restartDatabase = openDatabase(":memory:");
    runMigrations(restartDatabase);
    const replies = new ReplyRepository(restartDatabase);
    const attempts = new ReplyAttemptRepository(restartDatabase);
    const draft = replies.discover({
      sourceKey: "tmall:startup:submitting",
      orderId: "startup-submitting",
      review: "很好",
      product: "测试耳机",
      reviewedAt: "2026-07-16 08:00",
      sentimentLabel: "positive",
      itemId: "startup-item",
      reviewPhase: "initial",
    });
    replies.complete(draft.id, {
      finalReply: "感谢您的支持，若有任何疑问欢迎咨询在线客服！",
      productAdjusted: false,
      needsAttention: false,
      notes: "",
      attentionReasons: [],
    });
    const attempt = attempts.prepare(draft.id, "tmall:startup:submitting").attempt;
    attempts.markSubmitting(attempt.id);
    const interruptedRuns = new AutomationRepository(restartDatabase);
    const interruptedRunId = interruptedRuns.createRun("scheduled", {
      preset: "last7",
      startDate: "2026-07-10",
      endDate: "2026-07-16",
      timezone: "Asia/Shanghai",
      revision: 1,
    });

    const restartApp = buildApp({
      host,
      origin,
      sessionToken: "startup-recovery-session",
      csrfToken: "startup-recovery-csrf",
      database: restartDatabase,
      now: () => new Date("2026-07-16T10:00:00.000Z"),
    });
    await restartApp.ready();

    expect(attempts.get(attempt.id)).toMatchObject({
      state: "submission_uncertain",
      errorCode: "SUBMISSION_INTERRUPTED",
    });
    expect(replies.get(draft.id)).toMatchObject({
      state: "submission_uncertain",
      errorCode: "SUBMISSION_INTERRUPTED",
    });
    expect(new ReviewActionGate(restartDatabase).getLock("primary", "tmall:startup:submitting"))
      .toMatchObject({ actionKind: "reply" });
    expect(interruptedRuns.getLastRun()).toMatchObject({
      id: interruptedRunId,
      state: "interrupted",
      stopReason: "application_restarted",
    });

    await restartApp.close();
  });

  it("does not count three action-owned submissions as failures and continues to the next review", async () => {
    const replies = new ReplyRepository(database);
    const gate = new ReviewActionGate(database);
    const snapshots = Array.from({ length: 4 }, (_, index): TmallReviewSnapshot => ({
      sourceKey: `tmall:controller-skip:${index + 1}`,
      orderId: `controller-skip-${index + 1}`,
      review: `第${index + 1}条评价音质很好`,
      product: "漫步者测试耳机",
      reviewedAt: "2026-07-14 08:00",
      sentimentLabel: "positive",
      itemId: `1000${index + 1}`,
      reviewPhase: "initial",
    }));
    for (const [index, item] of snapshots.entries()) {
      const { id } = replies.discover(item);
      replies.complete(id, {
        finalReply: "感谢您选购漫步者测试耳机！若有任何疑问欢迎咨询在线客服，感谢您的支持！",
        productAdjusted: true,
        needsAttention: false,
        notes: "已适配当前商品",
        attentionReasons: [],
      });
      if (index < 3) gate.acquire("primary", item.sourceKey, "complaint");
    }
    tmallSnapshots = snapshots;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", processed: 0, succeeded: 0, failed: 0, currentStep: "" };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json();
    }

    expect(status).toMatchObject({ state: "disabled", processed: 4, succeeded: 1, failed: 0 });
    expect(status.currentStep).not.toContain("连续三条");
    expect(tmallSubmitCount).toBe(1);
    expect(database.prepare(`
      SELECT processed_count AS processed, succeeded_count AS succeeded, failed_count AS failed, state
      FROM automation_runs ORDER BY started_at DESC LIMIT 1
    `).get()).toEqual({ processed: 4, succeeded: 1, failed: 0, state: "completed" });
    expect(snapshots.slice(0, 3).every((item) => gate.getLock("primary", item.sourceKey)?.actionKind === "complaint")).toBe(true);
  });

  it("resets the failure circuit after manual and action-owned outcomes and continues", async () => {
    tmallSubmitState = "failed";
    deepseekSentimentResolver = async (input) => /obvious problem/iu.test(input.review)
      ? { sentiment: "negative", reason: "正文明确描述商品问题", confidence: 0.98 }
      : { sentiment: "positive", reason: "正文明确称赞音质", confidence: 0.98 };
    const products = new ManualProductRepository(database);
    products.upsert({ itemId: "manual-circuit-product", title: "Manual circuit product" }, "manual", products.revision());
    const replies = new ReplyRepository(database);
    const gate = new ReviewActionGate(database);
    const snapshots = Array.from({ length: 6 }, (_, index): TmallReviewSnapshot => ({
      sourceKey: `tmall:controller-interleaved:${index + 1}`,
      orderId: `controller-interleaved-${index + 1}`,
      review: index === 1 || index === 5 ? "The product has an obvious problem." : `Review ${index + 1} says the sound is good.`,
      product: index === 1 || index === 5 ? "Manual circuit product renamed" : "Regular product",
      reviewedAt: "2026-07-14 08:00",
      sentimentLabel: index === 1 || index === 5 ? "negative" : "positive",
      itemId: index === 1 || index === 5 ? "manual-circuit-product" : `circuit-${index + 1}`,
      reviewPhase: "initial",
    }));
    const skipped = snapshots[3];
    const { id: skippedDraftId } = replies.discover(skipped);
    replies.complete(skippedDraftId, {
      finalReply: "Thank you for your support.",
      productAdjusted: true,
      needsAttention: false,
      notes: "Prepared for an existing complaint action.",
      attentionReasons: [],
    });
    gate.acquire("primary", skipped.sourceKey, "complaint");
    tmallSnapshots = snapshots;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", processed: 0, manual: 0, failed: 0, currentStep: "" };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
    }

    expect(status).toMatchObject({ state: "disabled", processed: 6, manual: 2, failed: 0 });
    expect(status.currentStep).not.toContain("连续三条");
    expect(tmallSubmitCount).toBe(3);
  });

  it("diverts matching neutral and negative products to manual handling without submissions", async () => {
    deepseekSentimentResolver = async (input) => /acceptable/iu.test(input.review)
      ? { sentiment: "neutral", reason: "正文态度中性且描述问题", confidence: 0.96 }
      : /poor/iu.test(input.review)
        ? { sentiment: "negative", reason: "正文明确表达不满", confidence: 0.98 }
        : { sentiment: "positive", reason: "正文明确称赞音质", confidence: 0.98 };
    const products = new ManualProductRepository(database);
    products.upsert({ itemId: "manual-product-10001", title: "Manual product" }, "manual", products.revision());
    tmallSnapshots = [
      {
        sourceKey: "tmall:manual-policy:neutral",
        orderId: "manual-policy-neutral",
        review: "It is acceptable but has an obvious problem.",
        product: "Manual product renamed title",
        reviewedAt: "2026-07-14 08:00",
        sentimentLabel: "neutral",
        itemId: "manual-product-10001",
        reviewPhase: "initial",
      },
      {
        sourceKey: "tmall:manual-policy:negative",
        orderId: "manual-policy-negative",
        review: "The experience is poor.",
        product: "Manual product renamed again",
        reviewedAt: "2026-07-14 08:01",
        sentimentLabel: "negative",
        itemId: "manual-product-10001",
        reviewPhase: "initial",
      },
      {
        sourceKey: "tmall:manual-policy:positive",
        orderId: "manual-policy-positive",
        review: "The sound quality is very good.",
        product: "Manual product current title",
        reviewedAt: "2026-07-14 08:02",
        sentimentLabel: "positive",
        itemId: "manual-product-10001",
        reviewPhase: "initial",
      },
    ];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", processed: 0, succeeded: 0, failed: 0, manual: 0 };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json();
    }

    expect(status).toMatchObject({ state: "disabled", processed: 3, succeeded: 1, failed: 0, manual: 2 });
    expect(tmallSubmitCount).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_attempts").get()).toEqual({ value: 1 });
    expect(database.prepare("SELECT state, COUNT(*) AS value FROM reply_drafts GROUP BY state ORDER BY state").all()).toEqual([
      { state: "manual_product_hold", value: 2 },
      { state: "sent", value: 1 },
    ]);
    expect(database.prepare(`
      SELECT processed_count AS processed, succeeded_count AS succeeded,
        failed_count AS failed, manual_count AS manual, state, stop_reason AS stopReason
      FROM automation_runs ORDER BY started_at DESC LIMIT 1
    `).get()).toEqual({ processed: 3, succeeded: 1, failed: 0, manual: 2, state: "completed", stopReason: "queue_empty" });

    const dashboard = await app.inject({ method: "GET", url: "/api/dashboard", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(dashboard.json()).toMatchObject({
      reviewScope: {
        preset: "last7",
        startDate: "2026-07-09",
        endDate: "2026-07-15",
        timezone: "Asia/Shanghai",
        summary: expect.any(String),
      },
      manualProducts: { total: 1, diverted: 2 },
      latestRun: {
        trigger: "manual",
        state: "completed",
        processed: 3,
        succeeded: 1,
        failed: 0,
        manual: 2,
        stopReason: "queue_empty",
        scope: {
          preset: "last7",
          startDate: "2026-07-09",
          endDate: "2026-07-15",
          timezone: "Asia/Shanghai",
          summary: expect.any(String),
        },
      },
    });
    expect(dashboard.body).not.toMatch(/manualCatalogRevision|manualMatchKind|lockVersion|catalogRevision|scopeRevision|sourceKey|errorMessage|revision/iu);
  });

  it("skips three ordinary pre-submit failures without opening a failure circuit", async () => {
    tmallSubmitState = "failed";
    tmallSnapshots = Array.from({ length: 3 }, (_, index): TmallReviewSnapshot => ({
      sourceKey: `tmall:controller-failed:${index + 1}`,
      orderId: `controller-failed-${index + 1}`,
      review: `第${index + 1}条评价音质很好`,
      product: "漫步者测试耳机",
      reviewedAt: "2026-07-14 08:00",
      sentimentLabel: "positive",
      itemId: `2000${index + 1}`,
      reviewPhase: "initial",
    }));
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", failed: 0, currentStep: "" };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json();
    }

    expect(status).toMatchObject({ state: "disabled", failed: 0 });
    expect(tmallSubmitCount).toBe(3);
  });

  it("freezes one review scope for the whole run and records it in the run audit", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(tmallReadScopes.length).toBeGreaterThanOrEqual(2);
    expect(tmallReadScopes[0]).toMatchObject({
      preset: "last7",
      startDate: "2026-07-09",
      endDate: "2026-07-15",
      timezone: "Asia/Shanghai",
    });
    expect(tmallReadScopes.every((scope) => scope === tmallReadScopes[0])).toBe(true);
    expect(tmallVerifiedScopes).toEqual([]);
    expect(database.prepare(`
      SELECT scope_preset, scope_start_date, scope_end_date, scope_revision, scope_timezone
      FROM automation_runs
      ORDER BY started_at DESC
      LIMIT 1
    `).get()).toEqual({
      scope_preset: "last7",
      scope_start_date: "2026-07-09",
      scope_end_date: "2026-07-15",
      scope_revision: 1,
      scope_timezone: "Asia/Shanghai",
    });
  });

  it("keeps a scope change out of the active run and applies it to the next run", async () => {
    tmallSubmitDelayMs = 80;
    tmallSnapshots = [{
      sourceKey: "tmall:scope-freeze:first",
      orderId: "scope-freeze-first",
      review: "The first review is good.",
      product: "First product",
      reviewedAt: "2026-07-14 08:00",
      sentimentLabel: "positive",
      itemId: "scope-first",
      reviewPhase: "initial",
    }];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const writeHeaders = { ...headers, "content-type": "application/json" };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100 && tmallSubmitCount === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));

    const beforeChange = await app.inject({ method: "GET", url: "/api/automation/status", headers });
    expect(beforeChange.json()).toMatchObject({
      plan: { revision: 1 },
      currentReview: { review: "The first review is good.", product: "First product" },
      reviewScope: { preset: "last7", startDate: "2026-07-09", endDate: "2026-07-15", timezone: "Asia/Shanghai", summary: expect.any(String) },
      lastRun: { trigger: "manual", scope: { preset: "last7", startDate: "2026-07-09", endDate: "2026-07-15", timezone: "Asia/Shanghai", summary: expect.any(String) } },
    });
    expect(beforeChange.json().currentReview).toEqual({ review: "The first review is good.", product: "First product" });
    expectPublicAutomationStatus(beforeChange.json());
    const { plan: _beforePlan, ...beforePublicRun } = beforeChange.json();
    expect(JSON.stringify(beforePublicRun)).not.toMatch(/revision|lockVersion|manualMatchKind|manualCatalogRevision/iu);

    const changed = await app.inject({
      method: "PUT",
      url: "/api/review-scope",
      headers: writeHeaders,
      payload: { preset: "today", expectedRevision: 1 },
    });
    expect(changed.statusCode).toBe(200);
    const duringChangedRun = await app.inject({ method: "GET", url: "/api/automation/status", headers });
    expect(duringChangedRun.json()).toMatchObject({
      plan: { revision: 1 },
      reviewScope: { preset: "last7", startDate: "2026-07-09", endDate: "2026-07-15", timezone: "Asia/Shanghai", summary: expect.any(String) },
    });
    const { plan: _duringPlan, ...duringPublicRun } = duringChangedRun.json();
    expect(JSON.stringify(duringPublicRun)).not.toMatch(/revision|lockVersion|manualMatchKind|manualCatalogRevision/iu);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    tmallSubmitDelayMs = 0;
    tmallSnapshots = [{
      sourceKey: "tmall:scope-freeze:second",
      orderId: "scope-freeze-second",
      review: "The second review is good.",
      product: "Second product",
      reviewedAt: "2026-07-15 08:00",
      sentimentLabel: "positive",
      itemId: "scope-second",
      reviewPhase: "initial",
    }];
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(database.prepare(`
      SELECT scope_preset, scope_start_date, scope_end_date, scope_revision
      FROM automation_runs ORDER BY started_at, rowid
    `).all()).toEqual([
      { scope_preset: "last7", scope_start_date: "2026-07-09", scope_end_date: "2026-07-15", scope_revision: 1 },
      { scope_preset: "today", scope_start_date: "2026-07-15", scope_end_date: "2026-07-15", scope_revision: 2 },
    ]);
    expect(tmallReadScopes.filter((scope) => scope.preset === "last7").every((scope) => scope.startDate === "2026-07-09")).toBe(true);
    expect(tmallReadScopes.filter((scope) => scope.preset === "today").every((scope) => scope.startDate === "2026-07-15")).toBe(true);
    const afterSecondRun = await app.inject({ method: "GET", url: "/api/automation/status", headers });
    expect(afterSecondRun.json()).toMatchObject({
      plan: { revision: 1 },
      reviewScope: { preset: "today", startDate: "2026-07-15", endDate: "2026-07-15", timezone: "Asia/Shanghai", summary: expect.any(String) },
      lastRun: { trigger: "manual", scope: { preset: "today", startDate: "2026-07-15", endDate: "2026-07-15", timezone: "Asia/Shanghai", summary: expect.any(String) } },
    });
    const { plan: _afterPlan, ...afterPublicRun } = afterSecondRun.json();
    expect(JSON.stringify(afterPublicRun)).not.toMatch(/revision|lockVersion|manualMatchKind|manualCatalogRevision/iu);
  });

  it("processes an in-scope review that arrives while the current run is active", async () => {
    const first: TmallReviewSnapshot = {
      sourceKey: "tmall:realtime:first", orderId: "realtime-first", review: "First good review", product: "Product one",
      reviewedAt: "2026-07-14 08:00", sentimentLabel: "positive", itemId: "realtime-1", reviewPhase: "initial",
    };
    const arrived: TmallReviewSnapshot = {
      sourceKey: "tmall:realtime:arrived", orderId: "realtime-arrived", review: "New good review", product: "Product two",
      reviewedAt: "2026-07-14 08:01", sentimentLabel: "positive", itemId: "realtime-2", reviewPhase: "initial",
    };
    tmallSnapshotReads = [[first], [first, arrived], [], [], [], []];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", processed: 0, succeeded: 0 };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
    }
    expect(status).toMatchObject({ state: "disabled", processed: 2, succeeded: 2, failed: 0, manual: 0 });
    expect(tmallSubmitCount).toBe(2);
  });

  it("uses the same frozen review-scope semantics for a scheduled run", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({
      method: "PUT", url: "/api/review-scope", headers,
      payload: { preset: "today", expectedRevision: 1 },
    })).statusCode).toBe(200);
    tmallSnapshots = [{
      sourceKey: "tmall:scheduled-scope", orderId: "scheduled-scope", review: "Scheduled good review", product: "Scheduled product",
      reviewedAt: "2026-07-15 08:10", sentimentLabel: "positive", itemId: "scheduled-scope", reviewPhase: "initial",
    }];

    const enabled = await app.inject({
      method: "PUT", url: "/api/automation-plan", headers,
      payload: { enabled: true, intervalMinutes: 15, windows: [{ id: "morning", start: "08:00", end: "09:00" }], expectedRevision: 1 },
    });
    expect(enabled.statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = database.prepare("SELECT state FROM automation_runs ORDER BY started_at DESC LIMIT 1").get() as { state?: string } | undefined;
      if (run?.state && run.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(database.prepare(`
      SELECT trigger_type, state, scope_preset, scope_start_date, scope_end_date, scope_revision
      FROM automation_runs ORDER BY started_at DESC LIMIT 1
    `).get()).toEqual({
      trigger_type: "scheduled", state: "completed", scope_preset: "today",
      scope_start_date: "2026-07-15", scope_end_date: "2026-07-15", scope_revision: 2,
    });
    expect(tmallReadScopes.length).toBeGreaterThan(0);
    expect(tmallReadScopes.every((scope) => scope.preset === "today" && scope.startDate === "2026-07-15")).toBe(true);
    const status = await app.inject({ method: "GET", url: "/api/automation/status", headers });
    expect(status.json()).toMatchObject({
      plan: { revision: 2 },
      reviewScope: { preset: "today", startDate: "2026-07-15", endDate: "2026-07-15", timezone: "Asia/Shanghai", summary: expect.any(String) },
      lastRun: { trigger: "scheduled", scope: { preset: "today", startDate: "2026-07-15", endDate: "2026-07-15", timezone: "Asia/Shanghai", summary: expect.any(String) } },
    });
    const { plan: _scheduledPlan, ...scheduledPublicRun } = status.json();
    expect(JSON.stringify(scheduledPublicRun)).not.toMatch(/revision|lockVersion|manualMatchKind|manualCatalogRevision/iu);
  });

  it("ends the cycle without pausing when a page contains a review outside the frozen scope", async () => {
    tmallSnapshots = [
      {
        sourceKey: "tmall:test-order:valid",
        orderId: "test-order-valid",
        review: "音质很好，使用方便",
        product: "漫步者测试耳机",
        reviewedAt: "2026-07-14 08:00",
        sentimentLabel: "positive",
        itemId: "10001",
        reviewPhase: "initial",
      },
      {
        sourceKey: "tmall:test-order:outside",
        orderId: "test-order-outside",
        review: "评价日期不在本轮范围内",
        product: "漫步者测试耳机",
        reviewedAt: "2026-07-08 23:59",
        sentimentLabel: "neutral",
        itemId: "10002",
        reviewPhase: "initial",
      },
    ];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running" };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json();
    }

    expect(status.state).toBe("disabled");
    expect(tmallSubmitCount).toBe(0);
    expect((await app.inject({ method: "GET", url: "/api/replies", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json().items).toEqual([]);
    expect(database.prepare("SELECT state, stop_reason FROM automation_runs ORDER BY started_at DESC LIMIT 1").get()).toEqual({
      state: "error",
      stop_reason: "recoverable_page_failure",
    });
  });

  it("ends the cycle without pausing when a review date cannot be parsed", async () => {
    tmallSnapshots = [{
      sourceKey: "tmall:invalid-date",
      orderId: "invalid-date",
      review: "Review with an invalid date",
      product: "Invalid date product",
      reviewedAt: "not-a-date",
      sentimentLabel: "negative",
      itemId: "invalid-date-product",
      reviewPhase: "initial",
    }];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running" };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
    }
    expect(status.state).toBe("disabled");
    expect(tmallSubmitCount).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_drafts").get()).toEqual({ value: 0 });
    expect(database.prepare("SELECT state, stop_reason FROM automation_runs ORDER BY started_at DESC LIMIT 1").get()).toEqual({
      state: "error",
      stop_reason: "recoverable_page_failure",
    });
  });

  it("uses only complete in-scope scans to close disappeared manual holds", async () => {
    const replies = new ReplyRepository(database);
    const inScope = replies.discover({
      sourceKey: "tmall:scan-wiring:in-scope", orderId: "scan-in", review: "Needs manual handling", product: "Product in scope",
      reviewedAt: "2026-07-14 08:00", sentimentLabel: "negative", itemId: "scan-in", reviewPhase: "initial",
    });
    const outOfScope = replies.discover({
      sourceKey: "tmall:scan-wiring:out-of-scope", orderId: "scan-out", review: "Old manual handling", product: "Product out of scope",
      reviewedAt: "2026-07-08 08:00", sentimentLabel: "negative", itemId: "scan-out", reviewPhase: "initial",
    });
    for (const id of [inScope.id, outOfScope.id]) {
      replies.markManualProductHold(id, {
        storeId: "primary", manualProductId: null, catalogRevision: 1, matchKind: "item_id", reason: "Manual handling",
      });
    }
    tmallQueueEmpty = true;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(replies.get(inScope.id)).toMatchObject({ state: "not_actionable", manualHoldAbsentScans: 2 });
    expect(replies.get(outOfScope.id)).toMatchObject({ state: "manual_product_hold", manualHoldAbsentScans: 0 });
    expect(new ReviewActionGate(database).getTombstone("primary", "tmall:scan-wiring:in-scope")).toMatchObject({ terminalAction: "not_actionable" });
    expect(new ReviewActionGate(database).getLock("primary", "tmall:scan-wiring:out-of-scope")).toMatchObject({ actionKind: "manual_hold" });
  });

  it("persists manual diversion on an abnormal run without counting partial scan evidence", async () => {
    deepseekSentimentResolver = async () => ({ sentiment: "negative", reason: "正文明确描述商品问题", confidence: 0.98 });
    const products = new ManualProductRepository(database);
    products.upsert({ itemId: "manual-abnormal-product", title: "Manual abnormal product" }, "manual", products.revision());
    tmallSnapshots = [{
      sourceKey: "tmall:manual-abnormal",
      orderId: "manual-abnormal",
      review: "This product has a problem.",
      product: "Renamed manual abnormal product",
      reviewedAt: "2026-07-14 08:00",
      sentimentLabel: "negative",
      itemId: "manual-abnormal-product",
      reviewPhase: "initial",
    }];
    tmallReadFailures = [null, new Error("later page read failed")];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", manual: 0, failed: 0 };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
    }

    expect(status).toMatchObject({ state: "error", processed: 1, succeeded: 0, manual: 1, failed: 0 });
    expect(tmallSubmitCount).toBe(0);
    expect(database.prepare(`
      SELECT processed_count AS processed, succeeded_count AS succeeded, manual_count AS manual,
        failed_count AS failed, state, stop_reason AS stopReason
      FROM automation_runs ORDER BY started_at DESC LIMIT 1
    `).get()).toEqual({ processed: 1, succeeded: 0, manual: 1, failed: 0, state: "error", stopReason: "run_failed" });
    expect(database.prepare(`
      SELECT state, manual_hold_absent_scans AS absentScans FROM reply_drafts WHERE source_key = 'tmall:manual-abnormal'
    `).get()).toEqual({ state: "manual_product_hold", absentScans: 0 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_attempts").get()).toEqual({ value: 0 });
  });

  it("retries a transient untrusted page state after login recovery", async () => {
    tmallReadFailures = [
      new Error("淘宝登录状态已失效"),
      new TmallReviewPageStateError("恢复登录后仍无法确认评价筛选状态"),
    ];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running" };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json();
    }

    expect(status.state).toBe("disabled");
    expect(tmallSubmitCount).toBe(1);
    expect(database.prepare("SELECT state, stop_reason FROM automation_runs ORDER BY started_at DESC LIMIT 1").get()).toEqual({
      state: "completed",
      stop_reason: "queue_empty",
    });
  });

  it("locks a post-click uncertainty report without repeating it and keeps the scheduled plan running", async () => {
    tmallSubmitState = "uncertain";
    const headers = { host, origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const enabled = await app.inject({
      method: "PUT",
      url: "/api/automation-plan",
      headers,
      payload: { enabled: true, intervalMinutes: 1, windows: [{ id: "all-day", start: "00:00", end: "23:59" }], expectedRevision: 1 },
    });
    expect(enabled.statusCode).toBe(200);

    let status = { state: "running", nextRunAt: "pending" as string | null };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json();
    }
    expect(status).toMatchObject({ state: "waiting", nextRunAt: expect.any(String) });
    expect(tmallSubmitCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json()).toMatchObject({ state: "waiting", nextRunAt: expect.any(String) });
    expect(tmallSubmitCount).toBe(1);

    const replyId = (await app.inject({ method: "GET", url: "/api/replies", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json().items[0].id;
    expect((await app.inject({ method: "GET", url: `/api/replies/${replyId}`, headers: { host, cookie: `tmall_console_session=${cookie}` } })).json()).toMatchObject({ id: replyId, state: "submission_uncertain" });
    expect((await app.inject({ method: "GET", url: "/api/automation/preflight", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json()).toMatchObject({ ready: true });
  });

  it("records an untrusted pre-submit page and skips that review", async () => {
    tmallSubmitPageStateError = true;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running", currentStep: "" };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json();
    }

    expect(status).toMatchObject({ state: "disabled" });
    expect(tmallSubmitCount).toBe(1);
    const replies = await app.inject({ method: "GET", url: "/api/replies", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(replies.json().items[0]).toMatchObject({ state: "failed", errorCode: "TMALL_PAGE_STATE_UNTRUSTED" });
  });

  it("keeps a replaced account runnable while requiring runtime login verification", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const prepared = await app.inject({ method: "POST", url: "/api/tmall-auth/credentials/prepare", headers, payload: { action: "replace" } });
    await app.inject({ method: "PUT", url: "/api/tmall-auth/credentials", headers, payload: { nonce: prepared.json().nonce, account: "new-account", password: "new-password" } });

    const preflight = await app.inject({ method: "GET", url: "/api/automation/preflight", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(preflight.json().checks).toEqual(expect.arrayContaining([expect.objectContaining({ key: "tmall", ready: true })]));
    expect(preflight.json()).toMatchObject({ ready: true });
    const dashboard = await app.inject({ method: "GET", url: "/api/dashboard", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(dashboard.json()).toMatchObject({ health: { tmall: "configured" }, readiness: { ready: true } });
  });

  it("allows activation from the four merchant configurations before page elements are observed", async () => {
    const settings = new SettingsRepository(database);
    settings.set("tmall_verified_credential_fingerprint", "");
    settings.set("tmall_verified_store_name", "");
    for (const operationKey of ["navigation.trade", "navigation.reviews", "review.filter.buyer", "review.filter.content", "review.filter.unanswered", "review.date.trigger", "review.search", "review.list", "review.product", "reply.open", "reply.editor", "reply.submit"]) {
      locatorRepository.markAttention(operationKey);
    }

    const preflight = await app.inject({
      method: "GET",
      url: "/api/automation/preflight",
      headers: { host, cookie: `tmall_console_session=${cookie}` },
    });

    expect(preflight.statusCode).toBe(200);
    expect(preflight.json()).toMatchObject({ ready: true });
    expect(preflight.json().checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "tmall", ready: true }),
    ]));
    expect(preflight.json().checks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "elements" }),
    ]));
  });

  it("does not run a global element probe for an authenticated merchant", async () => {
    tmallMissingElements = ["reply.editor", "reply.submit"];
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const result = await app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ state: "authenticated" });
    expect(result.json().elementVerificationDeferred).toBeUndefined();
    const preflight = await app.inject({ method: "GET", url: "/api/automation/preflight", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(preflight.json()).toMatchObject({ ready: true, missing: [] });
    expect(preflight.json().checks).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: "elements" })]));
    expect(tmallVerifiedScopes).toEqual([]);
  });

  it("checks login state without running a global element probe or opening a reply box", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    const result = await app.inject({ method: "POST", url: "/api/tmall-auth/runtime-preflight", headers });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ state: "authenticated" });
    expect(tmallVerifyReplyControls).toEqual([]);
    expect(tmallSubmitCount).toBe(0);
  });

  it("allows an empty queue to enable future automation without global element probing", async () => {
    tmallQueueEmpty = true;
    for (const operationKey of ["review.list", "review.product", "reply.open", "reply.editor", "reply.submit"]) locatorRepository.markAttention(operationKey);
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: "tmall_console_session=" + cookie };
    const login = await app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ state: "authenticated" });
    expect(login.json().elementVerificationDeferred).toBeUndefined();
    const preflight = await app.inject({ method: "GET", url: "/api/automation/preflight", headers });
    expect(preflight.json().checks).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: "elements" })]));

    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(tmallSubmitCount).toBe(0);
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "disabled" });

    tmallQueueEmpty = false;
    tmallMissingElements = ["reply.submit"];
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers })).json();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(tmallSubmitCount).toBe(1);
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers })).json()).toMatchObject({ state: "disabled" });
    expect(tmallVerifyReplyControls).not.toContain(true);
  });

  it("restores an expired browser session and continues the same review exactly once", async () => {
    tmallSessionExpiresOnFirstSubmit = true;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    expect((await app.inject({ method: "POST", url: "/api/automation/start-now", headers })).statusCode).toBe(200);
    let status = { state: "running" };
    for (let attempt = 0; attempt < 100 && status.state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: "GET", url: "/api/automation/status", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json();
    }
    expect(status.state).toBe("disabled");
    expect(tmallSubmitCount).toBe(2);
    expect(tmallOpenCount).toBe(2);
    expect((await app.inject({ method: "GET", url: "/api/replies", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json().items[0]).toMatchObject({ state: "sent" });
  });

  it("cancels a pending pause when continue is clicked before the current review finishes", async () => {
    tmallSubmitDelayMs = 80;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    await app.inject({ method: "POST", url: "/api/automation/start-now", headers });
    for (let attempt = 0; attempt < 40 && tmallSubmitCount === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await app.inject({ method: "POST", url: "/api/automation/pause", headers })).json()).toMatchObject({ state: "paused" });
    const replies = await app.inject({ method: "GET", url: "/api/replies", headers });
    const concurrentReprocess = await app.inject({ method: "POST", url: "/api/replies/" + replies.json().items[0].id + "/reprocess", headers });
    expect(concurrentReprocess.statusCode).toBe(409);
    expect(concurrentReprocess.json()).toMatchObject({ error: "automation_running" });
    const concurrentRepairChange = await app.inject({ method: "POST", url: "/api/locator-repairs/missing/approve", headers });
    expect(concurrentRepairChange.statusCode).toBe(409);
    expect(concurrentRepairChange.json()).toMatchObject({ error: "automation_running" });
    expect((await app.inject({ method: "POST", url: "/api/automation/resume", headers })).json()).toMatchObject({ state: "running" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: "/api/automation/status", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json<{ state: string }>();
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await app.inject({ method: "GET", url: "/api/automation/status", headers: { host, cookie: `tmall_console_session=${cookie}` } })).json()).toMatchObject({ state: "disabled" });
  });

  it("accepts only the fixed Feishu template contract", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/template-sources",
      headers: {
        host,
        origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
        cookie: `tmall_console_session=${cookie}`,
      },
      payload: {
        library: "bad",
        url: "https://example.feishu.cn/base/demo123?table=tablebad123",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      library: "bad",
      schema: {
        fields: ["一级分类", "二级分类", "包含关键词", "回复话术 1…N"],
        fallbackCategory: "通用差评类",
      },
    });
  });

  it("stores the Feishu secret behind a one-use confirmation nonce without echoing it", async () => {
    const mutationHeaders = {
      host,
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      cookie: `tmall_console_session=${cookie}`,
    };
    const settings = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: mutationHeaders,
      payload: { feishuAppId: "cli_test_app" },
    });
    expect(settings.statusCode).toBe(200);

    const prepare = await app.inject({
      method: "POST",
      url: "/api/secrets/feishu_app_secret/prepare",
      headers: mutationHeaders,
      payload: { action: "replace" },
    });
    const { nonce } = prepare.json<{ nonce: string }>();
    const stored = await app.inject({
      method: "PUT",
      url: "/api/secrets/feishu_app_secret",
      headers: mutationHeaders,
      payload: { nonce, secret: "never-echo-this-secret" },
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.body).not.toContain("never-echo-this-secret");

    const current = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { host, cookie: `tmall_console_session=${cookie}` },
    });
    expect(current.json()).toMatchObject({ feishuAppId: "cli_test_app", feishuAppSecretConfigured: true });
    expect(current.body).not.toContain("never-echo-this-secret");

    const replay = await app.inject({
      method: "PUT",
      url: "/api/secrets/feishu_app_secret",
      headers: mutationHeaders,
      payload: { nonce, secret: "another-secret" },
    });
    expect(replay.statusCode).toBe(409);

    const source = await app.inject({
      method: "PUT",
      url: "/api/template-sources",
      headers: mutationHeaders,
      payload: {
        library: "good",
        url: "https://example.feishu.cn/base/demo123?table=tablegood123",
      },
    });
    expect(source.statusCode).toBe(200);
    const connection = await app.inject({
      method: "POST",
      url: "/api/connections/feishu/test",
      headers: mutationHeaders,
      payload: {},
    });
    expect(connection.json()).toMatchObject({ status: "ready" });
    const sync = await app.inject({
      method: "POST",
      url: "/api/template-sources/good/sync",
      headers: mutationHeaders,
      payload: {},
    });
    expect(sync.json()).toMatchObject({ changed: true, categoryCount: 2, replyCount: 2 });
    const categories = await app.inject({
      method: "GET",
      url: "/api/template-sources/good/categories",
      headers: { host, cookie: `tmall_console_session=${cookie}` },
    });
    expect(categories.json().items).toHaveLength(2);
  });

  it("contains no real reply submission endpoint", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/replies/demo-1/submit",
      headers: {
        host,
        origin,
        "sec-fetch-site": "same-origin",
        "x-csrf-token": csrfToken,
        cookie: `tmall_console_session=${cookie}`,
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it("does not expose demo reviews or invented dashboard metrics", async () => {
    const dashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { host, cookie: `tmall_console_session=${cookie}` },
    });
    expect(dashboard.json()).toMatchObject({
      metrics: { todayRead: 0, good: 0, bad: 0, generated: 0, failed: 0, productEdits: 0 },
      queue: [],
      recent: null,
    });
    expect(dashboard.body).not.toContain("demo-");
  });

  it("reports every manual diversion even when more than 200 replies exist", async () => {
    const replies = new ReplyRepository(database);
    for (let index = 0; index < 205; index += 1) {
      const draft = replies.discover({
        sourceKey: `tmall:dashboard-manual:${index}`,
        orderId: String(index),
        review: `Manual dashboard review ${index}`,
        product: `Manual dashboard product ${index}`,
        reviewedAt: "2026-07-15 08:00",
        sentimentLabel: "negative",
        itemId: String(index),
        reviewPhase: "initial",
      });
      database.prepare("UPDATE reply_drafts SET state = 'manual_product_hold' WHERE id = ?").run(draft.id);
    }

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { host, cookie: `tmall_console_session=${cookie}` },
    });
    expect(dashboard.json()).toMatchObject({ manualProducts: { diverted: 205 } });
    expect(dashboard.body).not.toMatch(/revision|lockVersion|manualMatchKind|manualCatalogRevision/iu);
  });

  it("stores and tests DeepSeek without echoing the API key", async () => {
    const mutationHeaders = {
      host,
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      cookie: `tmall_console_session=${cookie}`,
    };
    const prepare = await app.inject({
      method: "POST",
      url: "/api/secrets/deepseek_api_key/prepare",
      headers: mutationHeaders,
      payload: { action: "replace" },
    });
    const stored = await app.inject({
      method: "PUT",
      url: "/api/secrets/deepseek_api_key",
      headers: mutationHeaders,
      payload: { nonce: prepare.json().nonce, secret: "deepseek-secret-never-echo" },
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.body).not.toContain("deepseek-secret-never-echo");

    const tested = await app.inject({
      method: "POST",
      url: "/api/connections/deepseek/test",
      headers: mutationHeaders,
      payload: {},
    });
    expect(tested.json()).toMatchObject({ status: "ready", models: ["deepseek-v4-pro"] });
  });

  it("does not mark DeepSeek ready when the single Pro check fails", async () => {
    deepseekConnectionResult = {
      models: [],
      latencyMs: 18,
      checks: {
        pro: { model: "deepseek-v4-pro", status: "error", detail: "DeepSeek 服务暂时不可用，请稍后重试" },
      },
    };
    const headers = {
      host,
      origin,
      "sec-fetch-site": "same-origin",
      "x-csrf-token": csrfToken,
      cookie: `tmall_console_session=${cookie}`,
    };

    const tested = await app.inject({ method: "POST", url: "/api/connections/deepseek/test", headers });

    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      adapter: "deepseek",
      status: "error",
      checks: {
        pro: { status: "error", detail: "DeepSeek 服务暂时不可用，请稍后重试" },
      },
    });
  });

  it("stores Tmall credentials in the secret store and opens the configured review page", async () => {
    const mutationHeaders = {
      host,
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      cookie: `tmall_console_session=${cookie}`,
    };
    const prepare = await app.inject({
      method: "POST",
      url: "/api/tmall-auth/credentials/prepare",
      headers: mutationHeaders,
      payload: { action: "replace" },
    });
    const stored = await app.inject({
      method: "PUT",
      url: "/api/tmall-auth/credentials",
      headers: mutationHeaders,
      payload: { nonce: prepare.json().nonce, account: "merchant-account", password: "merchant-password" },
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.body).not.toContain("merchant-password");
    expect(stored.json()).toMatchObject({ configured: true, maskedAccount: "me***nt" });

    const open = await app.inject({
      method: "POST",
      url: "/api/tmall-auth/open-review-page",
      headers: mutationHeaders,
      payload: {},
    });
    expect(open.json()).toMatchObject({ state: "authenticated", page: "review_list" });

    const clearPrepare = await app.inject({
      method: "POST",
      url: "/api/tmall-auth/credentials/prepare",
      headers: mutationHeaders,
      payload: { action: "delete" },
    });
    const cleared = await app.inject({
      method: "DELETE",
      url: "/api/tmall-auth/credentials",
      headers: mutationHeaders,
      payload: { nonce: clearPrepare.json().nonce },
    });
    expect(cleared.json()).toEqual({ configured: false });
  });

  it("reuses an authenticated browser session when saved credentials are temporarily unavailable", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    await secretStore.delete("taobao_seller");
    new SettingsRepository(database).set("tmall_verified_store_name", tmallStoreName ?? "");

    const result = await app.inject({ method: "POST", url: "/api/tmall-auth/continue", headers });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ state: "authenticated", page: "review_list" });
    expect(tmallContinueCredentials).toBeUndefined();
    expect(tmallContinueCount).toBe(1);
  });

  it("reports automatic login recovery as enabled whenever credentials are saved", async () => {
    const result = await app.inject({ method: "GET", url: "/api/tmall-auth/status", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(result.json()).toMatchObject({ configured: true, autoReloginEnabled: true });
  });

  it("does not wait for the removed post-login critical element verification", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    tmallCriticalVerificationGate = deferred<void>();
    const pending = app.inject({ method: "POST", url: "/api/tmall-auth/continue", headers });

    const timedResult = await Promise.race([
      pending,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 400)),
    ]);
    tmallCriticalVerificationGate.resolve();
    const settled = await pending;

    expect(timedResult).not.toBeNull();
    expect(settled.json()).toMatchObject({ state: "authenticated" });
    expect(tmallVerifiedScopes).toEqual([]);
    expect(tmallCloseCount).toBe(0);

    const next = await app.inject({ method: "GET", url: "/api/tmall-auth/popup-diagnostics", headers: { host, cookie: `tmall_console_session=${cookie}` } });
    expect(next.statusCode).toBe(501);
    expect(next.json()).toMatchObject({ error: "popup_diagnostics_unavailable" });
  });

  it("ignores obsolete global element verification failures after login succeeds", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    tmallCurrentOperationKey = "review.date.trigger";
    tmallVerificationFailures = [new Error("private browser detail")];

    const result = await app.inject({ method: "POST", url: "/api/tmall-auth/continue", headers });

    expect(result.json()).toMatchObject({ state: "authenticated" });
    expect(result.json().failureOperationKey).toBeUndefined();
    expect(tmallVerifiedScopes).toEqual([]);
    expect(result.body).not.toContain("private browser detail");
  });

  it("uses the authentication deadline only for login recovery", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    tmallOpenGate = deferred<void>();
    tmallCriticalVerificationGate = deferred<void>();
    const pending = app.inject({ method: "POST", url: "/api/tmall-auth/continue", headers });
    setTimeout(() => tmallOpenGate?.resolve(), 70);

    const timedResult = await Promise.race([
      pending,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 145)),
    ]);
    tmallCriticalVerificationGate.resolve();
    const settled = await pending;

    expect(timedResult).not.toBeNull();
    expect(settled.json()).toMatchObject({ state: "authenticated" });
    expect(tmallVerifiedScopes).toEqual([]);
  });

  it("does not compare the authenticated store name with the saved account", async () => {
    const headers = { host, origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const prepared = await app.inject({ method: "POST", url: "/api/tmall-auth/credentials/prepare", headers, payload: { action: "replace" } });
    await app.inject({
      method: "PUT",
      url: "/api/tmall-auth/credentials",
      headers,
      payload: { nonce: prepared.json().nonce, account: "目标旗舰店:客服", password: "password" },
    });

    const result = await app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers, payload: {} });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ state: "authenticated" });
  });

  it("does not require a readable store name for a saved subaccount", async () => {
    tmallStoreName = null;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const prepared = await app.inject({ method: "POST", url: "/api/tmall-auth/credentials/prepare", headers, payload: { action: "replace" } });
    await app.inject({ method: "PUT", url: "/api/tmall-auth/credentials", headers, payload: { nonce: prepared.json().nonce, account: "目标旗舰店:客服", password: "password" } });

    const result = await app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers, payload: {} });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ state: "authenticated" });
  });

  it("does not require a readable store name for the active account", async () => {
    tmallStoreName = null;
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };
    const result = await app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ state: "authenticated" });
  });

  it("never locks a user out after repeated unresolved legacy login results", async () => {
    tmallAuthFailure = "账号或密码错误";
    const headers = { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` };

    const first = await app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers });
    const second = await app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers });
    const third = await app.inject({ method: "POST", url: "/api/tmall-auth/open-review-page", headers });

    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([200, 200, 200]);
    expect(third.body).not.toContain("10分钟");
    expect(tmallOpenCount).toBe(3);
  });

  it("exposes read-only complaint records and their safe status summary", async () => {
    const complaints = new ComplaintRepository(database);
    const replies = new ReplyRepository(database);
    replies.discover({
      sourceKey: "complaint-api-source",
      orderId: "complaint-order",
      review: "买家完整评价：客服态度恶劣，要求平台核对。",
      product: "测试耳机商品",
      reviewedAt: "2026-07-17 08:00",
      sentimentLabel: "negative",
      itemId: "complaint-item",
      reviewPhase: "followup",
    });
    const discovered = complaints.discover("primary", "complaint-api-source", {
      reviewId: "complaint-api-source",
      contentHash: "a".repeat(64),
      canonicalizerVersion: "canonical-v1",
      phase: "followup",
      imagePairs: [],
      promptVersion: "p1",
      ruleVersion: "r1",
      mappingVersion: "m1",
      visualVersion: "v1",
      platformMappingVersion: "platform-v1",
      modelVersion: "m1",
    });
    const noComplaint = complaints.discover("primary", "complaint-api-no-action", {
      reviewId: "complaint-api-no-action",
      contentHash: "b".repeat(64),
      canonicalizerVersion: "canonical-v1",
      phase: "initial",
      imagePairs: [],
      promptVersion: "p1",
      ruleVersion: "r1",
      mappingVersion: "m1",
      visualVersion: "v1",
      platformMappingVersion: "platform-v1",
      modelVersion: "m1",
    });
    complaints.markManualActionRequired(discovered.id, "manual_required");
    complaints.finalizeNoComplaint(noComplaint.id, 90, "普通使用反馈，不符合官方投诉类型", { reviewStillReplyable: true });
    const headers = { host, cookie: `tmall_console_session=${cookie}` };
    const list = await app.inject({ method: "GET", url: "/api/complaints", headers });
    const summary = await app.inject({ method: "GET", url: "/api/complaints/status-summary", headers });
    const detail = await app.inject({ method: "GET", url: `/api/complaints/${discovered.id}`, headers });

    expect(list.statusCode).toBe(200);
    // A review with no official complaint type is not a complaint, even if
    // an older run left it in a technical manual-action state. It belongs in
    // diagnostics/reply handling, never in the merchant's complaint list.
    expect(list.json()).toMatchObject({ total: 0, items: [] });
    expect(summary.json()).toMatchObject({ total: 0, unresolved: 0, noComplaint: 0 });
    expect(detail.statusCode).toBe(404);
  });

  it("deletes one visible unsubmitted complaint and allows the review to run again", async () => {
    const sourceKey = "complaint-api-delete-one";
    const replies = new ReplyRepository(database);
    replies.discover({
      sourceKey, orderId: "complaint-delete-order", review: "吧哈哈哈广告费风风光光vvvv发纷纷扰扰", product: "测试商品",
      reviewedAt: "2026-07-20 10:30", sentimentLabel: "unknown", itemId: "complaint-delete-item", reviewPhase: "initial",
    });
    const complaints = new ComplaintRepository(database);
    const complaint = complaints.discover("primary", sourceKey, {
      reviewId: sourceKey, contentHash: "c".repeat(64), canonicalizerVersion: "canonical-v1", phase: "initial", imagePairs: [],
      promptVersion: "p1", ruleVersion: "r1", mappingVersion: "m1", visualVersion: "v1",
      platformMappingVersion: "platform-v1", modelVersion: "m1",
    });
    database.prepare("UPDATE complaint_cases SET state = 'failed', complaint_type = 'meaningless_content', error_code = 'timeout' WHERE id = ?").run(complaint.id);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/complaints/${complaint.id}`,
      headers: { host, origin, "sec-fetch-site": "same-origin", "x-csrf-token": csrfToken, cookie: `tmall_console_session=${cookie}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ removed: true, mode: "reprocess", reprocessable: true });
    expect(database.prepare("SELECT COUNT(*) AS value FROM complaint_cases WHERE source_key = ?").get(sourceKey)).toEqual({ value: 0 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_drafts WHERE source_key = ?").get(sourceKey)).toEqual({ value: 0 });
  });
});
