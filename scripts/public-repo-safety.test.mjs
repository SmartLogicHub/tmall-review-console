import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

const publicPaths = [
  "apps/server/src/app.ts",
  "README.md",
  "docs/images/console-overview.png",
];

function isIgnored(path) {
  const excludesFile = process.platform === "win32" ? "NUL" : "/dev/null";
  const result = spawnSync(
    "git",
    ["-c", `core.excludesFile=${excludesFile}`, "check-ignore", "--no-index", "--quiet", "--", path],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed for ${path}: ${result.stderr || result.stdout}`);
  }
  return result.status === 0;
}

test("private runtime state and release artifacts stay outside the public repository", () => {
  for (const path of privatePaths) assert.equal(isIgnored(path), true, path);
});

test("source, documentation and anonymized screenshots remain publishable", () => {
  for (const path of publicPaths) assert.equal(isIgnored(path), false, path);
});

test("Feishu URL fixtures use unmistakably synthetic identifiers", async () => {
  const fixture = await readFile(
    new URL("../apps/server/src/feishu/url.test.ts", import.meta.url),
    "utf8",
  );
  const identifiers = [
    ...fixture.matchAll(/(?:appToken|tableId|viewId):\s*"([^"]+)"/gu),
  ].map((match) => match[1]);

  assert.equal(identifiers.length, 3);
  for (const identifier of identifiers) {
    assert.equal(
      /(?:Example|Fake|Demo)/u.test(identifier),
      true,
      "Feishu fixture identifiers must be visibly synthetic",
    );
    assert.equal(
      identifier.length <= 16,
      true,
      "Feishu fixture identifiers must stay below generic high-entropy scanner thresholds",
    );
  }
});

test("public repository verification runs locally and in GitHub Actions", async () => {
  const root = new URL("..", import.meta.url);
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.match(packageJson.scripts.test, /scripts\/public-repo-safety\.test\.mjs/u);

  const workflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  assert.match(workflow, /runs-on:\s*windows-latest/u);
  assert.match(workflow, /node --test scripts\/public-repo-safety\.test\.mjs/u);
  assert.match(workflow, /vitest run src --exclude src\/security\/credential-store\.test\.ts/u);
  assert.match(workflow, /npm run typecheck/u);
  assert.match(workflow, /npm run build/u);
});
