# Read-only Draft Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a persistent, inspectable, read-only Tmall review-to-draft pipeline without any reply submission capability.

**Architecture:** Extend the restricted Tmall driver with review snapshots, add strict DeepSeek JSON operations, orchestrate them in a focused draft processor, and persist every state transition in SQLite. The Fastify API reads the repository, while React polls runtime state and renders a read-only result detail.

**Tech Stack:** TypeScript, Fastify, Playwright, better-sqlite3, React, TanStack Query, Vitest, Playwright E2E.

---

### Task 1: Review snapshot contract and parser

**Files:**
- Create: `apps/server/src/tmall/review-reader.ts`
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Test: `apps/server/src/tmall/review-reader.test.ts`

- [ ] Write failing parser tests for current Tmall row text, order IDs, product titles and stable source keys.
- [ ] Run the focused test and confirm the missing module failure.
- [ ] Implement the minimal parser and restricted `readPendingReviews(limit)` driver method.
- [ ] Run focused tests and the server suite.

### Task 2: DeepSeek structured classification and rewriting

**Files:**
- Modify: `apps/server/src/deepseek/client.ts`
- Modify: `apps/server/src/deepseek/client.test.ts`

- [ ] Write failing tests for chat-completion request shape, JSON validation, invalid categories and secret-safe errors.
- [ ] Confirm the tests fail for missing methods.
- [ ] Implement `classifyReview` and `rewriteTemplate` with JSON Output and non-thinking mode.
- [ ] Run focused tests.

### Task 3: Persistent reply repository

**Files:**
- Modify: `apps/server/src/storage/database.ts`
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/server/src/storage/database.test.ts`

- [ ] Write failing migration and repository tests for idempotent discovery, stage updates, restart recovery and list/detail queries.
- [ ] Confirm failures before migration 2 exists.
- [ ] Add `reply_drafts` and `ReplyRepository`.
- [ ] Run storage tests.

### Task 4: Draft processing service

**Files:**
- Create: `apps/server/src/drafts/processor.ts`
- Create: `apps/server/src/drafts/processor.test.ts`

- [ ] Write failing tests for exact match, fallback categories, random selection persistence, review mismatch attention and partial failures.
- [ ] Confirm the service is missing.
- [ ] Implement the smallest sequential batch processor with a pause callback.
- [ ] Run focused tests.

### Task 5: Runtime API integration

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/state.ts`
- Modify: `apps/server/src/app.test.ts`

- [ ] Write failing API tests proving start launches a read-only batch, dashboard metrics come from SQLite and detail contains processing evidence.
- [ ] Confirm current in-memory endpoints fail the new expectations.
- [ ] Wire repositories, processor and background batch lifecycle into start/pause/continue.
- [ ] Add `POST /api/replies/:id/reprocess` without any submission route.
- [ ] Run server tests and retain the no-submit regression assertion.

### Task 6: Result review UI

**Files:**
- Modify: `apps/web/src/pages/replies.tsx`
- Modify: `apps/web/src/pages/run-center.tsx`
- Modify: `apps/web/src/app.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] Write failing UI tests for polling, persisted rows, read-only detail and absence of submission controls.
- [ ] Confirm tests fail against the current flat table.
- [ ] Implement selectable rows, detail drawer, evidence sections, retry action and honest runtime copy.
- [ ] Run web tests and visual checks at desktop and narrow widths.

### Task 7: Final verification

- [ ] Run `npm test` and confirm zero failures.
- [ ] Run `npm run typecheck` and confirm zero TypeScript errors.
- [ ] Run `npm run build` and confirm exit code 0.
- [ ] Run `npm run test:e2e` and confirm all browser tests pass.
- [ ] Verify compiled server contains no review submission route or browser reply-fill/click operation.
