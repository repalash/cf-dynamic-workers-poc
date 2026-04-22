import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import {
  ADMIN_STATE_DDL,
  readConfig,
  writeConfig,
  adminStateTableExists,
} from "../src/server/admin/state"

async function freshDB() {
  await env.TEENY_PRIMARY_DB.exec("DROP TABLE IF EXISTS _teeny_admin_state")
}

async function ensureTable() {
  await env.TEENY_PRIMARY_DB.exec(ADMIN_STATE_DDL.replace(/\n/g, " "))
}

describe("admin state", () => {
  beforeEach(freshDB)

  it("returns null when the admin state table doesn't exist", async () => {
    expect(await adminStateTableExists(env.TEENY_PRIMARY_DB)).toBe(false)
    expect(await readConfig(env.TEENY_PRIMARY_DB)).toBeNull()
  })

  it("returns null when table exists but no config written", async () => {
    await ensureTable()
    expect(await adminStateTableExists(env.TEENY_PRIMARY_DB)).toBe(true)
    expect(await readConfig(env.TEENY_PRIMARY_DB)).toBeNull()
  })

  it("round-trips config", async () => {
    await ensureTable()
    const cfg = { tables: [], version: 1, appUrl: "http://x", jwtSecret: "x" } as any
    await writeConfig(env.TEENY_PRIMARY_DB, cfg)
    expect(await readConfig(env.TEENY_PRIMARY_DB)).toEqual(cfg)
  })

  it("overwrites on second write", async () => {
    await ensureTable()
    await writeConfig(env.TEENY_PRIMARY_DB, { tables: [] } as any)
    await writeConfig(env.TEENY_PRIMARY_DB, { tables: [{ name: "t", fields: [] }] } as any)
    const got = await readConfig(env.TEENY_PRIMARY_DB) as any
    expect(got.tables).toEqual([{ name: "t", fields: [] }])
  })
})
