# Unified Review Execution and Recovery Implementation Plan

> **For agentic workers:** Execute inline in the current session. The user explicitly prohibited subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live Tmall page observations the only executable work source, submit real replies safely, route catalog-aware replies, complain whenever an evaluation clearly matches a platform complaint type, and isolate all per-review failures from the rest of the queue.

**Architecture:** Keep page discovery, AI classification, complaint handling, reply submission and platform reconciliation as separate boundaries joined by `sourceKey`. Per-review failures return non-pausing outcomes; recoverable browser and login faults use bounded recovery; only captcha/security verification and permanent AI configuration faults pause. Store names are not read or compared. SQLite records history and click/reconciliation checkpoints but never supplies an unobserved work queue.

**Tech Stack:** TypeScript, Fastify, Patchright/Playwright, React, SQLite/better-sqlite3, Vitest, Node.js Windows packaging

---

### Task 1: Establish a focused regression baseline

**Files:**
- Test: `apps/server/src/app.test.ts`
- Test: `apps/server/src/drafts/processor.test.ts`
- Test: `apps/server/src/tmall/review-reader.test.ts`
- Test: `apps/server/src/tmall/auth-driver.test.ts`
- Test: `apps/server/src/complaints/complaint-review-service.test.ts`
- Test: `apps/server/src/complaints/production-complaint-review-policy.test.ts`
- Test: `apps/server/src/submission/service.test.ts`
- Test: `apps/server/src/deepseek/client.test.ts`

- [ ] Record the current dirty-worktree file list so existing user changes are not overwritten.
- [ ] Run the focused tests before adding new cases.
- [ ] Classify every failure as an existing regression, missing test fixture or expected missing behavior.
- [ ] Do not modify production code until a failing regression test reproduces each missing behavior.

Run:

```powershell
npm.cmd exec vitest run --workspace apps/server apps/server/src/app.test.ts apps/server/src/drafts/processor.test.ts apps/server/src/tmall/review-reader.test.ts apps/server/src/tmall/auth-driver.test.ts apps/server/src/complaints/complaint-review-service.test.ts apps/server/src/complaints/production-complaint-review-policy.test.ts apps/server/src/submission/service.test.ts apps/server/src/deepseek/client.test.ts
```

Expected: current passing baseline, or a precise list of pre-existing failures to fix first.

### Task 2: Enforce live-page-only scheduling

