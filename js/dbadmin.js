// Database Admin tab: browse tables/schema and run read-only SQL.
(function (global) {
  "use strict";
  const { qs, escapeHtml, el } = Util;

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

  function checkReadOnly(sqlText) {
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

  function init(root, nav) {
    const state = { activeTable: null };

    root.innerHTML = `
      <div class="admin-layout">
        <aside class="admin-sidebar">
          <h3>Tables</h3>
          <ul class="table-list" id="table-list"></ul>
          <h3>Example queries</h3>
          <ul class="example-list" id="example-list"></ul>
        </aside>
        <main class="admin-main">
          <div class="sql-box">
            <textarea id="sql-input" spellcheck="false" placeholder="SELECT * FROM users LIMIT 20;"></textarea>
            <div class="sql-actions">
              <button id="run-sql" class="btn btn-primary">Run query <kbd>Ctrl+Enter</kbd></button>
              <span id="sql-status" class="sql-status"></span>
            </div>
          </div>
          <div id="schema-panel" class="schema-panel" hidden></div>
          <div id="admin-results" class="admin-results"></div>
        </main>
      </div>
    `;

    const tableListEl = qs("#table-list", root);
    const exampleListEl = qs("#example-list", root);
    const sqlInput = qs("#sql-input", root);
    const runBtn = qs("#run-sql", root);
    const statusEl = qs("#sql-status", root);
    const schemaPanel = qs("#schema-panel", root);
    const resultsEl = qs("#admin-results", root);

    const tables = DB.listTables();
    tables.forEach((t) => {
      const count = DB.tableRowCount(t);
      const li = el("li", { class: "table-list-item" });
      const btn = el("button", {
        class: "table-list-btn",
        onclick: () => selectTable(t),
      }, [
        el("span", { class: "table-name", text: t }),
        el("span", { class: "table-count", text: String(count) }),
      ]);
      li.appendChild(btn);
      tableListEl.appendChild(li);
    });

    EXAMPLE_QUERIES.forEach((ex) => {
      const li = el("li");
      const btn = el("button", {
        class: "example-btn",
        text: ex.label,
        onclick: () => { sqlInput.value = ex.sql; runQuery(); },
      });
      li.appendChild(btn);
      exampleListEl.appendChild(li);
    });

    function selectTable(t) {
      state.activeTable = t;
      Util.qsa(".table-list-btn", root).forEach((b) => b.classList.remove("active"));
      const idx = tables.indexOf(t);
      Util.qsa(".table-list-btn", root)[idx]?.classList.add("active");
      renderSchema(t);
      sqlInput.value = `SELECT * FROM ${t} LIMIT 50;`;
      runQuery();
    }

    function renderSchema(t) {
      const cols = DB.tableSchema(t);
      schemaPanel.hidden = false;
      schemaPanel.innerHTML = `
        <div class="schema-header">Schema: <strong>${escapeHtml(t)}</strong></div>
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
          const isRef = /^(user_id|account_id|transaction_id|id)$/.test(c) && v !== null && v !== undefined;
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
      sqlInput.value = sqlText;
      runQuery();
    };

    // Seed with something on first load.
    sqlInput.value = "SELECT * FROM users LIMIT 20;";
    runQuery();
  }

  global.DbAdmin = { init, checkReadOnly };
})(typeof window !== "undefined" ? window : globalThis);
