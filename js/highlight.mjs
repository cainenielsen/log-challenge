// Bootstraps Shiki (vendored, see vendor/shiki/README.md) and exposes a
// small synchronous-safe API on window.SqlHighlight for the rest of the
// app's classic (non-module) scripts to use.
//
// Module scripts execute after the document is parsed but before
// DOMContentLoaded fires, so by the time app.js's DOMContentLoaded handler
// runs, `window.SqlHighlight` is guaranteed to already exist (its `ready`
// promise may still be pending — Shiki's WASM engine loads asynchronously).
import { createHighlighterCore, createCssVariablesTheme } from "../vendor/shiki/shiki-core.mjs";
import { createOnigurumaEngine } from "../vendor/shiki/shiki-engine-oniguruma.mjs";
import getWasmInstance from "../vendor/shiki/shiki-wasm.mjs";
import sqlLang from "../vendor/shiki/shiki-lang-sql.mjs";

const THEME_NAME = "css-vars";

// Each token type resolves to var(--shiki-token-<name>) so callers can
// theme it per-surface (the app's console palette vs. answers.html's doc
// palette) purely in CSS — see the --shiki-* tokens in css/style.css and
// css/answers.css.
const cssVariablesTheme = createCssVariablesTheme({
  name: THEME_NAME,
  variablePrefix: "--shiki-",
  fontStyle: true,
});

let highlighter = null;

const ready = createHighlighterCore({
  themes: [cssVariablesTheme],
  langs: [sqlLang],
  engine: createOnigurumaEngine(getWasmInstance),
})
  .then((h) => {
    highlighter = h;
    return true;
  })
  .catch((err) => {
    console.error("SQL syntax highlighting unavailable, falling back to plain text:", err);
    return false;
  });

window.SqlHighlight = {
  ready,
  // Returns highlighted HTML (a full <pre class="shiki ...">…</pre>), or
  // null if the highlighter isn't ready yet / failed to load — callers
  // should fall back to escaped plain text in that case.
  toHtml(code) {
    if (!highlighter) return null;
    try {
      return highlighter.codeToHtml(code, { lang: "sql", theme: THEME_NAME });
    } catch (err) {
      return null;
    }
  },
};
