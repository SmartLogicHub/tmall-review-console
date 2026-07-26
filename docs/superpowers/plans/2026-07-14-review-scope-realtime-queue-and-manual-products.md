# 评价范围、实时队列与人工处理商品 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把原型中的日期选择与自动计划改成真实持久化能力，并增加人工处理商品名单，使实时更新的未回复队列能按日期范围持续处理，同时可靠跳过名单商品的中评和差评。

**Architecture:** 在 domain 包中定义日期与商品身份合同；SQLite 保存日期范围、名单实体/来源、动作锁和每轮冻结快照；Fastify 暴露带乐观并发的 API；Playwright 驱动幂等设置天猫筛选并读取商品 ID；运行控制器使用动态分页队列和统一动作门禁；React 工作台提供真实日期/计划对话框，独立页面维护人工商品。所有提交仍只经内部控制器，名单命中在投诉或回复动作之前生效。

**Tech Stack:** TypeScript、Node.js、Fastify 5、better-sqlite3、Playwright、React 19、TanStack Query、Radix Dialog、react-day-picker、date-fns、ExcelJS、yauzl、Vitest、Playwright Test。

> 后续身份决策（2026-07-16）覆盖本文早期规则：人工处理商品只按商品 ID 精确匹配；所有新增和 Excel 导入均要求商品 ID，商品标题可选且仅用于展示，不再进行任何标题回退或同标题合并。

**Design spec:** `docs/superpowers/specs/2026-07-14-review-scope-and-manual-products-design.md`

---

## 实施约束

- 每项任务先运行新增测试并看到预期失败，再写最小实现。
- 不使用用户真实淘宝账号、密码或 DeepSeek Key 作为测试夹具。
- 自动化测试不得点击真实“评价回复提交”或真实“投诉提交”。
- 不改变现有飞书模板字段合同。
- 不修改既有 `sourceKey` 算法。
- 每个任务完成后运行列出的局部测试；全部任务完成后再运行全量测试。
- 如果当前环境可写 Git 元数据，按任务创建提交；如果不可写，保留任务级验证记录，不尝试重置或覆盖用户改动。

## Task 1: 建立日期范围和人工商品的领域合同

**Files:**

- Create: `packages/domain/src/review-scope.ts`
- Create: `packages/domain/src/review-scope.test.ts`
- Create: `packages/domain/src/manual-products.ts`
- Create: `packages/domain/src/manual-products.test.ts`
- Modify: `packages/domain/src/index.ts`

- [ ] **Step 1: 写日期范围失败测试**

  覆盖：默认 `last7`、今天/昨天/近 7 天/近 30 天的上海时区边界、自定义起止包含、开始晚于结束、超过 90 天、非法日期、运行时范围判断。

  使用固定时钟 `2026-07-14T12:00:00+08:00`，断言 `last7` 解析为 `2026-07-08` 至 `2026-07-14`。

- [ ] **Step 2: 运行日期范围测试并确认失败**

  Run: `npm run test -w packages/domain -- src/review-scope.test.ts`

  Expected: FAIL，提示 `review-scope` 模块或导出不存在。

- [ ] **Step 3: 实现最小日期领域模型**

  提供：

  - `ReviewScopePreset`
  - `ReviewScopeConfig`
  - `ResolvedReviewScope`
  - `validateReviewScopeInput`
  - `resolveReviewScope`
  - `isReviewedAtWithinScope`
  - `formatReviewScopeSummary`

  所有“今天”计算必须从显式传入的 `now` 和 `Asia/Shanghai` 得到，不能依赖服务器本地时区。

- [ ] **Step 4: 写商品规范化、身份合并和匹配矩阵失败测试**

  覆盖：商品 ID 去空、缺失 ID 输入拒绝、同 ID 标题更新、ID-only 输入、同标题不同 ID 共存、评价行缺失/不可信 ID 时安全停止、任何情况下均不允许标题回退。

- [ ] **Step 5: 运行商品领域测试并确认失败**

  Run: `npm run test -w packages/domain -- src/manual-products.test.ts`

  Expected: FAIL，提示相关函数未实现。

- [ ] **Step 6: 实现最小商品领域模型并导出**

  提供纯函数：

  - `normalizeManualProductTitle`
  - `resolveManualProductIdentity`
  - `matchManualProduct`
  - `ManualProductMatchResult`，显式区分 `matched`、`not_matched`、`ambiguous`

  禁止包含匹配和 AI 模糊匹配。

- [ ] **Step 7: 验证 domain 包**

  Run: `npm run test -w packages/domain`

  Expected: PASS。

- [ ] **Step 8: 创建任务提交**

  Run: `git add packages/domain/src && git commit -m "feat: add review scope and manual product domain rules"`

## Task 2: 增加数据库迁移和冻结字段

**Files:**

- Modify: `apps/server/src/storage/database.ts`
- Modify: `apps/server/src/storage/database.test.ts`

