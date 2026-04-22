import type {
  DeployRequest,
  DeployResult,
  EvalConfigResult,
  FilesMap,
  FilesResponse,
  GenerateResult,
  MigrationHistoryRow,
  StatusPayload,
} from "@shared/types"

const BASE = "/_teeny/admin/api"

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, {
    credentials: "include",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  })
  if (!r.ok) {
    let body: any = null
    try { body = await r.json() } catch {}
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
  files: () => req<FilesResponse>("/files"),
  saveDraft: (files: FilesMap) =>
    req<{ ok: true }>("/save-draft", { method: "POST", body: JSON.stringify({ files }) }),
  revertDraft: () => req<{ ok: true }>("/revert-draft", { method: "POST" }),
  setup: () => req<{ ok: true }>("/setup", { method: "POST" }),
  evalConfig: (files: FilesMap) =>
    req<EvalConfigResult>("/eval-config", { method: "POST", body: JSON.stringify({ files }) }),
  generate: (files: FilesMap) =>
    req<GenerateResult>("/generate", { method: "POST", body: JSON.stringify({ files }) }),
  deploy: (body: DeployRequest) =>
    req<DeployResult>("/deploy", { method: "POST", body: JSON.stringify(body) }),
  history: () => req<{ rows: MigrationHistoryRow[] }>("/history"),
  clear: () => req<{ ok: true; dropped: number; names: string[] }>("/clear", { method: "POST" }),
  syncFromD1: () => req<{ ok: true }>("/sync-from-d1", { method: "POST" }),
}
