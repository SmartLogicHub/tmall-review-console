import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type AppDatabase = Database.Database;

export function openDatabase(path: string): AppDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (path !== ":memory:") {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
  }
  return database;
}

const MIGRATIONS = [
  `
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS template_sources (
      library TEXT PRIMARY KEY CHECK (library IN ('good', 'bad')),
      url TEXT NOT NULL,
      app_token TEXT NOT NULL,
      table_id TEXT NOT NULL,
      view_id TEXT,
      status TEXT NOT NULL DEFAULT 'not_configured',
      active_version_id INTEGER,
      last_tested_at TEXT,
      last_synced_at TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (active_version_id) REFERENCES template_versions(id)
    );

    CREATE TABLE IF NOT EXISTS template_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_record_count INTEGER NOT NULL,
      category_count INTEGER NOT NULL,
      reply_count INTEGER NOT NULL,
      warnings_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      activated_at TEXT NOT NULL,
      UNIQUE (library, content_hash),
      FOREIGN KEY (library) REFERENCES template_sources(library) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS template_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER NOT NULL,
      row_index INTEGER NOT NULL,
      primary_category TEXT NOT NULL,
      category TEXT NOT NULL,
      keywords_json TEXT NOT NULL,
      UNIQUE (version_id, category),
      FOREIGN KEY (version_id) REFERENCES template_versions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS template_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      text TEXT NOT NULL,
      UNIQUE (category_id, sequence),
      FOREIGN KEY (category_id) REFERENCES template_categories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS operation_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      target TEXT NOT NULL,
      result TEXT NOT NULL,
      error_code TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_template_versions_library_created
      ON template_versions(library, id DESC);
    CREATE INDEX IF NOT EXISTS idx_template_categories_version
      ON template_categories(version_id, row_index);
  `,
  `
    CREATE TABLE IF NOT EXISTS reply_drafts (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      order_id TEXT,
      review_text TEXT NOT NULL,
      product_title TEXT NOT NULL,
      reviewed_at TEXT,
      sentiment_label TEXT NOT NULL CHECK (sentiment_label IN ('positive', 'negative', 'neutral', 'unknown')),
      library TEXT CHECK (library IN ('good', 'bad')),
      primary_category TEXT,
      category TEXT,
      classification_confidence REAL,
      classification_reason TEXT,
      template_version_id INTEGER,
      template_sequence INTEGER,
      original_template TEXT,
      final_reply TEXT,
      product_adjusted INTEGER NOT NULL DEFAULT 0,
      rewrite_notes TEXT,
      attention_reasons_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      discovered_at TEXT NOT NULL,
      processed_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (template_version_id) REFERENCES template_versions(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_reply_drafts_discovered
      ON reply_drafts(discovered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reply_drafts_state
      ON reply_drafts(state, updated_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS automation_plan (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      interval_minutes INTEGER NOT NULL DEFAULT 15,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedule_windows (
      id TEXT PRIMARY KEY,
      plan_id INTEGER NOT NULL DEFAULT 1,
      start_minute INTEGER NOT NULL,
      end_minute INTEGER NOT NULL,
      sort_order INTEGER NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES automation_plan(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      trigger_type TEXT NOT NULL CHECK (trigger_type IN ('scheduled', 'manual')),
      state TEXT NOT NULL,
      processed_count INTEGER NOT NULL DEFAULT 0,
      succeeded_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      stop_reason TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_automation_runs_started ON automation_runs(started_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS locator_rules (
      operation_key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      risk TEXT NOT NULL CHECK (risk IN ('low', 'high')),
      health TEXT NOT NULL CHECK (health IN ('healthy', 'recovered', 'attention')),
      current_version_id INTEGER,
      last_success_at TEXT,
      last_failure_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS locator_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      strategy TEXT NOT NULL,
      selector TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      UNIQUE(operation_key, version),
      FOREIGN KEY(operation_key) REFERENCES locator_rules(operation_key) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS locator_repairs (
      id TEXT PRIMARY KEY,
      operation_key TEXT NOT NULL,
      risk TEXT NOT NULL,
      status TEXT NOT NULL,
      candidate_version_id INTEGER,
      evidence_summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY(operation_key) REFERENCES locator_rules(operation_key) ON DELETE CASCADE,
      FOREIGN KEY(candidate_version_id) REFERENCES locator_versions(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_locator_versions_operation ON locator_versions(operation_key, version DESC);
    CREATE INDEX IF NOT EXISTS idx_locator_repairs_created ON locator_repairs(created_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS reply_attempts (
      id TEXT PRIMARY KEY,
      reply_draft_id TEXT NOT NULL,
      source_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      evidence TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      submitted_at TEXT,
      verified_at TEXT,
      FOREIGN KEY(reply_draft_id) REFERENCES reply_drafts(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_reply_attempts_state ON reply_attempts(state, updated_at DESC);
  `,
  `
    CREATE TABLE reply_attempts_v2 (
      id TEXT PRIMARY KEY,
      reply_draft_id TEXT,
      source_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      evidence TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      submitted_at TEXT,
      verified_at TEXT,
      FOREIGN KEY(reply_draft_id) REFERENCES reply_drafts(id) ON DELETE SET NULL
    );

    INSERT INTO reply_attempts_v2 SELECT * FROM reply_attempts;
    DROP TABLE reply_attempts;
    ALTER TABLE reply_attempts_v2 RENAME TO reply_attempts;
    CREATE INDEX idx_reply_attempts_state ON reply_attempts(state, updated_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS locator_snapshots (
      id TEXT PRIMARY KEY,
      operation_key TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(operation_key) REFERENCES locator_rules(operation_key) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_locator_snapshots_created ON locator_snapshots(created_at DESC);
  `,
  `
    ALTER TABLE reply_drafts ADD COLUMN detected_template_products_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE reply_drafts ADD COLUMN unsupported_claims_json TEXT NOT NULL DEFAULT '[]';
  `,
  `
    CREATE TABLE review_scope (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      preset TEXT NOT NULL CHECK (preset IN ('today', 'yesterday', 'last7', 'last30', 'custom')),
      custom_start_date TEXT,
      custom_end_date TEXT,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai' CHECK (timezone = 'Asia/Shanghai'),
      revision INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(revision) = 'integer' AND revision >= 1),
      updated_at TEXT NOT NULL,
      CHECK (
        (preset = 'custom' AND custom_start_date IS NOT NULL AND custom_end_date IS NOT NULL)
        OR
        (preset <> 'custom' AND custom_start_date IS NULL AND custom_end_date IS NULL)
      )
    );

    INSERT INTO review_scope(
      id, preset, custom_start_date, custom_end_date, timezone, revision, updated_at
    ) VALUES (
      1, 'last7', NULL, NULL, 'Asia/Shanghai', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );

    CREATE TABLE manual_product_catalog_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(revision) = 'integer' AND revision >= 1),
      last_import_at TEXT,
      updated_at TEXT NOT NULL
    );

    INSERT INTO manual_product_catalog_state(id, revision, last_import_at, updated_at)
    VALUES (1, 1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

    CREATE TABLE manual_products (
      id TEXT PRIMARY KEY,
      item_id TEXT,
      product_title TEXT NOT NULL CHECK (length(trim(product_title)) > 0),
      normalized_title TEXT NOT NULL CHECK (length(trim(normalized_title)) > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_matched_at TEXT
    );

    CREATE UNIQUE INDEX idx_manual_products_item_id
      ON manual_products(item_id)
      WHERE item_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_manual_products_unidentified_title
      ON manual_products(normalized_title)
      WHERE item_id IS NULL;

    CREATE TABLE manual_product_memberships (
      product_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('manual', 'excel')),
      created_at TEXT NOT NULL,
      PRIMARY KEY(product_id, source),
      FOREIGN KEY(product_id) REFERENCES manual_products(id) ON DELETE CASCADE
    );

    CREATE TABLE review_action_locks (
      store_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      action_kind TEXT NOT NULL CHECK (action_kind IN ('manual_hold', 'complaint', 'reply')),
      lock_version INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(lock_version) = 'integer' AND lock_version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(store_id, source_key)
    );

    CREATE INDEX idx_review_action_locks_action_kind
      ON review_action_locks(action_kind);
    CREATE INDEX idx_review_action_locks_updated_at
      ON review_action_locks(updated_at);

    CREATE TABLE review_action_tombstones (
      store_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      terminal_action TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      PRIMARY KEY(store_id, source_key)
    );

    CREATE INDEX idx_review_action_tombstones_completed_at
      ON review_action_tombstones(completed_at);

    ALTER TABLE reply_drafts ADD COLUMN item_id TEXT;
    ALTER TABLE reply_drafts ADD COLUMN review_phase TEXT NOT NULL DEFAULT 'initial'
      CHECK (review_phase IN ('initial', 'followup'));
    ALTER TABLE reply_drafts ADD COLUMN manual_product_id TEXT
      REFERENCES manual_products(id) ON DELETE SET NULL;
    ALTER TABLE reply_drafts ADD COLUMN manual_hold_reason TEXT;
    ALTER TABLE reply_drafts ADD COLUMN manual_catalog_revision INTEGER
      CHECK (
        manual_catalog_revision IS NULL
        OR (typeof(manual_catalog_revision) = 'integer' AND manual_catalog_revision >= 1)
      );
    ALTER TABLE reply_drafts ADD COLUMN manual_match_kind TEXT;
    ALTER TABLE reply_drafts ADD COLUMN manual_hold_last_seen_at TEXT;
    ALTER TABLE reply_drafts ADD COLUMN manual_hold_absent_scans INTEGER NOT NULL DEFAULT 0
      CHECK (
        typeof(manual_hold_absent_scans) = 'integer'
        AND manual_hold_absent_scans >= 0
      );

    ALTER TABLE automation_runs ADD COLUMN scope_preset TEXT;
    ALTER TABLE automation_runs ADD COLUMN scope_start_date TEXT;
    ALTER TABLE automation_runs ADD COLUMN scope_end_date TEXT;
    ALTER TABLE automation_runs ADD COLUMN scope_revision INTEGER
      CHECK (
        scope_revision IS NULL
        OR (typeof(scope_revision) = 'integer' AND scope_revision >= 1)
      );
    ALTER TABLE automation_runs ADD COLUMN scope_timezone TEXT;

    ALTER TABLE reply_attempts ADD COLUMN action_lock_version INTEGER
      CHECK (
        action_lock_version IS NULL
        OR (typeof(action_lock_version) = 'integer' AND action_lock_version >= 1)
      );

    INSERT OR IGNORE INTO review_action_tombstones(
      store_id, source_key, terminal_action, completed_at
    )
    SELECT
      'primary', source_key, 'reply_sent',
      COALESCE(verified_at, submitted_at, updated_at, created_at)
    FROM reply_attempts
    WHERE state = 'sent';

    INSERT OR IGNORE INTO review_action_locks(
      store_id, source_key, action_kind, lock_version, created_at, updated_at
    )
    SELECT 'primary', source_key, 'reply', 1, created_at, updated_at
    FROM reply_attempts
    WHERE state IN ('pending', 'submitting', 'submission_uncertain');

    UPDATE reply_attempts
    SET action_lock_version = 1
    WHERE state IN ('pending', 'submitting', 'submission_uncertain')
      AND action_lock_version IS NULL;
  `,
  `
    ALTER TABLE automation_runs ADD COLUMN manual_count INTEGER NOT NULL DEFAULT 0
      CHECK (
        typeof(manual_count) = 'integer'
        AND manual_count >= 0
      );
  `,
  `
    ALTER TABLE reply_drafts ADD COLUMN ai_checkpoint_stage TEXT
      CHECK (ai_checkpoint_stage IS NULL OR ai_checkpoint_stage = 'template_selected');
    ALTER TABLE reply_drafts ADD COLUMN failed_stage TEXT
      CHECK (failed_stage IS NULL OR failed_stage IN ('classification', 'rewrite'));
    ALTER TABLE reply_drafts ADD COLUMN ai_retry_error_kind TEXT
      CHECK (
        ai_retry_error_kind IS NULL
        OR ai_retry_error_kind IN (
          'network', 'timeout', 'rate_limited', 'service_unavailable',
          'model_contract', 'transient_unknown'
        )
      );
    ALTER TABLE reply_drafts ADD COLUMN next_retry_at TEXT;
    ALTER TABLE reply_drafts ADD COLUMN consecutive_ai_failure_rounds INTEGER NOT NULL DEFAULT 0
      CHECK (
        typeof(consecutive_ai_failure_rounds) = 'integer'
        AND consecutive_ai_failure_rounds >= 0
      );

    CREATE INDEX idx_reply_drafts_ai_retry_due
      ON reply_drafts(state, next_retry_at);
  `,
  `
    ALTER TABLE reply_drafts ADD COLUMN ai_retry_claim_token TEXT;
    ALTER TABLE reply_drafts ADD COLUMN ai_retry_claim_expires_at TEXT;

    CREATE INDEX idx_reply_drafts_ai_retry_claim
      ON reply_drafts(state, ai_retry_claim_expires_at);
  `,
  `
    CREATE TABLE IF NOT EXISTS complaint_cases (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'analyzing', 'no_complaint', 'prepared', 'manual_action_required',
        'failed', 'submitting', 'submitted', 'submission_uncertain'
      )),
      complaint_type TEXT,
      fact_code TEXT,
      quote_text TEXT,
      confidence INTEGER,
      reason TEXT,
      description TEXT,
      action_lock_version INTEGER,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      prepared_at TEXT,
      submitted_at TEXT,
      UNIQUE(store_id, source_key)
    );

    CREATE TABLE IF NOT EXISTS complaint_attempts (
      id TEXT PRIMARY KEY,
      complaint_case_id TEXT NOT NULL UNIQUE,
      store_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'submitting', 'submitted', 'failed', 'submission_uncertain')),
      action_lock_version INTEGER NOT NULL,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      submitted_at TEXT,
      verified_at TEXT,
      UNIQUE(store_id, source_key),
      FOREIGN KEY(complaint_case_id) REFERENCES complaint_cases(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS complaint_events (
      id TEXT PRIMARY KEY,
      complaint_case_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(complaint_case_id) REFERENCES complaint_cases(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_complaint_cases_state_updated
      ON complaint_cases(state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_complaint_events_case_created
      ON complaint_events(complaint_case_id, created_at ASC);
  `,
  `
    CREATE TABLE complaint_cases_v2 (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'discovered', 'analyzing', 'no_complaint', 'prepared', 'submitting', 'submitted',
        'under_review', 'upheld', 'rejected', 'closed', 'not_actionable',
        'submission_uncertain', 'retry_wait', 'manual_action_required', 'failed'
      )),
      content_hash TEXT,
      review_phase TEXT CHECK (review_phase IN ('initial', 'followup')),
      image_hashes_json TEXT NOT NULL DEFAULT '[]',
      prompt_version TEXT,
      rule_version TEXT,
      mapping_version TEXT,
      complaint_type TEXT,
      fact_code TEXT,
      quote_text TEXT,
      confidence INTEGER,
      reason TEXT,
      description TEXT,
      action_lock_version INTEGER,
      platform_case_id TEXT,
      platform_detail_url TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      prepared_at TEXT,
      submitted_at TEXT,
      result_observed_at TEXT,
      UNIQUE(store_id, source_key)
    );
    INSERT INTO complaint_cases_v2(
      id, store_id, source_key, state, complaint_type, fact_code, quote_text, confidence,
      reason, description, action_lock_version, error_code, error_message, created_at, updated_at,
      prepared_at, submitted_at
    ) SELECT id, store_id, source_key,
      CASE state WHEN 'analyzing' THEN 'discovered' ELSE state END,
      complaint_type, fact_code, quote_text, confidence, reason, description, action_lock_version,
      error_code, error_message, created_at, updated_at, prepared_at, submitted_at
    FROM complaint_cases;
    DROP TABLE complaint_cases;
    ALTER TABLE complaint_cases_v2 RENAME TO complaint_cases;

    CREATE TABLE complaint_attempts_v2 (
      id TEXT PRIMARY KEY,
      complaint_case_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('intent_saved', 'click_started', 'click_finished', 'submitted', 'failed', 'submission_uncertain')),
      action_lock_version INTEGER NOT NULL,
      intent_saved_at TEXT NOT NULL,
      click_started_at TEXT,
      click_finished_at TEXT,
      platform_case_id TEXT,
      platform_detail_url TEXT,
      result_observed_at TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      submitted_at TEXT,
      verified_at TEXT,
      FOREIGN KEY(complaint_case_id) REFERENCES complaint_cases(id) ON DELETE RESTRICT
    );
    INSERT INTO complaint_attempts_v2(
      id, complaint_case_id, store_id, source_key, state, action_lock_version, intent_saved_at,
      error_code, error_message, created_at, updated_at, submitted_at, verified_at
    ) SELECT id, complaint_case_id, store_id, source_key,
      CASE state WHEN 'prepared' THEN 'intent_saved' WHEN 'submitting' THEN 'click_started' ELSE state END,
      action_lock_version, created_at, error_code, error_message, created_at, updated_at, submitted_at, verified_at
    FROM complaint_attempts;
    DROP TABLE complaint_attempts;
    ALTER TABLE complaint_attempts_v2 RENAME TO complaint_attempts;
    CREATE UNIQUE INDEX idx_complaint_attempts_active_case
      ON complaint_attempts(complaint_case_id)
      WHERE state IN ('intent_saved', 'click_started', 'click_finished', 'submission_uncertain');
    CREATE INDEX idx_complaint_cases_state_updated ON complaint_cases(state, updated_at DESC);
  `,
  `
    ALTER TABLE complaint_cases ADD COLUMN review_id TEXT;
    ALTER TABLE complaint_cases ADD COLUMN canonicalizer_version TEXT;
    ALTER TABLE complaint_cases ADD COLUMN image_pairs_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE complaint_cases ADD COLUMN visual_version TEXT;
    ALTER TABLE complaint_cases ADD COLUMN platform_mapping_version TEXT;
    ALTER TABLE complaint_cases ADD COLUMN model_version TEXT;
  `,
  `
    ALTER TABLE complaint_cases ADD COLUMN fact_description TEXT;
    ALTER TABLE complaint_cases ADD COLUMN validation_facts_json TEXT;
    ALTER TABLE complaint_cases ADD COLUMN model_result_json TEXT;
    ALTER TABLE complaint_cases ADD COLUMN description_builder_version TEXT;
  `,
  `
    CREATE TABLE complaint_analysis_invocations (
      id TEXT NOT NULL,
      complaint_case_id TEXT NOT NULL,
      analysis_pass TEXT NOT NULL CHECK (analysis_pass IN ('primary','independent_review','adjudication')),
      result_digest TEXT NOT NULL CHECK (length(result_digest) = 64),
      created_at TEXT NOT NULL,
      PRIMARY KEY(complaint_case_id, id),
      FOREIGN KEY(complaint_case_id) REFERENCES complaint_cases(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_complaint_analysis_invocations_case_pass
      ON complaint_analysis_invocations(complaint_case_id, analysis_pass, created_at);
  `,
] as const;

export function runMigrations(database: AppDatabase, targetVersion = MIGRATIONS.length): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    database.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: number }).version),
  );
  const apply = database.transaction((version: number, sql: string) => {
    database.exec(sql);
    database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
  });
  MIGRATIONS.forEach((sql, index) => {
    const version = index + 1;
    if (version <= targetVersion && !applied.has(version)) apply(version, sql);
  });
}
