// Admin state: just the current editable config.
//
// We keep the config in the host's D1 (next to teenybase's _ddb_internal_kv
// and _db_migrations) so the host can spawn the dynamic user worker on each
// request with the right config baked into a config.js module. The table is
// a singleton key-value; the only row is {key: "config", value: JSON}.
//
// On Apply, the admin endpoint writes the config to both _teeny_admin_state
// AND $settings in _ddb_internal_kv (via teenybase's MigrationHelperRaw). On
// page load, the editor's starting value is the current _teeny_admin_state.
import type { DatabaseSettings } from "teenybase"

export const ADMIN_STATE_DDL = `
CREATE TABLE IF NOT EXISTS _teeny_admin_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`.trim()

export async function adminStateTableExists(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_teeny_admin_state'")
    .first()
  return row !== null
}

export async function readConfig(db: D1Database): Promise<DatabaseSettings | null> {
  if (!(await adminStateTableExists(db))) return null
  const row = await db
    .prepare("SELECT value FROM _teeny_admin_state WHERE key='config'")
    .first<{ value: string }>()
  if (!row) return null
  try {
    return JSON.parse(row.value) as DatabaseSettings
  } catch {
    return null
  }
}

export async function writeConfig(db: D1Database, config: DatabaseSettings): Promise<void> {
  await db
    .prepare(
      "INSERT OR REPLACE INTO _teeny_admin_state (key, value, updated_at) VALUES ('config', ?, ?)"
    )
    .bind(JSON.stringify(config), Date.now())
    .run()
}

async function readStringKey(db: D1Database, key: "user_code" | "worker_code"): Promise<string | null> {
  if (!(await adminStateTableExists(db))) return null
  const row = await db
    .prepare("SELECT value FROM _teeny_admin_state WHERE key=?")
    .bind(key)
    .first<{ value: string }>()
  return row?.value ?? null
}
async function writeStringKey(db: D1Database, key: "user_code" | "worker_code", value: string): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO _teeny_admin_state (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(key, value, Date.now())
    .run()
}

export const readUserCode = (db: D1Database) => readStringKey(db, "user_code")
export const writeUserCode = (db: D1Database, code: string) => writeStringKey(db, "user_code", code)
export const readWorkerCode = (db: D1Database) => readStringKey(db, "worker_code")
export const writeWorkerCode = (db: D1Database, code: string) => writeStringKey(db, "worker_code", code)
