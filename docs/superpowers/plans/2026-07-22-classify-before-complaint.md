# Classify Before Complaint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. This execution is explicitly inline because the user prohibited agents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure page-sentiment `unknown` reviews are ordinarily classified before complaint screening, while preserving the one-action-only safety boundary and safely recovering unstarted historical complaint failures.

**Architecture:** Move complaint candidate evaluation after the ordinary classification/sentiment result but before persisting the template checkpoint. Permit only the existing narrowly defined failed-complaint recovery claim to perform classification under a complaint lock; after classification, either atomically release the unstarted complaint case to a reply lock or continue strict complaint analysis with the complaint lock.

**Tech Stack:** TypeScript, Fastify, SQLite/better-sqlite3, Vitest, React/Vite, .NET Windows launcher

---

### Task 1: Reproduce the production failure

**Files:**
- Modify: `apps/server/src/drafts/processor.test.ts`

- [ ] Add a test with `sentimentLabel: "unknown"`, ordinary positive review text, a successful ordinary classifier, and a complaint model that throws if called.
- [ ] Assert ordinary classification and rewrite complete without complaint analysis.
- [ ] Run the single test and verify it fails because complaint analysis runs before classification.

### Task 2: Put semantic classification before complaint evaluation

**Files:**
- Modify: `apps/server/src/drafts/processor.ts`
- Modify: `apps/server/src/complaints/production-complaint-review-policy.ts`

- [ ] Move complaint evaluation after the ordinary classification/sentiment result and before the template checkpoint.
- [ ] Pass an effective positive/negative sentiment derived from the final classification to complaint screening.
- [ ] Preserve explicit-violation screening for final-positive content.
- [ ] Keep complaint decisions terminal before template selection, rewrite, or submission-ready reply state.
- [ ] Run the new test and verify it passes.

### Task 3: Recover safe historical `unknown + internal` failures

**Files:**
- Modify: `apps/server/src/drafts/processor.test.ts`
- Modify: `apps/server/src/drafts/processor.ts`
- Modify: `apps/server/src/storage/repositories.ts`
- Verify: `apps/server/src/storage/complaint-repository.ts`

- [ ] Add a test that seeds an `unknown` draft and an `internal` complaint failure without type, facts, description, or attempt.
- [ ] Verify the test fails at the complaint action lock before the fix.
- [ ] Allow only the special failed-complaint processing claim to renew/assert its AI lease during ordinary classification.
- [ ] Skip re-running the already completed manual-product gate on that recovery path.
- [ ] After classification, release an ordinary review through `releaseUnstartedAnalysisAsNoComplaint`; keep a real candidate on the complaint path.
- [ ] Verify the historical recovery test passes and the lock becomes `reply`.

### Task 4: Prove complaint safety boundaries

**Files:**
- Modify: `apps/server/src/drafts/processor.test.ts`
- Modify: `apps/server/src/complaints/production-complaint-review-policy.test.ts`
- Verify: `apps/server/src/storage/complaint-repository.test.ts`

- [ ] Add/adjust tests proving a final-negative unknown review still invokes strict complaint analysis.
- [ ] Prove an explicit violation in final-positive text still invokes strict complaint analysis.
- [ ] Prove prepared/submitting/submitted/submission-uncertain cases are never released.
- [ ] Run the focused server tests and verify all pass.

### Task 5: Full verification and packaging

**Files:**
- Verify: all workspaces
- Output: a new workspace-local release directory without overwriting a running package

- [ ] Run `npm.cmd test`.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd run build`.
- [ ] Package a fresh Windows EXE to a new release directory.
- [ ] Run launcher layout verification and compare packaged server/web artifacts to the built workspace.

### Task 6: Real control-interface and runtime verification

**Files:**
- No source changes unless verification reveals a new reproducible defect.

- [ ] Launch the new EXE and locate its dynamic localhost port.
- [ ] Confirm launcher, Node listener, and `/api/bootstrap` health three times.
- [ ] Open the real control interface in Chromium and verify dashboard, settings, and replies pages with zero console errors/warnings.
- [ ] Verify historical safe failures become reprocessable under the new ordering without clicking reply submission or complaint submission during the controlled smoke test.
- [ ] Keep the user-visible control interface open and report exact process/port evidence.
