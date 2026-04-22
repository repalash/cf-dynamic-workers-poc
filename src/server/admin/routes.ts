// Admin sub-app — mounted at /_teeny/admin/api/*. Routes:
//   GET  /status            — meta-table presence, $settings, drift state
//   GET  /files             — current files + cached config
//   POST /save-files         { files }  — persist + re-eval config
//   POST /setup             — seed starter files, eval config, create meta tables
//   POST /eval-config        { files }  — pure: bundle + run teenybase.ts, return config
//   POST /generate           { files }  — eval + generate preview (no persist)
//   POST /apply              { files, baselineVersion, customSql?, customName?, markAsApplied? }
//   POST /sync-from-d1      — pull $settings into state.config (leaves files)
//   GET  /history           — rows from _db_migrations
//   POST /clear             — drop teenybase tables; preserve _teeny_admin_state
import { Hono } from "hono"
import { adminGate } from "./auth"
import {
  readConfig,
  readFiles,
  writeConfig,
  writeFiles,
} from "./state"
import type { FilesMap } from "./state"
import {
  setup,
  status,
  generate,
  apply,
  clearDB,
  syncAdminFromD1,
  history,
} from "./migrations"
import { evalConfigFromFiles } from "./eval-config"
import { STARTER_FILES } from "../user-runtime/starter-files"
import { TEENYBASE_VERSION } from "teenybase"

type Env = {
  Bindings: {
    TEENY_PRIMARY_DB: D1Database
    LOADER: any
    MIGRATE_UI_USER?: string
    MIGRATE_UI_PASSWORD?: string
    DEBUG_ERRORS?: string
  }
}

function errJson(e: unknown, debug: boolean) {
  const msg = (e as any)?.message ?? String(e)
  const body: Record<string, unknown> = { error: msg }
  if (debug) body.stack = (e as any)?.stack
  return body
}

function validateFiles(input: unknown): FilesMap {
  if (!input || typeof input !== "object") {
    throw new Error("files must be an object")
  }
  const out: FilesMap = {}
  let total = 0
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof k !== "string" || !k.length) throw new Error("file names must be non-empty strings")
    if (typeof v !== "string") throw new Error(`file ${k}: content must be a string`)
    out[k] = v
    total += v.length
  }
  if (total > 1024 * 1024) throw new Error("total files size exceeds 1 MB")
  return out
}

export function createAdminRoutes() {
  const app = new Hono<Env>()
  app.use("*", adminGate())

  app.get("/status", async (c) => {
    try {
      const s = await status(c.env.TEENY_PRIMARY_DB, TEENYBASE_VERSION)
      return c.json(s)
    } catch (e) {
      return c.json(errJson(e, c.env.DEBUG_ERRORS === "1"), 500)
    }
  })

  app.get("/files", async (c) => {
    const [files, config] = await Promise.all([
      readFiles(c.env.TEENY_PRIMARY_DB),
      readConfig(c.env.TEENY_PRIMARY_DB),
    ])
    return c.json({
      files: files ?? STARTER_FILES,
      filesSaved: files !== null,
      config,
    })
  })

  app.post("/save-files", async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON" }, 400)
    }
    let files: FilesMap
    try {
      files = validateFiles(body?.files)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    await writeFiles(c.env.TEENY_PRIMARY_DB, files)
    // Best-effort re-eval; save-files shouldn't fail on a bad teenybase.ts
    // — user might be in the middle of editing. Report the eval error
    // separately in the response.
    let configUpdated = false
    let evalError: string | null = null
    try {
      const cfg = await evalConfigFromFiles(c.env, files)
      await writeConfig(c.env.TEENY_PRIMARY_DB, cfg)
      configUpdated = true
    } catch (e: any) {
      evalError = e?.message ?? String(e)
    }
    return c.json({ ok: true, configUpdated, evalError })
  })

  app.post("/setup", async (c) => {
    try {
      await setup(c.env.TEENY_PRIMARY_DB, c.env as any)
      return c.json({ ok: true })
    } catch (e) {
      return c.json(errJson(e, c.env.DEBUG_ERRORS === "1"), 500)
    }
  })

  app.post("/eval-config", async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON" }, 400)
    }
    let files: FilesMap
    try {
      files = validateFiles(body?.files)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    try {
      const cfg = await evalConfigFromFiles(c.env, files)
      return c.json({ config: cfg })
    } catch (e) {
      return c.json(errJson(e, c.env.DEBUG_ERRORS === "1"), 400)
    }
  })

  app.post("/generate", async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON" }, 400)
    }
    let files: FilesMap
    try {
      files = validateFiles(body?.files)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    try {
      const g = await generate(c.env.TEENY_PRIMARY_DB, c.env as any, files)
      return c.json(g)
    } catch (e) {
      return c.json(errJson(e, c.env.DEBUG_ERRORS === "1"), 400)
    }
  })

  app.post("/apply", async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON" }, 400)
    }
    let files: FilesMap
    try {
      files = validateFiles(body?.files)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    if (!("baselineVersion" in (body ?? {}))) {
      return c.json(
        { error: "baselineVersion is required (use the one returned by /generate)" },
        400
      )
    }
    const baselineVersion = body.baselineVersion
    if (baselineVersion !== null && typeof baselineVersion !== "number") {
      return c.json({ error: "baselineVersion must be a number or null" }, 400)
    }
    const customSql = typeof body.customSql === "string" ? body.customSql.trim() : undefined
    const customName = typeof body.customName === "string" ? body.customName.trim() : undefined
    const markAsApplied = body.markAsApplied === true
    if (customSql && markAsApplied) {
      return c.json({ error: "markAsApplied and customSql are mutually exclusive" }, 400)
    }
    try {
      const r = await apply(c.env.TEENY_PRIMARY_DB, c.env as any, files, {
        customSql: customSql || undefined,
        customName: customName || undefined,
        markAsApplied,
        baselineVersion,
      })
      return c.json(r)
    } catch (e) {
      return c.json(errJson(e, c.env.DEBUG_ERRORS === "1"), 500)
    }
  })

  app.get("/history", async (c) => {
    const rows = await history(c.env.TEENY_PRIMARY_DB)
    return c.json({ rows })
  })

  app.post("/clear", async (c) => {
    try {
      const r = await clearDB(c.env.TEENY_PRIMARY_DB)
      if (r.remaining.length) {
        return c.json(
          {
            error: `Could not drop ${r.remaining.length} table(s): ${r.remaining.join(", ")}`,
            dropped: r.dropped,
            remaining: r.remaining,
          },
          500
        )
      }
      return c.json({ ok: true, dropped: r.dropped.length, names: r.dropped })
    } catch (e) {
      return c.json(errJson(e, c.env.DEBUG_ERRORS === "1"), 500)
    }
  })

  app.post("/sync-from-d1", async (c) => {
    try {
      await syncAdminFromD1(c.env.TEENY_PRIMARY_DB)
      return c.json({ ok: true })
    } catch (e) {
      return c.json(errJson(e, c.env.DEBUG_ERRORS === "1"), 400)
    }
  })

  return app
}
