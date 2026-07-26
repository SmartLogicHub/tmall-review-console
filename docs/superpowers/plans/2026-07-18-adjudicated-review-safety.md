# 投诉与好差评多轮裁决 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复当前自动回复主流程回归，实现投诉独立二审与第三次裁决、好差评风险二审与第三次裁决，并产出通过完整验收的 Windows 便携版。

**Architecture:** 保留现有 `DraftProcessor`、`ComplaintReviewService`、DeepSeek 客户端和动作锁边界。新增纯粹的情感裁决器，把第二/第三轮模型调用与业务流程分离；投诉服务把第一、第二、第三轮结构化结果解析为唯一最终结果后，仍交给既有确定性事实校验。人工处理商品名单在投诉前执行，名单中差评直接内部跳过，名单好评才继续投诉与回复流程。

**Tech Stack:** TypeScript 7、Vitest、Fastify、React/Vite、Playwright/Patchright、SQLite、DeepSeek JSON API、.NET Windows launcher

**Design spec:** `docs/superpowers/specs/2026-07-18-adjudicated-review-safety-design.md`

**Dirty worktree note:** 相关源文件已经包含上一任务留下的同范围未提交修改。实施时逐文件核对 diff，不覆盖这些修改；等完整回归通过后再统一提交同一功能范围，避免把重叠文件的一部分误当成无关改动丢失。

---

### Task 1: 修复测试集成根因并恢复可信基线

**Files:**
- Modify: `apps/server/src/app.test.ts`
- Verify: `apps/server/src/app.ts:663-678`

当前 22 项自动回复回归的共同根因已定位：`buildApp` 在 AI 适配器没有 `analyzeComplaint` 时创建 `UnavailableComplaintReviewPolicy`，所有评价在提交前变成 `manual_action_required`；默认 `app.test.ts` AI 假实现遗漏了该方法，因此提交计数全部为 0。这是测试集成夹具缺口，不应通过放宽生产安全策略解决。

- [ ] **Step 1: 重新运行一个现有失败用例，确认 RED 基线**

Run from `apps/server`:

```powershell
npx.cmd vitest run src/app.test.ts -t "runs the formal automation pipeline through generation, one safe submission and durable idempotency"
```

Expected: FAIL，`tmallSubmitCount` 期望 1、实际 0。

- [ ] **Step 2: 给默认测试 AI 增加明确的无投诉结构化结果**

在 `app.test.ts` 的默认 `deepseekFactory` 假实现中加入：

```ts
analyzeComplaint: async () => ({
  decision: "no_complaint" as const,
  complaintType: "none" as const,
  confidence: 98,
  quoteStart: null,
  quoteEnd: null,
  factCode: "none" as const,
  reason: "测试评价不符合官方投诉类型",
}),
```

不得修改 `UnavailableComplaintReviewPolicy` 的生产失败关闭行为。

- [ ] **Step 3: 运行单测确认 GREEN**

```powershell
npx.cmd vitest run src/app.test.ts -t "runs the formal automation pipeline through generation, one safe submission and durable idempotency"
```

Expected: PASS。

- [ ] **Step 4: 运行完整 app 集成测试，记录仍存在的独立失败**

```powershell
npx.cmd vitest run src/app.test.ts
```

Expected: 原 22 项共同失败消失；如有剩余失败，逐项保存最小复现，不进行批量猜测式修改。

---

### Task 2: 建立可复用的好差评风险二审与第三次裁决器

**Files:**
- Create: `apps/server/src/deepseek/review-sentiment-adjudication.ts`
- Create: `apps/server/src/deepseek/review-sentiment-adjudication.test.ts`
- Modify: `apps/server/src/deepseek/client.ts`
- Modify: `apps/server/src/deepseek/client.test.ts`

- [ ] **Step 1: 为风险触发和三轮状态机写失败测试**

测试必须覆盖：

```ts
it("does not audit an explicit high-confidence positive review", ...);
it("audits a positive result below 0.90 confidence", ...);
it("audits a positive result containing a deterministic negative-risk signal", ...);
it("accepts two positive decisions without adjudication", ...);
it("adjudicates primary-positive and reviewer-negative results", ...);
it("sends a neutral independent review to adjudication and accepts a valid final negative", ...);
it("rejects a neutral or otherwise invalid adjudication as a model contract error", ...);
```

裁决器期望接口：

