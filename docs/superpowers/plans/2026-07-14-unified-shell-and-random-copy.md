# 统一页面外壳与随机话术说明 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复桌面端页面像被分割且滚动不连贯的问题，移除固定品牌与店铺名称，并用测试和界面文案准确表达“不同评价独立随机、同一评价不重复提交”。

**Architecture:** 保留 React Router 页面结构和现有回复处理器，仅把应用外壳收敛为单一文档滚动模型。业务层继续以 `sourceKey` 实现评价幂等，并通过可注入 `pickIndex` 的测试证明每个新评价都会独立执行随机选择。

**Tech Stack:** React 19、React Router、TypeScript、Vitest、Testing Library、Playwright、CSS

---

### Task 1: 用测试锁定通用品牌和随机语义

**Files:**
- Modify: `apps/web/src/app.test.tsx`
- Modify: `apps/server/src/drafts/processor.test.ts`

- [x] 在 Web 测试中断言显示“评论助手”“自动回复控制台”，且不显示固定品牌、固定店铺和旧顶栏名称。
- [x] 在话术库页面测试中断言新的随机与防重复说明可见。
- [x] 在处理器测试中注入连续随机序列，让两个不同 `sourceKey` 分别选中不同序号的话术。
- [x] 再次处理其中一个 `sourceKey`，断言随机函数与 DeepSeek 均未再次调用。
- [x] 运行 `npm.cmd test -w apps/web -- src/app.test.tsx`，确认新增品牌与文案用例在实现前失败。
- [x] 运行 `npm.cmd test -w apps/server -- src/drafts/processor.test.ts`，确认“不同新评价独立随机、自动重扫不重抽”回归用例通过。

### Task 2: 合并页面外壳并删除固定品牌

**Files:**
- Modify: `apps/web/src/components/shell.tsx`
- Modify: `apps/web/src/styles.css`

- [x] 删除 `Shell` 中没有操作价值的顶栏。
- [x] 将侧栏品牌改为“评 / 评论助手 / 自动回复控制台”。
- [x] 合并前后重复的 `.app-frame`、`.sidebar`、`.workspace`、`.page-scroll` 规则。
- [x] 桌面端改为内容自然撑高、浏览器统一滚动、侧栏非固定。
- [x] 保留窄屏顶部导航能力，清除已经无组件对应的顶栏响应式样式。
- [x] 运行 `npm.cmd test -w apps/web -- src/app.test.tsx` 和 `npm.cmd run typecheck -w apps/web`。

### Task 3: 修正话术库的用户说明

**Files:**
- Modify: `apps/web/src/pages/templates.tsx`
- Test: `apps/web/src/app.test.tsx`

- [x] 在话术库格式说明中加入“每条新评价独立随机、同一评价不重复提交”的完整文案。
- [x] 检查文案不暗示话术只能使用一次，也不暴露 `sourceKey` 等开发者术语。
- [x] 运行 Web 单元测试确认文案与导航回归通过。

### Task 4: 浏览器视觉检查与全量回归

**Files:**
- Modify: `tests/e2e/console.spec.ts`
- Verify: `output/playwright/`

- [x] 增加桌面端页面滚动断言：记录侧栏 `getBoundingClientRect().top`，执行 `window.scrollTo` 后断言其随文档移动；同时断言 `.page-scroll` 没有 `overflow-y:auto/scroll` 及独立可滚动高度。
- [x] 增加固定品牌名称不存在和新随机说明存在的端到端断言。
- [x] 在 1366×768 与 760×900 下断言 `scrollWidth <= clientWidth + 1`，生成截图并检查页面整体性、间距和导航。
- [x] 运行 `npm.cmd run typecheck`。
- [x] 运行 `npm.cmd test`。
- [x] 运行 `npm.cmd run build`。
- [x] 运行 `npm.cmd run test:e2e`。
- [x] 扫描 `apps/web/src/components/shell.tsx` 和静态外壳文案，确认固定品牌、旧顶栏和重复外壳规则均已清理；不误删商品、客服规范与回复中的合法品牌信息。
