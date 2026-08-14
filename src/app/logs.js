// Log Explorer tab: Datadog-style facet sidebar + Lucene query bar over the
// `logs` table (loaded once into memory — filtering happens client-side).
//
// There's a single source of truth for what's filtered: the query text box.
// The service/level facets and time-range controls don't filter on their
// own — they toggle the equivalent Lucene term into the query text and run
// the same search a manual Enter would, so what's filtering the results is
// always visible (and editable) in the box, never hidden in separate UI
// state.
import * as Util from "./util.js";
import * as DB from "./db.js";
import * as Lucene from "./lucene.js";

const { qs, qsa, formatTs, prettyJson, el } = Util;

const SERVICES = ["auth-service", "payments-service", "notifications-service"];
const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"];
const MAX_DISPLAY_ROWS = 300;
const TIME_PRESET_HOURS = { "24h": 24, "3d": 72, "7d": 168 };

// Matches a ts:[X TO Y] clause anywhere in the query text — used to both
// detect/replace/remove the current time-range term and to read back its
// bounds (for the datetime inputs and preset-button highlighting).
const TS_RANGE_RE = /ts:\[([^\]]+?)\s+TO\s+([^\]]+?)\]/;

const HELP_HTML = `
  <strong>Query syntax</strong> (Lucene / Datadog style):<br>
  <code>service:payments-service</code> &middot;
  <code>level:ERROR</code> &middot;
  <code>account_id:42</code> &middot;
  <code>"insufficient funds"</code><br>
  <code>error_type:*Error</code> (wildcard) &middot;
  <code>-level:DEBUG</code> or <code>NOT level:DEBUG</code> (negation)<br>
  <code>service:payments-service AND level:ERROR</code> &middot;
  <code>level:ERROR OR level:WARN</code> &middot;
  <code>(level:ERROR OR level:WARN) AND service:payments-service</code><br>
  <code>duration_ms:&gt;1000</code> &middot;
  <code>http_status:[400 TO 599]</code> &middot;
  <code>ts:[2026-08-07T00:00:00.000Z TO 2026-08-08T00:00:00.000Z]</code><br>
  Bare words search message/service/error_type/stack_trace/http_path/metadata.
  Terms with no operator are combined with AND. The Service/Level/Time
  controls on the left just toggle these same terms into the box.<br>
  Searchable fields: service, level, message, request_id, trace_id, user_id,
  account_id, transaction_id, http_method, http_path, http_status,
  duration_ms, error_type, stack_trace, metadata, ts.
`;

function levelClass(level) { return "level-" + level.toLowerCase(); }

