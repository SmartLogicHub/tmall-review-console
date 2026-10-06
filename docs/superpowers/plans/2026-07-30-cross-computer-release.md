# Cross-Computer Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows archive that carries the review database but creates a fresh Chrome profile on the destination computer, with accurate login and launch-error messages.

**Architecture:** Split portable business data from machine-specific browser state in the packaging script. Keep authentication state based on the real driver result, and map browser launch failures at the API boundary.

**Tech Stack:** Node.js, TypeScript, Fastify, Vitest, PowerShell/.NET ZIP

---

### Task 1: Package only portable database state

**Files:**
- Modify: `scripts/package-windows.mjs`
- Modify: `scripts/package-windows.test.mjs`
- Modify: `package.json`

- [ ] Add a failing test for database-only local state.
- [ ] Run the packaging test and confirm it fails.
- [ ] Add a database-only CLI option and npm script.
- [ ] Run the packaging test and confirm it passes.

### Task 2: Correct authentication status and browser launch errors

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/web/src/app.test.tsx`

- [ ] Add failing API tests for credential-only state and browser launch failure.
- [ ] Run the focused tests and confirm they fail.
- [ ] Use actual authentication state and return a friendly 503 launch error.
- [ ] Run focused server and web tests.

### Task 3: Verify and package

- [ ] Run full tests and type checking.
- [ ] Build the database-only Windows release.
- [ ] Verify database integrity and absence of browser profile/WAL/SHM.
- [ ] Create and inspect the final ZIP archive.