- [ ] **Step 1: 写迁移失败测试**

  断言迁移幂等并创建：

  - `review_scope`
  - `manual_product_catalog_state`
  - `manual_products`
  - `manual_product_memberships`
  - `review_action_locks`
  - `review_action_tombstones`

  断言：

  - `manual_products.item_id` 的非空部分唯一索引；
  - `item_id` 为空仅用于兼容历史数据；所有新写入要求商品 ID，历史无 ID 记录不会自动命中；
  - `manual_product_memberships(product_id, source)` 唯一；
  - `review_action_locks(store_id, source_key)` 唯一；
  - `review_action_locks` 含非空 `lock_version`，默认 1，并按动作类型和更新时间建索引；
  - `review_action_tombstones(store_id, source_key)` 唯一，保存 `terminal_action`、`completed_at` 并按完成时间建清理索引；
  - `reply_drafts` 新增 `item_id`、`review_phase`、`manual_product_id`、`manual_hold_reason`、`manual_catalog_revision`、`manual_match_kind`、`manual_hold_last_seen_at`、`manual_hold_absent_scans`；
  - `reply_attempts` 新增 `action_lock_version`，把 attempt 绑定到取得时的 `reply` 锁版本；
  - `automation_runs` 新增 `scope_preset`、`scope_start_date`、`scope_end_date`、`scope_revision`、`scope_timezone`。

- [ ] **Step 2: 运行迁移测试并确认失败**

  Run: `npm run test -w apps/server -- src/storage/database.test.ts`

  Expected: FAIL，缺少新表或列。

- [ ] **Step 3: 添加下一版本迁移**

  默认插入：

  - `review_scope(id=1, preset='last7', revision=1, timezone='Asia/Shanghai')`
  - `manual_product_catalog_state(id=1, revision=1)`

  `manual_products` 与来源成员使用外键级联；`reply_drafts.manual_product_id` 使用 `ON DELETE SET NULL`，审计原因和动作锁继续保留。

  动作锁只保存活动互斥状态；`sent`、`not_actionable`、投诉成立和人工保留到期等终态在同一事务中压缩到 `review_action_tombstones`，避免永久占用活动锁又失去幂等保护。

- [ ] **Step 4: 测试旧数据库升级和重复启动**

  从仅应用旧迁移的内存数据库升级两次，确认旧回复草稿仍可读取，默认范围正确且无重复默认行。夹具必须包含历史 `sent` 和 `submission_uncertain` attempt：前者安全补建 `reply_sent` 墓碑，后者补建/保留活动 reply 锁；历史缺少 `action_lock_version` 时也不能变成可自动重试状态。

- [ ] **Step 5: 验证迁移**

  Run: `npm run test -w apps/server -- src/storage/database.test.ts`

  Expected: PASS。

- [ ] **Step 6: 创建任务提交**

  Run: `git add apps/server/src/storage/database.ts apps/server/src/storage/database.test.ts && git commit -m "feat: persist review scope manual catalog and action locks"`

## Task 3: 实现带修订号的仓储和统一动作门禁

**Files:**

