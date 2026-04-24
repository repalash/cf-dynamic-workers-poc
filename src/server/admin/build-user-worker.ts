// Canonical build helper for user worker files. Single build path used by
// validateBuild tool, deploy preflight, and spawnDynamic.
//
// Detects TSX/JSX files and enables Hono JSX transform automatically.
// Returns normalized errors with file/line/column for AI self-repair.
import { createWorker } from "@cloudflare/worker-bundler"
import type { FilesMap } from "./state"

const EXTERNALS = ["teenybase", "virtual:teenybase", "hono/jsx/jsx-runtime", "hono/jsx/jsx-dev-runtime"]

export interface NormalizedBuildError {
  message: string
  errors: {
    text: string
    location?: {
      file: string
      line: number
      column: number
      lineText?: string
    }
  }[]
}

export type BuildResult =
  | { ok: true; mainModule: string; modules: Record<string, any>; warnings: string[] }
  | { ok: false; error: NormalizedBuildError }

function hasTsxFiles(files: FilesMap): boolean {
  return Object.keys(files).some((f) => f.endsWith(".tsx") || f.endsWith(".jsx"))
}

function normalizeBuildError(e: any): NormalizedBuildError {
  const msg = e?.message ?? String(e)
  const errors: NormalizedBuildError["errors"] = []

  // esbuild-style errors have an `errors` array
  if (Array.isArray(e?.errors)) {
    for (const err of e.errors) {
      errors.push({
        text: err.text ?? String(err),
        location: err.location
          ? {
              file: err.location.file?.replace(/^virtual:/, "") ?? "",
              line: err.location.line ?? 0,
              column: err.location.column ?? 0,
              lineText: err.location.lineText,
            }
          : undefined,
      })
    }
  }

  // Fallback: parse "file:line:col: ERROR: text" from message
  if (errors.length === 0 && msg) {
    const match = msg.match(
      /(?:virtual:)?([^:\s]+):(\d+):(\d+):\s*ERROR:\s*(.+)/
    )
    if (match) {
      errors.push({
        text: match[4],
        location: {
          file: match[1],
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
        },
      })
    } else {
      errors.push({ text: msg })
    }
  }

  return { message: msg, errors }
}

export function formatBuildError(err: NormalizedBuildError): string {
  const lines = [err.message]
  for (const e of err.errors) {
    if (e.location) {
      lines.push(`  ${e.location.file}:${e.location.line}:${e.location.column}: ${e.text}`)
      if (e.location.lineText) lines.push(`    ${e.location.lineText}`)
    } else {
      lines.push(`  ${e.text}`)
    }
  }
  return lines.join("\n")
}

/**
 * Bundle user files into a worker. Returns structured success/error.
 * Automatically enables JSX transform when .tsx/.jsx files are present.
 */
export async function buildUserWorker(files: FilesMap): Promise<BuildResult> {
  try {
    const opts: any = {
      files,
      bundle: true,
      externals: EXTERNALS,
    }

    if (hasTsxFiles(files)) {
      opts.jsx = "automatic"
      opts.jsxImportSource = "hono/jsx"
    }

    const result = await createWorker(opts)

    return {
      ok: true,
      mainModule: result.mainModule,
      modules: result.modules,
      warnings: (result as any).warnings ?? [],
    }
  } catch (e: any) {
    return {
      ok: false,
      error: normalizeBuildError(e),
    }
  }
}

/**
 * Throwing variant — for call sites that want to abort on failure.
 */
export async function buildUserWorkerOrThrow(files: FilesMap) {
  const result = await buildUserWorker(files)
  if (!result.ok) throw new Error(formatBuildError(result.error))
  return result
}
