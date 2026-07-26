# 天猫浏览器稳定节奏与页面元素验收实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让淘宝登录、导航和评价页操作采用条件等待与用户指定的有界人性化节奏，并建立可测试、无业务写入的页面元素验收闭环。

**Architecture:** 保留 Claude 在主工作树最新实现的 `patchright`、人性化输入/点击/评价间隔和随机 viewport，并将其以独立、可注入测试的模块安全整合到当前功能工作树；不再整合已被替换的 `playwright-extra` 或 stealth 插件。条件等待继续提供不可突破的结果上限。登录驱动只编排同框架控件解析、输入、结果状态机和后续导航。沿用现有 `/api/tmall-auth/open-review-page`、`manual_verification_required` 认证结果和自动化 `manual_action_required` 状态，不新增重复认证合同；真实元素验收复用现有定位注册表与关键元素验证，只增加固定、无参数的审计操作键。

**Tech Stack:** TypeScript、Playwright、Fastify、React、Vitest、Testing Library、SQLite。

**Spec:** `docs/superpowers/specs/2026-07-16-tmall-browser-pacing-and-element-audit-design.md`

---

## 文件结构

- Create: `apps/server/src/tmall/browser-pacing.ts` — 确定性节奏常量、逐字输入和条件等待的独立实现。
- Create: `apps/server/src/tmall/browser-pacing.test.ts` — 可控时钟、逐键事件、超时和结果状态测试。
- Create: `apps/server/src/automation/human-delay.ts` — Claude 已实现的有界人性化输入、点击、停顿和随机 viewport，补齐输入清空与测试注入边界。
- Create: `apps/server/src/automation/human-delay.test.ts` — 随机范围、输入事件、非法参数和可控测试验证。
- Create: `apps/server/src/tmall/browser-runtime.ts` — 可注入的 patchright 持久化上下文启动边界。
- Create: `apps/server/src/tmall/browser-runtime.test.ts` — patchright 与 Chrome 启动选项测试。
- Modify: `apps/server/package.json`、`package-lock.json` — 保留 `patchright` 依赖，不加入已替换的 playwright-extra/stealth 依赖。
- Modify: `apps/server/src/automation/queue-drainer.ts`、`queue-drainer.test.ts` — 保留每条评价 3～8 秒默认间隔并允许测试注入 no-op。
- Modify: `apps/server/src/app.ts`、`app.test.ts` — 透传测试用 `interItemDelay`，避免集成测试真实等待。
- Modify: `apps/server/src/tmall/auth-driver.ts` — 同框架登录控件解析、结果分类、人工验证续接和固定审计动作。
- Modify: `apps/server/src/tmall/auth-driver.test.ts` — iframe 全局唯一性、备用定位、安全弹窗和元素合同测试。
- Modify: `apps/server/src/storage/repositories.ts` — 修正新安装默认密码定位并补齐投诉类型等高风险元素元数据。
- Modify: `apps/server/src/storage/database.test.ts` — 默认定位风险与重复初始化兼容测试。
- Modify: `apps/server/src/app.ts` — 复用现有登录验证 API，保持人工验证状态与自动化状态映射。
- Modify: `apps/server/src/app.test.ts` — 电话/短信/滑动控件、重检续接、限流不误计人工验证测试。
- Modify: `apps/web/src/pages/settings.tsx` — 人工验证时显示“重新检测并继续”，不要求重新填写凭据。
- Modify: `apps/web/src/app.test.tsx` — 设置页人工验证恢复交互测试。
- Modify: `tests/e2e/console.spec.ts` — 控制台登录恢复状态的端到端 UI 回归。
- Modify: `README.md` — 稳定节奏、人工验证和只读元素验收说明。

### Task 1: 确定性浏览器节奏模块

**Files:**
- Create: `apps/server/src/tmall/browser-pacing.ts`
- Create: `apps/server/src/tmall/browser-pacing.test.ts`

