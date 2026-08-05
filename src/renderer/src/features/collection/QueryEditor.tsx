import { useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type * as monaco from 'monaco-editor'
import { cn } from '@/lib/utils'
import {
  clearEditorCompletionContext,
  setEditorCompletionContext,
  QUERY_COMPLETION_CONTEXT,
  type EditorCompletionContext
} from '@/lib/monacoCompletions'

type Props = {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  hasError?: boolean
  placeholder?: string
  /** Minimum visible editor height in px. Defaults to one line (~24). */
  minHeight?: number
  /** Maximum height before vertical scroll. Defaults to ~5 lines. */
  maxHeight?: number
  /** Render the Run / Format actions absolutely over the editor's right edge. */
  actions?: React.ReactNode
  autoFocus?: boolean
  completionContext?: EditorCompletionContext
  /**
   * Called when the user presses Shift+Alt+F. If provided, overrides
   * Monaco's built-in JSON formatter — useful because Monaco's JSON
   * formatter rejects MongoDB shell syntax (ObjectId(...) etc.).
   */
  onFormat?: () => void
  /**
   * Reports the editor's natural content height (pre-clamp) on every
   * change. Sister editors can use this to keep their heights in sync.
   */
  onContentHeightChange?: (px: number) => void
}

/**
 * MongoDB filter editor.
 *
 * Wraps Monaco with: JSON syntax highlighting, bracket auto-pairing,
 * format-on-paste, MongoDB IntelliSense scoped to `completionContext`,
 * and a destructive-coloured border when the value isn't valid JSON.
 */
export function QueryEditor({
  value,
  onChange,
  onSubmit,
  hasError,
  placeholder,
  minHeight = 30,
  maxHeight = 140,
  actions,
  autoFocus,
  completionContext = QUERY_COMPLETION_CONTEXT,
  onFormat,
  onContentHeightChange
}: Props) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelUriRef = useRef<string | null>(null)
  const submitRef = useRef(onSubmit)
  const formatRef = useRef(onFormat)
  const completionContextRef = useRef(completionContext)
  const minHeightRef = useRef(minHeight)
  const maxHeightRef = useRef(maxHeight)
  const onContentHeightChangeRef = useRef(onContentHeightChange)
  const [contentHeight, setContentHeight] = useState(minHeight)
  useEffect(() => {
    submitRef.current = onSubmit
  }, [onSubmit])
  useEffect(() => {
    formatRef.current = onFormat
  }, [onFormat])
  useEffect(() => {
    onContentHeightChangeRef.current = onContentHeightChange
  }, [onContentHeightChange])
  useEffect(() => {
    completionContextRef.current = completionContext
    const uri = modelUriRef.current
    if (uri) setEditorCompletionContext(uri, completionContext)
  }, [completionContext])
  useEffect(
    () => () => {
      const uri = modelUriRef.current
      if (uri) clearEditorCompletionContext(uri)
    },
    []
  )
  // Re-clamp the visible height when the bounds change from outside —
  // e.g. a sister editor pushed our `minHeight` up to keep both rows the
  // same height.
  useEffect(() => {
    minHeightRef.current = minHeight
    maxHeightRef.current = maxHeight
    const editor = editorRef.current
    if (!editor) return
    const ch = editor.getContentHeight()
    setContentHeight(Math.min(Math.max(ch, minHeight), maxHeight))
  }, [minHeight, maxHeight])

  const handleMount: OnMount = (editor, m) => {
    editorRef.current = editor

    const uri = editor.getModel()?.uri.toString() ?? null
    modelUriRef.current = uri
    if (uri) setEditorCompletionContext(uri, completionContextRef.current)

    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => submitRef.current())
    editor.addAction({
      id: 'mongobench.format',
      label: 'Format JSON',
      keybindings: [m.KeyMod.Shift | m.KeyMod.Alt | m.KeyCode.KeyF],
      run: () => {
        if (formatRef.current) {
          formatRef.current()
        } else {
          void editor.getAction('editor.action.formatDocument')?.run()
        }
      }
    })

    const sync = () => {
      const ch = editor.getContentHeight()
      const next = Math.min(Math.max(ch, minHeightRef.current), maxHeightRef.current)
      setContentHeight(next)
      onContentHeightChangeRef.current?.(ch)
    }
    editor.onDidContentSizeChange(sync)
    sync()

    if (autoFocus) editor.focus()
  }

  const isEmpty = value.length === 0

  return (
    <div
      className={cn(
        'group relative flex w-full items-stretch rounded-md border bg-background transition-colors focus-within:ring-1 focus-within:ring-ring/60',
        hasError
          ? 'border-destructive ring-1 ring-destructive/40 focus-within:ring-destructive/60'
          : 'border-input'
      )}
    >
      <Editor
        height={contentHeight}
        width="100%"
        language="mongo-shell"
        theme="mongobench-dark"
        value={value}
        onMount={handleMount}
        onChange={(v) => onChange(v ?? '')}
        loading={<div className="px-3 py-1.5 text-xs text-muted-foreground">Loading editor…</div>}
        options={{
          minimap: { enabled: false },
          lineNumbers: 'off',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 12,
          lineHeight: 18,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          wordWrap: 'on',
          padding: { top: 6, bottom: 6 },
          formatOnPaste: true,
          formatOnType: true,
          renderLineHighlight: 'none',
          folding: false,
          glyphMargin: false,
          lineDecorationsWidth: 6,
          lineNumbersMinChars: 0,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          overviewRulerBorder: false,
          scrollbar: {
            vertical: 'auto',
            horizontal: 'hidden',
            verticalScrollbarSize: 6,
            alwaysConsumeMouseWheel: false
          },
          quickSuggestions: { other: true, comments: false, strings: true },
          suggestOnTriggerCharacters: true,
          acceptSuggestionOnEnter: 'smart',
          tabCompletion: 'on',
          wordBasedSuggestions: 'off',
          autoClosingBrackets: 'always',
          autoClosingQuotes: 'always',
          autoSurround: 'languageDefined',
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true, indentation: false }
        }}
      />
      {isEmpty && placeholder && (
        <div className="pointer-events-none absolute inset-0 flex items-center px-3 font-mono text-xs text-muted-foreground/55">
          {placeholder}
        </div>
      )}
      {actions && (
        <div className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1">
          <div className="pointer-events-auto flex items-center gap-1">{actions}</div>
        </div>
      )}
    </div>
  )
}
