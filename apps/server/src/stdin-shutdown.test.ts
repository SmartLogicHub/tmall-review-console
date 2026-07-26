import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installStdinShutdown } from "./stdin-shutdown";

class TestInput extends EventEmitter {
  resume = vi.fn();
}

describe("stdin-owned server lifetime", () => {
  it("shuts down and exits once when the launcher closes stdin", async () => {
    const input = new TestInput();
    const shutdown = vi.fn(async () => undefined);
    const exit = vi.fn();
    installStdinShutdown(input, shutdown, exit);

    expect(input.resume).toHaveBeenCalledOnce();
    input.emit("end");
    input.emit("end");
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("returns a failure exit code when graceful shutdown fails", async () => {
    const input = new TestInput();
    const exit = vi.fn();
    installStdinShutdown(input, async () => { throw new Error("close failed"); }, exit);

    input.emit("end");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
