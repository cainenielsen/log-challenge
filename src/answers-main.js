// Entry for answers.html: upgrades the static SQL snippets from plain text
// to real Shiki highlighting once the highlighter's WASM engine loads.
import * as SqlHighlight from "./app/highlight.js";

const ok = await SqlHighlight.ready;
if (ok) {
  document.querySelectorAll(".sql-block[data-sql]").forEach((el) => {
    const html = SqlHighlight.toHtml(el.textContent);
    if (html) el.innerHTML = html;
  });
}
