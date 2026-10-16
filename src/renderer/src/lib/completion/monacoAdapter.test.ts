import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import { createSchemaBuilder } from '@shared/collectionSchema'
import type { CollectionSchema } from '@shared/types'
import { attachCompletion, registerMongoCompletion, type CompletionBinding } from './monacoAdapter'
import type { CompletionEnv } from './useCompletionEnv'

type Provider = Monaco.languages.CompletionItemProvider

const monacoState = vi.hoisted(() => ({
  registrations: [] as Array<{ language: string; provider: unknown }>,
  editors: [] as unknown[]
}))

vi.mock('monaco-editor', () => ({
  languages: {
    CompletionItemKind: {
      Method: 0,
      Function: 1,
      Constructor: 2,
      Field: 3,
      Variable: 4,
      Class: 5,
      Module: 8,
      Operator: 11,
      Value: 13,
      EnumMember: 16,
      Keyword: 17,
      TypeParameter: 24
    },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 },
    registerCompletionItemProvider: (language: string, provider: unknown) => {
      monacoState.registrations.push({ language, provider })
      return { dispose: () => undefined }
    }
  },
  editor: { getEditors: () => monacoState.editors }
}))

const schemaOf = (...docs: unknown[]): CollectionSchema => {
  const builder = createSchemaBuilder()
  for (const doc of docs) builder.add(doc)
  return builder.build()
}

const SCHEMAS: Record<string, CollectionSchema> = {
  users: schemaOf({ _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'ada' }),
  orders: schemaOf({ _id: { $oid: '507f1f77bcf86cd799439012' }, total: { $numberInt: '3' } })
}

/** Text model double with Monaco's 1-based line/column positions. */
function fakeModel(text: string) {
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
  return {
    getValue: () => text,
    getOffsetAt: (p: { lineNumber: number; column: number }) =>
      (lineStarts[p.lineNumber - 1] ?? 0) + p.column - 1,
    getPositionAt: (offset: number) => {
      let line = 0
      while (line + 1 < lineStarts.length && (lineStarts[line + 1] ?? 0) <= offset) line++
      return { lineNumber: line + 1, column: offset - (lineStarts[line] ?? 0) + 1 }
    }
  }
}

function fakeEditor(model: ReturnType<typeof fakeModel>) {
  const focusListeners = new Set<() => void>()
  const disposeListeners = new Set<() => void>()
  const actions = new Map<string, Monaco.editor.IActionDescriptor>()
  const editor = {
    getModel: () => model,
    onDidFocusEditorText: (fn: () => void) => {
      focusListeners.add(fn)
      return { dispose: () => focusListeners.delete(fn) }
    },
    onDidDispose: (fn: () => void) => {
      disposeListeners.add(fn)
      return { dispose: () => disposeListeners.delete(fn) }
    },
    addAction: (descriptor: Monaco.editor.IActionDescriptor) => {
      actions.set(descriptor.id, descriptor)
      return { dispose: () => actions.delete(descriptor.id) }
    },
    focus: () => focusListeners.forEach((fn) => fn()),
    dispose: () => disposeListeners.forEach((fn) => fn()),
    actions
  }
  monacoState.editors.push(editor)
  return editor
}

const asEditor = (e: ReturnType<typeof fakeEditor>) =>
  e as unknown as Monaco.editor.IStandaloneCodeEditor

function makeEnv(overrides: Partial<CompletionEnv> = {}): CompletionEnv {
  return {
    coll: 'users',
    collections: ['users', 'orders'],
    uuidEncoding: 'default',
    timezone: 'UTC',
    loadSchema: vi.fn(async (name: string) => SCHEMAS[name] ?? null),
    prefetchSchema: vi.fn(),
    refreshSchema: vi.fn(),
    ...overrides
  }
}

const INVOKE: Monaco.languages.CompletionContext = { triggerKind: 0 }
const char = (c: string): Monaco.languages.CompletionContext => ({
  triggerKind: 1,
  triggerCharacter: c
})

let provider: Provider

beforeEach(() => {
  monacoState.registrations.length = 0
  monacoState.editors.length = 0
  registerMongoCompletion()
  provider = monacoState.registrations[0]?.provider as Provider
})

afterEach(() => {
  vi.useRealTimers()
})

/** Completion list at the `|` marker of `marked` in an editor bound to `binding`. */
async function complete(
  marked: string,
  binding: CompletionBinding | null,
  options: {
    context?: Monaco.languages.CompletionContext
    cancelled?: () => boolean
  } = {}
): Promise<Monaco.languages.CompletionList> {
  const offset = marked.indexOf('|')
  const model = fakeModel(marked.slice(0, offset) + marked.slice(offset + 1))
  attachCompletion(asEditor(fakeEditor(model)), () => binding)
  const token = {
    get isCancellationRequested() {
      return options.cancelled?.() ?? false
    }
  }
  const list = await provider.provideCompletionItems(
    model as unknown as Monaco.editor.ITextModel,
    model.getPositionAt(offset) as Monaco.Position,
    options.context ?? INVOKE,
    token as Monaco.CancellationToken
  )
  if (!list) throw new Error('provider returned nothing')
  return list
}

const labelOf = (item: Monaco.languages.CompletionItem): string =>
  typeof item.label === 'string' ? item.label : item.label.label
const byLabel = (list: Monaco.languages.CompletionList, label: string) =>
  list.suggestions.find((s) => labelOf(s) === label)

describe('registerMongoCompletion', () => {
  it('registers one mongo-shell provider with the completion trigger characters', () => {
    expect(monacoState.registrations.map((r) => r.language)).toEqual(['mongo-shell'])
    expect(provider.triggerCharacters).toEqual(['"', "'", '$', ':', ' ', '.', '{', '['])
  })
})

