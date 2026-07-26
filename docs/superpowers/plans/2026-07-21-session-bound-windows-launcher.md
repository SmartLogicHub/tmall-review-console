# 前台会话 Windows 启动器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让天猫评论助手仅在浏览器控制台页面保持活动时运行本地后端与定时自动处理，并消除固定端口、托盘常驻和旧实例静默复用带来的版本混淆。

**Architecture:** Windows 启动器每次选择新的 loopback 端口并启动当前发布目录中的 Node 服务；服务通过前端会话租约控制自动化调度与退出。前端会话使用注册、周期心跳和页面离开通知维持，最后一个会话消失后后端在现有安全停止边界完成收尾并关闭。DeepSeek 设置测试同时对实际使用的 Flash、Pro 模型执行最小聊天请求，并按模型显示验证结果。

**Tech Stack:** TypeScript、Fastify、React、TanStack Query、Vitest、Testing Library、.NET 8 WinForms、Node.js。

---

### Task 1: 服务端前台会话租约

**Files:**

- Create: `apps/server/src/ui-session-manager.ts`
- Create: `apps/server/src/ui-session-manager.test.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/app.test.ts`

- [ ] **Step 1: 写出会话注册、心跳续租、最后会话失效和重新注册取消关闭的失败测试。**

  使用可注入时钟/定时器验证会话过期不会因页面短暂刷新立即关闭服务；验证最后租约到期时只调用一次安全关闭回调。

- [ ] **Step 2: 运行单元测试，确认因模块不存在而失败。**

  Run: `npm.cmd run test -w apps/server -- --run src/ui-session-manager.test.ts`

  Expected: FAIL，原因是 `ui-session-manager` 尚不存在。

- [ ] **Step 3: 实现最小会话管理器。**

  管理器只负责会话标识、活动数量、租约过期和最后会话回调；不包含 Fastify、自动化或浏览器实现细节。

- [ ] **Step 4: 在 `buildApp` 中接入受 CSRF 保护的会话注册、心跳和关闭 API，并将自动调度限制为至少一个活动会话。**

  仅页面会话存在时调用 `rescheduleAutomation` / 启动计划任务；最后会话关闭后调用现有 `beginAutomationShutdown`，不开始新的评价处理，沿用现有 `preClose`/`onClose` 的安全收尾。

- [ ] **Step 5: 运行针对性服务端测试，确认通过。**

  Run: `npm.cmd run test -w apps/server -- --run src/ui-session-manager.test.ts src/app.test.ts`

  Expected: PASS。

### Task 2: 前端会话心跳

**Files:**

- Create: `apps/web/src/session/use-ui-session.ts`
- Create: `apps/web/src/session/use-ui-session.test.tsx`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/app.test.tsx`

- [ ] **Step 1: 写出失败测试，证明应用挂载会注册会话、周期发送心跳、卸载时释放会话。**

  测试使用假计时器和 mock fetch；测试不依赖真实浏览器或真实后端。

- [ ] **Step 2: 运行测试，确认因 hook 不存在而失败。**

  Run: `npm.cmd run test -w apps/web -- --run src/session/use-ui-session.test.tsx`

  Expected: FAIL，原因是 hook 尚不存在。

- [ ] **Step 3: 实现最小 `useUiSession` hook 并在 `App` 根组件挂载。**

  会话标识仅存在于内存；使用现有 `apiFetch` 获取 CSRF 与调用 API；`pagehide` / 卸载尽力释放，租约过期仍是后端的最终保障。

- [ ] **Step 4: 运行前端针对性测试，确认通过。**

  Run: `npm.cmd run test -w apps/web -- --run src/session/use-ui-session.test.tsx src/app.test.tsx`

  Expected: PASS。

### Task 3: 无托盘、动态端口启动器

**Files:**

- Modify: `apps/launcher/Program.cs`
- Modify: `scripts/package-windows.test.mjs`

- [ ] **Step 1: 写出启动器源代码约束失败测试。**

  验证启动器不再固定 `4300`、不再创建 `NotifyIcon`/托盘菜单、不再对任意已有服务执行静默复用；验证 Node 子进程接收动态端口、同源 origin 和 Web 路径环境变量。

- [ ] **Step 2: 运行包测试，确认现有启动器不满足新行为。**

  Run: `node --test scripts/package-windows.test.mjs`

  Expected: FAIL，原因是现有代码仍包含固定 URL/健康复用/托盘逻辑。

- [ ] **Step 3: 以最小改动实现启动器生命周期。**

  使用 loopback 临时监听器选择端口；启动随包 Node 后等待该端口健康；打开一次控制台；等待 Node 子进程退出后结束启动器。保留启动失败 MessageBox、发布目录完整性检查、标准输入优雅关闭和日志脱敏。

- [ ] **Step 4: 运行包测试，确认启动器源代码约束通过。**

  Run: `node --test scripts/package-windows.test.mjs`

  Expected: PASS。

### Task 4: 真实 Flash/Pro 验证与旧错误清理

**Files:**

- Modify: `apps/server/src/deepseek/client.ts`
- Modify: `apps/server/src/deepseek/client.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/web/src/pages/settings.tsx`
- Modify: `apps/web/src/app.test.tsx`

- [ ] **Step 1: 写出失败测试，证明连接测试必须分别调用 Flash 与 Pro 的最小聊天补全请求。**

  测试只检查模型名、请求形状、分类后的安全错误和返回的模型级结果，不包含真实 Key。

- [ ] **Step 2: 运行服务端 DeepSeek 测试，确认现有 `/models` 检查不足而失败。**

  Run: `npm.cmd run test -w apps/server -- --run src/deepseek/client.test.ts src/app.test.ts`

  Expected: FAIL，原因是当前测试只读取模型列表。

- [ ] **Step 3: 实现模型级真实验证并通过 API 返回 Flash、Pro 状态。**

  不输出 API Key、完整上游 body 或模型回复；继续使用既有 HTTP/传输错误分类。

- [ ] **Step 4: 写出并实现保存 Key 时清除旧测试错误、设置页分别展示模型验证状态的前端测试。**

  保存成功应显示“已保存，待验证”；失败提示只属于最近一次相关操作，不能与新的保存成功并列。

- [ ] **Step 5: 运行前后端针对性测试，确认通过。**

  Run: `npm.cmd run test -w apps/server -- --run src/deepseek/client.test.ts src/app.test.ts`

  Run: `npm.cmd run test -w apps/web -- --run src/app.test.tsx`

  Expected: PASS。

### Task 5: 全量验证与 Windows 发布包

**Files:**

- Generated: `release/天猫评论助手/`

- [ ] **Step 1: 运行完整测试、类型检查和生产构建。**

  Run: `npm.cmd test`

  Run: `npm.cmd run typecheck`

  Run: `npm.cmd run build`

- [ ] **Step 2: 构建 Windows 便携发布包并检查布局。**

  Run: `npm.cmd run package:windows`

  Run: `release\天猫评论助手\天猫评论助手.exe --check-layout`

- [ ] **Step 3: 检查差异和敏感信息。**

  Run: `git diff --check`

  Run: `git status --short`

  预期：无空白错误；不包含 API Key、浏览器 Cookie 或本地凭据。
