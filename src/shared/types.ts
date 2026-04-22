// Types shared between server (src/server) and client (src/client).
import type { DatabaseSettings } from "teenybase"

export type ConfigMatch = "match" | "drifted" | "no-applied" | "setup-required"

export interface MetaTableStatus {
  _ddb_internal_kv: boolean
  _db_migrations: boolean
  _teeny_admin_state: boolean
}

export interface StatusPayload {
  metaTables: MetaTableStatus
  migrationCount: number
  nextIndex: number
  applied: DatabaseSettings | null
  version: number | null
  configMatch: ConfigMatch
  teenybaseVersion: string
}

export type FilesMap = Record<string, string>

export interface FilesResponse {
  live: FilesMap | null       // null if never deployed
  draft: FilesMap | null      // null if no draft saved (= live is source of truth)
  editor: FilesMap            // convenience: draft ?? live ?? starter
  config: DatabaseSettings | null
}

export interface GenerateResult {
  migrations: { name: string; sql: string; sql_revert?: string }[]
  changes: DiffChanges
  extraLogs: string[]
  applied: DatabaseSettings | null
  version: number | null
  startIndex: number
  config: DatabaseSettings
}

export interface DiffChanges {
  create: { name: string; fields: { name: string; type?: string }[] }[]
  drop: { name: string }[]
  alter: [
    { name: string },
    { name: string },
    {
      create: { name: string; type?: string }[]
      drop: { name: string; type?: string }[]
      alter: [{ name: string; type?: string }, { name: string; type?: string }][]
      indexes?: { create?: { fields: string | string[] }[]; drop?: { fields: string | string[] }[] }
      triggers?: { create?: { name?: string }[]; drop?: { name?: string }[] }
      fts?: unknown
    }
  ][]
}

export interface DeployRequest {
  files: FilesMap
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

export interface MigrationHistoryRow {
  index: number
  name: string
  applied_at: number
}
