# Dynamic Workers: Limits, Pricing & Viability as Default

Research date: 2026-04-23. Status: **Open Beta** (since 2026-03-24).

## Pricing vs Static Workers

| Dimension | Static Worker | Dynamic Worker |
|-----------|--------------|----------------|
| Base plan | Free tier available | **Workers Paid ($5/mo) required** |
| Requests | $0.30/million (after 10M included) | Same |
| CPU time | $0.02/million ms — execution only | Same rate, **but startup/parse CPU also billed** |
| Per-worker/day | None | **$0.002/unique-worker/day** (waived during beta) |

The per-worker-per-day charge is ~$0.06/mo for a single app. Startup CPU billing is the real cost difference — every cache miss pays for V8 to parse the code string.

## Performance

| Scenario | Latency |
|----------|---------|
| Static worker | ~0ms cold start (pre-deployed) |
| Dynamic worker — cache hit (`LOADER.get`) | **~5ms** (isolate reuse) |
| Dynamic worker — cache miss | **~50-200ms** (bundle + isolate spawn) |

Cache misses only happen on code changes (new deploy version or file hash change), not on every request. The POC uses `LOADER.get(cacheKey, factory)` where `cacheKey = f(config.version, SHA-256(files))`.

Per-request overhead on cache hit: 1 D1 read (files + config) + SHA-256 hash computation.

## Caching Behavior

- `LOADER.load()` — new isolate every call, no caching. Not used in POC.
- `LOADER.get(id, factory)` — caches by ID, factory only called on miss. Used in POC.
- **No eviction guarantee** — isolates can be evicted under memory pressure.
- Defense: `config.version` header check detects stale config after eviction.

## Hard Limits

| Limit | Value |
|-------|-------|
| Code size | 1 MB compressed (standard Workers limit) |
| File payload (POC-enforced) | 1 MB total across all files |
| Languages | JavaScript (ESM/CJS) and Python only — no TypeScript at runtime |
| Bindings | No direct D1/KV/R2/AI — must use RPC wrappers |
| Scheduling | No cron triggers on dynamic workers |
| Concurrency | No documented limit on concurrent isolates |

## Feature Gaps vs Static Workers

- **No direct bindings**: D1, KV, R2, AI, etc. must be wrapped via WorkerEntrypoint RPC stubs. POC already does this for D1 via `D1RPC`.
- **No Durable Objects**: Dynamic workers can't define DO classes. (DO Facets exist as separate beta.)
- **No cron/scheduled triggers**: Dynamic workers are request-driven only.
- **No TypeScript**: Code must be precompiled to JS. POC handles this via `@cloudflare/worker-bundler` which runs esbuild in the request path.

## Can This Be the Default Deploy Target?

**Yes, technically viable. No for the free-tier onramp.**

### Arguments For
- Cache-hit overhead is minimal (~5ms)
- Pricing is near-zero (especially during beta — $0.002/day waived)
- Enables runtime code editing, AI agent, browser-based dev — impossible with static
- Same V8 isolate tech as regular Workers (mature since 2017)
- POC already solves the hard problems (RPC bindings, caching, bundling)

### Arguments Against
- **Requires Workers Paid ($5/mo)** — kills free-tier onramp for new users
- **Open beta** — API could change, not production-stable guarantee
- **Startup CPU billed** — slight cost increase vs static
- **No direct bindings** — added complexity for KV/R2/AI (needs more RPC wrappers)
- **Bundling in request path** on cache miss — adds latency spikes on deploy

### Recommended Strategy

```
teeny deploy           → static worker (free tier, zero overhead)
teeny deploy --dynamic → dynamic worker (paid tier, enables browser editing + AI)
teeny cloud            → managed dynamic worker on Teenybase Cloud
```

This preserves the free-tier CLI experience while offering the dynamic model as an upgrade path.