- [ ] **Step 1: 写逐字输入的失败测试**

测试必须证明输入框会先清空、按顺序接收每个字符、使用固定 `80ms` 延迟，并在最终值与目标值不一致时返回安全错误；测试不记录输入值。

```ts
expect(control.calls).toEqual([
  ["fill", ""],
  ["pressSequentially", "账号", { delay: 80 }],
]);
```

- [ ] **Step 2: 写确定性动作档位和条件等待的失败测试**

覆盖 `field=400`、`navigation=300`、`filter=500`、`list=800`；等待器在探针返回明确结果时立即结束，在上限到达时返回 `timed_out`，不使用随机数。

- [ ] **Step 3: 运行测试确认 RED**

Run: `npm.cmd test -w apps/server -- src/tmall/browser-pacing.test.ts`

Expected: FAIL，原因是 `browser-pacing.ts` 尚不存在。

- [ ] **Step 4: 写最小实现**

导出只读 `TMALL_PACING`、`enterTextWithStablePacing(control, value)` 和 `waitForExplicitOutcome({ probe, wait, timeoutMs, pollMs })`。输入控件接口只暴露 `fill`、`pressSequentially`、`inputValue`，便于真实 Playwright 与单元测试共用。

- [ ] **Step 5: 运行测试确认 GREEN**

Run: `npm.cmd test -w apps/server -- src/tmall/browser-pacing.test.ts`

Expected: PASS，且无定时器泄漏和控制台警告。

- [ ] **Step 6: 本地提交**

```powershell
git add apps/server/src/tmall/browser-pacing.ts apps/server/src/tmall/browser-pacing.test.ts
git commit -m "feat: add deterministic Tmall browser pacing"
```

### Task 2: 同框架登录控件与低风险备用定位

**Files:**
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Modify: `apps/server/src/tmall/auth-driver.test.ts`
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/server/src/storage/database.test.ts`

- [ ] **Step 1: 写 iframe 控件组失败测试**

覆盖主页面、一级 iframe、嵌套 iframe；账号、密码和按钮分别在不同框架时必须失败；两个框架都具备完整控件组时必须失败；恰好一个完整控件组时返回该框架。

- [ ] **Step 2: 写备用定位失败测试**

保留现有旧密码占位符回归，并新增多个备用密码框、隐藏密码框、禁用登录按钮和非密码类型输入框；只有唯一、可见、可编辑且 `type=password` 的密码框可以通过。

- [ ] **Step 3: 运行目标测试确认 RED**

Run: `npm.cmd test -w apps/server -- src/tmall/auth-driver.test.ts`

Expected: 新增的跨框架和密码类型测试 FAIL。

- [ ] **Step 4: 实现控件组解析**

将 `findTmallLoginFrame` 改为验证同一框架内的账号、密码和按钮三元组，并遍历 `page.frames()` 做全局唯一性检查。保留 `resolveTmallLocatorWithFallback` 的唯一、可见、可编辑/可用保护，增加密码类型校验。

- [ ] **Step 5: 修正默认定位元数据**

新安装默认密码占位符改为 `请输入登录密码`；旧数据库不强制覆盖当前版本，由运行时安全备用定位兼容。将投诉类型、投诉描述和投诉提交定位明确标为高风险；重复初始化不得创建重复版本。

- [ ] **Step 6: 运行目标测试确认 GREEN**

Run: `npm.cmd test -w apps/server -- src/tmall/auth-driver.test.ts src/storage/database.test.ts`

Expected: PASS。

- [ ] **Step 7: 本地提交**

```powershell
git add apps/server/src/tmall/auth-driver.ts apps/server/src/tmall/auth-driver.test.ts apps/server/src/storage/repositories.ts apps/server/src/storage/database.test.ts
git commit -m "fix: verify Tmall login controls in one frame"
```

### Task 2A: 整合 Claude 的 patchright 与人性化延迟改动

**Files:**
- Create: `apps/server/src/automation/human-delay.ts`
- Create: `apps/server/src/automation/human-delay.test.ts`
- Modify: `apps/server/package.json`
- Modify: `package-lock.json`
- Modify: `apps/server/src/automation/queue-drainer.ts`
- Modify: `apps/server/src/automation/queue-drainer.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Create: `apps/server/src/tmall/browser-runtime.ts`
- Create: `apps/server/src/tmall/browser-runtime.test.ts`
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Modify: `apps/server/src/tmall/auth-driver.test.ts`

