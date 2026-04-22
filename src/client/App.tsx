// Single-page admin UI. Dark cf-ui-sample design system. Panels:
//   Status → Setup (conditional) → Sync (conditional) → Migrate (3 steps,
//   driven by the in-memory files map) → Files (file manager) → History →
//   Danger.
//
// The files map is the source of truth for both:
//   - migration generation (teenybase.ts evaluated server-side to JSON)
//   - runtime spawn (bundled by worker-bundler at request time)
// All save + generate + apply endpoints take {files} in the body.
import { useEffect, useMemo, useState } from "react"
import { api } from "./api"
import { Editor } from "./Editor"
import { Confirm } from "./Confirm"
import type {
  DiffChanges,
  FilesMap,
  GenerateResult,
  MigrationHistoryRow,
  StatusPayload,
} from "@shared/types"

function joinSql(migs: { sql: string }[]) {
  return migs.map((m) => m.sql.trim()).join("\n\n")
}
function isEmptyOrCommentsOnly(sql: string) {
  const stripped = sql.replace(/--[^\n]*\n/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim()
  return stripped.length === 0
}
function looksDestructive(sql: string) {
  return /\b(DROP|TRUNCATE)\b/i.test(sql) || /\bDELETE\s+FROM\b(?![\s\S]{0,40}WHERE)/i.test(sql)
}
function pad5(n: number) {
  return String(n).padStart(5, "0")
}
function extOf(name: string): "json" | "javascript" {
  return name.endsWith(".json") ? "json" : "javascript"
}
function filesEqual(a: FilesMap, b: FilesMap): boolean {
  const ak = Object.keys(a).sort()
  const bk = Object.keys(b).sort()
  if (ak.length !== bk.length) return false
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false
    if (a[ak[i]] !== b[bk[i]]) return false
  }
  return true
}

function ErrorBanner({ err, onClose }: { err: string | null; onClose: () => void }) {
  if (!err) return null
  return (
    <div className="err">
      <strong>Error</strong>
      {err}
      <div style={{ marginTop: 6 }}>
        <button className="btn ghost" style={{ padding: "4px 10px" }} onClick={onClose}>
          dismiss
        </button>
      </div>
    </div>
  )
}

function StepNum({ n, active }: { n: number; active: boolean }) {
  return <span className={`step-num${active ? " active" : ""}`}>{n}</span>
}

function StatusPanel({ status }: { status: StatusPayload }) {
  const row = (name: keyof typeof status.metaTables) => (
    <span key={name} className={`item${status.metaTables[name] ? " ok" : " bad"}`}>
      {name}: {status.metaTables[name] ? "present" : "missing"}
    </span>
  )
  return (
    <section className="panel">
      <h2>Status</h2>
      <div className="status-row">
        {row("_ddb_internal_kv")}
        {row("_db_migrations")}
        {row("_teeny_admin_state")}
        <span className="item">
          applied: {status.migrationCount} · next: {pad5(status.nextIndex)} · version: {status.version ?? "—"}
        </span>
      </div>
      <div className="routes">
        <div className="route"><span className="label">CRUD</span><span className="tmpl">/api/v1/table/&#123;table&#125;/[select | list | view/:id | insert | update | edit/:id | delete]</span></div>
        <div className="route"><span className="label">Auth</span><span className="tmpl">/api/v1/table/&#123;table&#125;/auth/[sign-up | login-password | ...]</span></div>
        <div className="route"><span className="label">Health</span><a href="/api/v1/health" target="_blank" rel="noreferrer">/api/v1/health</a></div>
        <div className="route"><span className="label">Swagger</span><a href="/api/v1/doc/ui" target="_blank" rel="noreferrer">/api/v1/doc/ui</a></div>
        <div className="route"><span className="label">Admin</span><a href="/api/v1/pocket/" target="_blank" rel="noreferrer">/api/v1/pocket/</a></div>
        <div className="route"><span className="label">App</span><a href="/" target="_blank" rel="noreferrer">/</a> <span className="tmpl">(the dynamic worker — SSR notes app)</span></div>
      </div>
    </section>
  )
}

