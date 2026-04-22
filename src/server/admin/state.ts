// Admin state is a single KV table (`_teeny_admin_state`) with three keys:
//   files        — the deployed tree (runtime reads this)
//   files_draft  — the editor's working copy; deploy promotes it to files
//   config       — compiled DatabaseSettings JSON from the last deploy
import type { DatabaseSettings } from "teenybase"

export const ADMIN_STATE_DDL = `
CREATE TABLE IF NOT EXISTS _teeny_admin_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`.trim()

export type FilesMap = Record<string, string>

type StateKey = "files" | "files_draft" | "config"

async function readKey(db: D1Database, key: StateKey): Promise<string | null> {
  try {
    const row = await db
      .prepare("SELECT value FROM _teeny_admin_state WHERE key=?")
      .bind(key)
      .first<{ value: string }>()
    return row?.value ?? null
  } catch {
    // Table not there yet (pre-setup) or D1 cold-start — both behave the same
    // to callers: no data.
    return null
  }
}

async function writeKey(db: D1Database, key: StateKey, value: string): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO _teeny_admin_state (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(key, value, Date.now())
    .run()
}

function parseFiles(s: string | null): FilesMap | null {
  if (!s) return null
  try {
    const parsed = JSON.parse(s)
    return typeof parsed === "object" && parsed ? (parsed as FilesMap) : null
  } catch {
    return null
  }
}

export async function adminStateTableExists(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_teeny_admin_state'")
      .first()
    return row !== null
  } catch {
    return false
  }
}

export const readFiles = async (db: D1Database) => parseFiles(await readKey(db, "files"))
export const readDraftFiles = async (db: D1Database) => parseFiles(await readKey(db, "files_draft"))
export async function writeFiles(db: D1Database, files: FilesMap): Promise<void> {
  await writeKey(db, "files", JSON.stringify(files))
}
export async function writeDraftFiles(db: D1Database, files: FilesMap): Promise<void> {
  await writeKey(db, "files_draft", JSON.stringify(files))
}
export async function deleteDraftFiles(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM _teeny_admin_state WHERE key='files_draft'").run().catch(() => {})
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

/**
 * Runtime hot-path: read files + config in one D1 query.
 */
export async function readRuntimeState(
  db: D1Database
): Promise<{ files: FilesMap | null; config: DatabaseSettings | null }> {
  try {
    const rows = await db
      .prepare("SELECT key, value FROM _teeny_admin_state WHERE key IN ('files','config')")
      .all<{ key: string; value: string }>()
    const map = new Map((rows.results ?? []).map((r) => [r.key, r.value]))
    return {
      files: parseFiles(map.get("files") ?? null),
      config: (() => {
        const s = map.get("config")
        if (!s) return null
        try {
          return JSON.parse(s) as DatabaseSettings
        } catch {
          return null
        }
      })(),
    }
  } catch {
    return { files: null, config: null }
  }
}
