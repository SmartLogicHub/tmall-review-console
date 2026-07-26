# Public GitHub Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user explicitly requested inline execution without subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the complete source project for a safe public GitHub repository with a polished Chinese README, three anonymized console screenshots, an MIT license, and CI.

**Architecture:** Keep source, tests, and design documents public while excluding all runtime state and local release artifacts through explicit Git ignore rules. Generate screenshots from the existing isolated E2E server with in-memory secrets and fabricated records, then verify repository safety with automated ignore checks and a tracked-file audit before any external push.

**Tech Stack:** Git, Node.js, TypeScript, React, Fastify, SQLite, Playwright CLI, GitHub Actions, Markdown

---

### Task 1: Protect Local Runtime and Release Data

**Files:**
- Create: `scripts/public-repo-safety.test.mjs`
- Modify: `.gitignore`

- [ ] **Step 1: Write a failing ignore-rule test**

Create a Node test that runs `git check-ignore --no-index` for representative private paths:

```js
const privatePaths = [
  "data/tmall-review-console.sqlite",
  ".diagnostics/example/remote.sqlite",
  ".state-backups/example/browser-profile/Default/Cookies",
  "migration-backups/example.sqlite",
  ".pnpm-store/v11/index.db",
  "release-final-20260726-v7.zip",
  "release-final-20260726-v7/data/browser-profile/Default/Cookies",
  "corrected-data-20260724/replies.sqlite",
  "launcher.log",
];
```

Also assert that representative public paths such as `apps/server/src/app.ts`, `README.md`, and `docs/images/console-overview.png` are not ignored.

- [ ] **Step 2: Run the test and confirm failure**

Run:

```powershell
node --test scripts/public-repo-safety.test.mjs
```

Expected: FAIL because backup, diagnostics, local release, ZIP, SQLite, and log patterns are not all ignored yet.

- [ ] **Step 3: Extend `.gitignore`**

Add explicit patterns for:

```gitignore
.diagnostics/
.pnpm-store/
.state-backups/
migration-backups/
corrected-data-*/
release-final-*/
release-final-*.zip
*.sqlite
*.sqlite-shm
*.sqlite-wal
*.log
*.zip
*.pptx
```

Keep `docs/images/*.png` publishable. Continue excluding runtime data, Excel files, build output, and credentials.

- [ ] **Step 4: Run the ignore-rule test**

Run:

```powershell
node --test scripts/public-repo-safety.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Verify untracked private groups disappeared from Git status**

Run:

```powershell
git status --short --untracked-files=all
```

Expected: no entries under `data`, `.diagnostics`, `.state-backups`, `migration-backups`, `.pnpm-store`, `corrected-data-*`, or `release-final-*`.

### Task 2: Add Public Repository Metadata

**Files:**
- Create: `LICENSE`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`

- [ ] **Step 1: Add the MIT license**

Create the standard MIT License text with copyright:

```text
Copyright (c) 2026 Tmall Review Console contributors
```

- [ ] **Step 2: Add a CI workflow**

Create a Windows GitHub Actions workflow triggered by pushes and pull requests. It must:

1. Check out source.
2. Set up Node.js 22 with npm cache.
3. Run `npm ci`.
4. Run packaging and data-correction script tests.
5. Run domain tests.
6. Run server tests excluding the Windows non-interactive credential-store test.
7. Run web tests.
8. Run type checking.
9. Run the production build.

- [ ] **Step 3: Include the repository safety test in the root test command**

Add `scripts/public-repo-safety.test.mjs` to the root Node test list in `package.json`.

- [ ] **Step 4: Validate YAML structure and local commands**

Read the workflow back and run:

```powershell
node --test scripts/public-repo-safety.test.mjs scripts/package-windows.test.mjs scripts/correct-imported-reply-history.test.mjs
npm.cmd run typecheck
npm.cmd run build
```

Expected: all commands exit 0.

### Task 3: Capture Three Anonymized Console Screenshots

**Files:**
- Create: `docs/images/console-overview.png`
- Create: `docs/images/run-center.png`
- Create: `docs/images/reply-results.png`

- [ ] **Step 1: Confirm Playwright CLI prerequisites**

Run:

```powershell
Get-Command npx.cmd
```

Expected: an installed `npx.cmd` path.

- [ ] **Step 2: Start the existing isolated E2E server**

