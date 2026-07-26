# Page-Observed Processing and Catalog Routing Implementation Plan

> **For agentic workers:** Execute inline in the current session. The user explicitly prohibited subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live Tmall page the only source of executable reviews, resume AI retries only when the same review is observed again, route products through user-maintained category/keyword semantics, and produce a corrected imported database containing only successful reply records.

**Architecture:** Remove the startup-wide database retry drain and add an atomic, source-specific retry claim used only after a live page snapshot exists. Keep classification catalog-driven by strengthening the DeepSeek contract around product-family relevance without hard-coded product names. Correct the supplied database through a separately tested, transactional command that writes a new standalone SQLite file and never overwrites the original.

**Tech Stack:** TypeScript, Fastify, SQLite/better-sqlite3, Patchright/Playwright, Vitest, Node.js test runner

---

### Task 1: Add an atomic claim for a page-observed AI retry

**Files:**
- Modify: `apps/server/src/storage/repositories.ts`
- Test: `apps/server/src/storage/database.test.ts`

- [ ] Add a failing repository test proving that an observed retry claim takes an explicit draft/source key and never returns a different imported retry.
- [ ] Run the focused test and verify it fails because the source-specific claim does not exist.
- [ ] Add `claimObservedAiRetry` using the existing retry eligibility, lease, action-conflict, scope and due-time checks, but restricted to the explicitly observed draft/source key.
- [ ] Add tests for due automated retry, manual early retry, action-lock conflict and a nonmatching source key.
- [ ] Run the focused repository tests to green.

### Task 2: Resume retries only from live snapshots

**Files:**
- Modify: `apps/server/src/drafts/processor.ts`
- Modify: `apps/server/src/drafts/processor.test.ts`

- [ ] Add a failing processor test with two imported `retry_wait` records where the snapshot contains only one source key; assert only the observed record is resumed.
- [ ] Add a failing test proving a database-only retry is unchanged when `processSnapshots` receives no snapshot.
- [ ] Run the tests and verify the expected failures.
- [ ] Change the `retry_wait` branch in `processSnapshots` to claim and resume only the current snapshot’s record through `processClaimedRetry`.
- [ ] Preserve current retry checkpoints, pause handling and action-conflict behavior.
- [ ] Run processor tests to green.

### Task 3: Remove the database-first retry drain

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`

- [ ] Add or update an app-level failing test: imported retries exist, the Tmall page is empty, and neither AI nor submission is invoked.
- [ ] Add an app-level test: the page returns one matching retry and that record resumes and reaches submission with a scan-time target.
- [ ] Run focused app tests and confirm the old startup drain violates the first assertion.
- [ ] Remove `processDueAiRetries()` and its pre-scan invocation.
- [ ] Route retry status and next-run messaging through the page-observed processor outcome.
- [ ] Remove the old “retry outside current scope blocks the run” behavior because unseen database records are no longer executable.
- [ ] Run focused app tests to green.

### Task 4: Strengthen generic product-aware category routing

**Files:**
- Modify: `apps/server/src/deepseek/review-classification-prompt.ts`
- Modify: `apps/server/src/deepseek/client.test.ts`
- Modify: `apps/server/src/drafts/processor.test.ts`

- [ ] Add a failing prompt-contract test requiring product-family selection before aspect/category selection and forbidding categories that clearly belong to another product.
- [ ] Add fixtures for an amplifier catalog and an unrelated future product catalog; verify the payload includes the live product, `primaryCategory`, `category` and `keywords` without a code-side product dictionary.
- [ ] Run the focused tests and verify the new contract assertion fails.
- [ ] Update the classification prompt and bump its version.
- [ ] Keep the existing exact catalog membership validation so the model cannot invent a category.
- [ ] Add a processor regression test proving an arbitrary product-specific category returned by the classifier selects that category’s template.
- [ ] Run DeepSeek and processor focused tests to green.

### Task 5: Build a safe imported-history correction command

**Files:**
- Create: `scripts/correct-imported-reply-history.mjs`
- Create: `scripts/correct-imported-reply-history.test.mjs`
- Modify: `package.json`

- [ ] Write failing Node tests using a temporary migrated SQLite fixture containing `sent`, `failed`, `retry_wait`, `discovered` and `not_actionable` drafts plus attempts, locks and tombstones.
- [ ] Assert the command creates a new output file, refuses to overwrite source/output, and leaves the source unchanged.
- [ ] Assert every `failed` draft/attempt becomes `sent`, errors are cleared, verification evidence/timestamps and `reply_sent` tombstones are present.
- [ ] Assert all remaining non-`sent` reply drafts and their reply attempts/locks/tombstones are removed, while unrelated template/settings data remains.
- [ ] Run the test and verify it fails because the command does not exist.
- [ ] Implement SQLite backup, `integrity_check`, one immediate correction transaction, post-check counts and output verification.
- [ ] Add an npm script for the command and run its tests to green.

### Task 6: Correct the supplied old database

**Inputs:**
- Read-only reconstructed source: `.codex-tmp/other-pc-reply-diagnostic/tmall-review-console.sqlite`

**Output:**
- Create: `corrected-data-20260724/tmall-review-console.sqlite`
- Create: `corrected-data-20260724/correction-report.json`

- [ ] Record pre-correction state and attempt counts.
- [ ] Run the tested correction command against the reconstructed source and a new output path.
- [ ] Verify the source file hash is unchanged.
- [ ] Verify the output opens without WAL/SHM and `PRAGMA integrity_check` returns `ok`.
- [ ] Verify `reply_drafts` contains only `sent`, no reply action locks remain for deleted records, and counts match the report.

### Task 7: Full verification

**Files:**
- Verify all modified server and script files.

- [ ] Run the correction command tests.
- [ ] Run focused storage, processor, app and DeepSeek tests.
- [ ] Run `npm run test -w apps/server`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Review `git diff --check` and confirm no unrelated user changes were modified.
- [ ] Report the corrected database path, exact before/after counts, and any real-browser verification still required.
