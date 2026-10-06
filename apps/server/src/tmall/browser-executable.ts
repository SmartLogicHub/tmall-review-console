import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { launchTmallBrowserContext } from "./browser-runtime";

type Environment = Record<string, string | undefined>;
type PathExists = (path: string) => boolean;
type ChromeValidationContext = { close(): Promise<void> };
type ChromeValidationLauncher = (input: {
  profileDirectory: string;
  headless: boolean;
  executablePath: string;
}) => Promise<ChromeValidationContext>;

export const TMALL_BROWSER_EXECUTABLE_PATH_SETTING_KEY = "tmall_browser_executable_path";
const SUPPORTED_CHROME_EXECUTABLE_NAMES = new Set(["chrome.exe", "chromex.exe"]);

export type ChromeExecutableResolution = {
  source: "custom" | "standard" | "missing";
  executablePath: string | null;
  customPath: string | null;
  customPathValid: boolean;
};

export class InvalidChromeExecutablePathError extends Error {
  constructor(message = "请选择有效的 Chrome 启动程序（chrome.exe 或 chromex.exe）") {
    super(message);
    this.name = "InvalidChromeExecutablePathError";
  }
}

export function standardChromeCandidates(environment: Environment = process.env): string[] {
  const localRoot = environment.LOCALAPPDATA?.trim();
  const candidates = [
    ...(localRoot
      ? [
          win32.join(localRoot, "Google", "Chrome", "Application", "chrome.exe"),
          win32.join(localRoot, "Google", "Chrome", "Bin", "chromex.exe"),
        ]
      : []),
    ...[environment.PROGRAMFILES, environment["PROGRAMFILES(X86)"]]
      .filter((root): root is string => Boolean(root?.trim()))
      .map((root) => win32.join(root, "Google", "Chrome", "Application", "chrome.exe")),
  ];
  return candidates
    .filter((path, index, paths) => paths.findIndex((candidate) => candidate.toLowerCase() === path.toLowerCase()) === index);
}

export function validateChromeExecutablePath(
  selectedPath: string,
  exists: PathExists = isFile,
): string {
  const path = selectedPath.trim();
  if (
    !path
    || path.length > 1_024
    || /[\x00-\x1f]/u.test(path)
    || !win32.isAbsolute(path)
    || !SUPPORTED_CHROME_EXECUTABLE_NAMES.has(win32.basename(path).toLowerCase())
  ) {
    throw new InvalidChromeExecutablePathError();
  }
  if (!exists(path)) throw new InvalidChromeExecutablePathError("选择的 Chrome 文件不存在");
  return path;
}

export function resolveChromeExecutable(input: {
  customPath?: string | null;
  environment?: Environment;
  exists?: PathExists;
} = {}): ChromeExecutableResolution {
  const exists = input.exists ?? isFile;
  const customPath = input.customPath?.trim() || null;
  if (customPath) {
    try {
      const executablePath = validateChromeExecutablePath(customPath, exists);
      return {
        source: "custom",
        executablePath,
        customPath,
        customPathValid: true,
      };
    } catch {
      // A path copied from another computer must never block standard discovery.
    }
  }
  const standardPath = standardChromeCandidates(input.environment).find((path) => exists(path)) ?? null;
  if (standardPath) {
    return {
      source: "standard",
      executablePath: standardPath,
      customPath,
      customPathValid: false,
    };
  }
  return {
    source: "missing",
    executablePath: null,
    customPath,
    customPathValid: false,
  };
}

export async function verifyChromeExecutableLaunch(
  selectedPath: string,
  dependencies: {
    exists?: PathExists;
    createTemporaryProfile?: () => Promise<string>;
    launchBrowserContext?: ChromeValidationLauncher;
    removeTemporaryProfile?: (path: string) => Promise<void>;
  } = {},
): Promise<void> {
  const executablePath = validateChromeExecutablePath(selectedPath, dependencies.exists);
  const createTemporaryProfile = dependencies.createTemporaryProfile
    ?? (() => mkdtemp(join(tmpdir(), "tmall-chrome-validation-")));
  const launchBrowserContext = dependencies.launchBrowserContext ?? launchTmallBrowserContext;
  const removeTemporaryProfile = dependencies.removeTemporaryProfile
    ?? ((path) => rm(path, { recursive: true, force: true }));
  const profileDirectory = await createTemporaryProfile();
  try {
    const context = await launchBrowserContext({
      profileDirectory,
      executablePath,
      headless: true,
    });
    await context.close();
  } finally {
    await removeTemporaryProfile(profileDirectory);
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