```ts
export interface SentimentVerdict {
  sentiment: "positive" | "negative";
  confidence: number;
  reason: string;
}

export async function resolvePositiveRiskSentiment(input: {
  review: string;
  product: string;
  reviewPhase: "initial" | "followup";
  primary: SentimentVerdict;
  model: Required<Pick<DeepSeekClientApi, "reviewSentiment" | "adjudicateSentiment">>;
}): Promise<SentimentVerdict>;
```

- [ ] **Step 2: 运行新测试并确认 RED**

```powershell
npx.cmd vitest run src/deepseek/review-sentiment-adjudication.test.ts
```

Expected: FAIL，因为模块/接口尚不存在。

- [ ] **Step 3: 实现最小风险规则和裁决状态机**

将当前 `DraftProcessor.requiresIndependentNegativeAudit` 的确定性规则迁入新模块。触发条件固定为：第一轮为 positive 且置信度 `< 0.90`，或评价命中转折、后悔、勉强接受、价值否定、具体问题、反讽风险词。第一轮已为 negative 时直接返回 negative。

第二轮只接收评价、商品和阶段，不接收第一轮理由。第二轮为 positive 时返回 positive；第二轮为 negative/neutral 时调用第三轮。第三轮合同只允许 positive/negative；neutral、未知字段或非法 JSON 属于模型合同错误，进入现有有界重试，不能伪装成有效 negative。只有有效的第三轮 negative 才作为最终差评。

- [ ] **Step 4: 为 DeepSeek 第二轮和第三轮提示词写失败测试**

在 `client.test.ts` 断言：

- `reviewSentiment` 使用独立复核系统提示词，user JSON 不包含 primary reason。
- `adjudicateSentiment` 使用第三套裁决提示词，接收两份结构化结论，输出仅允许 positive/negative。
- 两个方法均使用低温度和严格 JSON 解析。

- [ ] **Step 5: 扩展 DeepSeekClientApi 并实现两个模型方法**

在 `client.ts` 新增：

```ts
reviewSentiment?(input: SentimentDeterminationInput): Promise<SentimentDetermination>;
adjudicateSentiment?(input: SentimentAdjudicationInput): Promise<SentimentVerdict>;
```

保留既有 `determineSentiment` 作为名单商品缺少情感时的第一轮，不改变其现有调用合同。

- [ ] **Step 6: 运行新模块与 DeepSeek 客户端测试**

```powershell
npx.cmd vitest run src/deepseek/review-sentiment-adjudication.test.ts src/deepseek/client.test.ts
```

Expected: PASS。

---

### Task 3: 把名单商品优先级和情感裁决接入 DraftProcessor

**Files:**
- Modify: `apps/server/src/drafts/processor.ts`
- Modify: `apps/server/src/drafts/processor.test.ts`
- Modify: `apps/server/src/manual-products/policy-service.ts`
- Modify: `apps/server/src/manual-products/policy-service.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/web/src/pages/manual-products.tsx`
- Modify: `apps/web/src/pages/manual-products.test.tsx`

- [ ] **Step 1: 写名单优先级失败测试**

新增集成断言：

```ts
it("skips a listed negative review before any complaint call", ...);
it("classifies an unknown listed review before complaint and skips a final negative", ...);
it("continues a listed final positive review into complaint and reply handling", ...);
it("applies the list-first rule when an operator reprocesses an existing review", ...);
```

第一、第二个测试必须使用 complaint spy 并断言调用次数为 0；第三个断言 complaint 在名单情感裁决结束后调用一次。

- [ ] **Step 2: 运行失败测试确认当前顺序错误**

```powershell
npx.cmd vitest run src/drafts/processor.test.ts src/manual-products/policy-service.test.ts
```

Expected: 新增的“名单先于投诉”测试 FAIL，因为当前 `DraftProcessor` 先调用 complaint policy。

- [ ] **Step 3: 移动名单策略到投诉策略之前**

在 `DraftProcessor.#process` 中按以下固定顺序执行：

1. 未冻结模板时执行 manual product policy；
2. `manual_hold` 立即返回 completed/skipped，不触发投诉；
3. continue 后刷新 record；
4. 再执行 complaint policy；
5. 最后执行模板分类和回复。

保持 claimed retry、pause、action gate 和 `template_selected` checkpoint 的现有语义。

- [ ] **Step 4: 在名单情感未知且初判 positive 时复用风险裁决器**

