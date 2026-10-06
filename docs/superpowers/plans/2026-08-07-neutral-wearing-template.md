# 未明确佩戴结构时的中性话术实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 本次按用户要求在当前会话内执行，不使用子智能体。

**Goal:** 让没有明确佩戴结构证据的耳机佩戴差评统一使用话术库中的中性“调整佩戴角度”回复。

**Architecture:** 在 `template-selection.ts` 中将半入耳与入耳式分开识别，并在分类确定性修正阶段优先选择“标题中未提及佩戴类型”分类；模板选择层对未知结构继续阻止耳塞/耳道/入耳深度等结构性建议。通过 Vitest 回归测试覆盖未知、半入耳、明确入耳三种场景。

**Tech Stack:** TypeScript、Vitest、SQLite 话术目录。

---

### Task 1: 添加失败回归测试

**Files:** `apps/server/src/drafts/template-selection.test.ts`

- [ ] 测试未知结构商品从入耳式模型结果改到“标题中未提及佩戴类型”。
- [ ] 测试半入耳商品不允许入耳式耳塞/耳道话术。
- [ ] 测试明确入耳式商品仍允许耳塞话术。
- [ ] 运行定向测试并确认新增测试先失败。

### Task 2: 实现最小修复

**Files:** `apps/server/src/drafts/template-selection.ts`

- [ ] 将 `HeadphoneForm` 的半入耳与入耳式拆分。
- [ ] 增加中性佩戴分类识别，并在未知结构时优先选择它。
- [ ] 对未知/半入耳结构过滤耳塞、耳道、入耳深度建议。
- [ ] 保持现有耳夹、头戴、扩音器和音箱路由不变。

### Task 3: 验证

- [ ] 运行 `npx.cmd vitest run src/drafts/template-selection.test.ts`。
- [ ] 运行 `npm.cmd run test -w apps/server`。
- [ ] 运行 `npm.cmd run typecheck -w apps/server` 和 `npm.cmd run build -w apps/server`。
- [ ] 核对工作区 diff，仅保留本次逻辑和测试变更；清理诊断副本。
