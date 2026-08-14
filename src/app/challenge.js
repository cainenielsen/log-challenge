// Challenge tab: renders the ticket brief in-app. This is the single
// source of truth for the ticket text (see also answers.html, which walks
// through the solution to each one — kept unlinked from the app on purpose).
// No DB access here — this is static content, safe to show before/without
// the database.
import * as Util from "./util.js";

const { qs, qsa, el, escapeHtml } = Util;

const CHEATSHEET_ROWS = [
  ["service:payments-service", "field match"],
  ["level:ERROR", "field match"],
  ["account_id:42", "numeric field match"],
  ['"insufficient funds"', "exact phrase — searched across message, stack trace, etc."],
  ["error_type:*Error", "wildcard"],
  ["-level:DEBUG  /  NOT level:DEBUG", "negation"],
  ["service:payments-service AND level:ERROR", "boolean AND"],
  ["level:ERROR OR level:WARN", "boolean OR"],
  ["(level:ERROR OR level:WARN) AND service:payments-service", "grouping"],
  ["duration_ms:>1000", "comparison"],
  ["http_status:[400 TO 599]", "range"],
];

const TICKETS = [
  {
    id: 1, title: "Declined card", tag: "Warm-up",
    quote: `"I tried to pay for coffee at Green Leaf Cafe and my card got declined, but there's definitely money in my account?? — hiroshi.wilson"`,
    meta: "Reported: around Aug 7th, purchase was roughly $84.50.",
    ask: "Find the transaction and the log line(s) that explain the decline. What was the actual account balance at the time, and does the decline make sense?",
  },
  {
    id: 2, title: "Charged twice", tag: "Easy",
    quote: `"Acme Movers charged me for my move TWICE, both for $219.99, a few seconds apart on the evening of Aug 9th. Please refund one of them! — stephanie.osei"`,
    ask: "Find both transactions. Look at the surrounding payments-service logs — what actually happened that caused a second charge to go through?",
  },
  {
    id: 3, title: "Can't log in", tag: "Easy",
    quote: `"My account won't let me log in anymore, it just says something about being locked. I don't remember doing anything wrong. — elizabeth.okafor"`,
    ask: "Confirm the account is locked, find when and why, and reconstruct the sequence of events that led to it from auth-service logs.",
  },
  {
    id: 4, title: "Missing receipt email", tag: "Medium",
    quote: `"I bought something from Wayfinder Travel around Aug 8th and never got a receipt email. Can you check what happened? — omar.davis"`,
    ask: "Find the transaction, then find what notifications-service logged for it. What's different about this customer's account that might explain a failure here?",
  },
  {
    id: 5, title: "Nothing happened, but also nothing went wrong?", tag: "Hard",
    quote: `"I made a $150 purchase at Summit Outfitters on Aug 13th, the money left my account, but I never got any confirmation email — and support chat says there's no error in the system for my order. — susan.novak"`,
    ask: "This one's harder: there's no ERROR log to find. Locate the transaction, get its trace_id, and check what each of the three services logged for that trace. What's missing, and what does that tell you?",
  },
  {
    id: 6, title: "Everyone's mad at once", tag: "Bonus",
    quote: null,
    meta: "Late on Aug 7th evening (UTC) there's a noticeable cluster of payment failures across many different customers within roughly a 30–40 minute window.",
    ask: "Find the window, characterize the failures (same error_type? same customer or spread across many?), and write one sentence for the incident channel summarizing what was going on and whether it was a customer-specific or systemic issue.",
  },
];

