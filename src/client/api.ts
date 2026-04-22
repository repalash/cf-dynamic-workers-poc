// Typed fetch client for /_teeny/admin/api/*.
import type {
  ApplyRequest,
  ApplyResult,
  ConfigResponse,
  GenerateResult,
  MigrationHistoryRow,
  StatusPayload,
} from "@shared/types"
import type { DatabaseSettings } from "teenybase"

const BASE = "/_teeny/admin/api"

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, {
    credentials: "include",
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  })
  if (!r.ok) {
    let body: any = null
    try {
      body = await r.json()
    } catch {}
    const err: any = new Error(body?.error || `HTTP ${r.status}`)
    err.status = r.status
    err.details = body?.details
    err.stack = body?.stack || err.stack
    throw err
  }
  return r.json() as Promise<T>
}

export const api = {
  status: () => req<StatusPayload>("/status"),
  config: () => req<ConfigResponse>("/config"),
  setup: () => req<{ ok: true }>("/setup", { method: "POST" }),
  saveUserCode: (userCode: string) =>
    req<{ ok: true }>("/save-user-code", {
      method: "POST",
      body: JSON.stringify({ userCode }),
    }),
  saveWorkerCode: (workerCode: string) =>
    req<{ ok: true }>("/save-worker-code", {
      method: "POST",
      body: JSON.stringify({ workerCode }),
    }),
  generate: (config: DatabaseSettings) =>
    req<GenerateResult>("/generate", { method: "POST", body: JSON.stringify({ config }) }),
  apply: (body: ApplyRequest) =>
    req<ApplyResult>("/apply", { method: "POST", body: JSON.stringify(body) }),
  history: () => req<{ rows: MigrationHistoryRow[] }>("/history"),
  clear: () => req<{ ok: true; dropped: number; names: string[] }>("/clear", { method: "POST" }),
  syncFromD1: () => req<{ ok: true }>("/sync-from-d1", { method: "POST" }),
  saveConfig: (config: DatabaseSettings) =>
    req<{ ok: true }>("/save-config", { method: "POST", body: JSON.stringify({ config }) }),
}
