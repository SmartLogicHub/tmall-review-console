# Custom Chrome Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让评论助手自动识别标准 Chrome，并在识别失败时允许用户选择、验证和保存自定义 `chrome.exe`。

**Architecture:** 将浏览器路径解析、Windows 文件选择和 Chrome 启动验证拆成独立模块。浏览器驱动通过路径提供器在每次新建上下文时读取当前有效路径，API 负责事务式“选择—启动验证—保存”，设置页只展示用户可理解的状态和操作。

**Tech Stack:** TypeScript、Fastify、React、TanStack Query、Patchright、PowerShell Windows Forms、Vitest

---

### Task 1: 浏览器路径解析

**Files:**
- Create: `apps/server/src/tmall/browser-executable.ts`
- Create: `apps/server/src/tmall/browser-executable.test.ts`

- [ ] 写失败测试：有效自定义路径优先、失效时回退标准路径、均不存在时返回缺失、拒绝非 `chrome.exe`。
- [ ] 运行测试并确认因模块不存在而失败。
- [ ] 实现纯路径解析与状态结构，文件存在性通过注入函数测试。
- [ ] 运行测试并确认通过。

### Task 2: Windows Chrome 文件选择器

**Files:**
- Create: `apps/server/resources/select-local-chrome.ps1`
- Create: `apps/server/src/tmall/local-chrome-picker.ts`
- Create: `apps/server/src/tmall/local-chrome-picker.test.ts`

- [ ] 写失败测试：选择、取消、非 Windows、进程失败、并发和关闭。
- [ ] 运行测试并确认失败。
- [ ] 复用现有本地 Excel 选择器的进程管理方式，实现 Chrome 选择器。
- [ ] 运行测试并确认通过。

### Task 3: 浏览器运行时支持显式路径

**Files:**
- Modify: `apps/server/src/tmall/browser-runtime.ts`
- Modify: `apps/server/src/tmall/browser-runtime.test.ts`
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Modify: `apps/server/src/tmall/auth-driver.test.ts`
- Modify: `apps/server/src/index.ts`

- [ ] 写失败测试：提供路径时传递 `executablePath` 且不传 `channel`；未提供时仍传 `channel: "chrome"`。
- [ ] 写失败测试：驱动每次重新启动上下文时读取最新路径提供器。
- [ ] 运行测试并确认失败。
- [ ] 实现最小运行时和驱动改动，并在入口用数据库设置提供有效路径。
- [ ] 运行相关测试并确认通过。

### Task 4: 浏览器选择与状态 API

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`

- [ ] 写失败测试：获取状态、选择取消、验证成功保存、验证失败不保存、运行中拒绝、恢复自动识别。
- [ ] 运行测试并确认失败。
- [ ] 注入选择器与启动验证函数，实现 `/api/tmall-browser/status`、`/select` 和 `/clear`。
- [ ] 保存或清除后关闭现有淘宝浏览器上下文，使下一次登录使用新路径。
- [ ] 运行 API 测试并确认通过。

### Task 5: 设置页交互

**Files:**
- Modify: `apps/web/src/pages/settings.tsx`
- Modify: `apps/web/src/app.test.tsx`

- [ ] 写失败测试：缺失时显示选择按钮、自定义路径成功展示、取消不报错、恢复自动识别。
- [ ] 运行测试并确认失败。
- [ ] 在淘宝登录卡片中加入简洁的浏览器状态和操作，不显示工程诊断信息。
- [ ] 成功选择后刷新浏览器状态和淘宝登录状态。
- [ ] 运行界面测试并确认通过。

### Task 6: 回归、构建与发布

**Files:**
- Modify: `scripts/package-windows.test.mjs`

- [ ] 增加发布布局测试，确认 Chrome 选择 PowerShell 资源被包含。
- [ ] 运行 `npm test`。
- [ ] 运行 `npm run typecheck`。
- [ ] 运行 `npm run build`。
- [ ] 使用 `npm run package:windows:transfer` 生成保留数据库、不含浏览器资料的新目录。
- [ ] 核验 SQLite 完整性、包内文件与压缩包 SHA-256。
