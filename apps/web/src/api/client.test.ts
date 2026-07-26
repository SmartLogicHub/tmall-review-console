import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, resetApiSessionForTests, toUserMessage } from "./client";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

describe("apiFetch session recovery", () => {
  beforeEach(() => {
    resetApiSessionForTests();
  });

  it.each(["invalid_session", "invalid_csrf"])("reinitializes and retries once for %s", async (errorCode) => {
    let bootstrapCount = 0;
    let mutationCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) {
        bootstrapCount += 1;
        return json({ csrfToken: `csrf-${bootstrapCount}` });
      }
      mutationCount += 1;
      if (mutationCount === 1) return json({ error: errorCode }, errorCode === "invalid_session" ? 401 : 403);
      return json({ ok: true, csrf: new Headers(init?.headers).get("X-CSRF-Token") });
    }));

    await expect(apiFetch<{ ok: boolean; csrf: string }>("/api/example", { method: "POST" }))
      .resolves.toEqual({ ok: true, csrf: "csrf-2" });
    expect(bootstrapCount).toBe(2);
    expect(mutationCount).toBe(2);
  });

  it("does not retry business errors and shows a human-readable message", async () => {
    let requestCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/bootstrap")) return json({ csrfToken: "csrf-1" });
      requestCount += 1;
      return json({ error: "tmall_credentials_not_configured", detail: "请先保存淘宝商家账号和密码" }, 409);
    }));

    await expect(apiFetch("/api/example", { method: "POST" })).rejects.toThrow("请先保存淘宝商家账号和密码");
    expect(requestCount).toBe(1);
  });

  it("preserves typed revision-conflict metadata without replaying the mutation", async () => {
    let requestCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/bootstrap")) return json({ csrfToken: "csrf-1" });
      requestCount += 1;
      return json({
        error: "review_scope_changed",
        detail: "处理日期已在其他页面修改，请刷新后重试",
        currentRevision: 9,
      }, 409);
    }));

    const error = await apiFetch("/api/review-scope", { method: "PUT", body: "{}" }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "review_scope_changed", status: 409, currentRevision: 9 });
    expect((error as Error).message).toBe("处理日期已在其他页面修改，请刷新后重试");
    expect(requestCount).toBe(1);
  });

  it("lets the browser set the multipart boundary for FormData while keeping session protection", async () => {
    const uploads: Array<{ headers: Headers; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/bootstrap")) return json({ csrfToken: "csrf-upload" });
      uploads.push({ headers: new Headers(init?.headers), body: init?.body });
      return json({ ok: true });
    }));
    const form = new FormData();
    form.append("file", new File(["xlsx"], "products.xlsx"));

    await apiFetch("/api/manual-products/import/preview", { method: "POST", body: form });

    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.headers.get("X-CSRF-Token")).toBe("csrf-upload");
    expect(uploads[0]?.headers.has("Content-Type")).toBe(false);
    expect(uploads[0]?.body).toBe(form);
  });

  it("refreshes an expired session but never replays an unsafe confirmed mutation", async () => {
    let bootstrapCount = 0;
    let mutationCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/bootstrap")) {
        bootstrapCount += 1;
        return json({ csrfToken: `csrf-${bootstrapCount}` });
      }
      mutationCount += 1;
      return json({ error: "invalid_session", detail: "本地会话已更新，请确认后重试" }, 401);
    }));

    await expect(apiFetch("/api/manual-products/import/apply", { method: "POST", body: "{}" }, { replayOnSessionRecovery: false }))
      .rejects.toMatchObject({ code: "session_recovered_confirmation_required", status: 409, message: "本地服务已重新连接，请重新确认此操作" });
    expect(bootstrapCount).toBe(2);
    expect(mutationCount).toBe(1);
  });

  it("does not replay unsafe deletes after CSRF recovery", async () => {
    let mutationCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/bootstrap")) return json({ csrfToken: "csrf-delete" });
      mutationCount += 1;
      return json({ error: "invalid_csrf", detail: "本地安全会话已更新，请确认后重试" }, 403);
    }));

    await expect(apiFetch("/api/manual-products/product-1", { method: "DELETE", body: "{}" }, { replayOnSessionRecovery: false }))
      .rejects.toMatchObject({ code: "session_recovered_confirmation_required", status: 409 });
    expect(mutationCount).toBe(1);
  });

  it("only exposes trusted ApiError messages to the interface", () => {
    expect(toUserMessage(new ApiError("名单已更新，请重试", "changed", 409), "安全回退")).toBe("名单已更新，请重试");
    expect(toUserMessage(new Error("ECONNRESET private-host"), "安全回退")).toBe("安全回退");
    expect(toUserMessage("raw failure", "安全回退")).toBe("安全回退");
  });
});