`ManualProductPolicyService` 先调用 `determineSentiment`。结果为 neutral/negative 立即内部 hold；结果为 positive 时调用 `resolvePositiveRiskSentiment`，最终 negative 仍内部 hold，最终 positive 才 continue。技术故障继续抛给现有有界 AI 重试，不当作语义冲突。

- [ ] **Step 5: 在普通模板分类中复用风险裁决器**

删除 `DraftProcessor` 内重复的风险函数。将 `classifyReview` 返回的 good/bad 映射为 primary positive/negative；需要复核时调用共享裁决器。最终 negative 固定进入差评库 fallback category，最终 positive 保留第一轮好评分类。

- [ ] **Step 6: 修正名单页面的用户可见文案**

页面仍命名“人工处理商品”，但说明改为：

> 命中的中评和差评会由自动流程直接跳过，不生成回复或提交投诉；好评继续自动处理。

不得显示“转人工队列”或暗示用户还需逐条判断。

- [ ] **Step 7: 修复单条重新处理入口的名单策略 wiring**

在 `/api/replies/:id/reprocess` 中与正式自动运行使用相同的 `ManualProductPolicyService`，同时传入 manual policy 和 complaint policy；不得构造缺少名单策略的 `DraftProcessor`。集成测试先发现评价、随后把商品加入名单，再调用 reprocess，并断言名单中差评没有投诉或回复动作。

- [ ] **Step 8: 运行名单、草稿、重处理接口和页面测试**

```powershell
npx.cmd vitest run src/drafts/processor.test.ts src/manual-products/policy-service.test.ts
npx.cmd vitest run src/app.test.ts -t "reprocess"
npx.cmd vitest run src/pages/manual-products.test.tsx
```

Expected: PASS。

---

### Task 4: 实现投诉独立二审与第三次裁决

**Files:**
- Modify: `apps/server/src/complaints/deepseek-complaint-analysis.ts`
- Modify: `apps/server/src/complaints/deepseek-complaint-analysis.test.ts`
- Modify: `apps/server/src/complaints/complaint-domain.ts`
- Modify: `apps/server/src/complaints/complaint-domain.test.ts`
- Modify: `apps/server/src/storage/complaint-repository.ts`
- Modify: `apps/server/src/storage/complaint-repository.test.ts`
- Modify: `apps/server/src/complaints/complaint-review-service.ts`
- Modify: `apps/server/src/complaints/complaint-review-service.test.ts`
- Modify: `apps/server/src/deepseek/client.ts`
- Modify: `apps/server/src/deepseek/client.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: 写三轮投诉状态机失败测试**

覆盖：

```ts
it("uses an independent review pass that receives no primary reason", ...);
it("submits a hard-validated candidate when primary and review match exactly", ...);
it("calls adjudication when decision, type, fact code or quote range conflicts", ...);
it("accepts an adjudicated candidate only when it matches one earlier pass", ...);
it("continues to sentiment when adjudication returns no complaint", ...);
it("continues to sentiment when a candidate lacks deterministic facts", ...);
it("always runs the primary complaint pass for mixed praise and reportable content", ...);
it("retries complaint model failures through the existing AI retry policy", ...);
it("stops the run after two complaint API failures without asking the user to judge", ...);
it("reopens a pre-submit technical failure on the next run", ...);
```

- [ ] **Step 2: 运行投诉测试确认 RED**

```powershell
npx.cmd vitest run src/complaints/complaint-review-service.test.ts src/complaints/deepseek-complaint-analysis.test.ts
```

Expected: 新的 pass/adjudication 断言 FAIL；现有双调用测试不能证明独立提示词。

- [ ] **Step 3: 给 ComplaintAnalysisInput 增加明确 pass 合同**

```ts
type ComplaintAnalysisPass = "primary" | "independent_review" | "adjudication";

