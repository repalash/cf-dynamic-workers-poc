// Migration helpers for the host admin. Ported from packages/cf-ui-sample/migrate_admin.js
// with one adaptation: there's no config.js file, so the "drift recovery" is
// 'Sync admin config from D1' (write $settings into _teeny_admin_state) instead
// of 'Show config to paste into worker.js'.
//
// teenybase Raw APIs (`$DatabaseRawImpl`, `MigrationHelperRaw`, `USER_MIGRATION_START`,
// `nextUserIndex`) are not in teenybase's public `exports` map. We consume them
// as values from the locally-built cf-ui bundle (`../user-runtime/teenybase_bundle.js`)
// and type them via `./teenybase_bundle.d.ts`.
import {
  $DatabaseRawImpl,
  MigrationHelperRaw,
  USER_MIGRATION_START,
  nextUserIndex,
  InternalKV,
  InternalIdentities,
  generateMigrations,
  hasIdentitiesExtension,
} from "../user-runtime/teenybase_bundle.js"
import type { DatabaseSettings } from "teenybase"
import { ADMIN_STATE_DDL, readConfig, writeConfig } from "./state"

// Starter config — a working users + notes schema wired to the starter SSR
// user.js. After Setup + Apply, visiting "/" should render the login page.
const STARTER_CONFIG: DatabaseSettings = {
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
  tables: [
    {
      name: "users",
      autoSetUid: true,
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, notNull: true, noUpdate: true, usage: "record_uid" },
        { name: "created", type: "date", sqlType: "timestamp", notNull: true, noInsert: true, noUpdate: true, default: { q: "CURRENT_TIMESTAMP" }, usage: "record_created" },
        { name: "updated", type: "date", sqlType: "timestamp", notNull: true, noInsert: true, noUpdate: true, default: { q: "CURRENT_TIMESTAMP" }, usage: "record_updated" },
        { name: "username", type: "text", sqlType: "text", notNull: true, unique: true, usage: "auth_username" },
        { name: "email", type: "text", sqlType: "text", notNull: true, unique: true, noUpdate: true, usage: "auth_email" },
        { name: "password", type: "text", sqlType: "text", notNull: true, usage: "auth_password", noSelect: true },
        { name: "password_salt", type: "text", sqlType: "text", notNull: true, usage: "auth_password_salt", noSelect: true, noInsert: true, noUpdate: true },
        { name: "name", type: "text", sqlType: "text", notNull: true, usage: "auth_name" },
        { name: "role", type: "text", sqlType: "text", usage: "auth_audience", default: { l: "user" } },
      ],
      extensions: [
        {
          name: "auth",
          passwordType: "sha256",
          jwtSecret: "dev-users-jwt-secret",
          jwtTokenDuration: 10800,
          maxTokenRefresh: 4,
        },
      ],
    },
    {
      name: "notes",
      autoSetUid: true,
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, notNull: true, noUpdate: true, usage: "record_uid" },
        { name: "created", type: "date", sqlType: "timestamp", notNull: true, noInsert: true, noUpdate: true, default: { q: "CURRENT_TIMESTAMP" }, usage: "record_created" },
        { name: "updated", type: "date", sqlType: "timestamp", notNull: true, noInsert: true, noUpdate: true, default: { q: "CURRENT_TIMESTAMP" }, usage: "record_updated" },
        { name: "owner_id", type: "relation", sqlType: "text", notNull: true, foreignKey: { table: "users", column: "id" } },
        { name: "title", type: "text", sqlType: "text", notNull: true },
        { name: "content", type: "text", sqlType: "text", notNull: true },
      ],
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
    },
  ],
} as unknown as DatabaseSettings

export interface MetaTableStatus {
  _ddb_internal_kv: boolean
  _db_migrations: boolean
  _teeny_admin_state: boolean
}

export async function metaTableStatus(db: D1Database): Promise<MetaTableStatus> {
  const rows = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('_ddb_internal_kv','_db_migrations','_teeny_admin_state')"
    )
    .all<{ name: string }>()
  const names = new Set((rows.results ?? []).map((r) => r.name))
  return {
    _ddb_internal_kv: names.has("_ddb_internal_kv"),
    _db_migrations: names.has("_db_migrations"),
    _teeny_admin_state: names.has("_teeny_admin_state"),
  }
}

function buildAdminDb(d1: D1Database, config?: DatabaseSettings) {
  const raw = new $DatabaseRawImpl(d1)
  raw.auth.superadmin = true
  const kvTableName = (config as any)?._kvTableName as string | undefined
  const kv = new InternalKV(raw as any, kvTableName)
  const helper = new MigrationHelperRaw(raw, kv)
  const identities = config && hasIdentitiesExtension(config)
    ? new InternalIdentities(raw as any)
    : null
  return { raw, kv, helper, identities }
}

/**
 * Reads $settings + $settings_version from `_ddb_internal_kv` in one batch.
 * Returns `{settings: undefined, version: null}` on fresh DB.
 */
async function dbState(db: D1Database, config?: DatabaseSettings) {
  const { helper } = buildAdminDb(db, config)
  return helper
    .dbSettings()
    .catch(() => ({ settings: undefined, version: null as number | null }))
}

