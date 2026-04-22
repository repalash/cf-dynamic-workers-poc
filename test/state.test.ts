import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import {
  ADMIN_STATE_DDL,
  adminStateTableExists,
  readConfig,
  readFiles,
  writeConfig,
  writeFiles,
} from "../src/server/admin/state"

async function freshDB() {
  await env.TEENY_PRIMARY_DB.exec("DROP TABLE IF EXISTS _teeny_admin_state")
}
async function ensureTable() {
  await env.TEENY_PRIMARY_DB.exec(ADMIN_STATE_DDL.replace(/\n/g, " "))
}

describe("admin state", () => {
  beforeEach(freshDB)

  it("returns null when the table doesn't exist", async () => {
    expect(await adminStateTableExists(env.TEENY_PRIMARY_DB)).toBe(false)
    expect(await readFiles(env.TEENY_PRIMARY_DB)).toBeNull()
    expect(await readConfig(env.TEENY_PRIMARY_DB)).toBeNull()
  })

  it("round-trips files", async () => {
    await ensureTable()
    const files = { "worker.js": "export default {fetch(){}}", "user.js": "export default 1" }
    await writeFiles(env.TEENY_PRIMARY_DB, files)
    expect(await readFiles(env.TEENY_PRIMARY_DB)).toEqual(files)
  })

  it("round-trips config", async () => {
    await ensureTable()
    const cfg = { tables: [], version: 1, appUrl: "http://x", jwtSecret: "x" } as any
    await writeConfig(env.TEENY_PRIMARY_DB, cfg)
    expect(await readConfig(env.TEENY_PRIMARY_DB)).toEqual(cfg)
  })

  it("overwrites files on second write", async () => {
    await ensureTable()
    await writeFiles(env.TEENY_PRIMARY_DB, { "a.js": "1" })
    await writeFiles(env.TEENY_PRIMARY_DB, { "b.js": "2", "c.js": "3" })
    expect(await readFiles(env.TEENY_PRIMARY_DB)).toEqual({ "b.js": "2", "c.js": "3" })
  })
})
