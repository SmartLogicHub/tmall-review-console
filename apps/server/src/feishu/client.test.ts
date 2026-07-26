import { describe, expect, it, vi } from "vitest";
import { FeishuClient } from "./client";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("FeishuClient", () => {
  it("caches the tenant token and reads every field and record page", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("tenant_access_token")) {
        return jsonResponse({ code: 0, tenant_access_token: "token-one", expire: 3600 });
      }
      if (url.includes("/fields")) {
        return url.includes("page_token=fields-next")
          ? jsonResponse({ code: 0, data: { items: [{ field_name: "包含关键词" }], has_more: false } })
          : jsonResponse({ code: 0, data: { items: [{ field_name: "关键词分类" }], has_more: true, page_token: "fields-next" } });
      }
      if (!url.includes("page_token=records-next")) {
        return jsonResponse({
          code: 0,
          data: { items: [{ record_id: "rec-1", fields: {} }], has_more: true, page_token: "records-next" },
        });
      }
      return jsonResponse({
        code: 0,
        data: { items: [{ record_id: "rec-2", fields: {} }], has_more: false },
      });
    });
    const client = new FeishuClient({ appId: "cli-app", appSecret: "secret", fetchFn });

    expect(await client.listFields("app-token", "table-id")).toHaveLength(2);
    expect(await client.listRecords("app-token", "table-id")).toHaveLength(2);
    expect(calls.filter((call) => call.url.includes("tenant_access_token"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes("page_token=fields-next"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes("page_token=records-next"))).toHaveLength(1);
    expect(
      calls
        .filter((call) => !call.url.includes("tenant_access_token"))
        .every((call) => new Headers(call.init?.headers).get("authorization") === "Bearer token-one"),
    ).toBe(true);
  });

  it("retries network, 429, and 5xx failures at most twice", async () => {
    for (const failure of ["network", 429, 503] as const) {
      const sleep = vi.fn(async () => undefined);
      let attempts = 0;
      const fetchFn = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("tenant_access_token")) {
          return jsonResponse({ code: 0, tenant_access_token: "token-one", expire: 3600 });
        }
        attempts += 1;
        if (attempts === 1 && failure === "network") throw new TypeError("network down");
        if (attempts === 1) return jsonResponse({ code: 999, msg: "busy" }, failure as number);
        return jsonResponse({ code: 0, data: { items: [], has_more: false } });
      });
      const client = new FeishuClient({ appId: "cli-app", appSecret: "secret", fetchFn, sleep });
      await expect(client.listFields("app-token", "table-id")).resolves.toEqual([]);
      expect(attempts).toBe(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    }
  });

  it("refreshes an invalid token only once", async () => {
    let tokenCount = 0;
    let apiCount = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("tenant_access_token")) {
        tokenCount += 1;
        return jsonResponse({ code: 0, tenant_access_token: `token-${tokenCount}`, expire: 3600 });
      }
      apiCount += 1;
      if (apiCount === 1) return jsonResponse({ code: 99991663, msg: "token invalid" });
      return jsonResponse({ code: 0, data: { items: [], has_more: false } });
    });
    const client = new FeishuClient({ appId: "cli-app", appSecret: "secret", fetchFn });

    await expect(client.listRecords("app-token", "table-id")).resolves.toEqual([]);
    expect(tokenCount).toBe(2);
    expect(apiCount).toBe(2);
  });
});
