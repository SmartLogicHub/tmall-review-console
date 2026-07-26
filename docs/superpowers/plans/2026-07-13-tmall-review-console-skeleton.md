# Tmall Review Console Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable, read-only local Web console skeleton that follows the approved console and login-recovery specifications without implementing real Tmall reply submission.

**Architecture:** Use a small npm workspace with a shared TypeScript domain package, a Fastify local API, and a React/Vite console. The shared package owns state machines, template-field normalization, and retention metadata so Feishu column changes remain configurable. The server exposes safe in-memory skeleton endpoints; the browser UI consumes only those endpoints and clearly labels every workflow as read-only validation.

**Tech Stack:** Node.js, TypeScript, npm workspaces, Fastify, React, Vite, TanStack Query, React Router, Tailwind CSS, Radix UI, Zod, Vitest, Testing Library, Playwright.

**Scope note:** The workspace is not currently a Git repository, so worktree creation and commit checkpoints are unavailable. This plan does not initialize Git without the user's request.

---

### Task 1: Workspace and Test Harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`

- [ ] Create npm workspace manifests and TypeScript project boundaries.
- [ ] Install the exact runtime and test dependencies.
- [ ] Add root `test`, `typecheck`, `build`, and `dev` commands.
- [ ] Verify all empty-package checks start successfully before behavior is added.

### Task 2: Shared Domain Contracts and Feishu Adapter

**Files:**
- Create: `packages/domain/src/runtime.test.ts`
- Create: `packages/domain/src/templates.test.ts`
- Create: `packages/domain/src/retention.test.ts`
- Create: `packages/domain/src/runtime.ts`
- Create: `packages/domain/src/templates.ts`
- Create: `packages/domain/src/retention.ts`
- Create: `packages/domain/src/contracts.ts`
- Create: `packages/domain/src/index.ts`

- [ ] Write failing tests for allowed runtime transitions and prohibited real-submit states.
- [ ] Run tests and confirm they fail because the domain implementation is missing.
- [ ] Implement the minimal runtime and Tmall-auth state contracts.
- [ ] Write failing tests for configurable category/keyword field names, dynamic `回复话术 N`, blank values, duplicate replies, and sequence gaps.
- [ ] Implement a normalizer that produces `{primaryCategory, category, keywords, replies}` without hard-coding the current Feishu headers.
- [ ] Write failing tests requiring every persistent skeleton data type to have a retention and cleanup declaration.
- [ ] Implement the retention catalogue and re-run all domain tests.

### Task 3: Read-only Local API Skeleton

**Files:**
- Create: `apps/server/src/app.test.ts`
- Create: `apps/server/src/security.test.ts`
- Create: `apps/server/src/state.ts`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/index.ts`

- [ ] Write failing tests for runtime, dashboard, replies, template sources, locator health, storage, settings, and Tmall-auth status endpoints.
- [ ] Write failing tests proving the runtime supports only `start`, `pause`, and `continue` in read-only mode.
- [ ] Write failing tests for Host validation, no CORS, session-cookie protection, CSRF protection on mutations, and `Cache-Control: no-store`.
- [ ] Implement the Fastify app with an in-memory skeleton store and deterministic demonstration records.
- [ ] Implement configurable good/bad template-source field mappings; do not call Feishu yet.
- [ ] Implement explicit `not_implemented` connection-test responses for DeepSeek, Feishu, Credential Manager, and Playwright adapters.
- [ ] Verify no route or service capable of real Tmall reply submission exists.

### Task 4: Five-page Console UI

**Files:**
- Create: `apps/web/index.html`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/tailwind.config.ts`
- Create: `apps/web/postcss.config.cjs`
- Create: `apps/web/src/test/setup.ts`
- Create: `apps/web/src/app.test.tsx`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app.tsx`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/styles.css`
- Create: `apps/web/src/components/*`
- Create: `apps/web/src/pages/*`

- [ ] Write failing UI tests for the persistent read-only banner, five navigation destinations, runtime controls, template field mapping, and password non-persistence behavior.
- [ ] Build the console shell using the approved Fog/Paper/Ink/Rose visual tokens and bundled Noto Sans SC/Manrope fonts.
- [ ] Implement the Run Center with health states, metrics, the signature processing rail, queue, and recent-result comparison.
- [ ] Implement Replies, Template Configuration, Element Health, and System Settings pages with loading, empty, success, and unavailable states.
- [ ] Implement the Tmall login card using blank password inputs, masked account display, disabled unsafe actions, and explicit manual-verification states.
- [ ] Keep Feishu field mapping editable so `一级分类/二级分类/包含关键词/回复话术 N` can change without code changes.
- [ ] Verify no UI text or control claims that a reply was submitted.

### Task 5: Integration and Visual Verification

**Files:**
- Create: `scripts/dev.mjs`
- Create: `tests/e2e/console.spec.ts`
- Create: `playwright.config.ts`
- Create: `README.md`

- [ ] Write the E2E smoke test before wiring the final dev launcher.
- [ ] Start the local Fastify service and Vite console through one root command.
- [ ] Verify navigation, runtime start/pause/continue, template mapping edits, and the settings login form against the local API.
- [ ] Run unit tests, type checking, production builds, and E2E tests.
- [ ] Capture and inspect 1366×768 and 1600×900 screenshots for overflow, clipping, readability, and the approved visual direction.
- [ ] Document what the skeleton implements and which adapters intentionally remain disconnected.