- [ ] **Step 1: 从主工作树读取并记录 Claude 的实际差异**

以 `G:/桌面/天猫评论回复` 主工作树相对提交 `44a6030` 的最新未提交差异为来源，保留 `patchright@^1.61.1`、`human-delay.ts`、队列评价间隔、随机 viewport 和人性化输入/点击调用。`playwright-extra` 与 stealth 已被用户替换，不得重新引入。不得通过复制旧版 `auth-driver.ts` 覆盖当前功能工作树；必须逐块整合。

- [ ] **Step 2: 写人性化延迟失败测试**

覆盖随机值始终位于批准范围、非法/反向/非有限范围立即失败、输入框先清空再逐字输入、最终输入值校验、点击前后均等待、随机 viewport 在边界内。随机源和等待函数必须可注入，使测试确定且不真实等待。

集中导出的动作档位必须完整保留并测试 Claude 当前范围：输入聚焦 `200～500ms`、字符 `60～180ms`、8% 思考概率与思考停顿 `300～800ms`、点击前 `150～600ms`、点击后 `200～500ms`、翻页后 `1500～3500ms`、直接导航后 `1000～2500ms`、打开回复后 `500～1200ms`、编辑器聚焦后 `300～700ms`、填写后 `800～2000ms`、提交后 `500～1000ms`、成功轮询 `400～800ms`、登录字段间 `300～800ms`、登录提交前 `500～1200ms`、登录提交后 `1500～3000ms`、交易菜单后 `800～2000ms`、评价管理后 `500～1500ms`、筛选后 `400～1000ms`、评价间 `3000～8000ms`、viewport 宽度偏移 `-120～120` 与高度偏移 `-80～80`。

- [ ] **Step 3: 写队列间隔失败测试**

默认生产间隔调用 3～8 秒的人性化延迟；测试注入 no-op。延迟前和延迟后都重新调用 `shouldStartNext`，暂停、停止或时间窗口结束后不开始下一条；间隔不得改变既有实时队列扫描与 `sourceKey` 去重算法。

同时在 `app.test.ts` 写集成失败测试：`buildApp({ interItemDelay })` 必须将该函数原样传给队列处理，使自动化集成测试不产生真实 3～8 秒等待。

- [ ] **Step 4: 写浏览器运行时失败测试**

通过注入假的 patchright `launchPersistentContext`，验证启动继续使用同一 profile 路径、用户选择的可见模式、随机 viewport、`zh-CN` locale，以及 Claude 的 `--disable-blink-features=AutomationControlled`、`--no-first-run`、`--no-default-browser-check` 参数。测试还必须证明运行时代码没有 `playwright-extra`、stealth 插件注册或模块级不可重置状态，不得依赖真实浏览器完成单元测试。

- [ ] **Step 5: 运行测试确认 RED**

Run: `npm.cmd test -w apps/server -- src/automation/human-delay.test.ts src/automation/queue-drainer.test.ts src/tmall/browser-runtime.test.ts src/tmall/auth-driver.test.ts src/app.test.ts`

Expected: FAIL，原因是当前功能工作树尚未整合 Claude 的模块和依赖。

- [ ] **Step 6: 安装并整合依赖与运行时**

