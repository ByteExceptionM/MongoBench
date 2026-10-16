const SLOTS = ['filter', 'projection', 'sort', 'pipeline', 'shell'] as const

export type QueryEditorSlot = (typeof SLOTS)[number]

const isSlot = (value: string): value is QueryEditorSlot =>
  (SLOTS as readonly string[]).includes(value)

/** Model path of one query editor of a tab, passed to @monaco-editor/react `path`. */
export function queryModelUri(tabId: string, slot: QueryEditorSlot): string {
  // The tab id goes in the path because URIs print their authority lowercased.
  return `mongobench://query/${tabId}/${slot}`
}

/** Tab id of a query-editor model; null for any other model (e.g. the document editor's). */
export function queryModelTabId(uri: {
  scheme: string
  authority: string
  path: string
}): string | null {
  if (uri.scheme !== 'mongobench' || uri.authority !== 'query') return null
  const match = /^\/([^/]+)\/([a-z]+)$/.exec(uri.path)
  const tabId = match?.[1]
  const slot = match?.[2]
  return tabId !== undefined && slot !== undefined && isSlot(slot) ? tabId : null
}
