# Safe Review Reopen and Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a locally failed, never-submitted review to be deleted and processed again, while recovering from ordinary prior-run errors without risking duplicate platform replies.

**Architecture:** Add one guarded transactional API that removes every nonterminal source-key record only before any external submission boundary. Expose it in Reply Results and make a new immediate run reset presentation-only failure state while retaining sent and uncertain protections.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React, TanStack Query, Vitest.

---

### Task 1: Backend safe reopen

**Files:**
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/app.ts`

- [ ] Add a failing API test proving a failed draft can be deleted and rediscovered as new.
- [ ] Add failing protection tests for sent and uncertain records.
- [ ] Run the focused tests and confirm the new endpoint is absent/failing.
- [ ] Implement a transaction that validates reply, complaint, lock and tombstone states before deletion.
- [ ] Run focused backend tests and confirm all pass.

### Task 2: Reply Results action

**Files:**
- Modify: `apps/web/src/pages/replies.test.tsx`
- Modify: `apps/web/src/pages/replies.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] Run the existing cleanup test and fix any regression.
- [ ] Add a failing test for “删除并允许重新处理”.
- [ ] Add the mutation, protected-state visibility rule, confirmation and success message.
- [ ] Run focused web tests and confirm all pass.

### Task 3: New-run recovery

**Files:**
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/app.ts` or the owning automation state module identified by the test.

- [ ] Add a failing test that starts a new run after an ordinary recoverable failure.
- [ ] Reset stale display/error state at the start boundary without changing sent or uncertain records.
- [ ] Run focused automation tests and confirm all pass.

### Task 4: Verification and package

**Files:**
- Verify all changed server/web files.
- Rebuild: `release/天猫评论助手`
- Create: updated deployment zip under `release/`.

- [ ] Run server and web test suites.
- [ ] Run type checks and production build.
- [ ] Run the critical browser flow with native viewport, page size 5, modal dismissal and second-run recovery.
- [ ] Back up existing release data, rebuild Windows package, restore data, and validate archive contents.
