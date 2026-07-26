import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultBrowserProfilePath, defaultDatabasePath } from "./runtime-paths";

describe("runtime paths", () => {
  it("keeps the database in the workspace-level data directory regardless of cwd", () => {
    const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
    expect(defaultDatabasePath()).toBe(resolve(workspaceRoot, "data", "tmall-review-console.sqlite"));
    expect(defaultDatabasePath()).not.toContain(resolve("apps/server/data"));
  });

  it("isolates the automated browser profile from the user's normal browser", () => {
    const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
    expect(defaultBrowserProfilePath()).toBe(resolve(workspaceRoot, "data", "browser-profile"));
  });
});
