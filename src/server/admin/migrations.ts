// Migration helpers. Flow changes for this iteration:
//   - Admin state stores a FilesMap (arbitrary user-authored file tree) +
//     the derived JSON config. teenybase.ts is one of the files; the config
//     is obtained by bundling + running that file in a throwaway LOADER
//     worker (see eval-config.ts).
//   - setup() seeds STARTER_FILES, runs eval to get initial config, creates
//     metadata tables.
//   - generate(files) and apply(files, opts) take the in-memory files from
//     the admin UI (so unsaved edits can be previewed + applied atomically).
//
// teenybase Raw APIs (MigrationHelperRaw, generateMigrations, etc.) come
// from the locally-built cf-ui bundle — typed via teenybase_bundle.d.ts.
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
import { ADMIN_STATE_DDL, readConfig, readFiles, writeConfig, writeFiles } from "./state"
import type { FilesMap } from "./state"
import { evalConfigFromFiles } from "./eval-config"
import { STARTER_FILES } from "../user-runtime/starter-files"

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
 * Creates the three metadata tables. Seeds STARTER_FILES (only if no files
 * are stored yet). Evaluates teenybase.ts to get the initial config and
 * persists it. Idempotent — safe to re-run.
 */
export async function setup(db: D1Database, env: { LOADER: any }): Promise<void> {
  await db.exec(ADMIN_STATE_DDL.replace(/\n/g, " "))

  // Seed files if empty.
  let files = await readFiles(db)
  if (!files) {
    files = { ...STARTER_FILES }
    await writeFiles(db, files)
  }

  // Evaluate teenybase.ts to derive the config, if no config is cached yet.
  const existingConfig = await readConfig(db)
  const cfg = existingConfig ?? (await evalConfigFromFiles(env, files))
  if (!existingConfig) await writeConfig(db, cfg)

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
  config: DatabaseSettings
}

/**
 * Takes a files map (as sent by the admin UI — possibly with unsaved edits),
 * evaluates teenybase.ts, diffs against $settings, returns the preview.
 */
export async function generate(
  db: D1Database,
  env: { LOADER: any },
  files: FilesMap
): Promise<GenerateResult> {
  const next = await evalConfigFromFiles(env, files)
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
    config: next,
  }
}

export interface ApplyOpts {
  customSql?: string
  customName?: string
  markAsApplied?: boolean
  baselineVersion: number | null
}

export interface ApplyResult {
  applied: string[]
  version: number
  config: DatabaseSettings
}

/**
 * Apply: re-evaluates teenybase.ts from the supplied files, bundles migrations
 * from the diff, applies + stamps $settings, and persists files + config.
 */
export async function apply(
  db: D1Database,
  env: { LOADER: any },
  files: FilesMap,
  opts: ApplyOpts
): Promise<ApplyResult> {
  const next = await evalConfigFromFiles(env, files)
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
    const list = await helper.list().catch(() => [])
    const startIndex = nextUserIndex(list)
    const { settings: applied } = await dbState(db, next)
    const gen = generateMigrations(next as any, applied as any, startIndex) as {
      migrations: { name: string; sql: string; sql_revert?: string }[]
    }
    migrations = gen.migrations ?? []
  }

  const nextVersion = ((opts.baselineVersion ?? -1) as number) + 1
  const nextStamped: DatabaseSettings = {
    ...(next as any),
    version: nextVersion,
  }
  await helper.apply(migrations, nextStamped as any, opts.baselineVersion)

  // Persist files + compiled config so future reads (e.g. runtime spawn, status)
  // reflect what we just stamped.
  await writeFiles(db, files)
  await writeConfig(db, nextStamped)

  return { applied: migrations.map((m) => m.name), version: nextVersion, config: nextStamped }
}

export async function clearDB(db: D1Database): Promise<{ dropped: string[]; remaining: string[] }> {
  const all = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>()
  const tables = (all.results ?? []).map((r) => r.name)
  const toDrop = tables.filter((n) => n !== "_teeny_admin_state" && !n.startsWith("_cf_"))

  const deps = new Map<string, Set<string>>()
  for (const t of toDrop) deps.set(t, new Set())
  for (const t of toDrop) {
    try {
      const fks = await db.prepare(`PRAGMA foreign_key_list("${t.replace(/"/g, '""')}")`)
        .all<{ table: string }>()
      for (const fk of fks.results ?? []) {
        if (fk.table && fk.table !== t && toDrop.includes(fk.table)) {
          deps.get(fk.table)?.add(t)
        }
      }
    } catch {}
  }

  const dropped: string[] = []
  const remaining = new Set(toDrop)
  let madeProgress = true
  while (remaining.size && madeProgress) {
    madeProgress = false
    for (const t of [...remaining]) {
      const dependents = deps.get(t) ?? new Set()
      if ([...dependents].some((d) => remaining.has(d))) continue
      try {
        await db.prepare(`DROP TABLE IF EXISTS "${t.replace(/"/g, '""')}"`).run()
        dropped.push(t)
        remaining.delete(t)
        madeProgress = true
      } catch {}
    }
  }

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
 * Pull $settings into admin state config. Files stay unchanged — the next
 * generate/apply will re-evaluate teenybase.ts and likely show drift; user
 * needs to reconcile by editing teenybase.ts manually.
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