interface ComplaintAnalysisInput {
  pass: ComplaintAnalysisPass;
  review: RedactedComplaintAnalysisText;
  officialTypes: readonly ComplaintTypeCode[];
  productName?: string;
  orderFacts?: Record<string, string | null>;
  priorResults?: readonly ComplaintModelResult[];
}
```

`priorResults` 只允许 adjudication 使用；independent_review 的请求体不得包含第一轮 reason/result。

- [ ] **Step 4: 增加独立审查和裁决系统提示词并接入客户端**

`DeepSeekClient.analyzeComplaint` 根据 pass 选择三个不同常量。primary 与 independent_review 都只发送评价、商品、事实和官方类型；adjudication 额外发送两份结构化结果。三者继续经过 `parseComplaintModelResult`。

- [ ] **Step 5: 把 verifier 改为返回最终模型结果和事实**

将现有 `createDoubleAnalysisEligibilityVerifier` 替换为 `createAdjudicatedComplaintEligibilityVerifier`，返回：

```ts
interface ComplaintEligibilityReview {
  finalResult: ComplaintModelResult;
  facts: ComplaintEligibilityFacts;
}
```

规则：primary no_complaint 不调用第二轮；primary candidate 调 independent_review；完全相同则使用两份确认；冲突则调 adjudication；裁决 candidate 必须与前两轮至少一份在 decision/type/factCode/quoteStart/quoteEnd 上完全一致，否则转为确定的 no_complaint。事实提取只基于最终候选的原文引用。

- [ ] **Step 6: 修改确认合同并加强程序硬校验**

在 `ComplaintEligibilityFacts` 增加 `adjudicationConfirmation`。把确认组合校验导出为一个由 domain 与 repository 共同调用的函数，避免两处规则漂移。确认规则只接受两种明确组合：

1. primary 与 independent_review 都完全匹配最终候选；或
2. adjudication 完全匹配最终候选，并且 primary/independent_review 至少一份也完全匹配。

不得复制同一结果伪造两份确认。`ComplaintRepository.recordValidatedCandidate` 删除硬编码的 primary+independent 判断，改用同一个导出校验函数，并增加存储层测试证明“裁决 + 前轮之一”可以持久化、单一确认或复制确认不能持久化。

`ComplaintReviewService` 必须用 `finalResult` 调 `validateComplaintAnalysis`。没有该类型所需客观事实时最终落为 no_complaint 并继续普通分类；不得填写投诉描述或点击提交。合法候选仍通过现有 action gate、beforeSubmit checkpoint 和不确定提交保护。

同时删除 `ComplaintReviewService.isClearlyPositivePraise` 的首轮旁路。除名单中差评已提前跳过外，每条评价都必须运行投诉 primary；混合称赞与广告/引流等内容不得被关键词快捷放行。

投诉分析使用 complaint case 自己持有的动作锁，不复用 reply retry 锁。为每次 primary、independent_review、adjudication 模型调用增加 complaint-native 有界重试：网络、超时或模型合同错误等待后再调用一次；第二次仍失败时原子把 pre-submit complaint case 标为 `failed`，保留 complaint 锁，并返回新的 `ComplaintReviewDecision.action = "error"`。配置缺失不做无意义重试，直接标记技术失败。

`DraftProcessor` 收到 complaint `error` 时返回 `circuit_breaker`，使当前自动运行进入错误/暂停状态；不得写 reply retry、不得转人工、不得生成回复或提交投诉。`ComplaintRepository` 新增 `reopenFailedAnalysis`：仅允许 `failed`、`complaint_type IS NULL`、无提交 attempt 且 complaint 锁版本仍一致的 case 回到 `discovered`。下次用户继续/重新运行时 `ComplaintReviewService.evaluate` 自动调用该方法并重新分析。

浏览器已经进入投诉提交阶段后的失败仍保留现有 manual/submission_uncertain 防重复语义，绝不由分析重试路径重新点击。

- [ ] **Step 7: 更新 app/index 正式 wiring**

正式运行和 `buildApp` 默认集成都使用新的 adjudicated verifier。删除旧双审命名，避免测试通过但生产仍调用旧路径。

- [ ] **Step 8: 运行全部投诉专项测试**

```powershell
npx.cmd vitest run src/complaints/complaint-domain.test.ts src/complaints/deepseek-complaint-analysis.test.ts src/complaints/complaint-review-service.test.ts src/complaints/complaint-browser-flow.test.ts src/complaints/tmall-complaint-dom-adapter.test.ts src/deepseek/client.test.ts
```

Expected: PASS。

---

### Task 5: 回归自适应队列、追评阶段和浏览器恢复

**Files:**
- Verify/modify only if a failing test proves the need:
  - `apps/server/src/automation/queue-drainer.ts`
  - `apps/server/src/automation/queue-drainer.test.ts`
  - `apps/server/src/tmall/auth-driver.ts`
  - `apps/server/src/tmall/auth-driver.test.ts`
  - `apps/server/src/tmall/review-filter.ts`
  - `apps/server/src/tmall/review-filter.test.ts`
  - `apps/server/src/app.ts`
  - `apps/server/src/app.test.ts`

- [ ] **Step 1: 运行小批次、实时新增和阶段串行测试**

```powershell
npx.cmd vitest run src/automation/queue-drainer.test.ts src/tmall/review-filter.test.ts src/tmall/auth-driver.test.ts
```

Expected: PASS；确认每 5 条自适应刷新、旧评价不会被实时新增饿死、日期先于模式、初评/追评串行。

- [ ] **Step 2: 运行完整服务端测试**

```powershell
npx.cmd vitest run src
```

Expected: 仅可能剩下正在运行旧 EXE 导致的 4 项 single-instance 失败。任何其他失败必须先用单个 `-t` 用例稳定复现，再写/保留失败测试并做最小修复。

- [ ] **Step 3: 在关闭旧 EXE 前单独记录互斥锁失败**

```powershell
npx.cmd vitest run src/single-instance.test.ts
```

如果旧版仍在运行，Expected: mutex acquire 相关失败；此时不修改单实例生产代码。

---

### Task 6: 完整验证源代码

**Files:**
- Verify all workspaces

- [ ] **Step 1: 关闭精确识别的旧发行版实例**

先按进程可执行文件绝对路径确认目标属于 `release\天猫智能回复`，再关闭旧 launcher/server。不得按模糊进程名终止其他 Node 或浏览器进程。

- [ ] **Step 2: 重新运行单实例测试**

```powershell
npx.cmd vitest run src/single-instance.test.ts
```

Expected: 6/6 PASS。

- [ ] **Step 3: 运行项目全量测试**

From worktree root:

```powershell
npm.cmd test
```

Expected: exit 0，所有 workspace 0 failures。

- [ ] **Step 4: 运行类型检查和生产构建**

```powershell
npm.cmd run typecheck
npm.cmd run build
```

Expected: 两条命令均 exit 0。

- [ ] **Step 5: 运行端到端测试**

```powershell
npm.cmd run test:e2e
```

Expected: exit 0；导航、配置、名单页面、投诉页面、桌面和窄屏布局通过。

- [ ] **Step 6: 检查最终 diff**

```powershell
git diff --check
git status --short
```

Expected: 无冲突标记或 whitespace error；仅保留已知的本任务文件。

---

### Task 7: 重新打包并验证 Windows EXE

**Files:**
- Verify: `scripts/package-windows.mjs`
- Verify: `scripts/package-windows.test.mjs`
- Output: `release/天猫智能回复/`

- [ ] **Step 1: 生成不带本地状态的正式便携版**

```powershell
npm.cmd run package:windows
```

Expected: exit 0，重新创建 `release/天猫智能回复`；不得使用 `package:windows:local`。

- [ ] **Step 2: 验证发行目录结构**

```powershell
& 'release\天猫智能回复\天猫评论助手.exe' --check-layout
```

Expected: exit 0。检查 `release.json` 的 `includesLocalState` 为 false，发行包不包含 `.env`、SQLite WAL/SHM、浏览器 profile 或测试文件。

- [ ] **Step 3: 从新 EXE 启动并做健康检查**

启动新 EXE，按条件轮询 `http://127.0.0.1:4300/api/bootstrap`，要求 200 且返回 csrfToken。再次启动同一 EXE，确认只打开既有控制台、不创建第二个服务实例。

- [ ] **Step 4: 对打包版执行安全冒烟**

验证工作台、回复结果、投诉记录、话术库、人工处理商品、设置六个入口可加载；确认名单说明为“中差评直接跳过，好评继续”；不向真实天猫提交测试回复或投诉。

- [ ] **Step 5: 安全退出新实例并确认互斥锁释放**

通过 launcher 托盘退出或精确 launcher 路径关闭实例，确认端口 4300 释放，再运行一次 `single-instance.test.ts`。

- [ ] **Step 6: 最终提交**

全量与打包验收全部通过后，核对并提交同一功能范围的剩余修改：

```powershell
git add apps packages docs scripts package.json package-lock.json
git commit -m "feat: complete adjudicated review automation"
```

提交前再次检查暂存 diff，排除 `.playwright-*`、`.pnpm-store`、`release`、运行数据、日志和凭据。
