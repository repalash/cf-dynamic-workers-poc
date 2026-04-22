// Admin sub-app — mounted at /_teeny/admin/api/*. Routes mirror cf-ui-sample's
// migrate_admin.js, minus the config.js-file-specific ones (this POC has no
// config.js; admin state IS the source). Single panel flow: status → setup →
// generate → apply → history → clear.
import { Hono } from "hono"
import { adminGate } from "./auth"
import {
  readConfig,
  readUserCode,
  readWorkerCode,
  writeConfig,
  writeUserCode,
  writeWorkerCode,
} from "./state"
import {
  setup,
  status,
  generate,
  apply,
  clearDB,
  syncAdminFromD1,
  history,
} from "./migrations"
import { STARTER_USER_CODE, STARTER_WORKER_CODE } from "./spawn"
import { TEENYBASE_VERSION, databaseSettingsSchema } from "teenybase"

type Env = {
  Bindings: {
    TEENY_PRIMARY_DB: D1Database
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

  // Returns both the config and the current user.js source so the admin UI
  // can seed both editors on first load. If user.js is missing in state, we
  // return the starter (the same fallback spawn uses) — so editing from blank
  // state behaves like editing the actually-running code.
  app.get("/config", async (c) => {
    const [cfg, workerCode, userCode] = await Promise.all([
      readConfig(c.env.TEENY_PRIMARY_DB),
      readWorkerCode(c.env.TEENY_PRIMARY_DB),
      readUserCode(c.env.TEENY_PRIMARY_DB),
    ])
    return c.json({
      config: cfg,
      workerCode: workerCode ?? STARTER_WORKER_CODE,
      workerCodeIsSaved: workerCode !== null,
      userCode: userCode ?? STARTER_USER_CODE,
      userCodeIsSaved: userCode !== null,
    })
  })

  const saveStringRoute = (key: "userCode" | "workerCode", writer: (db: D1Database, s: string) => Promise<void>) =>
    async (c: any) => {
      let body: any
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: "Invalid JSON" }, 400)
      }
      const code = body?.[key]
      if (typeof code !== "string") return c.json({ error: `${key} must be a string` }, 400)
      if (code.length > 256 * 1024) return c.json({ error: `${key} too large (>256 KB)` }, 413)
      await writer(c.env.TEENY_PRIMARY_DB, code)
      return c.json({ ok: true })
    }

  app.post("/save-user-code", saveStringRoute("userCode", writeUserCode))
  app.post("/save-worker-code", saveStringRoute("workerCode", writeWorkerCode))

  app.post("/setup", async (c) => {
    try {
      await setup(c.env.TEENY_PRIMARY_DB)
      return c.json({ ok: true })
    } catch (e) {
      return c.json(errJson(e, c.env.DEBUG_ERRORS === "1"), 500)
    }
  })

  app.post("/generate", async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400)
    }
    const parsed = databaseSettingsSchema.safeParse(body?.config)
    if (!parsed.success) {
      return c.json({ error: "Invalid config", details: parsed.error.format() }, 400)
    }
    try {
      const g = await generate(c.env.TEENY_PRIMARY_DB, parsed.data as any)
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
      return c.json({ error: "Invalid JSON body" }, 400)
    }
    const parsed = databaseSettingsSchema.safeParse(body?.config)
    if (!parsed.success) {
      return c.json({ error: "Invalid config", details: parsed.error.format() }, 400)
    }
    if (!("baselineVersion" in (body ?? {}))) {
      return c.json(
        {
          error:
            "baselineVersion is required (fetch /status first; send its .version field, or null on a fresh DB)",
        },
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
      const r = await apply(c.env.TEENY_PRIMARY_DB, parsed.data as any, {
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
        return c.json({
          error: `Could not drop ${r.remaining.length} table(s) after dep-sort + FK-off fallback: ${r.remaining.join(", ")}. Dropped ${r.dropped.length}: ${r.dropped.join(", ")}.`,
          dropped: r.dropped,
          remaining: r.remaining,
        }, 500)
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

  // Manually overwrite admin state (no SQL ran). Not used by the current UI
  // but handy for programmatic workflows.
  app.post("/save-config", async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON" }, 400)
    }
    const parsed = databaseSettingsSchema.safeParse(body?.config)
    if (!parsed.success)
      return c.json({ error: "Invalid config", details: parsed.error.format() }, 400)
    await writeConfig(c.env.TEENY_PRIMARY_DB, parsed.data as any)
    return c.json({ ok: true })
  })

  return app
}
