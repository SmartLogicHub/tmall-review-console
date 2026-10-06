import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  WindowsLocalChromePicker,
  type LocalChromePickerResult,
} from "./local-chrome-picker";

describe("WindowsLocalChromePicker", () => {
  it("ships an ASCII-only Windows PowerShell helper for chrome.exe and chromex.exe", async () => {
    const helperPath = fileURLToPath(new URL("../../resources/select-local-chrome.ps1", import.meta.url));
    const source = await readFile(helperPath, "utf8");

    expect(source).not.toMatch(/[^\x00-\x7F]/u);
    expect(source).toContain("Google Chrome");
    expect(source).toContain("chrome.exe");
    expect(source).toContain("chromex.exe");
  });

  it("opens the Chrome helper and decodes a selected custom executable path", async () => {
    const runProcess = vi.fn(async () => ({
      exitCode: 0,
      stdout: `SELECTED:${Buffer.from("D:\\浏览器\\Google Chrome\\chrome.exe", "utf8").toString("base64")}`,
    }));
    const picker = new WindowsLocalChromePicker({
      platform: "win32",
      powershellPath: "powershell-test.exe",
      helperPath: "C:\\fixed\\select-local-chrome.ps1",
      runProcess,
    });

    await expect(picker.pick()).resolves.toEqual<LocalChromePickerResult>({
      cancelled: false,
      path: "D:\\浏览器\\Google Chrome\\chrome.exe",
    });
    expect(runProcess).toHaveBeenCalledWith("powershell-test.exe", [
      "-NoProfile", "-STA", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\fixed\\select-local-chrome.ps1",
    ], expect.any(AbortSignal));
  });

  it("returns cancellation without changing the current browser path", async () => {
    const picker = new WindowsLocalChromePicker({
      platform: "win32",
      runProcess: async () => ({ exitCode: 0, stdout: "CANCELLED" }),
    });

    await expect(picker.pick()).resolves.toEqual({ cancelled: true });
    await picker.close();
  });
});