- Create: `apps/server/src/storage/review-scope-repository.ts`
- Create: `apps/server/src/storage/review-scope-repository.test.ts`
- Create: `apps/server/src/storage/manual-product-repository.ts`
- Create: `apps/server/src/storage/manual-product-repository.test.ts`
- Create: `apps/server/src/submission/review-action-gate.ts`
- Create: `apps/server/src/submission/review-action-gate.test.ts`
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/server/src/storage/database.ts`

- [ ] **Step 1: 写评价范围仓储失败测试**

  覆盖默认读取、正确 `expectedRevision` 保存、旧修订号拒绝、成功后修订号递增、重启恢复。

- [ ] **Step 2: 写人工商品仓储失败测试**

  覆盖：

  - 新增手工商品；
  - 缺少商品 ID 的新增输入直接拒绝；
  - 手工和 Excel 双来源成员；
  - 同 ID 标题更新；
  - 同标题不同 ID 共存；
  - ID-only 输入可创建，同标题不同 ID 不合并；
  - 搜索与分页返回顶层 `catalogRevision`；
  - 汇总返回 `total`、`manualSourceCount`、`excelSourceCount`、`lastImportAt`，双来源商品按来源分别计数但总商品不重复；
  - 旧修订号新增/删除失败；
  - “移出名单”删除全部来源；
  - Excel 替换只移除 Excel 来源；
  - 合并实体时迁移来源和活动人工保留引用。

- [ ] **Step 3: 写动作门禁失败测试**

  使用两个数据库连接或交错事务验证：

  - `manual_hold`、`reply`、`complaint` 只能有一个；
  - `lockVersion` 比较并交换且每次成功转换递增；
  - `manual_hold` 时不能创建回复 attempt；
  - 已 `submitting`、`sent`、`submission_uncertain` 或终态墓碑时不能被人工规则抢占；
  - 只有无 attempt/案件/墓碑的 `manual_hold` 能释放；
  - 活动锁转终态墓碑在一个事务中完成，墓碑存在时不能重新取得任何动作锁。
  - `prepareWithReplyLock` 在同一个 immediate transaction 中检查墓碑、取得或验证 `reply` 锁、递增/读取 `lockVersion` 并创建唯一 attempt；不得先检查后另起事务插入 attempt；
  - 在“取得 reply 锁”和“创建 attempt”之间并发新增人工名单时，只允许该原子事务的一方先完成，另一方必须观察到已有动作锁，不能同时产生 `manual_hold` 和 reply attempt；
  - 重复 prepare 若已存在 `submitting/sent/submission_uncertain` attempt，只返回原 attempt 且不能重置锁；只有确认点击前失败且仍持有同版本 reply 锁时才允许安全重试。

- [ ] **Step 4: 运行新仓储测试并确认失败**

  Run: `npm run test -w apps/server -- src/storage/review-scope-repository.test.ts src/storage/manual-product-repository.test.ts src/submission/review-action-gate.test.ts`

  Expected: FAIL，模块不存在。

- [ ] **Step 5: 实现仓储与事务边界**

  仓储写操作统一使用 immediate transaction 语义；修订冲突抛出可识别领域错误，不直接携带 SQL 文本。

  `POST` 所需的“新建、复用、补充 ID、合并”结果由仓储显式返回。

  `ReplyAttemptRepository` 的锁生命周期固定为：

  - `prepareWithReplyLock`：原子取得 `reply` 锁并创建 `pending` attempt，把 `lockVersion` 写入 attempt；
  - `markSubmitting`：比较 attempt 保存的版本和当前 reply 锁，匹配才转 submitting，活动锁保留；
  - `markSent`：attempt、草稿转 sent，活动锁删除并写 `reply_sent` 墓碑，全部在一个事务；
  - `markUncertain`：转 `submission_uncertain`，活动 reply 锁永久保留直到人工核对；
  - `markFailed` 和 `markPreSubmitFailed`：只允许在确认没有点击平台按钮时使用，attempt 记 failed、草稿恢复可重试状态并释放同版本 reply 锁，全部在一个事务；
  - `resolveUncertain(sent)`：写 sent 和 `reply_sent` 墓碑；`resolveUncertain(not_sent)`：有平台核对证据后释放 reply 锁并回到安全重试状态；
  - 已存在不同动作锁、版本不符或终态墓碑时，任何 attempt 方法都失败且不改变既有记录。

- [ ] **Step 6: 接入现有回复仓储**

  更新 `ReplyRepository.discover` 和映射以保存新字段；增加：

  - `markManualProductHold`
  - `releaseEligibleManualHolds`
  - `clearUnsubmittedDraftForManualHold`
  - `recordManualHoldScanEvidence`
  - `compactExpiredManualHolds`

  完整扫描范围包含该评价日期时：本轮观察到则把 `manual_hold_absent_scans` 归零；未观察到则递增；连续两次未观察到时原子转 `not_actionable` 墓碑并释放活动锁。范围不包含评价日期时不得把缺席当作证据。

  每日清理对超过 90 天、仍无 attempt/案件且未能取得页面缺席证据的人工保留执行内容压缩：写 `manual_hold_expired` 墓碑、删除活动锁并允许清理完整评价内容。墓碑按现有 180 天策略保留。这样活动保留不会永久占用锁，也不会因内容清理后被当作新评价重复处理。

- [ ] **Step 7: 验证仓储和原有测试**

  Run: `npm run test -w apps/server -- src/storage src/submission`

  Expected: PASS。

- [ ] **Step 8: 创建任务提交**

  Run: `git add apps/server/src/storage apps/server/src/submission && git commit -m "feat: add revisioned manual catalog and review action gate"`

## Task 4: 实现安全的 Excel 预览与原子替换

**Files:**

- Modify: `apps/server/package.json`
- Modify: `package-lock.json`
- Create: `apps/server/src/manual-products/xlsx-parser.ts`
- Create: `apps/server/src/manual-products/xlsx-parser.test.ts`
- Create: `apps/server/src/manual-products/import-preview-store.ts`
- Create: `apps/server/src/manual-products/import-preview-store.test.ts`
- Create: `apps/server/src/manual-products/import-service.ts`
- Create: `apps/server/src/manual-products/import-service.test.ts`

- [ ] **Step 1: 安装运行时依赖**

  Run: `npm install -w apps/server @fastify/multipart exceljs yauzl`

  Run: `npm install -D -w apps/server @types/yauzl`

  Expected: `apps/server/package.json` 和根 `package-lock.json` 更新。

- [ ] **Step 2: 写工作簿解析失败测试**

  用 ExcelJS 在测试内存中生成夹具，不复制用户文件。覆盖：

  - 新版工作簿 Sheet1 含 `商品标题` + `商品ID`，共 4 组数据，Sheet2/3 空白；商品 ID 必须作为字符串读取；
  - 通用导入必须且只能包含 `商品ID` / `商品 ID` 列；`商品标题` 可选且仅用于展示，当前验收工作簿实际同时包含标题和 ID；
  - 多个有效表头、缺失/重复 ID 表头、重复 ID、同标题不同 ID、空标题和 ID-only 行、超过 5,000 行；
  - 非 ZIP 签名、压缩包总解压大小超限、单工作表 XML 超限、单元格数超限；
  - `.xls`、`.xlsm` 和多个上传文件拒绝。

- [ ] **Step 3: 运行解析测试并确认失败**

  Run: `npm run test -w apps/server -- src/manual-products/xlsx-parser.test.ts`

  Expected: FAIL，解析器不存在。

- [ ] **Step 4: 实现两层解析保护**

  先用 `yauzl` lazy entries 校验 ZIP 中央目录、总未压缩大小、工作表 XML 大小和条目数量，再把通过的 Buffer 交给 ExcelJS。限制值集中为导出常量并写入测试，不读取公式、不执行宏、不落盘。

- [ ] **Step 5: 写预览令牌和替换失败测试**

  覆盖：当前会话绑定、10 分钟过期、一次性使用、错会话、重放、预览冻结 `catalogRevision`、并发修改后 apply 拒绝、事务失败回滚、手工来源保留、Excel 来源替换、解除符合条件的人工保留。

- [ ] **Step 6: 实现内存预览存储和导入服务**

  `ImportPreviewStore` 只保存规范化行、差异、会话 ID、修订号和过期时间，不保存原始 Buffer。`apply` 成功或失败后都使令牌失效。

- [ ] **Step 7: 验证导入模块**

  Run: `npm run test -w apps/server -- src/manual-products`

  Expected: PASS。

- [ ] **Step 8: 创建任务提交**

  Run: `git add apps/server/package.json package-lock.json apps/server/src/manual-products && git commit -m "feat: add safe manual product workbook import"`

## Task 5: 暴露日期、计划和人工商品 API

**Files:**

- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/server/src/state.ts`

