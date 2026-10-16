import * as monaco from 'monaco-editor'
import type { CollectionSchema } from '@shared/types'
import {
  SHELL_AGGREGATE_CURSOR_METHODS,
  SHELL_COLLECTION_METHODS,
  SHELL_CURSOR_METHODS,
  shellCollectionAccessor
} from '../shellParser'
import { analyzeContext, type EditorKind } from './context'
import { suggest, type Suggestion, type SuggestionKind, type SuggestTrigger } from './suggest'
import type { CompletionEnv } from './useCompletionEnv'

export type CompletionBinding = { kind: EditorKind; env: CompletionEnv }

// No `,` (quick suggestions already cover the next key), no `(` and no letters.
const TRIGGER_CHARACTERS = ['"', "'", '$', ':', ' ', '.', '{', '[']
// A cached or quick sample makes it into this request; a slower one into the next keystroke's.
const SCHEMA_WAIT_MS = 300

const Kind = monaco.languages.CompletionItemKind
const ITEM_KINDS: Record<SuggestionKind, monaco.languages.CompletionItemKind> = {
  field: Kind.Field,
  operator: Kind.Operator,
  stage: Kind.Module,
  expression: Kind.Function,
  accumulator: Kind.Function,
  constructor: Kind.Constructor,
  value: Kind.Value,
  literal: Kind.Keyword,
  enum: Kind.EnumMember,
  typeAlias: Kind.TypeParameter,
  collection: Kind.Class,
  method: Kind.Method,
  variable: Kind.Variable
}

const RETRIGGER: monaco.languages.Command = { id: 'editor.action.triggerSuggest', title: 'Suggest' }

// Keyed by editor, not model: query editors swap models per tab and slot.
const bindings = new WeakMap<monaco.editor.ICodeEditor, () => CompletionBinding | null>()

/** Registers the single `mongo-shell` completion provider; call once from monacoSetup. */
export function registerMongoCompletion(): void {
  monaco.languages.registerCompletionItemProvider('mongo-shell', {
    triggerCharacters: TRIGGER_CHARACTERS,
    provideCompletionItems
  })
}

/**
 * Binds completion to `editor` until disposed or the editor is disposed.
 * @param binding read on every request; null disables completion for the moment
 */
export function attachCompletion(
  editor: monaco.editor.IStandaloneCodeEditor,
  binding: () => CompletionBinding | null
): monaco.IDisposable {
  bindings.set(editor, binding)
  const disposables = [
    editor.onDidFocusEditorText(() => binding()?.env.prefetchSchema()),
    editor.addAction({
      id: 'mongobench.refreshSchema',
      label: 'Refresh Field Suggestions',
      contextMenuGroupId: 'navigation',
      run: () => binding()?.env.refreshSchema()
    })
  ]
  const dispose = (): void => {
    if (bindings.get(editor) === binding) bindings.delete(editor)
    for (const d of disposables.splice(0)) d.dispose()
  }
  disposables.push(editor.onDidDispose(dispose))
  return { dispose }
}

async function provideCompletionItems(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  context: monaco.languages.CompletionContext,
  token: monaco.CancellationToken
): Promise<monaco.languages.CompletionList> {
  const editor = monaco.editor.getEditors().find((e) => e.getModel() === model)
  const binding = editor ? bindings.get(editor)?.() : null
  if (!binding) return { suggestions: [] }
  const { kind, env } = binding
  const ctx = analyzeContext(model.getValue(), model.getOffsetAt(position), kind, env.coll)
  if (ctx.position.at === 'none') return { suggestions: [] }

  const { schemas, pending } = await loadSchemas(ctx.collections, env)
  if (token.isCancellationRequested) return { suggestions: [] }
  const result = suggest(
    ctx,
    {
      ...env,
      schemaOf: (name) => schemas.get(name) ?? null,
      now: new Date(),
      shellMethods: SHELL_COLLECTION_METHODS,
      cursorMethods: SHELL_CURSOR_METHODS,
      aggregateCursorMethods: SHELL_AGGREGATE_CURSOR_METHODS,
      collectionAccessor: shellCollectionAccessor
    },
    triggerOf(context)
  )
  const start = model.getPositionAt(result.range.start)
  const end = model.getPositionAt(result.range.end)
  const range: monaco.IRange = {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column
  }
  // Incomplete makes Monaco ask again on the next keystroke, when the schema may have arrived.
  return {
    suggestions: result.items.map((item) => toCompletionItem(item, range)),
    incomplete: pending
  }
}

const LOADING = Symbol('loading')

async function loadSchemas(
  names: readonly string[],
  env: CompletionEnv
): Promise<{ schemas: Map<string, CollectionSchema>; pending: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof LOADING>((resolve) => {
    timer = setTimeout(() => resolve(LOADING), SCHEMA_WAIT_MS)
  })
  const loaded = await Promise.all(
    names.map((name) => Promise.race([env.loadSchema(name), timeout]))
  )
  clearTimeout(timer)
  const schemas = new Map<string, CollectionSchema>()
  let pending = false
  loaded.forEach((schema, i) => {
    if (schema === LOADING) pending = true
    else if (schema) schemas.set(names[i] as string, schema)
  })
  return { schemas, pending }
}

function triggerOf(context: monaco.languages.CompletionContext): SuggestTrigger {
  // A re-request for an incomplete list continues what the user is typing, like an invoke.
  return context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter &&
    context.triggerCharacter !== undefined
    ? { kind: 'character', char: context.triggerCharacter }
    : { kind: 'invoke' }
}

function toCompletionItem(item: Suggestion, range: monaco.IRange): monaco.languages.CompletionItem {
  return {
    label: item.description ? { label: item.label, description: item.description } : item.label,
    kind: ITEM_KINDS[item.kind],
    insertText: item.insertText,
    insertTextRules: item.snippet
      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
      : undefined,
    filterText: item.filterText,
    sortText: item.sortText,
    preselect: item.preselect,
    documentation: item.documentation ? { value: item.documentation } : undefined,
    command: item.retrigger ? RETRIGGER : undefined,
    range
  }
}
