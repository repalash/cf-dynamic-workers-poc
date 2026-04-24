// Admin sub-app at /_teeny/admin/api/*. Error handling is centralized via
// Hono's onError + HTTPException — handlers just throw on 4xx conditions and
// let the middleware serialize.
import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { adminGate } from "./auth"
import {
  deleteDraftFiles,
  readConfig,
  readDraftFiles,
  readFiles,
  writeDraftFiles,
} from "./state"
import type { FilesMap } from "./state"
import { clearDB, deploy, generate, history, setup, status } from "./migrations"
import { STARTER_FILES } from "../user-runtime/starter-files"
import { TEENYBASE_VERSION } from "teenybase"
import { handleChat, getChatLogs } from "./chat"
import { buildUserWorker } from "./build-user-worker"

type Env = {
  Bindings: {
    TEENY_PRIMARY_DB: D1Database
    LOADER: any
    MIGRATE_UI_USER?: string
    MIGRATE_UI_PASSWORD?: string
    DEBUG_ERRORS?: string
  }
}

const MAX_FILES_BYTES = 1024 * 1024

function validateFiles(input: unknown): FilesMap {
  if (!input || typeof input !== "object") throw new HTTPException(400, { message: "files must be an object" })
  const out: FilesMap = {}
  let total = 0
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof k !== "string" || !k.length) throw new HTTPException(400, { message: "file names must be non-empty strings" })
    if (typeof v !== "string") throw new HTTPException(400, { message: `file ${k}: content must be a string` })
    out[k] = v
    total += v.length
  }
  if (total > MAX_FILES_BYTES) throw new HTTPException(413, { message: "total files size exceeds 1 MB" })
  return out
}

async function parseJsonBody(c: Context<Env>): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON" })
  }
}

async function filesFromBody(c: Context<Env>): Promise<{ files: FilesMap; body: Record<string, unknown> }> {
  const body = await parseJsonBody(c)
  return { files: validateFiles(body.files), body }
}

export function createAdminRoutes() {
  const app = new Hono<Env>()
  app.use("*", adminGate())

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    const debug = c.env.DEBUG_ERRORS === "1"
    const body: Record<string, unknown> = { error: (err as any)?.message ?? String(err) }
    if (debug) body.stack = (err as any)?.stack
    return c.json(body, 500)
  })

  app.get("/status", async (c) => c.json(await status(c.env.TEENY_PRIMARY_DB, TEENYBASE_VERSION)))

  app.get("/files", async (c) => {
    const [live, draft, config] = await Promise.all([
      readFiles(c.env.TEENY_PRIMARY_DB),
      readDraftFiles(c.env.TEENY_PRIMARY_DB),
      readConfig(c.env.TEENY_PRIMARY_DB),
    ])
    return c.json({ live, draft, editor: draft ?? live ?? STARTER_FILES, config })
  })

  app.post("/save-draft", async (c) => {
    const { files } = await filesFromBody(c)
    await writeDraftFiles(c.env.TEENY_PRIMARY_DB, files)
    return c.json({ ok: true })
  })

  app.post("/revert-draft", async (c) => {
    await deleteDraftFiles(c.env.TEENY_PRIMARY_DB)
    return c.json({ ok: true })
  })

  app.post("/setup", async (c) => {
    await setup(c.env.TEENY_PRIMARY_DB)
    return c.json({ ok: true })
  })

  app.post("/validate-build", async (c) => {
    const { files } = await filesFromBody(c)
    const result = await buildUserWorker(files)
    if (result.ok) {
      return c.json({ ok: true, mainModule: result.mainModule, warnings: result.warnings })
    }
    return c.json({ ok: false, error: result.error }, 422)
  })

  app.post("/generate", async (c) => {
    const { files } = await filesFromBody(c)
    return c.json(await generate(c.env.TEENY_PRIMARY_DB, { LOADER: c.env.LOADER }, files))
  })

  app.post("/deploy", async (c) => {
    const { files, body } = await filesFromBody(c)
    if (!("baselineVersion" in body)) {
      throw new HTTPException(400, { message: "baselineVersion is required" })
    }
    const baselineVersion = body.baselineVersion
    if (baselineVersion !== null && typeof baselineVersion !== "number") {
      throw new HTTPException(400, { message: "baselineVersion must be a number or null" })
    }
    const customSql = typeof body.customSql === "string" ? body.customSql.trim() : undefined
    const customName = typeof body.customName === "string" ? body.customName.trim() : undefined
    return c.json(
      await deploy(c.env.TEENY_PRIMARY_DB, { LOADER: c.env.LOADER }, files, {
        customSql: customSql || undefined,
        customName: customName || undefined,
        baselineVersion,
      })
    )
  })

  app.get("/history", async (c) => c.json({ rows: await history(c.env.TEENY_PRIMARY_DB) }))

  app.post("/clear", async (c) => {
    const r = await clearDB(c.env.TEENY_PRIMARY_DB)
    if (r.remaining.length) {
      throw new HTTPException(500, {
        message: `Could not drop ${r.remaining.length} table(s): ${r.remaining.join(", ")}`,
      })
    }
    return c.json({ ok: true, dropped: r.dropped.length, names: r.dropped })
  })

  // AI chat endpoint — streams responses via Vercel AI SDK protocol.
  app.post("/chat", async (c) => {
    const url = new URL(c.req.url)
    // D1RPC export is needed for testEndpoint to spawn the dynamic worker
    const exports = (c.executionCtx as any).exports || (globalThis as any).__exports
    return handleChat(c.req.raw, {
      AI: (c.env as any).AI,
      TEENY_PRIMARY_DB: c.env.TEENY_PRIMARY_DB,
      LOADER: c.env.LOADER,
      WORKER_URL: url.origin,
      D1RPC_EXPORT: exports,
      WAIT_UNTIL: (p: Promise<any>) => c.executionCtx.waitUntil(p),
    })
  })

  // Chat log query endpoints — list all sessions or drill into one
  app.get("/chat-logs", async (c) => {
    const limit = parseInt(c.req.query("limit") ?? "50", 10)
    const sessionId = c.req.query("session") ?? undefined
    return c.json({ logs: await getChatLogs(c.env.TEENY_PRIMARY_DB, limit, sessionId) })
  })

  // Test-only: wipe admin state rows. Gated behind DEBUG_ERRORS so production
  // deploys don't expose this.
  app.post("/_reset-admin-state", async (c) => {
    if (c.env.DEBUG_ERRORS !== "1") throw new HTTPException(404, { message: "not found" })
    await c.env.TEENY_PRIMARY_DB.prepare("DELETE FROM _teeny_admin_state").run().catch(() => {})
    return c.json({ ok: true })
  })

  return app
}
