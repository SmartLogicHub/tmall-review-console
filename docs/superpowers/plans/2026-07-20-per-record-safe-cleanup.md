# Per-Record Safe Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user explicitly requested inline execution without subagents.

**Goal:** Give every reply and complaint record an individual delete action while preserving idempotency for platform actions and reopening only records that never reached the platform.

**Architecture:** Centralize state-aware cleanup in one service. Unsubmitted records are physically removed with linked local state and no tombstone so they can run again; completed platform actions are also physically removed, but retain only the existing minimal action tombstone. Submission-uncertain records remain protected until resolved. UI list rows and details call the same entity-specific DELETE endpoints.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React, TanStack Query, Vitest/Testing Library

---

### Task 1: Implement state-aware cleanup service

**Files:**
- Create: `apps/server/src/storage/operator-record-cleanup.ts`
- Create: `apps/server/src/storage/operator-record-cleanup.test.ts`

- [ ] Write failing tests for four behaviors: unsubmitted reply full deletion without tombstone; sent reply full deletion with only tombstone retained; unsubmitted complaint linked-state deletion without tombstone; submitted complaint full deletion with only tombstone retained.
- [ ] Add tests proving automation-running deletion is rejected by the API layer later, and one record never affects another source key.
- [ ] Run the focused service tests and verify RED failures are caused by the missing service.
- [ ] Implement `removeReply(id)` and `removeComplaint(id)` returning `{ mode: "reprocess" | "hidden", sourceKey }`.
- [ ] Treat completed platform states or a terminal tombstone as `completed`; only never-submitted local states use `reprocess`; reject submission-uncertain and actively submitting states.
- [ ] For `reprocess`, delete complaint events, complaint invocations/attempts/cases, reply attempts/draft, action locks and prior hidden markers in one immediate transaction.
- [ ] For `completed`, preserve or insert the minimal tombstone, then delete detailed attempts, events, cases and drafts.
- [ ] Re-run the focused service tests and verify GREEN.

### Task 2: Expose safe DELETE APIs

**Files:**
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/app.test.ts`

- [ ] Write failing API tests for `DELETE /api/replies/:id` returning the cleanup mode, `DELETE /api/complaints/:id`, removed records disappearing from list/detail, uncertain deletion rejection, and deletion returning 409 while automation runs.
- [ ] Verify the tests fail before route/filter changes.
- [ ] Construct the cleanup service in `createApp`, replace the existing reply-delete transaction, and add the complaint-delete route.
- [ ] Audit both cleanup modes with entity, source key and result.
- [ ] Re-run focused API tests and verify GREEN.

### Task 3: Add a delete action to every reply row

**Files:**
- Modify: `apps/web/src/pages/replies.tsx`
- Modify: `apps/web/src/pages/replies.test.tsx`
- Modify if necessary: `apps/web/src/styles.css`

- [ ] Write failing UI tests showing each row and the detail pane have a delete button; verify confirmation text differs between reprocessable and platform-protected states.
- [ ] Verify RED.
- [ ] Replace the state-limited detail action with a universal delete mutation and add a row-level icon button that stops row-selection propagation.
- [ ] On success, remove selection, show whether the record will be reprocessed or only hidden, and invalidate replies/dashboard/storage/complaints queries.
- [ ] Re-run focused reply-page tests and verify GREEN.

### Task 4: Add a delete action to every complaint row

**Files:**
- Modify: `apps/web/src/pages/complaints.tsx`
- Create or modify: `apps/web/src/pages/complaints.test.tsx`
- Modify if necessary: `apps/web/src/styles.css`

- [ ] Write failing UI tests for row-level and detail-level complaint delete actions, confirmations, refresh, selection clearing and server error display.
- [ ] Verify RED.
- [ ] Add the complaint delete mutation and buttons using `DELETE /api/complaints/:id`.
- [ ] Invalidate complaints, summary, replies, dashboard and storage after deletion.
- [ ] Re-run focused complaint-page tests and verify GREEN.

### Task 5: Regression verification

**Files:**
- Verify all changed files above

- [ ] Run `npm.cmd test` and require zero failures.
- [ ] Run `npm.cmd run typecheck` and require exit code 0.
- [ ] Run `npm.cmd run build` and require exit code 0.
- [ ] Review the final diff to confirm no platform attempts or tombstones are deleted in hidden mode.
- [ ] Do not package until the user has tested the unpackaged build and explicitly asks for a new package.

## Workspace note

The worktree already contains the user's ongoing changes. Commit steps are intentionally omitted so unrelated user work is not staged or committed. All edits remain directly reviewable in the shared workspace.
