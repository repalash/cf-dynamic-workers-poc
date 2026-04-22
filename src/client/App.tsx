// Single-page admin UI — dark cf-ui-sample design system. Panels:
//   Status → Setup (conditional) → Sync (conditional) → Migrate (3 steps) →
//   User code (SSR user.js editor) → History → Danger.
import { useEffect, useMemo, useState } from "react"
import { api } from "./api"
import { Editor } from "./Editor"
import { Confirm } from "./Confirm"
import type {
  DiffChanges,
  GenerateResult,
  MigrationHistoryRow,
  StatusPayload,
} from "@shared/types"
import type { DatabaseSettings } from "teenybase"

function pretty(x: unknown) {
  return JSON.stringify(x, null, 2)
}
function joinSql(migs: { sql: string }[]) {
  return migs.map((m) => m.sql.trim()).join("\n\n")
}
function isEmptyOrCommentsOnly(sql: string) {
  const stripped = sql
    .replace(/--[^\n]*\n/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim()
  return stripped.length === 0
}
function looksDestructive(sql: string) {
  return /\b(DROP|TRUNCATE)\b/i.test(sql) || /\bDELETE\s+FROM\b(?![\s\S]{0,40}WHERE)/i.test(sql)
}
function pad5(n: number) {
  return String(n).padStart(5, "0")
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
        <div className="route"><span className="label">Auth</span><span className="tmpl">/api/v1/table/&#123;table&#125;/auth/[sign-up | login-password | refresh-token | ...]</span></div>
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
      {extraLogs.map((l, i) => (
        <div key={"l" + i} className="warn">{l}</div>
      ))}
      {empty ? (
        <div className="ok">No schema changes detected. Write data-only SQL below (backfill / seed) to run a data-only migration, or edit the config above.</div>
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
              {d.create.map((f) => (
                <div key={"cf" + f.name} className="diff-sub diff-add">+ field &quot;{f.name}&quot;{f.type ? ` (${f.type})` : ""}</div>
              ))}
              {d.drop.map((f) => (
                <div key={"df" + f.name} className="diff-sub diff-drop">- field &quot;{f.name}&quot;</div>
              ))}
              {d.alter.map(([a, b], j) => (
                <div key={"af" + j} className="diff-sub diff-mod">~ field &quot;{a.name}&quot;{a.name !== b.name ? ` (renamed from ${b.name})` : ""}</div>
              ))}
              {(d.indexes?.create ?? []).map((ix, j) => (
                <div key={"ic" + j} className="diff-sub diff-add">+ index {JSON.stringify(ix.fields)}</div>
              ))}
              {(d.indexes?.drop ?? []).map((ix, j) => (
                <div key={"id" + j} className="diff-sub diff-drop">- index {JSON.stringify(ix.fields)}</div>
              ))}
              {(d.triggers?.create ?? []).map((t, j) => (
                <div key={"tc" + j} className="diff-sub diff-add">+ trigger &quot;{t.name ?? ""}&quot;</div>
              ))}
              {(d.triggers?.drop ?? []).map((t, j) => (
                <div key={"td" + j} className="diff-sub diff-drop">- trigger &quot;{t.name ?? ""}&quot;</div>
              ))}
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
  const [configText, setConfigText] = useState<string>("")
  const [appliedConfig, setAppliedConfig] = useState<DatabaseSettings | null>(null)
  const [seedConfig, setSeedConfig] = useState<DatabaseSettings | null>(null)
  const [lastGen, setLastGen] = useState<GenerateResult | null>(null)
  const [sqlText, setSqlText] = useState<string>("")
  const [customName, setCustomName] = useState<string>("")
  const [userCodeText, setUserCodeText] = useState<string>("")
  const [userCodeSaved, setUserCodeSaved] = useState<string>("")
  const [userStarterCode, setUserStarterCode] = useState<string>("")
  const [workerCodeText, setWorkerCodeText] = useState<string>("")
  const [workerCodeSaved, setWorkerCodeSaved] = useState<string>("")
  const [workerStarterCode, setWorkerStarterCode] = useState<string>("")
  const [codeTab, setCodeTab] = useState<"worker.js" | "user.js">("worker.js")
  const [history, setHistory] = useState<MigrationHistoryRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string>("")
  const [note, setNote] = useState<string>("")
  const [confirmOpen, setConfirmOpen] = useState<{
    run: () => void
    title: string
    body: string
    destructive: boolean
  } | null>(null)

  async function loadAll() {
    try {
      setErr(null)
      const [s, c] = await Promise.all([api.status(), api.config()])
      setStatus(s)
      setAppliedConfig(s.applied)
      if (c.config && !seedConfig) {
        setSeedConfig(c.config)
        setConfigText(pretty(c.config))
      } else if (!c.config && !seedConfig) {
        // no seed yet — leave editor empty; will populate after Setup.
      }
      // Code seeds — if saved, use saved; else use starter. Track both so we
      // can offer "Reset to starter". On first load, the server returns
      // starter content when nothing's saved, so we cache it as the reference.
      if (!userCodeText) setUserCodeText(c.userCode)
      setUserCodeSaved(c.userCode)
      if (!userStarterCode) setUserStarterCode(c.userCode)
      if (!workerCodeText) setWorkerCodeText(c.workerCode)
      setWorkerCodeSaved(c.workerCode)
      if (!workerStarterCode) setWorkerStarterCode(c.workerCode)
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
  const canApply =
    !!lastGen &&
    (lastGen.migrations.length > 0 || !isEmptyOrCommentsOnly(sqlText)) &&
    !isEmptyOrCommentsOnly(sqlText)
  const userCodeDirty = userCodeText !== userCodeSaved
  const workerCodeDirty = workerCodeText !== workerCodeSaved

  async function doSetup() {
    setBusy("setup")
    setErr(null)
    try {
      await api.setup()
      setSeedConfig(null) // re-seed editor from state
      await loadAll()
      const r = await api.history()
      setHistory(r.rows)
      setNote("Metadata tables created. Edit the config below and run Generate preview → Apply.")
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy("")
    }
  }

  async function doGenerate() {
    setBusy("generate")
    setErr(null)
    setNote("")
    let parsed: DatabaseSettings
    try {
      parsed = JSON.parse(configText)
    } catch (e: any) {
      setErr("Invalid JSON: " + e.message)
      setBusy("")
      return
    }
    try {
      const g = await api.generate(parsed)
      setLastGen(g)
      setAppliedConfig(g.applied)
      const seed = joinSql(g.migrations) || "-- No schema changes. Write data-only SQL (backfill / seed) here."
      setSqlText(seed)
      setCustomName("")
    } catch (e: any) {
      setErr(e.details ? `${e.message}: ${JSON.stringify(e.details, null, 2)}` : e.message)
    } finally {
      setBusy("")
    }
  }

  function resetConfig() {
    if (appliedConfig) setConfigText(pretty(appliedConfig))
    else if (seedConfig) setConfigText(pretty(seedConfig))
  }
  function resetSql() {
    setSqlText(autoSql || "-- No schema changes.")
  }

  async function doApply() {
    if (!lastGen) return
    let parsed: DatabaseSettings
    try {
      parsed = JSON.parse(configText)
    } catch (e: any) {
      setErr("Invalid JSON: " + e.message)
      return
    }
    const baselineVersion = lastGen.version
    const currentSql = sqlText.trim()
    if (!sqlEdited) {
      const destructive = looksDestructive(autoSql)
      setConfirmOpen({
        title: `Apply ${lastGen.migrations.length} migration${lastGen.migrations.length === 1 ? "" : "s"} to D1`,
        body:
          (destructive ? "⚠ Destructive operations (DROP / TRUNCATE). Data loss possible.\n\n" : "") +
          lastGen.migrations.map((m) => `-- ${m.name}\n${m.sql.trim()}`).join("\n\n"),
        destructive,
        run: async () => {
          setConfirmOpen(null)
          setBusy("apply")
          setErr(null)
          try {
            await api.apply({ config: parsed, baselineVersion })
            await loadAll()
            setLastGen(null)
            setSqlText("")
            setCustomName("")
            const h = await api.history()
            setHistory(h.rows)
            setNote(`Applied. $settings stamped.`)
            setBusy("")
          } catch (e: any) {
            setErr(e.stack ? `${e.message}\n\n${e.stack}` : e.message)
            setBusy("")
          }
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
      body:
        (destructive ? "⚠ Destructive operations (DROP / TRUNCATE). Data loss possible.\n\n" : "") +
        `-- ${fullCustomName}\n${currentSql}`,
      destructive,
      run: async () => {
        setConfirmOpen(null)
        setBusy("apply")
        setErr(null)
        try {
          await api.apply({
            config: parsed,
            customSql: currentSql,
            customName: fullCustomName,
            baselineVersion,
          })
          await loadAll()
          setLastGen(null)
          setSqlText("")
          setCustomName("")
          const h = await api.history()
          setHistory(h.rows)
          setNote("Applied custom migration.")
          setBusy("")
        } catch (e: any) {
          setErr(e.stack ? `${e.message}\n\n${e.stack}` : e.message)
          setBusy("")
        }
      },
    })
  }

  async function doSaveUserCode() {
    setBusy("save-user-code")
    setErr(null)
    try {
      await api.saveUserCode(userCodeText)
      setUserCodeSaved(userCodeText)
      setNote("user.js saved. Next request picks up the new code.")
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy("")
    }
  }
  async function doSaveWorkerCode() {
    setBusy("save-worker-code")
    setErr(null)
    try {
      await api.saveWorkerCode(workerCodeText)
      setWorkerCodeSaved(workerCodeText)
      setNote("worker.js saved. Next request picks up the new code.")
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy("")
    }
  }

  function resetUserCode() {
    setUserCodeText(userStarterCode || userCodeSaved)
  }
  function resetWorkerCode() {
    setWorkerCodeText(workerStarterCode || workerCodeSaved)
  }

  async function doSyncFromD1() {
    setBusy("sync")
    setErr(null)
    try {
      await api.syncFromD1()
      setSeedConfig(null)
      await loadAll()
      setNote("Admin config synced from D1.")
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy("")
    }
  }

  async function doClear() {
    setConfirmOpen({
      title: "Clear DB",
      body:
        "Drops teenybase metadata (_ddb_internal_kv, _db_migrations) + every user table. " +
        "Admin state (the Config + Code editors below) is preserved. After clear, re-run Setup + Apply.",
      destructive: true,
      run: async () => {
        setConfirmOpen(null)
        setBusy("clear")
        setErr(null)
        try {
          await api.clear()
          await loadAll()
          setLastGen(null)
          setSqlText("")
          setCustomName("")
          setHistory([])
          setNote("Cleared.")
        } catch (e: any) {
          setErr(e.message)
        } finally {
          setBusy("")
        }
      },
    })
  }

  const configMatch = status?.configMatch ?? "setup-required"
  const setupMissing = configMatch === "setup-required"
  const drifted = configMatch === "drifted"

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
            <p className="hint">Metadata tables are missing. Click <strong>Setup</strong> to create them. Idempotent.</p>
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
              The editor&apos;s config differs from <code>$settings</code> in D1. Apply your edits via step 3 below, or pull D1&apos;s applied config into the editor.
            </p>
            <div className="actions">
              <button className="btn ghost" onClick={doSyncFromD1} disabled={busy === "sync"}>
                {busy === "sync" ? "Syncing…" : "Sync editor from D1"}
              </button>
            </div>
          </section>
        )}

        <section className="panel migrate-panel">
          <h2>Migrate</h2>

          {/* Step 1 */}
          <div className={`step${setupMissing ? " pending" : ""}`}>
            <div className="step-header">
              <StepNum n={1} active={!setupMissing && !lastGen} />
              <span className="step-title">Edit config</span>
            </div>
            <p className="hint">Edit the config below. Click <strong>Generate preview</strong> to see the auto-generated migrations.</p>
            <Editor value={configText} onChange={setConfigText} lang="json" minHeight="360px" />
            <div className="actions">
              <button className="btn" onClick={doGenerate} disabled={busy === "generate" || setupMissing}>
                {busy === "generate" ? "Generating…" : "Generate preview"}
              </button>
              <button className="btn ghost" onClick={resetConfig}>
                Reset config
              </button>
            </div>
          </div>

          {/* Step 2 */}
          <div className={`step${lastGen ? "" : " pending"}`}>
            <div className="step-header">
              <StepNum n={2} active={!!lastGen && !sqlEdited} />
              <span className="step-title">Review generated SQL</span>
            </div>
            {lastGen ? <DiffOutput changes={lastGen.changes} extraLogs={lastGen.extraLogs} /> : null}
            {lastGen && (
              <>
                <label>SQL to apply (edit to override — becomes one custom migration)</label>
                <Editor value={sqlText} onChange={setSqlText} lang="sql" minHeight="220px" />
                <div className="actions">
                  <button className="btn ghost" onClick={resetSql}>
                    Reset to auto-generated
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Step 3 */}
          <div className={`step${lastGen ? "" : " pending"}`}>
            <div className="step-header">
              <StepNum n={3} active={!!lastGen && (sqlEdited || !isEmptyOrCommentsOnly(sqlText))} />
              <span className="step-title">Apply</span>
            </div>
            {lastGen && !sqlEdited && lastGen.migrations.length > 0 && (
              <>
                <label>Files to create in _db_migrations</label>
                <ul className="file-list">
                  {lastGen.migrations.map((m) => (
                    <li key={m.name}>{m.name}</li>
                  ))}
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

        {/* Code — tabbed editor for worker.js + user.js */}
        <section className="panel">
          <h2>Code</h2>
          <p className="hint">
            Modules loaded into the dynamic worker on every request. <code>worker.js</code> is the entry — imports from <strong>teenybase</strong> (bare), <strong>virtual:teenybase</strong> (generated config), and <strong>./user.js</strong>. <code>user.js</code> exports a Hono app mounted at <code>/</code>. Users can replace <code>worker.js</code> to skip teenyHono (e.g. plain <code>export default &#123;fetch()&#125;</code>).
          </p>
          <div className="tabs">
            <button
              className={`tab${codeTab === "worker.js" ? " active" : ""}`}
              onClick={() => setCodeTab("worker.js")}
            >
              worker.js{workerCodeDirty ? " •" : ""}
            </button>
            <button
              className={`tab${codeTab === "user.js" ? " active" : ""}`}
              onClick={() => setCodeTab("user.js")}
            >
              user.js{userCodeDirty ? " •" : ""}
            </button>
          </div>
          {codeTab === "worker.js" ? (
            <>
              <Editor value={workerCodeText} onChange={setWorkerCodeText} lang="javascript" minHeight="360px" />
              <div className="actions">
                <button
                  className="btn"
                  onClick={doSaveWorkerCode}
                  disabled={!workerCodeDirty || busy === "save-worker-code"}
                >
                  {busy === "save-worker-code" ? "Saving…" : "Save"}
                </button>
                <button className="btn ghost" onClick={resetWorkerCode}>
                  Reset to starter
                </button>
                {workerCodeDirty && <span className="status-msg">unsaved changes</span>}
              </div>
            </>
          ) : (
            <>
              <Editor value={userCodeText} onChange={setUserCodeText} lang="javascript" minHeight="360px" />
              <div className="actions">
                <button
                  className="btn"
                  onClick={doSaveUserCode}
                  disabled={!userCodeDirty || busy === "save-user-code"}
                >
                  {busy === "save-user-code" ? "Saving…" : "Save"}
                </button>
                <button className="btn ghost" onClick={resetUserCode}>
                  Reset to starter
                </button>
                {userCodeDirty && <span className="status-msg">unsaved changes</span>}
              </div>
            </>
          )}
        </section>

        {/* History */}
        <section className="panel">
          <h2>Migration history</h2>
          <div className="actions">
            <button
              className="btn ghost"
              onClick={() => api.history().then((r) => setHistory(r.rows)).catch((e) => setErr(e.message))}
            >
              Refresh
            </button>
          </div>
          {history.length === 0 ? (
            <div className="status-msg">No migrations recorded.</div>
          ) : (
            <table className="history-table">
              <thead>
                <tr><th>idx</th><th>name</th><th>applied</th></tr>
              </thead>
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

        {/* Danger */}
        <section className="panel danger">
          <h2>Danger zone</h2>
          <p className="hint">
            Drops teenybase metadata + every user table. Admin state (the Config + Code editors above) is preserved.
          </p>
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
        body={
          confirmOpen ? (
            <pre>{confirmOpen.body}</pre>
          ) : null
        }
        destructive={confirmOpen?.destructive || false}
        confirmLabel="Confirm & execute"
        onConfirm={() => confirmOpen?.run()}
        onCancel={() => setConfirmOpen(null)}
      />
    </>
  )
}