export function init(root, nav) {
  root.innerHTML = `
    <div class="challenge-page">
      <div class="challenge-hero">
        <p class="kicker">Ledgerly Support Console</p>
        <h1>Support Engineer Debugging Challenge</h1>
        <p class="challenge-lede">
          You're covering the support queue for <strong>Ledgerly</strong>, a fictional
          consumer fintech app. You have two tools: <strong>Log Explorer</strong>, which
          searches logs from three backend services
          (<code>auth-service</code>, <code>payments-service</code>,
          <code>notifications-service</code>) using a Lucene/Datadog-style query
          syntax, and <strong>Database Admin</strong>, a read-only browser over the
          production-replica tables (<code>users</code>, <code>accounts</code>,
          <code>transactions</code>, <code>logs</code>).
        </p>
      </div>

      <div class="challenge-grid">
        <section class="challenge-card">
          <h2>How to work a ticket</h2>
          <ol class="step-list">
            <li>Support tickets come with a username and roughly when/what happened
              — not internal IDs. Look the customer up in <strong>Database Admin</strong>
              (<code>users</code> table) to get their <code>id</code>, then their
              <code>accounts</code> and <code>transactions</code>.</li>
            <li>Search <strong>Log Explorer</strong> for that <code>account_id</code> /
              <code>transaction_id</code> / <code>user_id</code> around the reported
              time to see what actually happened server-side.</li>
            <li>Follow <code>trace_id</code> / <code>request_id</code> to see the full
              request across all three services, not just the one that logged an
              error. Logs only carry internal numeric IDs, not usernames — that's
              why step 1 matters.</li>
          </ol>
          <div class="challenge-jumps">
            <button class="btn" data-jump="logs">Open Log Explorer →</button>
            <button class="btn" data-jump="admin">Open Database Admin →</button>
          </div>
        </section>

        <section class="challenge-card">
          <h2>Query syntax cheat sheet</h2>
          <table class="cheatsheet-table">
            <tbody>
              ${CHEATSHEET_ROWS.map(([q, desc]) => `
                <tr><td><code>${escapeHtml(q)}</code></td><td>${escapeHtml(desc)}</td></tr>
              `).join("")}
            </tbody>
          </table>
          <p class="cheatsheet-note">Terms with no operator are combined with AND.
            Bare words search across message, service, error_type, stack_trace,
            http_path, and metadata. Only <code>SELECT</code> / <code>WITH</code> /
            <code>EXPLAIN</code> are accepted in Database Admin — this mirrors a real
            read-replica support tool.</p>
        </section>
      </div>

      <section class="challenge-card">
        <h2>Warm-up</h2>
        <p class="challenge-section-note">These don't map to a specific ticket — just get comfortable with the tools first.</p>
        <ol class="warmup-list">
          <li>How many ERROR-level log lines has <code>payments-service</code> produced in the last 7 days?</li>
          <li>Which service produced the most WARN-level logs overall, and what's the most common WARN message for it?</li>
          <li>Using Database Admin, how many users currently have a status other than <code>active</code>? What are the distinct status values?</li>
        </ol>
      </section>

      <section class="challenge-tickets">
        <h2>Ticket queue</h2>
        <div id="ticket-list" class="ticket-list"></div>
      </section>

      <p class="challenge-closer">Good luck — and remember: the log tool never lies,
        but it also never tells you the whole story by itself.</p>
    </div>
  `;

  const ticketList = qs("#ticket-list", root);
  TICKETS.forEach((t) => ticketList.appendChild(buildTicketCard(t)));

  qsa("[data-jump]", root).forEach((btn) => {
    btn.addEventListener("click", () => nav.switchTab(btn.dataset.jump));
  });
}

function buildTicketCard(t) {
  const card = el("article", { class: "ticket-card" });
  const header = el("div", { class: "ticket-header" }, [
    el("span", { class: "ticket-number", text: t.id === 6 ? "Bonus" : `Ticket #${t.id}` }),
    el("span", { class: "ticket-tag tag-" + t.tag.toLowerCase(), text: t.tag }),
  ]);
  card.appendChild(header);
  card.appendChild(el("h3", { text: t.title }));
  if (t.quote) card.appendChild(el("blockquote", { class: "ticket-quote", text: t.quote }));
  if (t.meta) card.appendChild(el("p", { class: "ticket-meta", text: t.meta }));
  card.appendChild(el("p", { class: "ticket-ask", text: t.ask }));
  return card;
}
