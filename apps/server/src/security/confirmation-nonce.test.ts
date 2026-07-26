import { describe, expect, it } from "vitest";
import { ConfirmationNonceService } from "./confirmation-nonce";

describe("ConfirmationNonceService", () => {
  it("creates a 32-byte, five-minute, single-use nonce", () => {
    let now = Date.parse("2026-07-13T00:00:00.000Z");
    const service = new ConfirmationNonceService({ now: () => now });

    const prepared = service.prepare({ sessionId: "session-a", action: "replace" });

    expect(Buffer.from(prepared.nonce, "base64url")).toHaveLength(32);
    expect(prepared.expiresAt).toBe(now + 5 * 60 * 1000);
    expect(
      service.consume({ nonce: prepared.nonce, sessionId: "session-a", action: "replace" }),
    ).toBe(true);
    expect(() =>
      service.consume({ nonce: prepared.nonce, sessionId: "session-a", action: "replace" }),
    ).toThrow(/invalid or expired/i);
  });

  it("invalidates the nonce after a wrong session or action attempt", () => {
    const service = new ConfirmationNonceService();
    const wrongSession = service.prepare({ sessionId: "session-a", action: "replace" });

    expect(() =>
      service.consume({ nonce: wrongSession.nonce, sessionId: "session-b", action: "replace" }),
    ).toThrow(/invalid or expired/i);
    expect(() =>
      service.consume({ nonce: wrongSession.nonce, sessionId: "session-a", action: "replace" }),
    ).toThrow(/invalid or expired/i);

    const wrongAction = service.prepare({ sessionId: "session-a", action: "replace" });
    expect(() =>
      service.consume({ nonce: wrongAction.nonce, sessionId: "session-a", action: "delete" }),
    ).toThrow(/invalid or expired/i);
    expect(() =>
      service.consume({ nonce: wrongAction.nonce, sessionId: "session-a", action: "replace" }),
    ).toThrow(/invalid or expired/i);
  });

  it("rejects and consumes an expired nonce", () => {
    let now = 1_000;
    const service = new ConfirmationNonceService({ now: () => now, ttlMs: 50 });
    const prepared = service.prepare({ sessionId: "session-a", action: "delete" });
    now = 1_051;

    expect(() =>
      service.consume({ nonce: prepared.nonce, sessionId: "session-a", action: "delete" }),
    ).toThrow(/invalid or expired/i);
    expect(() =>
      service.consume({ nonce: prepared.nonce, sessionId: "session-a", action: "delete" }),
    ).toThrow(/invalid or expired/i);
  });

  it("does not accept a secret-delete nonce for a factory reset", () => {
    const service = new ConfirmationNonceService();
    const prepared = service.prepare({ sessionId: "session-a", action: "delete" });
    expect(() => service.consume({ nonce: prepared.nonce, sessionId: "session-a", action: "factory_reset" })).toThrow(/invalid or expired/i);
  });
});
