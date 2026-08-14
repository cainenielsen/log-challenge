// Database Admin tab: browse tables/schema and run read-only SQL.
import * as Util from "./util.js";
import * as DB from "./db.js";
import * as SqlHighlight from "./highlight.js";

const { qs, qsa, escapeHtml, el } = Util;

const MAX_DISPLAY_ROWS = 500;

const MUTATION_RE = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|VACUUM|REINDEX|TRIGGER|PRAGMA)\b/i;
const READ_START_RE = /^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(SELECT|WITH|EXPLAIN)\b/i;

const EXAMPLE_QUERIES = [
  { label: "Recently locked users", sql: "SELECT id, username, status, locked_at, locked_reason\nFROM users\nWHERE status != 'active'\nORDER BY locked_at DESC;" },
  { label: "Failed transactions", sql: "SELECT id, account_id, merchant, amount_cents, failure_reason, created_at\nFROM transactions\nWHERE status = 'failed'\nORDER BY created_at DESC\nLIMIT 50;" },
  { label: "Non-USD accounts", sql: "SELECT a.id, a.user_id, u.username, a.currency, a.balance_cents\nFROM accounts a\nJOIN users u ON u.id = a.user_id\nWHERE a.currency != 'USD';" },
  { label: "Duplicate idempotency keys", sql: "SELECT idempotency_key, COUNT(*) AS n, GROUP_CONCAT(id) AS transaction_ids\nFROM transactions\nGROUP BY idempotency_key\nHAVING COUNT(*) > 1;" },
  { label: "Log volume by service/level", sql: "SELECT service, level, COUNT(*) AS n\nFROM logs\nGROUP BY service, level\nORDER BY service, n DESC;" },
];

export function checkReadOnly(sqlText) {
  const trimmed = sqlText.trim().replace(/;\s*$/, "");
  if (trimmed.includes(";")) {
    return "Only a single statement is allowed — remove the extra ';'-separated statement(s).";
  }
  if (!READ_START_RE.test(trimmed)) {
    return "Only SELECT / WITH / EXPLAIN statements are allowed in this read-only tool.";
  }
  if (MUTATION_RE.test(trimmed)) {
    return "This looks like a write/DDL statement. This is a read-only database explorer.";
  }
  return null;
}

