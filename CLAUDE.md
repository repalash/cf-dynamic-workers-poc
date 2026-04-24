# CLAUDE.md

## Project

Teenybase running inside a Cloudflare Dynamic Worker, with a browser-based admin UI + AI chat agent on the host worker.

## Architecture

- **Host worker** (`src/server/worker.ts`) — routes `/_teeny/admin/api/*` to Hono admin routes, `/_teeny/admin/*` to SPA assets, everything else to the dynamic user worker via `LOADER.load()`. Injects the chat widget into HTML responses via HTMLRewriter.
- **Admin UI** (`src/client/`) — React + Tailwind SPA with CodeMirror editors and an AI chat panel
- **Embedded chat widget** (`src/server/chat-widget.html`) — self-contained vanilla JS chat panel injected into every dynamic worker HTML page (Lovable/v0-style). Persists messages in localStorage, auto-reloads page after deploy, handles Basic auth.
- **Dynamic user worker** — spawned per-request from files stored in D1; code is bundled via `@cloudflare/worker-bundler` and cached by `LOADER.get(cacheKey, factory)`
- **AI chat agent** (`src/server/admin/chat.ts`) — Workers AI (glm-4.7-flash) with Vercel AI SDK v5, 12 tools for full-stack editing (schema, backend routes, frontend pages), migration, deploy, and debug

## Build & Deploy

```bash
npm run dev          # local dev (vite + miniflare)
npm run build        # build client + worker
npm run deploy       # build + wrangler deploy
```

The `prebuild` script runs `scripts/build-teenybase-bundle.mjs` which bundles teenybase into a single ESM string. If the teenybase source at `../../teenybase/src/bundle/cf-ui-entry.ts` is unavailable, it skips the rebuild and uses the existing `src/server/user-runtime/teenybase_bundle.js` (checked into git).

## Key Dependencies

- `teenybase` — local file dependency at `../teenybase` (symlinked to `../teenybase-public/teenybase/packages/teenybase/`)
- `ai` + `@ai-sdk/react` + `workers-ai-provider` — Vercel AI SDK v5 for streaming chat
- `@cloudflare/worker-bundler` — bundles user files for LOADER
- `hono` — HTTP framework for admin routes

## Wrangler Bindings

- `TEENY_PRIMARY_DB` — D1 database
- `AI` — Workers AI
- `LOADER` — Dynamic worker loader
- `ASSETS` — SPA static assets

## AI SDK v5 Gotchas

- `useChat` uses `DefaultChatTransport` (not a raw `api` string) — configured in `ChatPanel.tsx`
- Client sends `UIMessage[]` (with `parts` array); server must use `convertToModelMessages()` before passing to `streamText()`
- Tool parts in UIMessage have type `"tool-<toolName>"` with flat properties (`input`, `output`, `state`), not nested `toolInvocation`
- Multi-step tool calling uses `stopWhen: stepCountIs(N)`, not `maxSteps`
- `@ai-sdk/react` is a separate package from `ai` (the core)

## D1 State Layout

- `_teeny_admin_state` — KV table with keys: `files` (deployed), `files_draft` (editor working copy), `config` (compiled DatabaseSettings JSON)
- `_ddb_internal_kv` — teenybase internal metadata
- `_db_migrations` — append-only migration log
- User tables (users, notes, etc.) — created by migrations

## Testing the Chat Agent

```bash
# Single message
curl -s -u admin:devpassword -X POST "$URL/_teeny/admin/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"id":"test","messages":[{"id":"m1","role":"user","parts":[{"type":"text","text":"check status"}],"createdAt":"2026-04-23T00:00:00Z"}],"trigger":"submit-message"}'

# Extract text from SSE stream
... | grep "text-delta" | sed 's/.*"delta":"//' | sed 's/"}//' | tr -d '\n'
```

## Dynamic Worker Limits

See `workflow/dynamic_worker_limits.md` for pricing, performance, and viability analysis.