- [ ] **Step 1: 写日期范围 API 失败测试**

  覆盖 `GET/PUT /api/review-scope`、有效范围摘要、重启恢复、旧修订号 409 和中文错误；确认原始异常不回显。

- [ ] **Step 2: 写自动计划乐观并发失败测试**

  扩展现有计划 API：GET 返回 `revision`；PUT 必须携带 `expectedRevision`；两个并发客户端只有第一个成功；暂停、继续和停止的内部更新仍安全递增修订号。

- [ ] **Step 3: 写人工商品 API 失败测试**

  覆盖：

  - GET 搜索/分页、`catalogRevision`、`total`、`manualSourceCount`、`excelSourceCount`、`lastImportAt`；
  - POST 新增及补 ID 合并语义；
  - DELETE 移出全部来源；
  - multipart preview；
  - apply；
  - 错修订、错会话、过期预览、恶意文件和重复提交；
  - 每个成功写响应返回新修订号。

  `lastImportAt` 来自最近一次成功确认 Excel 替换的操作审计/目录状态字段，不使用 preview 时间；同一商品有双来源时分别计入两个来源数，但 `total` 只计一个商品实体。

- [ ] **Step 4: 运行 API 测试并确认失败**

  Run: `npm run test -w apps/server -- src/app.test.ts`

  Expected: FAIL，新路由 404 或修订合同缺失。

- [ ] **Step 5: 注册 multipart 和新路由**

  全局限制一个文件、5 MB；路由只把 Buffer 传入导入服务。所有写路由继续走现有 CSRF/session 保护。用户错误为中文，技术代码只进脱敏诊断。

- [ ] **Step 6: 更新自动计划仓储响应**

  `AutomationRepository.getPlan` 返回修订号，`savePlan(plan, expectedRevision)` 比较并交换。内部暂停/继续/停止使用读取到的当前修订号重试一次，外部 PUT 不自动覆盖冲突。

- [ ] **Step 7: 验证没有公开提交绕过路由**

  保留并扩展回归断言：不存在接收任意评价文本并直接回复或投诉的 API；新增路由只管理规则和范围。

- [ ] **Step 8: 验证 API**

  Run: `npm run test -w apps/server -- src/app.test.ts src/security.test.ts`

  Expected: PASS。

- [ ] **Step 9: 创建任务提交**

  Run: `git add apps/server/src/app.ts apps/server/src/app.test.ts apps/server/src/storage/repositories.ts apps/server/src/state.ts && git commit -m "feat: expose review scope and manual catalog APIs"`

## Task 6: 扩展天猫评价快照和商品 ID 读取

**Files:**

- Modify: `apps/server/src/tmall/review-reader.ts`
- Modify: `apps/server/src/tmall/review-reader.test.ts`
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Modify: `apps/server/src/tmall/auth-driver.test.ts`
- Modify: `apps/server/src/automation/queue-drainer.test.ts`

- [ ] **Step 1: 写商品链接解析失败测试**

  覆盖天猫/淘宝白名单商品链接中的 `id`、相对链接、无 ID、非法协议、非平台域名、多个候选链接。解析失败返回 `null`，不能把任意 URL 持久化。

- [ ] **Step 2: 写行快照失败测试**

  断言新增 `itemId`、`reviewPhase` 和必要商品链接输入；主评/追评正确区分；`sourceKey` 对现有同一输入保持不变。商品链接候选必须过滤“复制、优惠、活动、领券、查看更多”等旁链，同时保留所有真实商品详情候选，让不同商品 ID 的冲突进入读取器并安全停止。重复 `sourceKey` 仅在阶段相同时允许补充缺失商品 ID；阶段冲突不得覆盖或复用 `read_only_ready`、`sent` 记录。

- [ ] **Step 3: 运行读取器测试并确认失败**

  Run: `npm run test -w apps/server -- src/tmall/review-reader.test.ts src/tmall/auth-driver.test.ts`

  Expected: FAIL，新字段缺失。

- [ ] **Step 4: 实现纯解析和 DOM 读取扩展**

  从商品信息区域唯一商品链接提取 ID，不从评价正文猜测。若同一行出现多个冲突 ID，抛出页面状态不可信错误并停止该轮。

- [ ] **Step 5: 更新所有测试快照构造器**

  给现有 `TmallReviewSnapshot` 夹具补充可选默认值，保持旧行为不变。

