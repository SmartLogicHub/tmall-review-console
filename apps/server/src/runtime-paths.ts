import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function defaultDatabasePath(): string {
  const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
  return resolve(workspaceRoot, "data", "tmall-review-console.sqlite");
}

export function defaultBrowserProfilePath(): string {
  const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
  return resolve(workspaceRoot, "data", "browser-profile");
}
