# Reply Accuracy and Resilient Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复历史回复误判、模板安全误拦、投诉误入和网络异常中断，使当前页面上的评价可靠地分类、回复或跳过并继续。

**Architecture:** 保留现有 AI 分类与固定话术库，以确定性的产品族、语义维度、模板来源和页面状态作为安全纠偏层。数据库继续承担展示、审计和防重复，但只有已提交或提交不确定边界能阻止页面当前可回复项再次操作。

**Tech Stack:** TypeScript、Vitest、Fastify、SQLite、Playwright/Patchright、React、Windows 打包脚本

---

### Task 1: 当前页面重新出现时重开未提交失败

**Files:**
- Modify: `apps/server/src/drafts/processor.test.ts`
- Modify: `apps/server/src/drafts/processor.ts`
- Modify: `apps/server/src/storage/repositories.test.ts`
- Modify: `apps/server/src/storage/repositories.ts`

- [ ] 写入失败测试：现有 `read_only_ready`/`needs_attention` 草稿和失败提交记录在当前页面仍可回复时返回可提交结果。
- [ ] 写入失败测试：`sent`、`submitting`、`submission_uncertain` 和终态墓碑仍然跳过。
- [ ] 运行定向测试并确认因现有 ready 分支只返回 skipped 而失败。
- [ ] 最小修改页面观测流程，使未跨越提交边界的 ready/failed 项可继续提交。
- [ ] 运行定向测试并确认通过。

### Task 2: 信任商家话术，拦截 AI 新增承诺

**Files:**
- Modify: `apps/server/src/submission/service.test.ts`
- Modify: `apps/server/src/submission/service.ts`
- Modify: `apps/server/src/drafts/processor.test.ts`
- Modify: `apps/server/src/drafts/processor.ts`

- [ ] 写入失败测试：原始模板包含“支持全额退款退货”且最终回复保持模板时允许提交。
- [ ] 写入失败测试：原模板没有售后承诺、最终回复新增退款/退货/赔偿时仍拦截。
- [ ] 写入失败测试：模板中的批准售后词不再产生人工检查原因。
- [ ] 运行定向测试并确认失败原因正确。
- [ ] 将验证改为比较模板来源，而不是全局禁词。
- [ ] 运行定向测试并确认通过。

### Task 3: 字段型空评价与明星规则

**Files:**
- Modify: `apps/server/src/drafts/processor.test.ts`
- Modify: `apps/server/src/drafts/processor.ts`

- [ ] 写入失败测试：“佩戴感受：续航能力：”被纠偏为好评通用整体分类并生成通用好评。
- [ ] 写入失败测试：“音质清晰得仿佛歌手就在耳边低语”不会跳过。
- [ ] 写入失败测试：明确明星姓名、代言人或“某明星同款”仍跳过。
- [ ] 运行定向测试并确认失败。
- [ ] 增加字段型空内容检测与明确公众人物检测，删除“歌手/演员”等单独泛词触发。
- [ ] 运行定向测试并确认通过。

### Task 4: 产品族与主要问题语义纠偏

**Files:**
- Modify: `apps/server/src/drafts/template-selection.test.ts`
- Modify: `apps/server/src/drafts/template-selection.ts`
- Modify: `apps/server/src/drafts/processor.test.ts`

- [ ] 写入失败测试：截图评价选择“连接有延迟”，不选择“蓝牙稳定性”。
- [ ] 写入失败测试：双设备连接正面描述不触发断连；久戴闷为次级问题。
- [ ] 写入失败测试：睡眠耳塞不得选择扩音器分类；明确扩音器仍可选择扩音器专属分类。
- [ ] 写入失败测试：“喜欢”不自动判定送礼；麦克风“收音一般”、包装简单无保护、单耳 ANC、声音有点大分别匹配正确语义或通用兜底。
- [ ] 运行定向测试并确认失败。
- [ ] 扩充产品族词表，加入耳塞等称呼。
- [ ] 为分类增加延迟、稳定性、麦克风拾音、佩戴闷、ANC、包装防护等语义维度和冲突惩罚。
- [ ] 即使模型选择了同产品族的已知分类，也对明确高权重问题进行全目录纠偏。
- [ ] 限制泛词，找不到唯一可靠专项分类时回到当前库通用兜底。
- [ ] 运行定向测试并确认通过。

