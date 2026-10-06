# `chromex.exe` Chrome Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让程序兼容安装在 `Google\Chrome\Bin\chromex.exe` 的 Chrome，同时保持严格校验和真实启动验证。

**Architecture:** 扩展现有 `browser-executable` 的候选路径和允许文件名集合；扩展 Windows 文件选择器的筛选规则。浏览器驱动、设置 API 和真实启动验证流程保持不变，由现有链路自然接收新路径。

**Tech Stack:** TypeScript、Vitest、PowerShell Windows Forms、Patchright

---

### Task 1: 路径解析与安全校验

**Files:**
- Modify: `apps/server/src/tmall/browser-executable.test.ts`
- Modify: `apps/server/src/tmall/browser-executable.ts`

- [ ] 添加失败测试：标准候选列表包含 `%LOCALAPPDATA%\Google\Chrome\Bin\chromex.exe`。
- [ ] 添加失败测试：自定义 `chromex.exe` 路径可通过校验和解析。
- [ ] 添加失败测试：其他 `.exe` 仍被拒绝。
- [ ] 运行 `npx.cmd vitest run src/tmall/browser-executable.test.ts`，确认因功能缺失失败。
- [ ] 最小实现允许文件名集合和自动候选路径。
- [ ] 再次运行定向测试并确认通过。

### Task 2: Windows 文件选择器

**Files:**
- Modify: `apps/server/src/tmall/local-chrome-picker.test.ts`
- Modify: `apps/server/resources/select-local-chrome.ps1`

- [ ] 添加失败测试：助手脚本同时包含 `chrome.exe` 和 `chromex.exe`。
- [ ] 运行 `npx.cmd vitest run src/tmall/local-chrome-picker.test.ts`，确认失败。
- [ ] 修改文件筛选器和默认说明，使两种程序均可见。
- [ ] 再次运行定向测试并确认通过。

### Task 3: 回归、构建与发布

**Files:**
- Verify: `apps/server/src/tmall/browser-runtime.test.ts`
- Verify: `apps/server/src/app.test.ts`
- Verify: `scripts/package-windows.test.mjs`

- [ ] 运行服务端类型检查。
- [ ] 运行 Chrome、运行时和设置 API 相关测试。
- [ ] 运行可重复的服务端核心回归、前端回归和打包脚本测试。
- [ ] 生成新的跨电脑发布目录，包含当前数据库、不包含浏览器资料。
- [ ] 使用 UTF-8 文件名生成 ZIP，并核验启动程序、选择脚本、数据库及前端资源。