- [ ] **Step 6: 验证读取层**

  Run: `npm run test -w apps/server -- src/tmall`

  Expected: PASS。

- [ ] **Step 7: 创建任务提交**

  Run: `git add apps/server/src/tmall apps/server/src/automation/queue-drainer.test.ts && git commit -m "feat: read tmall item identity and review phase"`

## Task 7: 让天猫日期和未回复筛选真实、幂等

**Files:**

- Create: `apps/server/src/tmall/review-filter.ts`
- Create: `apps/server/src/tmall/review-filter.test.ts`
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Modify: `apps/server/src/tmall/auth-driver.test.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: 写筛选状态机失败测试**

  覆盖：

  - `有内容`、`未回复` 已选时不再点击；
  - 未选时只点击一次并验证后置状态；
  - 今天、昨天、近 7 天、近 30 天使用快捷项；
  - 自定义范围按开始/结束选择并点击搜索；
  - 跨月、同日、月份切换；
  - 日期元素不唯一、状态无法回读、危险弹窗或登录失效时安全失败。

- [ ] **Step 2: 运行筛选测试并确认失败**

  Run: `npm run test -w apps/server -- src/tmall/review-filter.test.ts src/tmall/auth-driver.test.ts`

  Expected: FAIL，驱动尚不接收范围或仍盲点筛选器。

- [ ] **Step 3: 实现声明式筛选器**

  将 `#selectReviewFilters` 拆为可测试的状态机。先读取选中状态，再执行最少动作，并验证：来自买家的评价、有内容、未回复、日期范围均正确。

- [ ] **Step 4: 扩展驱动接口**

  `readPendingReviews` 和 `readPendingReviewPage` 接收冻结的 `ResolvedReviewScope`。不可用驱动和所有测试替身同步更新。

- [ ] **Step 5: 增加服务端第二道日期校验**

  每条 `reviewedAt` 必须可解析且落在冻结范围内；否则将运行转为 `manual_action_required`，当前及后续评价都不提交。

- [ ] **Step 6: 验证筛选与安全失败**

  Run: `npm run test -w apps/server -- src/tmall src/app.test.ts`

  Expected: PASS。

- [ ] **Step 7: 创建任务提交**

  Run: `git add apps/server/src/tmall apps/server/src/app.ts apps/server/src/app.test.ts && git commit -m "feat: apply persisted review date filters safely"`

## Task 8: 将队列改为高效的实时动态扫描

**Files:**

- Modify: `apps/server/src/automation/queue-drainer.ts`
- Modify: `apps/server/src/automation/queue-drainer.test.ts`
- Modify: `apps/server/src/app.ts`

- [ ] **Step 1: 扩展动态队列失败测试**

  保留 785 条/20 条分页测试，并新增：

  - 处理一条后新评价插入第一页；
  - 扫描已离开第一页后新评价插入顶部；
  - 中间页因删除或插入发生重排；
  - 列表延迟移除已回复评价；
  - 最终检查前观察到的新评价本轮处理；
  - 最终检查后才出现的评价本轮不标记、下一次调用处理；
  - 持续新评价时暂停、停止和时间段末尾仍在当前单条后生效；
  - 静态 785 条、每页 20 条且处理后列表及时移除时，分页读取调用不超过 `785 + 2 * ceil(785 / 20) + 10 = 875` 次，防止每条都重扫全库。

- [ ] **Step 2: 运行队列测试并确认失败**

  Run: `npm run test -w apps/server -- src/automation/queue-drainer.test.ts`

  Expected: 至少“离开第一页后插入”和“最终检查竞态”场景 FAIL。

- [ ] **Step 3: 实现动态扫描算法**

  维护本轮 `seen sourceKey`：

  1. 正常遍历当前页；
  2. 每个处理结果后优先刷新第一页，发现新 key 时立即处理；
  3. 未发现时继续当前扫描游标，不重扫全部已见分页；
  4. 页重排遗漏由后续完整确认扫描补齐；
  5. 每次空完整扫描结束再检查第一页；
  6. 连续两次完整空扫描加最终检查均无新 key 才结束。

  `seen` 只在当前轮内去重，真正幂等仍由数据库动作锁和 attempt 唯一约束保证。

  队列通过 `onFullScanCompleted({ observedSourceKeys, scope })` 回调把每次完整扫描证据交给运行控制器；控制请求中止或页面读取失败的半次扫描不得作为人工保留“未出现”的证据。

- [ ] **Step 4: 更新运行状态文案**

  运行中心区分“正在处理”“正在检查新评价”“当前队列已处理完，等待下一次运行”，不声称平台从此没有新评价。

- [ ] **Step 5: 验证动态队列**

  Run: `npm run test -w apps/server -- src/automation/queue-drainer.test.ts src/app.test.ts`

  Expected: PASS，无重复且控制边界正确。

- [ ] **Step 6: 创建任务提交**

  Run: `git add apps/server/src/automation apps/server/src/app.ts && git commit -m "feat: drain live review queue without duplicate work"`

## Task 9: 接入人工商品分流和仅情感判定

**Files:**