在 `apps/server/package.json` 加入 `patchright@^1.61.1`，通过 npm 更新锁文件；保留现有 `playwright` 依赖供当前测试和其他模块使用，但生产 `auth-driver.ts` 与 `human-delay.ts` 的浏览器类型和 Chromium 来自 patchright。通过 `browser-runtime.ts` 启动持久化上下文；保留持久化 profile、可见 Chrome、随机 viewport、中文 locale 和 Claude 的启动参数。`app.ts` 仅增加 Claude 已写好的 `interItemDelay` 透传测试缝，不改变生产默认值。

- [ ] **Step 7: 安全整合人性化动作**

保留 Claude 的随机范围和 3～8 秒评价间隔；修复输入未先清空、随机参数不校验、测试不可注入等兼容问题。人性化延迟只能调节动作节奏，登录、筛选、分页、回复提交仍必须通过现有唯一性、后置状态、幂等和不确定提交保护。

- [ ] **Step 8: 运行测试与类型检查确认 GREEN**

```powershell
npm.cmd test -w apps/server -- src/automation/human-delay.test.ts src/automation/queue-drainer.test.ts src/tmall/browser-runtime.test.ts src/tmall/auth-driver.test.ts src/app.test.ts
npm.cmd run typecheck -w apps/server
```

Expected: PASS，无随机失败、真实长等待、旧 playwright-extra/stealth 残留或类型冲突。

- [ ] **Step 9: 本地提交**

```powershell
git add apps/server/package.json package-lock.json apps/server/src/automation/human-delay.ts apps/server/src/automation/human-delay.test.ts apps/server/src/automation/queue-drainer.ts apps/server/src/automation/queue-drainer.test.ts apps/server/src/app.ts apps/server/src/app.test.ts apps/server/src/tmall/browser-runtime.ts apps/server/src/tmall/browser-runtime.test.ts apps/server/src/tmall/auth-driver.ts apps/server/src/tmall/auth-driver.test.ts
git commit -m "feat: integrate patchright browser pacing"
```

### Task 3: 登录结果状态机与慢速输入集成

**Files:**
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Modify: `apps/server/src/tmall/auth-driver.test.ts`
- Test: `apps/server/src/tmall/browser-pacing.test.ts`

Task 1 的 `waitForExplicitOutcome` 继续承担确定性的硬上限轮询；生产输入、点击和动作间隔以 Task 2A 集中的 `human-delay.ts` 为准。Task 1 的固定输入帮助函数不作为生产人性化节奏来源。

- [ ] **Step 1: 写登录结果分类失败测试**

覆盖驱动内部结果 `authenticated`、`manual_verification_required`、`invalid_credentials` 和 `timed_out`。其中前两者映射到现有同名公开认证结果；`invalid_credentials` 与 `timed_out` 都映射为现有公开 `failed` 结果，仅使用规范化错误类别，不扩展或破坏 API 联合类型。验证码、扫码、电话/短信、安全/身份验证及任何未分类滑动控件必须进入人工验证；只允许读取白名单错误类别。

- [ ] **Step 2: 写输入顺序失败测试**

使用 Playwright DOM 夹具监听键盘事件，证明账号和密码均通过已整合的 `humanType` 逐字输入；随机源和等待函数注入固定序列以验证 Claude 批准的范围；点击前再次确认三个控件有效且输入完整。

- [ ] **Step 3: 运行目标测试确认 RED**

Run: `npm.cmd test -w apps/server -- src/tmall/auth-driver.test.ts src/tmall/browser-pacing.test.ts`

Expected: 新状态机和逐键事件断言 FAIL。

- [ ] **Step 4: 集成稳定节奏和条件等待**

`#login` 调用已整合且会先清空、最终校验的 `humanType`，不再一次性 `fill(credentials.password)` 后立即点击。点击后以 20 秒硬上限轮询明确状态；人性化延迟不能替代或突破该上限。页面公开错误规范化为中文类别，账号、密码和认证响应不进入结果或日志。

- [ ] **Step 5: 运行目标测试确认 GREEN**

