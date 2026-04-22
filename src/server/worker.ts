// Host worker:
//   /_teeny/admin/api/*  → admin Hono sub-app
//   /_teeny/admin/*      → SPA assets (with SPA fallback to index.html)
//   everything else      → bundle current live files + LOADER.load + forward
import { createAdminRoutes } from "./admin/routes"
import { readRuntimeState } from "./admin/state"
import { spawnDynamic } from "./admin/spawn"

type Env = {
  TEENY_PRIMARY_DB: D1Database
  LOADER: any
  ASSETS: Fetcher
  MIGRATE_UI_USER?: string
  MIGRATE_UI_PASSWORD?: string
  DEBUG_ERRORS?: string
}

const adminRoutes = createAdminRoutes()

async function serveSPA(req: Request, env: Env): Promise<Response> {
  const first = await env.ASSETS.fetch(req)
  if (first.status !== 404) return first
  const url = new URL(req.url)
  return env.ASSETS.fetch(new Request(new URL("/_teeny/admin/index.html", url.origin).toString(), req))
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    if (path.startsWith("/_teeny/admin/api/")) {
      const stripped = path.replace(/^\/_teeny\/admin\/api/, "") || "/"
      return adminRoutes.fetch(new Request(new URL(stripped + url.search, url.origin).toString(), req), env, ctx)
    }
    if (path.startsWith("/_teeny/admin")) return serveSPA(req, env)

    const { files, config } = await readRuntimeState(env.TEENY_PRIMARY_DB)
    if (!files || !config) {
      return new Response("Setup required. Visit /_teeny/admin to initialize.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }
    try {
      const dyn = await spawnDynamic(
        ctx,
        env,
        files,
        config,
        (ctx as any).exports || (globalThis as any).__exports
      )
      return dyn.fetch(req)
    } catch (e: any) {
      const debug = env.DEBUG_ERRORS === "1"
      const body = debug
        ? `Dynamic worker spawn/fetch failed:\n${e?.message}\n\n${e?.stack ?? ""}`
        : `Dynamic worker spawn/fetch failed: ${e?.message}`
      return new Response(body, { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } })
    }
  },
} satisfies ExportedHandler<Env>

export { D1RPC } from "./rpc/D1RPC"
