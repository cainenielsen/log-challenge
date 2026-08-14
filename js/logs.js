// Log Explorer tab: Datadog-style facet sidebar + Lucene query bar over the
// `logs` table (loaded once into memory — filtering happens client-side).
(function (global) {
  "use strict";
  const { qs, qsa, escapeHtml, debounce, formatTs, prettyJson, el } = Util;

  const SERVICES = ["auth-service", "payments-service", "notifications-service"];
  const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"];
  const MAX_DISPLAY_ROWS = 300;

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
    <code>http_status:[400 TO 599]</code><br>
    Bare words search message/service/error_type/stack_trace/http_path/metadata.
    Terms with no operator are combined with AND.<br>
    Searchable fields: service, level, message, request_id, trace_id, user_id,
    account_id, transaction_id, http_method, http_path, http_status,
    duration_ms, error_type, stack_trace, metadata.
  `;

  function levelClass(level) { return "level-" + level.toLowerCase(); }

  function init(root, nav) {
    const { rows: allRows } = DB.query("SELECT * FROM logs ORDER BY ts DESC");
    const datasetMax = allRows[0]?.ts || "";
    const datasetMin = allRows[allRows.length - 1]?.ts || "";

    const state = {
      queryText: "",
      ast: null,
      parseError: null,
      selectedServices: new Set(),
      selectedLevels: new Set(),
      from: datasetMin,
      to: datasetMax,
      expandedId: null,
    };

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

    fromInput.value = isoToLocalInput(datasetMin);
    toInput.value = isoToLocalInput(datasetMax);

    helpToggle.addEventListener("click", () => { helpPanel.hidden = !helpPanel.hidden; });

    qsa(".time-presets button", root).forEach((btn) => {
      btn.addEventListener("click", () => {
        qsa(".time-presets button", root).forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const preset = btn.dataset.preset;
        if (preset === "all") {
          state.from = datasetMin; state.to = datasetMax;
        } else {
          const hours = { "24h": 24, "3d": 72, "7d": 168 }[preset];
          const to = new Date(datasetMax);
          const from = new Date(to.getTime() - hours * 3600 * 1000);
          state.from = from.toISOString().replace(/\.\d{3}Z$/, ".000Z");
          state.to = datasetMax;
        }
        fromInput.value = isoToLocalInput(state.from);
        toInput.value = isoToLocalInput(state.to);
        render();
      });
    });

    function onManualTimeChange() {
      qsa(".time-presets button", root).forEach((b) => b.classList.remove("active"));
      state.from = localInputToIso(fromInput.value) || datasetMin;
      state.to = localInputToIso(toInput.value) || datasetMax;
      render();
    }
    fromInput.addEventListener("change", onManualTimeChange);
    toInput.addEventListener("change", onManualTimeChange);

    const onQueryInput = debounce(() => {
      state.queryText = queryInput.value;
      try {
        state.ast = Lucene.parse(state.queryText);
        state.parseError = null;
      } catch (e) {
        state.parseError = e.message;
      }
      render();
    }, 150);
    queryInput.addEventListener("input", onQueryInput);

    function matchesTime(row) {
      return row.ts >= state.from && row.ts <= state.to;
    }
    function matchesQuery(row) {
      if (state.parseError) return false;
      try { return Lucene.evaluate(state.ast, row); } catch (e) { return false; }
    }
    function matchesServiceSet(row, ignore) {
      if (ignore || state.selectedServices.size === 0) return true;
      return state.selectedServices.has(row.service);
    }
    function matchesLevelSet(row, ignore) {
      if (ignore || state.selectedLevels.size === 0) return true;
      return state.selectedLevels.has(row.level);
    }

    function render() {
      const baseFiltered = allRows.filter((r) => matchesTime(r) && matchesQuery(r));

      // Facet counts: each facet's counts reflect all *other* active filters.
      const serviceCounts = Object.fromEntries(SERVICES.map((s) => [s, 0]));
      baseFiltered.filter((r) => matchesLevelSet(r)).forEach((r) => {
        if (serviceCounts[r.service] !== undefined) serviceCounts[r.service]++;
      });
      const levelCounts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
      baseFiltered.filter((r) => matchesServiceSet(r)).forEach((r) => {
        if (levelCounts[r.level] !== undefined) levelCounts[r.level]++;
      });

      renderFacetList(facetServiceEl, SERVICES, state.selectedServices, serviceCounts, "service");
      renderFacetList(facetLevelEl, LEVELS, state.selectedLevels, levelCounts, "level");

      const finalRows = baseFiltered.filter((r) => matchesServiceSet(r) && matchesLevelSet(r));

      if (state.parseError) {
        statusEl.textContent = `Query error: ${state.parseError}`;
        statusEl.className = "query-status error";
      } else {
        statusEl.textContent = `${finalRows.length.toLocaleString()} log${finalRows.length === 1 ? "" : "s"} matched`;
        statusEl.className = "query-status ok";
      }

      renderResults(finalRows);
    }

    function renderFacetList(container, values, selectedSet, counts, dim) {
      container.innerHTML = "";
      values.forEach((v) => {
        const active = selectedSet.has(v);
        const li = el("li", { class: "facet-item" + (active ? " active" : "") });
        const btn = el("button", { class: "facet-btn" }, [
          el("span", { class: "facet-swatch " + (dim === "level" ? levelClass(v) : "") }),
          el("span", { class: "facet-name", text: v }),
          el("span", { class: "facet-count", text: counts[v]?.toLocaleString() ?? "0" }),
        ]);
        btn.addEventListener("click", () => {
          if (selectedSet.has(v)) selectedSet.delete(v); else selectedSet.add(v);
          render();
        });
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
      state.queryText = queryInput.value;
      state.ast = Lucene.parse(state.queryText);
      state.parseError = null;
      state.selectedServices.clear();
      state.selectedLevels.clear();
      state.from = datasetMin; state.to = datasetMax;
      fromInput.value = isoToLocalInput(datasetMin);
      toInput.value = isoToLocalInput(datasetMax);
      qsa(".time-presets button", root).forEach((b) => b.classList.toggle("active", b.dataset.preset === "all"));
      render();
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
        pill("request_id", row.request_id, (v) => { queryInput.value = `request_id:"${v}"`; onQueryInput(); }),
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

  global.LogsExplorer = { init };
})(typeof window !== "undefined" ? window : globalThis);
