import concurrently from "concurrently";

const { result } = concurrently(
  [
    { command: "npm run dev -w apps/server", name: "本地服务" },
    { command: "npm run dev -w apps/web", name: "控制台" },
  ],
  {
    prefix: "name",
    padPrefix: true,
    killOthersOn: ["failure", "success"],
    killSignal: "SIGTERM",
  },
);

try {
  await result;
} catch {
  process.exitCode = 1;
}