**Files:**
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/server/src/drafts/processor.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/storage/database.test.ts`
- Test: `apps/server/src/drafts/processor.test.ts`
- Test: `apps/server/src/app.test.ts`

- [ ] Add a failing test: database contains a due retry but the page returns no snapshots; AI and browser submission must not run.
- [ ] Add a failing test: several database retries exist but the page observes only one; only that `sourceKey` may be claimed.
- [ ] Add a failing test: an imported local `sent`/non-success state conflicts with a freshly refreshed platform row; platform evidence drives reconciliation without global database search.
- [ ] Run the focused tests and verify the new assertions fail for the intended reason.
- [ ] Restrict retry claiming to the explicitly observed `sourceKey`.
- [ ] Remove any startup-wide retry drain and out-of-scope retry blocking.
- [ ] Re-run storage, processor and app tests.

### Task 3: Make product routing catalog-aware and generic

**Files:**
- Modify: `apps/server/src/deepseek/review-classification-prompt.ts`
- Modify: `apps/server/src/deepseek/client.ts`
- Modify: `apps/server/src/drafts/processor.ts`
- Test: `apps/server/src/deepseek/client.test.ts`
- Test: `apps/server/src/drafts/processor.test.ts`

- [ ] Add a failing test using an earphone product and an amplifier-specific catalog; the earphone must not choose the amplifier category.
- [ ] Add a failing test using an amplifier alias that does not literally contain “扩音器”; semantic catalog routing must still allow the amplifier category.
- [ ] Add a second fictional future product fixture to prove there is no hard-coded product dictionary.
- [ ] Add a fallback test: no reliable product-specific category selects the sentiment-appropriate general category.
- [ ] Require classification input to include full product, review, all category levels, keywords and valid category identifiers.
- [ ] Keep exact catalog-membership validation for the returned category.
- [ ] Re-run DeepSeek and processor tests.

### Task 4: Skip celebrity-related evaluations

**Files:**
- Modify: `apps/server/src/deepseek/review-classification-prompt.ts`
- Modify: `apps/server/src/drafts/processor.ts`
- Test: `apps/server/src/deepseek/client.test.ts`
- Test: `apps/server/src/drafts/processor.test.ts`

- [ ] Add a failing test for a review that chooses a product because of an endorser/celebrity; no reply or complaint action may start.
- [ ] Add a negative-control test for ordinary names and the phrase “明星产品”; these must not be skipped.
- [ ] Add a typed, explicit celebrity-skip decision before complaint/reply execution.
- [ ] Persist/display it as a business skip, not a processing failure.
- [ ] Re-run focused tests.

### Task 5: Relax artificial complaint strictness while preserving platform fit

**Files:**
- Modify: `apps/server/src/complaints/deepseek-complaint-analysis.ts`
- Modify: `apps/server/src/complaints/production-complaint-review-policy.ts`
- Modify: `apps/server/src/complaints/complaint-domain.ts`
- Modify: `apps/server/src/complaints/complaint-review-service.ts`
- Test: `apps/server/src/complaints/deepseek-complaint-analysis.test.ts`
- Test: `apps/server/src/complaints/production-complaint-review-policy.test.ts`
- Test: `apps/server/src/complaints/complaint-domain.test.ts`
- Test: `apps/server/src/complaints/complaint-review-service.test.ts`

- [ ] Add failing fixtures where the content clearly matches a supported complaint type but does not contain exaggerated severity language; expect complaint submission eligibility.
- [ ] Add controls for genuine product quality, service and usage complaints that do not match a platform complaint type; expect ordinary reply flow.
- [ ] Remove any artificial “must be extremely severe” or unnecessary multi-signal veto.
- [ ] Keep required agreement between review facts, platform complaint type and generated complaint description.
- [ ] Keep type/description completeness and platform option validation.
- [ ] Re-run all complaint-domain and policy tests.

### Task 6: Isolate complaint failures and reconcile platform terminal states

**Files:**
- Modify: `apps/server/src/tmall/review-reader.ts`
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Modify: `apps/server/src/complaints/complaint-review-service.ts`
- Modify: `apps/server/src/drafts/processor.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/tmall/review-reader.test.ts`
- Test: `apps/server/src/tmall/auth-driver.test.ts`
- Test: `apps/server/src/complaints/complaint-review-service.test.ts`
- Test: `apps/server/src/drafts/processor.test.ts`
- Test: `apps/server/src/app.test.ts`

- [ ] Add a failing app test reproducing the screenshot: complaint pre-review returns `internal`; the current item ends without reply/complaint and the next snapshot still runs.
- [ ] Add failing tests for `投诉成立`, `投诉成功`, `投诉处理成功`, complaint record and no complaint entrance.
- [ ] Add a failing test: complaint `manual_action_required` does not set global automation state to manual.
- [ ] Map all per-review complaint errors to current-item defer/skip outcomes.
- [ ] Keep retry-next-round eligibility for transient complaint failures.
- [ ] Reconcile platform complaint terminal evidence before AI/reply execution.
- [ ] Update run-center messages to say the current item was skipped and processing continued.
- [ ] Re-run reader, driver, complaint, processor and app tests.

### Task 7: Verify real reply submission and post-click uncertainty

**Files:**
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Modify: `apps/server/src/submission/service.ts`
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/server/src/drafts/processor.ts`
- Test: `apps/server/src/tmall/auth-driver.test.ts`
- Test: `apps/server/src/submission/service.test.ts`
- Test: `apps/server/src/storage/database.test.ts`
- Test: `apps/server/src/drafts/processor.test.ts`

- [ ] Add a failing driver test requiring open-dialog, unique editor, fill, readback, durable pre-click checkpoint and real submit `click()`.
- [ ] Add a failing test proving a fixed delay alone cannot mark success.
- [ ] Add a failing test: failure before the click checkpoint is safe to retry later.
- [ ] Add a failing test: timeout/network loss after the click checkpoint becomes `submission_uncertain` and cannot be resubmitted.
- [ ] Add a failing reconciliation test: a later platform reply record converts uncertain/legacy failed state to `sent`.
- [ ] Implement condition-based platform confirmation and keep a bounded deadline.
- [ ] Re-run driver, submission, storage and processor tests.

