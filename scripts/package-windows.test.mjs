import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  requiredDistributionPaths,
  resolvePackageDataRootPath,
  resolveReleaseRootPath,
  shouldCopyLocalBrowserPath,
  shouldCopyPath,
} from "./package-windows.mjs";

test("package output override stays inside the workspace", () => {
  assert.match(resolveReleaseRootPath(), /release[\\/]天猫评论助手$/u);
  assert.match(resolveReleaseRootPath("release-next/天猫评论助手"), /release-next[\\/]天猫评论助手$/u);
  assert.throws(() => resolveReleaseRootPath("../outside-workspace"), /outside workspace/u);
});

test("local-state source override stays inside the workspace", () => {
  assert.match(resolvePackageDataRootPath(), /data$/u);
  assert.match(
    resolvePackageDataRootPath("release-final-20260724-v4/data"),
    /release-final-20260724-v4[\\/]data$/u,
  );
  assert.throws(() => resolvePackageDataRootPath("../outside-workspace"), /outside workspace/u);
});

test("distribution excludes credentials, browser sessions, runtime data and repository metadata", () => {
  for (const path of [
    ".env",
    ".git/config",
    "data/browser-profile/Default/Cookies",
    "data/tmall-review-console.sqlite-wal",
    "test-results/result.json",
    "output/screenshot.png",
    "apps/server/src/example.test.ts",
  ]) assert.equal(shouldCopyPath(path), false, path);
  for (const path of [
    "apps/server/src/index.ts",
    "apps/web/dist/index.html",
    "node_modules/fastify/package.json",
    "packages/domain/src/index.ts",
  ]) assert.equal(shouldCopyPath(path), true, path);
});

test("distribution layout contains everything the launcher validates", () => {
  assert.deepEqual(requiredDistributionPaths(), [
    "runtime/node.exe",
    "node_modules/tsx/dist/cli.mjs",
    "apps/server/src/index.ts",
    "apps/web/dist/index.html",
    "天猫评论助手.exe",
  ]);
});

test("launcher owns one dynamic loopback service and exits when that service exits", async () => {
  const source = await readFile(new URL("../apps/launcher/Program.cs", import.meta.url), "utf8");
  assert.match(source, /TcpListener\(IPAddress\.Loopback,\s*0\)/);
  assert.match(source, /TMALL_CONSOLE_PORT.*port/);
  assert.match(source, /TMALL_CONSOLE_ORIGIN.*ConsoleUrl\(port\)/);
  assert.match(source, /await WaitForHealthAsync\(HealthUrl\(port\), TimeSpan\.FromSeconds\(60\), server\)\.ConfigureAwait\(false\)/);
  assert.match(source, /await server\.WaitForExitAsync\(\)\.ConfigureAwait\(false\)/);
  assert.doesNotMatch(source, /127\.0\.0\.1:4300|NotifyIcon|ContextMenuStrip|Application\.Run\(/u);
  assert.doesNotMatch(source, /if \(IsHealthyAsync\(\)\.GetAwaiter\(\)\.GetResult\(\)\)/u);
});

test("local-state package keeps the login profile but drops volatile browser caches and lock files", () => {
  for (const path of [
    "Local State",
    "Default/Network/Cookies",
    "Default/Login Data",
  ]) assert.equal(shouldCopyLocalBrowserPath(path), true, path);
  for (const path of [
    "SingletonLock",
    "SingletonCookie",
    "DevToolsActivePort",
    "Default/LOCK",
    "Default/Local Storage/leveldb/LOCK",
    "extensions_crx_cache/index.json",
    "Default/Extensions/hofgfmmdolnmimplihglefekekfcfijf/3.1.0.0/manifest.json",
    "Default/Extension State/LOG",
    "Default/Local Extension Settings/hofgfmmdolnmimplihglefekekfcfijf/LOG",
    "Default/Preferences",
    "Default/Secure Preferences",
    "Default/Cache/data_0",
    "Default/Code Cache/js/index",
    "ShaderCache/data_0",
    "Crashpad/reports/report.dmp",
  ]) assert.equal(shouldCopyLocalBrowserPath(path), false, path);
});

test("desktop entry points do not create Windows named mutex locks", async () => {
  const launcher = await readFile(new URL("../apps/launcher/Program.cs", import.meta.url), "utf8");
  const server = await readFile(new URL("../apps/server/src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(launcher, /\bMutex\b|TmallReviewConsoleLauncher/u);
  assert.doesNotMatch(server, /WindowsMutexInstanceGuard|launchSingleInstanceServer|ServerAlreadyRunningError/u);
});