function DiffOutput({ changes, extraLogs }: { changes: DiffChanges; extraLogs: string[] }) {
  const empty = changes.create.length === 0 && changes.drop.length === 0 && changes.alter.length === 0
  return (
    <div className="diff-output">
      {extraLogs.map((l, i) => <div key={"l" + i} className="warn">{l}</div>)}
      {empty ? (
        <div className="ok">No schema changes detected. Write data-only SQL below (backfill / seed) to run a data-only migration, or edit teenybase.ts.</div>
      ) : (
        <div className="diff-box">
          <h3>Changes</h3>
          {changes.create.map((t) => (
            <div key={"c" + t.name} className="diff-item diff-add">+ Table &quot;{t.name}&quot; ({t.fields.length} field{t.fields.length === 1 ? "" : "s"})</div>
          ))}
          {changes.drop.map((t) => (
            <div key={"d" + t.name} className="diff-item diff-drop">- Table &quot;{t.name}&quot;</div>
          ))}
          {changes.alter.map(([nn, _pp, d], i) => (
            <div key={"a" + i}>
              <div className="diff-item diff-mod">~ Table &quot;{nn.name}&quot;</div>
              {d.create.map((f) => <div key={"cf" + f.name} className="diff-sub diff-add">+ field &quot;{f.name}&quot;{f.type ? ` (${f.type})` : ""}</div>)}
              {d.drop.map((f) => <div key={"df" + f.name} className="diff-sub diff-drop">- field &quot;{f.name}&quot;</div>)}
              {d.alter.map(([a, b], j) => <div key={"af" + j} className="diff-sub diff-mod">~ field &quot;{a.name}&quot;{a.name !== b.name ? ` (renamed from ${b.name})` : ""}</div>)}
              {(d.indexes?.create ?? []).map((ix, j) => <div key={"ic" + j} className="diff-sub diff-add">+ index {JSON.stringify(ix.fields)}</div>)}
              {(d.indexes?.drop ?? []).map((ix, j) => <div key={"id" + j} className="diff-sub diff-drop">- index {JSON.stringify(ix.fields)}</div>)}
              {(d.triggers?.create ?? []).map((t, j) => <div key={"tc" + j} className="diff-sub diff-add">+ trigger &quot;{t.name ?? ""}&quot;</div>)}
              {(d.triggers?.drop ?? []).map((t, j) => <div key={"td" + j} className="diff-sub diff-drop">- trigger &quot;{t.name ?? ""}&quot;</div>)}
              {d.fts ? <div className="diff-sub diff-mod">~ FTS index changed</div> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function App() {
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [files, setFiles] = useState<FilesMap>({})
  const [filesSaved, setFilesSaved] = useState<FilesMap>({})
  const [activeFile, setActiveFile] = useState<string>("")
  const [lastGen, setLastGen] = useState<GenerateResult | null>(null)
  const [sqlText, setSqlText] = useState<string>("")
  const [customName, setCustomName] = useState<string>("")
  const [history, setHistory] = useState<MigrationHistoryRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string>("")
  const [note, setNote] = useState<string>("")
  const [confirmOpen, setConfirmOpen] = useState<{
    run: () => void; title: string; body: string; destructive: boolean
  } | null>(null)
  const [newFileName, setNewFileName] = useState<string>("")

  async function loadAll() {
    try {
      setErr(null)
      const [s, f] = await Promise.all([api.status(), api.files()])
      setStatus(s)
      setFiles(f.files)
      setFilesSaved(f.filesSaved ? f.files : {})
      if (!activeFile || !(activeFile in f.files)) {
        const first = Object.keys(f.files).find((n) => n === "teenybase.ts") ?? Object.keys(f.files)[0] ?? ""
        setActiveFile(first)
      }
    } catch (e: any) {
      setErr(e.message)
    }
  }
  useEffect(() => {
    loadAll()
    api.history().then((r) => setHistory(r.rows)).catch(() => {})
  }, [])

  const autoSql = useMemo(() => (lastGen ? joinSql(lastGen.migrations) : ""), [lastGen])
  const sqlEdited = lastGen ? sqlText.trim() !== autoSql.trim() : false
  const canApply = !!lastGen && (lastGen.migrations.length > 0 || !isEmptyOrCommentsOnly(sqlText)) && !isEmptyOrCommentsOnly(sqlText)
  const filesDirty = !filesEqual(files, filesSaved)

  function updateActiveContent(content: string) {
    if (!activeFile) return
    setFiles((f) => ({ ...f, [activeFile]: content }))
  }

  async function doSetup() {
    setBusy("setup"); setErr(null)
    try {
      await api.setup()
      await loadAll()
      const r = await api.history(); setHistory(r.rows)
      setNote("Metadata tables created. Edit teenybase.ts then Generate preview → Apply.")
    } catch (e: any) { setErr(e.message) } finally { setBusy("") }
  }

  async function doSaveFiles() {
    setBusy("save-files"); setErr(null)
    try {
      const r = await api.saveFiles(files)
      setFilesSaved({ ...files })
      setNote(r.configUpdated
        ? "Files saved. Config re-evaluated."
        : `Files saved. (Config eval error: ${r.evalError}).`)
    } catch (e: any) { setErr(e.message) } finally { setBusy("") }
  }

  async function doGenerate() {
    setBusy("generate"); setErr(null); setNote("")
    try {
      const g = await api.generate(files)
      setLastGen(g)
      const seed = joinSql(g.migrations) || "-- No schema changes. Add data-only SQL (backfill / seed) here."
      setSqlText(seed); setCustomName("")
    } catch (e: any) {
      setErr(e.details ? `${e.message}: ${JSON.stringify(e.details, null, 2)}` : e.message)
    } finally { setBusy("") }
  }

  function resetSql() { setSqlText(autoSql || "-- No schema changes.") }

  async function doApply() {
    if (!lastGen) return
    const baselineVersion = lastGen.version
    const currentSql = sqlText.trim()
    if (!sqlEdited) {
      const destructive = looksDestructive(autoSql)
      setConfirmOpen({
        title: `Apply ${lastGen.migrations.length} migration${lastGen.migrations.length === 1 ? "" : "s"} to D1`,
        body: (destructive ? "⚠ Destructive operations.\n\n" : "") +
          lastGen.migrations.map((m) => `-- ${m.name}\n${m.sql.trim()}`).join("\n\n"),
        destructive,
        run: async () => {
          setConfirmOpen(null); setBusy("apply"); setErr(null)
          try {
            await api.apply({ files, baselineVersion })
            setFilesSaved({ ...files })
            await loadAll()
            setLastGen(null); setSqlText(""); setCustomName("")
            const h = await api.history(); setHistory(h.rows)
            setNote("Applied. $settings stamped.")
          } catch (e: any) {
            setErr(e.stack ? `${e.message}\n\n${e.stack}` : e.message)
          } finally { setBusy("") }
        },
      })
      return
    }
    const suffix = customName.trim() || "custom.sql"
    const finalSuffix = suffix.endsWith(".sql") ? suffix : suffix + ".sql"
    const fullCustomName = `${pad5(lastGen.startIndex)}_${finalSuffix}`
    const destructive = looksDestructive(currentSql)
    setConfirmOpen({
      title: `Apply custom SQL as "${fullCustomName}"`,
      body: (destructive ? "⚠ Destructive operations.\n\n" : "") + `-- ${fullCustomName}\n${currentSql}`,
      destructive,
      run: async () => {
        setConfirmOpen(null); setBusy("apply"); setErr(null)
        try {
          await api.apply({ files, customSql: currentSql, customName: fullCustomName, baselineVersion })
          setFilesSaved({ ...files })
          await loadAll()
          setLastGen(null); setSqlText(""); setCustomName("")
          const h = await api.history(); setHistory(h.rows)
          setNote("Applied custom migration.")
        } catch (e: any) {
          setErr(e.stack ? `${e.message}\n\n${e.stack}` : e.message)
        } finally { setBusy("") }
      },
    })
  }

  function addFile() {
    const name = newFileName.trim()
    if (!name) return
    if (name in files) { setErr(`File ${name} already exists`); return }
    setFiles((f) => ({ ...f, [name]: "" }))
    setActiveFile(name)
    setNewFileName("")
  }
  function removeFile(name: string) {
    if (!confirm(`Delete ${name}? (Not persisted until you Save files.)`)) return
    setFiles((f) => {
      const { [name]: _, ...rest } = f
      return rest
    })
    if (activeFile === name) {
      const next = Object.keys(files).find((n) => n !== name) ?? ""
      setActiveFile(next)
    }
  }

  async function doSyncFromD1() {
    setBusy("sync"); setErr(null)
    try { await api.syncFromD1(); await loadAll(); setNote("Admin config synced from D1.") }
    catch (e: any) { setErr(e.message) } finally { setBusy("") }
  }

  async function doClear() {
    setConfirmOpen({
      title: "Clear DB",
      body: "Drops teenybase metadata + every user table. Admin state (Files + Config) is preserved. After clear, re-run Setup + Apply.",
      destructive: true,
      run: async () => {
        setConfirmOpen(null); setBusy("clear"); setErr(null)
        try {
          await api.clear(); await loadAll()
          setLastGen(null); setSqlText(""); setCustomName(""); setHistory([])
          setNote("Cleared.")
        } catch (e: any) { setErr(e.message) } finally { setBusy("") }
      },
    })
  }

  const configMatch = status?.configMatch ?? "setup-required"
  const setupMissing = configMatch === "setup-required"
  const drifted = configMatch === "drifted"
  const fileNames = Object.keys(files).sort()

  return (
    <>
      <header className="site">
        <h1>
          <span className="brand">teenybase</span>
          <span className="slash">/</span>
          <span className="sub">admin</span>
        </h1>
        <span className="meta">teenybase {status?.teenybaseVersion ?? "…"}</span>
      </header>

      <main>
        <ErrorBanner err={err} onClose={() => setErr(null)} />
        {note && <div className="ok">{note}</div>}

        {status && <StatusPanel status={status} />}

        {setupMissing && (
          <section className="panel">
            <h2>Setup</h2>
            <p className="hint">Metadata tables are missing. Setup seeds a starter file tree (teenybase.ts + worker.js + user.js + package.json), evaluates the config, and creates <code>_ddb_internal_kv</code> / <code>_db_migrations</code> / <code>_teeny_admin_state</code>. Idempotent.</p>
            <div className="actions">
              <button className="btn" onClick={doSetup} disabled={busy === "setup"}>
                {busy === "setup" ? "Setting up…" : "Setup metadata tables"}
              </button>
            </div>
          </section>
        )}

        {drifted && (
          <section className="panel sync">
            <h2>Config drift</h2>
            <p className="hint">
              The editor&apos;s teenybase.ts evaluates to something that doesn&apos;t match <code>$settings</code> in D1. Apply via Migrate below, or pull D1&apos;s applied config into admin state (teenybase.ts itself is left untouched; you&apos;ll need to reconcile manually).
            </p>
            <div className="actions">
              <button className="btn ghost" onClick={doSyncFromD1} disabled={busy === "sync"}>
                {busy === "sync" ? "Syncing…" : "Sync admin state from D1"}
              </button>
            </div>
          </section>
        )}

        {/* Files panel */}
        <section className="panel">
          <h2>Files</h2>
          <p className="hint">
            User-authored file tree. Bundled via <code>@cloudflare/worker-bundler</code> at spawn time, loaded into the dynamic worker. <strong>teenybase.ts</strong> is evaluated server-side to derive the config JSON; <strong>worker.js</strong> is the entry; <strong>user.js</strong> is the Hono app mounted at <code>/</code>. Add or remove files freely.
          </p>
          <div style={{ display: "flex", gap: 12 }}>
            <aside style={{ width: 220, flexShrink: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              {fileNames.length === 0 && <div className="hint">(no files)</div>}
              {fileNames.map((n) => (
                <div key={n} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <button
                    className={`tab${activeFile === n ? " active" : ""}`}
                    style={{ flex: 1, textAlign: "left", padding: "6px 10px", borderBottom: 0 }}
                    onClick={() => setActiveFile(n)}
                  >
                    {n}
                    {files[n] !== filesSaved[n] ? " •" : ""}
                  </button>
                  <button
                    className="btn ghost"
                    style={{ padding: "2px 6px", fontSize: 11 }}
                    onClick={() => removeFile(n)}
                    title="Delete file"
                  >×</button>
                </div>
              ))}
              <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                <input
                  type="text"
                  placeholder="new file.ts"
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addFile() }}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button className="btn ghost" onClick={addFile} style={{ padding: "4px 10px" }}>+</button>
              </div>
            </aside>
            <div style={{ flex: 1, minWidth: 0 }}>
              {activeFile ? (
                <Editor
                  value={files[activeFile] ?? ""}
                  onChange={updateActiveContent}
                  lang={extOf(activeFile)}
                  minHeight="420px"
                />
              ) : (
                <div className="hint">Select a file or add a new one.</div>
              )}
            </div>
          </div>
          <div className="actions">
            <button className="btn" onClick={doSaveFiles} disabled={!filesDirty || busy === "save-files"}>
              {busy === "save-files" ? "Saving…" : "Save files"}
            </button>
            {filesDirty && <span className="status-msg">unsaved changes</span>}
          </div>
        </section>

        {/* Migrate */}
        <section className="panel migrate-panel">
          <h2>Migrate</h2>

          <div className={`step${setupMissing ? " pending" : ""}`}>
            <div className="step-header">
              <StepNum n={1} active={!setupMissing && !lastGen} />
              <span className="step-title">Generate preview from teenybase.ts</span>
            </div>
            <p className="hint">Bundles &amp; evaluates <code>teenybase.ts</code> server-side (LOADER-run eval worker), diffs against D1&apos;s <code>$settings</code>, returns the migrations.</p>
            <div className="actions">
              <button className="btn" onClick={doGenerate} disabled={busy === "generate" || setupMissing}>
                {busy === "generate" ? "Generating…" : "Generate preview"}
              </button>
            </div>
          </div>

          <div className={`step${lastGen ? "" : " pending"}`}>
            <div className="step-header">
              <StepNum n={2} active={!!lastGen && !sqlEdited} />
              <span className="step-title">Review generated SQL</span>
            </div>
            {lastGen ? <DiffOutput changes={lastGen.changes} extraLogs={lastGen.extraLogs} /> : null}
            {lastGen && (
              <>
                <label>SQL to apply (edit to override — becomes one custom migration)</label>
                <Editor value={sqlText} onChange={setSqlText} lang="javascript" minHeight="220px" />
                <div className="actions">
                  <button className="btn ghost" onClick={resetSql}>Reset to auto-generated</button>
                </div>
              </>
            )}
          </div>

          <div className={`step${lastGen ? "" : " pending"}`}>
            <div className="step-header">
              <StepNum n={3} active={!!lastGen && (sqlEdited || !isEmptyOrCommentsOnly(sqlText))} />
              <span className="step-title">Apply</span>
            </div>
            {lastGen && !sqlEdited && lastGen.migrations.length > 0 && (
              <>
                <label>Files to create in _db_migrations</label>
                <ul className="file-list">
                  {lastGen.migrations.map((m) => <li key={m.name}>{m.name}</li>)}
                </ul>
              </>
            )}
            {lastGen && sqlEdited && (
              <div className="actions">
                <span className="group">
                  <label style={{ margin: 0 }}>Name</label>
                  <span className="name-group">
                    <span className="name-prefix">{pad5(lastGen.startIndex)}_</span>
                    <input
                      type="text"
                      placeholder="custom.sql"
                      value={customName}
                      onChange={(e) => setCustomName(e.target.value)}
                    />
                  </span>
                </span>
              </div>
            )}
            <div className="actions">
              <button className="btn" onClick={doApply} disabled={!canApply || busy === "apply"}>
                {busy === "apply" ? "Applying…" : "Apply to D1"}
              </button>
            </div>
          </div>
        </section>

        <section className="panel">
          <h2>Migration history</h2>
          <div className="actions">
            <button className="btn ghost" onClick={() => api.history().then((r) => setHistory(r.rows)).catch((e) => setErr(e.message))}>Refresh</button>
          </div>
          {history.length === 0 ? (
            <div className="status-msg">No migrations recorded.</div>
          ) : (
            <table className="history-table">
              <thead><tr><th>idx</th><th>name</th><th>applied</th></tr></thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.index}>
                    <td>{r.index}</td>
                    <td>{r.name}</td>
                    <td>{r.applied_at ? new Date(r.applied_at).toISOString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel danger">
          <h2>Danger zone</h2>
          <p className="hint">Drops teenybase metadata + every user table. Admin state (Files + Config) is preserved.</p>
          <div className="actions">
            <button className="btn danger" onClick={doClear} disabled={busy === "clear"}>
              {busy === "clear" ? "Clearing…" : "Clear DB"}
            </button>
          </div>
        </section>
      </main>

      <Confirm
        open={!!confirmOpen}
        title={confirmOpen?.title || ""}
        body={confirmOpen ? <pre>{confirmOpen.body}</pre> : null}
        destructive={confirmOpen?.destructive || false}
        confirmLabel="Confirm & execute"
        onConfirm={() => confirmOpen?.run()}
        onCancel={() => setConfirmOpen(null)}
      />
    </>
  )
}
