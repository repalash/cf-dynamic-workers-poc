// Admin state: the user's file tree for the dynamic worker + the compiled
// config JSON. Files are an arbitrary map (Record<string, string>) so the
// user can add/remove files freely (worker.js, user.js, teenybase.ts,
// lib/foo.ts, package.json — whatever). The host bundles them via
// @cloudflare/worker-bundler at spawn time and feeds the result into
// LOADER.load({ modules }).
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

async function readKey(db: D1Database, key: string): Promise<string | null> {
  if (!(await adminStateTableExists(db))) return null
  const row = await db
    .prepare("SELECT value FROM _teeny_admin_state WHERE key=?")
    .bind(key)
    .first<{ value: string }>()
  return row?.value ?? null
}

async function writeKey(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO _teeny_admin_state (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(key, value, Date.now())
    .run()
}

export type FilesMap = Record<string, string>

export async function readFiles(db: D1Database): Promise<FilesMap | null> {
  const s = await readKey(db, "files")
  if (!s) return null
  try {
    const parsed = JSON.parse(s)
    return typeof parsed === "object" && parsed ? (parsed as FilesMap) : null
  } catch {
    return null
  }
}

export async function writeFiles(db: D1Database, files: FilesMap): Promise<void> {
  await writeKey(db, "files", JSON.stringify(files))
}

export async function readConfig(db: D1Database): Promise<DatabaseSettings | null> {
  const s = await readKey(db, "config")
  if (!s) return null
  try {
    return JSON.parse(s) as DatabaseSettings
  } catch {
    return null
  }
}

export async function writeConfig(db: D1Database, config: DatabaseSettings): Promise<void> {
  await writeKey(db, "config", JSON.stringify(config))
}
