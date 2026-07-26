# DeepSeek Timeout and Retry State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 DeepSeek 单次超时统一为 60 秒，并让投诉预审失败和回复结果页准确表达可恢复的待重试状态。

**Architecture:** 继续使用 `DeepSeekClient` 的单一超时入口覆盖投诉、分类、情感复核和改写；在草稿处理器接收投诉策略错误时写入现有 AI 重试字段；前端从草稿状态和失败阶段派生状态标签与详情提示。

**Tech Stack:** TypeScript, Fastify, React, Vitest, Testing Library, SQLite

---

### Task 1: 统一 DeepSeek 超时

**Files:**
- Modify: `apps/server/src/deepseek/client.ts`
- Test: `apps/server/src/deepseek/client.test.ts`

- [ ] 写一个捕获默认 `AbortSignal` 60 秒超时的失败测试。
- [ ] 运行测试并确认当前 10 秒实现失败。
- [ ] 将默认超时改为 60 秒并通过测试。

### Task 2: 投诉预审失败进入 AI 待重试

**Files:**
- Modify: `apps/server/src/drafts/processor.ts`
- Modify as needed: `apps/server/src/complaints/complaint-review-service.ts`
- Test: `apps/server/src/drafts/processor.test.ts`

- [ ] 写失败测试，证明投诉策略返回超时错误后草稿不是 `discovered`。
- [ ] 将失败种类传回处理器并调用现有 `recordRoundFailure`。
- [ ] 验证手动运行和下次运行能够认领该记录。

### Task 3: 展示真实处理状态

**Files:**
- Modify: `apps/web/src/pages/replies.tsx`
- Test: `apps/web/src/app.test.tsx`

- [ ] 写失败测试，证明 `discovered` 不显示“回复已生成”。
- [ ] 写失败测试，证明 `retry_wait` 显示失败阶段与超时原因。
- [ ] 实现状态文案映射并通过测试。

### Task 4: 验证与打包

**Files:**
- Generated: `release/*.zip`

- [ ] 运行服务器和前端针对性测试。
- [ ] 运行 `npm test`、`npm run typecheck`、`npm run build`。
- [ ] 运行含本地数据且无扩展的 Windows 打包流程。
- [ ] 校验 ZIP 大小、时间和 SHA256。
