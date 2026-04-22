import type { ReactNode } from "react"

export function Confirm({
  open,
  title,
  body,
  destructive = false,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  body: ReactNode
  destructive?: boolean
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!open) return null
  return (
    <div className="modal-backdrop open" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
        </header>
        <div className="body">{body}</div>
        <footer>
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn${destructive ? " danger" : ""}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
