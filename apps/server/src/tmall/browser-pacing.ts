import { performance } from "node:perf_hooks";

type TextControl = {
  fill(value: string): Promise<void>;
  pressSequentially(value: string, options: { delay: number }): Promise<void>;
  inputValue(): Promise<string>;
};

export const TMALL_PACING = Object.freeze({
  character: 80,
  field: 400,
  navigation: 300,
  filter: 500,
  list: 800,
});

export async function enterTextWithStablePacing(control: TextControl, value: string): Promise<void> {
  await control.fill("");
  await control.pressSequentially(value, { delay: TMALL_PACING.character });
  if (await control.inputValue() !== value) {
    throw new Error("Tmall text entry verification failed");
  }
}

export async function waitForExplicitOutcome<T>(options: {
  probe: () => T | null | undefined | Promise<T | null | undefined>;
  wait: (durationMs: number) => void | Promise<void>;
  timeoutMs: number;
  pollMs: number;
  now?: () => number;
}): Promise<T | "timed_out"> {
  if (
    !Number.isFinite(options.timeoutMs)
    || options.timeoutMs < 0
    || !Number.isFinite(options.pollMs)
    || options.pollMs <= 0
  ) {
    throw new Error("Invalid Tmall browser pacing configuration");
  }

  const now = options.now ?? (() => performance.now());
  const startedAtMs = now();
  while (true) {
    let remainingMs = options.timeoutMs - (now() - startedAtMs);
    if (remainingMs <= 0) return "timed_out";

    const outcome = await options.probe();
    remainingMs = options.timeoutMs - (now() - startedAtMs);
    if (remainingMs <= 0) return "timed_out";
    if (outcome !== null && outcome !== undefined) return outcome;

    await options.wait(Math.min(options.pollMs, remainingMs));
  }
}