- Create: `apps/server/src/manual-products/policy-service.ts`
- Create: `apps/server/src/manual-products/policy-service.test.ts`
- Modify: `apps/server/src/deepseek/client.ts`
- Modify: `apps/server/src/deepseek/client.test.ts`
- Modify: `apps/server/src/drafts/processor.ts`
- Modify: `apps/server/src/drafts/processor.test.ts`
- Modify: `apps/server/src/submission/service.ts`
- Modify: `apps/server/src/submission/service.test.ts`

- [ ] **Step 1: 写 DeepSeek 仅情感判定失败测试**

  增加 `determineSentiment` 结构化合同，仅允许 `positive|neutral|negative`、理由和置信度。覆盖“不错”“还行”的正负语境、混合评价、空输入、非法 JSON、枚举外值、服务异常。

- [ ] **Step 2: 写人工分流策略失败测试**

  覆盖：

  - 未命中名单走正常流程；
  - 命中 + positive 走正常好评；
  - 命中 + neutral/negative 取得 `manual_hold`，不分类、不抽话术、不投诉；
  - 命中 + unknown 只调用情感判定；
  - unknown 判 positive 后才进入完整分类；
  - unknown 判 neutral/negative 后转人工；
  - AI 失败或商品身份歧义安全转人工；
  - 单条开始冻结 `catalogRevision`，处理中名单变化只影响下一条。

- [ ] **Step 3: 写提交门禁失败测试**

  断言 `SubmissionService` 只能调用原子的 `prepareWithReplyLock`，不能执行独立“先检查再 prepare”；`manual_hold`、complaint 锁、终态墓碑和版本不符时均不填写、不点击、不创建 attempt。覆盖取得 reply 锁与人工名单新增交错并发、重复 attempt、sent 墓碑转换、uncertain 保留锁、验证失败/点击前失败释放锁、人工确认 not_sent 后安全释放。

- [ ] **Step 4: 运行策略测试并确认失败**

  Run: `npm run test -w apps/server -- src/deepseek/client.test.ts src/manual-products/policy-service.test.ts src/drafts/processor.test.ts src/submission/service.test.ts`

  Expected: FAIL，新合同和门禁未实现。

- [ ] **Step 5: 实现仅情感判定**

  复用已批准的完整分类原则，但此调用不读取分类目录、不选择模板、不生成回复。任何解析不确定都返回失败并由策略服务转人工。

- [ ] **Step 6: 实现人工商品策略服务**

  单条开始时读取名单修订并保存决策；中差评原子写 `manual_product_hold` 与 `manual_hold` 动作锁。好评不取得人工锁，继续既有分类和随机话术流程。

- [ ] **Step 7: 集成草稿和提交服务**

  对既有未提交草稿重新过门禁；新规则命中时清空草稿并转人工。正常回复必须通过 `prepareWithReplyLock` 原子取得 reply 锁和 attempt；所有 attempt 状态转换按 Task 3 的锁生命周期执行。已经 sent、submission_uncertain 或活动投诉的动作锁不被改写。

- [ ] **Step 8: 验证 AI、草稿和提交层**

  Run: `npm run test -w apps/server -- src/deepseek src/manual-products src/drafts src/submission`

  Expected: PASS。

- [ ] **Step 9: 创建任务提交**

  Run: `git add apps/server/src/deepseek apps/server/src/manual-products apps/server/src/drafts apps/server/src/submission && git commit -m "feat: divert manual product neutral and bad reviews"`

## Task 10: 冻结每轮范围并接入运行控制器

**Files:**

- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/server/src/automation/queue-drainer.ts`

- [ ] **Step 1: 写运行冻结失败测试**

  覆盖：

  - 启动时解析范围并写入 `automation_runs`；
  - 运行中修改日期不改变当前轮；
  - 下一轮使用新修订；
  - 手动运行和定时运行使用同一范围；
  - 新评价在范围内时本轮可发现，范围外时不处理；
  - 日期不可解析或页面返回范围外记录时整轮安全停止；
  - 人工保留计入 `manual`，不计为回复失败；
  - 只有完整扫描回调可以累计人工保留缺席证据，连续两次后转 `not_actionable` 墓碑；中断扫描不累计。

- [ ] **Step 2: 运行控制器测试并确认失败**

  Run: `npm run test -w apps/server -- src/app.test.ts`

  Expected: FAIL，运行记录没有范围快照或处理器未接收人工策略。

- [ ] **Step 3: 扩展运行记录和状态**

  `AutomationRepository.createRun(trigger, resolvedScope)` 原子写冻结范围。状态增加本轮人工处理数和当前范围摘要；`finishRun` 保存正确停止原因。

- [ ] **Step 4: 组装真实依赖**

  在 `executeAutomationRun` 中按顺序创建：范围快照 → 页面筛选 → 人工策略 → 投诉/回复动作门禁 → 草稿 → 提交。确保人工名单判断发生在任何投诉或回复动作之前。

- [ ] **Step 5: 更新仪表盘数据**

  `/api/dashboard` 返回有效日期范围、人工名单总数、人工分流数和最新运行范围；不返回内部锁或修订诊断字段。

- [ ] **Step 6: 接入人工保留终结事务**

  把 `onFullScanCompleted` 交给仓储：仅对评价日期落在冻结范围内的 hold 更新 lastSeen/absentScans；两次完整缺席后原子写 `not_actionable` 墓碑、删除活动锁并把草稿转不可操作终态。任何部分扫描、登录失败、页面不可信或用户中止都不提供缺席证据。

- [ ] **Step 7: 验证运行控制器**

  Run: `npm run test -w apps/server -- src/app.test.ts src/automation src/drafts src/submission`

  Expected: PASS。

- [ ] **Step 8: 创建任务提交**

  Run: `git add apps/server/src/app.ts apps/server/src/app.test.ts apps/server/src/storage/repositories.ts apps/server/src/automation && git commit -m "feat: freeze review scope in automation runs"`

## Task 11: 在工作台接入真实日期和自动计划编辑器

**Files:**

- Modify: `apps/web/package.json`
- Modify: `package-lock.json`
- Create: `apps/web/src/components/review-scope-dialog.tsx`
- Create: `apps/web/src/components/review-scope-dialog.test.tsx`
- Create: `apps/web/src/components/automation-plan-dialog.tsx`
- Create: `apps/web/src/components/automation-plan-dialog.test.tsx`
- Modify: `apps/web/src/pages/run-center.tsx`
- Modify: `apps/web/src/pages/settings.tsx`
- Modify: `apps/web/src/app.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: 安装日期组件依赖**

  Run: `npm install -w apps/web react-day-picker date-fns`

  Expected: Web package 和 lockfile 更新。

