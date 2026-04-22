import type { Context, Next } from "hono"

type GateEnv = {
  TEENY_PRIMARY_DB: D1Database
  MIGRATE_UI_USER?: string
  MIGRATE_UI_PASSWORD?: string
}

// Memo: creds come from env and are constant per isolate, so we only btoa once.
let memo: { user: string; pwd: string; expected: string } | null = null
function expectedHeader(user: string, pwd: string): string {
  if (memo && memo.user === user && memo.pwd === pwd) return memo.expected
  const expected = "Basic " + btoa(`${user}:${pwd}`)
  memo = { user, pwd, expected }
  return expected
}

export function adminGate() {
  return async function gate(c: Context<{ Bindings: GateEnv }>, next: Next) {
    // CSRF: Basic creds auto-send on cross-origin credentialed requests.
    // Reject browser cross-origin unless Sec-Fetch-Site is same-origin or none.
    const sfs = c.req.header("sec-fetch-site")
    if (sfs && sfs !== "same-origin" && sfs !== "none") {
      return c.json({ error: "Cross-origin admin requests rejected (CSRF)." }, 403)
    }
    if (!c.env.TEENY_PRIMARY_DB) {
      return c.json({ error: "D1 binding TEENY_PRIMARY_DB is not configured." }, 500)
    }
    const user = c.env.MIGRATE_UI_USER || "admin"
    const pwd = c.env.MIGRATE_UI_PASSWORD
    if (!pwd) {
      return c.json({ error: "MIGRATE_UI_PASSWORD is not set. Refusing to serve admin." }, 500)
    }
    const got = c.req.header("authorization") || ""
    if (got !== expectedHeader(user, pwd)) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "www-authenticate": `Basic realm="Teeny Admin", charset="UTF-8"` },
      })
    }
    await next()
  }
}
