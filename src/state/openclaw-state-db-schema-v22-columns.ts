import type { DatabaseSync } from "node:sqlite";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { ensureColumn, tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

export const STATE_CURSOR_TABLES_V22 = [
  "operator_approvals",
  "cron_run_receipts",
  "execution_decision_facts",
  "skill_workshop_changes",
] as const;

/** The schema owner holds the migration transaction with foreign keys disabled. */
export function migratePortableIdentityColumnsV22(
  db: DatabaseSync,
  previousVersion: number,
): boolean {
  if (previousVersion >= 22) {
    return false;
  }
  let changed = false;
  for (const table of STATE_CURSOR_TABLES_V22) {
    if (!tableExists(db, table) || tableHasColumn(db, table, "cursor_id")) {
      continue;
    }
    // Preserve historical constraints and local indexes/triggers, including older
    // shapes whose additive/STRICT repairs still belong to the existing owners.
    // sqlite-allow-raw -- One-time v22 catalog capture for an atomic table rebuild.
    const objects = db
      .prepare("SELECT type, sql FROM sqlite_schema WHERE tbl_name = ? AND sql IS NOT NULL")
      .all(table);
    const create = objects.find((object) => object.type === "table")?.sql;
    if (typeof create !== "string") {
      throw new Error(`Missing v22 cursor migration schema: ${table}`);
    }
    const temporary = quoteSqliteIdentifier(`${table}_migration_v22`);
    const name = quoteSqliteIdentifier(table);
    // sqlite-allow-raw -- Native column names are quoted before the lossless copy.
    const columns = db
      .prepare(`PRAGMA table_xinfo(${name})`)
      .all()
      .flatMap((column) =>
        column.hidden === 0 && typeof column.name === "string"
          ? [quoteSqliteIdentifier(column.name)]
          : [],
      )
      .join(", ");
    // Keep gaps and native 64-bit identities: issued cursors must still find the
    // same row. New writes subsequently allocate max(cursor_id) + 1.
    // sqlite-allow-raw -- One-time v22 rowid preservation, inside schema maintenance.
    db.exec(`CREATE TABLE ${temporary} (cursor_id INTEGER NOT NULL, ${create.slice(create.indexOf("(") + 1)};
      INSERT INTO ${temporary} (rowid, ${columns}, cursor_id) SELECT rowid, ${columns}, rowid FROM ${name} ORDER BY rowid;
      DROP TABLE ${name};
      ALTER TABLE ${temporary} RENAME TO ${name};`);
    for (const object of objects) {
      if (object.type !== "table" && typeof object.sql === "string") {
        // sqlite-allow-raw -- Replay the table's own captured index/trigger definitions.
        db.exec(object.sql);
      }
    }
    changed = true;
  }
  if (tableExists(db, "acp_sessions")) {
    changed = ensureColumn(db, "acp_sessions", "resume_agent_session_id TEXT") || changed;
    changed = ensureColumn(db, "acp_sessions", "resume_acpx_session_id TEXT") || changed;
    const identity = "CASE WHEN json_valid(identity_json) THEN identity_json END";
    const whitespace =
      "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
    // sqlite-allow-raw -- Backfill with the shipped JSON1 expressions; canonical DDL installs column indexes next.
    db.exec(`UPDATE acp_sessions SET
      resume_agent_session_id = trim(json_extract(${identity}, '$.agentSessionId'), ${whitespace}),
      resume_acpx_session_id = trim(json_extract(${identity}, '$.acpxSessionId'), ${whitespace});
      DROP INDEX IF EXISTS idx_acp_sessions_resume_agent;
      DROP INDEX IF EXISTS idx_acp_sessions_resume_acpx;`);
  }
  return changed;
}
