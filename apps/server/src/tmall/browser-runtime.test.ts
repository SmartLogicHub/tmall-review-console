import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { TmallBrowserLaunchError, launchTmallBrowserContext } from "./browser-runtime";

describe("Patchright Tmall browser runtime", () => {
  it("uses the native maximized Chrome viewport so the page matches a manually opened browser", async () => {
    const context = { pages: () => [] };
    const calls: Array<{ directory: string; options: Record<string, unknown> }> = [];
    const result = await launchTmallBrowserContext({
      profileDirectory: "G:\\tmall\\browser-profile",
      headless: true,
      launchPersistentContext: async (directory, options) => {
        calls.push({ directory, options: options as Record<string, unknown> });
        return context as never;
      },
    });

    expect(result).toBe(context);
    expect(calls).toEqual([{
      directory: "G:\\tmall\\browser-profile",
      options: {
        channel: "chrome",
        headless: true,
        viewport: null,
        locale: "zh-CN",
        serviceWorkers: "block",
        args: [
          "--disable-extensions",
          "--disable-blink-features=AutomationControlled",
          "--disable-session-crashed-bubble",
          "--no-first-run",
          "--no-default-browser-check",
          "--start-maximized",
        ],
      },
    }]);
  });

  it("does not retain launch state between calls", async () => {
    let calls = 0;
    const launchPersistentContext = async () => {
      calls += 1;
      return { id: calls } as never;
    };
    await launchTmallBrowserContext({ profileDirectory: "one", headless: false, launchPersistentContext });
    await launchTmallBrowserContext({ profileDirectory: "two", headless: false, launchPersistentContext });
    expect(calls).toBe(2);
  });

  it("converts a raw Chrome launch failure into a safe and actionable error", async () => {
    const launch = launchTmallBrowserContext({
      profileDirectory: "C:\\private\\copied-profile",
      headless: false,
      launchPersistentContext: async () => {
        throw new Error("EPERM C:\\private\\copied-profile Bearer secret-token");
      },
    });

    await expect(launch).rejects.toEqual(expect.objectContaining({
      name: "TmallBrowserLaunchError",
      message: "专用淘宝浏览器启动失败。请确认已安装 Chrome，并关闭影刀RPA等正在调试 Chrome 的工具后重试",
    }));
    await expect(launch).rejects.toBeInstanceOf(TmallBrowserLaunchError);
    await expect(launch).rejects.not.toHaveProperty("message", expect.stringMatching(/private|Bearer|secret-token/iu));
  });

  it("depends on patchright without installing playwright-extra or stealth packages", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const source = await readFile(new URL("./auth-driver.ts", import.meta.url), "utf8");
    expect(packageJson.dependencies?.patchright).toBe("^1.61.1");
    expect(packageJson.dependencies).not.toHaveProperty("playwright-extra");
    expect(Object.keys(packageJson.dependencies ?? {})).not.toEqual(expect.arrayContaining([expect.stringMatching(/stealth/iu)]));
    expect(source).toContain('from "patchright"');
    expect(source).not.toMatch(/playwright-extra|stealth/iu);
  });
});
