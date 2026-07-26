import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedTemplate } from "@tmall/domain";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "./database";
import { AutomationRepository, LocatorRepository, ReplyAttemptRepository, ReplyRepository, SettingsRepository, TemplateRepository } from "./repositories";
import { ReviewActionConflictError, ReviewActionGate } from "../submission/review-action-gate";

const cleanupPaths: string[] = [];
const RUN_SCOPE = {
  preset: "last7",
  startDate: "2026-07-09",
  endDate: "2026-07-15",
  timezone: "Asia/Shanghai",
  revision: 1,
} as const;

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createFileDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "tmall-review-db-"));
  cleanupPaths.push(directory);
  const path = join(directory, "console.sqlite");
  const database = openDatabase(path);
  runMigrations(database);
  return { database, path };
}

function createVersion8Database() {
  const database = openDatabase(":memory:");
  runMigrations(database, 8);
  return database;
}

function createVersion10Database() {
  const database = openDatabase(":memory:");
  runMigrations(database, 10);
  return database;
}

function createVersion11Database() {
  const database = openDatabase(":memory:");
  runMigrations(database, 11);
  return database;
}

function createVersion16Database() {
  const database = openDatabase(":memory:");
  runMigrations(database, 16);
  return database;
}

function template(category: string, reply: string): NormalizedTemplate {
  return {
    primaryCategory: "",
    category,
    keywords: [category],
    replies: [{ sequence: 1, text: reply }],
  };
}

