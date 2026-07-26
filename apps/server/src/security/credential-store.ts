import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface SecretStore {
  has(key: string): Promise<boolean>;
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
  readonly #values = new Map<string, string>();

  async has(key: string) {
    return this.#values.has(key);
  }

  async read(key: string) {
    return this.#values.get(key) ?? null;
  }

  async write(key: string, value: string) {
    if (!value) throw new Error("Secret cannot be empty");
    this.#values.set(key, value);
  }

  async delete(key: string) {
    this.#values.delete(key);
  }
}

interface WindowsCredentialStoreOptions {
  targetPrefix?: string;
  helperPath?: string;
  powershellPath?: string;
}

interface HelperResponse {
  ok: boolean;
  exists?: boolean;
  value?: string | null;
  error?: string;
}

export class WindowsCredentialStore implements SecretStore {
  readonly #targetPrefix: string;
  readonly #helperPath: string;
  readonly #powershellPath: string;

  constructor(options: WindowsCredentialStoreOptions = {}) {
    this.#targetPrefix = options.targetPrefix ?? "TmallReviewConsole";
    this.#helperPath =
      options.helperPath ??
      fileURLToPath(new URL("../../resources/windows-credential-helper.ps1", import.meta.url));
    this.#powershellPath = options.powershellPath ?? "powershell.exe";
  }

  async has(key: string) {
    const response = await this.#invoke({ action: "has", target: this.#target(key) });
    return response.exists === true;
  }

  async read(key: string) {
    const response = await this.#invoke({ action: "read", target: this.#target(key) });
    return response.value ?? null;
  }

  async write(key: string, value: string) {
    if (!value) throw new Error("Secret cannot be empty");
    await this.#invoke({ action: "write", target: this.#target(key), secret: value });
  }

  async delete(key: string) {
    await this.#invoke({ action: "delete", target: this.#target(key) });
  }

  #target(key: string) {
    if (!key || /[\x00-\x1f]/u.test(key)) throw new Error("Invalid credential key");
    return `${this.#targetPrefix}/${key}`;
  }

  async #invoke(request: Record<string, string>): Promise<HelperResponse> {
    if (process.platform !== "win32") {
      throw new Error("Windows Credential Manager is only available on Windows");
    }

    return new Promise((resolve, reject) => {
      const child = spawn(
        this.#powershellPath,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.#helperPath],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          let helperError = "";
          try {
            helperError = (JSON.parse(stdout.trim()) as HelperResponse).error?.trim() ?? "";
          } catch {
            // Prefer the helper's structured error when available; stderr is
            // retained as the compatibility fallback for process failures.
          }
          reject(new Error(helperError || stderr.trim() || "Windows Credential Manager helper failed"));
          return;
        }
        try {
          const response = JSON.parse(stdout.trim()) as HelperResponse;
          if (!response.ok) {
            reject(new Error(response.error || "Windows Credential Manager operation failed"));
            return;
          }
          resolve(response);
        } catch {
          reject(new Error("Windows Credential Manager returned an invalid response"));
        }
      });
      child.stdin.end(JSON.stringify(request), "utf8");
    });
  }
}
