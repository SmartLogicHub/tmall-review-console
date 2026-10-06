import { randomBytes } from "node:crypto";
import { buildApp } from "./app";
import { defaultBrowserProfilePath, defaultDatabasePath } from "./runtime-paths";
import { InMemorySecretStore, WindowsCredentialStore } from "./security/credential-store";
import { openDatabase, runMigrations } from "./storage/database";
import { SettingsRepository } from "./storage/repositories";
import { PlaywrightTmallAuthDriver } from "./tmall/auth-driver";
import {
  resolveChromeExecutable,
  TMALL_BROWSER_EXECUTABLE_PATH_SETTING_KEY,
} from "./tmall/browser-executable";
import { bindComplaintAnalysis, createProductionComplaintReviewPolicy } from "./complaints/production-complaint-review-policy";
import { registerStaticWeb } from "./static-web";
import { installStdinShutdown } from "./stdin-shutdown";
import { UiSessionManager } from "./ui-session-manager";
import { createForegroundBrowserIdleNotifier } from "./runtime-notices";

const port = Number(process.env.TMALL_CONSOLE_PORT ?? 4300);
const host = `127.0.0.1:${port}`;
const origin = process.env.TMALL_CONSOLE_ORIGIN ?? "http://127.0.0.1:5173";

const databasePath = process.env.TMALL_CONSOLE_DATABASE_PATH ?? defaultDatabasePath();
const database = openDatabase(databasePath);
runMigrations(database);
const startupSettings = new SettingsRepository(database);
const tmallAuthDriver = new PlaywrightTmallAuthDriver({
  profileDirectory: process.env.TMALL_CONSOLE_BROWSER_PROFILE_PATH ?? defaultBrowserProfilePath(),
  browserExecutablePath: () => resolveChromeExecutable({
    customPath: startupSettings.get<string>(TMALL_BROWSER_EXECUTABLE_PATH_SETTING_KEY),
  }).executablePath,
});
const notifyForegroundBrowserIdle = createForegroundBrowserIdleNotifier({
  cooldownMs: 15 * 60_000,
});
const uiSessionManager = new UiSessionManager({
  leaseMs: 15_000,
  onIdle: notifyForegroundBrowserIdle,
});

const app = buildApp({
        host,
        origin,
        sessionToken: randomBytes(32).toString("hex"),
        csrfToken: randomBytes(32).toString("hex"),
        database,
        secretStore: process.env.TMALL_CONSOLE_IN_MEMORY_SECRETS === "1" ? new InMemorySecretStore() : new WindowsCredentialStore(),
        tmallAuthDriver,
        complaintReviewPolicyFactory: ({ complaints, ai, complaintAutoSubmit }) => {
          const analyzeComplaint = bindComplaintAnalysis(ai);
          return createProductionComplaintReviewPolicy({
            complaints,
            complaintAutoSubmit,
            executeComplaint: tmallAuthDriver.executeComplaint,
            ...(analyzeComplaint ? { analyzeComplaint } : {}),
          });
        },
        uiSessionManager,
});
const webDistPath = process.env.TMALL_CONSOLE_WEB_DIST_PATH;
if (webDistPath) registerStaticWeb(app, webDistPath);
await app.listen({ host: "127.0.0.1", port });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  uiSessionManager.dispose();
  await app.close();
};
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
if (process.env.TMALL_CONSOLE_LAUNCHER_OWNS_STDIN === "1") {
  installStdinShutdown(process.stdin, shutdown, (code) => process.exit(code));
}
console.log(`Tmall review console API listening on http://${host}`);
