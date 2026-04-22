import CodeMirror from "@uiw/react-codemirror"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"

export type Lang = "json" | "sql" | "javascript"

export function Editor({
  value,
  onChange,
  lang,
  minHeight = "280px",
  readOnly = false,
}: {
  value: string
  onChange: (v: string) => void
  lang: Lang
  minHeight?: string
  readOnly?: boolean
}) {
  const extensions =
    lang === "json"
      ? [json()]
      : lang === "javascript"
        ? [javascript({ jsx: false })]
        : [javascript({ typescript: false, jsx: false })] // sql → treat as js for now; syntax highlight is lenient
  return (
    <div className="editor-wrap">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        theme="dark"
        minHeight={minHeight}
        readOnly={readOnly}
        basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
      />
    </div>
  )
}
