// Evaluates the user's teenybase.ts (or .js) file to a JSON DatabaseSettings.
//
// Approach: bundle teenybase.ts via @cloudflare/worker-bundler along with a
// tiny entry shim that imports the default export and returns it as JSON.
// Load the bundle into a throwaway LOADER isolate + fetch it. This lets the
// user write TS using `import { sqlValue, baseFields } from "teenybase"` and
// have the module resolve to the teenybase bundle at runtime.
//
// Caveats:
//   - Config is expected as the module's DEFAULT export.
//   - teenybase is declared external; the modules map injects the bundle.
//   - sqlValue/sql/sqlRaw/baseFields/etc. come from the teenybase bundle's
//     re-exports (see user-runtime/bundle-entry.ts).
import { createWorker } from "@cloudflare/worker-bundler"
import type { DatabaseSettings } from "teenybase"
import type { FilesMap } from "@shared/types"
// @ts-ignore — ?raw import
import teenybaseBundle from "../user-runtime/teenybase_bundle.js?raw"

const COMPAT_DATE = "2026-01-28"

const EVAL_ENTRY = `import config from "./teenybase.ts";
export default { async fetch() { return Response.json(config); } };
`

/**
 * Returns the config object defined by the given files' teenybase.ts (or .js).
 * Throws if no teenybase.{ts,js} file exists or if evaluation fails.
 */
export async function evalConfigFromFiles(
  env: { LOADER: any },
  files: FilesMap
): Promise<DatabaseSettings> {
  const configFile =
    "teenybase.ts" in files
      ? "teenybase.ts"
      : "teenybase.js" in files
        ? "teenybase.js"
        : null
  if (!configFile) {
    throw new Error("teenybase.ts (or teenybase.js) not found in files")
  }

  // Bundle a tiny entry that imports the user's config and fetches it.
  const evalFiles: FilesMap = {
    "teenybase.ts": files["teenybase.ts"] ?? files["teenybase.js"]!,
    "entry.js": EVAL_ENTRY,
    "package.json": JSON.stringify({
      name: "teenybase-config-eval",
      main: "entry.js",
      type: "module",
    }),
  }
  if (configFile === "teenybase.js") {
    // Rename so entry import can stay stable.
    evalFiles["teenybase.ts"] = files["teenybase.js"]!
  }

  const bundled = await createWorker({
    files: evalFiles,
    bundle: true,
    externals: ["teenybase"],
  })

  const modules: Record<string, any> = { ...bundled.modules }
  modules["teenybase"] = { js: teenybaseBundle as string }

  const worker = env.LOADER.load({
    compatibilityDate: COMPAT_DATE,
    compatibilityFlags: ["nodejs_compat"],
    mainModule: bundled.mainModule,
    modules,
    env: {},
    globalOutbound: null,
  })

  const res = await worker.getEntrypoint().fetch(new Request("https://eval.local/"))
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Config eval returned ${res.status}: ${text.slice(0, 400)}`)
  }
  const json = (await res.json()) as unknown
  if (typeof json !== "object" || !json) {
    throw new Error("Config eval: default export is not an object")
  }
  return json as DatabaseSettings
}
