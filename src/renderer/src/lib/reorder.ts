/** `ids` with `dragId` moved before / after `overId`; null when the order would not change. */
export function reorderIds(
  ids: readonly string[],
  dragId: string,
  overId: string,
  pos: 'before' | 'after'
): string[] | null {
  const fromIdx = ids.indexOf(dragId)
  const overIdx = ids.indexOf(overId)
  if (fromIdx < 0 || overIdx < 0 || fromIdx === overIdx) return null
  // Taking the dragged id out shifts every later index down by one.
  const target = fromIdx < overIdx ? overIdx - 1 : overIdx
  const insertAt = pos === 'after' ? target + 1 : target
  if (insertAt === fromIdx) return null
  const next = ids.filter((id) => id !== dragId)
  next.splice(insertAt, 0, dragId)
  return next
}
