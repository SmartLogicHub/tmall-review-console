# Lock-Free Login Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove startup mutexes and make saved-credential login retryable without blocking later runs.

**Architecture:** The launcher reuses an already healthy localhost service and otherwise starts one; TCP port ownership replaces named mutexes. The automation run reads saved credentials through a bounded retry helper and delegates login/SMS handling to the existing browser driver.

**Tech Stack:** TypeScript, Fastify, Vitest, C# WinForms launcher, Playwright.

---

### Task 1: Remove named startup mutexes

**Files:**
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/single-instance.test.ts`
- Modify: `apps/launcher/Program.cs`
- Test: `scripts/package-windows.test.mjs`

- [ ] Add failing source tests proving neither entry point constructs a named Mutex or PowerShell mutex guard.
- [ ] Run the focused tests and confirm failure.
- [ ] Remove both mutex integrations; let the launcher health probe and TCP port own startup arbitration.
- [ ] Run focused launcher/server tests.

### Task 2: Retry saved credential reads and preserve manual login behavior

**Files:**
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/app.ts`

- [ ] Add a failing run test where the first credential read throws and the second succeeds.
- [ ] Add a failing run test for a persistent credential-read failure with a clear retryable status.
- [ ] Implement bounded credential reads used by automation login startup.
- [ ] Verify automatic login proceeds and SMS/manual states remain unchanged.

### Task 3: Remove user-facing lock wording and test locally

**Files:**
- Modify: `apps/web/src/pages/run-center.tsx`
- Modify: `apps/web/src/app.test.tsx`

- [ ] Add a failing UI assertion that no “本轮已锁定” text appears.
- [ ] Replace it with neutral current-run scope wording.
- [ ] Run server, web, typecheck and real-browser tests.
- [ ] Start the current workspace for user verification; do not package.
