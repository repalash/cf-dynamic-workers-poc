# cf-dynamic-workers-poc

Teenybase running inside a Cloudflare Dynamic Worker, with a browser-based admin UI on the host worker. Sister POC to `../cf-ui-sample` — same framework, different deploy shape (git repo + wrangler, not dashboard drag-and-drop).

## What this POC proves

- Host Worker can spawn a dynamic user Worker per request via `env.LOADER.load({ modules, env })`.
- Teenybase runtime ships as a string module into the dynamic Worker; D1 access is passed in as a WorkerEntrypoint RPC stub that mirrors teenybase's `StorageAdapter` interface — no teenybase source changes needed.
- All of { teenybase config, user `register(app)` code, secrets, env vars } are stored in the host's D1 and editable from the admin UI. No file edits, no re-deploys for config/code/secrets/vars changes.

## Quick start

```sh
cd packages/cf-dynamic-workers-poc
npm install
echo "MIGRATE_UI_PASSWORD=devpassword" > .dev.vars
npm run dev
# open http://localhost:8787/_teeny/admin — user: admin, pwd: devpassword
```

First visit → Migrations tab → "Set up metadata tables" → Apply. Hit `http://localhost:8787/` for the dynamic worker's response.

## Scripts

- `npm run dev` — Vite + miniflare, HMR, local SQLite D1 under `.wrangler/state/`.
- `npm run build` — emits `dist/client/` for the SPA.
- `npm run deploy` — `vite build && wrangler deploy`. Requires `wrangler d1 create cf-dynamic-workers-poc-db` once and the real DB id in `wrangler.jsonc`.
- `npm test` — vitest (unit + integration).

## Architecture

See `docs/superpowers/specs/2026-04-21-cf-dynamic-workers-poc-design.md` in the repo root.

## POC limitations

- Plaintext secrets at rest in D1 (auth-gated, not encrypted).
- D1 is the only supported binding. KV/R2/service/AI bindings are future work (each needs its own RPC wrapper).
- Per-request isolate spawn — no `LOADER.get(id, fn)` caching yet.
- Single-file user code (`register(app)` export only).
- No rollback; `_db_migrations` is append-only.
- Single-env, single-tenant.

## Troubleshooting

- **Alpine/musl:** run `bash ../teenybase/scripts/fix-alpine-workerd.sh .` after any `npm install`.
- **`LOADER is not defined` in tests:** `@cloudflare/vitest-pool-workers` may not support `worker_loaders` yet; integration tests that need spawn are documented to be skipped with a comment when that's the case. Manual testing via `npm run dev` is the fallback proof.
- **RPC stub construction:** the `ctx.exports.D1RPC` value is a *LoopbackServiceStub* — call it as a factory (`exports.D1RPC({})`) to get a serializable `Fetcher<D1RPC>` that can be passed in the dynamic worker's `env`. `.get()` / `.getByName(...)` return an `RpcPromise` which is not serializable and will fail with a type error inside `LOADER.load`. See `src/server/admin/spawn.ts`.
- **Setup required banner after `apply`:** check `curl /_teeny/admin/api/status` — if `_teeny_admin_state: missing` persists after setup, the D1 binding may be wrong in wrangler.jsonc.

## Files worth reading first

- `src/server/worker.ts` — host routing + D1RPC export.
- `src/server/admin/spawn.ts` — how the dynamic worker gets its modules + env.
- `src/server/admin/migrations.ts` — setup / preview / apply / clear / custom, adapted from `../cf-ui-sample/migrate_admin.js`.
- `src/server/user-runtime/entry.ts` — the dynamic worker's entry point (shipped as a string).
