// App bootstrap: loads the database, wires up tab navigation, and starts
// the Log Explorer and Database Admin modules.
(function () {
  "use strict";
  const { qs, qsa } = Util;

  const nav = {
    onOpenSql: null,      // set by DbAdmin.init — jump to Admin tab with a query
    onOpenLogQuery: null, // reserved for future cross-links the other way
    switchTab: (name) => switchTab(name),
  };

  function switchTab(name) {
    qsa(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    qsa(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  }

  async function main() {
    const statusEl = qs("#boot-status");
    try {
      await DB.init("data.db", "vendor");
      statusEl.remove();
    } catch (err) {
      statusEl.textContent = `Failed to load database: ${err.message}`;
      statusEl.classList.add("error");
      return;
    }

    qsa(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    ChallengeBrief.init(qs("#tab-challenge"), nav);
    LogsExplorer.init(qs("#tab-logs"), nav);
    DbAdmin.init(qs("#tab-admin"), nav);

    qs("#app").hidden = false;
  }

  document.addEventListener("DOMContentLoaded", main);
})();