export function init(root, nav) {
  const { rows: allRows } = DB.query("SELECT * FROM logs ORDER BY ts DESC");
  const datasetMax = allRows[0]?.ts || "";
  const datasetMin = allRows[allRows.length - 1]?.ts || "";

  const state = { queryText: "", ast: null, parseError: null, expandedId: null };

  root.innerHTML = `
    <div class="logs-layout">
      <aside class="logs-sidebar">
        <div class="facet-block">
          <h3>Time range</h3>
          <div class="time-presets">
            <button data-preset="24h">Last 24h</button>
            <button data-preset="3d">Last 3d</button>
            <button data-preset="7d">Last 7d</button>
            <button data-preset="all" class="active">All time</button>
          </div>
          <label class="time-label">From
            <input type="datetime-local" id="from-input">
          </label>
          <label class="time-label">To
            <input type="datetime-local" id="to-input">
          </label>
        </div>
        <div class="facet-block">
          <h3>Service</h3>
          <ul id="facet-service" class="facet-list"></ul>
        </div>
        <div class="facet-block">
          <h3>Level</h3>
          <ul id="facet-level" class="facet-list"></ul>
        </div>
      </aside>
      <main class="logs-main">
        <div class="query-bar">
          <input type="text" id="query-input" placeholder='Search, e.g. service:payments-service AND level:ERROR' autocomplete="off">
          <kbd>Enter</kbd>
          <button id="help-toggle" class="btn" title="Query syntax help">?</button>
        </div>
        <div id="help-panel" class="help-panel" hidden>${HELP_HTML}</div>
        <div id="query-status" class="query-status"></div>
        <div id="log-results"></div>
      </main>
    </div>
  `;

  const fromInput = qs("#from-input", root);
  const toInput = qs("#to-input", root);
  const queryInput = qs("#query-input", root);
  const helpToggle = qs("#help-toggle", root);
  const helpPanel = qs("#help-panel", root);
  const statusEl = qs("#query-status", root);
  const resultsEl = qs("#log-results", root);
  const facetServiceEl = qs("#facet-service", root);
  const facetLevelEl = qs("#facet-level", root);

  helpToggle.addEventListener("click", () => { helpPanel.hidden = !helpPanel.hidden; });

  // --- query text helpers: every filter control below is really just
  // editing this string, then running the same search Enter would. ---
  function appendTerm(text, term) {
    const trimmed = text.trim();
    return trimmed ? `${trimmed} AND ${term}` : term;
  }
  function removeSubstring(text, substr) {
    return cleanupBoolean(text.replace(substr, ""));
  }
  function cleanupBoolean(text) {
    return text
      .replace(/\s+AND\s+AND\s+/gi, " AND ")
      .replace(/^\s*AND\s+/i, "")
      .replace(/\s+AND\s*$/i, "")
      .trim();
  }

  function toggleFacetTerm(field, value) {
    const term = `${field}:${value}`;
    queryInput.value = queryInput.value.includes(term)
      ? removeSubstring(queryInput.value, term)
      : appendTerm(queryInput.value, term);
    runSearch();
  }

  function presetRange(preset) {
    if (preset === "all") return null;
    const hours = TIME_PRESET_HOURS[preset];
    const to = new Date(datasetMax);
    const from = new Date(to.getTime() - hours * 3600 * 1000);
    return { from: from.toISOString().replace(/\.\d{3}Z$/, ".000Z"), to: datasetMax };
  }
  function setTimeRange(fromIso, toIso) {
    const term = `ts:[${fromIso} TO ${toIso}]`;
    queryInput.value = TS_RANGE_RE.test(queryInput.value)
      ? queryInput.value.replace(TS_RANGE_RE, term)
      : appendTerm(queryInput.value, term);
    runSearch();
  }
  function clearTimeRange() {
    queryInput.value = removeSubstring(queryInput.value, TS_RANGE_RE);
    runSearch();
  }

  qsa(".time-presets button", root).forEach((btn) => {
    btn.addEventListener("click", () => {
      const range = presetRange(btn.dataset.preset);
      if (range) setTimeRange(range.from, range.to); else clearTimeRange();
    });
  });

  function onManualTimeChange() {
    const fromIso = localInputToIso(fromInput.value);
    const toIso = localInputToIso(toInput.value);
    if (!fromIso && !toIso) { clearTimeRange(); return; }
    setTimeRange(fromIso || datasetMin, toIso || datasetMax);
  }
  fromInput.addEventListener("change", onManualTimeChange);
  toInput.addEventListener("change", onManualTimeChange);

  function runSearch() {
    state.queryText = queryInput.value;
    try {
      state.ast = Lucene.parse(state.queryText);
      state.parseError = null;
    } catch (e) {
      state.parseError = e.message;
    }
    render();
  }
  // Search runs on Enter, not on every keystroke — queries can involve
  // scanning thousands of rows, and re-filtering mid-word is wasted work.
  queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runSearch(); }
  });

  function matchesQuery(row) {
    if (state.parseError) return false;
    try { return Lucene.evaluate(state.ast, row); } catch (e) { return false; }
  }

  function render() {
    const finalRows = state.parseError ? [] : allRows.filter(matchesQuery);

    const serviceCounts = Object.fromEntries(SERVICES.map((s) => [s, 0]));
    const levelCounts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
    finalRows.forEach((r) => {
      if (serviceCounts[r.service] !== undefined) serviceCounts[r.service]++;
      if (levelCounts[r.level] !== undefined) levelCounts[r.level]++;
    });

    renderFacetList(facetServiceEl, "service", SERVICES, serviceCounts);
    renderFacetList(facetLevelEl, "level", LEVELS, levelCounts);
    syncTimeUI();

    if (state.parseError) {
      statusEl.textContent = `Query error: ${state.parseError}`;
      statusEl.className = "query-status error";
    } else {
      statusEl.textContent = `${finalRows.length.toLocaleString()} log${finalRows.length === 1 ? "" : "s"} matched`;
      statusEl.className = "query-status ok";
    }

    renderResults(finalRows);
  }

  function syncTimeUI() {
    qsa(".time-presets button", root).forEach((b) => b.classList.remove("active"));
    const m = queryInput.value.match(TS_RANGE_RE);
    if (!m) {
      qs('.time-presets button[data-preset="all"]', root)?.classList.add("active");
      fromInput.value = isoToLocalInput(datasetMin);
      toInput.value = isoToLocalInput(datasetMax);
      return;
    }
    const [, fromIso, toIso] = m;
    fromInput.value = isoToLocalInput(fromIso);
    toInput.value = isoToLocalInput(toIso);
    for (const preset of Object.keys(TIME_PRESET_HOURS)) {
      const r = presetRange(preset);
      if (r && r.from === fromIso && r.to === toIso) {
        qs(`.time-presets button[data-preset="${preset}"]`, root)?.classList.add("active");
        break;
      }
    }
  }

  function renderFacetList(container, field, values, counts) {
    container.innerHTML = "";
    values.forEach((v) => {
      const active = queryInput.value.includes(`${field}:${v}`);
      const li = el("li", { class: "facet-item" + (active ? " active" : "") });
      const btn = el("button", { class: "facet-btn" }, [
        el("span", { class: "facet-swatch " + (field === "level" ? levelClass(v) : "") }),
        el("span", { class: "facet-name", text: v }),
        el("span", { class: "facet-count", text: counts[v]?.toLocaleString() ?? "0" }),
      ]);
      btn.addEventListener("click", () => toggleFacetTerm(field, v));
      li.appendChild(btn);
      container.appendChild(li);
    });
  }

  function renderResults(rows) {
    resultsEl.innerHTML = "";
    if (rows.length === 0) {
      resultsEl.appendChild(el("div", { class: "empty-state", text: "No logs match these filters." }));
      return;
    }
    const shown = rows.slice(0, MAX_DISPLAY_ROWS);
    const table = el("table", { class: "log-table" });
    const thead = el("thead", {}, [
      el("tr", {}, [
        el("th", { text: "Time" }),
        el("th", { text: "Service" }),
        el("th", { text: "Level" }),
        el("th", { text: "Message" }),
      ]),
    ]);
    const tbody = el("tbody");
    shown.forEach((row) => {
      const tr = el("tr", { class: "log-row", onclick: () => toggleExpand(row.id, tbody, tr) }, [
        el("td", { class: "col-time", text: formatTs(row.ts) }),
        el("td", { class: "col-service", text: row.service }),
        el("td", {}, [el("span", { class: "level-badge " + levelClass(row.level), text: row.level })]),
        el("td", { class: "col-message", text: row.message }),
      ]);
      tr.dataset.id = row.id;
      tbody.appendChild(tr);
      if (state.expandedId === row.id) {
        tbody.appendChild(buildDetailRow(row));
      }
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    resultsEl.appendChild(table);
    if (rows.length > MAX_DISPLAY_ROWS) {
      resultsEl.appendChild(el("div", {
        class: "truncate-note",
        text: `Showing first ${MAX_DISPLAY_ROWS} of ${rows.length} matches. Narrow your query or time range to see more precisely.`,
      }));
    }
  }

  function toggleExpand(id, tbody, tr) {
    state.expandedId = state.expandedId === id ? null : id;
    const existing = qs(".log-detail-row", tbody);
    if (existing) existing.remove();
    if (state.expandedId === id) {
      tr.after(buildDetailRow(allRows.find((r) => r.id === id)));
    }
  }

  function pill(label, value, onClick) {
    if (value === null || value === undefined || value === "") return null;
    const btn = el("button", { class: "pill", title: "Click to investigate", onclick: (e) => { e.stopPropagation(); onClick(value); } }, [
      el("span", { class: "pill-label", text: label + ": " }),
      el("span", { class: "pill-value", text: String(value) }),
    ]);
    return btn;
  }

  function goToSql(sql) {
    nav.switchTab("admin");
    nav.onOpenSql(sql);
  }
  function goToTrace(traceId) {
    queryInput.value = `trace_id:"${traceId}"`;
    runSearch();
  }

  function buildDetailRow(row) {
    const meta = row.metadata ? prettyJson(row.metadata) : null;
    const tr = el("tr", { class: "log-detail-row" });
    const td = el("td", { colspan: "4" });
    const wrap = el("div", { class: "log-detail" });

    wrap.appendChild(el("div", { class: "detail-message", text: row.message }));

    const pills = el("div", { class: "pill-row" });
    [
      pill("user_id", row.user_id, (v) => goToSql(`SELECT * FROM users WHERE id = ${Number(v)};`)),
      pill("account_id", row.account_id, (v) => goToSql(`SELECT * FROM accounts WHERE id = ${Number(v)};`)),
      pill("transaction_id", row.transaction_id, (v) => goToSql(`SELECT * FROM transactions WHERE id = ${Number(v)};`)),
      pill("trace_id", row.trace_id, (v) => goToTrace(v)),
      pill("request_id", row.request_id, (v) => { queryInput.value = `request_id:"${v}"`; runSearch(); }),
    ].forEach((p) => p && pills.appendChild(p));
    wrap.appendChild(pills);

    const grid = el("div", { class: "detail-grid" }, [
      detailField("HTTP", [row.http_method, row.http_path, row.http_status].filter(Boolean).join(" ")),
      detailField("Duration", row.duration_ms != null ? `${row.duration_ms} ms` : null),
      detailField("Error type", row.error_type),
    ]);
    wrap.appendChild(grid);

    if (row.stack_trace) {
      wrap.appendChild(el("div", { class: "detail-label", text: "Stack trace" }));
      wrap.appendChild(el("pre", { class: "detail-pre stack-trace", text: row.stack_trace }));
    }
    if (meta) {
      wrap.appendChild(el("div", { class: "detail-label", text: "Metadata" }));
      wrap.appendChild(el("pre", { class: "detail-pre", text: meta }));
    }

    td.appendChild(wrap);
    tr.appendChild(td);
    return tr;
  }

  function detailField(label, value) {
    if (!value) return el("span", { hidden: "" });
    return el("div", { class: "detail-field" }, [
      el("span", { class: "detail-field-label", text: label + ": " }),
      el("span", { class: "detail-field-value", text: value }),
    ]);
  }

  render();
}

function isoToLocalInput(iso) {
  if (!iso) return "";
  return iso.replace("Z", "").slice(0, 19);
}
function localInputToIso(local) {
  if (!local) return "";
  const withSeconds = local.length === 16 ? local + ":00" : local;
  return withSeconds + ".000Z";
}
