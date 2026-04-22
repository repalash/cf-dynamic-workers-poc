import type {
  ApplyRequest,
  ApplyResult,
  EvalConfigResult,
  FilesMap,
  FilesResponse,
  GenerateResult,
  MigrationHistoryRow,
  SaveFilesResult,
  StatusPayload,
} from "@shared/types"

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
  files: () => req<FilesResponse>("/files"),
  saveFiles: (files: FilesMap) =>
    req<SaveFilesResult>("/save-files", { method: "POST", body: JSON.stringify({ files }) }),
  setup: () => req<{ ok: true }>("/setup", { method: "POST" }),
  evalConfig: (files: FilesMap) =>
    req<EvalConfigResult>("/eval-config", { method: "POST", body: JSON.stringify({ files }) }),
  generate: (files: FilesMap) =>
    req<GenerateResult>("/generate", { method: "POST", body: JSON.stringify({ files }) }),
  apply: (body: ApplyRequest) =>
    req<ApplyResult>("/apply", { method: "POST", body: JSON.stringify(body) }),
  history: () => req<{ rows: MigrationHistoryRow[] }>("/history"),
  clear: () => req<{ ok: true; dropped: number; names: string[] }>("/clear", { method: "POST" }),
  syncFromD1: () => req<{ ok: true }>("/sync-from-d1", { method: "POST" }),
}
