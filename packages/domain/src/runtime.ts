export const RUNTIME_STATES = ["stopped", "running_read_only", "paused", "error"] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number];

export const RUNTIME_EVENTS = ["START", "PAUSE", "CONTINUE", "STOP", "FAIL", "RESET"] as const;
export type RuntimeEvent = (typeof RUNTIME_EVENTS)[number];

export const AUTH_STATES = [
  "not_configured",
  "checking_session",
  "authenticated",
  "session_expired",
  "auto_signing_in",
  "manual_verification_required",
  "manual_action_required",
  "not_ready",
  "navigation_failed",
  "credential_rejected",
  "identity_mismatch",
  "credential_error",
] as const;
export type AuthState = (typeof AUTH_STATES)[number];

export const REPLY_STATES = [
  "discovered",
  "classifying",
  "template_selected",
  "rewriting",
  "read_only_ready",
  "interrupted",
  "identity_ambiguous",
  "needs_attention",
  "failed",
] as const;
export type ReplyState = (typeof REPLY_STATES)[number];

export const ELEMENT_HEALTH_STATES = ["healthy", "degraded", "healing", "paused"] as const;
export type ElementHealthState = (typeof ELEMENT_HEALTH_STATES)[number];

const TRANSITIONS: Record<RuntimeState, Partial<Record<RuntimeEvent, RuntimeState>>> = {
  stopped: { START: "running_read_only", RESET: "stopped" },
  running_read_only: { PAUSE: "paused", STOP: "stopped", FAIL: "error" },
  paused: { CONTINUE: "running_read_only", STOP: "stopped", FAIL: "error" },
  error: { RESET: "stopped", STOP: "stopped" },
};

export function transitionRuntime(state: RuntimeState, event: RuntimeEvent): RuntimeState {
  const next = TRANSITIONS[state]?.[event];
  if (!next) {
    throw new Error(`Invalid runtime transition: ${state} -> ${String(event)}`);
  }
  return next;
}
