import * as monaco from 'monaco-editor'
import {
  describeSymbol,
  resolveCompletions,
  resolveSignature,
  QUERY_COMPLETION_CONTEXT,
  type CompletionGroup,
  type CompletionItemData,
  type EditorCompletionContext,
  type SuggestionKind
} from './mongoCompletionModel'

export {
  QUERY_COMPLETION_CONTEXT,
  SORT_COMPLETION_CONTEXT,
  PROJECTION_COMPLETION_CONTEXT,
  PIPELINE_COMPLETION_CONTEXT,
  type EditorCompletionContext
} from './mongoCompletionModel'

const MONACO_KINDS: Record<SuggestionKind, monaco.languages.CompletionItemKind> = {
  operator: monaco.languages.CompletionItemKind.Function,
  stage: monaco.languages.CompletionItemKind.Module,
  expression: monaco.languages.CompletionItemKind.Function,
  update: monaco.languages.CompletionItemKind.Event,
  ejson: monaco.languages.CompletionItemKind.Value,
  value: monaco.languages.CompletionItemKind.Constant,
  field: monaco.languages.CompletionItemKind.Field,
  fieldPath: monaco.languages.CompletionItemKind.Variable,
  helper: monaco.languages.CompletionItemKind.Constructor,
  literal: monaco.languages.CompletionItemKind.Keyword,
  method: monaco.languages.CompletionItemKind.Method,
  collection: monaco.languages.CompletionItemKind.Class,
  database: monaco.languages.CompletionItemKind.Variable,
  command: monaco.languages.CompletionItemKind.Snippet
}

const RETRIGGER_COMMAND = { id: 'editor.action.triggerSuggest', title: 'Suggest' }

const contextByModel = new Map<string, EditorCompletionContext>()

let documentFieldNames: string[] = []
let providerRegistered = false

export function setDocumentFieldNames(names: Iterable<string>): void {
  documentFieldNames = Array.from(new Set(names)).sort((a, b) => a.localeCompare(b))
}

export function setEditorCompletionContext(uri: string, context: EditorCompletionContext): void {
  contextByModel.set(uri, context)
}

export function clearEditorCompletionContext(uri: string): void {
  contextByModel.delete(uri)
}

export function registerMongoLanguageProviders(): void {
  if (providerRegistered) return
  providerRegistered = true

  monaco.languages.registerCompletionItemProvider('mongo-shell', {
    triggerCharacters: ['$', '"', '.', '{', '[', '(', ',', ':', ' '],
    provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber)
      const groups = resolveCompletions({
        context: contextByModel.get(model.uri.toString()) ?? QUERY_COMPLETION_CONTEXT,
        textUpToCursor: textUpToCursor(model, position),
        lineUpToCursor: line.slice(0, position.column - 1),
        charAfterCursor: line.charAt(position.column - 1),
        fieldNames: documentFieldNames
      })
      return { suggestions: groups.flatMap((group) => toItems(group, position)) }
    }
  })

  monaco.languages.registerSignatureHelpProvider('mongo-shell', {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],
    provideSignatureHelp(model, position) {
      const info = resolveSignature(textUpToCursor(model, position))
      if (!info) return null
      return {
        value: {
          signatures: [
            {
              label: info.label,
              documentation: { value: info.doc },
              parameters: info.parameters.map((parameter) => ({
                label: parameter.label,
                documentation: { value: parameter.doc }
              }))
            }
          ],
          activeSignature: 0,
          activeParameter: info.activeParameter
        },
        dispose: () => undefined
      }
    }
  })

  monaco.languages.registerHoverProvider('mongo-shell', {
    provideHover(model, position) {
      const line = model.getLineContent(position.lineNumber)
      const token = tokenAt(line, position.column)
      if (!token) return null
      const description = describeSymbol(token.text)
      if (!description) return null
      const sections = description.entries.map((entry) => '_' + entry.detail + '_\n\n' + entry.doc)
      return {
        range: new monaco.Range(
          position.lineNumber,
          token.startColumn,
          position.lineNumber,
          token.endColumn
        ),
        contents: [{ value: '**' + description.label + '**' }, { value: sections.join('\n\n') }]
      }
    }
  })
}

function textUpToCursor(model: monaco.editor.ITextModel, position: monaco.Position): string {
  return model.getValueInRange({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column
  })
}

function tokenAt(
  line: string,
  column: number
): { text: string; startColumn: number; endColumn: number } | null {
  const pattern = /[$A-Za-z_][\w$]*/g
  const offset = column - 1
  let match = pattern.exec(line)
  while (match) {
    const start = match.index
    const end = start + match[0].length
    if (offset >= start && offset <= end) {
      return { text: match[0], startColumn: start + 1, endColumn: end + 1 }
    }
    match = pattern.exec(line)
  }
  return null
}

function toItems(
  group: CompletionGroup,
  position: monaco.Position
): monaco.languages.CompletionItem[] {
  const range = new monaco.Range(
    position.lineNumber,
    position.column - group.prefixLength,
    position.lineNumber,
    group.consumeTrailingQuote ? position.column + 1 : position.column
  )
  return group.items.map((item) => toItem(item, range))
}

function toItem(item: CompletionItemData, range: monaco.IRange): monaco.languages.CompletionItem {
  return {
    label: item.label,
    kind: MONACO_KINDS[item.kind],
    insertText: item.insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    filterText: item.filterText,
    documentation: { value: item.doc },
    detail: item.detail,
    sortText: item.sortText,
    range,
    ...(item.retrigger ? { command: RETRIGGER_COMMAND } : {})
  }
}
