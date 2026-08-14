import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ command }) => ({
  // Relative asset paths so the build works under any subpath (e.g. GitHub
  // Pages project sites at <user>.github.io/<repo>/) without hardcoding the
  // repo name here. Dev server still serves from "/".
  base: command === "build" ? "./" : "/",
  build: {
    // The Shiki chunk is inherently large (base64-inlined Oniguruma WASM
    // engine) — that's a fixed cost of correct SQL tokenization, not
    // something code-splitting would meaningfully reduce here.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        answers: resolve(root, "answers.html"),
      },
    },
  },
}));
