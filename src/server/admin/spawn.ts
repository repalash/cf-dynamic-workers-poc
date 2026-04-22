// Spawns the dynamic user worker. The user owns an arbitrary file tree
// (stored as Record<string, string> in _teeny_admin_state.files). On every
// request we:
//
//   1. createWorker({ files }) — @cloudflare/worker-bundler runs esbuild-wasm
//      inside workerd. Resolves relative imports across the user's files,
//      strips TS types, emits { mainModule, modules } ready for LOADER.
//      "teenybase" is declared external so it doesn't get bundled — we ship
//      it as a separate module entry.
//   2. LOADER.load({ modules: bundled.modules ∪ { "teenybase": <bundle>,
//      "virtual:teenybase": <config> }, env: { TEENY_PRIMARY_DB: d1Stub } }).
//
// D1 access crosses the LOADER boundary as an RPC stub; the user's worker.js
// wraps it in a plain {run, runBatch} adapter (see starter-files.ts).
import type { DatabaseSettings } from "teenybase"
import { createWorker } from "@cloudflare/worker-bundler"
import type { FilesMap } from "./state"
// @ts-ignore — ?raw import resolved at build time
import teenybaseBundle from "../user-runtime/teenybase_bundle.js?raw"

export { STARTER_FILES } from "../user-runtime/starter-files"

const COMPAT_DATE = "2026-01-28"
const EXTERNALS = ["teenybase", "virtual:teenybase"]

type Env = {
  TEENY_PRIMARY_DB: D1Database
  LOADER: any
}

/**
 * Bundles the user's file tree plus a virtual:teenybase config module.
 * teenybase stays external so the bundler doesn't try to resolve it; we
 * ship our own pre-built bundle at the "teenybase" specifier via the
 * modules map.
 */
export async function bundleUserFiles(files: FilesMap, config: DatabaseSettings) {
  // Synthesize the config module as JS so worker-bundler resolves it through
  // relative imports if anything inside `files` references `virtual:teenybase`.
  // It's externalized below, so the bundler leaves the specifier alone and the
  // module comes from the `modules` map we hand to LOADER.
  return await createWorker({
    files,
    bundle: true,
    externals: EXTERNALS,
  })
}

export async function spawnDynamic(
  ctx: ExecutionContext,
  env: Env,
  files: FilesMap,
  config: DatabaseSettings,
  exports: { D1RPC: any }
) {
  const d1Stub = exports.D1RPC({})
  const bundled = await bundleUserFiles(files, config)

  const configModule = `export default ${JSON.stringify(config)};\n`

  // Combine bundler output + our externalized modules. LOADER resolves by
  // exact string match against the modules map; both bare ("teenybase") and
  // virtual: prefixes require the object-form { js: "..." } since workerd
  // otherwise rejects specifiers that don't end in .js/.py.
  const modules: Record<string, any> = { ...bundled.modules }
  modules["teenybase"] = { js: teenybaseBundle as string }
  modules["virtual:teenybase"] = { js: configModule }

  const worker = env.LOADER.load({
    compatibilityDate: COMPAT_DATE,
    compatibilityFlags: ["nodejs_compat"],
    mainModule: bundled.mainModule,
    modules,
    env: { TEENY_PRIMARY_DB: d1Stub },
    globalOutbound: null,
  })
  return worker.getEntrypoint()
}