- [ ] **Step 2: 写日期对话框失败测试**

  覆盖五个快捷项、双月自定义选择、开始/结束状态、同日、跨月、90 天限制、未完成时禁用、保存加载/错误、修订冲突后刷新提示、保存后工作台摘要更新。

- [ ] **Step 3: 写计划对话框失败测试**

  覆盖自动开关、1～6 个时间段、增删、开始早于结束、不重叠、1～120 分钟、取消不保存、保存后当前时段/下一次运行/间隔更新、旧修订冲突。

- [ ] **Step 4: 运行组件测试并确认失败**

  Run: `npm run test -w apps/web -- src/components/review-scope-dialog.test.tsx src/components/automation-plan-dialog.test.tsx`

  Expected: FAIL，组件不存在。

- [ ] **Step 5: 实现真实对话框**

  使用 Radix Dialog 管理焦点和 Esc；日期由 react-day-picker 双月显示。任何生产状态都来自 API/TanStack Query，不使用 `localStorage`。

- [ ] **Step 6: 接入工作台**

  “本轮处理范围”摘要可点击打开日期；黑色运行控制卡的计划摘要可点击编辑计划。保存成功后更新 `review-scope`、`automation-plan`、`automation-status` 和 `dashboard` 查询缓存。

- [ ] **Step 7: 简化设置页计划区**

  删除第二套完整计划表单，只显示摘要和“前往工作台修改”，凭据、飞书和数据管理保持不变。

- [ ] **Step 8: 做响应式与滚动回归**

  验证 1366×768、1440×900、1920×1080；页面只有统一浏览器滚动，不产生主内容与侧栏割裂的双滚动。

- [ ] **Step 9: 验证 Web 日期与计划**

  Run: `npm run test -w apps/web -- src/components src/app.test.tsx`

  Expected: PASS。

- [ ] **Step 10: 创建任务提交**

  Run: `git add apps/web/package.json package-lock.json apps/web/src && git commit -m "feat: make review dates and schedules editable on workbench"`

## Task 12: 实现人工处理商品页面和 Excel 差异确认

**Files:**

