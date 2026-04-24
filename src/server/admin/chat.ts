// Streaming AI chat endpoint using Workers AI + Vercel AI SDK.
// Tools give the LLM direct access to file editing, migration generation,
// and deployment — the same operations the admin UI exposes manually.
import { streamText, tool, stepCountIs, convertToModelMessages, type UIMessage } from "ai"
import { createWorkersAI } from "workers-ai-provider"
import { z } from "zod"
import {
  readFiles,
  readDraftFiles,
  writeDraftFiles,
  type FilesMap,
} from "./state"
import { generate, deploy, status, history } from "./migrations"
import { spawnDynamic } from "./spawn"
import { readConfig } from "./state"
import { TEENYBASE_VERSION } from "teenybase"

type ChatEnv = {
  AI: Ai
  TEENY_PRIMARY_DB: D1Database
  LOADER: any
  WORKER_URL: string // origin URL for constructing test requests
  D1RPC_EXPORT: any // D1RPC class export for spawning dynamic workers
}

const SYSTEM_PROMPT = `You are a coding assistant for Teenybase, a database schema manager running on Cloudflare Workers.

You help users build their app by editing configuration files in a dynamic Cloudflare Worker. The workflow is:
1. Read current files to understand what exists
2. Edit files as needed (teenybase.ts for schema, worker.js for the worker entry, user.js for the Hono app, package.json for config)
3. Generate migration preview to see what SQL will run
4. Deploy to apply changes

## File structure
- **teenybase.ts** — Schema config. Default export is a DatabaseSettings object defining tables, fields, indexes, extensions (auth, rules), triggers. Uses imports from "teenybase" (baseFields, authFields, createdTrigger, updatedTrigger, sql, sqlValue).
- **worker.js** — Dynamic worker entry. Sets up teenybase + mounts the user app. Usually doesn't need changes unless adding middleware.
- **user.js** — Hono app with SSR pages using \`html\` tagged templates (no JSX — dynamic workers can't transpile). Imports from "teenybase" for Hono, html, raw, setCookie, deleteCookie, getCookie.
- **package.json** — Declares the entry module. Rarely needs changes.

## Important rules
- user.js uses \`html\` tagged template literals from "teenybase" for rendering (NOT JSX/TSX)
- Always read files first before editing to see current state
- After editing files, generate a migration preview, then deploy
- When writing teenybase.ts, follow the existing pattern with baseFields, authFields, triggers, etc.
- Field types: text, number, bool, json, relation. Use sqlType for the underlying SQL type.
- Extensions: auth (for user tables), rules (access control), fts (full-text search)
- Rules use teenybase's expression syntax: auth.uid, auth.role, field comparisons
- The deploy is atomic: migrations + file promotion happen together

The app is deployed on Cloudflare Workers — never reference localhost. When telling the user where to test, say "the live app" or "your deployed worker". The deploy tool pushes changes to the live Cloudflare Worker instantly.

## Verifying changes
After deploying, always verify your changes actually work:
- Use testEndpoint to hit /api/v1/health and confirm the app is responding
- Use listTables to confirm tables were created/dropped correctly
- Use queryTable to inspect data if needed
- Use testEndpoint to test specific pages (GET /, GET /login, etc.) and confirm rendering
- If something fails, use runSQL to debug the database state

Be concise. Write code directly. After making changes, always generate, deploy, and verify.`

