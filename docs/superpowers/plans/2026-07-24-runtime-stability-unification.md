# 天猫回复与 DeepSeek 运行稳定性统一修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本次按用户要求不使用子智能体，由当前会话逐项执行。

**Goal:** 消除独立元素验证和双模型可用性造成的误暂停，并确保提交后网络中断不会被误记为失败。

**Architecture:** 天猫运行只在每条正式提交前进行局部目标校验，页面读取异常由有限重读吸收，提交状态以点击边界和后续平台记录协调。DeepSeek 客户端统一使用 Pro，并在连接测试中仅对瞬时错误进行有限重试。

**Tech Stack:** TypeScript、Fastify、Playwright/Patchright、Vitest、React、SQLite、Node.js Windows 打包脚本。

---

### Task 1: 移除独立元素验证运行门

**Files:**
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/app.test.ts`
- Modify: `apps/web/src/pages/run-center.tsx`
- Test: `apps/web/src/app.test.tsx`

- [ ] 写失败测试：已登录且基础配置完整时，不因 locator 历史状态阻止自动运行。
- [ ] 运行相关服务端测试，确认旧行为导致失败。
- [ ] 删除启动和逐条处理前的 `verifyCriticalElements` 阻断，仅保留正式提交内部校验。
- [ ] 删除运行中心元素健康异常卡片依赖。
- [ ] 运行相关服务端和前端测试确认通过。

### Task 2: 页面半加载有限重读

**Files:**
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/app.test.ts`

- [ ] 写失败测试：首次 `TmallReviewPageStateError`、第二次成功时继续处理。
- [ ] 写失败测试：连续失败时暂停但不增加评价处理失败数。
- [ ] 运行测试确认失败原因来自当前立即暂停行为。
- [ ] 实现条件明确、次数有限的页面重读和短等待。
- [ ] 运行测试确认两种场景通过。

### Task 3: 提交点击边界和平台结果协调

**Files:**
- Modify: `apps/server/src/submission/service.ts`
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/server/src/drafts/processor.ts`
- Test: `apps/server/src/submission/service.test.ts`
- Test: `apps/server/src/drafts/processor.test.ts`

- [ ] 写失败测试：点击边界之后任何异常只能生成 `submission_uncertain`。
- [ ] 写失败测试：平台读取到 `reply_record` 时将不确定或旧失败记录协调为 `sent`。
- [ ] 写失败测试：目标从未回复列表消失不创建确定失败结论。
- [ ] 运行测试确认失败。
- [ ] 实现最小状态转换与平台协调。
- [ ] 运行 submission、processor 和 repository 测试确认通过。

### Task 4: DeepSeek 单一 Pro 模型

**Files:**
- Modify: `apps/server/src/deepseek/client.ts`
- Test: `apps/server/src/deepseek/client.test.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/app.test.ts`
- Modify: `apps/web/src/pages/settings.tsx`
- Test: `apps/web/src/app.test.tsx`

- [ ] 写失败测试：所有业务请求只使用 `deepseek-v4-pro`。
- [ ] 写失败测试：连接测试只验证 Pro。
- [ ] 写失败测试：Pro 首次 5xx/429/超时后成功时验证通过。
- [ ] 运行测试确认旧双模型行为失败。
- [ ] 统一模型配置并实现瞬时连接测试重试。
- [ ] 更新设置页单模型文案和结果结构。
- [ ] 运行 DeepSeek、接口和设置页测试确认通过。

### Task 5: 全量验证和含数据打包

**Files:**
- Modify only if required by verified packaging failure: `scripts/package-windows.mjs`
- Output: `release-final-20260724/`
- Output: `release-final-20260724.zip`

- [ ] 运行 `npm test`。
- [ ] 运行 `npm run typecheck`。
- [ ] 运行 `npm run build`。
- [ ] 备份当前发布数据库并核对仅保留成功历史。
- [ ] 使用 `npm run package:windows:local` 生成包含当前数据和浏览器状态的发布目录。
- [ ] 冷启动发布版，核对状态、话术和数据库。
- [ ] 生成 ZIP，执行 CRC、数据库哈希和必要文件校验。
