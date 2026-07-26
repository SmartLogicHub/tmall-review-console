import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiSessionForTests } from "../api/client";
import { useUiSession } from "./use-ui-session";

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

function SessionHarness() {
  useUiSession({ createSessionId: () => "console-tab" });
  return null;
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
  });
}

describe("useUiSession", () => {
  beforeEach(() => {
    resetApiSessionForTests();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "session-csrf" });
      return json({ activeCount: 1 });
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers once, renews its lease, and releases it when the page leaves", async () => {
    const view = render(<SessionHarness />);
    await flushPromises();

    expect(vi.mocked(fetch).mock.calls.some(([url, init]) =>
      String(url).endsWith("/api/ui-sessions/console-tab") && init?.method === "POST",
    )).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flushPromises();
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) =>
      String(url).endsWith("/api/ui-sessions/console-tab/heartbeat") && init?.method === "POST",
    )).toBe(true);

    window.dispatchEvent(new Event("pagehide"));
    await flushPromises();
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) =>
      String(url).endsWith("/api/ui-sessions/console-tab") && init?.method === "DELETE",
    )).toBe(true);
    view.unmount();

    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) =>
      String(url).endsWith("/api/ui-sessions/console-tab") && init?.method === "DELETE",
    )).toHaveLength(1);
  });
});