describe("SQLite persistence", () => {
  it("upgrades version 16 complaint data with the invocation ledger idempotently", () => {
    const database = createVersion16Database();
    const timestamp = "2026-07-18T00:00:00.000Z";
    database.prepare(`INSERT INTO complaint_cases(
      id, store_id, source_key, state, image_hashes_json, image_pairs_json, created_at, updated_at
    ) VALUES ('legacy-complaint', 'primary', 'legacy-source', 'discovered', '[]', '[]', ?, ?)`)
      .run(timestamp, timestamp);

    runMigrations(database);
    runMigrations(database);

    expect(database.prepare("SELECT id, state FROM complaint_cases WHERE id = 'legacy-complaint'").get())
      .toEqual({ id: "legacy-complaint", state: "discovered" });
    expect((database.pragma("table_info('complaint_analysis_invocations')") as Array<{ name: string }>).map((column) => column.name))
      .toEqual(["id", "complaint_case_id", "analysis_pass", "result_digest", "created_at"]);
    expect(database.prepare("SELECT COUNT(*) AS value FROM schema_migrations WHERE version = 17").get())
      .toEqual({ value: 1 });
    database.close();
  });

  it("creates constrained review scope and manual catalog singleton state", async () => {
    const { database } = await createFileDatabase();

    expect(database.prepare("SELECT * FROM review_scope").all()).toMatchObject([{
      id: 1,
      preset: "last7",
      custom_start_date: null,
      custom_end_date: null,
      timezone: "Asia/Shanghai",
      revision: 1,
    }]);
    expect(database.prepare("SELECT * FROM manual_product_catalog_state").all()).toMatchObject([{
      id: 1,
      revision: 1,
      last_import_at: null,
    }]);
    expect(database.prepare("SELECT COUNT(*) AS value FROM review_scope").get()).toEqual({ value: 1 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM manual_product_catalog_state").get()).toEqual({ value: 1 });
    expect((database.pragma("table_info('review_scope')") as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "id", "preset", "custom_start_date", "custom_end_date", "timezone", "revision", "updated_at",
    ]);
    expect((database.pragma("table_info('manual_product_catalog_state')") as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "id", "revision", "last_import_at", "updated_at",
    ]);

    expect(() => database.prepare(`
      INSERT INTO review_scope(id, preset, timezone, revision, updated_at)
      VALUES (2, 'last7', 'Asia/Shanghai', 1, '2026-07-14T00:00:00.000Z')
    `).run()).toThrow();
    expect(() => database.prepare("UPDATE review_scope SET preset = 'invalid' WHERE id = 1").run()).toThrow();
    expect(() => database.prepare("UPDATE review_scope SET preset = 'custom' WHERE id = 1").run()).toThrow();
    expect(() => database.prepare("UPDATE review_scope SET custom_start_date = '2026-07-01', custom_end_date = '2026-07-14' WHERE id = 1").run()).toThrow();
    expect(() => database.prepare("UPDATE review_scope SET timezone = 'UTC' WHERE id = 1").run()).toThrow();
    expect(() => database.prepare("UPDATE review_scope SET revision = 0 WHERE id = 1").run()).toThrow();
    expect(database.prepare(`
      UPDATE review_scope
      SET preset = 'custom', custom_start_date = '2026-07-01', custom_end_date = '2026-07-14'
      WHERE id = 1
    `).run().changes).toBe(1);

    expect(() => database.prepare(`
      INSERT INTO manual_product_catalog_state(id, revision, updated_at)
      VALUES (2, 1, '2026-07-14T00:00:00.000Z')
    `).run()).toThrow();
    expect(() => database.prepare("UPDATE manual_product_catalog_state SET revision = 0 WHERE id = 1").run()).toThrow();
    database.close();
  });

  it("enforces manual product identity rules and membership lifecycle", async () => {
    const { database } = await createFileDatabase();
    const insertProduct = database.prepare(`
      INSERT INTO manual_products(id, item_id, product_title, normalized_title, created_at, updated_at)
      VALUES (?, ?, ?, ?, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')
    `);

    insertProduct.run("product-1", "item-1", "Headphones", "headphones");
    expect(() => insertProduct.run("duplicate-item", "item-1", "Other", "other")).toThrow();
    insertProduct.run("product-2", "item-2", "Headphones bundle", "headphones");
    insertProduct.run("manual-only", null, "Manual title", "manual title");
    expect(() => insertProduct.run("duplicate-manual-title", null, "Manual title 2", "manual title")).toThrow();
    expect(() => insertProduct.run("empty-title", "item-3", "   ", "empty title")).toThrow();
    expect(() => insertProduct.run("empty-normalized", "item-4", "Valid", "   ")).toThrow();

    const productColumns = database.pragma("table_info('manual_products')") as Array<{ name: string }>;
    expect(productColumns.map((column) => column.name)).toEqual([
      "id", "item_id", "product_title", "normalized_title", "created_at", "updated_at", "last_matched_at",
    ]);
    const productIndexes = database.pragma("index_list('manual_products')") as Array<{ name: string; unique: number; partial: number }>;
    expect(productIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idx_manual_products_item_id", unique: 1, partial: 1 }),
      expect.objectContaining({ name: "idx_manual_products_unidentified_title", unique: 1, partial: 1 }),
    ]));

    database.prepare(`
      INSERT INTO manual_product_memberships(product_id, source, created_at)
      VALUES ('manual-only', 'manual', '2026-07-14T00:00:00.000Z'),
             ('manual-only', 'excel', '2026-07-14T00:00:00.000Z')
    `).run();
    expect((database.pragma("table_info('manual_product_memberships')") as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "product_id", "source", "created_at",
    ]);
    expect(() => database.prepare(`
      INSERT INTO manual_product_memberships(product_id, source, created_at)
      VALUES ('manual-only', 'manual', '2026-07-14T00:00:00.000Z')
    `).run()).toThrow();
    expect(() => database.prepare(`
      INSERT INTO manual_product_memberships(product_id, source, created_at)
      VALUES ('manual-only', 'other', '2026-07-14T00:00:00.000Z')
    `).run()).toThrow();
    expect(() => database.prepare(`
      INSERT INTO manual_product_memberships(product_id, source, created_at)
      VALUES ('missing-product', 'manual', '2026-07-14T00:00:00.000Z')
    `).run()).toThrow();
    database.prepare("DELETE FROM manual_products WHERE id = 'manual-only'").run();
    expect(database.prepare("SELECT * FROM manual_product_memberships WHERE product_id = 'manual-only'").all()).toEqual([]);
    database.close();
  });

  it("creates durable action locks and tombstones with cleanup indexes", async () => {
    const { database } = await createFileDatabase();
    database.prepare(`
      INSERT INTO review_action_locks(store_id, source_key, action_kind, created_at, updated_at)
      VALUES ('primary', 'source-1', 'reply', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')
    `).run();
    expect(database.prepare("SELECT * FROM review_action_locks").get()).toMatchObject({
      store_id: "primary",
      source_key: "source-1",
      action_kind: "reply",
      lock_version: 1,
    });
    expect((database.pragma("table_info('review_action_locks')") as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "store_id", "source_key", "action_kind", "lock_version", "created_at", "updated_at",
    ]);
    expect(() => database.prepare(`
      INSERT INTO review_action_locks(store_id, source_key, action_kind, created_at, updated_at)
      VALUES ('primary', 'source-1', 'complaint', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')
    `).run()).toThrow();
    expect(() => database.prepare(`
      INSERT INTO review_action_locks(store_id, source_key, action_kind, created_at, updated_at)
      VALUES ('primary', 'invalid-kind', 'invalid', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')
    `).run()).toThrow();
    expect(() => database.prepare(`
      INSERT INTO review_action_locks(store_id, source_key, action_kind, lock_version, created_at, updated_at)
      VALUES ('primary', 'invalid-version', 'manual_hold', 0, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')
    `).run()).toThrow();

    const lockIndexes = database.pragma("index_list('review_action_locks')") as Array<{ name: string }>;
    expect(lockIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idx_review_action_locks_action_kind" }),
      expect.objectContaining({ name: "idx_review_action_locks_updated_at" }),
    ]));

    database.prepare(`
      INSERT INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at)
      VALUES ('primary', 'source-1', 'reply_sent', '2026-07-14T00:00:00.000Z')
    `).run();
    expect((database.pragma("table_info('review_action_tombstones')") as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "store_id", "source_key", "terminal_action", "completed_at",
    ]);
    expect(() => database.prepare(`
      INSERT INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at)
      VALUES ('primary', 'source-1', 'reply_sent', '2026-07-14T00:00:00.000Z')
    `).run()).toThrow();
    const tombstoneIndexes = database.pragma("index_list('review_action_tombstones')") as Array<{ name: string }>;
    expect(tombstoneIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idx_review_action_tombstones_completed_at" }),
    ]));
    database.close();
  });

  it("adds manual matching, review scope snapshot, and action lock columns", async () => {
    const { database } = await createFileDatabase();
    const draftColumns = database.pragma("table_info('reply_drafts')") as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    expect(draftColumns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "item_id", notnull: 0 }),
      expect.objectContaining({ name: "review_phase", notnull: 1, dflt_value: "'initial'" }),
      expect.objectContaining({ name: "manual_product_id", notnull: 0 }),
      expect.objectContaining({ name: "manual_hold_reason", notnull: 0 }),
      expect.objectContaining({ name: "manual_catalog_revision", notnull: 0 }),
      expect.objectContaining({ name: "manual_match_kind", notnull: 0 }),
      expect.objectContaining({ name: "manual_hold_last_seen_at", notnull: 0 }),
      expect.objectContaining({ name: "manual_hold_absent_scans", notnull: 1, dflt_value: "0" }),
    ]));
    const automationColumns = database.pragma("table_info('automation_runs')") as Array<{ name: string; notnull: number }>;
    expect(automationColumns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "scope_preset", notnull: 0 }),
      expect.objectContaining({ name: "scope_start_date", notnull: 0 }),
      expect.objectContaining({ name: "scope_end_date", notnull: 0 }),
      expect.objectContaining({ name: "scope_revision", notnull: 0 }),
      expect.objectContaining({ name: "scope_timezone", notnull: 0 }),
      expect.objectContaining({ name: "manual_count", notnull: 1 }),
    ]));
    expect(database.pragma("table_info('reply_attempts')")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "action_lock_version", notnull: 0 }),
    ]));

    database.prepare(`
      INSERT INTO manual_products(id, item_id, product_title, normalized_title, created_at, updated_at)
      VALUES ('manual-reference', NULL, 'Reference product', 'reference product', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')
    `).run();
    const insertDraft = database.prepare(`
      INSERT INTO reply_drafts(
        id, source_key, review_text, product_title, sentiment_label, state,
        discovered_at, updated_at, manual_product_id, review_phase, manual_hold_absent_scans
      ) VALUES (?, ?, 'Review', 'Product', 'unknown', 'discovered',
        '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z', ?, ?, ?)
    `);
    insertDraft.run("draft-1", "source-1", "manual-reference", "initial", 0);
    expect(() => insertDraft.run("bad-phase", "bad-phase", null, "later", 0)).toThrow();
    expect(() => insertDraft.run("bad-scan-count", "bad-scan-count", null, "followup", -1)).toThrow();
    database.prepare("DELETE FROM manual_products WHERE id = 'manual-reference'").run();
    expect(database.prepare("SELECT manual_product_id, review_phase, manual_hold_absent_scans FROM reply_drafts WHERE id = 'draft-1'").get()).toEqual({
      manual_product_id: null,
      review_phase: "initial",
      manual_hold_absent_scans: 0,
    });
    expect(database.pragma("foreign_key_list('reply_drafts')")).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "manual_products", from: "manual_product_id", to: "id", on_delete: "SET NULL" }),
    ]));
    database.close();
  });

  it("rejects fractional values in versioned integer columns", async () => {
    const { database } = await createFileDatabase();
    const now = "2026-07-14T00:00:00.000Z";

    expect(() => database.prepare("UPDATE review_scope SET revision = 1.5 WHERE id = 1").run()).toThrow();
    database.prepare("UPDATE review_scope SET revision = 2 WHERE id = 1").run();
    expect(() => database.prepare("UPDATE manual_product_catalog_state SET revision = 1.5 WHERE id = 1").run()).toThrow();
    database.prepare("UPDATE manual_product_catalog_state SET revision = 2 WHERE id = 1").run();

    expect(() => database.prepare(`
      INSERT INTO review_action_locks(
        store_id, source_key, action_kind, lock_version, created_at, updated_at
      ) VALUES ('primary', 'fractional-lock', 'reply', 1.5, ?, ?)
    `).run(now, now)).toThrow();
    database.prepare(`
      INSERT INTO review_action_locks(
        store_id, source_key, action_kind, lock_version, created_at, updated_at
      ) VALUES ('primary', 'integer-lock', 'reply', 2, ?, ?)
    `).run(now, now);

    database.prepare(`
      INSERT INTO reply_drafts(
        id, source_key, review_text, product_title, sentiment_label, state, discovered_at, updated_at
      ) VALUES ('strict-integer-draft', 'strict-integer-source', 'Review', 'Product', 'unknown', 'discovered', ?, ?)
    `).run(now, now);
    expect(() => database.prepare(`
      UPDATE reply_drafts SET manual_catalog_revision = 1.5 WHERE id = 'strict-integer-draft'
    `).run()).toThrow();
    expect(() => database.prepare(`
      UPDATE reply_drafts SET manual_catalog_revision = 0 WHERE id = 'strict-integer-draft'
    `).run()).toThrow();
    expect(() => database.prepare(`
      UPDATE reply_drafts SET manual_hold_absent_scans = 0.5 WHERE id = 'strict-integer-draft'
    `).run()).toThrow();
    database.prepare(`
      UPDATE reply_drafts
      SET manual_catalog_revision = 2, manual_hold_absent_scans = 1
      WHERE id = 'strict-integer-draft'
    `).run();

    expect(() => database.prepare(`
      INSERT INTO automation_runs(id, trigger_type, state, started_at, scope_revision)
      VALUES ('fractional-run', 'manual', 'completed', ?, 1.5)
    `).run(now)).toThrow();
    expect(() => database.prepare(`
      INSERT INTO automation_runs(id, trigger_type, state, started_at, scope_revision)
      VALUES ('zero-revision-run', 'manual', 'completed', ?, 0)
    `).run(now)).toThrow();
    database.prepare(`
      INSERT INTO automation_runs(id, trigger_type, state, started_at, scope_revision)
      VALUES ('integer-run', 'manual', 'completed', ?, NULL)
    `).run(now);
    database.prepare("UPDATE automation_runs SET scope_revision = 2 WHERE id = 'integer-run'").run();

    expect(() => database.prepare(`
      INSERT INTO reply_attempts(id, source_key, state, created_at, updated_at, action_lock_version)
      VALUES ('fractional-attempt', 'fractional-attempt-source', 'failed', ?, ?, 1.5)
    `).run(now, now)).toThrow();
    expect(() => database.prepare(`
      INSERT INTO reply_attempts(id, source_key, state, created_at, updated_at, action_lock_version)
      VALUES ('zero-version-attempt', 'zero-version-attempt-source', 'failed', ?, ?, 0)
    `).run(now, now)).toThrow();
    database.prepare(`
      INSERT INTO reply_attempts(id, source_key, state, created_at, updated_at, action_lock_version)
      VALUES ('integer-attempt', 'integer-attempt-source', 'failed', ?, ?, NULL)
    `).run(now, now);
    database.prepare("UPDATE reply_attempts SET action_lock_version = 2 WHERE id = 'integer-attempt'").run();

    expect(database.prepare("SELECT revision FROM review_scope WHERE id = 1").get()).toEqual({ revision: 2 });
    expect(database.prepare("SELECT revision FROM manual_product_catalog_state WHERE id = 1").get()).toEqual({ revision: 2 });
    expect(database.prepare("SELECT lock_version FROM review_action_locks WHERE source_key = 'integer-lock'").get()).toEqual({ lock_version: 2 });
    expect(database.prepare(`
      SELECT manual_catalog_revision, manual_hold_absent_scans
      FROM reply_drafts WHERE id = 'strict-integer-draft'
    `).get()).toEqual({ manual_catalog_revision: 2, manual_hold_absent_scans: 1 });
    expect(database.prepare("SELECT scope_revision FROM automation_runs WHERE id = 'integer-run'").get()).toEqual({ scope_revision: 2 });
    expect(database.prepare("SELECT action_lock_version FROM reply_attempts WHERE id = 'integer-attempt'").get()).toEqual({ action_lock_version: 2 });
    database.close();
  });

  it("upgrades version 8 attempts into reply locks and terminal tombstones idempotently", () => {
    const database = createVersion8Database();
    const now = "2026-07-14T00:00:00.000Z";
    const states = ["sent", "pending", "submitting", "submission_uncertain", "failed"] as const;
    database.prepare(`
      INSERT INTO template_sources(
        library, url, app_token, table_id, status, created_at, updated_at
      ) VALUES ('good', 'https://example.test/templates', 'app', 'table', 'configured', ?, ?)
    `).run(now, now);
    database.prepare(`
      INSERT INTO template_versions(
        id, library, content_hash, source_record_count, category_count,
        reply_count, warnings_json, created_at, activated_at
      ) VALUES (7, 'good', 'legacy-template', 1, 1, 1, '[]', ?, ?)
    `).run(now, now);
    const insertDraft = database.prepare(`
      INSERT INTO reply_drafts(
        id, source_key, review_text, product_title, sentiment_label, state,
        discovered_at, updated_at, template_version_id
      ) VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?, ?)
    `);
    const insertAttempt = database.prepare(`
      INSERT INTO reply_attempts(
        id, reply_draft_id, source_key, state, evidence, created_at, updated_at, submitted_at, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const state of states) {
      const sourceKey = `legacy:${state}`;
      insertDraft.run(`draft-${state}`, sourceKey, `review-${state}`, `product-${state}`, state, now, now, state === "sent" ? 7 : null);
      insertAttempt.run(`attempt-${state}`, `draft-${state}`, sourceKey, state, `evidence-${state}`, now, now, state === "pending" ? null : now, state === "sent" ? now : null);
    }

    runMigrations(database);
    runMigrations(database);

    expect(database.prepare("SELECT store_id, source_key, terminal_action, completed_at FROM review_action_tombstones").all()).toEqual([{
      store_id: "primary",
      source_key: "legacy:sent",
      terminal_action: "reply_sent",
      completed_at: now,
    }]);
    expect(database.prepare("SELECT store_id, source_key, action_kind, lock_version FROM review_action_locks ORDER BY source_key").all()).toEqual([
      { store_id: "primary", source_key: "legacy:pending", action_kind: "reply", lock_version: 1 },
      { store_id: "primary", source_key: "legacy:submission_uncertain", action_kind: "reply", lock_version: 1 },
      { store_id: "primary", source_key: "legacy:submitting", action_kind: "reply", lock_version: 1 },
    ]);
    expect(database.prepare(`
      SELECT source_key, state, action_lock_version
      FROM reply_attempts
      WHERE state IN ('pending', 'submitting', 'submission_uncertain')
      ORDER BY source_key
    `).all()).toEqual([
      { source_key: "legacy:pending", state: "pending", action_lock_version: 1 },
      { source_key: "legacy:submission_uncertain", state: "submission_uncertain", action_lock_version: 1 },
      { source_key: "legacy:submitting", state: "submitting", action_lock_version: 1 },
    ]);
    expect(database.prepare("SELECT state, action_lock_version FROM reply_attempts WHERE source_key = 'legacy:sent'").get()).toEqual({
      state: "sent",
      action_lock_version: null,
    });
    expect(database.prepare("SELECT state, action_lock_version FROM reply_attempts WHERE source_key = 'legacy:failed'").get()).toEqual({
      state: "failed",
      action_lock_version: null,
    });
    expect(database.prepare("SELECT COUNT(*) AS value FROM review_action_locks WHERE source_key = 'legacy:failed'").get()).toEqual({ value: 0 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM review_action_tombstones WHERE source_key = 'legacy:failed'").get()).toEqual({ value: 0 });
    expect(database.prepare("SELECT id, review_text, product_title FROM reply_drafts WHERE id = 'draft-submission_uncertain'").get()).toEqual({
      id: "draft-submission_uncertain",
      review_text: "review-submission_uncertain",
      product_title: "product-submission_uncertain",
    });
    expect(database.prepare("SELECT template_version_id FROM reply_drafts WHERE id = 'draft-sent'").get()).toEqual({ template_version_id: 7 });
    expect(database.prepare(`
      SELECT evidence, created_at, updated_at, submitted_at, verified_at
      FROM reply_attempts
      WHERE id = 'attempt-sent'
    `).get()).toEqual({
      evidence: "evidence-sent",
      created_at: now,
      updated_at: now,
      submitted_at: now,
      verified_at: now,
    });
    expect(database.prepare("SELECT COUNT(*) AS value FROM reply_drafts").get()).toEqual({ value: states.length });
    expect(database.prepare("SELECT COUNT(*) AS value FROM schema_migrations WHERE version = 9").get()).toEqual({ value: 1 });
    expect(database.pragma("foreign_key_list('reply_attempts')")).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "reply_drafts", from: "reply_draft_id", to: "id", on_delete: "SET NULL" }),
    ]));
    expect(database.pragma("foreign_key_list('reply_drafts')")).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "template_versions", from: "template_version_id", to: "id", on_delete: "SET NULL" }),
    ]));
    database.prepare("DELETE FROM reply_drafts WHERE id = 'draft-failed'").run();
    expect(database.prepare("SELECT reply_draft_id FROM reply_attempts WHERE id = 'attempt-failed'").get()).toEqual({ reply_draft_id: null });
    database.close();
  });

  it("rolls back all version 9 changes when recording the migration version fails", () => {
    const database = createVersion8Database();
    const now = "2026-07-14T00:00:00.000Z";
    database.prepare(`
      INSERT INTO reply_drafts(
        id, source_key, review_text, product_title, sentiment_label, state, discovered_at, updated_at
      ) VALUES ('rollback-draft', 'rollback-source', 'Review', 'Product', 'unknown', 'discovered', ?, ?)
    `).run(now, now);
    database.prepare(`
      INSERT INTO reply_attempts(
        id, reply_draft_id, source_key, state, evidence, created_at, updated_at
      ) VALUES ('rollback-attempt', 'rollback-draft', 'rollback-source', 'pending', 'preserve-me', ?, ?)
    `).run(now, now);
    database.exec(`
      CREATE TRIGGER abort_version_9_record
      BEFORE INSERT ON schema_migrations
      WHEN NEW.version = 9
      BEGIN
        SELECT RAISE(ABORT, 'abort version 9 record');
      END;
    `);
    expect(database.prepare("SELECT MAX(version) AS value FROM schema_migrations").get()).toEqual({ value: 8 });

    expect(() => runMigrations(database)).toThrow(/abort version 9 record/);

    expect(database.prepare("SELECT COUNT(*) AS value FROM schema_migrations WHERE version = 9").get()).toEqual({ value: 0 });
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'review_scope', 'manual_product_catalog_state', 'manual_products',
        'manual_product_memberships', 'review_action_locks', 'review_action_tombstones'
      )
      ORDER BY name
    `).all()).toEqual([]);
    const rolledBackDraftColumns = (database.pragma("table_info('reply_drafts')") as Array<{ name: string }>).map((column) => column.name);
    expect(rolledBackDraftColumns.filter((name) => [
      "item_id", "review_phase", "manual_product_id", "manual_hold_reason",
      "manual_catalog_revision", "manual_match_kind", "manual_hold_last_seen_at",
      "manual_hold_absent_scans",
    ].includes(name))).toEqual([]);
    const rolledBackRunColumns = (database.pragma("table_info('automation_runs')") as Array<{ name: string }>).map((column) => column.name);
    expect(rolledBackRunColumns.filter((name) => [
      "scope_preset", "scope_start_date", "scope_end_date", "scope_revision", "scope_timezone",
    ].includes(name))).toEqual([]);
    expect((database.pragma("table_info('reply_attempts')") as Array<{ name: string }>).map((column) => column.name)).not.toContain("action_lock_version");
    expect(database.prepare("SELECT state, evidence FROM reply_attempts WHERE id = 'rollback-attempt'").get()).toEqual({
      state: "pending",
      evidence: "preserve-me",
    });
    expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(database.pragma("foreign_key_check")).toEqual([]);

    database.exec("DROP TRIGGER abort_version_9_record");
    runMigrations(database);

    expect(database.prepare("SELECT COUNT(*) AS value FROM schema_migrations WHERE version = 9").get()).toEqual({ value: 1 });
    expect(database.prepare("SELECT action_kind, lock_version FROM review_action_locks WHERE source_key = 'rollback-source'").get()).toEqual({
      action_kind: "reply",
      lock_version: 1,
    });
    expect(database.prepare("SELECT action_lock_version FROM reply_attempts WHERE id = 'rollback-attempt'").get()).toEqual({
      action_lock_version: 1,
    });
    expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("runs migrations idempotently and persists settings across restarts", async () => {
    const first = await createFileDatabase();
    runMigrations(first.database);
    const settings = new SettingsRepository(first.database);
    settings.set("feishuAppId", "cli_demo");
    first.database.close();

    const reopened = openDatabase(first.path);
    runMigrations(reopened);
    expect(new SettingsRepository(reopened).get("feishuAppId")).toBe("cli_demo");
    expect(reopened.pragma("foreign_keys", { simple: true })).toBe(1);
    reopened.close();
  });

  it("atomically activates a validated template version", async () => {
    const { database } = await createFileDatabase();
    const repository = new TemplateRepository(database);
    repository.saveSource({ library: "good", url: "https://demo.feishu.cn/base/app?table=tbl1", appToken: "app", tableId: "tbl1", viewId: null });

    const activated = repository.activateVersion({
      library: "good",
      contentHash: "hash-v1",
      sourceRecordCount: 2,
      templates: [template("音质音效类", "音质话术"), template("通用整体好评类", "通用话术")],
      warnings: [],
    });

    expect(activated.changed).toBe(true);
    expect(repository.getActiveCategories("good").map((item) => item.category)).toEqual(["音质音效类", "通用整体好评类"]);
    database.close();
  });

  it("rolls back a failed version and preserves the previous active version", async () => {
    const { database } = await createFileDatabase();
    const repository = new TemplateRepository(database);
    repository.saveSource({ library: "good", url: "https://demo.feishu.cn/base/app?table=tbl1", appToken: "app", tableId: "tbl1", viewId: null });
    repository.activateVersion({
      library: "good",
      contentHash: "stable",
      sourceRecordCount: 1,
      templates: [template("通用整体好评类", "旧话术")],
      warnings: [],
    });

    expect(() => repository.activateVersion({
      library: "good",
      contentHash: "broken",
      sourceRecordCount: 2,
      templates: [template("重复分类", "第一条"), template("重复分类", "第二条")],
      warnings: [],
    })).toThrow();

    expect(repository.getActiveCategories("good")).toMatchObject([{ category: "通用整体好评类", replies: [{ text: "旧话术" }] }]);
    database.close();
  });

  it("does not create a duplicate version for unchanged content", async () => {
    const { database } = await createFileDatabase();
    const repository = new TemplateRepository(database);
    repository.saveSource({ library: "bad", url: "https://demo.feishu.cn/base/app?table=tbl2", appToken: "app", tableId: "tbl2", viewId: null });
    const input = {
      library: "bad" as const,
      contentHash: "same-content",
      sourceRecordCount: 1,
      templates: [{ ...template("通用差评类", "通用差评"), primaryCategory: "其他问题" }],
      warnings: [],
    };

    expect(repository.activateVersion(input).changed).toBe(true);
    expect(repository.activateVersion(input).changed).toBe(false);
    expect(repository.listVersions("bad")).toHaveLength(1);
    database.close();
  });

  it("keeps the active version plus only the nine newest historical versions", async () => {
    const { database } = await createFileDatabase();
    const repository = new TemplateRepository(database);
    repository.saveSource({ library: "good", url: "https://demo.feishu.cn/base/app?table=tbl1", appToken: "app", tableId: "tbl1", viewId: null });

    for (let index = 1; index <= 12; index += 1) {
      repository.activateVersion({
        library: "good",
        contentHash: `hash-${index}`,
        sourceRecordCount: 1,
        templates: [template("通用整体好评类", `话术-${index}`)],
        warnings: [],
      });
    }

    const versions = repository.listVersions("good");
    expect(versions).toHaveLength(10);
    expect(versions[0]?.contentHash).toBe("hash-12");
    expect(versions.at(-1)?.contentHash).toBe("hash-3");
    database.close();
  });

  it("persists one draft record per Tmall source key across restarts", async () => {
    const first = await createFileDatabase();
    const repository = new ReplyRepository(first.database);
    const snapshot = {
      sourceKey: "tmall:1001:stable",
      orderId: "1001",
      review: "戴着有点夹耳朵",
      product: "漫步者 X1 EVO 真无线蓝牙耳机",
      reviewedAt: "2026-07-13 11:45",
      sentimentLabel: "positive" as const,
      itemId: "900719925474099312345",
      reviewPhase: "followup" as const,
    };

    const discovered = repository.discover(snapshot);
    const duplicate = repository.discover(snapshot);
    expect(discovered.created).toBe(true);
    expect(duplicate).toEqual({ id: discovered.id, created: false });
    first.database.close();

    const reopened = openDatabase(first.path);
    runMigrations(reopened);
    const persisted = new ReplyRepository(reopened).get(discovered.id);
    expect(persisted).toMatchObject({ sourceKey: snapshot.sourceKey, review: snapshot.review, itemId: snapshot.itemId, reviewPhase: snapshot.reviewPhase, state: "discovered" });
    reopened.close();
  });

  it("atomically backfills duplicate snapshot identity and fails closed on identity conflicts", async () => {
    const { database } = await createFileDatabase();
    const repository = new ReplyRepository(database);
    const original = repository.discover({
      sourceKey: "tmall:identity-backfill",
      orderId: "1001",
      review: "很好",
      product: "旧标题",
      reviewedAt: null,
      sentimentLabel: "positive",
      itemId: null,
      reviewPhase: "initial",
    });

    expect(repository.discover({
      sourceKey: "tmall:identity-backfill",
      orderId: "1001",
      review: "很好",
      product: "新标题",
      reviewedAt: null,
      sentimentLabel: "positive",
      itemId: "960227744800",
      reviewPhase: "initial",
    })).toEqual({ id: original.id, created: false });
    expect(repository.get(original.id)).toMatchObject({
      product: "旧标题",
      itemId: "960227744800",
      reviewPhase: "initial",
    });

    repository.discover({
      sourceKey: "tmall:identity-backfill",
      orderId: "1001",
      review: "很好",
      product: "又一个标题",
      reviewedAt: null,
      sentimentLabel: "positive",
      itemId: null,
      reviewPhase: "initial",
    });
    expect(repository.get(original.id)).toMatchObject({ itemId: "960227744800", reviewPhase: "initial" });

    expect(() => repository.discover({
      sourceKey: "tmall:identity-backfill",
      orderId: "1001",
      review: "很好",
      product: "阶段冲突标题",
      reviewedAt: null,
      sentimentLabel: "positive",
      itemId: "960227744800",
      reviewPhase: "followup",
    })).toThrow("评价阶段冲突");
    expect(repository.get(original.id)).toMatchObject({ itemId: "960227744800", reviewPhase: "initial" });

    expect(() => repository.discover({
      sourceKey: "tmall:identity-backfill",
      orderId: "1001",
      review: "很好",
      product: "冲突标题",
      reviewedAt: null,
      sentimentLabel: "positive",
      itemId: "980913413146",
      reviewPhase: "initial",
    })).toThrow("商品ID冲突");
    expect(repository.get(original.id)).toMatchObject({ itemId: "960227744800", reviewPhase: "initial" });
    database.close();
  });

  it("prunes on old-version reactivation while keeping checkpoint-protected versions as explicit exceptions", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const templates = new TemplateRepository(database);
    const replies = new ReplyRepository(database);
    templates.saveSource({
      library: "good", url: "https://demo.feishu.cn/base/app?table=tbl1",
      appToken: "app", tableId: "tbl1", viewId: null,
    });
    const frozenText = "感谢您对音质的认可！";
    const frozen = templates.activateVersion({
      library: "good", contentHash: "reactivate-v1", sourceRecordCount: 1,
      templates: [template("音质音效类", frozenText)], warnings: [],
    });
    const { id } = replies.discover({
      sourceKey: "tmall:reactivated-version-checkpoint", orderId: null, review: "音质很好",
      product: "漫步者 X1", reviewedAt: null, sentimentLabel: "positive",
      itemId: null, reviewPhase: "initial",
    });
    replies.saveAiCheckpoint(id, {
      library: "good", primaryCategory: "", category: "音质音效类",
      confidence: 0.96, reason: "明确称赞音质", needsAttention: false,
      templateVersionId: frozen.versionId, templateSequence: 1, originalTemplate: frozenText,
    });
    replies.recordAiRetryRoundFailure(id, {
      failedStage: "rewrite", errorKind: "timeout",
      nextRetryAt: new Date("2026-07-16T08:05:00.000Z"),
    });
    for (let version = 2; version <= 11; version += 1) {
      templates.activateVersion({
        library: "good", contentHash: `reactivate-v${version}`, sourceRecordCount: 1,
        templates: [template("音质音效类", `新版话术-${version}`)], warnings: [],
      });
    }
    expect(templates.listVersions("good")).toHaveLength(11);

    expect(templates.activateVersion({
      library: "good", contentHash: "reactivate-v1", sourceRecordCount: 1,
      templates: [template("音质音效类", frozenText)], warnings: [],
    })).toEqual({ versionId: frozen.versionId, changed: false });
    expect(templates.listVersions("good")).toHaveLength(10);
    expect(templates.getActiveVersionId("good")).toBe(frozen.versionId);

    const newest = templates.activateVersion({
      library: "good", contentHash: "reactivate-v12", sourceRecordCount: 1,
      templates: [template("音质音效类", "新版话术-12")], warnings: [],
    });
    const versions = templates.listVersions("good");
    expect(versions.filter((version) => version.id !== frozen.versionId)).toHaveLength(10);
    expect(versions.some((version) => version.id === frozen.versionId)).toBe(true);
    expect(templates.getActiveVersionId("good")).toBe(newest.versionId);
    database.close();
  });

  it.each(["read_only_ready", "sent"] as const)(
    "never reuses a %s initial-phase draft when the duplicate source key is rediscovered as follow-up",
    async (state) => {
      const { database } = await createFileDatabase();
      const repository = new ReplyRepository(database);
      const original = repository.discover({
        sourceKey: `tmall:phase-immutable:${state}`,
        orderId: "1002",
        review: "同一正文",
        product: "漫步者耳机",
        reviewedAt: "2026-07-14 09:10",
        sentimentLabel: "positive",
        itemId: "960227744800",
        reviewPhase: "initial",
      });
      repository.complete(original.id, {
        finalReply: "初评专用回复",
        productAdjusted: false,
        needsAttention: false,
        notes: "",
        attentionReasons: [],
      });
      if (state === "sent") {
        const attempts = new ReplyAttemptRepository(database);
        const attempt = attempts.prepare(original.id, `tmall:phase-immutable:${state}`).attempt;
        attempts.markSubmitting(attempt.id);
        attempts.markSent(attempt.id, "平台显示已回复");
      }

      expect(() => repository.discover({
        sourceKey: `tmall:phase-immutable:${state}`,
        orderId: "1002",
        review: "同一正文",
        product: "漫步者耳机",
        reviewedAt: "2026-07-14 09:10",
        sentimentLabel: "positive",
        itemId: "960227744800",
        reviewPhase: "followup",
      })).toThrow("评价阶段冲突");
      expect(repository.get(original.id)).toMatchObject({
        reviewPhase: "initial",
        state,
        finalReply: "初评专用回复",
      });
      database.close();
    },
  );

  it("never resets a manual hold or a draft protected by an action lock or terminal tombstone", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const gate = new ReviewActionGate(database);
    const createDraft = (sourceKey: string) => {
      const { id } = replies.discover({
        sourceKey,
        orderId: sourceKey,
        review: "评价内容",
        product: "漫步者耳机",
        reviewedAt: null,
        sentimentLabel: "negative",
        itemId: null,
        reviewPhase: "initial",
      });
      return id;
    };

    const heldId = createDraft("tmall:reset-held");
    replies.markManualProductHold(heldId, {
      storeId: "primary",
      manualProductId: null,
      catalogRevision: 1,
      matchKind: "identity_untrusted",
      reason: "商品身份无法安全识别",
    });
    expect(replies.resetForReprocess(heldId)).toBe(false);
    expect(replies.get(heldId)?.state).toBe("manual_product_hold");

    const complaintId = createDraft("tmall:reset-complaint");
    gate.acquire("primary", "tmall:reset-complaint", "complaint");
    expect(replies.resetForReprocess(complaintId)).toBe(false);
    expect(replies.get(complaintId)?.state).toBe("discovered");

    const terminalId = createDraft("tmall:reset-terminal");
    const complaint = gate.acquire("primary", "tmall:reset-terminal", "complaint");
    gate.complete("primary", "tmall:reset-terminal", "complaint", complaint.lockVersion, "complaint_upheld");
    expect(replies.resetForReprocess(terminalId)).toBe(false);
    expect(replies.get(terminalId)?.state).toBe("discovered");
    database.close();
  });

  it("atomically saves catalog decisions without changing content and rejects protected drafts", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const gate = new ReviewActionGate(database);
    const createDraft = (sourceKey: string) => replies.discover({
      sourceKey,
      orderId: sourceKey,
      review: "音质很好",
      product: "漫步者耳机",
      reviewedAt: null,
      sentimentLabel: "positive",
      itemId: null,
      reviewPhase: "initial",
    }).id;
    const normalId = createDraft("tmall:decision-normal");
    const before = replies.get(normalId)!;

    const saved = replies.saveManualProductDecision(normalId, {
      storeId: "primary",
      manualProductId: null,
      catalogRevision: 7,
      matchKind: "not_matched",
    });

    expect(saved).toMatchObject({
      state: before.state,
      review: before.review,
      finalReply: before.finalReply,
      manualProductId: null,
      manualCatalogRevision: 7,
      manualMatchKind: "not_matched",
    });

    for (const actionKind of ["manual_hold", "reply", "complaint"] as const) {
      const sourceKey = `tmall:decision-${actionKind}`;
      const id = createDraft(sourceKey);
      gate.acquire("primary", sourceKey, actionKind);
      expect(() => replies.saveManualProductDecision(id, {
        storeId: "primary", manualProductId: null, catalogRevision: 8, matchKind: "not_matched",
      })).toThrow(ReviewActionConflictError);
      expect(replies.get(id)?.manualCatalogRevision).toBeNull();
    }

    const terminalSourceKey = "tmall:decision-terminal";
    const terminalId = createDraft(terminalSourceKey);
    const terminalLock = gate.acquire("primary", terminalSourceKey, "complaint");
    gate.complete("primary", terminalSourceKey, "complaint", terminalLock.lockVersion, "complaint_upheld");
    expect(() => replies.saveManualProductDecision(terminalId, {
      storeId: "primary", manualProductId: null, catalogRevision: 9, matchKind: "not_matched",
    })).toThrow(ReviewActionConflictError);
    expect(replies.get(terminalId)?.manualCatalogRevision).toBeNull();

    const protectedId = createDraft("tmall:decision-protected-state");
    database.prepare("UPDATE reply_drafts SET state = 'submission_uncertain' WHERE id = ?").run(protectedId);
    expect(() => replies.saveManualProductDecision(protectedId, {
      storeId: "primary", manualProductId: null, catalogRevision: 10, matchKind: "not_matched",
    })).toThrow(ReviewActionConflictError);
    expect(replies.get(protectedId)?.manualCatalogRevision).toBeNull();
    database.close();
  });

  it("nulls stale manual product foreign keys inside decision and hold transactions", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const createDraft = (sourceKey: string) => replies.discover({
      sourceKey, orderId: sourceKey, review: "评价", product: "商品", reviewedAt: null,
      sentimentLabel: "unknown", itemId: null, reviewPhase: "initial",
    }).id;

    const continuedId = createDraft("tmall:stale-continue");
    expect(() => replies.saveManualProductDecision(continuedId, {
      storeId: "primary", manualProductId: "already-deleted", catalogRevision: 3, matchKind: "item_id",
    })).not.toThrow();
    expect(replies.get(continuedId)).toMatchObject({ manualProductId: null, manualCatalogRevision: 3, manualMatchKind: "item_id" });

    const heldId = createDraft("tmall:stale-hold");
    expect(() => replies.markManualProductHold(heldId, {
      storeId: "primary", manualProductId: "already-deleted", catalogRevision: 4,
      matchKind: "item_id", reason: "冻结名单命中",
    })).not.toThrow();
    expect(replies.get(heldId)).toMatchObject({ state: "manual_product_hold", manualProductId: null, manualCatalogRevision: 4 });
    database.close();
  });

  it("replays the same manual hold decision idempotently and rejects changed metadata", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const { id } = replies.discover({
      sourceKey: "tmall:hold-replay", orderId: "hold-replay", review: "不好", product: "商品",
      reviewedAt: null, sentimentLabel: "negative", itemId: null, reviewPhase: "initial",
    });
    const decision = {
      storeId: "primary", manualProductId: null, catalogRevision: 5,
      matchKind: "item_id", reason: "名单商品差评转人工",
    };
    const first = replies.markManualProductHold(id, decision);
    const lock = new ReviewActionGate(database).getLock("primary", first.sourceKey)!;

    expect(replies.markManualProductHold(id, decision)).toEqual(first);
    expect(new ReviewActionGate(database).getLock("primary", first.sourceKey)?.lockVersion).toBe(lock.lockVersion);
    expect(() => replies.markManualProductHold(id, { ...decision, catalogRevision: 6 }))
      .toThrow(ReviewActionConflictError);
    expect(replies.get(id)).toEqual(first);
    database.close();
  });

  it("never marks a protected draft failed", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const gate = new ReviewActionGate(database);
    const { id } = replies.discover({
      sourceKey: "tmall:fail-protected", orderId: "fail-protected", review: "评价", product: "商品",
      reviewedAt: null, sentimentLabel: "unknown", itemId: null, reviewPhase: "initial",
    });
    gate.acquire("primary", "tmall:fail-protected", "complaint");

    expect(replies.fail(id, "SHOULD_NOT_WRITE", "不应覆盖")).toBe(false);
    expect(replies.get(id)).toMatchObject({ state: "discovered", errorCode: null, errorMessage: null });
    database.close();
  });

  it("records classification, selected template and final read-only draft evidence", async () => {
    const { database } = await createFileDatabase();
    const repository = new ReplyRepository(database);
    const templates = new TemplateRepository(database);
    templates.saveSource({ library: "good", url: "https://demo.feishu.cn/base/app?table=tbl1", appToken: "app", tableId: "tbl1", viewId: null });
    const active = templates.activateVersion({
      library: "good",
      contentHash: "reply-evidence-template",
      sourceRecordCount: 1,
      templates: [template("音质音效类", "感谢您对音质的认可！")],
      warnings: [],
    });
    const { id } = repository.discover({
      sourceKey: "tmall:1002:evidence",
      orderId: "1002",
      review: "音质很好",
      product: "漫步者耳机",
      reviewedAt: null,
      sentimentLabel: "positive",
      itemId: null,
      reviewPhase: "initial",
    });

    repository.saveClassification(id, {
      library: "good",
      primaryCategory: "",
      category: "音质音效类",
      confidence: 0.94,
      reason: "买家明确称赞音质",
      needsAttention: false,
    });
    repository.saveTemplate(id, { versionId: active.versionId, sequence: 2, text: "感谢您对音质的认可！" });
    repository.complete(id, {
      finalReply: "感谢您对漫步者耳机音质的认可！若有任何疑问欢迎咨询在线客服，感谢您的支持！",
      productAdjusted: true,
      needsAttention: false,
      notes: "补充当前商品名称",
      attentionReasons: [],
    });

    expect(repository.get(id)).toMatchObject({
      library: "good",
      category: "音质音效类",
      templateSequence: 2,
      originalTemplate: "感谢您对音质的认可！",
      state: "read_only_ready",
      productAdjusted: true,
    });
    expect(repository.list()).toHaveLength(1);
    database.close();
  });

  it("cleans expired draft records without touching current records", async () => {
    const { database } = await createFileDatabase();
    const repository = new ReplyRepository(database);
    const old = repository.discover({ sourceKey: "old", orderId: null, review: "旧评论", product: "旧商品", reviewedAt: null, sentimentLabel: "unknown", itemId: null, reviewPhase: "initial" });
    repository.discover({ sourceKey: "current", orderId: null, review: "新评论", product: "新商品", reviewedAt: null, sentimentLabel: "positive", itemId: null, reviewPhase: "initial" });
    database.prepare("UPDATE reply_drafts SET state = 'failed', discovered_at = '2025-01-01T00:00:00.000Z' WHERE id = ?").run(old.id);

    expect(repository.pruneOlderThan(90, new Date("2026-07-14T00:00:00.000Z"))).toBe(1);
    expect(repository.list()).toMatchObject([{ sourceKey: "current" }]);
    database.close();
  });

  it("persists the automation plan, windows and run audit across restarts", async () => {
    const first = await createFileDatabase();
    const repository = new AutomationRepository(first.database);
    repository.savePlan({
      enabled: true,
      paused: false,
      timezone: "Asia/Shanghai",
      intervalMinutes: 20,
      windows: [{ id: "morning", start: "08:00", end: "09:00" }],
    }, 1);
    const runId = repository.createRun("manual", RUN_SCOPE);
    repository.finishRun(runId, { state: "completed", processed: 785, succeeded: 770, failed: 5, manual: 10, stopReason: "queue_empty" });
    first.database.close();

    const reopened = openDatabase(first.path);
    runMigrations(reopened);
    const persisted = new AutomationRepository(reopened);
    expect(persisted.getPlan()).toMatchObject({ enabled: true, intervalMinutes: 20, windows: [{ id: "morning", start: "08:00", end: "09:00" }] });
    expect(persisted.getLastRun()).toMatchObject({ trigger: "manual", state: "completed", processed: 785, succeeded: 770, failed: 5, manual: 10, stopReason: "queue_empty" });
    reopened.close();
  });

  it("records automation run timestamps from the injected caller clock", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const automation = new AutomationRepository(database);
    const startedAt = new Date("2026-07-16T08:00:00.000Z");
    const finishedAt = new Date("2026-07-16T08:03:00.000Z");
    const id = automation.createRun("manual", RUN_SCOPE, startedAt);

    expect(automation.finishRun(id, {
      state: "completed", processed: 0, succeeded: 0, failed: 0, manual: 0, stopReason: "queue_empty", at: finishedAt,
    })).toBe(true);
    expect(database.prepare("SELECT started_at AS startedAt, finished_at AS finishedAt FROM automation_runs WHERE id = ?").get(id)).toEqual({
      startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
    });
    database.close();
  });

  it("closes automation runs left active by an interrupted process", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const automation = new AutomationRepository(database);
    const runId = automation.createRun("scheduled", RUN_SCOPE);

    expect(automation.recoverInterruptedRuns(new Date("2026-07-16T10:00:00.000Z"))).toBe(1);
    expect(automation.getLastRun()).toMatchObject({
      id: runId,
      state: "interrupted",
      stopReason: "application_restarted",
      finishedAt: "2026-07-16T10:00:00.000Z",
    });
    expect(automation.recoverInterruptedRuns(new Date("2026-07-16T10:01:00.000Z"))).toBe(0);
    database.close();
  });

  it("upgrades version 10 drafts with durable AI retry fields without losing existing data", () => {
    const database = createVersion10Database();
    const timestamp = "2026-07-16T08:00:00.000Z";
    database.prepare(`
      INSERT INTO reply_drafts(
        id, source_key, review_text, product_title, sentiment_label, state, discovered_at, updated_at
      ) VALUES ('legacy-ai-draft', 'tmall:legacy-ai-draft', '音质很好', '漫步者耳机', 'positive', 'discovered', ?, ?)
    `).run(timestamp, timestamp);

    runMigrations(database);
    runMigrations(database);

    expect((database.pragma("table_info('reply_drafts')") as Array<{ name: string }>).map((column) => column.name))
      .toEqual(expect.arrayContaining([
        "ai_checkpoint_stage",
        "failed_stage",
        "ai_retry_error_kind",
        "next_retry_at",
        "consecutive_ai_failure_rounds",
      ]));
    expect(database.prepare(`
      SELECT source_key, review_text, state, ai_checkpoint_stage, failed_stage,
             ai_retry_error_kind, next_retry_at, consecutive_ai_failure_rounds
      FROM reply_drafts WHERE id = 'legacy-ai-draft'
    `).get()).toEqual({
      source_key: "tmall:legacy-ai-draft",
      review_text: "音质很好",
      state: "discovered",
      ai_checkpoint_stage: null,
      failed_stage: null,
      ai_retry_error_kind: null,
      next_retry_at: null,
      consecutive_ai_failure_rounds: 0,
    });
    expect(database.prepare("SELECT COUNT(*) AS value FROM schema_migrations WHERE version = 11").get())
      .toEqual({ value: 1 });
    expect(() => database.prepare(
      "UPDATE reply_drafts SET failed_stage = 'other' WHERE id = 'legacy-ai-draft'",
    ).run()).toThrow();
    expect(() => database.prepare(
      "UPDATE reply_drafts SET ai_retry_error_kind = 'configuration' WHERE id = 'legacy-ai-draft'",
    ).run()).toThrow();
    database.close();
  });

  it("upgrades an already-version-11 database with nullable durable retry claim leases", () => {
    const database = createVersion11Database();
    const timestamp = "2026-07-16T08:00:00.000Z";
    database.prepare(`
      INSERT INTO reply_drafts(
        id, source_key, review_text, product_title, sentiment_label, state,
        failed_stage, ai_retry_error_kind, next_retry_at, consecutive_ai_failure_rounds,
        discovered_at, updated_at
      ) VALUES (
        'legacy-v11-retry', 'tmall:legacy-v11-retry', '音质很好', '漫步者耳机',
        'positive', 'retry_wait', 'classification', 'timeout', ?, 1, ?, ?
      )
    `).run(timestamp, timestamp, timestamp);

    runMigrations(database);
    runMigrations(database);

    expect(database.prepare(`
      SELECT ai_retry_claim_token, ai_retry_claim_expires_at
      FROM reply_drafts WHERE id = 'legacy-v11-retry'
    `).get()).toEqual({ ai_retry_claim_token: null, ai_retry_claim_expires_at: null });
    expect(database.prepare("SELECT COUNT(*) AS value FROM schema_migrations WHERE version = 12").get())
      .toEqual({ value: 1 });
    database.close();
  });

  it("atomically persists the classification and random-template checkpoint for restart-safe rewrite", async () => {
    const first = await createFileDatabase();
    const replies = new ReplyRepository(first.database);
    const templates = new TemplateRepository(first.database);
    templates.saveSource({
      library: "good",
      url: "https://demo.feishu.cn/base/app?table=tbl1",
      appToken: "app",
      tableId: "tbl1",
      viewId: null,
    });
    const active = templates.activateVersion({
      library: "good",
      contentHash: "ai-checkpoint-template",
      sourceRecordCount: 1,
      templates: [template("音质音效类", "感谢您对音质的认可！")],
      warnings: [],
    });
    const discovered = replies.discover({
      sourceKey: "tmall:ai-checkpoint",
      orderId: "ai-checkpoint",
      review: "音质很好",
      product: "漫步者 X1",
      reviewedAt: null,
      sentimentLabel: "positive",
      itemId: "960227744800",
      reviewPhase: "initial",
    });

    const checkpoint = replies.saveAiCheckpoint(discovered.id, {
      library: "good",
      primaryCategory: "",
      category: "音质音效类",
      confidence: 0.97,
      reason: "买家明确称赞音质",
      needsAttention: false,
      templateVersionId: active.versionId,
      templateSequence: 1,
      originalTemplate: "感谢您对音质的认可！",
    });
    expect(checkpoint).toMatchObject({
      id: discovered.id,
      sourceKey: "tmall:ai-checkpoint",
      state: "template_selected",
      library: "good",
      category: "音质音效类",
      templateVersionId: active.versionId,
      templateSequence: 1,
      originalTemplate: "感谢您对音质的认可！",
      aiCheckpointStage: "template_selected",
      failedStage: null,
      aiRetryErrorKind: null,
      nextRetryAt: null,
      consecutiveAiFailureRounds: 0,
    });
    expect(replies.discover({
      sourceKey: "tmall:ai-checkpoint",
      orderId: "ai-checkpoint",
      review: "音质很好",
      product: "漫步者 X1 新标题",
      reviewedAt: null,
      sentimentLabel: "positive",
      itemId: "960227744800",
      reviewPhase: "initial",
    })).toEqual({ id: discovered.id, created: false });
    expect(first.database.prepare(
      "SELECT COUNT(*) AS value FROM reply_drafts WHERE source_key = 'tmall:ai-checkpoint'",
    ).get()).toEqual({ value: 1 });

    first.database.close();
    const reopened = openDatabase(first.path);
    runMigrations(reopened);
    expect(new ReplyRepository(reopened).get(discovered.id)).toMatchObject({
      state: "template_selected",
      category: "音质音效类",
      templateVersionId: active.versionId,
      templateSequence: 1,
      originalTemplate: "感谢您对音质的认可！",
      aiCheckpointStage: "template_selected",
    });
    reopened.close();
  });

  it("rolls back every checkpoint field when the selected template is inconsistent", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const { id } = replies.discover({
      sourceKey: "tmall:invalid-checkpoint",
      orderId: null,
      review: "很好",
      product: "漫步者耳机",
      reviewedAt: null,
      sentimentLabel: "positive",
      itemId: null,
      reviewPhase: "initial",
    });

    expect(() => replies.saveAiCheckpoint(id, {
      library: "good",
      primaryCategory: "",
      category: "音质音效类",
      confidence: 0.9,
      reason: "称赞音质",
      needsAttention: false,
      templateVersionId: 999_999,
      templateSequence: 1,
      originalTemplate: "不存在的话术",
    })).toThrow();
    expect(replies.get(id)).toMatchObject({
      state: "discovered",
      library: null,
      category: "",
      templateVersionId: null,
      templateSequence: null,
      originalTemplate: "",
      aiCheckpointStage: null,
    });
    database.close();
  });

  it("persists retry rounds, keeps the circuit visible diagnostically, and blocks execution after round three", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const { id } = replies.discover({
      sourceKey: "tmall:retry-due",
      orderId: null,
      review: "音质很好",
      product: "漫步者耳机",
      reviewedAt: null,
      sentimentLabel: "positive",
      itemId: null,
      reviewPhase: "initial",
    });
    const retryAt = new Date("2026-07-16T08:05:00.000Z");

    expect(replies.recordAiRetryRoundFailure(id, {
      failedStage: "classification",
      errorKind: "timeout",
      nextRetryAt: retryAt,
    })).toMatchObject({
      state: "retry_wait",
      failedStage: "classification",
      aiRetryErrorKind: "timeout",
      nextRetryAt: retryAt.toISOString(),
      consecutiveAiFailureRounds: 1,
    });
    expect(replies.listDueAiRetriesForDiagnostics(new Date("2026-07-16T08:04:59.999Z"))).toEqual([]);
    expect(replies.listDueAiRetriesForDiagnostics(retryAt)).toMatchObject([{
      id,
      failedStage: "classification",
      consecutiveAiFailureRounds: 1,
    }]);

    const secondClaim = replies.claimDueAiRetries({ now: retryAt, leaseMs: 60_000, limit: 1 });
    replies.recordAiRetryRoundFailure(id, {
      failedStage: "classification",
      errorKind: "model_contract",
      nextRetryAt: new Date("2026-07-16T08:10:00.000Z"),
      expectedClaimToken: secondClaim.claimToken,
      at: new Date("2026-07-16T08:05:01.000Z"),
    });
    const thirdClaim = replies.claimDueAiRetries({
      now: new Date("2026-07-16T08:10:00.000Z"), leaseMs: 60_000, limit: 1,
    });
    const thirdRound = replies.recordAiRetryRoundFailure(id, {
      failedStage: "classification",
      errorKind: "service_unavailable",
      nextRetryAt: new Date("2026-07-16T08:15:00.000Z"),
      expectedClaimToken: thirdClaim.claimToken,
      at: new Date("2026-07-16T08:10:01.000Z"),
    });
    expect(thirdRound.consecutiveAiFailureRounds).toBe(3);
    const circuitAt = new Date("2026-07-16T08:15:00.000Z");
    expect(replies.listDueAiRetriesForDiagnostics(circuitAt)).toMatchObject([{
      id, state: "retry_wait", consecutiveAiFailureRounds: 3,
    }]);
    expect(replies.claimDueAiRetries({ now: circuitAt, leaseMs: 60_000, limit: 1 }).drafts).toEqual([]);
    expect(replies.fail(id, "CIRCUIT_MUST_STAY_OPEN", "不应改变熔断状态")).toBe(false);
    expect(replies.resetForReprocess(id)).toBe(false);
    expect(replies.get(id)).toMatchObject({
      state: "retry_wait",
      failedStage: "classification",
      consecutiveAiFailureRounds: 3,
    });
    database.close();
  });

  it("claims only the explicitly page-observed AI retry", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const dueAt = new Date("2026-07-16T08:05:00.000Z");
    const makeRetry = (sourceKey: string) => {
      const draft = replies.discover({
        sourceKey,
        orderId: sourceKey,
        review: "音质很好",
        product: "测试商品",
        reviewedAt: "2026-07-16 08:00",
        sentimentLabel: "positive",
        itemId: null,
        reviewPhase: "initial",
      });
      replies.recordAiRetryRoundFailure(draft.id, {
        failedStage: "classification",
        errorKind: "timeout",
        nextRetryAt: dueAt,
        at: dueAt,
      });
      return draft;
    };
    const importedOnlySourceKey = "tmall:observed-retry:imported-only";
    const observedSourceKey = "tmall:observed-retry:visible-page";
    const importedOnly = makeRetry(importedOnlySourceKey);
    const observed = makeRetry(observedSourceKey);

    const claim = replies.claimObservedAiRetry({
      id: observed.id,
      sourceKey: observedSourceKey,
      now: dueAt,
      leaseMs: 60_000,
    });

    expect(claim.drafts).toMatchObject([{ id: observed.id, sourceKey: observedSourceKey }]);
    expect(replies.get(importedOnly.id)).toMatchObject({ state: "retry_wait" });
    expect(database.prepare(
      "SELECT ai_retry_claim_token AS token FROM reply_drafts WHERE id = ?",
    ).get(importedOnly.id)).toEqual({ token: null });
    expect(replies.claimObservedAiRetry({
      id: observed.id,
      sourceKey: importedOnlySourceKey,
      now: dueAt,
      leaseMs: 60_000,
    }).drafts).toEqual([]);
    database.close();
  });

  it("releases only the matching live retry lease and leaves action-owned claims untouched", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const gate = new ReviewActionGate(database);
    const dueAt = new Date("2026-07-16T08:05:00.000Z");
    const first = replies.discover({
      sourceKey: "tmall:release-claim:first", orderId: null, review: "音质很好", product: "漫步者耳机",
      reviewedAt: null, sentimentLabel: "positive", itemId: null, reviewPhase: "initial",
    });
    replies.recordAiRetryRoundFailure(first.id, {
      failedStage: "classification", errorKind: "timeout", nextRetryAt: dueAt, at: dueAt,
    });
    const claim = replies.claimDueAiRetries({ now: dueAt, leaseMs: 60_000, limit: 1 });

    expect(replies.releaseAiRetryClaim(first.id, { claimToken: "wrong-token", at: dueAt })).toBe(false);
    expect(replies.releaseAiRetryClaim(first.id, { claimToken: claim.claimToken, at: dueAt })).toBe(true);
    expect(replies.claimDueAiRetries({ now: dueAt, leaseMs: 60_000, limit: 1 }).drafts).toMatchObject([{ id: first.id }]);

    const second = replies.discover({
      sourceKey: "tmall:release-claim:locked", orderId: null, review: "音质很好", product: "漫步者耳机",
      reviewedAt: null, sentimentLabel: "positive", itemId: null, reviewPhase: "initial",
    });
    replies.recordAiRetryRoundFailure(second.id, {
      failedStage: "classification", errorKind: "timeout", nextRetryAt: dueAt, at: dueAt,
    });
    const lockedClaim = replies.claimDueAiRetries({ now: dueAt, leaseMs: 60_000, limit: 10 });
    gate.acquire("primary", "tmall:release-claim:locked", "complaint");

    expect(replies.releaseAiRetryClaim(second.id, { claimToken: lockedClaim.claimToken, at: dueAt })).toBe(false);
    expect(database.prepare("SELECT ai_retry_claim_token AS token FROM reply_drafts WHERE id = ?").get(second.id)).toEqual({ token: lockedClaim.claimToken });
    database.close();
  });

  it("claims only strictly valid in-range retry timestamps and flags missing, malformed, or overflow dates for manual handling", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const dueAt = new Date("2026-07-16T08:05:00.000Z");
    const scope = { startDate: "2026-06-01", endDate: "2026-07-31" } as const;
    const createRetry = (sourceKey: string, reviewedAt: string | null) => {
      const draft = replies.discover({
        sourceKey, orderId: sourceKey, review: "音质很好", product: "漫步者耳机",
        reviewedAt, sentimentLabel: "positive", itemId: null, reviewPhase: "initial",
      });
      replies.recordAiRetryRoundFailure(draft.id, {
        failedStage: "classification", errorKind: "timeout", nextRetryAt: dueAt, at: dueAt,
      });
      return draft;
    };
    const valid = createRetry("tmall:strict-date:valid", "2026-07-16 08:00");
    const overflowSourceKey = "tmall:strict-date:overflow";
    createRetry(overflowSourceKey, "2026-06-31 08:00");
    createRetry("tmall:strict-date:malformed", "reviewed-yesterday");
    createRetry("tmall:strict-date:missing", null);

    expect(replies.hasDueAiRetryOutsideScope({ now: dueAt, scope })).toBe(true);
    expect(replies.claimDueAiRetries({ now: dueAt, leaseMs: 60_000, limit: 10, scope }).drafts.map((draft) => draft.id))
      .toEqual([valid.id]);
    expect(replies.list().find((draft) => draft.sourceKey === overflowSourceKey)).toMatchObject({ state: "retry_wait" });
    database.close();
  });

  it("recovers an interrupted AI-only retry lease immediately on restart without releasing an action-owned lease", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const gate = new ReviewActionGate(database);
    const dueAt = new Date("2026-07-16T08:05:00.000Z");
    const safe = replies.discover({
      sourceKey: "tmall:restart-ai-lease:safe", orderId: null, review: "音质很好", product: "漫步者耳机",
      reviewedAt: "2026-07-16 08:00", sentimentLabel: "positive", itemId: null, reviewPhase: "initial",
    });
    replies.recordAiRetryRoundFailure(safe.id, {
      failedStage: "classification", errorKind: "timeout", nextRetryAt: dueAt, at: dueAt,
    });
    const safeClaim = replies.claimDueAiRetries({ now: dueAt, leaseMs: 60_000, limit: 1 });

    expect(replies.recoverInterruptedAiRetryClaims(dueAt)).toBe(1);
    expect(replies.claimDueAiRetries({ now: dueAt, leaseMs: 60_000, limit: 1 }).drafts).toMatchObject([{ id: safe.id }]);

    const heldSourceKey = "tmall:restart-ai-lease:held";
    const held = replies.discover({
      sourceKey: heldSourceKey, orderId: null, review: "音质很好", product: "漫步者耳机",
      reviewedAt: "2026-07-16 08:00", sentimentLabel: "positive", itemId: null, reviewPhase: "initial",
    });
    replies.recordAiRetryRoundFailure(held.id, {
      failedStage: "classification", errorKind: "timeout", nextRetryAt: dueAt, at: dueAt,
    });
    const heldClaim = replies.claimDueAiRetries({ now: dueAt, leaseMs: 60_000, limit: 10 });
    gate.acquire("primary", heldSourceKey, "complaint");

    expect(replies.recoverInterruptedAiRetryClaims(dueAt)).toBe(1);
    expect(database.prepare("SELECT ai_retry_claim_token AS token FROM reply_drafts WHERE id = ?").get(held.id)).toEqual({ token: heldClaim.claimToken });
    database.close();
  });

  it("recovers interrupted ordinary AI owners across a file restart without releasing an action-owned draft", async () => {
    const first = await createFileDatabase();
    const restartAt = new Date("2026-07-16T08:05:00.000Z");
    const firstReplies = new ReplyRepository(first.database);
    const discovered = firstReplies.discover({
      sourceKey: "tmall:restart-ordinary-owner:discovered", orderId: null, review: "Great sound quality", product: "Headphones",
      reviewedAt: "2026-07-16 08:00", sentimentLabel: "positive", itemId: null, reviewPhase: "initial",
    });
    const classifying = firstReplies.discover({
      sourceKey: "tmall:restart-ordinary-owner:classifying", orderId: null, review: "Great sound quality", product: "Headphones",
      reviewedAt: "2026-07-16 08:00", sentimentLabel: "positive", itemId: null, reviewPhase: "initial",
    });
    const actionOwnedSourceKey = "tmall:restart-ordinary-owner:action";
    const actionOwned = firstReplies.discover({
      sourceKey: actionOwnedSourceKey, orderId: null, review: "Great sound quality", product: "Headphones",
      reviewedAt: "2026-07-16 08:00", sentimentLabel: "positive", itemId: null, reviewPhase: "initial",
    });
    expect(firstReplies.claimDraftProcessing(discovered.id, { at: restartAt, leaseMs: 30 * 60_000 })).toBeTruthy();
    expect(firstReplies.claimDraftProcessing(classifying.id, { at: restartAt, leaseMs: 30 * 60_000 })).toBeTruthy();
    expect(firstReplies.claimDraftProcessing(actionOwned.id, { at: restartAt, leaseMs: 30 * 60_000 })).toBeTruthy();
    first.database.prepare("UPDATE reply_drafts SET state = 'classifying' WHERE id = ?").run(classifying.id);
    new ReviewActionGate(first.database).acquire("primary", actionOwnedSourceKey, "complaint");
    first.database.close();

    const restarted = openDatabase(first.path);
    runMigrations(restarted);
    try {
      const replies = new ReplyRepository(restarted);
      expect(replies.recoverInterruptedAiRetryClaims(restartAt)).toBe(2);
      expect(restarted.prepare(`
        SELECT state, ai_retry_claim_token, ai_retry_claim_expires_at
        FROM reply_drafts WHERE id = ?
      `).get(discovered.id)).toEqual({
        state: "discovered", ai_retry_claim_token: null, ai_retry_claim_expires_at: null,
      });
      expect(restarted.prepare(`
        SELECT state, ai_retry_claim_token, ai_retry_claim_expires_at
        FROM reply_drafts WHERE id = ?
      `).get(classifying.id)).toEqual({
        state: "discovered", ai_retry_claim_token: null, ai_retry_claim_expires_at: null,
      });
      expect(replies.claimDraftProcessing(discovered.id, { at: restartAt, leaseMs: 30 * 60_000 })).toBeTruthy();
      expect(replies.claimDraftProcessing(classifying.id, { at: restartAt, leaseMs: 30 * 60_000 })).toBeTruthy();
      expect(replies.claimDraftProcessing(actionOwned.id, { at: restartAt, leaseMs: 30 * 60_000 })).toBeNull();
      expect(restarted.prepare(`
        SELECT ai_retry_claim_token AS token
        FROM reply_drafts WHERE id = ?
      `).get(actionOwned.id)).toMatchObject({ token: expect.any(String) });
    } finally {
      restarted.close();
    }
  });

  it("keeps a selected-template checkpoint across rewrite retry and resets retry counters on completion", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const templates = new TemplateRepository(database);
    templates.saveSource({
      library: "bad", url: "https://demo.feishu.cn/base/app?table=tbl2",
      appToken: "app", tableId: "tbl2", viewId: null,
    });
    const active = templates.activateVersion({
      library: "bad",
      contentHash: "rewrite-retry-template",
      sourceRecordCount: 1,
      templates: [template("通用差评类", "非常抱歉没有达到您的预期。")],
      warnings: [],
    });
    const { id } = replies.discover({
      sourceKey: "tmall:rewrite-retry", orderId: null, review: "不好用", product: "漫步者 X1",
      reviewedAt: null, sentimentLabel: "negative", itemId: null, reviewPhase: "initial",
    });
    replies.saveAiCheckpoint(id, {
      library: "bad", primaryCategory: "通用差评类", category: "通用差评类",
      confidence: 0.7, reason: "没有更具体的问题", needsAttention: false,
      templateVersionId: active.versionId, templateSequence: 1,
      originalTemplate: "非常抱歉没有达到您的预期。",
    });
    replies.recordAiRetryRoundFailure(id, {
      failedStage: "rewrite", errorKind: "network",
      nextRetryAt: new Date("2026-07-16T08:05:00.000Z"),
    });
    const completionClaim = replies.claimDueAiRetries({
      now: new Date("2026-07-16T08:05:00.000Z"), leaseMs: 60_000, limit: 1,
    });

    expect(replies.get(id)).toMatchObject({
      state: "retry_wait",
      failedStage: "rewrite",
      aiCheckpointStage: "template_selected",
      library: "bad",
      category: "通用差评类",
      templateVersionId: active.versionId,
      templateSequence: 1,
      originalTemplate: "非常抱歉没有达到您的预期。",
    });
    replies.complete(id, {
      finalReply: "非常抱歉没有达到您的预期，若使用过程中有任何疑问可咨询漫步者客服。",
      productAdjusted: false,
      needsAttention: false,
      notes: "已完成改写",
      attentionReasons: [],
      expectedClaimToken: completionClaim.claimToken,
      at: new Date("2026-07-16T08:05:01.000Z"),
    });
    expect(replies.get(id)).toMatchObject({
      state: "read_only_ready",
      aiCheckpointStage: "template_selected",
      failedStage: null,
      aiRetryErrorKind: null,
      nextRetryAt: null,
      consecutiveAiFailureRounds: 0,
      originalTemplate: "非常抱歉没有达到您的预期。",
    });
    database.close();
  });

  it("preserves an open AI circuit through manual-product hold release and rejects legacy reset bypasses", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const gate = new ReviewActionGate(database);
    const circuit = replies.discover({
      sourceKey: "tmall:circuit-manual-hold", orderId: null, review: "不好用", product: "漫步者 X1",
      reviewedAt: null, sentimentLabel: "negative", itemId: null, reviewPhase: "initial",
    });
    database.prepare(`
      UPDATE reply_drafts
      SET state = 'retry_wait', failed_stage = 'classification', ai_retry_error_kind = 'timeout',
          next_retry_at = '2026-07-16T08:15:00.000Z', consecutive_ai_failure_rounds = 3
      WHERE id = ?
    `).run(circuit.id);

    expect(replies.markManualProductHold(circuit.id, {
      storeId: "primary", manualProductId: null, catalogRevision: 1,
      matchKind: "item_id", reason: "人工名单专属处理",
    })).toMatchObject({ state: "manual_product_hold", consecutiveAiFailureRounds: 3 });
    const manualLock = gate.getLock("primary", "tmall:circuit-manual-hold")!;
    expect(gate.releaseManualHold("primary", "tmall:circuit-manual-hold", manualLock.lockVersion)).toBe(true);
    expect(replies.get(circuit.id)).toMatchObject({ state: "discovered", consecutiveAiFailureRounds: 3 });
    expect(replies.resetForReprocess(circuit.id)).toBe(false);
    expect(() => replies.recordAiRetryRoundFailure(circuit.id, {
      failedStage: "classification", errorKind: "timeout",
      nextRetryAt: new Date("2026-07-16T08:20:00.000Z"),
    })).toThrow(ReviewActionConflictError);

    const legacy = replies.discover({
      sourceKey: "tmall:legacy-failed-circuit", orderId: null, review: "评价", product: "商品",
      reviewedAt: null, sentimentLabel: "unknown", itemId: null, reviewPhase: "initial",
    });
    database.prepare(`
      UPDATE reply_drafts SET state = 'failed', consecutive_ai_failure_rounds = 3 WHERE id = ?
    `).run(legacy.id);
    expect(replies.resetForReprocess(legacy.id)).toBe(false);
    expect(replies.get(legacy.id)).toMatchObject({ state: "failed", consecutiveAiFailureRounds: 3 });
    database.close();
  });

  it("protects an old template version while a non-terminal rewrite retry still freezes that checkpoint", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const templates = new TemplateRepository(database);
    templates.saveSource({
      library: "good", url: "https://demo.feishu.cn/base/app?table=tbl1",
      appToken: "app", tableId: "tbl1", viewId: null,
    });
    const frozenTemplate = "感谢您对音质的认可，若有疑问欢迎咨询在线客服！";
    const firstVersion = templates.activateVersion({
      library: "good",
      contentHash: "frozen-checkpoint-v1",
      sourceRecordCount: 1,
      templates: [template("音质音效类", frozenTemplate)],
      warnings: [],
    });
    const { id } = replies.discover({
      sourceKey: "tmall:frozen-old-template", orderId: null, review: "音质很好",
      product: "漫步者 X1", reviewedAt: null, sentimentLabel: "positive",
      itemId: null, reviewPhase: "initial",
    });
    replies.saveAiCheckpoint(id, {
      library: "good", primaryCategory: "", category: "音质音效类",
      confidence: 0.96, reason: "买家明确称赞音质", needsAttention: false,
      templateVersionId: firstVersion.versionId, templateSequence: 1, originalTemplate: frozenTemplate,
    });
    replies.recordAiRetryRoundFailure(id, {
      failedStage: "rewrite", errorKind: "timeout",
      nextRetryAt: new Date("2026-07-16T08:05:00.000Z"),
    });

    for (let version = 2; version <= 11; version += 1) {
      templates.activateVersion({
        library: "good",
        contentHash: `frozen-checkpoint-v${version}`,
        sourceRecordCount: 1,
        templates: [template("音质音效类", `新版话术-${version}`)],
        warnings: [],
      });
    }

    expect(database.prepare("SELECT id FROM template_versions WHERE id = ?").get(firstVersion.versionId))
      .toEqual({ id: firstVersion.versionId });
    expect(replies.get(id)).toMatchObject({
      state: "retry_wait",
      failedStage: "rewrite",
      aiCheckpointStage: "template_selected",
      library: "good",
      category: "音质音效类",
      templateVersionId: firstVersion.versionId,
      templateSequence: 1,
      originalTemplate: frozenTemplate,
    });
    expect(replies.listDueAiRetriesForDiagnostics(new Date("2026-07-16T08:05:00.000Z")))
      .toMatchObject([{ id, templateVersionId: firstVersion.versionId, originalTemplate: frozenTemplate }]);
    database.close();
  });

  it("returns due retries only when the failed stage has a complete matching checkpoint", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const dueAt = "2026-07-16T08:05:00.000Z";
    const createDraft = (sourceKey: string) => replies.discover({
      sourceKey, orderId: null, review: "评价", product: "商品", reviewedAt: null,
      sentimentLabel: "unknown", itemId: null, reviewPhase: "initial",
    });
    const validClassification = createDraft("tmall:valid-classification-retry");
    replies.recordAiRetryRoundFailure(validClassification.id, {
      failedStage: "classification", errorKind: "network", nextRetryAt: new Date(dueAt),
    });

    const incompleteRewrite = createDraft("tmall:incomplete-rewrite-retry");
    database.prepare(`
      UPDATE reply_drafts
      SET state = 'retry_wait', ai_checkpoint_stage = 'template_selected', failed_stage = 'rewrite',
          ai_retry_error_kind = 'timeout', next_retry_at = ?, consecutive_ai_failure_rounds = 1
      WHERE id = ?
    `).run(dueAt, incompleteRewrite.id);
    const classificationWithCheckpoint = createDraft("tmall:classification-with-checkpoint");
    database.prepare(`
      UPDATE reply_drafts
      SET state = 'retry_wait', ai_checkpoint_stage = 'template_selected', failed_stage = 'classification',
          ai_retry_error_kind = 'model_contract', next_retry_at = ?, consecutive_ai_failure_rounds = 1
      WHERE id = ?
    `).run(dueAt, classificationWithCheckpoint.id);

    expect(replies.listDueAiRetriesForDiagnostics(new Date(dueAt)).map((draft) => draft.id))
      .toEqual([validClassification.id]);
    database.close();
  });

  it("atomically claims due retry work across two database connections and permits only one failure result", async () => {
    const first = await createFileDatabase();
    const secondDatabase = openDatabase(first.path);
    runMigrations(secondDatabase);
    try {
      const firstReplies = new ReplyRepository(first.database);
      const secondReplies = new ReplyRepository(secondDatabase);
      const { id } = firstReplies.discover({
        sourceKey: "tmall:retry-claim-race", orderId: null, review: "音质一般",
        product: "漫步者 X1", reviewedAt: null, sentimentLabel: "neutral",
        itemId: null, reviewPhase: "initial",
      });
      const dueAt = new Date("2026-07-16T08:05:00.000Z");
      firstReplies.recordAiRetryRoundFailure(id, {
        failedStage: "classification", errorKind: "timeout", nextRetryAt: dueAt,
      });
      expect(firstReplies.resetForReprocess(id)).toBe(false);
      expect(firstReplies.get(id)).toMatchObject({ state: "retry_wait", consecutiveAiFailureRounds: 1 });

      const firstClaim = firstReplies.claimDueAiRetries({ now: dueAt, leaseMs: 60_000, limit: 1 });
      const competingClaim = secondReplies.claimDueAiRetries({ now: dueAt, leaseMs: 60_000, limit: 1 });
      expect(firstClaim.drafts.map((draft) => draft.id)).toEqual([id]);
      expect(firstClaim.claimToken).toBeTruthy();
      expect(competingClaim.drafts).toEqual([]);
      expect(firstReplies.get(id)).not.toHaveProperty("aiRetryClaimToken");
      expect(firstReplies.get(id)).not.toHaveProperty("aiRetryClaimExpiresAt");
      expect(secondReplies.get(id)).toMatchObject({
        consecutiveAiFailureRounds: 1,
      });
      expect(secondDatabase.prepare(`
        SELECT ai_retry_claim_token, ai_retry_claim_expires_at FROM reply_drafts WHERE id = ?
      `).get(id)).toEqual({
        ai_retry_claim_token: firstClaim.claimToken,
        ai_retry_claim_expires_at: firstClaim.leaseExpiresAt,
      });

      const takeoverAt = new Date("2026-07-16T08:06:00.001Z");
      expect(() => firstReplies.recordAiRetryRoundFailure(id, {
        failedStage: "classification", errorKind: "network",
        nextRetryAt: new Date("2026-07-16T08:11:00.000Z"),
        expectedClaimToken: firstClaim.claimToken,
        at: takeoverAt,
      })).toThrow(ReviewActionConflictError);
      expect(firstReplies.get(id)?.consecutiveAiFailureRounds).toBe(1);
      const takeover = secondReplies.claimDueAiRetries({ now: takeoverAt, leaseMs: 60_000, limit: 1 });
      expect(takeover.drafts.map((draft) => draft.id)).toEqual([id]);
      expect(takeover.claimToken).not.toBe(firstClaim.claimToken);

      expect(() => firstReplies.recordAiRetryRoundFailure(id, {
        failedStage: "classification", errorKind: "network",
        nextRetryAt: new Date("2026-07-16T08:11:00.000Z"),
        expectedClaimToken: firstClaim.claimToken,
        at: new Date("2026-07-16T08:06:01.000Z"),
      })).toThrow(ReviewActionConflictError);
      expect(secondReplies.recordAiRetryRoundFailure(id, {
        failedStage: "classification", errorKind: "network",
        nextRetryAt: new Date("2026-07-16T08:11:00.000Z"),
        expectedClaimToken: takeover.claimToken,
        at: new Date("2026-07-16T08:06:01.000Z"),
      })).toMatchObject({
        state: "retry_wait",
        consecutiveAiFailureRounds: 2,
      });
      expect(() => secondReplies.recordAiRetryRoundFailure(id, {
        failedStage: "classification", errorKind: "network",
        nextRetryAt: new Date("2026-07-16T08:11:00.000Z"),
        expectedClaimToken: takeover.claimToken,
        at: new Date("2026-07-16T08:06:01.000Z"),
      })).toThrow(ReviewActionConflictError);
      expect(firstReplies.get(id)?.consecutiveAiFailureRounds).toBe(2);
    } finally {
      secondDatabase.close();
      first.database.close();
    }
  });

  it("reclaims an expired claimed classification checkpoint and keeps the capability out of generic draft records", async () => {
    const first = await createFileDatabase();
    const secondDatabase = openDatabase(first.path);
    runMigrations(secondDatabase);
    try {
      const firstReplies = new ReplyRepository(first.database);
      const secondReplies = new ReplyRepository(secondDatabase);
      const templates = new TemplateRepository(first.database);
      templates.saveSource({
        library: "good", url: "https://demo.feishu.cn/base/app?table=tbl1",
        appToken: "app", tableId: "tbl1", viewId: null,
      });
      const templateText = "感谢您对音质的认可！";
      const active = templates.activateVersion({
        library: "good", contentHash: "expired-continuation", sourceRecordCount: 1,
        templates: [template("音质音效类", templateText)], warnings: [],
      });
      const { id } = firstReplies.discover({
        sourceKey: "tmall:expired-claimed-continuation", orderId: null, review: "音质很好",
        product: "漫步者 X1", reviewedAt: null, sentimentLabel: "positive",
        itemId: null, reviewPhase: "initial",
      });
      const dueAt = new Date("2026-07-16T08:05:00.000Z");
      firstReplies.recordAiRetryRoundFailure(id, {
        failedStage: "classification", errorKind: "timeout", nextRetryAt: dueAt,
      });
      const stale = firstReplies.claimDueAiRetries({ now: dueAt, leaseMs: 1_000, limit: 1 });
      firstReplies.saveAiCheckpoint(id, {
        library: "good", primaryCategory: "", category: "音质音效类",
        confidence: 0.95, reason: "称赞音质", needsAttention: false,
        templateVersionId: active.versionId, templateSequence: 1, originalTemplate: templateText,
        expectedClaimToken: stale.claimToken, at: new Date("2026-07-16T08:05:00.500Z"),
      });

      const takeoverAt = new Date("2026-07-16T08:05:01.001Z");
      expect(() => firstReplies.markRewriting(id, {
        expectedClaimToken: stale.claimToken, at: takeoverAt,
      })).toThrow(ReviewActionConflictError);
      const current = secondReplies.claimDueAiRetries({ now: takeoverAt, leaseMs: 60_000, limit: 1 });
      expect(current.drafts.map((draft) => draft.id)).toEqual([id]);
      expect(current.drafts[0]).not.toHaveProperty("aiRetryClaimToken");
      secondReplies.markRewriting(id, {
        expectedClaimToken: current.claimToken, at: new Date("2026-07-16T08:05:02.000Z"),
      });
      expect(secondReplies.recordAiRetryRoundFailure(id, {
        failedStage: "rewrite", errorKind: "network",
        nextRetryAt: new Date("2026-07-16T08:10:00.000Z"),
        expectedClaimToken: current.claimToken, at: new Date("2026-07-16T08:05:03.000Z"),
      })).toMatchObject({ state: "retry_wait", consecutiveAiFailureRounds: 2 });
    } finally {
      secondDatabase.close();
      first.database.close();
    }
  });

  it("prevents an expired retry worker from clearing or overwriting the newer worker final reply", async () => {
    const first = await createFileDatabase();
    const secondDatabase = openDatabase(first.path);
    runMigrations(secondDatabase);
    try {
      const firstReplies = new ReplyRepository(first.database);
      const secondReplies = new ReplyRepository(secondDatabase);
      const templates = new TemplateRepository(first.database);
      templates.saveSource({
        library: "bad", url: "https://demo.feishu.cn/base/app?table=tbl2",
        appToken: "app", tableId: "tbl2", viewId: null,
      });
      const templateText = "非常抱歉没有达到您的预期。";
      const active = templates.activateVersion({
        library: "bad", contentHash: "claim-final-reply", sourceRecordCount: 1,
        templates: [template("通用差评类", templateText)], warnings: [],
      });
      const { id } = firstReplies.discover({
        sourceKey: "tmall:retry-final-cas", orderId: null, review: "不好用",
        product: "漫步者 X1", reviewedAt: null, sentimentLabel: "negative",
        itemId: null, reviewPhase: "initial",
      });
      firstReplies.saveAiCheckpoint(id, {
        library: "bad", primaryCategory: "", category: "通用差评类",
        confidence: 0.8, reason: "整体负面但无具体问题", needsAttention: false,
        templateVersionId: active.versionId, templateSequence: 1, originalTemplate: templateText,
      });
      const dueAt = new Date("2026-07-16T08:05:00.000Z");
      firstReplies.recordAiRetryRoundFailure(id, {
        failedStage: "rewrite", errorKind: "timeout", nextRetryAt: dueAt,
      });
      const stale = firstReplies.claimDueAiRetries({ now: dueAt, leaseMs: 1_000, limit: 1 });
      const current = secondReplies.claimDueAiRetries({
        now: new Date("2026-07-16T08:05:01.001Z"), leaseMs: 60_000, limit: 1,
      });
      const staleResult = {
        finalReply: "旧 worker 生成的回复，不应覆盖。",
        productAdjusted: false, needsAttention: false, notes: "stale", attentionReasons: [],
        expectedClaimToken: stale.claimToken,
        at: new Date("2026-07-16T08:05:01.001Z"),
      };
      const currentResult = {
        finalReply: "非常抱歉没有达到您的预期，若有任何疑问可咨询漫步者客服。",
        productAdjusted: false, needsAttention: false, notes: "current", attentionReasons: [],
        expectedClaimToken: current.claimToken,
        at: new Date("2026-07-16T08:05:02.000Z"),
      };

      expect(() => firstReplies.complete(id, staleResult)).toThrow(ReviewActionConflictError);
      secondReplies.complete(id, currentResult);
      expect(() => firstReplies.complete(id, staleResult)).toThrow(ReviewActionConflictError);
      expect(firstReplies.get(id)).toMatchObject({
        state: "read_only_ready",
        finalReply: currentResult.finalReply,
        rewriteNotes: "current",
        consecutiveAiFailureRounds: 0,
      });
    } finally {
      secondDatabase.close();
      first.database.close();
    }
  });

  it("allows only the current unexpired retry claimant to record a fatal failure", async () => {
    const first = await createFileDatabase();
    const secondDatabase = openDatabase(first.path);
    runMigrations(secondDatabase);
    try {
      const firstReplies = new ReplyRepository(first.database);
      const secondReplies = new ReplyRepository(secondDatabase);
      const templates = new TemplateRepository(first.database);
      templates.saveSource({
        library: "good", url: "https://demo.feishu.cn/base/app?table=tbl1",
        appToken: "app", tableId: "tbl1", viewId: null,
      });
      const templateText = "感谢您对音质的认可！";
      const active = templates.activateVersion({
        library: "good", contentHash: "fatal-failure-claim-cas", sourceRecordCount: 1,
        templates: [template("音质音效类", templateText)], warnings: [],
      });
      const sourceKey = "tmall:fatal-failure-claim-cas";
      const { id } = firstReplies.discover({
        sourceKey, orderId: null, review: "音质很好", product: "漫步者 X1",
        reviewedAt: null, sentimentLabel: "positive", itemId: null, reviewPhase: "initial",
      });
      const dueAt = new Date("2026-07-16T08:05:00.000Z");
      firstReplies.recordAiRetryRoundFailure(id, {
        failedStage: "classification", errorKind: "timeout", nextRetryAt: dueAt,
      });
      const stale = firstReplies.claimDueAiRetries({ now: dueAt, leaseMs: 1_000, limit: 1 });
      firstReplies.saveAiCheckpoint(id, {
        library: "good", primaryCategory: "", category: "音质音效类",
        confidence: 0.95, reason: "称赞音质", needsAttention: false,
        templateVersionId: active.versionId, templateSequence: 1, originalTemplate: templateText,
        expectedClaimToken: stale.claimToken, at: new Date("2026-07-16T08:05:00.200Z"),
      });
      firstReplies.markRewriting(id, {
        expectedClaimToken: stale.claimToken, at: new Date("2026-07-16T08:05:00.400Z"),
      });

      const takeoverAt = new Date("2026-07-16T08:05:01.001Z");
      const current = secondReplies.claimDueAiRetries({ now: takeoverAt, leaseMs: 60_000, limit: 1 });
      expect(current.drafts.map((draft) => draft.id)).toEqual([id]);
      const selectDraft = first.database.prepare(`
        SELECT state, error_code, error_message, consecutive_ai_failure_rounds,
               ai_retry_claim_token, ai_retry_claim_expires_at, updated_at
        FROM reply_drafts WHERE id = ?
      `);
      const before = selectDraft.get(id);

      expect(() => firstReplies.fail(id, "STALE_WORKER", "旧 worker 不得写入", {
        expectedClaimToken: stale.claimToken, at: new Date("2026-07-16T08:05:01.002Z"),
      })).toThrow(ReviewActionConflictError);
      expect(selectDraft.get(id)).toEqual(before);
      expect(() => firstReplies.fail(id, "MISSING_CLAIM", "无 token worker 不得写入", {
        at: new Date("2026-07-16T08:05:01.002Z"),
      })).toThrow(ReviewActionConflictError);
      expect(selectDraft.get(id)).toEqual(before);

      expect(secondReplies.fail(id, "AI_CONFIGURATION_ERROR", "配置错误，已停止自动处理", {
        expectedClaimToken: current.claimToken, at: new Date("2026-07-16T08:05:02.000Z"),
      })).toBe(true);
      expect(selectDraft.get(id)).toEqual({
        state: "failed",
        error_code: "AI_CONFIGURATION_ERROR",
        error_message: "配置错误，已停止自动处理",
        consecutive_ai_failure_rounds: 1,
        ai_retry_claim_token: null,
        ai_retry_claim_expires_at: null,
        updated_at: "2026-07-16T08:05:02.000Z",
      });
    } finally {
      secondDatabase.close();
      first.database.close();
    }
  });

  it("allows the current classification-retry claimant to fail retry_wait without opening stale or tokenless writes", async () => {
    const first = await createFileDatabase();
    const secondDatabase = openDatabase(first.path);
    runMigrations(secondDatabase);
    try {
      const firstReplies = new ReplyRepository(first.database);
      const secondReplies = new ReplyRepository(secondDatabase);
      const { id } = firstReplies.discover({
        sourceKey: "tmall:classification-fatal-failure", orderId: null, review: "评价内容",
        product: "漫步者 X1", reviewedAt: null, sentimentLabel: "unknown",
        itemId: null, reviewPhase: "initial",
      });
      const dueAt = new Date("2026-07-16T08:05:00.000Z");
      firstReplies.recordAiRetryRoundFailure(id, {
        failedStage: "classification", errorKind: "timeout", nextRetryAt: dueAt,
      });
      const stale = firstReplies.claimDueAiRetries({ now: dueAt, leaseMs: 1_000, limit: 1 });
      const takeoverAt = new Date("2026-07-16T08:05:01.001Z");
      const current = secondReplies.claimDueAiRetries({ now: takeoverAt, leaseMs: 60_000, limit: 1 });
      expect(current.drafts.map((draft) => draft.id)).toEqual([id]);
      const selectDraft = first.database.prepare(`
        SELECT state, error_code, error_message, consecutive_ai_failure_rounds,
               ai_retry_claim_token, ai_retry_claim_expires_at, updated_at
        FROM reply_drafts WHERE id = ?
      `);
      const before = selectDraft.get(id);
      const operationAt = new Date("2026-07-16T08:05:02.000Z");

      expect(() => firstReplies.fail(id, "MISSING_CLAIM", "无 token 不得写入", { at: operationAt }))
        .toThrow(ReviewActionConflictError);
      expect(selectDraft.get(id)).toEqual(before);
      expect(() => firstReplies.fail(id, "STALE_CLAIM", "旧 token 不得写入", {
        expectedClaimToken: stale.claimToken, at: operationAt,
      })).toThrow(ReviewActionConflictError);
      expect(selectDraft.get(id)).toEqual(before);

      expect(secondReplies.fail(id, "AI_CONFIGURATION_ERROR", "配置错误，已停止自动处理", {
        expectedClaimToken: current.claimToken, at: operationAt,
      })).toBe(true);
      expect(selectDraft.get(id)).toEqual({
        state: "failed",
        error_code: "AI_CONFIGURATION_ERROR",
        error_message: "配置错误，已停止自动处理",
        consecutive_ai_failure_rounds: 1,
        ai_retry_claim_token: null,
        ai_retry_claim_expires_at: null,
        updated_at: operationAt.toISOString(),
      });
    } finally {
      secondDatabase.close();
      first.database.close();
    }
  });

  it.each([
    { blocker: "complaint_lock", operation: "mark_rewriting" },
    { blocker: "complaint_lock", operation: "complete" },
    { blocker: "reply_attempt", operation: "mark_rewriting" },
    { blocker: "reply_attempt", operation: "complete" },
    { blocker: "tombstone", operation: "mark_rewriting" },
    { blocker: "tombstone", operation: "complete" },
  ] as const)(
    "rejects a claimed $operation write when another connection adds a $blocker",
    async ({ blocker, operation }) => {
      const first = await createFileDatabase();
      const secondDatabase = openDatabase(first.path);
      runMigrations(secondDatabase);
      try {
        const firstReplies = new ReplyRepository(first.database);
        const templates = new TemplateRepository(first.database);
        templates.saveSource({
          library: "bad", url: "https://demo.feishu.cn/base/app?table=tbl2",
          appToken: "app", tableId: "tbl2", viewId: null,
        });
        const templateText = "非常抱歉没有达到您的预期。";
        const active = templates.activateVersion({
          library: "bad", contentHash: `post-claim-${blocker}-${operation}`, sourceRecordCount: 1,
          templates: [template("通用差评类", templateText)], warnings: [],
        });
        const sourceKey = `tmall:post-claim:${blocker}:${operation}`;
        const { id } = firstReplies.discover({
          sourceKey, orderId: null, review: "不好用", product: "漫步者 X1",
          reviewedAt: null, sentimentLabel: "negative", itemId: null, reviewPhase: "initial",
        });
        firstReplies.saveAiCheckpoint(id, {
          library: "bad", primaryCategory: "", category: "通用差评类",
          confidence: 0.8, reason: "整体负面且无具体问题", needsAttention: false,
          templateVersionId: active.versionId, templateSequence: 1, originalTemplate: templateText,
        });
        const dueAt = new Date("2026-07-16T08:05:00.000Z");
        firstReplies.recordAiRetryRoundFailure(id, {
          failedStage: "rewrite", errorKind: "timeout", nextRetryAt: dueAt,
        });
        const claim = firstReplies.claimDueAiRetries({ now: dueAt, leaseMs: 60_000, limit: 1 });
        expect(claim.drafts.map((draft) => draft.id)).toEqual([id]);

        const blockedAt = "2026-07-16T08:05:01.000Z";
        if (blocker === "complaint_lock") {
          new ReviewActionGate(secondDatabase).acquire("primary", sourceKey, "complaint");
        } else if (blocker === "reply_attempt") {
          secondDatabase.prepare(`
            INSERT INTO reply_attempts(
              id, reply_draft_id, source_key, state, created_at, updated_at
            ) VALUES (?, ?, ?, 'failed', ?, ?)
          `).run(`attempt-${operation}`, id, sourceKey, blockedAt, blockedAt);
        } else {
          secondDatabase.prepare(`
            INSERT INTO review_action_tombstones(store_id, source_key, terminal_action, completed_at)
            VALUES ('primary', ?, 'complaint_submitted', ?)
          `).run(sourceKey, blockedAt);
        }
        const selectDraft = first.database.prepare(`
          SELECT state, final_reply, updated_at, ai_retry_claim_token, ai_retry_claim_expires_at
          FROM reply_drafts WHERE id = ?
        `);
        const before = selectDraft.get(id);
        const operationAt = new Date("2026-07-16T08:05:02.000Z");

        if (operation === "mark_rewriting") {
          expect(() => firstReplies.markRewriting(id, {
            expectedClaimToken: claim.claimToken, at: operationAt,
          })).toThrow(ReviewActionConflictError);
        } else {
          expect(() => firstReplies.complete(id, {
            finalReply: "这条回复必须被保护动作阻止。",
            productAdjusted: false, needsAttention: false, notes: "blocked", attentionReasons: [],
            expectedClaimToken: claim.claimToken, at: operationAt,
          })).toThrow(ReviewActionConflictError);
        }
        expect(selectDraft.get(id)).toEqual(before);
      } finally {
        secondDatabase.close();
        first.database.close();
      }
    },
  );

  it("preserves consecutive failure rounds through a successful classification checkpoint until the full reply succeeds", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const templates = new TemplateRepository(database);
    templates.saveSource({
      library: "good", url: "https://demo.feishu.cn/base/app?table=tbl1",
      appToken: "app", tableId: "tbl1", viewId: null,
    });
    const templateText = "感谢您对音质的认可！";
    const active = templates.activateVersion({
      library: "good", contentHash: "cross-stage-failure-rounds", sourceRecordCount: 1,
      templates: [template("音质音效类", templateText)], warnings: [],
    });
    const { id } = replies.discover({
      sourceKey: "tmall:cross-stage-failure-rounds", orderId: null, review: "音质很好",
      product: "漫步者 X1", reviewedAt: null, sentimentLabel: "positive",
      itemId: null, reviewPhase: "initial",
    });
    const firstDueAt = new Date("2026-07-16T08:05:00.000Z");
    replies.recordAiRetryRoundFailure(id, {
      failedStage: "classification", errorKind: "model_contract", nextRetryAt: firstDueAt,
    });
    const classificationClaim = replies.claimDueAiRetries({ now: firstDueAt, leaseMs: 60_000, limit: 1 });
    expect(replies.saveAiCheckpoint(id, {
      library: "good", primaryCategory: "", category: "音质音效类",
      confidence: 0.94, reason: "明确称赞音质", needsAttention: false,
      templateVersionId: active.versionId, templateSequence: 1, originalTemplate: templateText,
      expectedClaimToken: classificationClaim.claimToken,
      at: new Date("2026-07-16T08:05:01.000Z"),
    })).toMatchObject({
      state: "template_selected",
      consecutiveAiFailureRounds: 1,
    });
    expect(database.prepare("SELECT ai_retry_claim_token FROM reply_drafts WHERE id = ?").get(id))
      .toEqual({ ai_retry_claim_token: classificationClaim.claimToken });
    const rewriteDueAt = new Date("2026-07-16T08:10:00.000Z");
    expect(replies.recordAiRetryRoundFailure(id, {
      failedStage: "rewrite", errorKind: "timeout", nextRetryAt: rewriteDueAt,
      expectedClaimToken: classificationClaim.claimToken,
      at: new Date("2026-07-16T08:05:01.000Z"),
    })).toMatchObject({ consecutiveAiFailureRounds: 2 });
    const rewriteClaim = replies.claimDueAiRetries({ now: rewriteDueAt, leaseMs: 60_000, limit: 1 });
    expect(replies.recordAiRetryRoundFailure(id, {
      failedStage: "rewrite", errorKind: "service_unavailable",
      nextRetryAt: new Date("2026-07-16T08:15:00.000Z"),
      expectedClaimToken: rewriteClaim.claimToken,
      at: new Date("2026-07-16T08:10:01.000Z"),
    })).toMatchObject({ consecutiveAiFailureRounds: 3 });
    database.close();
  });

  it("never schedules configuration failures or returns drafts protected by attempts and action locks", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const gate = new ReviewActionGate(database);
    const createDraft = (sourceKey: string) => replies.discover({
      sourceKey, orderId: null, review: "评价", product: "商品", reviewedAt: null,
      sentimentLabel: "unknown", itemId: null, reviewPhase: "initial",
    });

    const configuration = createDraft("tmall:retry-configuration");
    expect(() => replies.recordAiRetryRoundFailure(configuration.id, {
      failedStage: "classification",
      errorKind: "configuration" as never,
      nextRetryAt: new Date("2026-07-16T08:00:00.000Z"),
    })).toThrow();
    expect(replies.get(configuration.id)).toMatchObject({ state: "discovered", consecutiveAiFailureRounds: 0 });

    const locked = createDraft("tmall:retry-locked");
    gate.acquire("primary", "tmall:retry-locked", "reply");
    expect(() => replies.recordAiRetryRoundFailure(locked.id, {
      failedStage: "classification", errorKind: "timeout",
      nextRetryAt: new Date("2026-07-16T08:00:00.000Z"),
    })).toThrow(ReviewActionConflictError);

    const attempted = createDraft("tmall:retry-attempted");
    replies.complete(attempted.id, {
      finalReply: "感谢您的支持，若有任何疑问欢迎咨询在线客服！",
      productAdjusted: false, needsAttention: false, notes: "", attentionReasons: [],
    });
    const attempt = attempts.prepare(attempted.id, "tmall:retry-attempted").attempt;
    attempts.markSubmitting(attempt.id);
    attempts.markUncertain(attempt.id, "平台响应中断");
    database.prepare(`
      UPDATE reply_drafts
      SET state = 'retry_wait', failed_stage = 'rewrite', ai_retry_error_kind = 'timeout',
          next_retry_at = '2026-07-16T08:00:00.000Z', consecutive_ai_failure_rounds = 1
      WHERE id = ?
    `).run(attempted.id);

    expect(replies.listDueAiRetriesForDiagnostics(new Date("2026-07-16T09:00:00.000Z"))).toEqual([]);
    expect(() => replies.recordAiRetryRoundFailure(attempted.id, {
      failedStage: "rewrite", errorKind: "timeout",
      nextRetryAt: new Date("2026-07-16T09:05:00.000Z"),
    })).toThrow(ReviewActionConflictError);
    database.close();
  });

  it("freezes the resolved review scope and revision on each automation run", async () => {
    const { database } = await createFileDatabase();
    const repository = new AutomationRepository(database);
    const runId = repository.createRun("manual", {
      preset: "last7",
      startDate: "2026-07-09",
      endDate: "2026-07-15",
      timezone: "Asia/Shanghai",
      revision: 7,
    });

    expect(repository.getLastRun()).toMatchObject({
      id: runId,
      scope: {
        preset: "last7",
        startDate: "2026-07-09",
        endDate: "2026-07-15",
        timezone: "Asia/Shanghai",
        revision: 7,
      },
    });
    database.close();
  });

  it("finishes a running automation run only once without overwriting its first result", async () => {
    const { database } = await createFileDatabase();
    const repository = new AutomationRepository(database);
    const runId = repository.createRun("manual", RUN_SCOPE);

    expect(repository.finishRun(runId, {
      state: "completed", processed: 5, succeeded: 3, manual: 1, failed: 1, stopReason: "queue_empty",
    })).toBe(true);
    expect(repository.finishRun(runId, {
      state: "error", processed: 99, succeeded: 0, manual: 0, failed: 99, stopReason: "duplicate_finish",
    })).toBe(false);
    expect(repository.getLastRun()).toMatchObject({
      id: runId,
      state: "completed",
      processed: 5,
      succeeded: 3,
      manual: 1,
      failed: 1,
      stopReason: "queue_empty",
    });
    database.close();
  });

  it("prunes finished run audit after 180 days but protects an active run", async () => {
    const { database } = await createFileDatabase();
    const repository = new AutomationRepository(database);
    const finished = repository.createRun("manual", RUN_SCOPE);
    repository.finishRun(finished, { state: "completed", processed: 1, succeeded: 1, manual: 0, failed: 0, stopReason: "queue_empty" });
    const active = repository.createRun("scheduled", RUN_SCOPE);
    database.prepare("UPDATE automation_runs SET started_at = '2025-01-01T00:00:00.000Z', finished_at = CASE WHEN id = ? THEN '2025-01-01T01:00:00.000Z' ELSE NULL END WHERE id IN (?, ?)")
      .run(finished, finished, active);

    expect(repository.pruneRuns(180, new Date("2026-07-14T00:00:00.000Z"))).toBe(1);
    expect(database.prepare("SELECT id FROM automation_runs").all()).toEqual([{ id: active }]);
    database.close();
  });

  it("keeps locator versions, requires approval for high-risk repairs and supports rollback", async () => {
    const { database } = await createFileDatabase();
    const repository = new LocatorRepository(database);
    repository.ensureDefaults();
    expect(repository.get("review.filter.buyer")).toMatchObject({ risk: "low", selector: "来自买家的评价" });
    expect(repository.get("review.date.trigger")).toMatchObject({ risk: "low", selector: "评价时间" });
    expect(repository.get("review.search")).toMatchObject({ risk: "low", selector: "button:搜索" });
    expect(repository.get("review.pagination.current")).toMatchObject({ risk: "low", strategy: "css" });
    expect(repository.get("login.password")).toMatchObject({ risk: "low", strategy: "placeholder", selector: "请输入登录密码" });
    expect(repository.get("popup.notice.close")).toMatchObject({
      risk: "low",
      strategy: "css",
      selector: "[aria-label='关闭'], [title='关闭'], .next-dialog-close",
    });
    expect(repository.get("reply.open")).toMatchObject({ selector: "评价回复|追评回复" });
    expect(repository.get("reply.submit")).toMatchObject({ risk: "high", selector: "button:提交|确认提交|确认回复|发布|回复|确认|确定" });
    expect(repository.get("reply.success")).toMatchObject({ selector: "已回复|商家回复成功|回复成功" });
    expect(repository.get("complaint.type")).toMatchObject({ risk: "high" });
    expect(repository.get("complaint.description")).toMatchObject({ risk: "high" });
    expect(repository.get("complaint.submit")).toMatchObject({ risk: "high" });

    const repair = repository.proposeRepair({
      operationKey: "reply.submit",
      strategy: "role",
      selector: "button[name='评价回复']",
      evidenceSummary: "唯一匹配1个按钮，影子验证通过",
      validated: true,
    });
    expect(repair.status).toBe("pending_approval");
    const before = repository.get("reply.submit");
    repository.approveRepair(repair.id);
    expect(repository.get("reply.submit")?.version).toBe((before?.version ?? 0) + 1);

    repository.rollback("reply.submit");
    expect(repository.get("reply.submit")?.version).toBe(before?.version);
    database.close();
  });

  it("does not overwrite existing locator versions or create duplicate versions during initialization", async () => {
    const { database } = await createFileDatabase();
    const repository = new LocatorRepository(database);
    repository.ensureDefaults();
    const builtIn = repository.get("reply.open")!;
    database.prepare("UPDATE locator_versions SET selector = '评价回复' WHERE operation_key = 'reply.open' AND status = 'active'").run();
    const repair = repository.proposeRepair({ operationKey: "reply.submit", strategy: "role", selector: "button:安全提交", evidenceSummary: "唯一匹配", validated: true });
    repository.approveRepair(repair.id);
    const versionCountBefore = (database.prepare("SELECT COUNT(*) AS value FROM locator_versions").get() as { value: number }).value;

    repository.ensureDefaults();
    repository.ensureDefaults();

    expect(repository.get("reply.open")).toMatchObject({ version: builtIn.version, selector: "评价回复" });
    expect(repository.get("reply.submit")?.selector).toBe("button:安全提交");
    expect((database.prepare("SELECT COUNT(*) AS value FROM locator_versions").get() as { value: number }).value).toBe(versionCountBefore);
    database.close();
  });

  it("clears stale attention after a high-risk candidate is rejected", async () => {
    const { database } = await createFileDatabase();
    const repository = new LocatorRepository(database);
    repository.ensureDefaults();
    const repair = repository.proposeRepair({
      operationKey: "reply.submit",
      strategy: "role",
      selector: "button:确认回复",
      evidenceSummary: "唯一匹配",
      validated: true,
    });
    repository.markAttention("reply.submit");

    expect(repository.get("reply.submit")?.health).toBe("attention");
    repository.rejectRepair(repair.id);
    expect(repository.get("reply.submit")?.health).toBe("healthy");

    repository.markAttention("reply.submit");
    repository.ensureDefaults();
    expect(repository.get("reply.submit")?.health).toBe("healthy");
    database.close();
  });

  it("replaces the obsolete broad built-in popup close selector on existing databases", async () => {
    const { database } = await createFileDatabase();
    const repository = new LocatorRepository(database);
    repository.ensureDefaults();
    database.prepare(`
      UPDATE locator_versions
      SET selector = '[aria-label=''关闭''], [title=''关闭''], .next-dialog-close, [class*=''close'']'
      WHERE id = (SELECT current_version_id FROM locator_rules WHERE operation_key = 'popup.notice.close')
    `).run();

    repository.ensureDefaults();

    expect(repository.get("popup.notice.close")?.selector).toBe("[aria-label='关闭'], [title='关闭'], .next-dialog-close");
    database.close();
  });

  it("preserves the legacy login password locator in an existing database", async () => {
    const { database } = await createFileDatabase();
    const repository = new LocatorRepository(database);
    repository.ensureDefaults();
    database.prepare("UPDATE locator_versions SET selector = '登录密码' WHERE operation_key = 'login.password' AND status = 'active'").run();

    repository.ensureDefaults();

    expect(repository.get("login.password")).toMatchObject({ version: 1, selector: "登录密码" });
    database.close();
  });

  it("auto-applies a validated low-risk locator candidate and rejects an unvalidated one", async () => {
    const { database } = await createFileDatabase();
    const repository = new LocatorRepository(database);
    repository.ensureDefaults();
    expect(repository.proposeRepair({ operationKey: "review.pagination", strategy: "role", selector: "button[name='下一页']", evidenceSummary: "唯一匹配", validated: true }).status).toBe("auto_applied");
    expect(repository.get("review.pagination")?.health).toBe("recovered");
    expect(repository.proposeRepair({ operationKey: "review.pagination", strategy: "css", selector: ".unknown", evidenceSummary: "匹配0个", validated: false }).status).toBe("rejected");
    database.close();
  });

  it("retains sanitized locator snapshots for seven days and bounds rejected version history", async () => {
    const { database } = await createFileDatabase();
    const repository = new LocatorRepository(database);
    repository.ensureDefaults();
    repository.saveSnapshot("navigation.trade", '[{"tag":"button","name":"[已隐藏]"}]');
    database.prepare("UPDATE locator_snapshots SET created_at = '2026-07-01T00:00:00.000Z'").run();
    for (let index = 0; index < 15; index += 1) {
      repository.proposeRepair({ operationKey: "navigation.trade", strategy: "css", selector: `.candidate-${index}`, evidenceSummary: "未通过", validated: false });
    }

    expect(repository.pruneSnapshots(7, new Date("2026-07-14T00:00:00.000Z"))).toBe(1);
    expect(repository.snapshotCount()).toBe(0);
    expect((database.prepare("SELECT COUNT(*) AS value FROM locator_versions WHERE operation_key = 'navigation.trade'").get() as { value: number }).value).toBeLessThanOrEqual(11);
    database.close();
  });

  it("only rolls back the repair version that is currently active", async () => {
    const { database } = await createFileDatabase();
    const repository = new LocatorRepository(database);
    repository.ensureDefaults();
    const first = repository.proposeRepair({ operationKey: "review.pagination", strategy: "css", selector: ".next-v2", evidenceSummary: "唯一匹配", validated: true });
    const second = repository.proposeRepair({ operationKey: "review.pagination", strategy: "css", selector: ".next-v3", evidenceSummary: "唯一匹配", validated: true });

    expect(repository.getRepair(first.id)).toMatchObject({ canRollback: false });
    expect(repository.getRepair(second.id)).toMatchObject({ canRollback: true });
    expect(repository.rollbackRepair(first.id)).toBeNull();
    expect(repository.rollbackRepair(second.id)).toMatchObject({ status: "rolled_back" });
    expect(repository.getRepair(second.id)).toMatchObject({ canRollback: false });
    expect(repository.get("review.pagination")?.selector).toBe(".next-v2");
    database.close();
  });

  it("enforces one durable submission attempt per Tmall source key", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const draft = replies.discover({ sourceKey: "tmall:unique-submit", orderId: "1", review: "很好", product: "耳机", reviewedAt: null, sentimentLabel: "positive", itemId: null, reviewPhase: "initial" });
    replies.complete(draft.id, { finalReply: "感谢您的支持，若有任何疑问欢迎咨询在线客服！", productAdjusted: false, needsAttention: false, notes: "", attentionReasons: [] });
    const first = attempts.prepare(draft.id, "tmall:unique-submit");
    expect(first.created).toBe(true);
    attempts.markSubmitting(first.attempt.id);
    attempts.markUncertain(first.attempt.id, "提交后响应中断");

    const duplicate = attempts.prepare(draft.id, "tmall:unique-submit");
    expect(duplicate.created).toBe(false);
    expect(duplicate.attempt.state).toBe("submission_uncertain");
    database.close();
  });

  it("allows a proven pre-submit failure to retry but never reopens an uncertain attempt", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const draft = replies.discover({ sourceKey: "tmall:safe-retry", orderId: "1", review: "很好", product: "耳机", reviewedAt: null, sentimentLabel: "positive", itemId: null, reviewPhase: "initial" });
    replies.complete(draft.id, { finalReply: "感谢您的支持，若有任何疑问欢迎咨询在线客服！", productAdjusted: false, needsAttention: false, notes: "", attentionReasons: [] });
    const first = attempts.prepare(draft.id, "tmall:safe-retry");
    attempts.markSubmitting(first.attempt.id);
    attempts.markPreSubmitFailed(first.attempt.id, "ELEMENT_NOT_FOUND", "回复框无法识别");

    const retry = attempts.prepare(draft.id, "tmall:safe-retry");
    expect(retry.created).toBe(true);
    expect(retry.attempt.state).toBe("pending");
    expect(replies.get(draft.id)?.state).toBe("read_only_ready");
    attempts.markSubmitting(retry.attempt.id);
    attempts.markUncertain(retry.attempt.id, "点击后响应中断");
    expect(attempts.prepare(draft.id, "tmall:safe-retry")).toMatchObject({ created: false, attempt: { state: "submission_uncertain" } });
    database.close();
  });

  it("recovers interrupted pending and submitting attempts without risking a duplicate reply", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const gate = new ReviewActionGate(database);
    const createReadyDraft = (sourceKey: string) => {
      const draft = replies.discover({
        sourceKey,
        orderId: sourceKey,
        review: "很好",
        product: "耳机",
        reviewedAt: null,
        sentimentLabel: "positive",
        itemId: "item-1",
        reviewPhase: "initial",
      });
      replies.complete(draft.id, {
        finalReply: "感谢您的支持，若有任何疑问欢迎咨询在线客服！",
        productAdjusted: false,
        needsAttention: false,
        notes: "",
        attentionReasons: [],
      });
      return draft;
    };

    const pendingSourceKey = "tmall:restart:pending";
    const pendingDraft = createReadyDraft(pendingSourceKey);
    const pending = attempts.prepare(pendingDraft.id, pendingSourceKey).attempt;
    const submittingSourceKey = "tmall:restart:submitting";
    const submittingDraft = createReadyDraft(submittingSourceKey);
    const submitting = attempts.prepare(submittingDraft.id, submittingSourceKey).attempt;
    attempts.markSubmitting(submitting.id);
    const alreadyUncertainSourceKey = "tmall:restart:uncertain";
    const alreadyUncertainDraft = createReadyDraft(alreadyUncertainSourceKey);
    const alreadyUncertain = attempts.prepare(alreadyUncertainDraft.id, alreadyUncertainSourceKey).attempt;
    attempts.markSubmitting(alreadyUncertain.id);
    attempts.markUncertain(alreadyUncertain.id, "原有待核对记录");

    expect(attempts.recoverInterrupted(new Date("2026-07-16T10:00:00.000Z"))).toEqual({
      releasedPending: 1,
      markedUncertain: 1,
    });

    expect(attempts.get(pending.id)).toMatchObject({
      state: "failed",
      errorCode: "PROCESS_INTERRUPTED_BEFORE_SUBMIT",
    });
    expect(replies.get(pendingDraft.id)?.state).toBe("read_only_ready");
    expect(gate.getLock("primary", pendingSourceKey)).toBeNull();

    expect(attempts.get(submitting.id)).toMatchObject({
      state: "submission_uncertain",
      errorCode: "SUBMISSION_INTERRUPTED",
    });
    expect(replies.get(submittingDraft.id)?.state).toBe("submission_uncertain");
    expect(gate.getLock("primary", submittingSourceKey)).toMatchObject({ actionKind: "reply" });
    expect(attempts.get(alreadyUncertain.id)).toMatchObject({
      state: "submission_uncertain",
      evidence: "原有待核对记录",
    });

    expect(attempts.unresolvedCount()).toBe(2);
    expect(attempts.recoverInterrupted(new Date("2026-07-16T10:01:00.000Z"))).toEqual({
      releasedPending: 0,
      markedUncertain: 0,
    });
    database.close();
  });

  it("keeps 180-day submission audit after its 90-day review content is cleaned", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const attempts = new ReplyAttemptRepository(database);
    const draft = replies.discover({ sourceKey: "tmall:retained-audit", orderId: "1", review: "旧评论内容", product: "耳机", reviewedAt: null, sentimentLabel: "positive", itemId: null, reviewPhase: "initial" });
    replies.complete(draft.id, { finalReply: "感谢您的支持，若有任何疑问欢迎咨询在线客服！", productAdjusted: false, needsAttention: false, notes: "", attentionReasons: [] });
    const attempt = attempts.prepare(draft.id, "tmall:retained-audit").attempt;
    attempts.markSubmitting(attempt.id);
    attempts.markSent(attempt.id, "平台显示已回复");
    database.prepare("UPDATE reply_drafts SET discovered_at = '2025-01-01T00:00:00.000Z' WHERE id = ?").run(draft.id);

    expect(replies.pruneOlderThan(90, new Date("2026-07-14T00:00:00.000Z"))).toBe(1);
    expect(replies.get(draft.id)).toBeNull();
    expect(attempts.get(attempt.id)).toMatchObject({ sourceKey: "tmall:retained-audit", replyDraftId: null, state: "sent" });
    database.close();
  });

  it("ordinary cleanup protects active and uncertain reply records", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const active = replies.discover({ sourceKey: "active", orderId: null, review: "处理中", product: "耳机", reviewedAt: null, sentimentLabel: "unknown", itemId: null, reviewPhase: "initial" });
    const uncertain = replies.discover({ sourceKey: "uncertain", orderId: null, review: "待核对", product: "耳机", reviewedAt: null, sentimentLabel: "unknown", itemId: null, reviewPhase: "initial" });
    database.prepare("UPDATE reply_drafts SET state = 'submission_uncertain', discovered_at = '2025-01-01T00:00:00.000Z' WHERE id = ?").run(uncertain.id);
    database.prepare("UPDATE reply_drafts SET discovered_at = '2025-01-01T00:00:00.000Z' WHERE id = ?").run(active.id);

    expect(replies.pruneOlderThan(90, new Date("2026-07-14T00:00:00.000Z"))).toBe(0);
    expect(replies.list()).toHaveLength(2);
    database.close();
  });

  it("counts every manual diversion without the default reply-list limit", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    const manualStates = ["manual_product_hold", "manual_hold_expired", "not_actionable"] as const;
    for (let index = 0; index < 205; index += 1) {
      const draft = replies.discover({
        sourceKey: `tmall:manual-count:${index}`,
        orderId: String(index),
        review: `Manual review ${index}`,
        product: `Product ${index}`,
        reviewedAt: "2026-07-15 08:00",
        sentimentLabel: "negative",
        itemId: String(index),
        reviewPhase: "initial",
      });
      database.prepare("UPDATE reply_drafts SET state = ? WHERE id = ?").run(manualStates[index % manualStates.length], draft.id);
    }

    expect(replies.list()).toHaveLength(200);
    expect(replies.countByStates(manualStates)).toBe(205);
    expect(replies.manualDiversionCount()).toBe(205);
    database.close();
  });

  it("paginates and filters every retained reply beyond the legacy 200-row display limit", async () => {
    const { database } = await createFileDatabase();
    const replies = new ReplyRepository(database);
    for (let index = 0; index < 205; index += 1) {
      const draft = replies.discover({
        sourceKey: `tmall:reply-page:${index}`,
        orderId: String(index),
        review: index === 204 ? "Needle review for complete search" : `Review ${index}`,
        product: `Product ${index}`,
        reviewedAt: "2026-07-15 08:00",
        sentimentLabel: index % 2 === 0 ? "positive" : "negative",
        itemId: String(index),
        reviewPhase: "initial",
      });
      database.prepare(`
        UPDATE reply_drafts
        SET state = ?, library = ?, primary_category = ?, category = ?,
            discovered_at = ?
        WHERE id = ?
      `).run(
        index % 2 === 0 ? "sent" : "failed",
        index % 2 === 0 ? "good" : "bad",
        index % 2 === 0 ? "Positive" : "Negative",
        index % 2 === 0 ? "Sound" : "Service",
        new Date(Date.UTC(2026, 6, 15, 0, index)).toISOString(),
        draft.id,
      );
    }

    expect(replies.listPage({ page: 5, pageSize: 50, filter: "all", query: "" })).toMatchObject({
      total: 205,
      overallTotal: 205,
      page: 5,
      pageSize: 50,
      totalPages: 5,
      items: expect.arrayContaining([expect.objectContaining({ review: "Review 0" })]),
    });
    expect(replies.listPage({ page: 99, pageSize: 50, filter: "all", query: "" })).toMatchObject({
      page: 5,
      totalPages: 5,
    });
    expect(replies.listPage({ page: 1, pageSize: 50, filter: "sent", query: "" })).toMatchObject({
      total: 103,
      overallTotal: 205,
    });
    expect(replies.listPage({ page: 1, pageSize: 50, filter: "unsent", query: "" })).toMatchObject({
      total: 102,
      overallTotal: 205,
    });
    expect(replies.listPage({ page: 1, pageSize: 50, filter: "bad", query: "needle" })).toMatchObject({
      total: 0,
      overallTotal: 205,
      items: [],
    });
    expect(replies.listPage({ page: 1, pageSize: 50, filter: "good", query: "needle" })).toMatchObject({
      total: 1,
      overallTotal: 205,
      items: [expect.objectContaining({ review: "Needle review for complete search" })],
    });
    database.close();
  });
});
