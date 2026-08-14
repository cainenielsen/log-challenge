// Builds a Shiki highlighter scoped to just SQL, using the real Oniguruma
// (WASM) engine — tested against the pure-JS regex engine first, which
// mis-tokenizes SELECT/FROM/GROUP BY/HAVING as plain text, so this isn't
// a default, it's a requirement.
//
// Uses Shiki's fine-grained core API instead of the top-level `shiki`
// package, and imports the SQL grammar directly from @shikijs/langs rather
// than through shiki/langs' bundledLanguages map — that map dynamic-
// import()s every bundled language (~200), which Rollup's static analysis
// discovers and chunks regardless of only ever calling `.sql()` at
// runtime. Importing the one file we need keeps only SQL in the bundle.
import { createHighlighterCore, createCssVariablesTheme } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import getWasmInstance from "shiki/wasm";
import sqlLang from "@shikijs/langs/sql";

const THEME_NAME = "css-vars";

// Each token type resolves to var(--shiki-token-<name>) so callers can
// theme it per-surface (the app's console palette vs. answers.html's doc
// palette) purely in CSS — see the --shiki-* tokens in src/styles/*.css.
const cssVariablesTheme = createCssVariablesTheme({
  name: THEME_NAME,
  variablePrefix: "--shiki-",
  fontStyle: true,
});

let highlighter = null;

export const ready = (async () => {
  highlighter = await createHighlighterCore({
    themes: [cssVariablesTheme],
    langs: [sqlLang],
    engine: createOnigurumaEngine(getWasmInstance),
  });
  return true;
})().catch((err) => {
  console.error("SQL syntax highlighting unavailable, falling back to plain text:", err);
  return false;
});

// Returns highlighted HTML (a full <pre class="shiki ...">…</pre>), or
// null if the highlighter isn't ready yet / failed to load — callers
// should fall back to escaped plain text in that case.
export function toHtml(code) {
  if (!highlighter) return null;
  try {
    return highlighter.codeToHtml(code, { lang: "sql", theme: THEME_NAME });
  } catch (err) {
    return null;
  }
}