export interface StatusPayload {
  metaTables: MetaTableStatus
  migrationCount: number
  nextIndex: number
  applied: DatabaseSettings | null
  version: number | null
  configMatch: "match" | "drifted" | "no-applied" | "setup-required"
  teenybaseVersion: string
}

export async function status(db: D1Database, teenybaseVersion: string): Promise<StatusPayload> {
  const meta = await metaTableStatus(db)
  if (!meta._ddb_internal_kv || !meta._db_migrations || !meta._teeny_admin_state) {
    return {
      metaTables: meta,
      migrationCount: 0,
      nextIndex: USER_MIGRATION_START,
      applied: null,
      version: null,
      configMatch: "setup-required",
      teenybaseVersion,
    }
  }
  const countRow = await db
    .prepare("SELECT COUNT(*) AS c FROM _db_migrations")
    .first<{ c: number }>()
  const migrationCount = countRow?.c ?? 0

  const { settings: applied, version } = await dbState(db)
  const adminCfg = await readConfig(db)
  let configMatch: StatusPayload["configMatch"] = "match"
  if (!applied) {
    configMatch = "no-applied"
  } else if (adminCfg) {
    try {
      const gen = generateMigrations(adminCfg as any, applied as any, 0) as {
        migrations: unknown[]
      }
      configMatch = gen.migrations.length === 0 ? "match" : "drifted"
    } catch {
      configMatch = "drifted"
    }
  }

  // nextIndex = max(id) + 1 among user-range migrations, clamped to USER_MIGRATION_START.
  const { helper } = buildAdminDb(db)
  const list = await helper.list().catch(() => [])
  const nextIndex = Math.max(USER_MIGRATION_START, nextUserIndex(list))

  return {
    metaTables: meta,
    migrationCount,
    nextIndex,
    applied: (applied as DatabaseSettings | undefined) ?? null,
    version,
    configMatch,
    teenybaseVersion,
  }
}

/**
 * Create the three metadata tables + seed admin state with STARTER_CONFIG if empty.
 * Idempotent.
 */
export async function setup(db: D1Database): Promise<void> {
  await db.exec(ADMIN_STATE_DDL.replace(/\n/g, " "))

  // Seed admin state with starter config if nothing there yet (so first-visit
  // users see a parseable JSON in the editor they can edit).
  const existing = await readConfig(db)
  if (!existing) await writeConfig(db, STARTER_CONFIG)

  const cfg = existing ?? STARTER_CONFIG
  const { kv, helper, identities } = buildAdminDb(db, cfg)

  const kvEntry = await kv.setup(0)
  await helper.setup(0)
  const idEntry = identities ? await identities.setup(0) : null

  const infraEntries = [kvEntry, idEntry].filter(
    (e): e is { name: string; sql: string; sql_revert?: string } =>
      !!e && typeof e === "object" && "sql" in (e as any)
  )
  if (infraEntries.length) {
    await helper.apply(infraEntries)
  }
}

export interface GenerateResult {
  migrations: { name: string; sql: string; sql_revert?: string }[]
  changes: unknown
  extraLogs: string[]
  applied: DatabaseSettings | null
  version: number | null
  startIndex: number
}

/**
 * Pure preview against a user-supplied config. No writes.
 */
export async function generate(
  db: D1Database,
  next: DatabaseSettings
): Promise<GenerateResult> {
  const { helper } = buildAdminDb(db, next)
  const { settings: applied, version } = await dbState(db, next)
  const list = await helper.list().catch(() => [])
  const startIndex = nextUserIndex(list)
  const gen = generateMigrations(next as any, applied as any, startIndex) as {
    migrations: { name: string; sql: string; sql_revert?: string }[]
    changes: unknown
    extraLogs?: string[]
  }
  return {
    migrations: gen.migrations ?? [],
    changes: gen.changes ?? { create: [], drop: [], alter: [] },
    extraLogs: gen.extraLogs ?? [],
    applied: (applied as DatabaseSettings | undefined) ?? null,
    version,
    startIndex,
  }
}

export interface ApplyOpts {
  /** If present, applies these named SQL statements as ONE migration with customName. */
  customSql?: string
  customName?: string
  /** If true, advance $settings without running any SQL (config.js already matches D1). */
  markAsApplied?: boolean
  /** CAS token from the last generate() call. Must match current $settings_version. */
  baselineVersion: number | null
}

export interface ApplyResult {
  applied: string[]
  version: number
}

/**
 * Apply migrations against D1 + stamp $settings atomically. Three paths:
 *   1. customSql  → [{name: customName, sql: customSql}]
 *   2. markAsApplied → [] (just advance $settings)
 *   3. default    → regenerate from config diff server-side
 *
 * In all cases, admin state is also updated so future reads are consistent.
 */
