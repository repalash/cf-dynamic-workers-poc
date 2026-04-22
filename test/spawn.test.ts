// test/spawn.test.ts
// Integration smoke test: setup → apply → GET / proves the whole stack works.
// The dynamic worker spawn relies on the LOADER binding, which is configured
// via wrangler.jsonc's `worker_loaders` entry. If `@cloudflare/vitest-pool-workers`
// can't surface that binding to SELF, the test suite skips with a documented
// reason and we rely on the dev-server smoke (Task 15) as the primary proof.
import { env, SELF } from "cloudflare:test"
import { describe, it, expect, beforeAll } from "vitest"

const auth = "Basic " + btoa("admin:devpassword")

async function admin(path: string, init?: RequestInit) {
  const r = await SELF.fetch("http://localhost/_teeny/admin/api" + path, {
    ...init,
    headers: {
      authorization: auth,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  })
  return r
}

// Detect whether LOADER is present on env. If not (miniflare doesn't plumb
// worker_loaders yet), skip the suite — Task 15's dev-server smoke is the
// primary proof in that case.
// miniflare's worker-loader plugin in this vitest-pool-workers version is a
// stub that creates the binding name but supplies no runtime (env.LOADER is
// an empty object with no `.load()` method). Detect that and skip.
const loader: any = (env as any).LOADER
const loaderAvailable = Boolean(loader) && typeof loader.load === "function"
const maybeDescribe = loaderAvailable ? describe : describe.skip

maybeDescribe("e2e spawn", () => {
  beforeAll(async () => {
    const tables = await env.TEENY_PRIMARY_DB
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
      )
      .all<{ name: string }>()
    for (const t of tables.results ?? []) {
      await env.TEENY_PRIMARY_DB.exec(`DROP TABLE IF EXISTS "${t.name}"`)
    }
  })

  it("setup → apply → GET / returns user code's hello", async () => {
    const s1 = await admin("/setup", { method: "POST" })
    expect(s1.status).toBe(200)
    const s2 = await admin("/apply", {
      method: "POST",
      body: JSON.stringify({
        files: {
          "teenybase.ts": "export default { tables: [], appUrl: 'http://x', jwtSecret: 'x' }",
          "worker.js": "export default { fetch() { return new Response('ok') } }",
          "package.json": JSON.stringify({ name: "e2e", main: "worker.js" }),
        },
        baselineVersion: null,
      }),
    })
    expect(s2.status).toBe(200)

    const r = await SELF.fetch("http://localhost/")
    expect(r.status).toBe(200)
    const body = (await r.json()) as any
    expect(body.message).toMatch(/Hello from user code/)
  })

  it("GET /api/v1/health is served by the dynamic worker", async () => {
    const r = await SELF.fetch("http://localhost/api/v1/health")
    expect(r.status).toBe(200)
  })
})

if (!loaderAvailable) {
  describe("e2e spawn (skipped)", () => {
    it.skip(
      "LOADER binding unavailable in miniflare / vitest-pool-workers — fallback to dev-server smoke (Task 15).",
      () => {}
    )
  })
}
