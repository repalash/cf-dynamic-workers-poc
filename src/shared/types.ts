// Types shared between server (src/server) and client (src/client).
// Mirrors cf-ui-sample's admin API shape where applicable.
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

export interface ConfigResponse {
  config: DatabaseSettings | null
  workerCode: string
  workerCodeIsSaved: boolean
  userCode: string
  userCodeIsSaved: boolean
}

export interface GenerateResult {
  migrations: { name: string; sql: string; sql_revert?: string }[]
  changes: DiffChanges
  extraLogs: string[]
  applied: DatabaseSettings | null
  version: number | null
  startIndex: number
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
      indexes?: {
        create?: { fields: string | string[] }[]
        drop?: { fields: string | string[] }[]
      }
      triggers?: {
        create?: { name?: string }[]
        drop?: { name?: string }[]
      }
      fts?: unknown
    }
  ][]
}

export interface ApplyRequest {
  config: DatabaseSettings
  customSql?: string
  customName?: string
  markAsApplied?: boolean
  /** CAS token from the last /generate response. null on fresh DB. */
  baselineVersion: number | null
}

export interface ApplyResult {
  applied: string[]
  version: number
}

export interface MigrationHistoryRow {
  index: number
  name: string
  applied_at: number
}

export interface ApiError {
  error: string
  details?: unknown
  stack?: string
}
