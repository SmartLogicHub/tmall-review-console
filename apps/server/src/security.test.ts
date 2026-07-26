import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";

const host = "127.0.0.1:4300";
const origin = `http://${host}`;

describe("local API security boundary", () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    app = buildApp({
      host,
      origin,
      sessionToken: "test-session-token",
      csrfToken: "test-csrf-token",
    });
    await app.ready();
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host } });
    cookie = bootstrap.cookies[0]?.value ?? "";
  });

  afterEach(async () => app.close());

  it("rejects an unexpected Host before issuing a session", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { host: "evil.example" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("requires the local session cookie for read endpoints", async () => {
    const response = await app.inject({ method: "GET", url: "/api/automation/status", headers: { host } });
    expect(response.statusCode).toBe(401);
  });

  it("requires exact origin, same-origin fetch metadata, and CSRF for mutations", async () => {
    const baseHeaders = { host, cookie: `tmall_console_session=${cookie}` };

    const missing = await app.inject({ method: "POST", url: "/api/automation/start-now", headers: baseHeaders });
    expect(missing.statusCode).toBe(403);

    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/api/automation/start-now",
      headers: {
        ...baseHeaders,
        origin: "https://evil.example",
        "sec-fetch-site": "same-origin",
        "x-csrf-token": "test-csrf-token",
      },
    });
    expect(wrongOrigin.statusCode).toBe(403);
  });

  it("does not enable CORS and marks every response no-store", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/automation/status",
      headers: { host, cookie: `tmall_console_session=${cookie}` },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
