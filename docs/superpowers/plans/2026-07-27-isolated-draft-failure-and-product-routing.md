# Isolated Draft Failure and Product Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the live-page queue running after an unexpected per-review draft failure and prevent product-incompatible category selection.

**Architecture:** Add an explicit per-record failure outcome between `DraftProcessor` and the automation controller, preserving existing global stops for permanent configuration and browser verification. Apply the existing product-family compatibility check to model-selected categories before deterministic category refinement, then verify the two supplied follow-up reviews against the real catalogue shape.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, Fastify, npm workspaces

---

### Task 1: Reproduce the queue-stopping draft failure

**Files:**
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/drafts/processor.test.ts`

- [ ] Add a processor test whose otherwise valid classification has an invalid checkpoint field and assert the saved draft is failed without requesting global manual action.
- [ ] Add an automation integration test with two page snapshots: the first triggers the same draft failure and the second remains valid.
- [ ] Assert the run processes both snapshots, submits the second, records one failure, and ends at `queue_empty`.
- [ ] Run the targeted tests and confirm they fail because the current processor returns `manual_action_required`.

### Task 2: Implement per-record failure continuation and safe stage evidence

**Files:**
- Modify: `apps/server/src/drafts/processor.ts`
- Modify: `apps/server/src/app.ts`

- [ ] Add a `failed_continue` draft outcome.
- [ ] Track the current safe processing stage and store it in the generic failure message.
- [ ] Return `failed_continue` for `DRAFT_PROCESSING_FAILED`.
- [ ] Map `failed_continue` to a failed counter and continuation message without changing global automation state.
- [ ] Run the targeted tests and confirm they pass.

### Task 3: Reproduce product-incompatible routing

**Files:**
- Modify: `apps/server/src/drafts/template-selection.test.ts`

- [ ] Add the H180Plus follow-up with a model-selected amplifier delay category and compatible bad-review alternatives.
- [ ] Assert the amplifier-specific choice is rejected for the headphone product.
- [ ] Add the atomdot wind-noise follow-up and assert fallback refinement selects `环境音`.
- [ ] Add a control case proving an amplifier product can retain the amplifier delay category.
- [ ] Run the tests and confirm the headphone control fails under current direct-category behavior.

### Task 4: Enforce product compatibility for direct model categories

**Files:**
- Modify: `apps/server/src/drafts/template-selection.ts`
- Modify: `apps/server/src/drafts/processor.ts`

- [ ] Export a focused category compatibility/refinement operation.
- [ ] Treat an explicitly incompatible model category as the corresponding library fallback before existing refinement.
- [ ] Preserve model-selected compatible categories without changing their result.
- [ ] Run template-selection and processor tests.

### Task 5: Verify the complete repair

**Files:**
- Test: `apps/server/src/app.test.ts`
- Test: `apps/server/src/drafts/processor.test.ts`
- Test: `apps/server/src/drafts/template-selection.test.ts`
- Test: `apps/server/src/storage/database.test.ts`

- [ ] Run the targeted regression tests.
- [ ] Run the full server test suite.
- [ ] Run root type checking.
- [ ] Run the complete root test suite.
- [ ] Run the production build.
- [ ] If the local browser profile and credentials are usable, open the project and perform a non-destructive UI inspection; do not submit a live reply unless the current page and generated reply are both explicitly verified.
