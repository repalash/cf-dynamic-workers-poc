// Admin sub-app — mounted at /_teeny/admin/api/*.
//
// Flow: edit drafts → Generate preview → Deploy (atomic).
//
//   GET  /status            — meta tables + drift + migration count + version
//   GET  /files             — { live, draft, config } — draft ?? live ?? starter
//   POST /save-draft         { files }  — persist drafts
//   POST /revert-draft      — delete draft row (editor re-seeds from live)
//   POST /setup             — seed starter drafts + create meta tables
//   POST /eval-config        { files }  — bundle + run teenybase.ts, return JSON
//   POST /generate           { files }  — eval + diff; no writes
//   POST /deploy             { files, baselineVersion, customSql?, customName? }
//                             atomic: run migrations + promote files + bump version
//   POST /sync-from-d1      — pull $settings into state.config
//   GET  /history           — _db_migrations rows
//   POST /clear             — drop user + teenybase tables (preserve admin state)
import { Hono } from "hono"
import { adminGate } from "./auth"
import {
  readConfig,
  readDraftFiles,
  readFiles,
  writeDraftFiles,
  deleteDraftFiles,
} from "./state"
import type { FilesMap } from "./state"
import {
  clearDB,
  deploy,
  generate,
  history,
  setup,
  status,
  syncAdminFromD1,
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
  if (!input || typeof input !== "object") throw new Error("files must be an object")
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
    const [live, draft, config] = await Promise.all([
      readFiles(c.env.TEENY_PRIMARY_DB),
      readDraftFiles(c.env.TEENY_PRIMARY_DB),
      readConfig(c.env.TEENY_PRIMARY_DB),
    ])
    // If there's no live deploy yet and no draft, the editor should get the
    // starter so the user has something to edit. UI distinguishes "live is
    // null" (nothing deployed yet) from "draft is null" (nothing unsaved).
    const editor = draft ?? live ?? STARTER_FILES
    return c.json({
      live,
      draft,
      editor,
      config,
    })
  })

  app.post("/save-draft", async (c) => {
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
    await writeDraftFiles(c.env.TEENY_PRIMARY_DB, files)
    return c.json({ ok: true })
  })

  app.post("/revert-draft", async (c) => {
    await deleteDraftFiles(c.env.TEENY_PRIMARY_DB)
    return c.json({ ok: true })
  })

  // Test-only: wipe admin state rows (drafts + live files + config) so the
  // next request behaves like a fresh install. Does NOT drop user tables —
  // pair with /clear for that. Not exposed in the UI.
  app.post("/_reset-admin-state", async (c) => {
    await c.env.TEENY_PRIMARY_DB
      .prepare("DELETE FROM _teeny_admin_state")
      .run()
      .catch(() => {})
    return c.json({ ok: true })
  })

  app.post("/setup", async (c) => {
    try {
      await setup(c.env.TEENY_PRIMARY_DB)
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

  app.post("/deploy", async (c) => {
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
      return c.json({ error: "baselineVersion is required" }, 400)
    }
    const baselineVersion = body.baselineVersion
    if (baselineVersion !== null && typeof baselineVersion !== "number") {
      return c.json({ error: "baselineVersion must be a number or null" }, 400)
    }
    const customSql = typeof body.customSql === "string" ? body.customSql.trim() : undefined
    const customName = typeof body.customName === "string" ? body.customName.trim() : undefined
    try {
      const r = await deploy(c.env.TEENY_PRIMARY_DB, c.env as any, files, {
        customSql: customSql || undefined,
        customName: customName || undefined,
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
          { error: `Could not drop ${r.remaining.length} table(s): ${r.remaining.join(", ")}`, ...r },
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
