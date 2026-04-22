// Spawns the dynamic user worker via LOADER.load(). Module layout (matches
// packages/notes-sample's structure):
//
//   "worker.js"          — user-editable entry. Does teenybase setup +
//                          app.route("/", userApp). LOADER treats this as
//                          the mainModule.
//   "./user.js"          — user-editable Hono app. Exports default.
//   "virtual:teenybase"  — generated config module (export default <config>).
//                          Same name teenybase's CLI uses — the convention
//                          is preserved for mental-model parity even though
//                          here it's an actual runtime module-map key, not
//                          a build-time alias.
//   "teenybase"          — the teenybase bundle, keyed as a bare specifier
//                          so user code writes `import ... from "teenybase"`
//                          like they would in a normal project.
//
// Workerd's WorkerLoader resolves by exact string match against the modules
// map — keys don't have to be relative paths.
import type { DatabaseSettings } from "teenybase"
// @ts-ignore — ?raw imports resolved by Vite at build time
import teenybaseBundle from "../user-runtime/teenybase_bundle.js?raw"
// @ts-ignore
import starterWorkerCode from "../user-runtime/starter-worker-code.ts?raw"
// @ts-ignore
import starterUserCode from "../user-runtime/starter-user-code.ts?raw"

export const STARTER_WORKER_CODE: string = starterWorkerCode as string
export const STARTER_USER_CODE: string = starterUserCode as string

const COMPAT_DATE = "2026-01-28"

type Env = {
  TEENY_PRIMARY_DB: D1Database
  LOADER: any
}

export async function spawnDynamic(
  ctx: ExecutionContext,
  env: Env,
  config: DatabaseSettings,
  workerCode: string | null,
  userCode: string | null,
  exports: { D1RPC: any }
) {
  const d1Stub = exports.D1RPC({})
  const configModule = `export default ${JSON.stringify(config)};\n`
  // Workerd requires module names to end in .js/.py unless the value is the
  // { js | cjs | text | ... } object form. We use the object form so the
  // specifiers ("teenybase", "virtual:teenybase") can be bare/virtual — that
  // matches the CLI convention notes-sample uses at build time.
  const worker = env.LOADER.load({
    compatibilityDate: COMPAT_DATE,
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "worker.js",
    modules: {
      "worker.js": { js: workerCode && workerCode.trim() ? workerCode : STARTER_WORKER_CODE },
      "./user.js": { js: userCode && userCode.trim() ? userCode : STARTER_USER_CODE },
      "virtual:teenybase": { js: configModule },
      "teenybase": { js: teenybaseBundle as string },
    },
    env: { TEENY_PRIMARY_DB: d1Stub },
    globalOutbound: null,
  })
  return worker.getEntrypoint()
}
