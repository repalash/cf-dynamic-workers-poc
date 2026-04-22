// Starter file tree seeded into _teeny_admin_state on Setup. Users can
// freely add / rename / delete files; the host bundles whatever's there
// via @cloudflare/worker-bundler and feeds the result into LOADER.load.
//
// Files that show up in the admin UI:
//   - teenybase.ts   — schema config. Its default export is the config object.
//                       The host evaluates this (bundler + throwaway LOADER
//                       worker) to get JSON for migration generation.
//   - worker.js      — dynamic-worker entry. Does teenyHono setup + mounts
//                       userApp at /. Users can replace the whole thing with
//                       `export default { fetch() { ... } }` if they don't
//                       want teenybase's Hono app.
//   - user.js        — Hono app exported as default. Worker.js imports and
//                       mounts it. Same shape as packages/notes-sample.
//   - package.json   — tells worker-bundler which file is the entry.

const TEENYBASE_TS = `// Schema config. Default export = the teenybase.DatabaseSettings object.
// Imports from "teenybase" resolve to the bundle we ship with the dynamic
// worker — it re-exports scaffold helpers (baseFields, authFields, ...)
// so you don't need to know the subpath.
import {
  sql,
  sqlValue,
  baseFields,
  authFields,
  createdTrigger,
  updatedTrigger,
} from "teenybase"

const users = {
  name: "users",
  autoSetUid: true,
  fields: [
    ...baseFields,
    ...authFields,
  ],
  indexes: [{ fields: "role COLLATE NOCASE" }],
  extensions: [
    {
      name: "auth",
      passwordType: "sha256",
      jwtSecret: "dev-users-jwt-secret",
      jwtTokenDuration: 3 * 60 * 60,
      maxTokenRefresh: 4,
    },
  ],
  triggers: [createdTrigger, updatedTrigger],
}

const notes = {
  name: "notes",
  autoSetUid: true,
  fields: [
    ...baseFields,
    { name: "owner_id", type: "relation", sqlType: "text", notNull: true, foreignKey: { table: "users", column: "id" } },
    { name: "title", type: "text", sqlType: "text", notNull: true },
    { name: "content", type: "text", sqlType: "text", notNull: true },
  ],
  indexes: [{ fields: "owner_id" }],
  extensions: [
    {
      name: "rules",
      listRule: "(auth.uid != null & owner_id == auth.uid) | auth.role ~ '%admin'",
      viewRule: "(auth.uid != null & owner_id == auth.uid) | auth.role ~ '%admin'",
      createRule: "auth.uid != null & owner_id == auth.uid",
      updateRule: "auth.uid != null & owner_id == auth.uid",
      deleteRule: "auth.uid != null & owner_id == auth.uid",
    },
  ],
  triggers: [createdTrigger, updatedTrigger],
}

export default {
  appName: "Teeny Notes",
  appUrl: "http://localhost:8787",
  jwtSecret: "dev-secret-change-me",
  authCookie: {
    name: "teeny_auth",
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    path: "/",
  },
  tables: [users, notes],
}
`

const WORKER_JS = `// Dynamic-worker entry. LOADER.load runs this as the mainModule.
// Imports from "teenybase" (the bundle), "virtual:teenybase" (compiled config),
// and "./user.js" (your Hono app). Replace with your own fetch handler if you
// don't want teenybase's wiring.
import {
  $Database,
  teenyHono,
  OpenApiExtension,
  PocketUIExtension,
} from "teenybase"
import config from "virtual:teenybase"
import userApp from "./user.js"

// D1 RPC stubs are proxies — \`"prepare" in stub\` is truthy — which trips
// teenybase's adapter detection into calling .prepare() over RPC. Project
// to a plain {run, runBatch} adapter so teenybase treats it as a
// StorageAdapter directly.
function wrapD1Stub(stub) {
  return {
    run: (q, v) => stub.run(q, Array.from(v ?? [])),
    runBatch: (queries) =>
      stub.runBatch(queries.map((qr) => ({ q: qr.q, v: Array.from(qr.v ?? []) }))),
  }
}

const app = teenyHono(async (c) => {
  const db = new $Database(c, config, wrapD1Stub(c.env.TEENY_PRIMARY_DB))
  db.extensions.push(new OpenApiExtension(db, true))
  db.extensions.push(new PocketUIExtension(db))
  return db
}, undefined, { logger: false, cors: true })

app.route("/", userApp)

export default app
`

