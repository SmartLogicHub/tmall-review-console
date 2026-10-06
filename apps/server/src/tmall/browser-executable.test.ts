import { describe, expect, it } from "vitest";
import {
  InvalidChromeExecutablePathError,
  resolveChromeExecutable,
  standardChromeCandidates,
  validateChromeExecutablePath,
  verifyChromeExecutableLaunch,
} from "./browser-executable";

describe("Chrome executable resolution", () => {
  const environment = {
    LOCALAPPDATA: "C:\\Users\\seller\\AppData\\Local",
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  };

  it("uses a valid saved custom chrome.exe before standard installations", () => {
    const customPath = "D:\\Portable Chrome\\chrome.exe";
    const standardPath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const existing = new Set([customPath, standardPath]);

    expect(resolveChromeExecutable({
      customPath,
      environment,
      exists: (path) => existing.has(path),
    })).toEqual({
      source: "custom",
      executablePath: customPath,
      customPath,
      customPathValid: true,
    });
  });

  it("falls back to a standard Chrome when a transferred custom path no longer exists", () => {
    const standardPath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

    expect(resolveChromeExecutable({
      customPath: "D:\\Old computer\\chrome.exe",
      environment,
      exists: (path) => path === standardPath,
    })).toEqual({
      source: "standard",
      executablePath: standardPath,
      customPath: "D:\\Old computer\\chrome.exe",
      customPathValid: false,
    });
  });

  it("reports missing when neither the custom nor standard paths exist", () => {
    expect(resolveChromeExecutable({
      customPath: null,
      environment,
      exists: () => false,
    })).toEqual({
      source: "missing",
      executablePath: null,
      customPath: null,
      customPathValid: false,
    });
  });

  it("builds all supported per-user and machine-wide standard paths", () => {
    expect(standardChromeCandidates(environment)).toEqual([
      "C:\\Users\\seller\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\seller\\AppData\\Local\\Google\\Chrome\\Bin\\chromex.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ]);
  });

  it("accepts and resolves a verified chromex.exe installation", () => {
    const customPath = "C:\\Users\\seller\\AppData\\Local\\Google\\Chrome\\Bin\\chromex.exe";

    expect(validateChromeExecutablePath(customPath, () => true)).toBe(customPath);
    expect(resolveChromeExecutable({
      customPath,
      environment,
      exists: (path) => path === customPath,
    })).toMatchObject({
      source: "custom",
      executablePath: customPath,
      customPath,
      customPathValid: true,
    });
  });

  it.each([
    "",
    "D:\\Portable Chrome\\not-chrome.exe",
    "D:\\Portable Chrome\\firefox.exe",
    "D:\\Portable Chrome",
    "D:\\Portable Chrome\\chrome.exe\n--extra-argument",
  ])("rejects an unsafe or non-Chrome custom path: %s", (path) => {
    expect(() => validateChromeExecutablePath(path, () => true)).toThrow(InvalidChromeExecutablePathError);
  });

  it("rejects a selected chrome.exe that is no longer present", () => {
    expect(() => validateChromeExecutablePath("D:\\Portable Chrome\\chrome.exe", () => false))
      .toThrow(InvalidChromeExecutablePathError);
  });

  it("starts the selected Chrome with a disposable profile before accepting it", async () => {
    const events: string[] = [];
    await verifyChromeExecutableLaunch("D:\\Portable Chrome\\chrome.exe", {
      exists: () => true,
      createTemporaryProfile: async () => "C:\\Temp\\tmall-chrome-validation-123",
      launchBrowserContext: async (input) => {
        expect(input).toMatchObject({
          executablePath: "D:\\Portable Chrome\\chrome.exe",
          profileDirectory: "C:\\Temp\\tmall-chrome-validation-123",
          headless: true,
        });
        events.push("launched");
        return {
          close: async () => {
            events.push("closed");
          },
        };
      },
      removeTemporaryProfile: async (path) => {
        expect(path).toBe("C:\\Temp\\tmall-chrome-validation-123");
        events.push("removed");
      },
    });

    expect(events).toEqual(["launched", "closed", "removed"]);
  });

  it("removes the disposable profile even when the selected Chrome cannot launch", async () => {
    const removed: string[] = [];
    await expect(verifyChromeExecutableLaunch("D:\\Portable Chrome\\chrome.exe", {
      exists: () => true,
      createTemporaryProfile: async () => "C:\\Temp\\tmall-chrome-validation-456",
      launchBrowserContext: async () => {
        throw new Error("launch failed");
      },
      removeTemporaryProfile: async (path) => {
        removed.push(path);
      },
    })).rejects.toThrow("launch failed");

    expect(removed).toEqual(["C:\\Temp\\tmall-chrome-validation-456"]);
  });
});
