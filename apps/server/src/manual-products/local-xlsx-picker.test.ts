import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  LocalXlsxPickerProcessError,
  LocalXlsxPickerUnavailableError,
  WindowsLocalXlsxPicker,
  parsePickerOutput,
} from "./local-xlsx-picker";

describe("WindowsLocalXlsxPicker", () => {
  it("keeps the PowerShell 5.1 helper ASCII-only so localized dialog text is encoding-safe", async () => {
    const helperPath = fileURLToPath(new URL("../../resources/select-local-xlsx.ps1", import.meta.url));
    const source = await readFile(helperPath, "utf8");

    expect(source).not.toMatch(/[^\x00-\x7F]/u);
    expect(source).toContain("36873, 25321");
    expect(source).toContain("24037, 20316, 31807");
  });

  it("uses only the fixed helper script arguments and decodes the selected UTF-8 path", async () => {
    const runProcess = vi.fn(async () => ({
      exitCode: 0,
      stdout: `SELECTED:${Buffer.from("G:\\名单\\中差评剔除产品.xlsx", "utf8").toString("base64")}`,
    }));
    const picker = new WindowsLocalXlsxPicker({
      platform: "win32",
      powershellPath: "powershell-test.exe",
      helperPath: "C:\\fixed\\select-local-xlsx.ps1",
      runProcess,
    });

    await expect(picker.pick()).resolves.toEqual({ cancelled: false, path: "G:\\名单\\中差评剔除产品.xlsx" });
    expect(runProcess).toHaveBeenCalledWith("powershell-test.exe", [
      "-NoProfile", "-STA", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\fixed\\select-local-xlsx.ps1",
    ], expect.any(AbortSignal));
  });

  it("returns a stable cancellation and rejects unavailable or failed processes without leaking output", async () => {
    expect(parsePickerOutput("CANCELLED\r\n")).toEqual({ cancelled: true });
    await expect(new WindowsLocalXlsxPicker({ platform: "linux" }).pick()).rejects.toBeInstanceOf(LocalXlsxPickerUnavailableError);
    const failed = new WindowsLocalXlsxPicker({
      platform: "win32",
      runProcess: async () => ({ exitCode: 1, stdout: "C:\\private\\secret.xlsx" }),
    });
    await expect(failed.pick()).rejects.toMatchObject({
      name: LocalXlsxPickerProcessError.name,
      message: "本机文件选择器未能完成操作",
    });
  });

  it("coalesces concurrent requests and fails closed on timeout", async () => {
    const runProcess = vi.fn(async (_executable: string, _args: readonly string[], signal: AbortSignal) =>
      new Promise<{ exitCode: number; stdout: string }>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("timed out at C:\\private\\secret.xlsx")), { once: true });
      }));
    const picker = new WindowsLocalXlsxPicker({ platform: "win32", timeoutMs: 10, runProcess });
    const first = picker.pick();
    const second = picker.pick();

    expect(first).toBe(second);
    await expect(Promise.all([first, second])).rejects.toMatchObject({
      name: LocalXlsxPickerProcessError.name,
      message: "本机文件选择器未能完成操作",
    });
    expect(runProcess).toHaveBeenCalledTimes(1);
  });

  it("closes idempotently, aborts the shared in-flight dialog, and rejects later picks", async () => {
    let abortCount = 0;
    const runProcess = vi.fn(async (_executable: string, _args: readonly string[], signal: AbortSignal) =>
      new Promise<{ exitCode: number; stdout: string }>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortCount += 1;
          reject(new Error("dialog process stopped"));
        }, { once: true });
      }));
    const picker = new WindowsLocalXlsxPicker({ platform: "win32", runProcess });
    const first = picker.pick();
    const second = picker.pick();

    const closing = picker.close();
    const closingAgain = picker.close();

    expect(first).toBe(second);
    await expect(first).rejects.toBeInstanceOf(LocalXlsxPickerProcessError);
    await Promise.all([closing, closingAgain]);
    expect(abortCount).toBe(1);
    expect(runProcess).toHaveBeenCalledTimes(1);
    await expect(picker.pick()).rejects.toBeInstanceOf(LocalXlsxPickerUnavailableError);
  });

  it("can cancel an open dialog without permanently closing the picker", async () => {
    let invocation = 0;
    const runProcess = vi.fn(async (_executable: string, _args: readonly string[], signal: AbortSignal) => {
      invocation += 1;
      if (invocation === 2) return { exitCode: 0, stdout: "CANCELLED" };
      return new Promise<{ exitCode: number; stdout: string }>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    });
    const picker = new WindowsLocalXlsxPicker({ platform: "win32", runProcess });
    const pending = picker.pick();

    await picker.cancel();
    await expect(pending).rejects.toBeInstanceOf(LocalXlsxPickerProcessError);
    await expect(picker.pick()).resolves.toEqual({ cancelled: true });
    await picker.close();
  });
});