describe('mongo-shell completion provider', () => {
  it('maps a snippet constructor with its range, rank and preselection', async () => {
    const env = makeEnv()
    const list = await complete('{\n  "_id":|\n}', { kind: 'filter', env })

    const ctor = list.suggestions.find((s) => s.preselect)
    expect(ctor).toMatchObject({
      label: { label: 'ObjectId("…")' },
      kind: 2,
      insertText: ' ObjectId("$0")',
      insertTextRules: 4,
      range: { startLineNumber: 2, startColumn: 9, endLineNumber: 2, endColumn: 9 }
    })
    expect(ctor?.sortText?.startsWith('a')).toBe(true)
    expect(list.incomplete).toBe(false)
    expect(env.loadSchema).toHaveBeenCalledWith('users')
  })

  it('inserts field keys as plain text and re-opens suggestions after them', async () => {
    const list = await complete('{ na| }', { kind: 'filter', env: makeEnv() })

    expect(byLabel(list, 'name')).toMatchObject({
      kind: 3,
      insertText: 'name: ',
      insertTextRules: undefined,
      filterText: 'name',
      command: { id: 'editor.action.triggerSuggest', title: 'Suggest' },
      range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 5 }
    })
    expect(byLabel(list, '$and')).toMatchObject({ kind: 11 })
  })

  it('applies trigger-character gating and treats incomplete re-requests as invokes', async () => {
    const binding: CompletionBinding = { kind: 'filter', env: makeEnv() }

    expect((await complete('{ na |', binding, { context: char(' ') })).suggestions).toEqual([])
    expect(
      (await complete('{ "_id": |', binding, { context: char(' ') })).suggestions.length
    ).toBeGreaterThan(0)
    expect(
      (await complete('{ na|', binding, { context: { triggerKind: 2 } })).suggestions.length
    ).toBeGreaterThan(0)
  })

  it("loads the schema of the command's collection in the shell editor", async () => {
    const env = makeEnv()
    const list = await complete('db.orders.find({ t| })', { kind: 'shell', env })

    expect(env.loadSchema).toHaveBeenCalledWith('orders')
    expect(byLabel(list, 'total')).toBeDefined()
    expect(byLabel(list, 'name')).toBeUndefined()
  })

  it('uses the shell parser rules for collection accessors and aggregate cursors', async () => {
    const env = makeEnv({ coll: 'my logs' })
    const root = await complete('|', { kind: 'shell', env })
    expect(root.suggestions.find((s) => s.preselect)?.insertText).toBe(
      'db.getCollection("my logs").find({ $0 })'
    )
    const cursor = await complete('db.users.aggregate([]).|', { kind: 'shell', env })
    expect(cursor.suggestions.map(labelOf)).toEqual(['toArray', 'pretty'])
  })

  it('answers without a slow schema and marks the list incomplete', async () => {
    vi.useFakeTimers()
    const env = makeEnv({ loadSchema: vi.fn(() => new Promise<null>(() => undefined)) })

    const pending = complete('{ na|', { kind: 'filter', env })
    await vi.advanceTimersByTimeAsync(300)
    const list = await pending

    expect(list.incomplete).toBe(true)
    expect(byLabel(list, 'name')).toBeUndefined()
    expect(byLabel(list, '$or')).toBeDefined()
  })

  it('returns nothing for a cancelled request, a dead position or a missing binding', async () => {
    const env = makeEnv()
    expect(
      (await complete('{ na|', { kind: 'filter', env }, { cancelled: () => true })).suggestions
    ).toEqual([])
    expect((await complete('{ a: 1 // na|', { kind: 'filter', env })).suggestions).toEqual([])
    expect((await complete('{ na|', null)).suggestions).toEqual([])
  })

  it('ignores models that no bound editor shows', async () => {
    const model = fakeModel('{ ')
    const list = await provider.provideCompletionItems(
      model as unknown as Monaco.editor.ITextModel,
      { lineNumber: 1, column: 3 } as Monaco.Position,
      INVOKE,
      { isCancellationRequested: false } as Monaco.CancellationToken
    )
    expect(list).toEqual({ suggestions: [] })
  })
})

describe('attachCompletion', () => {
  it('prefetches on focus and offers a refresh action', () => {
    const env = makeEnv()
    const editor = fakeEditor(fakeModel(''))
    attachCompletion(asEditor(editor), () => ({ kind: 'filter', env }))

    editor.focus()
    void editor.actions.get('mongobench.refreshSchema')?.run(asEditor(editor))

    expect(env.prefetchSchema).toHaveBeenCalledTimes(1)
    expect(env.refreshSchema).toHaveBeenCalledTimes(1)
  })

  it('unbinds the editor when disposed or when the editor is disposed', async () => {
    const env = makeEnv()
    const model = fakeModel('{ ')
    const request = () =>
      provider.provideCompletionItems(
        model as unknown as Monaco.editor.ITextModel,
        { lineNumber: 1, column: 3 } as Monaco.Position,
        INVOKE,
        { isCancellationRequested: false } as Monaco.CancellationToken
      ) as Promise<Monaco.languages.CompletionList>

    const first = fakeEditor(model)
    const attachment = attachCompletion(asEditor(first), () => ({ kind: 'filter', env }))
    expect((await request()).suggestions.length).toBeGreaterThan(0)
    attachment.dispose()
    expect((await request()).suggestions).toEqual([])
    expect(first.actions.size).toBe(0)
    first.focus()
    expect(env.prefetchSchema).not.toHaveBeenCalled()

    monacoState.editors.length = 0
    const second = fakeEditor(model)
    attachCompletion(asEditor(second), () => ({ kind: 'filter', env }))
    second.dispose()
    expect((await request()).suggestions).toEqual([])
    expect(second.actions.size).toBe(0)
  })
})
