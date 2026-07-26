# Windows 一键启动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 生成可双击启动本地服务并打开 Web 控制台的 Windows EXE 发布包，并完成真实只读端到端验收。

**Architecture:** Fastify 同源提供生产 Web 构建；自包含 .NET 托盘启动器管理随包 Node 子进程；Node 标准输入关闭触发优雅退出。发布脚本组装固定运行时、应用文件和生产依赖。

**Tech Stack:** TypeScript、Fastify、React/Vite、Node.js、.NET 8 WinForms、Patchright、Vitest、Playwright。

---

### Task 1: 同源 Web 服务

**Files:**
- Create: `apps/server/src/static-web.ts`
- Create: `apps/server/src/static-web.test.ts`
- Modify: `apps/server/src/index.ts`

- [ ] 先写静态首页、资源、SPA 回退、404、路径穿越失败测试。
- [ ] 运行测试并确认因功能缺失失败。
- [ ] 实现最小安全静态路由并接入显式环境变量。
- [ ] 运行服务端测试和类型检查。

### Task 2: 服务生命周期

**Files:**
- Create: `apps/server/src/stdin-shutdown.ts`
- Create: `apps/server/src/stdin-shutdown.test.ts`
- Modify: `apps/server/src/index.ts`

- [ ] 先写 stdin 结束只触发一次关闭的失败测试。
- [ ] 实现可注入、幂等的关闭监听。
- [ ] 回归单实例、运行恢复和服务关闭测试。

### Task 3: Windows 托盘启动器

**Files:**
- Create: `apps/launcher/TmallReviewLauncher.csproj`
- Create: `apps/launcher/Program.cs`
- Create: `apps/launcher/LauncherPaths.cs`
- Create: `apps/launcher/LauncherPaths.test.ps1`

- [ ] 先写发布目录解析与必需文件检查测试。
- [ ] 实现单实例、健康探测、Node 子进程、浏览器打开和托盘退出。
- [ ] 发布自包含单文件 win-x64 启动器并运行路径测试。

### Task 4: 发布组装

**Files:**
- Create: `scripts/package-windows.mjs`
- Create: `scripts/package-windows.test.mjs`
- Modify: `package.json`

- [ ] 先写清单与敏感文件排除测试。
- [ ] 实现可重复的发布目录组装和内容校验。
- [ ] 运行 `npm run package:windows` 并检查产物。

### Task 5: 最终验收

- [ ] 运行全量单元测试、类型检查、生产构建与 Playwright E2E。
- [ ] 从 EXE 首次启动，验证同源页面与数据库创建。
- [ ] 再次双击验证不重复启动。
- [ ] 完成真实淘宝只读全流程、分页/实时新增算法和所有入口检查。
- [ ] 检查敏感信息、`git diff --check`，本地提交，不推送。
