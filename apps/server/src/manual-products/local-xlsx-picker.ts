import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export type LocalXlsxPickerResult = { cancelled: true } | { cancelled: false; path: string };

export interface LocalXlsxPicker {
  pick(): Promise<LocalXlsxPickerResult>;
  cancel?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export class LocalXlsxPickerUnavailableError extends Error {
  constructor() {
    super("本机文件选择器在当前系统不可用");
    this.name = "LocalXlsxPickerUnavailableError";
  }
}

export class LocalXlsxPickerProcessError extends Error {
  constructor() {
    super("本机文件选择器未能完成操作");
    this.name = "LocalXlsxPickerProcessError";
  }
}

type PickerProcessResult = { exitCode: number | null; stdout: string };
type PickerProcessRunner = (executable: string, args: readonly string[], signal: AbortSignal) => Promise<PickerProcessResult>;

export interface WindowsLocalXlsxPickerOptions {
  platform?: NodeJS.Platform;
  powershellPath?: string;
  helperPath?: string;
  runProcess?: PickerProcessRunner;
  timeoutMs?: number;
}

export class WindowsLocalXlsxPicker implements LocalXlsxPicker {
  readonly #platform: NodeJS.Platform;
  readonly #powershellPath: string;
  readonly #helperPath: string;
  readonly #runProcess: PickerProcessRunner;
  readonly #timeoutMs: number;
  #inFlight: Promise<LocalXlsxPickerResult> | null = null;
  #activeController: AbortController | null = null;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: WindowsLocalXlsxPickerOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#powershellPath = options.powershellPath ?? "powershell.exe";
    this.#helperPath = options.helperPath
      ?? fileURLToPath(new URL("../../resources/select-local-xlsx.ps1", import.meta.url));
    this.#runProcess = options.runProcess ?? runPickerProcess;
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? 10 * 60 * 1000);
  }

  pick(): Promise<LocalXlsxPickerResult> {
    if (this.#closed) return Promise.reject(new LocalXlsxPickerUnavailableError());
    if (this.#inFlight) return this.#inFlight;
    const current = this.#pickOnce().finally(() => {
      if (this.#inFlight === current) this.#inFlight = null;
    });
    this.#inFlight = current;
    return current;
  }

  cancel(): Promise<void> {
    return this.#cancelCurrent();
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#cancelCurrent();
    return this.#closePromise;
  }

  async #cancelCurrent(): Promise<void> {
    const pending = this.#inFlight;
    this.#activeController?.abort();
    if (!pending) return;
    try {
      await pending;
    } catch {
      // Cancellation is complete once the shared request settles.
    }
  }

  async #pickOnce(): Promise<LocalXlsxPickerResult> {
    if (this.#platform !== "win32") throw new LocalXlsxPickerUnavailableError();
    const args = [
      "-NoProfile",
      "-STA",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.#helperPath,
    ] as const;
    let result: PickerProcessResult;
    const controller = new AbortController();
    this.#activeController = controller;
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      result = await this.#runProcess(this.#powershellPath, args, controller.signal);
    } catch {
      throw new LocalXlsxPickerProcessError();
    } finally {
      clearTimeout(timeout);
      if (this.#activeController === controller) this.#activeController = null;
    }
    if (result.exitCode !== 0) throw new LocalXlsxPickerProcessError();
    return parsePickerOutput(result.stdout);
  }
}

export function parsePickerOutput(stdout: string): LocalXlsxPickerResult {
  const output = stdout.trim();
  if (output === "CANCELLED") return { cancelled: true };
  if (!output.startsWith("SELECTED:")) throw new LocalXlsxPickerProcessError();
  const encoded = output.slice("SELECTED:".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new LocalXlsxPickerProcessError();
  const path = Buffer.from(encoded, "base64").toString("utf8");
  if (!path || path.includes("\0") || path.includes("\r") || path.includes("\n")) {
    throw new LocalXlsxPickerProcessError();
  }
  return { cancelled: false, path };
}

function runPickerProcess(executable: string, args: readonly string[], signal: AbortSignal): Promise<PickerProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    let terminationRequested = false;
    const cleanup = () => signal.removeEventListener("abort", terminate);
    const rejectProcess = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new LocalXlsxPickerProcessError());
    };
    const terminate = () => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      // OpenFileDialog runs inside this PowerShell process; terminate only this direct child.
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", terminate, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 32_768) terminate();
    });
    child.once("error", rejectProcess);
    child.once("close", (exitCode) => {
      cleanup();
      if (settled) return;
      settled = true;
      if (terminationRequested) reject(new LocalXlsxPickerProcessError());
      else resolve({ exitCode, stdout });
    });
  });
}
