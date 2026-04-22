#!/usr/bin/env node
// Bundles the POC's user-runtime bundle entry into a single ESM file that the
// dynamic worker imports as "./teenybase.js". Run automatically by pre-dev /
// pre-build / pre-test.
//
// Source: src/server/user-runtime/bundle-entry.ts
//   — re-exports teenybase's cf-ui surface + hono/html + hono/cookie helpers
//     for SSR user code (no teenybase source edits required).
// Output: src/server/user-runtime/teenybase_bundle.js
import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, "../src/server/user-runtime/bundle-entry.ts")
const out = resolve(here, "../src/server/user-runtime/teenybase_bundle.js")

await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: out,
  jsx: "automatic",
  jsxImportSource: "hono/jsx",
  logLevel: "info",
})

console.log(`teenybase bundle → ${out}`)
