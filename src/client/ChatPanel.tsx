import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { useEffect, useRef, useState } from "react"

const transport = new DefaultChatTransport({
  api: "/_teeny/admin/api/chat",
  credentials: "include",
})

function ToolCallDisplay({ name, args, result }: { name: string; args: unknown; result?: unknown }) {
  const labels: Record<string, string> = {
    getStatus: "Checking status",
    getFiles: "Reading files",
    writeFile: "Writing file",
    deleteFile: "Deleting file",
    generateMigrations: "Generating migrations",
    deploy: "Deploying",
    getMigrationHistory: "Checking history",
  }
  const label = labels[name] || name
  const argStr = args && typeof args === "object" && "filename" in (args as any)
    ? `: ${(args as any).filename}`
    : ""

  return (
    <div className="chat-tool">
      <span className="chat-tool-label">{label}{argStr}</span>
      {result && (
        <pre className="chat-tool-result">
          {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  )
}

function MessageContent({ content }: { content: string }) {
  const parts = content.split(/(```[\s\S]*?```)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const lines = part.slice(3, -3).split("\n")
          const lang = lines[0]?.trim() || ""
          const code = (lang ? lines.slice(1) : lines).join("\n")
          return (
            <pre key={i} className="chat-code">
              <code>{code}</code>
            </pre>
          )
        }
        const inlineParts = part.split(/(`[^`]+`)/g)
        return (
          <span key={i}>
            {inlineParts.map((ip, j) =>
              ip.startsWith("`") && ip.endsWith("`") ? (
                <code key={j} className="chat-inline-code">{ip.slice(1, -1)}</code>
              ) : (
                <span key={j}>{ip}</span>
              )
            )}
          </span>
        )
      })}
    </>
  )
}

export function ChatPanel({ onFilesChanged }: { onFilesChanged?: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [input, setInput] = useState("")

  const { messages, sendMessage, setMessages, status, error } = useChat({
    transport,
    onFinish: () => {
      onFilesChanged?.()
    },
  })

  const isLoading = status === "submitted" || status === "streaming"

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function handleSend() {
    const text = input.trim()
    if (!text || isLoading) return
    setInput("")
    sendMessage({ text })
  }

  if (collapsed) {
    return (
      <button
        className="chat-expand-btn"
        onClick={() => setCollapsed(false)}
        title="Open AI chat"
      >
        AI
      </button>
    )
  }

  return (
    <aside className="chat-panel">
      <div className="chat-header">
        <h2>AI Assistant</h2>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            className="chat-header-btn"
            onClick={() => setMessages([])}
            title="Clear chat"
          >
            Clear
          </button>
          <button
            className="chat-header-btn"
            onClick={() => setCollapsed(true)}
            title="Collapse"
          >
            &times;
          </button>
        </div>
      </div>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            Ask me to edit your schema, add tables, modify your app, or deploy changes.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg chat-msg-${m.role}`}>
            <div className="chat-msg-role">{m.role === "user" ? "You" : "AI"}</div>
            <div className="chat-msg-body">
              {m.parts?.map((part: any, i: number) => {
                if (part.type === "text" && part.text) {
                  return <MessageContent key={i} content={part.text} />
                }
                // v5 UIMessage tool parts: type is "tool-<toolName>"
                if (typeof part.type === "string" && part.type.startsWith("tool-") && part.toolCallId) {
                  const toolName = part.type.slice(5) // strip "tool-" prefix
                  return (
                    <ToolCallDisplay
                      key={i}
                      name={toolName}
                      args={part.input}
                      result={
                        part.state === "output-available"
                          ? part.output
                          : undefined
                      }
                    />
                  )
                }
                return null
              })}
            </div>
          </div>
        ))}
        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="chat-loading">
            <span className="chat-dot" />
            <span className="chat-dot" />
            <span className="chat-dot" />
          </div>
        )}
        {error && (
          <div className="chat-error">
            {error.message || "Something went wrong"}
          </div>
        )}
      </div>

      <div className="chat-input-form">
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder="Ask me to edit files, add tables, deploy..."
          rows={2}
          disabled={isLoading}
        />
        <button
          type="button"
          className="chat-send-btn"
          onClick={handleSend}
          disabled={isLoading || !input.trim()}
        >
          {isLoading ? "..." : "Send"}
        </button>
      </div>
    </aside>
  )
}
