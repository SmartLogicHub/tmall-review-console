# Platform Reconciliation and Browser Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. The user prohibited agents, so this plan is executed inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make platform complaint outcomes authoritative, prevent duplicate complaint/reply actions, keep per-record failures from pausing the queue, and eliminate browser close/reopen races and raw Playwright errors.

**Architecture:** Extend row-scoped Tmall snapshots with phase-specific platform action evidence, reconcile that evidence atomically before AI processing, and classify every browser outcome by submit checkpoint. Add an explicit browser lifecycle gate so timeouts and paused states cannot implicitly close/relaunch Chrome, then map all low-level failures to stable business errors for the UI.

**Tech Stack:** TypeScript, Fastify, SQLite/better-sqlite3, Patchright/Playwright, Vitest, React Query, React/Vite, .NET Windows launcher

---

### Task 1: Platform action evidence

**Files:**
- Modify: `apps/server/src/tmall/review-reader.ts`
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Test: `apps/server/src/tmall/auth-driver.test.ts`

- [ ] Write failing row-scoped tests for complaint upheld, complaint record, reply record, and initial/followup separation.
- [ ] Run the focused tests and confirm expected failures.
- [ ] Add the minimal snapshot fields and row parser.
- [ ] Run focused tests to green.

### Task 2: Atomic platform reconciliation and terminal skip

**Files:**
- Modify: `apps/server/src/storage/complaint-repository.ts`
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/server/src/drafts/processor.ts`
- Test: `apps/server/src/complaints/complaint-review-service.test.ts`
- Test: `apps/server/src/drafts/processor.test.ts`

- [ ] Write failing tests for local failed + platform upheld, existing complaint record, rejected-but-replyable, and old internal failures.
- [ ] Verify they fail because platform evidence is ignored.
- [ ] Implement idempotent reconciliation and tombstones before AI/complaint work.
- [ ] Prove existing platform actions never open complaint or reply flows.

### Task 3: Per-record complaint failures continue the queue

**Files:**
- Modify: `apps/server/src/complaints/complaint-review-service.ts`
- Modify: `apps/server/src/complaints/production-complaint-review-policy.ts`
- Modify: `apps/server/src/drafts/processor.ts`
- Modify: `apps/server/src/app.ts`
- Tests: corresponding `*.test.ts`

- [ ] Write failing tests proving pre-click platform/page failures return a safe skip rather than `manual_action_required`.
- [ ] Preserve `submission_uncertain` after the click and forbid automatic retry.
- [ ] Keep only identity, authentication, verification and lock failures as whole-run blockers.
- [ ] Verify queue drain advances to the next snapshot.

### Task 4: Browser deadline and restart gate

**Files:**
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Modify: `apps/server/src/app.ts`
- Tests: `apps/server/src/tmall/auth-driver.test.ts`, `apps/server/src/app.test.ts`

- [ ] Write a failing race test where cancellation closes a context while `locator.all()` is pending.
- [ ] Require the stable timeout outcome to win over the close-induced error.
- [ ] Write failing tests that paused/manual/error/disabled states cannot implicitly relaunch a browser.
- [ ] Implement explicit restart permission and one-shot active-run recovery.
- [ ] Verify genuine user-initiated continue can relaunch.

### Task 5: Login page selection and classification

**Files:**
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Test: `apps/server/src/tmall/auth-driver.test.ts`

- [ ] Write failing tests for multiple pages and a transient/hidden login surface.
- [ ] Prefer the verified review page over `pages()[0]`.
- [ ] Require stable visible login evidence before returning `session.login`.
- [ ] Keep the browser open for real manual login verification.

### Task 6: Business-safe UI errors and disconnected state

**Files:**
- Modify: `apps/server/src/submission/service.ts`
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/web/src/pages/replies.tsx`
- Modify: `apps/web/src/pages/complaints.tsx`
- Modify: `apps/web/src/pages/run-center.tsx`
- Tests: server and web counterparts

- [ ] Write failing tests that raw Playwright strings never reach reply/complaint operator views.
- [ ] Map pre-click closed/timeout, post-click uncertain, platform handled and authentication outcomes to Chinese messages.
- [ ] Add a query-error state that does not present stale running data as live.
- [ ] Run focused tests to green.

### Task 7: Regression, build, packaging and runtime verification

**Files:**
- Verify all workspaces.
- Package to a new clean directory; do not overwrite v2.

- [ ] Run focused server/web tests for every red-green cycle.
- [ ] Run `npm.cmd test`.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd run build`.
- [ ] Run `npm.cmd run package:windows` with a new output directory.
- [ ] Verify `includesLocalState=false`, `includesBrowserProfile=false`, and launcher layout exit code 0.
- [ ] Launch the new build, check dynamic localhost health, and perform the safe portion of real-browser acceptance.
- [ ] Clearly report any cross-computer-only scenario that still requires confirmation on the second computer.
