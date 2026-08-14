// Thin wrapper around sql.js: loads data.db and exposes query helpers.
import initSqlJs from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";

let db = null;

export async function init(dbUrl) {
  const sqlJs = await initSqlJs({ locateFile: () => sqlWasmUrl });
  const resp = await fetch(dbUrl);
  if (!resp.ok) throw new Error(`Failed to fetch ${dbUrl}: HTTP ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  db = new sqlJs.Database(buf, { filename: dbUrl });
  // Belt & suspenders: even though this is an in-memory copy that never
  // persists, the challenge tool should behave like a read-only client.
  db.run("PRAGMA query_only = ON;");
  return db;
}

// Runs a query and returns { columns, rows } where rows is an array of
// plain objects keyed by column name.
export function query(sql, params) {
  if (!db) throw new Error("Database not initialized yet");
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const columns = stmt.getColumnNames();
  const rows = [];
  while (stmt.step()) {
    const values = stmt.get();
    const row = {};
    columns.forEach((c, i) => { row[c] = values[i]; });
    rows.push(row);
  }
  stmt.free();
  return { columns, rows };
}

export function listTables() {
  const { rows } = query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return rows.map((r) => r.name);
}

export function tableSchema(table) {
  // Table name is validated against listTables() by callers before this
  // is ever interpolated — sql.js has no parameterized PRAGMA support.
  return query(`PRAGMA table_info(${quoteIdent(table)})`).rows;
}

export function tableRowCount(table) {
  return query(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).rows[0].n;
}

export function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error("Invalid table name");
  }
  return `"${name}"`;
}
