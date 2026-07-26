import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("foreground browser session lifecycle", () => {
  it("does not close the local API when a browser session becomes idle", () => {
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/onIdle:\s*\(\)\s*=>\s*\{\s*void shutdown\(\)/u);
  });
});
