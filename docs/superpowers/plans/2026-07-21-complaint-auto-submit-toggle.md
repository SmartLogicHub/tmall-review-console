# Complaint Auto-Submit Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-off setting that makes platform complaint submission opt-in while retaining every existing validation and uncertainty safeguard.

**Architecture:** `buildApp` exposes a persisted boolean to the complaint-policy factory. The production factory supplies `ComplaintExecutor` only for a fresh run created with the toggle enabled; with it disabled, the existing `ComplaintReviewService` moves validated candidates to manual review. The Settings API and Settings page expose the same boolean.

**Tech Stack:** TypeScript, Fastify, SQLite settings repository, React, TanStack Query, Vitest, Testing Library.

---

### Task 1: Persist and expose the opt-in setting

**Files:**

- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`

- [ ] **Step 1: Write failing API tests**

  Verify a new database returns `complaintAutoSubmit: false`; a protected `PUT /api/settings` persists a boolean; non-boolean values are rejected; and changing it while automation is active returns a conflict.

- [ ] **Step 2: Run the targeted test**

  Run: `npx.cmd vitest run src/app.test.ts -t "complaint auto-submit"`

  Expected: FAIL because the settings field and validation do not exist.

- [ ] **Step 3: Add the minimal settings API implementation**

  Read `complaint_auto_submit` with `=== true`, return it from GET and PUT responses, allow only a boolean write, and reject a write while the existing automation promise is active.

- [ ] **Step 4: Re-run the targeted test**

  Run: `npx.cmd vitest run src/app.test.ts -t "complaint auto-submit"`

  Expected: PASS.

### Task 2: Gate the production complaint executor

**Files:**

- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/app.test.ts`

- [ ] **Step 1: Write a failing integration test**

  Give the complaint-policy factory a captured `complaintAutoSubmit` input. Trigger a fresh policy creation with the setting disabled and enabled, and assert the factory receives `false` then `true` only at run creation time.

- [ ] **Step 2: Run the targeted test**

  Run: `npx.cmd vitest run src/app.test.ts -t "passes complaint auto-submit"`

  Expected: FAIL because the factory has no setting input.

- [ ] **Step 3: Implement the factory boundary**

  Add `complaintAutoSubmit` to the factory input, obtain it from the local settings repository in `complaintReviewPolicyFor`, and change the production factory so that it supplies `ComplaintExecutor` only when true.

- [ ] **Step 4: Re-run server tests and type check**

  Run: `npx.cmd vitest run src/app.test.ts src/complaints/complaint-review-service.test.ts`

  Run: `npm.cmd run typecheck`

  Expected: PASS.

### Task 3: Add the Settings-page control

**Files:**

- Modify: `apps/web/src/pages/settings.tsx`
- Modify: `apps/web/src/app.test.tsx`

- [ ] **Step 1: Write a failing UI test**

  Return `complaintAutoSubmit: false` from the settings fixture. Verify the page shows an unchecked labelled control and its default-off warning; toggling it sends `PUT /api/settings` with `{ complaintAutoSubmit: true }`.

- [ ] **Step 2: Run the targeted UI test**

  Run: `npx.cmd vitest run src/app.test.tsx -t "complaint auto-submit"`

  Expected: FAIL because no control or mutation exists.

- [ ] **Step 3: Implement the minimal control**

  Extend the settings type, add a mutation that saves only the boolean, invalidate the settings query on completion, and display a default-off/risk explanation without exposing technical internals.

- [ ] **Step 4: Re-run the targeted UI test and type check**

  Run: `npx.cmd vitest run src/app.test.tsx -t "complaint auto-submit"`

  Run: `npm.cmd run typecheck`

  Expected: PASS.

### Task 4: Recognize a platform-already-handled complaint after an unchanged submit

**Files:**

- Modify: `apps/server/src/complaints/complaint-browser-flow.ts`
- Modify: `apps/server/src/complaints/complaint-browser-flow.test.ts`
- Modify: `apps/server/src/complaints/tmall-complaint-dom-adapter.ts`
- Modify: `apps/server/src/complaints/tmall-complaint-dom-adapter.test.ts`
- Modify: `apps/server/src/complaints/complaint-review-service.ts`
- Modify: `apps/server/src/complaints/complaint-review-service.test.ts`
- Modify: `apps/server/src/storage/complaint-repository.ts`

- [ ] **Step 1: Write failing browser-flow tests**

  Simulate a completed submit click whose evidence reports that the same complaint dialog and its input remain visible. Verify the flow closes that dialog and returns `already_handled`. Keep an ordinary missing button, a changed page and a missing result identifier out of this branch.

- [ ] **Step 2: Run the flow test**

  Run: `npx.cmd vitest run src/complaints/complaint-browser-flow.test.ts`

  Expected: FAIL because the flow currently treats the page as a generic failure or post-click uncertainty.

- [ ] **Step 3: Implement the unchanged-page boundary**

  Read post-click evidence without waiting for a missing detail link. Only when success evidence is absent and the original visible dialog still contains its complaint input, close the uniquely identified close control, verify it closed, and return `already_handled`.

- [ ] **Step 4: Write and pass the service/repository transition test**

  Give `ComplaintReviewService` an executor that returns `already_handled` before calling `beforeSubmit`. Verify the case changes from `prepared` to `not_actionable`, deletes the pre-click attempt, writes a safe reason/event, releases the complaint lock into its terminal tombstone, and returns `skip` without a manual-confirmation state.

- [ ] **Step 5: Wire the production executor mapping**

  Map the browser driver's `already_handled` result to the service result. Do not map any generic failed, unavailable or uncertain result to this terminal path.

### Task 5: Regression verification

**Files:**

- Verify: `apps/server/src/app.test.ts`
- Verify: `apps/server/src/complaints/complaint-review-service.test.ts`
- Verify: `apps/web/src/app.test.tsx`

- [ ] **Step 1: Run focused server and web suites**

  Run: `npx.cmd vitest run src/app.test.ts src/complaints/complaint-review-service.test.ts`

  Run: `npx.cmd vitest run src/app.test.tsx`

- [ ] **Step 2: Run full type checks and diff check**

  Run: `npm.cmd run typecheck`

  Run: `git diff --check`

- [ ] **Step 3: Run the full workspace verification before packaging**

  Run: `npm.cmd test`

  Run: `npm.cmd run build`

  Run: `npm.cmd run package:windows`