const USER_JS = `// Your Hono app. Exported as default, mounted at / by worker.js.
// Uses hono/html tagged templates (re-exported from "teenybase") because
// dynamic workers can't transpile JSX/TSX — plain JS + html\\\`…\\\` only.
import { Hono, html, raw, setCookie, deleteCookie, getCookie } from "teenybase"

const COOKIE = "teeny_auth"

const styles = \`
  *{box-sizing:border-box}
  body{font-family:'IBM Plex Sans',system-ui,sans-serif;margin:0;background:#0a0b0e;color:#ebedf2;line-height:1.5}
  a{color:#ff8c42;text-decoration:none}a:hover{text-decoration:underline}
  nav{border-bottom:1px solid #1f2229;padding:14px 28px;display:flex;gap:20px;align-items:center;background:#101217}
  nav .brand{font-family:'Instrument Serif',serif;font-size:22px;color:#ebedf2}
  nav .spacer{flex:1}
  nav .user{color:#9196a0;font-size:13px}
  main{max-width:760px;margin:0 auto;padding:28px}
  h1{font-family:'Instrument Serif',serif;font-weight:400;font-size:28px;margin:0 0 20px}
  .card{background:#101217;border:1px solid #1f2229;border-radius:8px;padding:20px;margin-bottom:16px}
  .card h3{margin:0 0 8px;font-size:17px;font-weight:500}
  .card .meta{color:#5e626b;font-size:12px;font-family:'IBM Plex Mono',monospace}
  .card p{color:#9196a0;margin:8px 0 0;white-space:pre-wrap}
  form{display:flex;flex-direction:column;gap:12px;max-width:480px}
  form label{font-size:13px;color:#9196a0;text-transform:uppercase;letter-spacing:0.14em;font-weight:500}
  input,textarea{background:#07080a;border:1px solid #2a2e36;border-radius:5px;padding:8px 10px;color:#ebedf2;font-family:inherit;font-size:14px}
  textarea{min-height:140px;resize:vertical;font-family:'IBM Plex Mono',monospace}
  button{background:#ff8c42;color:#1c0e05;border:0;padding:8px 18px;border-radius:5px;font-weight:500;font-size:14px;cursor:pointer;align-self:flex-start}
  button:hover{background:#ffa362}
  .err{background:rgba(255,154,143,0.07);border:1px solid rgba(255,154,143,0.24);color:#ff9a8f;padding:10px 12px;border-radius:5px;margin-bottom:12px}
  .hint{color:#5e626b;font-size:13px;margin-bottom:20px}
\`

const layout = (title, bodyFrag, user) => html\`<!doctype html>
<html><head><meta charset="utf-8"/><title>\${title}</title><style>\${raw(styles)}</style></head>
<body>
  <nav>
    <span class="brand">teenybase notes</span>
    <a href="/">Notes</a>
    \${user ? html\`<a href="/notes/new">+ New</a>\` : null}
    <span class="spacer"></span>
    \${user
      ? html\`<span class="user">\${user.email ?? user.username ?? "user"}</span> <a href="/logout">logout</a>\`
      : html\`<a href="/login">login</a> · <a href="/signup">sign up</a>\`}
  </nav>
  <main>\${bodyFrag}</main>
</body></html>\`

async function getAuthUser(db) {
  await db.initAuth()
  if (!db.auth?.uid) return null
  try {
    const res = await db.table("users").select({ where: \`id = "\${db.auth.uid}"\`, limit: 1 }, true)
    return res?.items?.[0] ?? { id: db.auth.uid }
  } catch {
    return { id: db.auth.uid }
  }
}

const app = new Hono()

app.get("/", async (c) => {
  const db = c.get("$db")
  const user = await getAuthUser(db)
  if (!user) return c.redirect("/login")
  let items = []
  try {
    const res = await db.table("notes").select(
      { select: "id,title,content,created", where: \`owner_id = "\${user.id}"\`, order: "-created" },
      true
    )
    items = res?.items ?? []
  } catch (e) {
    return c.html(layout("Notes", html\`<h1>Notes</h1><div class="err">\${e?.message ?? "DB error"}</div>\`, user))
  }
  return c.html(layout("Notes — teenybase", html\`
    <h1>Your notes</h1>
    \${items.length === 0
      ? html\`<div class="hint">No notes yet. <a href="/notes/new">Create your first</a>.</div>\`
      : items.map((n) => html\`
          <article class="card">
            <h3><a href="/notes/\${n.id}">\${n.title}</a></h3>
            <div class="meta">\${n.created}</div>
            <p>\${(n.content ?? "").slice(0, 140)}\${(n.content ?? "").length > 140 ? "…" : ""}</p>
          </article>
        \`)}
  \`, user))
})

app.get("/login", (c) => c.html(layout("Login", html\`
  <h1>Log in</h1>
  <form method="post" action="/login">
    <label>Username<input name="username" required autofocus /></label>
    <label>Password<input name="password" type="password" required /></label>
    <button>Log in</button>
  </form>
  <div class="hint">No account? <a href="/signup">Sign up</a>.</div>
\`, null)))

app.post("/login", async (c) => {
  const body = await c.req.parseBody()
  try {
    const res = await c.get("$db").table("users").extension("auth").loginWithPassword({
      username: String(body.username ?? ""),
      password: String(body.password ?? ""),
    })
    setCookie(c, COOKIE, res.token, { httpOnly: true, sameSite: "Lax", path: "/" })
    return c.redirect("/")
  } catch (e) {
    return c.html(layout("Login", html\`
      <h1>Log in</h1>
      <div class="err">\${e?.message ?? "Login failed"}</div>
      <form method="post" action="/login">
        <label>Username<input name="username" value="\${String(body.username ?? "")}" required /></label>
        <label>Password<input name="password" type="password" required /></label>
        <button>Log in</button>
      </form>
    \`, null), 400)
  }
})

app.get("/signup", (c) => c.html(layout("Sign up", html\`
  <h1>Sign up</h1>
  <form method="post" action="/signup">
    <label>Username<input name="username" required autofocus /></label>
    <label>Email<input name="email" type="email" required /></label>
    <label>Display name<input name="name" required /></label>
    <label>Password<input name="password" type="password" required minlength="8" /></label>
    <button>Create account</button>
  </form>
  <div class="hint">Already have one? <a href="/login">Log in</a>.</div>
\`, null)))

app.post("/signup", async (c) => {
  const body = await c.req.parseBody()
  try {
    const res = await c.get("$db").table("users").extension("auth").signUp({
      username: String(body.username ?? ""),
      email: String(body.email ?? ""),
      name: String(body.name ?? ""),
      password: String(body.password ?? ""),
    })
    setCookie(c, COOKIE, res.token, { httpOnly: true, sameSite: "Lax", path: "/" })
    return c.redirect("/")
  } catch (e) {
    return c.html(layout("Sign up", html\`
      <h1>Sign up</h1>
      <div class="err">\${e?.message ?? "Signup failed"}</div>
      <form method="post" action="/signup">
        <label>Username<input name="username" value="\${String(body.username ?? "")}" required /></label>
        <label>Email<input name="email" type="email" value="\${String(body.email ?? "")}" required /></label>
        <label>Display name<input name="name" value="\${String(body.name ?? "")}" required /></label>
        <label>Password<input name="password" type="password" required minlength="8" /></label>
        <button>Create account</button>
      </form>
    \`, null), 400)
  }
})

app.get("/logout", (c) => {
  deleteCookie(c, COOKIE, { path: "/" })
  return c.redirect("/login")
})

app.get("/notes/new", async (c) => {
  const user = await getAuthUser(c.get("$db"))
  if (!user) return c.redirect("/login")
  return c.html(layout("New note", html\`
    <h1>New note</h1>
    <form method="post" action="/notes">
      <label>Title<input name="title" required autofocus /></label>
      <label>Content<textarea name="content" required></textarea></label>
      <button>Create</button>
    </form>
  \`, user))
})

app.post("/notes", async (c) => {
  const db = c.get("$db")
  const user = await getAuthUser(db)
  if (!user) return c.redirect("/login")
  const body = await c.req.parseBody()
  try {
    await db.table("notes").insert({
      values: { owner_id: user.id, title: String(body.title ?? ""), content: String(body.content ?? "") },
    })
    return c.redirect("/")
  } catch (e) {
    return c.html(layout("New note", html\`
      <h1>New note</h1>
      <div class="err">\${e?.message ?? "Create failed"}</div>
      <form method="post" action="/notes">
        <label>Title<input name="title" value="\${String(body.title ?? "")}" required /></label>
        <label>Content<textarea name="content" required>\${String(body.content ?? "")}</textarea></label>
        <button>Create</button>
      </form>
    \`, user), 400)
  }
})

app.get("/notes/:id", async (c) => {
  const db = c.get("$db")
  const user = await getAuthUser(db)
  if (!user) return c.redirect("/login")
  const id = c.req.param("id")
  try {
    const n = await db.table("notes").view({}, id)
    if (!n) return c.html(layout("Not found", html\`<h1>Not found</h1>\`, user), 404)
    return c.html(layout(n.title, html\`
      <h1>\${n.title}</h1>
      <div class="hint">\${n.created}</div>
      <article class="card"><p>\${n.content}</p></article>
      <div><a href="/">← All notes</a></div>
    \`, user))
  } catch (e) {
    return c.html(layout("Error", html\`<h1>Error</h1><div class="err">\${e?.message ?? String(e)}</div>\`, user), 500)
  }
})

export default app
`

const PACKAGE_JSON = `{
  "name": "cf-dynamic-workers-poc-user",
  "main": "worker.js",
  "type": "module"
}
`

export const STARTER_FILES: Record<string, string> = {
  "teenybase.ts": TEENYBASE_TS,
  "worker.js": WORKER_JS,
  "user.js": USER_JS,
  "package.json": PACKAGE_JSON,
}
