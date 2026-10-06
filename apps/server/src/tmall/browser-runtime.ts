import { chromium, type BrowserContext } from "patchright";

export type TmallPersistentContextLauncher = (
  profileDirectory: string,
  options: Parameters<typeof chromium.launchPersistentContext>[1],
) => Promise<BrowserContext>;

export class TmallBrowserLaunchError extends Error {
  readonly cause?: unknown;

  constructor(options: { cause?: unknown } = {}) {
    super("专用淘宝浏览器启动失败。请确认已安装 Chrome，关闭 Chrome、影刀/RPA 等占用程序；换电脑使用时请清除旧浏览器资料后重试");
    this.name = "TmallBrowserLaunchError";
    this.cause = options.cause;
  }
}

export async function launchTmallBrowserContext(input: {
  profileDirectory: string;
  headless: boolean;
  executablePath?: string | null;
  launchPersistentContext?: TmallPersistentContextLauncher;
}): Promise<BrowserContext> {
  const launchPersistentContext = input.launchPersistentContext
    ?? chromium.launchPersistentContext.bind(chromium);
  try {
    return await launchPersistentContext(input.profileDirectory, {
      ...(input.executablePath
        ? { executablePath: input.executablePath }
        : { channel: "chrome" as const }),
      headless: input.headless,
      // Use Chrome's real maximized window dimensions. A simulated viewport can
      // be taller than the physical window on another computer, which makes
      // Tmall render the reply dialog footer below the visible screen.
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
    });
  } catch (cause) {
    throw new TmallBrowserLaunchError({ cause });
  }
}
