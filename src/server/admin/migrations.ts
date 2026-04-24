// Migration helpers. Admin state stores a FilesMap + the derived JSON config.
// teenybase.ts is one of the files; its JSON is recovered by bundling + running
// it in a throwaway LOADER worker (see eval-config.ts).
//
// Raw APIs (MigrationHelperRaw, generateMigrations, InternalKV, $DatabaseRawImpl,
// nextUserIndex, hasIdentitiesExtension) live in teenybase's internal cf-ui
// bundle — consumed as values from teenybase_bundle.js with ambient types in
// teenybase_bundle.d.ts.
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
import { buildUserWorkerOrThrow } from "./build-user-worker"
import {
  filesEqual,
  type GenerateResult,
  type MetaTableStatus,
  type StatusPayload,
} from "@shared/types"
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

// teenybase's DatabaseSettings type is strict; internals sometimes stamp extra
// fields (version, _kvTableName). Widen once here instead of casting at call sites.
type StampedSettings = DatabaseSettings & { version?: number; _kvTableName?: string }

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
    return { _ddb_internal_kv: false, _db_migrations: false, _teeny_admin_state: false }
  }
}

function buildAdminDb(d1: D1Database, config?: DatabaseSettings) {
  const raw = new $DatabaseRawImpl(d1)
  raw.auth.superadmin = true
  const kvTableName = (config as StampedSettings | undefined)?._kvTableName
  const kv = new InternalKV(raw as any, kvTableName)
  const helper = new MigrationHelperRaw(raw, kv)
  const identities = config && hasIdentitiesExtension(config) ? new InternalIdentities(raw as any) : null
  return { raw, kv, helper, identities }
}

type DbState = { settings: DatabaseSettings | undefined; version: number | null }

async function dbState(db: D1Database, config?: DatabaseSettings): Promise<DbState> {
  const { helper } = buildAdminDb(db, config)
  return helper
    .dbSettings()
    .catch(() => ({ settings: undefined, version: null })) as Promise<DbState>
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

  const { helper } = buildAdminDb(db)
  const [countRow, state, adminCfg, list] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS c FROM _db_migrations").first<{ c: number }>(),
    dbState(db),
    readConfig(db),
    helper.list().catch(() => []),
  ])
  const { settings: applied, version } = state

  let configMatch: StatusPayload["configMatch"] = "match"
  if (!applied) {
    configMatch = "no-applied"
  } else if (adminCfg) {
    try {
      const gen = generateMigrations(adminCfg as any, applied as any, 0) as { migrations: unknown[] }
      configMatch = gen.migrations.length === 0 ? "match" : "drifted"
    } catch {
      configMatch = "drifted"
    }
  }

  return {
    metaTables: meta,
    migrationCount: countRow?.c ?? 0,
    nextIndex: Math.max(USER_MIGRATION_START, nextUserIndex(list)),
    applied: applied ?? null,
    version,
    configMatch,
    teenybaseVersion,
  }
}

/**
 * Create the three metadata tables + seed STARTER_FILES into drafts. Live files
 * stay null — first deploy creates them. Idempotent.
 */
export async function setup(db: D1Database): Promise<void> {
  await db.exec(ADMIN_STATE_DDL.replace(/\n/g, " "))

  const existingDraft = await readDraftFiles(db)
  if (!existingDraft) await writeDraftFiles(db, { ...STARTER_FILES })

  const placeholderConfig = { tables: [] } as unknown as DatabaseSettings
  const { kv, helper, identities } = buildAdminDb(db, placeholderConfig)

  const kvEntry = await kv.setup(0)
  await helper.setup(0)
  const idEntry = identities ? await identities.setup(0) : null

  const infraEntries = [kvEntry, idEntry].filter(
    (e): e is { name: string; sql: string; sql_revert?: string } =>
      !!e && typeof e === "object" && "sql" in (e as any)
  )
  if (infraEntries.length) await helper.apply(infraEntries)
}

export async function generate(
  db: D1Database,
  env: { LOADER: any },
  files: FilesMap
): Promise<GenerateResult> {
  const next = await evalConfigFromFiles(env, files)
  const { helper } = buildAdminDb(db, next)
  const [state, list] = await Promise.all([dbState(db, next), helper.list().catch(() => [])])
  const { settings: applied, version } = state
  const startIndex = nextUserIndex(list)
  const gen = generateMigrations(next as any, applied as any, startIndex) as {
    migrations: { name: string; sql: string; sql_revert?: string }[]
    changes: unknown
    extraLogs?: string[]
  }
  return {
    migrations: gen.migrations ?? [],
    changes: (gen.changes ?? { create: [], drop: [], alter: [] }) as any,
    extraLogs: gen.extraLogs ?? [],
    applied: applied ?? null,
    version,
    startIndex,
    config: next,
  }
}

export interface DeployOpts {
  customSql?: string
  customName?: string
  baselineVersion: number | null
}

export interface DeployResult {
  applied: string[]
  version: number
  config: DatabaseSettings
  promotedFiles: boolean
}

/**
 * Atomic deploy: eval → migrations → $settings CAS → promote draft → clear draft.
 * Any failure before promote aborts with no partial write. Three effective modes
 * fall out of the inputs — no flag needed:
 *   - customSql: runs that SQL as ONE named migration
 *   - schema diff: runs the auto-generated migrations
 *   - neither: helper.apply([], stamped, baseline) still bumps version + writes
 *     $settings (markAsApplied-equivalent) — for code-only deploys
 */
export async function deploy(
  db: D1Database,
  env: { LOADER: any },
  files: FilesMap,
  opts: DeployOpts
): Promise<DeployResult> {
  // Preflight: validate that user files compile before touching the database.
  await buildUserWorkerOrThrow(files)

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
    const [state, list] = await Promise.all([dbState(db, next), helper.list().catch(() => [])])
    const startIndex = nextUserIndex(list)
    const gen = generateMigrations(next as any, state.settings as any, startIndex) as {
      migrations: { name: string; sql: string; sql_revert?: string }[]
    }
    migrations = gen.migrations ?? []
  }

  const nextVersion = ((opts.baselineVersion ?? -1) as number) + 1
  const nextStamped: StampedSettings = { ...(next as any), version: nextVersion }
  const [prevLive] = await Promise.all([
    readFiles(db),
    helper.apply(migrations, nextStamped as any, opts.baselineVersion),
  ])

  const samePromote = !!prevLive && filesEqual(prevLive, files)
  await Promise.all([
    writeFiles(db, files),
    writeConfig(db, nextStamped as DatabaseSettings),
    deleteDraftFiles(db),
  ])

  return {
    applied: migrations.map((m) => m.name),
    version: nextVersion,
    config: nextStamped as DatabaseSettings,
    promotedFiles: !samePromote,
  }
}

/**
 * Drop every user table + teenybase metadata. Preserves _teeny_admin_state
 * (drafts + live files survive). D1 doesn't honor PRAGMA foreign_keys=OFF
 * across separate prepare().run() calls, so we sort by FK dependency and
 * fall back to the PRAGMA approach only for leftovers (cycles).
 */
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
      const fks = await db
        .prepare(`PRAGMA foreign_key_list("${t.replace(/"/g, '""')}")`)
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