### Task 8: Remove global element-health blocking and recover login/page state

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/tmall/auth-driver.ts`
- Modify: `apps/server/src/tmall/browser-runtime.ts`
- Test: `apps/server/src/app.test.ts`
- Test: `apps/server/src/tmall/auth-driver.test.ts`
- Test: `apps/server/src/tmall/browser-runtime.test.ts`

- [ ] Add a failing test: stale locator health state cannot block an otherwise authenticated run.
- [ ] Add a failing test: a half-loaded page succeeds after bounded re-read.
- [ ] Add a failing test: expired login automatically logs in again and resumes the current item.
- [ ] Add a failing test: authentication, reply and complaint execution do not require a readable store name.
- [ ] Remove store-name extraction, persistence and comparison from run, reply and complaint gates.
- [ ] Remove independent startup/per-item element-health gates.
- [ ] Keep local uniqueness checks at the exact action boundary.
- [ ] Return an end-current-cycle/retry-later result when the review page remains unavailable, rather than a permanent manual pause.
- [ ] Re-run app, driver and runtime tests.

### Task 9: Use one DeepSeek Pro path with bounded transient retries

**Files:**
- Modify: `apps/server/src/deepseek/client.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/web/src/pages/settings.tsx`
- Test: `apps/server/src/deepseek/client.test.ts`
- Test: `apps/server/src/app.test.ts`
- Test: `apps/web/src/app.test.tsx`

- [ ] Add failing tests proving every business request and connection test uses Pro only.
- [ ] Add a failing test: initial 429/5xx/timeout followed by success reports configured.
- [ ] Add a control: 401/403/insufficient balance remains a global configuration failure.
- [ ] Remove Flash validation and display.
- [ ] Route exhausted per-review transient failures to current-item skip/continue.
- [ ] Re-run DeepSeek, app and web tests.

### Task 10: Align persisted and displayed statuses

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/storage/repositories.ts`
- Modify: `apps/web/src/pages/replies.tsx`
- Modify: `apps/web/src/pages/run-center.tsx`
- Test: `apps/server/src/app.test.ts`
- Test: `apps/server/src/storage/database.test.ts`
- Test: `apps/web/src/pages/replies.test.tsx`
- Test: `apps/web/src/app.test.tsx`

- [ ] Add failing tests ensuring per-review failures never render “需要人工处理”.
- [ ] Add display states for current-item skipped, next-round recheck and waiting-platform-confirmation.
- [ ] Ensure platform success reconciliation updates the visible history to success.
- [ ] Keep global manual UI only for verification, confirmed wrong store or permanent AI configuration failure.
- [ ] Re-run server and web tests.

### Task 11: Correct imported data safely

**Files:**
- Verify/modify: `scripts/correct-imported-reply-history.mjs`
- Verify/modify: `scripts/correct-imported-reply-history.test.mjs`
- Output: `corrected-data-20260724/tmall-review-console.sqlite`
- Output: `corrected-data-20260724/correction-report.json`

- [ ] Run the correction-command tests.
- [ ] Verify the source database hash before correction.
- [ ] Generate a new output database; never overwrite the supplied source.
- [ ] Verify all confirmed old failures became `sent`.
- [ ] Verify all other non-success reply histories were removed without orphan records.
- [ ] Verify `PRAGMA integrity_check` returns `ok` and the output opens without WAL/SHM.

### Task 12: Full verification, two real replies and Windows packaging

**Files:**
- Verify: all modified source and test files
- Verify/modify only if a packaging test fails: `scripts/package-windows.mjs`
- Test: `scripts/package-windows.test.mjs`
- Output: a new timestamped release directory and ZIP

- [ ] Run `npm.cmd test`.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd run build`.
- [ ] Run `git diff --check` and inspect the final change inventory.
- [ ] Back up the active data directory before launching the packaged build.
- [ ] Start the packaged application and confirm page-driven discovery, Pro-only settings and corrected data.
- [ ] Submit two eligible ordinary reviews on the live Tmall page; verify platform reply records and local `sent` rows agree.
- [ ] Stop immediately if captcha/security verification or an irreversible unexpected platform state appears.
- [ ] Package with corrected `data`, templates, settings and required browser state; exclude logs, caches, temporary diagnostics and old release folders.
- [ ] Verify ZIP CRC, required files and packaged database hash.