### Task 5: 投诉以当前语义和页面状态为准

**Files:**
- Modify: `apps/server/src/complaints/production-complaint-review-policy.test.ts`
- Modify: `apps/server/src/complaints/production-complaint-review-policy.ts`
- Modify: `apps/server/src/storage/complaint-repository.test.ts`
- Modify: `apps/server/src/storage/complaint-repository.ts`
- Modify: `apps/server/src/drafts/processor.test.ts`

- [ ] 写入失败测试：“降噪效果不行，音质及续航可以”不调用投诉模型。
- [ ] 写入失败测试：当前评论不满足投诉候选时，导入的未提交旧投诉分析不会阻止回复。
- [ ] 写入失败测试：投诉已提交或提交结果不确定仍保持防重复保护。
- [ ] 写入失败测试：当前阶段没有投诉入口时跳过投诉并继续，不进入暂停。
- [ ] 写入失败测试：投诉连接失败发生在点击前时记录失败并继续下一条；点击后不确定不重试。
- [ ] 运行定向测试并确认失败。
- [ ] 让候选筛选始终服从当前评论；仅安全释放未跨越提交边界的旧投诉状态。
- [ ] 保持官方类型、精确引用和事实验证三道门。
- [ ] 运行定向测试并确认通过。

### Task 6: 网络失败不中断队列

**Files:**
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/submission/service.test.ts`
- Modify: `apps/server/src/index.test.ts`
- Modify: `apps/server/src/index.ts`

- [ ] 写入失败测试：单条分类、投诉预审或提交前网络失败不会累计为暂停计划。
- [ ] 写入失败测试：整页不可信经过有限恢复后只结束本轮，计划保持等待下次运行。
- [ ] 写入失败测试：登录/验证码仍进入人工处理。
- [ ] 写入失败测试：前台浏览器会话过期的相同警告只输出一次状态变化。
- [ ] 运行定向测试并确认失败。
- [ ] 将可恢复失败与登录人工阻塞分开计数，保留点击后不确定保护。
- [ ] 对重复会话提示做一次性/节流记录。
- [ ] 运行定向测试并确认通过。

### Task 7: 历史数据回放与数据展示一致性

**Files:**
- Modify: `apps/server/src/drafts/processor.test.ts`
- Modify: `apps/server/src/app.test.ts`
- Create or Modify: `scripts/replay-review-regressions.mjs`
- Modify: `scripts/public-repo-safety.test.mjs`

- [ ] 建立不含买家隐私的历史评价回归夹具，覆盖本轮全部误判。
- [ ] 验证最终有效情感标签、分类、话术和发送状态可在结果页完整展示。
- [ ] 只读打开诊断数据库副本并生成汇总，不修改用户原始数据库。
- [ ] 运行回放并检查每个案例的预期分类与回复主题。

### Task 8: 全量验证和 Windows 打包

**Files:**
- Verify only unless测试发现问题。

- [ ] 运行 `npm run test -w apps/server`。
- [ ] 运行 `npm test`。
- [ ] 运行 `npm run typecheck`。
- [ ] 运行 `npm run build`。
- [ ] 运行历史数据库 `quick_check` 和只读回放。
- [ ] 在已登录且用户授权的真实页面进行受控端到端观察；提交前和点击后状态均需记录。
- [ ] 运行 `npm run package:windows:local`，确认压缩包保留本地 `data`。
- [ ] 检查压缩包内容、版本号、启动脚本和公开仓库安全扫描。