export function init(root, nav) {
  root.innerHTML = `
    <div class="admin-layout">
      <aside class="admin-sidebar">
        <h3>Example queries</h3>
        <ul class="example-list" id="example-list"></ul>
      </aside>
      <main class="admin-main">
        <div class="sql-box">
          <div class="sql-editor">
            <div id="sql-highlight" class="sql-highlight" aria-hidden="true"></div>
            <textarea id="sql-input" spellcheck="false" placeholder="SELECT * FROM users LIMIT 20;"></textarea>
          </div>
          <div class="sql-actions">
            <button id="run-sql" class="btn btn-primary">
              <svg class="btn-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M4 2.3v11.4a.6.6 0 0 0 .92.5l9-5.7a.6.6 0 0 0 0-1l-9-5.7a.6.6 0 0 0-.92.5z" fill="currentColor"/></svg>
              Run query
            </button>
            <kbd>Ctrl+Enter</kbd>
            <span id="sql-status" class="sql-status"></span>
          </div>
        </div>
        <div id="admin-results" class="admin-results"></div>
      </main>
      <aside class="schema-sidebar">
        <h3>Schema</h3>
        <nav class="schema-nav" id="schema-nav"></nav>
        <div class="schema-panel" id="schema-panel"></div>
      </aside>
    </div>
  `;

  const exampleListEl = qs("#example-list", root);
  const sqlInput = qs("#sql-input", root);
  const sqlHighlightEl = qs("#sql-highlight", root);
  const runBtn = qs("#run-sql", root);
  const statusEl = qs("#sql-status", root);
  const resultsEl = qs("#admin-results", root);
  const schemaNavEl = qs("#schema-nav", root);
  const schemaPanelEl = qs("#schema-panel", root);

  // Live syntax highlighting: a read-only backdrop (built by Shiki, see
  // src/app/highlight.js) sits behind the real textarea, which is rendered
  // fully transparent except for its caret. Re-rendered on every keystroke
  // and kept in scroll-sync with the textarea.
  function renderHighlight() {
    const code = sqlInput.value;
    const html = SqlHighlight.toHtml(code);
    sqlHighlightEl.innerHTML = html || `<pre class="shiki-fallback">${escapeHtml(code)}</pre>`;
    // Shiki's <pre> is tabindex="0" for standalone use; this one is a
    // decorative, aria-hidden backdrop and shouldn't be a tab stop.
    sqlHighlightEl.querySelectorAll("[tabindex]").forEach((n) => n.removeAttribute("tabindex"));
    syncHighlightScroll();
  }
  function syncHighlightScroll() {
    sqlHighlightEl.scrollTop = sqlInput.scrollTop;
    sqlHighlightEl.scrollLeft = sqlInput.scrollLeft;
  }
  function setSql(text) {
    sqlInput.value = text;
    renderHighlight();
  }
  // Highlighter loads its WASM engine asynchronously — once ready, upgrade
  // whatever's currently shown from plain text to real colors.
  SqlHighlight.ready.then((ok) => { if (ok) renderHighlight(); });
  sqlInput.addEventListener("input", renderHighlight);
  sqlInput.addEventListener("scroll", syncHighlightScroll);

  const tables = DB.listTables();

  // Example queries: a plain "list everything" entry per table, followed by
  // the curated ones. These only ever touch the query box — picking one
  // never changes what the schema panel on the right is showing.
  const listAllQueries = tables.map((t) => ({ label: `List all ${t}`, sql: `SELECT * FROM ${t} LIMIT 50;` }));
  [...listAllQueries, ...EXAMPLE_QUERIES].forEach((ex) => {
    const li = el("li");
    const btn = el("button", {
      class: "example-btn",
      text: ex.label,
      onclick: () => { setSql(ex.sql); runQuery(); },
    });
    li.appendChild(btn);
    exampleListEl.appendChild(li);
  });

  // Schema side panel: an independent nav of table names, entirely
  // decoupled from the query box and the example-query list above.
  tables.forEach((t) => {
    const btn = el("button", { class: "schema-nav-btn", text: t, onclick: () => selectSchema(t) });
    btn.dataset.table = t;
    schemaNavEl.appendChild(btn);
  });

  function selectSchema(t) {
    qsa(".schema-nav-btn", root).forEach((b) => b.classList.toggle("active", b.dataset.table === t));
    const cols = DB.tableSchema(t);
    schemaPanelEl.innerHTML = `
      <table class="schema-table">
        <thead><tr><th>Column</th><th>Type</th><th>Not Null</th><th>PK</th></tr></thead>
        <tbody>
          ${cols.map((c) => `
            <tr>
              <td>${escapeHtml(c.name)}</td>
              <td>${escapeHtml(c.type)}</td>
              <td>${c.notnull ? "yes" : ""}</td>
              <td>${c.pk ? "yes" : ""}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    `;
  }
  if (tables.length) selectSchema(tables[0]);

  function runQuery() {
    const sqlText = sqlInput.value.trim();
    if (!sqlText) return;
    const err = checkReadOnly(sqlText);
    if (err) {
      statusEl.textContent = err;
      statusEl.className = "sql-status error";
      resultsEl.innerHTML = "";
      return;
    }
    const t0 = performance.now();
    try {
      const { columns, rows } = DB.query(sqlText);
      const ms = (performance.now() - t0).toFixed(1);
      statusEl.textContent = `${rows.length} row${rows.length === 1 ? "" : "s"} in ${ms} ms`;
      statusEl.className = "sql-status ok";
      renderResults(columns, rows);
    } catch (e) {
      statusEl.textContent = e.message;
      statusEl.className = "sql-status error";
      resultsEl.innerHTML = "";
    }
  }

  function renderResults(columns, rows) {
    if (rows.length === 0) {
      resultsEl.innerHTML = `<div class="empty-state">No rows returned.</div>`;
      return;
    }
    const shown = rows.slice(0, MAX_DISPLAY_ROWS);
    const table = el("table", { class: "results-table" });
    const thead = el("thead", {}, [
      el("tr", {}, columns.map((c) => el("th", { text: c }))),
    ]);
    const tbody = el("tbody", {}, shown.map((r) =>
      el("tr", {}, columns.map((c) => {
        const v = r[c];
        const td = el("td", { text: v === null || v === undefined ? "NULL" : String(v) });
        if (v === null || v === undefined) td.classList.add("null-value");
        return td;
      }))
    ));
    table.appendChild(thead);
    table.appendChild(tbody);
    resultsEl.innerHTML = "";
    resultsEl.appendChild(table);
    if (rows.length > MAX_DISPLAY_ROWS) {
      resultsEl.appendChild(el("div", {
        class: "truncate-note",
        text: `Showing first ${MAX_DISPLAY_ROWS} of ${rows.length} rows. Refine your query (WHERE/LIMIT) to see more precisely.`,
      }));
    }
  }

  runBtn.addEventListener("click", runQuery);
  sqlInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runQuery(); }
  });

  // Cross-tab navigation: Log Explorer can ask us to jump here with a
  // pre-filled, already-run query (e.g. clicking an account_id pill).
  nav.onOpenSql = (sqlText) => {
    setSql(sqlText);
    runQuery();
  };

  // Seed with something on first load.
  setSql("SELECT * FROM users LIMIT 20;");
  runQuery();
}
