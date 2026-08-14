# Vendored Shiki (SQL syntax highlighting)

Plain ES modules, no bundler/build step — matches this repo's "just static
files" approach. Fetched from Shiki 1.24.0 via esm.sh's `es2022` bundle
output (each file is already fully self-contained — no further `import`s
except where noted below) and used as-is except for two patches.

| File | What it is |
|---|---|
| `shiki-core.mjs` | `shiki/core` — highlighter engine, `createCssVariablesTheme` |
| `shiki-engine-oniguruma.mjs` | `shiki/engine/oniguruma` — the real Oniguruma regex engine (WASM), needed for correct SQL tokenization (the pure-JS regex engine mis-tokenizes `SELECT`/`FROM`/`GROUP BY`/etc. — tested, not a guess) |
| `shiki-wasm.mjs` | `shiki/wasm` — the Oniguruma WASM binary, base64-inlined in this file (no separate `.wasm` fetch) |
| `shiki-lang-sql.mjs` | `shiki/langs/sql` — the SQL TextMate grammar |
| `node-process-stub.mjs`, `node-buffer-stub.mjs` | Local stand-ins for two Node-only imports (see below) |

## The patch

`shiki-core.mjs` and `shiki-engine-oniguruma.mjs` each import a Node
polyfill (`/node/process.mjs`, `/node/buffer.mjs`) that esm.sh serves from
its own CDN for browser use. Both are only referenced behind
`typeof X !== "undefined"` feature-detection guards for edge cases we don't
hit (a VS Code debug flag, an `ArrayBuffer`-vs-`Buffer` check) — so rather
than vendor esm.sh's polyfill chain (which pulls in several more files),
the two import specifiers were repointed at `node-process-stub.mjs` /
`node-buffer-stub.mjs`, which just export `undefined`. That makes the
`typeof` checks correctly resolve to "not available," identical to real
browser behavior.

No other content was changed.

## Regenerating

```sh
SHIKI_VERSION=1.24.0
for f in core engine/oniguruma wasm langs/sql; do
  curl -sL "https://esm.sh/shiki@${SHIKI_VERSION}/es2022/${f}.bundle.mjs"
done
```

Then reapply the two `sed` substitutions above (`/node/process.mjs` →
`./node-process-stub.mjs`, `/node/buffer.mjs` → `./node-buffer-stub.mjs`)
to whichever of the four files still import them.

MIT licensed — see `LICENSE`.
