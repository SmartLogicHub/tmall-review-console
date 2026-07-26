export interface LauncherInput {
  once(event: "end", listener: () => void): unknown;
  resume(): unknown;
}

export function installStdinShutdown(
  input: LauncherInput,
  shutdown: () => Promise<void>,
  exit: (code: number) => void,
): void {
  let stopping = false;
  input.once("end", () => {
    if (stopping) return;
    stopping = true;
    void shutdown().then(() => exit(0), () => exit(1));
  });
  input.resume();
}
