import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

function stateCounts(database, tableName) {
  return Object.fromEntries(
    database
      .prepare(`SELECT state, COUNT(*) AS count FROM ${tableName} GROUP BY state ORDER BY state`)
      .all()
      .map((row) => [row.state, Number(row.count)]),
  );
}

function assertRequiredTables(database) {
  const required = [
    "reply_drafts",
    "reply_attempts",
    "review_action_locks",
    "review_action_tombstones",
    "complaint_cases",
    "complaint_attempts",
    "complaint_events",
    "complaint_analysis_invocations",
  ];
  const existing = new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  const missing = required.filter((tableName) => !existing.has(tableName));
  if (missing.length > 0) {
    throw new Error(`数据库缺少必要数据表：${missing.join("、")}`);
  }
}

function assertIntegrity(database, label) {
  const integrity = database.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    throw new Error(`${label}完整性检查失败：${String(integrity)}`);
  }
}

function optionalResetAssignments(database) {
  const columns = new Set(
    database.pragma("table_info(reply_drafts)").map((column) => column.name),
  );
  return [
    ["ai_checkpoint_stage", "NULL"],
    ["failed_stage", "NULL"],
    ["ai_retry_error_kind", "NULL"],
    ["next_retry_at", "NULL"],
    ["consecutive_ai_failure_rounds", "0"],
    ["ai_retry_claim_token", "NULL"],
    ["ai_retry_claim_expires_at", "NULL"],
  ]
    .filter(([column]) => columns.has(column))
    .map(([column, value]) => `${column} = ${value}`);
}

export async function correctImportedReplyHistory({
  sourcePath,
  outputPath,
  correctionAt = new Date().toISOString(),
  reportPath,
}) {
  if (!sourcePath || !outputPath) {
    throw new Error("必须提供源数据库和输出数据库路径");
  }
  const resolvedSource = path.resolve(sourcePath);
  const resolvedOutput = path.resolve(outputPath);
  if (resolvedSource.toLocaleLowerCase() === resolvedOutput.toLocaleLowerCase()) {
    throw new Error("源数据库和输出数据库不能是同一个文件");
  }
  if (!existsSync(resolvedSource)) {
    throw new Error(`源数据库不存在：${resolvedSource}`);
  }
  if (existsSync(resolvedOutput)) {
    throw new Error(`输出文件已存在：${resolvedOutput}`);
  }
  if (reportPath && existsSync(path.resolve(reportPath))) {
    throw new Error(`校正报告已存在：${path.resolve(reportPath)}`);
  }

  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  let source;
  let corrected;
  try {
    source = new Database(resolvedSource, { readonly: true, fileMustExist: true });
    assertRequiredTables(source);
    assertIntegrity(source, "源数据库");
    const before = {
      replyDraftsByState: stateCounts(source, "reply_drafts"),
      replyAttemptsByState: stateCounts(source, "reply_attempts"),
      complaintCasesByState: stateCounts(source, "complaint_cases"),
    };
    const convertedFailed = Number(
      source.prepare("SELECT COUNT(*) AS count FROM reply_drafts WHERE state = 'failed'").get().count,
    );
    const deletedNotSuccessful = Number(
      source
        .prepare("SELECT COUNT(*) AS count FROM reply_drafts WHERE state NOT IN ('sent', 'failed')")
        .get().count,
    );
    const deletedComplaintCases = Number(
      source.prepare(`
        SELECT COUNT(*) AS count
        FROM complaint_cases
        WHERE state NOT IN ('submitted', 'under_review', 'upheld', 'rejected', 'closed')
      `).get().count,
    );

    await source.backup(resolvedOutput);
    source.close();
    source = undefined;

    corrected = new Database(resolvedOutput, { fileMustExist: true });
    assertRequiredTables(corrected);
    assertIntegrity(corrected, "备份数据库");
    const resetAssignments = optionalResetAssignments(corrected);

    corrected.transaction(() => {
      corrected.exec(`
        CREATE TEMP TABLE correction_removed_complaints (
          id TEXT PRIMARY KEY,
          source_key TEXT NOT NULL
        );
        INSERT INTO correction_removed_complaints(id, source_key)
        SELECT id, source_key
        FROM complaint_cases
        WHERE state NOT IN ('submitted', 'under_review', 'upheld', 'rejected', 'closed');
      `);

      corrected.prepare(`
        UPDATE reply_drafts
        SET
          state = 'sent',
          error_code = NULL,
          error_message = NULL,
          processed_at = COALESCE(processed_at, updated_at, ?),
          updated_at = ?
          ${resetAssignments.length > 0 ? `, ${resetAssignments.join(", ")}` : ""}
        WHERE state = 'failed'
      `).run(correctionAt, correctionAt);

      corrected.exec(`
        DELETE FROM complaint_analysis_invocations
        WHERE complaint_case_id IN (SELECT id FROM correction_removed_complaints);
        DELETE FROM complaint_events
        WHERE complaint_case_id IN (SELECT id FROM correction_removed_complaints);
        DELETE FROM complaint_attempts
        WHERE complaint_case_id IN (SELECT id FROM correction_removed_complaints);
        DELETE FROM complaint_cases
        WHERE id IN (SELECT id FROM correction_removed_complaints);

        DELETE FROM reply_attempts;
        DELETE FROM review_action_locks;

        DELETE FROM reply_drafts WHERE state <> 'sent';

        DELETE FROM review_action_tombstones
        WHERE NOT EXISTS (
          SELECT 1
          FROM complaint_cases
          WHERE complaint_cases.store_id = review_action_tombstones.store_id
            AND complaint_cases.source_key = review_action_tombstones.source_key
            AND complaint_cases.state IN ('submitted', 'under_review', 'upheld', 'rejected', 'closed')
        );

        DROP TABLE correction_removed_complaints;
      `);
    }).immediate();

    assertIntegrity(corrected, "校正数据库");
    const foreignKeyProblems = corrected.pragma("foreign_key_check");
    if (foreignKeyProblems.length > 0) {
      throw new Error(`校正数据库外键检查失败：${JSON.stringify(foreignKeyProblems)}`);
    }
    const after = {
      replyDraftsByState: stateCounts(corrected, "reply_drafts"),
      replyAttemptsByState: stateCounts(corrected, "reply_attempts"),
      complaintCasesByState: stateCounts(corrected, "complaint_cases"),
    };
    corrected.pragma("wal_checkpoint(TRUNCATE)");
    corrected.pragma("journal_mode = DELETE");
    corrected.close();
    corrected = undefined;

    const report = {
      sourcePath: resolvedSource,
      outputPath: resolvedOutput,
      correctionAt,
      rule: "数据库仅作历史查看：failed 经用户确认转为 sent，其余非 sent 回复和未实际提交的投诉记录删除；历史回复不保留动作锁",
      convertedFailed,
      deletedNotSuccessful,
      deletedComplaintCases,
      before,
      after,
    };
    if (reportPath) {
      const resolvedReport = path.resolve(reportPath);
      await mkdir(path.dirname(resolvedReport), { recursive: true });
      await writeFile(resolvedReport, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    }
    return report;
  } catch (error) {
    corrected?.close();
    source?.close();
    await rm(resolvedOutput, { force: true });
    throw error;
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("用法：--source <源数据库> --output <输出数据库> [--report <报告JSON>]");
    }
    values.set(key.slice(2), value);
  }
  return {
    sourcePath: values.get("source"),
    outputPath: values.get("output"),
    reportPath: values.get("report"),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = await correctImportedReplyHistory(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
