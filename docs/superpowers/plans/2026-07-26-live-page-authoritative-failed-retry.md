# Live Page Authoritative Failed Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reprocess a locally failed review whenever the live Tmall page still exposes a reply action and no submit boundary was crossed.

**Architecture:** Extend the repository’s live-page reconciliation boundary so it can atomically reopen safe pre-submit failures while preserving terminal locks, tombstones, sent attempts, and uncertain submissions. Keep queue order and same-run deduplication unchanged.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, npm workspaces

---

### Task 1: Reproduce the terminal-failed skip

**Files:**
- Modify: `apps/server/src/drafts/processor.test.ts`

- [ ] Add an integration test that creates a ready draft, records a pre-submit `failed` attempt, observes the same live actionable snapshot again, and expects a newly generated ready draft.
- [ ] Add a protection test whose failed attempt has a non-null submission boundary and expects the row to remain skipped.
- [ ] Run `npm.cmd test -w apps/server -- processor.test.ts -t "live actionable"` and verify the first test fails because the current processor skips `failed`.

### Task 2: Make live-page reconciliation reopen only safe failures

**Files:**
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/server/src/drafts/processor.ts`

- [ ] Replace the display-only-specific reconciliation name with a live-action reconciliation name.
- [ ] Allow `failed` drafts to reopen only when no lock or tombstone exists and any reply attempt is either absent or safely failed before submit.
- [ ] Permit the explicit `MANUALLY_CONFIRMED_NOT_SENT` outcome.
- [ ] Atomically remove only the obsolete pre-submit failed attempt, then reset draft-generation fields so existing strict action-conflict guards remain unchanged.
- [ ] Run the targeted processor tests and verify both pass.

### Task 3: Regression verification

**Files:**
- Test: `apps/server/src/drafts/processor.test.ts`
- Test: `apps/server/src/submission/service.test.ts`
- Test: `apps/server/src/storage/database.test.ts`

- [ ] Run `npm.cmd test -w apps/server -- processor.test.ts submission/service.test.ts storage/database.test.ts`.
- [ ] Run `npm.cmd run typecheck -w apps/server`.
- [ ] Run the full server test suite and confirm no unrelated behavior changed.
- [ ] Build and package the next Windows release with preserved local data only after all checks pass.
