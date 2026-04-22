// src/server/rpc/D1RPC.ts
// Wraps the real D1 binding in a WorkerEntrypoint so it can be passed to a
// dynamically-loaded worker's env as an RPC stub (native bindings aren't
// serializable across LOADER.load). The surface mirrors teenybase's
// StorageAdapter — run/runBatch — so teenybase's $Database can consume the
// stub directly as a StorageAdapter.
import { WorkerEntrypoint } from "cloudflare:workers"
import type { QueryResult } from "teenybase/worker"

interface HostEnv {
  TEENY_PRIMARY_DB: D1Database
}

export class D1RPC extends WorkerEntrypoint<HostEnv> {
  async run<T = unknown>(q: string, v: readonly any[]): Promise<QueryResult<T>> {
    return this.env.TEENY_PRIMARY_DB.prepare(q)
      .bind(...v)
      .run<T>() as unknown as QueryResult<T>
  }

  async runBatch<T = unknown>(
    queries: { q: string; v: readonly any[] }[]
  ): Promise<QueryResult<T>[]> {
    if (!queries.length) return []
    const statements = queries.map((qr) =>
      this.env.TEENY_PRIMARY_DB.prepare(qr.q).bind(...qr.v)
    )
    return (await this.env.TEENY_PRIMARY_DB.batch<T>(statements)) as unknown as QueryResult<T>[]
  }
}
