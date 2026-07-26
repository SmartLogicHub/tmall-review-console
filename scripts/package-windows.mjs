import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveReleaseRootPath(outputPath) {
  const selected = outputPath?.trim()
    ? resolve(root, outputPath.trim())
    : resolve(root, "release", "天猫评论助手");
  assertInsideWorkspace(selected);
  return selected;
}

export function resolvePackageDataRootPath(dataPath) {
  const selected = dataPath?.trim()
    ? resolve(root, dataPath.trim())
    : resolve(root, "data");
  assertInsideWorkspace(selected);
  return selected;
}

const releaseRoot = resolveReleaseRootPath(process.env.TMALL_CONSOLE_PACKAGE_RELEASE_ROOT);
const packageDataRoot = resolvePackageDataRootPath(process.env.TMALL_CONSOLE_PACKAGE_DATA_ROOT);

function portable(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function shouldCopyPath(path) {
  const value = portable(path);
  if (value === ".env" || value.startsWith(".env.")) return false;
  if (value === ".git" || value.startsWith(".git/")) return false;
  if (value === "output" || value.startsWith("output/")) return false;
  if (value === "test-results" || value.startsWith("test-results/")) return false;
  if (value === "data/browser-profile" || value.startsWith("data/browser-profile/")) return false;
  if (/^data\/tmall-review-console\.sqlite-(?:wal|shm)$/u.test(value)) return false;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(value) && !value.startsWith("node_modules/")) return false;
  return true;
}

export function shouldCopyLocalBrowserPath(path) {
  const value = portable(path);
  const lower = value.toLowerCase();
  if (!value) return true;
  if (/^(?:singleton[^/]*|devtoolsactiveport)$/iu.test(value)) return false;
  if (/(?:^|\/)lock$/u.test(lower)) return false;
  if (/(?:^|\/)(?:extensions|extension rules|extension scripts|extension state|local extension settings|sync extension settings|managed extension settings|extensions_crx_cache|component_crx_cache)(?:\/|$)/iu.test(value)) return false;
  if (/(?:^|\/)(?:preferences|secure preferences)$/iu.test(value)) return false;
  if (/(?:^|\/)(?:cache|code cache|gpucache|shadercache|grshadercache|dawncache|crashpad)(?:\/|$)/iu.test(value)) return false;
  if (lower === "browsermetrics" || lower.startsWith("browsermetrics/")) return false;
  return true;
}

export function requiredDistributionPaths() {
  return [
    "runtime/node.exe",
    "node_modules/tsx/dist/cli.mjs",
    "apps/server/src/index.ts",
    "apps/web/dist/index.html",
    "天猫评论助手.exe",
  ];
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

function assertInsideWorkspace(path) {
  const normalizedRoot = `${root}${sep}`.toLowerCase();
  if (!path.toLowerCase().startsWith(normalizedRoot)) throw new Error(`Refusing to modify path outside workspace: ${path}`);
}

async function copyTree(sourceRelative, destinationRelative = sourceRelative) {
  const source = resolve(root, sourceRelative);
  const destination = resolve(releaseRoot, destinationRelative);
  await cp(source, destination, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (sourcePath) => shouldCopyPath(portable(relative(root, sourcePath))),
  });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}`);
}

async function backupLocalDatabase() {
  const source = resolve(packageDataRoot, "tmall-review-console.sqlite");
  if (!(await exists(source))) return;
  const destination = resolve(releaseRoot, "data", "tmall-review-console.sqlite");
  const imported = await import("better-sqlite3");
  const Database = imported.default;
  const database = new Database(source, { readonly: true });
  try {
    await database.backup(destination);
  } finally {
    database.close();
  }
}

async function backupLocalBrowserProfile() {
  const source = resolve(packageDataRoot, "browser-profile");
  if (!(await exists(source))) return false;
  const destination = resolve(releaseRoot, "data", "browser-profile");
  await cp(source, destination, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (sourcePath) => shouldCopyLocalBrowserPath(portable(relative(source, sourcePath))),
  });
  return true;
}

export async function packageWindows({ includeLocalState = false } = {}) {
  assertInsideWorkspace(releaseRoot);
  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(releaseRoot, { recursive: true });

  const publish = resolve(root, ".runtime", "launcher-publish");
  assertInsideWorkspace(publish);
  await rm(publish, { recursive: true, force: true });
  await mkdir(publish, { recursive: true });
  run("dotnet", [
    "publish", "apps/launcher/TmallReviewLauncher.csproj",
    "-c", "Release", "-r", "win-x64", "--self-contained", "true",
    "-p:PublishSingleFile=true", "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-o", publish,
  ]);

  await mkdir(resolve(releaseRoot, "runtime"), { recursive: true });
  await cp(process.execPath, resolve(releaseRoot, "runtime", "node.exe"), { force: true });
  await cp(resolve(publish, "TmallReviewLauncher.exe"), resolve(releaseRoot, "天猫评论助手.exe"), { force: true });
  await copyTree("node_modules");
  await copyTree("apps/server/src");
  await copyTree("apps/server/resources");
  await copyTree("apps/web/dist");
  await copyTree("packages/domain");
  await cp(resolve(root, "package.json"), resolve(releaseRoot, "package.json"));
  await mkdir(resolve(releaseRoot, "data"), { recursive: true });
  const includesBrowserProfile = includeLocalState ? await backupLocalBrowserProfile() : false;
  if (includeLocalState) await backupLocalDatabase();

  const missing = [];
  for (const path of requiredDistributionPaths()) {
    if (!(await exists(resolve(releaseRoot, path)))) missing.push(path);
  }
  if (missing.length) throw new Error(`Distribution is incomplete: ${missing.join(", ")}`);

  const manifest = {
    product: "评论助手",
    version: "0.1.0",
    builtAt: new Date().toISOString(),
    portable: true,
    includesLocalState: includeLocalState,
    includesBrowserProfile,
  };
  await writeFile(resolve(releaseRoot, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return releaseRoot;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const includeLocalState = process.argv.includes("--include-local-state");
  packageWindows({ includeLocalState }).then((path) => {
    process.stdout.write(`Windows release created at ${path}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
