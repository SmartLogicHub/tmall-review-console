# Reply Timeout and Complaint Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. The user explicitly prohibited agents, so this plan is executed inline with red-green checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent late reply clicks after the 180-second deadline, make pre-submit verification fast and accurately represented, reconcile platform-confirmed replies, and recover transient complaint-analysis failures including the supplied Traditional Chinese review.

**Architecture:** Keep reply attempts pending during target verification, use scan-time row hints for a one-row identity recheck with full-scan fallback, and write the existing `submitting/submitted_at` checkpoint immediately before the final click. Compose the browser deadline with an operation activity token so timed-out work cannot perform later side effects; classify post-checkpoint interruptions as uncertain and reconcile authoritative `reply_record` evidence. Extend complaint-model retry to unknown invocation errors while preserving the complaint lock and strict fail-closed behavior.

**Tech Stack:** TypeScript, Fastify, SQLite/better-sqlite3, Patchright/Playwright, Vitest, React Query, React/Vite, .NET Windows launcher

---

### Task 1: Reproduce the reply deadline race

**Files:**
- Modify: `apps/server/src/tmall/auth-driver.test.ts`
- Modify: `apps/server/src/submission/service.test.ts`
- Modify: `apps/server/src/app.test.ts`

- [ ] Add a deadline test whose old operation reaches a click checkpoint after the public timeout.
- [ ] Assert cancellation makes the operation inactive and the delayed click never occurs.
- [ ] Add service tests for timeout before and after the durable submit callback.
- [ ] Run focused tests and verify the new assertions fail for the expected reasons.

### Task 2: Add operation activity and a durable final-click boundary

**Files:**
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Modify: `apps/server/src/submission/service.ts`
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/server/src/app.ts`
- Test: corresponding files from Task 1

- [ ] Add an optional reply-submission control containing `shouldContinue` and `beforeSubmit`.
- [ ] Keep attempts pending during verification; call `markSubmitting` only from `beforeSubmit` immediately before final click.
- [ ] Make the app deadline cancel callback synchronously invalidate the per-call activity token.
- [ ] Check activity before every browser side effect and before the durable callback/final click.
- [ ] Map a pre-checkpoint interruption to a safe failed/skip result and a post-checkpoint interruption to `submission_uncertain`.
- [ ] Run focused tests to green.

### Task 3: Add fast target-row revalidation with safe fallback

**Files:**
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Modify: `apps/server/src/tmall/auth-driver.test.ts`

- [ ] Add failing tests for a valid scan-time row hint, a shifted row requiring fallback, and duplicate source keys during initial scan.
- [ ] Record the native reply-action index in `TmallReviewTargetHint`.
- [ ] Rebuild and verify only the hinted row when the review context is unchanged.
- [ ] Fall back to existing full-page unique matching on any hint mismatch.
- [ ] Adjust later indices after a successful row removal and retain identity validation as the final authority.
- [ ] Run focused tests to green.

### Task 4: Reconcile authoritative reply records

**Files:**
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/server/src/drafts/processor.test.ts`
- Verify: `apps/server/src/drafts/processor.ts`

- [ ] Add failing tests for `reply_record` observed while local attempt is failed, submitting, or submission-uncertain.
- [ ] Atomically mark attempt and draft sent, clear the action lock, and create `reply_sent` tombstone.
- [ ] Prove repeated reconciliation is idempotent and never sends again.
- [ ] Run focused tests to green.

### Task 5: Recover complaint-analysis internal failures

**Files:**
- Modify: `apps/server/src/complaints/complaint-review-service.test.ts`
- Modify: `apps/server/src/complaints/complaint-review-service.ts`
- Modify: `apps/server/src/complaints/deepseek-complaint-analysis.test.ts`
- Modify: `apps/server/src/complaints/deepseek-complaint-analysis.ts`
- Modify: `apps/server/src/drafts/processor.test.ts`

- [ ] Add the supplied Traditional Chinese regional-registration review as a regression fixture.
- [ ] Assert geographic service limitations are ordinary product feedback, not political/terror complaint facts.
- [ ] Add a failing test where the independent complaint call throws an unknown error once and then returns `no_complaint`.
- [ ] Permit one retry for unknown model invocation errors, excluding configuration and pause.
- [ ] Prove a repeated unknown error stays fail-closed, ends only the current record, and is recoverable on the next scan.
- [ ] Run focused tests to green.

### Task 6: Make UI status match the backend phase

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/web/src/pages/replies.tsx`
- Modify: `apps/web/src/pages/replies.test.tsx`
- Verify: `apps/web/src/pages/run-center.tsx`

- [ ] Show “正在核对目标评价” during the pending verification phase.
- [ ] Keep “正在发送” limited to the durable final-click window.
- [ ] Preserve “等待平台同步” for post-click uncertainty.
- [ ] Run focused web tests to green.

### Task 7: Full verification and Windows packaging

**Files:**
- Verify: all workspaces
- Output: `release-fixed-20260723-v5` or the next unused release directory

- [ ] Run complaint, submission, storage, processor, app and web focused suites.
- [ ] Run all workspace tests.
- [ ] Run all type checks.
- [ ] Run all builds.
- [ ] Run Windows package safety tests.
- [ ] Package a clean Windows release without local API keys, cookies, database, or browser profile.
- [ ] Verify launcher, Node runtime, web assets and server source/runtime layout.
- [ ] Report what was proven locally and what still requires a real second-computer Tmall run.
