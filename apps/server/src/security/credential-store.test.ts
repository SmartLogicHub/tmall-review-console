import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { InMemorySecretStore, WindowsCredentialStore } from "./credential-store";

describe("InMemorySecretStore", () => {
  it("writes, reads, replaces, and deletes secrets", async () => {
    const store = new InMemorySecretStore();
    expect(await store.has("feishu")).toBe(false);
    await store.write("feishu", "first-secret");
    expect(await store.has("feishu")).toBe(true);
    expect(await store.read("feishu")).toBe("first-secret");
    await store.write("feishu", "second-secret");
    expect(await store.read("feishu")).toBe("second-secret");
    await store.delete("feishu");
    expect(await store.has("feishu")).toBe(false);
    expect(await store.read("feishu")).toBeNull();
  });
});

describe.skipIf(process.platform !== "win32")("WindowsCredentialStore", () => {
  const target = `TmallReviewConsole/Test/${randomUUID()}`;
  const store = new WindowsCredentialStore({ targetPrefix: target });

  afterEach(async () => {
    await store.delete("app-secret");
  }, 30_000);

  it("round-trips through Windows Credential Manager and cleans up", async () => {
    const secret = `secret-${randomUUID()}`;
    await store.write("app-secret", secret);
    expect(await store.has("app-secret")).toBe(true);
    expect(await store.read("app-secret")).toBe(secret);
    await store.delete("app-secret");
    expect(await store.has("app-secret")).toBe(false);
  }, 60_000);

  it("round-trips UTF-8 seller credentials without corrupting the account", async () => {
    const credentials = JSON.stringify({ account: "测试旗舰店:客服", password: "fake-password" });
    await store.write("app-secret", credentials);
    expect(await store.read("app-secret")).toBe(credentials);
  }, 60_000);
});
