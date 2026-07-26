import { describe, expect, it } from "vitest";
import { AUTH_STATES, RUNTIME_STATES, transitionRuntime } from "./runtime";

describe("runtime state machine", () => {
  it("starts only in read-only mode", () => {
    expect(transitionRuntime("stopped", "START")).toBe("running_read_only");
  });

  it("pauses and continues a read-only run", () => {
    expect(transitionRuntime("running_read_only", "PAUSE")).toBe("paused");
    expect(transitionRuntime("paused", "CONTINUE")).toBe("running_read_only");
  });

  it("rejects invalid and submit-like events", () => {
    expect(() => transitionRuntime("stopped", "CONTINUE")).toThrow("Invalid runtime transition");
    expect(() => transitionRuntime("running_read_only", "SUBMIT_REPLY" as never)).toThrow(
      "Invalid runtime transition",
    );
  });

  it("contains no submitted or production-running state", () => {
    expect(RUNTIME_STATES).toEqual(["stopped", "running_read_only", "paused", "error"]);
    expect(RUNTIME_STATES.some((state) => state.includes("submit"))).toBe(false);
  });

  it("exposes the finite Tmall login states from the approved design", () => {
    expect(AUTH_STATES).toContain("manual_verification_required");
    expect(AUTH_STATES).toContain("manual_action_required");
    expect(AUTH_STATES).toContain("not_ready");
    expect(AUTH_STATES).toContain("navigation_failed");
    expect(AUTH_STATES).toContain("credential_rejected");
    expect(AUTH_STATES).toContain("identity_mismatch");
    expect(AUTH_STATES).toContain("credential_error");
    expect(AUTH_STATES).not.toContain("locked_out");
  });
});