export async function handleChat(
  req: Request,
  env: ChatEnv
): Promise<Response> {
  const body = (await req.json()) as { messages: UIMessage[] }

  const workersai = createWorkersAI({ binding: env.AI })
  const modelMessages = await convertToModelMessages(body.messages)

  const result = streamText({
    model: workersai("@cf/zai-org/glm-4.7-flash"),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    stopWhen: stepCountIs(8),
    tools: {
      getStatus: tool({
        description:
          "Get the current status of the teenybase deployment: which tables exist, migration count, version, and whether setup is needed.",
        parameters: z.object({}),
        execute: async () => {
          const s = await status(env.TEENY_PRIMARY_DB, TEENYBASE_VERSION)
          return {
            setupRequired: s.configMatch === "setup-required",
            migrationCount: s.migrationCount,
            version: s.version,
            configMatch: s.configMatch,
            metaTables: s.metaTables,
          }
        },
      }),

      getFiles: tool({
        description:
          "Read all current files (draft or live). Returns a map of filename → content. Always call this before editing to see the current state.",
        parameters: z.object({}),
        execute: async () => {
          const draft = await readDraftFiles(env.TEENY_PRIMARY_DB)
          const live = await readFiles(env.TEENY_PRIMARY_DB)
          const files = draft ?? live ?? {}
          return { files }
        },
      }),

      writeFile: tool({
        description:
          "Write or update a single file. This saves as a draft (not yet deployed). The file will be part of the dynamic worker bundle.",
        parameters: z.object({
          filename: z
            .string()
            .describe(
              "The filename to write (e.g. teenybase.ts, worker.js, user.js)"
            ),
          content: z.string().describe("The full file content to write"),
        }),
        execute: async ({ filename, content }) => {
          const draft = await readDraftFiles(env.TEENY_PRIMARY_DB)
          const live = await readFiles(env.TEENY_PRIMARY_DB)
          const current = draft ?? live ?? {}
          const updated: FilesMap = { ...current, [filename]: content }
          await writeDraftFiles(env.TEENY_PRIMARY_DB, updated)
          return { ok: true, filename, filesCount: Object.keys(updated).length }
        },
      }),

      deleteFile: tool({
        description: "Delete a file from the draft file set.",
        parameters: z.object({
          filename: z.string().describe("The filename to delete"),
        }),
        execute: async ({ filename }) => {
          const draft = await readDraftFiles(env.TEENY_PRIMARY_DB)
          const live = await readFiles(env.TEENY_PRIMARY_DB)
          const current = draft ?? live ?? {}
          const { [filename]: _, ...rest } = current
          await writeDraftFiles(env.TEENY_PRIMARY_DB, rest)
          return { ok: true, deleted: filename }
        },
      }),

      generateMigrations: tool({
        description:
          "Generate a migration preview. Bundles and evaluates teenybase.ts, diffs against the current DB schema, and returns the SQL migrations that would run. Call this after editing files to see what changes will be applied.",
        parameters: z.object({}),
        execute: async () => {
          const draft = await readDraftFiles(env.TEENY_PRIMARY_DB)
          const live = await readFiles(env.TEENY_PRIMARY_DB)
          const files = draft ?? live ?? {}
          try {
            const result = await generate(
              env.TEENY_PRIMARY_DB,
              { LOADER: env.LOADER },
              files
            )
            return {
              migrationsCount: result.migrations.length,
              migrations: result.migrations.map((m) => ({
                name: m.name,
                sql: m.sql,
              })),
              changes: result.changes,
              extraLogs: result.extraLogs,
              version: result.version,
            }
          } catch (e: any) {
            return { error: e?.message ?? String(e) }
          }
        },
      }),

      deploy: tool({
        description:
          "Deploy: atomically runs pending migrations and promotes draft files to live. The dynamic worker will immediately serve the new code. Call generateMigrations first to preview what will happen.",
        parameters: z.object({}),
        execute: async () => {
          const draft = await readDraftFiles(env.TEENY_PRIMARY_DB)
          const live = await readFiles(env.TEENY_PRIMARY_DB)
          const files = draft ?? live ?? {}

          // Get current version for baseline
          const s = await status(env.TEENY_PRIMARY_DB, TEENYBASE_VERSION)
          const baselineVersion = s.version

          try {
            const result = await deploy(
              env.TEENY_PRIMARY_DB,
              { LOADER: env.LOADER },
              files,
              { baselineVersion }
            )
            return {
              ok: true,
              version: result.version,
              applied: result.applied,
              promotedFiles: result.promotedFiles,
            }
          } catch (e: any) {
            return { error: e?.message ?? String(e) }
          }
        },
      }),

      getMigrationHistory: tool({
        description: "Get the history of applied migrations.",
        parameters: z.object({}),
        execute: async () => {
          const rows = await history(env.TEENY_PRIMARY_DB)
          return { rows: rows.slice(0, 20) }
        },
      }),

      listTables: tool({
        description:
          "List all tables in the D1 database with their column info. Use this to verify schema changes were applied correctly after deploying.",
        parameters: z.object({}),
        execute: async () => {
          try {
            const tables = await env.TEENY_PRIMARY_DB
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
              )
              .all<{ name: string }>()
            const result: Record<string, { columns: string[] }> = {}
            for (const t of tables.results ?? []) {
              const cols = await env.TEENY_PRIMARY_DB
                .prepare(`PRAGMA table_info("${t.name.replace(/"/g, '""')}")`)
                .all<{ name: string; type: string; notnull: number }>()
              result[t.name] = {
                columns: (cols.results ?? []).map(
                  (c) => `${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}`
                ),
              }
            }
            return result
          } catch (e: any) {
            return { error: e?.message ?? String(e) }
          }
        },
      }),

      queryTable: tool({
        description:
          "Read rows from a table. Use this to inspect data, verify inserts, or check that a table was created correctly. Returns up to 20 rows.",
        parameters: z.object({
          table: z.string().describe("Table name to query"),
          where: z
            .string()
            .optional()
            .describe("Optional WHERE clause (without the WHERE keyword), e.g. \"owner_id = 'abc'\""),
          limit: z
            .number()
            .optional()
            .describe("Max rows to return (default 20, max 50)"),
        }),
        execute: async ({ table, where, limit }) => {
          const n = Math.min(limit ?? 20, 50)
          const safeName = table.replace(/"/g, '""')
          let sql = `SELECT * FROM "${safeName}"`
          if (where) sql += ` WHERE ${where}`
          sql += ` LIMIT ${n}`
          try {
            const rows = await env.TEENY_PRIMARY_DB.prepare(sql).all()
            return {
              table,
              count: rows.results?.length ?? 0,
              rows: rows.results ?? [],
            }
          } catch (e: any) {
            return { error: e?.message ?? String(e) }
          }
        },
      }),

      runSQL: tool({
        description:
          "Run a read-only SQL query against D1 for debugging. Only SELECT, PRAGMA, and EXPLAIN are allowed. Use this to inspect database state, check indexes, or debug query issues.",
        parameters: z.object({
          sql: z.string().describe("The SQL query to run (SELECT/PRAGMA/EXPLAIN only)"),
        }),
        execute: async ({ sql: query }) => {
          const trimmed = query.trim().toUpperCase()
          if (
            !trimmed.startsWith("SELECT") &&
            !trimmed.startsWith("PRAGMA") &&
            !trimmed.startsWith("EXPLAIN")
          ) {
            return { error: "Only SELECT, PRAGMA, and EXPLAIN queries are allowed" }
          }
          try {
            const rows = await env.TEENY_PRIMARY_DB.prepare(query).all()
            return { rows: (rows.results ?? []).slice(0, 50) }
          } catch (e: any) {
            return { error: e?.message ?? String(e) }
          }
        },
      }),

      testEndpoint: tool({
        description:
          "Make a request to the live dynamic worker to verify it's working. Spawns the worker internally and calls its fetch handler directly. Use this after deploying to confirm the app responds correctly. Returns status code, headers, and body (truncated to 2000 chars).",
        parameters: z.object({
          path: z
            .string()
            .describe("The path to request, e.g. '/api/v1/health' or '/' or '/login'"),
          method: z
            .enum(["GET", "POST", "PUT", "DELETE"])
            .optional()
            .describe("HTTP method (default GET)"),
          body: z
            .string()
            .optional()
            .describe("Request body for POST/PUT (JSON string)"),
          headers: z
            .record(z.string())
            .optional()
            .describe("Additional headers to send"),
        }),
        execute: async ({ path, method, body: reqBody, headers: extraHeaders }) => {
          try {
            // Read live files + config, spawn the dynamic worker internally
            const live = await readFiles(env.TEENY_PRIMARY_DB)
            const config = await readConfig(env.TEENY_PRIMARY_DB)
            if (!live || !config) {
              return { error: "No deployed files/config found. Deploy first." }
            }
            const dyn = await spawnDynamic(
              { waitUntil: () => {} } as any,
              { TEENY_PRIMARY_DB: env.TEENY_PRIMARY_DB, LOADER: env.LOADER },
              live,
              config,
              env.D1RPC_EXPORT
            )
            // Build request
            const url = env.WORKER_URL + path
            const hdrs: Record<string, string> = { ...extraHeaders }
            const init: RequestInit = { method: method ?? "GET" }
            if (reqBody) {
              init.body = reqBody
              hdrs["content-type"] = hdrs["content-type"] ?? "application/json"
            }
            init.headers = hdrs
            const resp = await dyn.fetch(new Request(url, init))
            const text = await resp.text()
            return {
              status: resp.status,
              statusText: resp.statusText,
              contentType: resp.headers.get("content-type"),
              body: text.length > 2000 ? text.slice(0, 2000) + "... (truncated)" : text,
            }
          } catch (e: any) {
            return { error: e?.message ?? String(e) }
          }
        },
      }),
    },
  })

  return result.toUIMessageStreamResponse()
}
