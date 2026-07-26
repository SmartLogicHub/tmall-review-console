import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "./database";
import { RevisionConflictError, ReviewScopeRepository } from "./review-scope-repository";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ReviewScopeRepository", () => {
  it("reads the default and persists a compare-and-swap update across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-scope-repo-"));
    cleanup.push(directory);
    const path = join(directory, "console.sqlite");
    const database = openDatabase(path);
    runMigrations(database);
    const repository = new ReviewScopeRepository(database);

    expect(repository.get()).toMatchObject({
      preset: "last7",
      startDate: null,
      endDate: null,
      timezone: "Asia/Shanghai",
      revision: 1,
    });
    expect(repository.save({ preset: "custom", startDate: "2026-07-01", endDate: "2026-07-14" }, 1))
      .toMatchObject({ preset: "custom", startDate: "2026-07-01", endDate: "2026-07-14", revision: 2 });
    database.close();

    const reopened = openDatabase(path);
    runMigrations(reopened);
    expect(new ReviewScopeRepository(reopened).get()).toMatchObject({ preset: "custom", revision: 2 });
    reopened.close();
  });

  it("rejects a stale revision with a recognizable domain error and no mutation", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new ReviewScopeRepository(database);
    repository.save({ preset: "today" }, 1);

    expect(() => repository.save({ preset: "last30" }, 1)).toThrowError(RevisionConflictError);
    try {
      repository.save({ preset: "last30" }, 1);
    } catch (error) {
      expect(error).toMatchObject({ code: "REVISION_CONFLICT", currentRevision: 2 });
      expect(String(error)).not.toContain("UPDATE review_scope");
    }
    expect(repository.get()).toMatchObject({ preset: "today", revision: 2 });
    database.close();
  });
});
