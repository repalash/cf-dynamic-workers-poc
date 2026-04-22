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
import {
  ADMIN_STATE_DDL,
  deleteDraftFiles,
  readConfig,
  readDraftFiles,
  readFiles,
  writeConfig,
  writeDraftFiles,
  writeFiles,
} from "./state"
import type { FilesMap } from "./state"
import { evalConfigFromFiles } from "./eval-config"
import { STARTER_FILES } from "../user-runtime/starter-files"

export interface MetaTableStatus {
  _ddb_internal_kv: boolean
  _db_migrations: boolean
  _teeny_admin_state: boolean
}

export async function metaTableStatus(db: D1Database): Promise<MetaTableStatus> {
  try {
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
  } catch {
    // Transient D1 error (cold start or connection hiccup). Report as missing
    // so the UI shows a sane setup-required state; next poll will pick up.
    return { _ddb_internal_kv: false, _db_migrations: false, _teeny_admin_state: false }
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
 * Creates the three metadata tables. Seeds STARTER_FILES into _draft_ (live
 * stays null — deploy is a separate action). Idempotent — safe to re-run.
 *
 * Does NOT evaluate teenybase.ts. First deploy handles that. Setup is
 * intentionally fast and no-throw on user-code issues.
 */
export async function setup(db: D1Database): Promise<void> {
  await db.exec(ADMIN_STATE_DDL.replace(/\n/g, " "))

  // Seed draft with the starter tree if no draft yet.
  const existingDraft = await readDraftFiles(db)
  if (!existingDraft) await writeDraftFiles(db, { ...STARTER_FILES })

  // Use STARTER_CONFIG_SHAPE as a placeholder config for infra setup — teenybase
  // needs SOMETHING to know which kv/identities tables to create, but the real
  // config for user tables gets stamped by the first deploy. An empty-tables
  // shape is enough because no identities extension is on.
  const placeholderConfig = { tables: [] } as unknown as DatabaseSettings
  const { kv, helper, identities } = buildAdminDb(db, placeholderConfig)

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

export interface DeployOpts {
  /** Optional custom SQL to run as a single named migration alongside (or instead of) auto-generated schema migrations. */
  customSql?: string
  /** Required if customSql is present. Must match NNNNN_<name>.sql. */
  customName?: string
  /** CAS token from the last /generate call. */
  baselineVersion: number | null
}

export interface DeployResult {
  applied: string[]
  version: number
  config: DatabaseSettings
  promotedFiles: boolean
}

/**
 * Atomic deploy: re-evaluate teenybase.ts, run schema + custom migrations,
 * stamp $settings + $settings_version (CAS-protected), promote draft files
 * to live, and update the cached config. Single DB-batch for the schema side
 * (via MigrationHelperRaw.apply) means any failure aborts before the files
 * become live.
 *
 * Three effective modes fall out of the inputs, no flag needed:
 *   - custom SQL provided:            runs that SQL as ONE named migration
 *   - no custom SQL, schema changed:  runs auto-generated migrations
 *   - no custom SQL, no schema diff:  migrations=[] → helper.apply still
 *                                      writes $settings + bumps version
 *                                      (markAsApplied-equivalent), useful
 *                                      for code-only deploys
 *
 * If draft files equal live files, promotedFiles=false in the result; the
 * version still bumps to keep the CAS counter monotonic.
 */
export async function deploy(
  db: D1Database,
  env: { LOADER: any },
  files: FilesMap,
  opts: DeployOpts
): Promise<DeployResult> {
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
  } else {
    const list = await helper.list().catch(() => [])
    const startIndex = nextUserIndex(list)
    const { settings: applied } = await dbState(db, next)
    const gen = generateMigrations(next as any, applied as any, startIndex) as {
      migrations: { name: string; sql: string; sql_revert?: string }[]
    }
    migrations = gen.migrations ?? []
  }

  const nextVersion = ((opts.baselineVersion ?? -1) as number) + 1
  const nextStamped: DatabaseSettings = { ...(next as any), version: nextVersion }
  await helper.apply(migrations, nextStamped as any, opts.baselineVersion)

  // Promote draft → live + update cached config. We also clear the drafts row
  // since the editor's source-of-truth is now the live tree.
  const prevLive = await readFiles(db)
  const samePromote = prevLive ? JSON.stringify(prevLive) === JSON.stringify(files) : false
  await writeFiles(db, files)
  await writeConfig(db, nextStamped)
  await deleteDraftFiles(db)

  return {
    applied: migrations.map((m) => m.name),
    version: nextVersion,
    config: nextStamped,
    promotedFiles: !samePromote,
  }
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
