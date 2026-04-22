// @ts-nocheck
// The default worker.js shipped into the dynamic worker. Editable via the
// admin UI. Runs as the LOADER.load mainModule. Imports teenybase as a bare
// specifier, config from virtual:teenybase, and the user app from ./user.js
// (pattern matches packages/notes-sample/worker.ts).
//
// Users can freely replace this — e.g. skip teenyHono and `export default
// { fetch(req, env) {...} }` — as long as they still export a Hono-compatible
// Fetcher as default.
import { $Database, teenyHono, OpenApiExtension, PocketUIExtension } from "teenybase"
import config from "virtual:teenybase"
import userApp from "./user.js"

// The D1 access arrives as an RPC stub (WorkerEntrypoint). JS RPC stubs are
// proxies — `"prepare" in stub` is truthy — which trips teenybase's adapter
// auto-detection into D1Adapter, which calls `.prepare()` over RPC and fails.
// Wrap in a plain object with just {run, runBatch} (teenybase's StorageAdapter
// surface) and project PreparedQuery instances to plain {q, v} objects so
// they're serializable.
function wrapD1Stub(stub) {
  return {
    run: (q, v) => stub.run(q, Array.from(v ?? [])),
    runBatch: (queries) =>
      stub.runBatch(queries.map((qr) => ({ q: qr.q, v: Array.from(qr.v ?? []) }))),
  }
}

const app = teenyHono(
  async (c) => {
    const db = new $Database(c, config, wrapD1Stub(c.env.TEENY_PRIMARY_DB))
    db.extensions.push(new OpenApiExtension(db, true))
    db.extensions.push(new PocketUIExtension(db))
    return db
  },
  undefined,
  { logger: false, cors: true }
)

// Mount the user app at / — it owns everything outside /api/v1/*, which
// teenybase claims automatically.
app.route("/", userApp)

export default app