Run: `npm.cmd test -w apps/server -- src/tmall/auth-driver.test.ts src/tmall/browser-pacing.test.ts`

Expected: PASS。

- [ ] **Step 6: 本地提交**

```powershell
git add apps/server/src/tmall/auth-driver.ts apps/server/src/tmall/auth-driver.test.ts apps/server/src/tmall/browser-pacing.ts apps/server/src/tmall/browser-pacing.test.ts
git commit -m "fix: wait for explicit Tmall login outcomes"
```

### Task 4: 人工验证状态映射与原会话续接

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`

- [ ] **Step 1: 写 API 失败测试**

模拟电话验证和滑动控件，断言 `/api/tmall-auth/open-review-page` 返回既有 `manual_verification_required`，不记为错误密码、不消耗两次自动登录失败额度、不关闭驱动上下文。

- [ ] **Step 2: 写重新检测续接失败测试**

第一次返回人工验证，第二次在同一驱动实例返回已认证；重新检测允许从 Windows 凭据管理器读取已保存凭据用于身份核对并继续调用既有驱动合同，但不得替换或重新持久化凭据，也不得在当前页面已经离开登录页后再次提交登录表单；不创建新认证模式。自动化控制状态从 `manual_action_required` 恢复到原来的手动或计划触发语义。

- [ ] **Step 3: 运行测试确认 RED**

Run: `npm.cmd test -w apps/server -- src/app.test.ts`

Expected: 新增的人工验证限流和状态恢复断言 FAIL。

- [ ] **Step 4: 复用现有认证合同实现映射**

集中处理 `manual_verification_required -> manual_action_required`，保留持久化浏览器上下文。明确账号密码错误才累计登录失败；人工验证和超时不错误锁定账号。复用 `/api/tmall-auth/open-review-page` 作为重新检测接口，不新增重复 API；该接口仍读取安全存储中的凭据，但驱动仅在当前页面确实是登录页时才允许执行登录表单输入。

- [ ] **Step 5: 运行测试确认 GREEN**

Run: `npm.cmd test -w apps/server -- src/app.test.ts`

Expected: PASS。

- [ ] **Step 6: 本地提交**

```powershell
git add apps/server/src/app.ts apps/server/src/app.test.ts
git commit -m "fix: resume Tmall auth after manual verification"
```

### Task 5: 设置页人工验证恢复交互

**Files:**
- Modify: `apps/web/src/pages/settings.tsx`
- Modify: `apps/web/src/app.test.tsx`
- Modify: `tests/e2e/console.spec.ts`

- [ ] **Step 1: 写前端失败测试**

当认证状态为 `manual_verification_required` 时显示清晰说明和“重新检测并继续”；账号、密码输入保持空白，点击后只调用 `/api/tmall-auth/open-review-page`。

- [ ] **Step 2: 写端到端 UI 失败测试**

模拟首次返回电话验证、再次返回认证成功，断言按钮文案和状态卡更新，不把 CSRF、HTTP 码或原始 JSON 显示给用户。

- [ ] **Step 3: 运行测试确认 RED**

Run: `npm.cmd test -w apps/web -- src/app.test.tsx`

Expected: 新人工验证文案测试 FAIL。

- [ ] **Step 4: 实现最小 UI**

复用当前 `verifyTmall` mutation，根据认证状态切换文案；不增加第二套凭据表单，不把任何凭据放入浏览器存储。

- [ ] **Step 5: 运行前端测试确认 GREEN**

Run: `npm.cmd test -w apps/web -- src/app.test.tsx`

Expected: PASS。

- [ ] **Step 6: 运行聚焦 E2E**

Run: `npx.cmd playwright test tests/e2e/console.spec.ts -g "manual verification"`

Expected: PASS。

- [ ] **Step 7: 本地提交**

```powershell
git add apps/web/src/pages/settings.tsx apps/web/src/app.test.tsx tests/e2e/console.spec.ts
git commit -m "feat: guide manual Tmall verification recovery"
```

### Task 6: 固定页面元素合同与无写入审计

**Files:**
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Modify: `apps/server/src/tmall/auth-driver.test.ts`
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/server/src/app.test.ts`

