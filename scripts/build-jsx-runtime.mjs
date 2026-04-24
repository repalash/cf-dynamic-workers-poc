#!/usr/bin/env node
// Builds a standalone hono/jsx/jsx-runtime ESM bundle that the dynamic worker
// can load as a virtual module. Companion to the teenybase bundle.
//
// Output: src/server/user-runtime/hono_jsx_runtime.js
import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, "../src/server/user-runtime/hono_jsx_runtime.js")

await build({
  stdin: {
    contents: `export { jsx, Fragment } from "hono/jsx";\nexport { jsx as jsxs } from "hono/jsx";\n`,
    resolveDir: resolve(here, ".."),
    loader: "js",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: out,
  logLevel: "info",
})

console.log(`hono jsx runtime → ${out}`)