export async function apply(
  db: D1Database,
  next: DatabaseSettings,
  opts: ApplyOpts
): Promise<ApplyResult> {
  const { helper } = buildAdminDb(db, next)

  let migrations: { name: string; sql: string; sql_revert?: string }[] = []

  if (opts.customSql) {
    if (!opts.customName) throw new Error("customName is required when customSql is present")
    const m = opts.customName.match(/^(\d{5})_.+\.sql$/i)
    if (!m) throw new Error("customName must match NNNNN_name.sql (5-digit prefix, ends in .sql)")
    if (parseInt(m[1], 10) < USER_MIGRATION_START) {
      throw new Error(`customName prefix < ${USER_MIGRATION_START} is reserved for infra migrations.`)
    }
    migrations = [{ name: opts.customName, sql: opts.customSql }]
  } else if (!opts.markAsApplied) {
    const g = await generate(db, next)
    migrations = g.migrations
  }

  // Stamp version so $settings and $settings_version land in sync.
  const nextVersion = ((opts.baselineVersion ?? -1) as number) + 1
  const nextStamped: DatabaseSettings = {
    ...(next as any),
    version: nextVersion,
  }

  // helper.apply with settings provided CAS-protects the batch against drift.
  // It executes the migrations inline + writes $settings + $settings_version.
  await helper.apply(migrations, nextStamped as any, opts.baselineVersion)

  // Keep admin state coherent with what we just applied.
  await writeConfig(db, nextStamped)

  return { applied: migrations.map((m) => m.name), version: nextVersion }
}

/**
 * Drop all user tables + teenybase metadata. Preserves _teeny_admin_state so
 * the user doesn't lose their editor draft.
 *
 * D1 doesn't honor `PRAGMA foreign_keys = OFF` via `.prepare().run()` (each
 * call runs in its own implicit transaction), so we sort tables in reverse
 * foreign-key dependency order and drop dependents before parents. Falls back
 * to retry-on-failure if the graph has cycles or we miss something.
 */
export async function clearDB(db: D1Database): Promise<{ dropped: string[]; remaining: string[] }> {
  const all = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>()
  const tables = (all.results ?? []).map((r) => r.name)
  const toDrop = tables.filter((n) => n !== "_teeny_admin_state" && !n.startsWith("_cf_"))

  // Build dep graph: table → [tables it references].
  // Table A "depends on" B if A has a FK pointing to B, so B must wait
  // until A is dropped (drop dependents first).
  const deps = new Map<string, Set<string>>()
  for (const t of toDrop) deps.set(t, new Set())
  for (const t of toDrop) {
    try {
      const fks = await db.prepare(`PRAGMA foreign_key_list("${t.replace(/"/g, '""')}")`)
        .all<{ table: string }>()
      for (const fk of fks.results ?? []) {
        if (fk.table && fk.table !== t && toDrop.includes(fk.table)) {
          // t references fk.table → fk.table is a dependency (can't drop until t is gone).
          deps.get(fk.table)?.add(t)
        }
      }
    } catch {
      // ignore — pragma may fail on view-like entries or metadata tables
    }
  }

  // Iteratively drop tables that no remaining table depends on.
  const dropped: string[] = []
  const remaining = new Set(toDrop)
  let madeProgress = true
  while (remaining.size && madeProgress) {
    madeProgress = false
    for (const t of [...remaining]) {
      // Drop if no remaining table depends on t (i.e. all dependents already dropped).
      const dependents = deps.get(t) ?? new Set()
      const stillDependingOnT = [...dependents].some((d) => remaining.has(d))
      if (stillDependingOnT) continue
      try {
        await db.prepare(`DROP TABLE IF EXISTS "${t.replace(/"/g, '""')}"`).run()
        dropped.push(t)
        remaining.delete(t)
        madeProgress = true
      } catch {
        // keep in remaining; maybe a later pass succeeds
      }
    }
  }

  // One last fallback: PRAGMA approach in case of cycles or weirdness.
  if (remaining.size) {
    await db.prepare("PRAGMA foreign_keys = OFF").run().catch(() => {})
    for (const t of [...remaining]) {
      try {
        await db.prepare(`DROP TABLE IF EXISTS "${t.replace(/"/g, '""')}"`).run()
        dropped.push(t)
        remaining.delete(t)
      } catch {}
    }
    await db.prepare("PRAGMA foreign_keys = ON").run().catch(() => {})
  }

  return { dropped, remaining: [...remaining] }
}

/**
 * Pull $settings from D1 into _teeny_admin_state.config. Used when external SQL
 * advanced $settings past what the editor has — the editor re-loads on next page
 * read to reflect D1's reality.
 */
export async function syncAdminFromD1(db: D1Database): Promise<{ ok: true }> {
  const { settings: applied } = await dbState(db)
  if (!applied) throw new Error("No $settings in D1 to sync from.")
  await writeConfig(db, applied as DatabaseSettings)
  return { ok: true }
}

export async function history(db: D1Database) {
  try {
    const rows = await db
      .prepare("SELECT id, name, applied_at FROM _db_migrations ORDER BY id DESC")
      .all<{ id: number; name: string; applied_at: string }>()
    return (rows.results ?? []).map((r) => ({
      index: r.id,
      name: r.name,
      applied_at: Date.parse(r.applied_at.replace(" ", "T") + "Z") || Date.now(),
    }))
  } catch {
    return []
  }
}
