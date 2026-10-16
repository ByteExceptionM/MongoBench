import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OnMount } from '@monaco-editor/react'
import type { CompletionEnv } from '@/lib/completion/useCompletionEnv'
import { QueryEditor } from './QueryEditor'

const editorProps = vi.hoisted(() => ({ onMount: null as unknown }))

vi.mock('monaco-editor', () => ({}))
vi.mock('@monaco-editor/react', () => ({
  default: (props: { onMount: unknown }) => {
    editorProps.onMount = props.onMount
    return null
  }
}))
vi.mock('@/lib/completion/monacoAdapter', () => ({
  attachCompletion: () => ({ dispose: () => undefined })
}))
// The real module boots Monaco's workers and languages as a side effect.
vi.mock('@/lib/monacoSetup', () => ({ BASE_EDITOR_OPTIONS: {} }))

const KeyMod = { CtrlCmd: 2048, Shift: 1024, Alt: 512 }
const KeyCode = { Enter: 3, KeyF: 36 }
const CTRL_ENTER = KeyMod.CtrlCmd | KeyCode.Enter

type KeyEvent = {
  browserEvent: { repeat: boolean }
  equals: (keybinding: number) => boolean
  preventDefault: () => void
  stopPropagation: () => void
}

/** Mounts the editor on a fake Monaco; the returned `press` reports whether the editor stopped the key. */
function mountEditor(onSubmit: () => void): (keybinding: number, repeat: boolean) => boolean {
  renderToStaticMarkup(
    <QueryEditor
      modelPath="mongobench://query/t1/shell"
      completion={{ kind: 'shell', env: {} as CompletionEnv }}
      value=""
      onChange={() => undefined}
      onSubmit={onSubmit}
    />
  )
  const disposable = { dispose: () => undefined }
  const keyListeners: ((event: KeyEvent) => void)[] = []
  const actions = new Map<number, () => void>()
  const editor = {
    addAction: ({ keybindings, run }: { keybindings: number[]; run: () => void }) => {
      for (const keybinding of keybindings) actions.set(keybinding, run)
      return disposable
    },
    onKeyDown: (listener: (event: KeyEvent) => void) => {
      keyListeners.push(listener)
      return disposable
    },
    getModel: () => null,
    onDidChangeModel: () => disposable,
    onDidContentSizeChange: () => disposable,
    getContentHeight: () => 18
  }
  ;(editorProps.onMount as OnMount)(editor as never, { KeyMod, KeyCode } as never)
  return (keybinding, repeat) => {
    let stopped = false
    const event: KeyEvent = {
      browserEvent: { repeat },
      equals: (other) => other === keybinding,
      preventDefault: () => undefined,
      stopPropagation: () => (stopped = true)
    }
    for (const listener of keyListeners) listener(event)
    // Monaco dispatches keybindings from the editor's container, which a stopped event never reaches.
    if (!stopped) actions.get(keybinding)?.()
    return stopped
  }
}

describe('QueryEditor Run keybinding', () => {
  it('runs once per press of Ctrl/Cmd+Enter, not on the key repeats of holding it', () => {
    const onSubmit = vi.fn()
    const press = mountEditor(onSubmit)
    press(CTRL_ENTER, false)
    press(CTRL_ENTER, true)
    press(CTRL_ENTER, true)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    press(CTRL_ENTER, false)
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('leaves the key repeats of other keys to the editor', () => {
    const press = mountEditor(vi.fn())
    expect(press(KeyCode.Enter, true)).toBe(false)
    expect(press(KeyMod.Shift | KeyCode.Enter, true)).toBe(false)
  })
})
