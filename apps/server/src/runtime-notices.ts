const FOREGROUND_BROWSER_IDLE_MESSAGE =
  "Foreground browser session expired; local service remains available until the launcher is closed";

export function createForegroundBrowserIdleNotifier(options: {
  cooldownMs: number;
  now?: () => number;
  console?: Pick<Console, "info" | "warn">;
}): () => void {
  if (!Number.isFinite(options.cooldownMs) || options.cooldownMs < 1_000) {
    throw new Error("Foreground browser idle notice cooldown must be at least one second");
  }
  const now = options.now ?? Date.now;
  const output = options.console ?? console;
  let lastNoticeAt: number | null = null;
  return () => {
    const current = now();
    if (lastNoticeAt !== null && current - lastNoticeAt < options.cooldownMs) return;
    lastNoticeAt = current;
    output.info(FOREGROUND_BROWSER_IDLE_MESSAGE);
  };
}

