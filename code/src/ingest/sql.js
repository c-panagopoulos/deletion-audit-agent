// SQL snapshot exports: executed in an in-memory SQLite database, then every row of every table
// becomes an observation. Two layouts exist:
//   - normalized tables (customer_profiles, support_records, ...) with one column per field;
//   - JSON tables (customer_data_primary / *_replica) with origin_system + record_json.
// A row in ANY table (primary or replica) means the record still exists: a replica that kept a row
// the primary deleted is exactly the replication drift the audit must catch.
//
// Evidence files are untrusted input (ADR-008): a snapshot may only create tables and insert rows.
// Statements that touch the filesystem or load code are rejected before anything is executed.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { observe, systemFor } from './record.js';

const FORBIDDEN_SQL = /\b(ATTACH|DETACH|VACUUM|load_extension|readfile|writefile)\b|^\s*PRAGMA\s+(?!foreign_keys\b)/im;

export function readSql(file) {
  const sql = fs.readFileSync(file.absPath, 'utf8');
  const bad = sql.match(FORBIDDEN_SQL);
  if (bad) throw new Error(`rejected unsafe SQL statement: ${bad[0].trim()}`);

  const db = new DatabaseSync(':memory:', { allowExtension: false });
  try {
    db.exec(sql);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    const observations = [];
    const covered = new Set();

    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM "${table.replace(/"/g, '""')}"`).all();
      if (table === 'snapshot_scope') {
        for (const r of rows) covered.add(r.origin_system);
        continue;
      }
      for (const row of rows) {
        const record = row.record_json ? JSON.parse(row.record_json) : { ...row };
        const obs = observe(record, {
          fileId: file.fileId,
          at: file.capturedAt,
          system: row.origin_system ?? systemFor(record.resource_id ?? ''),
          source: `sql:${table}`,
        });
        if (!obs) continue;
        covered.add(obs.system);
        observations.push(obs);
      }
    }
    return { observations, coverage: [...covered] };
  } finally {
    db.close();
  }
}