- [ ] **Step 1: 写元素后置条件失败测试**

覆盖交易菜单后出现评价管理、评价管理后 URL/页签成立、日期值吻合、有内容/未回复选中、搜索后列表证据变化或验证空队列、分页后活动页码吻合。所有条件等待分别受 20/15/8 秒上限控制。

- [ ] **Step 2: 写固定审计操作键失败测试**

只允许 `audit.reply.open`、`audit.reply.cancel`、`audit.complaint.open`、`audit.complaint.cancel`；API 和驱动不得接受任意选择器、坐标或通用点击参数。投诉类型、描述、提交和结果标识只用脱敏夹具验证。

- [ ] **Step 3: 写实时队列兼容回归测试**

确认本任务不改变既有“每次外部动作后刷新、连续两次完整扫描、每次末尾第一页最终检查”算法，也不把同分类随机话术与 `sourceKey` 幂等混为一谈。

- [ ] **Step 4: 运行测试确认 RED**

Run: `npm.cmd test -w apps/server -- src/tmall/auth-driver.test.ts src/app.test.ts`

Expected: 新增元素合同测试 FAIL。

- [ ] **Step 5: 实现固定合同**

扩展现有 `verifyCriticalElements` 和定位注册表，不新增公开“任意点击”接口。审计只打开首层回复/投诉入口并立即取消；真实验收不选择投诉类型、不填写、不提交。

- [ ] **Step 6: 运行测试确认 GREEN**

Run: `npm.cmd test -w apps/server -- src/tmall/auth-driver.test.ts src/app.test.ts`

Expected: PASS。

并显式运行实时队列专门回归：

Run: `npm.cmd test -w apps/server -- src/automation/queue-drainer.test.ts`

Expected: PASS，覆盖处理期间新增评价、外部动作刷新和最终判空。

- [ ] **Step 7: 本地提交**

```powershell
git add apps/server/src/tmall/auth-driver.ts apps/server/src/tmall/auth-driver.test.ts apps/server/src/storage/repositories.ts apps/server/src/app.test.ts
git commit -m "test: verify Tmall page element contracts safely"
```

### Task 7: 文档、完整回归与真实只读验收

**Files:**
- Modify: `README.md`
- Verify: all changed files

- [ ] **Step 1: 更新用户文档**

说明稳定节奏不是模拟真人；电话/短信/滑动控件需要用户在原窗口完成；“重新检测并继续”复用会话；元素验收不会回复或投诉。

- [ ] **Step 2: 运行完整自动化验证**

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test:e2e
git diff --check
```

Expected: 全部退出码 0，无失败测试、类型错误、构建错误或补丁空白错误。

- [ ] **Step 3: 运行安全扫描**

扫描数据库、日志、前端代码、构建产物和 Git 差异，确认不包含淘宝密码、DeepSeek/飞书密钥、Cookie、验证码、认证响应或聊天中暴露的敏感值；确认没有公开直接提交评价或任意点击 API。

- [ ] **Step 4: 真实登录只读验收**

通过产品“验证并进入评价页”使用 Windows 凭据管理器中的已保存凭据。若出现电话验证或滑动控件，保持窗口并等待用户完成；重新检测后按清单记录每步匹配数量与后置状态。

- [ ] **Step 5: 真实元素只读验收**

验证登录、交易、评价管理、日期、有内容、未回复、搜索、列表身份字段和分页。回复与投诉只允许固定首层打开后立即取消；不填写、不提交。若真实页面与合同不符，回到对应任务新增失败测试后修复。

- [ ] **Step 6: 最终本地提交**

```powershell
git add README.md apps packages tests docs
git commit -m "feat: stabilize Tmall browser operations"
```

不执行 `git push`。