- Create: `apps/web/src/pages/manual-products.tsx`
- Create: `apps/web/src/pages/manual-products.test.tsx`
- Create: `apps/web/src/components/manual-product-form.tsx`
- Create: `apps/web/src/components/manual-product-import-dialog.tsx`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/client.test.ts`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/components/shell.tsx`
- Modify: `apps/web/src/pages/run-center.tsx`
- Modify: `apps/web/src/app.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: 写页面失败测试**

  覆盖：侧栏入口、空状态、`total/manualSourceCount/excelSourceCount/lastImportAt` 汇总、搜索、分页、手工新增、商品 ID 必填与标题可选、两个来源标签、最近命中、移出名单二次确认、工作台人数摘要跳转。

- [ ] **Step 2: 写导入交互失败测试**

  覆盖：选择 `.xlsx`、上传中、预览新增/保留/移除/冲突、确认替换、取消、预览过期、名单修订冲突、恶意文件中文错误、确认后列表和工作台计数更新。

- [ ] **Step 3: 写 FormData 客户端测试**

  确认 `apiFetch` 发送 FormData 时不手工设置 JSON `Content-Type`，仍携带 CSRF/session，后端重启后只重试安全初始化，不自动重放已经确认的导入或删除。

- [ ] **Step 4: 运行页面测试并确认失败**

  Run: `npm run test -w apps/web -- src/pages/manual-products.test.tsx src/api/client.test.ts`

  Expected: FAIL，页面和 multipart 客户端未实现。

- [ ] **Step 5: 实现名单页面**

  显示规则：“名单商品的中评/差评转人工，好评仍自动回复”。用户界面不显示 normalized title、锁、修订号或 sourceKey。

- [ ] **Step 6: 实现导入两阶段对话框**

  第一步上传并展示差异，第二步明确确认“替换 Excel 来源名单”。成功后清空文件 input 和 previewId，关闭对话框并刷新缓存。

- [ ] **Step 7: 接入路由与导航**

  新增 `/manual-products`；侧栏名称固定“人工处理商品”，不显示店铺名或品牌名。

- [ ] **Step 8: 验证人工商品 UI**

  Run: `npm run test -w apps/web -- src/pages/manual-products.test.tsx src/api/client.test.ts src/app.test.tsx`

  Expected: PASS。

- [ ] **Step 9: 创建任务提交**

  Run: `git add apps/web/src && git commit -m "feat: add manual product management workspace"`

## Task 13: 完成生命周期、端到端和正式只读验收

**Files:**

- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `packages/domain/src/retention.ts`
- Modify: `packages/domain/src/retention.test.ts`
- Modify: `apps/web/src/pages/settings.tsx`
- Modify: `apps/web/src/app.test.tsx`
- Modify: `tests/e2e/console.spec.ts`
- Modify: `README.md`

- [ ] **Step 1: 写数据生命周期失败测试**

  断言：日期范围和人工名单不参与普通 90 天清理；未满 90 天且仍活动的人工保留受保护；人工保留连续两次在覆盖其日期的完整扫描中缺席时转 `not_actionable` 墓碑；超过 90 天仍未终结且无 attempt/案件的人工保留压缩为 `manual_hold_expired` 墓碑；完整内容随后可清理；操作审计和墓碑保留 180 天；`submission_uncertain` 等不确定状态继续受保护；恢复出厂清空名单、使预览失效并把日期恢复为近 7 天。

- [ ] **Step 2: 更新数据管理视图**

  显示人工商品数、人工保留评价数和数据库占用；分项清理不能误删规则。恢复出厂设置文案明确会清空人工商品和日期设置。

- [ ] **Step 3: 增加端到端 UI 测试**

  用模拟 API 验证：

  1. 工作台保存自定义日期；
  2. 工作台编辑两个时间段和 20 分钟间隔；
  3. 进入人工商品页导入 4 条测试商品；
  4. 搜索、添加和移出；
  5. 返回工作台看到计数和摘要同步；
  6. 页面保持统一滚动、对话框焦点可用、无固定店铺名。

- [ ] **Step 4: 增加服务端集成场景**

  模拟 785 条队列并在运行中插入新评价；名单商品的中差评转人工、好评继续；删除名单后下一轮重新发现；范围外评价不处理；所有 reply/complaint attempt 数量符合预期。

- [ ] **Step 5: 使用用户工作簿做本地只读验收**

  仅通过正式 preview 路径读取用户选择的新版工作簿 `中差评剔除产品(1).xlsx`，不硬编码个人缓存绝对路径。确认按“商品标题 + 商品 ID”合同识别当前 4 组商品、忽略空 Sheet2/3，并验证所有商品 ID 从读取到预览均保持精确字符串主键。先检查差异，不在未获用户确认时写入正式名单。

- [ ] **Step 6: 对真实天猫页面做只读筛选验收**

  在已登录会话中只验证：交易 → 评价管理 → 来自买家的评价 → 日期 → 有内容 → 未回复；读取商品 ID、标题、评价时间和分页。取消所有回复/投诉对话框，不填写或提交业务表单。

- [ ] **Step 7: 运行全量自动化验证**

  Run: `npm test`

  Expected: PASS。

  Run: `npm run typecheck`

  Expected: PASS。

  Run: `npm run build`

  Expected: PASS。

  Run: `npm run test:e2e`

  Expected: PASS。

- [ ] **Step 8: 检查敏感信息和禁止路由**

  搜索数据库测试快照、日志、前端存储和错误响应，确认没有淘宝密码、DeepSeek Key、飞书 Secret、原始 Excel 二进制、Cookie 或验证码；确认没有新增任意直接提交 API。

- [ ] **Step 9: 更新 README**

  说明真实日期范围、实时队列边界、自动计划入口、人工商品规则、Excel 替换语义，以及“最终检查后到达的新评价由下一轮发现”。

- [ ] **Step 10: 创建最终实施提交**

  Run: `git add apps packages tests README.md package-lock.json && git commit -m "feat: complete scoped realtime review automation controls"`

## 最终验收清单

- [ ] 自定义日期不是演示数据，保存后重启仍存在并真实影响天猫筛选。
- [ ] 自动计划可从工作台编辑，设置页没有第二套冲突表单。
- [ ] 运行中观察到的新评价本轮处理；最终检查后的竞态评价留给下一轮且未被错误标记。
- [ ] 785 条/20 条分页完整处理，无重复、无死循环、扫描请求量合理。
- [ ] 人工名单商品的中评/差评不回复、不投诉；好评仍回复。
- [ ] 未知情感只先做情感判定，失败时安全转人工。
- [ ] 商品 ID 是唯一匹配依据；缺失 ID 安全停止、标题不回退、同名不同 ID 和来源成员关系符合最终矩阵。
- [ ] 删除名单后符合条件的人工保留评价可重新进入下一轮。
- [ ] 日期、计划和名单的旧修订不能覆盖新配置。
- [ ] Excel 先预览差异再替换，原始文件不落盘。
- [ ] 所有真实页面验收保持只读，不触发回复或投诉提交。
- [ ] `npm test`、`npm run typecheck`、`npm run build`、`npm run test:e2e` 全部通过。
