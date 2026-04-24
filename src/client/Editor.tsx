import CodeMirror from "@uiw/react-codemirror"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"

export type Lang = "json" | "sql" | "javascript"

// `sql` is intentionally handled by the JS grammar — CodeMirror's sql pack
// isn't pulled in to keep the bundle small; JS highlighting is lenient enough.
const EXTENSIONS: Record<Lang, () => any[]> = {
  json: () => [json()],
  javascript: () => [javascript({ jsx: false })],
  sql: () => [javascript({ typescript: false, jsx: false })],
}

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
  const extensions = EXTENSIONS[lang]()
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
