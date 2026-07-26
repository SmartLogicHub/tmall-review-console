import Fastify from "fastify";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerStaticWeb } from "./static-web";

describe("static web console", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tmall-web-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<main>评论助手</main>");
    await writeFile(join(root, "assets", "app.js"), "console.log('ready')");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves the built index and assets with their content types", async () => {
    const app = Fastify();
    registerStaticWeb(app, root);

    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.body).toContain("评论助手");

    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");
  });

  it("declares a packaged favicon instead of relying on the browser fallback", async () => {
    const index = await readFile(new URL("../../web/index.html", import.meta.url), "utf8");
    expect(index).toContain('rel="icon"');
    expect(index).toContain('href="/favicon.svg"');
    expect(index).toContain("<title>天猫智能回复</title>");
  });

  it("falls back to index only for client-side routes", async () => {
    const app = Fastify();
    registerStaticWeb(app, root);

    expect((await app.inject({ method: "GET", url: "/settings" })).body).toContain("评论助手");
    expect((await app.inject({ method: "GET", url: "/assets/missing.js" })).statusCode).toBe(404);
  });

  it("does not expose files outside the build directory", async () => {
    const app = Fastify();
    registerStaticWeb(app, root);

    expect((await app.inject({ method: "GET", url: "/..%2F..%2Fpackage.json" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/%2e%2e/%2e%2e/package.json" })).statusCode).toBe(404);
  });
});
