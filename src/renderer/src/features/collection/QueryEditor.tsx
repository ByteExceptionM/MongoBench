import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { cn } from '@/lib/utils'
import type { CompletionBinding } from '@/lib/completion/monacoAdapter'
import { useCompletionAttachment } from '@/lib/completion/useCompletionAttachment'
import { BASE_EDITOR_OPTIONS } from '@/lib/monacoSetup'
import { queryModelTabId } from '@/lib/queryModelUri'
import { useTabsStore } from '@/store/tabs'

// @monaco-editor/react keys its unmount save by the editor's first path, wrong once path changes.
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState>()

function storeViewState(editor: monaco.editor.IStandaloneCodeEditor | null): void {
  const model = editor?.getModel()
  const state = editor?.saveViewState()
  if (model && state) viewStates.set(model.uri.toString(), state)
}

// Query models outlive editor instances (keepCurrentModel) and end with their tab.
useTabsStore.subscribe((state, prev) => {
  if (state.tabs === prev.tabs) return
  const openIds = new Set(state.tabs.map((t) => t.id))
  for (const model of monaco.editor.getModels()) {
    const tabId = queryModelTabId(model.uri)
    if (tabId === null || openIds.has(tabId)) continue
    viewStates.delete(model.uri.toString())
    model.dispose()
  }
})

type Props = {
  /** Monaco model path (see queryModelUri); one model per tab and slot, disposed with the tab. */
  modelPath: string
  /** Editor kind and environment for completion; read on every request. */
  completion: CompletionBinding
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
 * MongoDB query editor.
 *
 * Wraps Monaco with: mongo-shell syntax highlighting, bracket auto-pairing,
 * format-on-paste, schema-aware MongoDB completion (bound per editor via
 * `attachCompletion`), and a destructive-coloured border when
 * the value doesn't parse.
 */
export function QueryEditor({
  modelPath,
  completion,
  value,
  onChange,
  onSubmit,
  hasError,
  placeholder,
  minHeight = 30,
  maxHeight = 140,
  actions,
  autoFocus,
  onFormat,
  onContentHeightChange
}: Props) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const actionsRef = useRef<monaco.IDisposable[]>([])
  const bindCompletion = useCompletionAttachment(completion)
  const submitRef = useRef(onSubmit)
  const formatRef = useRef(onFormat)
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
  // Editor disposal does not release addAction registrations.
  useEffect(() => () => actionsRef.current.forEach((d) => d.dispose()), [])
  // Layout cleanup runs before the library's passive effects swap the model or dispose the editor.
  useLayoutEffect(() => () => storeViewState(editorRef.current), [modelPath])

  const handleMount: OnMount = (editor, m) => {
    editorRef.current = editor

    const runKeybinding = m.KeyMod.CtrlCmd | m.KeyCode.Enter
    // addAction scopes the keybinding to this editor; addCommand binds it globally to the last one.
    const runAction = editor.addAction({
      id: 'mongobench.run',
      label: 'Run query',
      keybindings: [runKeybinding],
      run: () => submitRef.current()
    })
    // Keybindings dispatch from the container after this listener; a held key must not run again.
    editor.onKeyDown((e) => {
      if (!e.browserEvent.repeat || !e.equals(runKeybinding)) return
      e.preventDefault()
      e.stopPropagation()
    })
    const formatAction = editor.addAction({
      id: 'mongobench.format',
      label: 'Format',
      keybindings: [m.KeyMod.Shift | m.KeyMod.Alt | m.KeyCode.KeyF],
      run: () => {
        if (formatRef.current) {
          formatRef.current()
        } else {
          void editor.getAction('editor.action.formatDocument')?.run()
        }
      }
    })
    actionsRef.current = [runAction, formatAction]
    bindCompletion(editor)

    const restoreViewState = () => {
      const model = editor.getModel()
      const state = model ? viewStates.get(model.uri.toString()) : undefined
      if (state) editor.restoreViewState(state)
    }
    editor.onDidChangeModel(restoreViewState)
    restoreViewState()

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
        path={modelPath}
        keepCurrentModel
        saveViewState={false}
        value={value}
        onMount={handleMount}
        onChange={(v) => onChange(v ?? '')}
        loading={<div className="px-3 py-1.5 text-xs text-muted-foreground">Loading editor…</div>}
        options={{
          ...BASE_EDITOR_OPTIONS,
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
          tabCompletion: 'on',
          suggest: { ...BASE_EDITOR_OPTIONS.suggest, snippetsPreventQuickSuggestions: false },
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
