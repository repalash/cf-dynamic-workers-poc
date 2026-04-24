// Spawns the dynamic user worker via the LOADER binding. Uses LOADER.get(id,
// factory) for caching: the id encodes the stamped $settings_version + a hash
// of the live files + teenybase bundle identity. Same id → reused isolate
// (fast). Deploy bumps the version (always) and often the files too → new id
// → fresh isolate next request.
//
// The config module's default export includes `.version` so teenybase's
// $Database can enforce the DDB_SETTINGS_VERSION header check on inbound
// requests. That's defense-in-depth against any cache-eviction race.
import type { DatabaseSettings } from "teenybase"
import { createWorker } from "@cloudflare/worker-bundler"
import type { FilesMap } from "@shared/types"
// @ts-ignore — ?raw import resolved at build time
import teenybaseBundle from "../user-runtime/teenybase_bundle.js?raw"

const COMPAT_DATE = "2026-01-28"
const EXTERNALS = ["teenybase", "virtual:teenybase"]

type Env = {
  TEENY_PRIMARY_DB: D1Database
  LOADER: any
}

// In-isolate memo. `deploy()` always bumps version, so version uniquely
// identifies the live (files, config) tuple within an isolate's lifetime.
// Avoids JSON.stringify+SHA-256 over the full file tree on every request.
let keyMemo: { version: number; id: string } | null = null

async function cacheKey(config: DatabaseSettings, files: FilesMap): Promise<string> {
  const v = (config as any).version ?? 0
  if (keyMemo && keyMemo.version === v) return keyMemo.id
  const sortedFiles = Object.keys(files).sort().map((k) => [k, files[k]] as const)
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sortedFiles)))
  const hash = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16)
  const id = `teenyuser-v${v}-${hash}`
  keyMemo = { version: v, id }
  return id
}

/**
 * Bundles the user's file tree and returns a LOADER-ready Fetcher. Cached
 * under an id derived from config.version + files hash, so repeat requests
 * with no change reuse the isolate.
 */
export async function spawnDynamic(
  _ctx: ExecutionContext,
  env: Env,
  files: FilesMap,
  config: DatabaseSettings,
  exports: { D1RPC: any }
) {
  const d1Stub = exports.D1RPC({})
  const id = await cacheKey(config, files)

  const worker = env.LOADER.get(id, async () => {
    const bundled = await createWorker({
      files,
      bundle: true,
      externals: EXTERNALS,
    })
    const configModule = `export default ${JSON.stringify(config)};\n`
    const modules: Record<string, any> = { ...bundled.modules }
    modules["teenybase"] = { js: teenybaseBundle as string }
    modules["virtual:teenybase"] = { js: configModule }
    return {
      compatibilityDate: COMPAT_DATE,
      compatibilityFlags: ["nodejs_compat"],
      mainModule: bundled.mainModule,
      modules,
      env: { TEENY_PRIMARY_DB: d1Stub },
      globalOutbound: null,
    }
  })
  return worker.getEntrypoint()
}
