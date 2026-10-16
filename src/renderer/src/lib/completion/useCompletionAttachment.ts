import { useEffect, useRef } from 'react'
import type * as monaco from 'monaco-editor'
import { attachCompletion, type CompletionBinding } from './monacoAdapter'

/**
 * Binds completion to the editor mounted with the returned callback, until unmount or the next mount.
 * @param binding read on every request; null at mount leaves that editor without completion
 * @returns The editor's `onMount` (or a call from it).
 */
export function useCompletionAttachment(
  binding: CompletionBinding | null
): (editor: monaco.editor.IStandaloneCodeEditor) => void {
  const bindingRef = useRef(binding)
  const attachmentRef = useRef<monaco.IDisposable | null>(null)
  useEffect(() => {
    bindingRef.current = binding
  }, [binding])
  useEffect(() => () => attachmentRef.current?.dispose(), [])

  return (editor) => {
    attachmentRef.current?.dispose()
    attachmentRef.current =
      binding === null ? null : attachCompletion(editor, () => bindingRef.current)
  }
}
