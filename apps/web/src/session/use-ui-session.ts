import { useEffect, useRef } from "react";
import { apiFetch } from "../api/client";

const HEARTBEAT_INTERVAL_MS = 5_000;

export interface UseUiSessionOptions {
  createSessionId?: () => string;
}

function createSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `console-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useUiSession(options: UseUiSessionOptions = {}): void {
  const sessionId = useRef<string | null>(null);
  if (sessionId.current === null) sessionId.current = (options.createSessionId ?? createSessionId)();

  useEffect(() => {
    const path = `/api/ui-sessions/${encodeURIComponent(sessionId.current!)}`;
    let released = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const release = () => {
      if (released) return;
      released = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      void apiFetch(`${path}`, { method: "DELETE" }).catch(() => undefined);
    };
    const heartbeat = () => {
      if (released) return;
      void apiFetch(`${path}/heartbeat`, { method: "POST" }).catch(() => undefined);
    };
    const onPageHide = () => release();

    window.addEventListener("pagehide", onPageHide);
    void apiFetch(path, { method: "POST" })
      .then(() => {
        if (!released) heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
      })
      .catch(() => undefined);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      release();
    };
  }, []);
}