Launch `tests/e2e/global-setup.ts` with Node and `tsx`. This server uses an in-memory database, in-memory secrets, a fake Tmall driver, and fictional review data. Do not use the production `data` directory.

- [ ] **Step 3: Capture the overview**

Use Playwright CLI with a 1440×1000 viewport to open the workbench and save:

```text
docs/images/console-overview.png
```

- [ ] **Step 4: Capture the run center**

Navigate to the automatic-processing page exposed by the current UI and save:

```text
docs/images/run-center.png
```

- [ ] **Step 5: Capture reply results**

Navigate to `/replies`, keep the fictitious record visible, and save:

```text
docs/images/reply-results.png
```

- [ ] **Step 6: Visually inspect all screenshots**

Check each image for:

- no real store, buyer, order, product, API key, password, or Feishu link;
- correct Chinese text rendering;
- no modal, loading overlay, or browser error;
- the two reply-cleanup buttons visible in the reply-results screenshot.

- [ ] **Step 7: Stop the isolated server**

Stop only the exact process started for screenshot capture and confirm ports 4310 and 5183 are no longer listening.

### Task 4: Rewrite the Public README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the internal-operation-first opening**

Lead with a concise open-source description, safety positioning, and the three primary capabilities:

- page-observed processing;
- semantic classification and template selection;
- auditable reply/complaint outcomes.

- [ ] **Step 2: Add the screenshot gallery**

Reference:

```markdown
![控制台首页](docs/images/console-overview.png)
![自动处理中心](docs/images/run-center.png)
![回复结果](docs/images/reply-results.png)
```

- [ ] **Step 3: Document architecture and workflow**

Explain React, Fastify, SQLite, Playwright, DeepSeek, and Feishu without exposing private endpoints or production credentials.

- [ ] **Step 4: Correct current behavior**

Ensure the README states:

- page-visible reviews are the processing source of truth;
- imported SQLite records are for history display and deduplication evidence, not a priority queue;
- a failed item does not stop later items;
- missing complaint entry means platform-handled/skip, while a self-complaint succeeds only after an actual submit confirmation;
- comments containing celebrity references are skipped from replies;
- unmatched classifications use a general fallback.

- [ ] **Step 5: Add development, testing, packaging, privacy, and license sections**

Document source setup, clean Windows packaging, local-state exclusion, test commands, and MIT license.

- [ ] **Step 6: Verify README links**

Confirm all three image paths and referenced project paths exist.

### Task 5: Audit and Validate the Public Repository

**Files:**
- Modify only if audit finds a release-blocking issue.

- [ ] **Step 1: Scan tracked and candidate files for private artifacts**

List file paths matching:

- `.sqlite`, `.sqlite-wal`, `.sqlite-shm`;
- `browser-profile`, `Cookies`, `Login Data`;
- `.zip`, `.log`, `.env`;
- backup and diagnostics directories.

Do not print secret values.

- [ ] **Step 2: Scan source for credential-shaped content**

Search tracked text for likely real keys, tokens, passwords, App Secrets, and Feishu Base URLs. Report file paths and classify test placeholders separately; never echo possible secret values.

- [ ] **Step 3: Run the complete verification suite**

Run:

```powershell
node --test scripts/public-repo-safety.test.mjs scripts/package-windows.test.mjs scripts/correct-imported-reply-history.test.mjs
npm.cmd run test -w packages/domain
npm.cmd exec -w apps/server -- vitest run src --exclude src/security/credential-store.test.ts
npm.cmd run test -w apps/web
npm.cmd run typecheck
npm.cmd run build
```

Expected:

- script tests pass;
- 71 domain tests pass;
- server suite passes with only the known credential-store exclusion;
- 123 web tests pass;
- type checking and build exit 0.

- [ ] **Step 4: Review the candidate Git diff**

Run:

```powershell
git diff --check
git status --short
```

Confirm no private or generated runtime paths are candidates for commit.

- [ ] **Step 5: Commit only reviewed public files**

Stage explicit source, documentation, workflow, license, and screenshot paths. Do not use an unreviewed `git add .`. Review `git diff --cached --name-status` before committing.

- [ ] **Step 6: Stop before external publication**

Report the clean candidate state and request the public GitHub repository name. Do not create a remote repository or push until the user confirms the final name and public scope.
