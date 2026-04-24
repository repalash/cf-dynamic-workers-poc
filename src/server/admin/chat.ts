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
import { buildUserWorker, formatBuildError } from "./build-user-worker"

type ChatEnv = {
  AI: Ai
  TEENY_PRIMARY_DB: D1Database
  LOADER: any
  WORKER_URL: string // origin URL for constructing test requests
  D1RPC_EXPORT: any // D1RPC class export for spawning dynamic workers
  WAIT_UNTIL?: (p: Promise<any>) => void // ctx.waitUntil for background log writes
}

// ── Chat log persistence ──────────────────────────────────────────────
const CHAT_LOGS_DDL = `CREATE TABLE IF NOT EXISTS _teeny_chat_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_message TEXT,
  tool_calls TEXT,
  assistant_text TEXT,
  steps_json TEXT,
  error TEXT,
  duration_ms INTEGER
)`

async function ensureChatLogsTable(db: D1Database) {
  await db.prepare(CHAT_LOGS_DDL).run()
}

async function saveChatLog(
  db: D1Database,
  sessionId: string,
  userMessage: string,
  startTime: number,
  result: { text?: string; steps?: any[]; error?: string; toolCalls?: any[] }
) {
  try {
    await ensureChatLogsTable(db)
    const toolCalls = (result.steps ?? [])
      .flatMap((s: any) => s.toolCalls ?? [])
      .map((tc: any) => ({ name: tc.toolName, args: tc.args }))
    await db.prepare(
      `INSERT INTO _teeny_chat_logs (session_id, user_message, tool_calls, assistant_text, steps_json, error, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      sessionId,
      userMessage.slice(0, 10000),
      JSON.stringify(toolCalls),
      (result.text ?? "").slice(0, 50000),
      JSON.stringify((result.steps ?? []).map((s: any) => ({
        text: s.text?.slice?.(0, 2000),
        toolCalls: s.toolCalls?.map?.((tc: any) => ({ name: tc.toolName, args: tc.args })),
        toolResults: s.toolResults?.map?.((tr: any) => ({ name: tr.toolName, result: JSON.stringify(tr.result)?.slice(0, 2000) })),
      }))).slice(0, 100000),
      result.error ?? null,
      Math.round(performance.now() - startTime),
    ).run()
  } catch (e: any) {
    console.error("Chat log save failed:", e?.message)
  }
}

export async function getChatLogs(db: D1Database, limit = 50, sessionId?: string) {
  await ensureChatLogsTable(db)
  if (sessionId) {
    const rows = await db.prepare(
      `SELECT * FROM _teeny_chat_logs WHERE session_id = ? ORDER BY id DESC LIMIT ?`
    ).bind(sessionId, limit).all()
    return rows.results ?? []
  }
  const rows = await db.prepare(
    `SELECT id, session_id, created_at, user_message, duration_ms, error,
            json_array_length(tool_calls) as tool_count
     FROM _teeny_chat_logs ORDER BY id DESC LIMIT ?`
  ).bind(limit).all()
  return rows.results ?? []
}

const SYSTEM_PROMPT = `You are a coding assistant for Teenybase, a database schema manager running on Cloudflare Workers.

You help users build their app by editing configuration files in a dynamic Cloudflare Worker. The workflow is:
1. Read current files to understand what exists
2. Edit files as needed (teenybase.ts for schema, worker.js for the worker entry, user.js for the Hono app, package.json for config)
3. Validate the build to catch syntax/import errors before deploying
4. Generate migration preview to see what SQL will run
5. Deploy to apply changes
6. Verify with testEndpoint

Always call validateBuild after editing files and before generateMigrations/deploy. If validation fails, fix the errors and re-validate. Never deploy without a passing build.

## File structure
- **teenybase.ts** — Schema config. Default export is a DatabaseSettings object defining tables, fields, indexes, extensions (auth, rules), triggers. Uses imports from "teenybase" (baseFields, authFields, createdTrigger, updatedTrigger, sql, sqlValue).
- **worker.ts** — Dynamic worker entry. Sets up teenybase + mounts the user app. Usually doesn't need changes unless adding middleware.
- **user.tsx** — Hono app with server-side JSX pages. Components are plain functions returning JSX. Route handlers return \`c.html(<Layout>...</Layout>)\`.
- **components.tsx** — Reusable JSX components: Layout, Card, Nav, DataTable, etc.
- **package.json** — Declares the entry module (\`"main": "worker.ts"\`). Rarely needs changes.

## Frontend development (server-side TSX)

Use **.tsx** files with server-side JSX. Components are plain functions — no React, no hooks, no hydration. Everything renders to HTML on the server.

### JSX rules
- Use Hono JSX (automatic transform) — never import React or react-dom
- Components are plain functions: \`function Card({ title, children }) { return <div>{children}</div> }\`
- No useState, useEffect, or any hooks — this is SSR only
- Route handlers return \`c.html(<Layout title="Page">...</Layout>)\`
- Use \`class\` not \`className\` for HTML attributes

### Multi-file organization
- **components.tsx** — reusable components (Layout, Card, Nav, Footer, DataTable)
- **user.tsx** — Hono route handlers using components
- Any \`.tsx\` or \`.ts\` file you add gets bundled automatically
- Example: \`import { Layout, Card } from "./components"\` in user.tsx

### Component examples
Layout:
\`\`\`tsx
export function Layout({ title, children }) {
  return (
    <html>
      <head><title>{title}</title><script src="https://cdn.tailwindcss.com"></script></head>
      <body class="bg-neutral-950 text-neutral-100">{children}</body>
    </html>
  )
}
\`\`\`

Data table:
\`\`\`tsx
export function DataTable({ rows }) {
  const cols = Object.keys(rows[0] ?? {})
  return (
    <table class="w-full text-sm">
      <thead><tr>{cols.map(c => <th class="text-left p-2">{c}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr>{cols.map(c => <td class="p-2">{String(row[c] ?? "")}</td>)}</tr>)}</tbody>
    </table>
  )
}
\`\`\`

Route with data:
\`\`\`tsx
app.get("/", async (c) => {
  const db = c.get("$db")
  const res = await db.table("notes").select({ limit: 20 }, true)
  return c.html(
    <Layout title="Notes">
      <DataTable rows={res.items ?? []} />
    </Layout>
  )
})
\`\`\`

### Styling
- **Tailwind CSS via CDN** (preferred): \`<script src="https://cdn.tailwindcss.com"></script>\` in Layout head
- Use utility classes directly on JSX elements: \`<div class="p-4 bg-neutral-900 rounded-lg">\`

### Client-side interactivity
- **Alpine.js via CDN**: \`<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js"></script>\`
- **HTMX via CDN**: \`<script src="https://unpkg.com/htmx.org@2"></script>\`
- Vanilla JS \`<script>\` blocks for DOM manipulation

### Frontend verification
After deploying, always verify:
- Use testEndpoint on page routes (GET /, /login, etc.) and check the HTML output
- Verify expected elements, styles, and content are present

## Important rules
- Use .tsx files for pages and components — JSX is supported via server-side rendering
- Hono, html, raw, setCookie, deleteCookie, getCookie must be imported from "teenybase" — never import from "hono" or other packages directly
- Do not use React, react-dom, useState, useEffect, or client-side hydration
- **Never break existing imports.** When rewriting a file, check what other files import from it and preserve those exports. If user.tsx imports \`{ Layout, Card }\` from './components', your new components.tsx MUST export both.
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
  const body = (await req.json()) as { id?: string; messages: UIMessage[] }
  const startTime = performance.now()
  const sessionId = body.id ?? "unknown"

  // Extract user's latest message for logging
  const lastUserMsg = [...body.messages].reverse().find((m) => m.role === "user")
  const userText = lastUserMsg?.parts
    ?.filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join(" ") ?? ""

  const workersai = createWorkersAI({ binding: env.AI })
  const modelMessages = await convertToModelMessages(body.messages)

  const result = streamText({
    model: workersai("@cf/moonshotai/kimi-k2.6"),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    stopWhen: stepCountIs(8),
    onFinish: async (event) => {
      const logPromise = saveChatLog(env.TEENY_PRIMARY_DB, sessionId, userText, startTime, {
        text: event.text,
        steps: event.steps as any[],
        toolCalls: event.steps?.flatMap?.((s: any) => s.toolCalls ?? []),
      })
      if (env.WAIT_UNTIL) env.WAIT_UNTIL(logPromise)
      else await logPromise
    },
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
              "The filename to write (e.g. teenybase.ts, worker.ts, user.tsx, components.tsx)"
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

      validateBuild: tool({
        description:
          "Validate that the current files compile without errors. ALWAYS call this after writing files and before deploying. Returns structured errors with file, line, column if the build fails — use these to fix the code and re-validate.",
        parameters: z.object({}),
        execute: async () => {
          const draft = await readDraftFiles(env.TEENY_PRIMARY_DB)
          const live = await readFiles(env.TEENY_PRIMARY_DB)
          const files = draft ?? live ?? {}
          const result = await buildUserWorker(files)
          if (result.ok) {
            return { ok: true, mainModule: result.mainModule, warnings: result.warnings }
          }
          return {
            ok: false,
            error: result.error.message,
            errors: result.error.errors,
          }
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
