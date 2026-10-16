import { hashKey, type QueryKey } from '@tanstack/react-query'
import { api } from './api'

type RunningRequest = { requestId: string; queryKey: QueryKey }

// React Query's own `signal` is not used: it aborts a query as soon as its last observer
// unmounts, which happens on every tab switch.
const running = new Map<string, RunningRequest>()

function abortServerOp(requestId: string): void {
  // The run may already have settled in main; an unknown id is a no-op there.
  void api.query.cancel({ requestId }).catch(() => undefined)
}

/** Runs `fn` with a fresh request id; a newer run of the same key aborts the older server op. */
export async function withRequestId<T>(
  queryKey: QueryKey,
  fn: (requestId: string) => Promise<T>
): Promise<T> {
  const hash = hashKey(queryKey)
  const previous = running.get(hash)
  if (previous) abortServerOp(previous.requestId)
  const entry: RunningRequest = { requestId: crypto.randomUUID(), queryKey }
  running.set(hash, entry)
  try {
    return await fn(entry.requestId)
  } finally {
    if (running.get(hash) === entry) running.delete(hash)
  }
}

/** Aborts the server-side ops of running queries whose key matches. */
export function cancelRequests(matches: (queryKey: QueryKey) => boolean): void {
  for (const [hash, entry] of running) {
    if (!matches(entry.queryKey)) continue
    running.delete(hash)
    abortServerOp(entry.requestId)
  }
}
