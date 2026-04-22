// Ambient types for the locally-built teenybase cf-ui bundle.
// teenybase's public exports map doesn't expose the migration Raw APIs
// (see ../../../../../packages/teenybase/plans/expose-migration-raw-apis.md),
// so this POC consumes them as values from the local bundle and types them
// here against the published teenybase types.
//
// This file sits next to teenybase_bundle.js so TS picks it up as the
// ambient declaration for that module under moduleResolution: "bundler".

// Re-export the public teenybase surface we use.
export {
  $Database,
  teenyHono,
  OpenApiExtension,
  PocketUIExtension,
  InternalKV,
  InternalIdentities,
  TEENYBASE_VERSION,
  databaseSettingsSchema,
  generateMigrations,
} from "teenybase"

// hono/html + hono/cookie helpers — added by bundle-entry.ts so SSR user.js
// can render HTML and set auth cookies without JSX.
export { html, raw } from "hono/html"
export { setCookie, deleteCookie, getCookie } from "hono/cookie"

// Bundle-only symbols. Typed loosely; cf-ui-sample already validates the shape.
export class $DatabaseRawImpl {
  constructor(adapter: unknown)
  auth: { superadmin: boolean; [k: string]: unknown }
}
export class MigrationHelperRaw {
  constructor(raw: $DatabaseRawImpl, kv: unknown, tableName?: string)
  readonly tableName: string
  setup(version: number): Promise<unknown>
  apply(
    migrations: { name: string; sql: string; sql_revert?: string }[],
    settings?: unknown,
    lastVersion?: number | null
  ): Promise<string[]>
  list(): Promise<{ id: number; name: string; sql: string; sql_revert?: string }[]>
  dbSettings(): Promise<{ settings: unknown; version: number | null }>
}
export const USER_MIGRATION_START: number
export function nextUserIndex(migrations: { name: string }[]): number
export function hasIdentitiesExtension(settings: unknown): boolean
