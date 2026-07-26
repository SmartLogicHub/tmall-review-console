# Complaint Entry and Safe Routing Implementation Plan

> **For agentic workers:** Execute inline in the current session. The user explicitly prohibited subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent mistaken complaints, distinguish platform handling from this program's successful complaint submission, and keep page-driven processing alive through per-item and browser-frame failures.

**Architecture:** Treat the current visible row and review phase as the only platform-state authority. Screen complaints with explicit platform-violation signals before using AI, keep ordinary dissatisfaction in the reply path, persist separate platform-handled and self-submitted outcomes, and isolate every failure to the current item.

**Tech Stack:** TypeScript, Fastify, Patchright/Playwright, React, SQLite/better-sqlite3, Vitest, Node.js Windows packaging

---

### Task 1: Lock down complaint candidate routing

**Files:**
- Modify: `apps/server/src/complaints/production-complaint-review-policy.ts`
- Test: `apps/server/src/complaints/production-complaint-review-policy.test.ts`

- [ ] Add a failing test proving an ordinary negative or mixed product review never calls complaint AI.
- [ ] Add controls proving explicit advertising, privacy, harmful-content and targeted-abuse signals still enter complaint analysis.
- [ ] Remove the blanket negative-sentiment candidate rule.
- [ ] Run the focused complaint-policy tests.

### Task 2: Represent platform handling and self-submitted complaints separately

**Files:**
- Modify: `apps/server/src/tmall/review-reader.ts`
- Modify: `apps/server/src/complaints/complaint-review-service.ts`
- Modify: `apps/server/src/storage/complaint-repository.ts`
- Test: corresponding server tests

- [ ] Add failing tests for visible complaint entry, no entry, platform-handled state, rejected submission and confirmed self-submission.
- [ ] Ensure no-entry/`already_handled` never writes the same state as confirmed program submission.
- [ ] Require both a durable pre-click checkpoint and explicit post-click platform success for self-submitted success.

### Task 3: Scope platform evidence to the current visible row and phase

**Files:**
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Modify: `apps/server/src/tmall/review-reader.ts`
- Test: `apps/server/src/tmall/auth-driver.test.ts`
- Test: `apps/server/src/tmall/review-reader.test.ts`

- [ ] Add a failing test where another row or a hidden element contains “投诉评价记录”.
- [ ] Add a failing test where initial and follow-up actions coexist.
- [ ] Collect only visible action elements under the exact current row and phase surface.
- [ ] Stop passing broad row text as platform action evidence.

### Task 4: Make page evidence override imported viewing history safely

**Files:**
- Modify: `apps/server/src/drafts/processor.ts`
- Modify: `apps/server/src/storage/repositories.ts`
- Test: `apps/server/src/drafts/processor.test.ts`
- Test: `apps/server/src/storage/database.test.ts`

- [ ] Add a failing test where an imported terminal state exists but the current page still exposes an actionable reply.
- [ ] Keep only current-session click checkpoints as temporary duplicate protection.
- [ ] Reconcile imported/display history to the current platform row instead of skipping the row.

### Task 5: Continue after per-item failures and survive detached frames

**Files:**
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/src/tmall/auth-driver.test.ts`
- Test: `apps/server/src/app.test.ts`
- Test: `apps/server/src/index.lifecycle.test.ts`

- [ ] Add a failing test reproducing `locator.all: Frame was detached`.
- [ ] Catch each page/frame candidate failure, reacquire fresh frames and retry within a bound.
- [ ] Ensure a complaint or page failure returns a per-item outcome and the next snapshot is processed.
- [ ] Reconcile orphan `running` automation rows at startup.

### Task 6: Show exact current reasons

**Files:**
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/web/src/pages/replies.tsx`
- Test: `apps/web/src/pages/replies.test.tsx`

- [ ] Add failing tests proving current draft state takes precedence over stale complaint errors.
- [ ] Replace generic “已按规则跳过” with the persisted specific reason.
- [ ] Display platform-handled and self-submitted outcomes distinctly.

### Task 7: Correct packaged state and verify

**Files:**
- Modify if needed: `scripts/correct-imported-reply-history.mjs`
- Test: `scripts/correct-imported-reply-history.test.mjs`
- Output: new release directory and ZIP

- [ ] Add a failing correction test for old failed complaint cases and orphan running rows.
- [ ] Produce a corrected copy without overwriting source data.
- [ ] Run focused tests, full tests, typecheck and production build.
- [ ] Verify SQLite integrity, package layout, ZIP CRC and hashes.
- [ ] Perform read-only browser verification; only perform real submissions within the user's explicitly approved test scope.
