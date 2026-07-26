# 回复结果完整分页与未成功记录清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 本任务按用户要求在当前会话内执行，不使用子智能体。

**Goal:** 让回复结果显示保留期内的全部数据，并支持服务端筛选、分页以及一键删除全部未发送成功记录。

**Architecture:** 在 `ReplyRepository` 增加参数化分页查询，API 只负责校验和序列化；批量清理由 `OperatorRecordCleanup` 事务化完成，保证关联记录与动作锁一致清理。前端使用 React Query 将页码、搜索词和筛选条件纳入查询键。

**Tech Stack:** TypeScript、Fastify、better-sqlite3、React、TanStack Query、Vitest、Testing Library。

---

### Task 1: 回复仓储分页查询

**Files:**
- Modify: `apps/server/src/storage/repositories.ts`
- Test: `apps/server/src/storage/database.test.ts`

- [ ] 写失败测试：创建 205 条记录，验证第 5 页、真实总数、搜索和状态/评价类型筛选。
- [ ] 运行定向测试并确认因 `listPage` 尚不存在而失败。
- [ ] 实现 `ReplyRepository.listPage`，使用参数化 SQL、稳定排序和页码归一化。
- [ ] 运行定向测试并确认通过。

### Task 2: 全部非成功记录批量清理

**Files:**
- Modify: `apps/server/src/storage/operator-record-cleanup.ts`
- Test: `apps/server/src/storage/operator-record-cleanup.test.ts`

- [ ] 写失败测试：混合 `sent`、`failed`、`retry_wait`、`submitting`、`submission_uncertain` 等状态。
- [ ] 验证测试因批量清理方法不存在而失败。
- [ ] 实现事务化 `removeReplyRecords("unsent" | "sent")`。
- [ ] 验证 `unsent` 删除所有非 `sent` 及其未完成关联数据，`sent` 清理时保留防重复终结标记。
- [ ] 运行仓储测试并确认通过。

### Task 3: 回复结果 API

**Files:**
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/app.test.ts`

- [ ] 写失败测试：分页、搜索、筛选、越界页以及 `scope=unsent` 清理。
- [ ] 运行定向测试并确认当前接口固定返回 200 条且不识别 scope。
- [ ] 将 `GET /api/replies` 接入 `listPage`。
- [ ] 将 `DELETE /api/storage/reviews` 接入明确的 `sent`/`unsent` 批量清理。
- [ ] 保留自动任务运行时的 409 保护和旧调用兼容。
- [ ] 运行接口测试并确认通过。

### Task 4: 回复结果前端

**Files:**
- Modify: `apps/web/src/pages/replies.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/pages/replies.test.tsx`

- [ ] 写失败测试：查询参数、发送状态筛选、翻页、总数和“清理未成功记录”。
- [ ] 运行测试并确认因控件或请求参数缺失而失败。
- [ ] 将搜索词做短延迟提交并纳入 React Query 查询键。
- [ ] 增加服务端筛选、分页控件、真实总数，保留“清理已完成记录”并新增“清理未成功记录”。
- [ ] 清理成功后回到第一页并刷新回复、仪表盘和存储统计。
- [ ] 运行前端测试并确认通过。

### Task 5: 回归与交付

**Files:**
- Verify: `apps/server/src`
- Verify: `apps/web/src`

- [ ] 运行回复仓储、清理、API 和页面定向测试。
- [ ] 运行服务端全量测试（排除当前 Windows 非交互凭据环境项）。
- [ ] 运行前端全量测试、类型检查和生产构建。
- [ ] 启动本地程序检查回复结果接口与页面。
- [ ] 如用户需要新安装包，再以保留数据和浏览器资料的方式生成下一版本压缩包。
