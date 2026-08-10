import { toast } from 'sonner'
import type { ConnectResult } from '@shared/types'

/**
 * Warns the user when a tunnel just trusted an SSH host key MongoBench had
 * never seen before. Shared by every place that connects, so the notice cannot
 * be missed by taking a different route into a connection.
 */
export function notifyPinnedHostKey(result: ConnectResult): void {
  const pinned = result.pinnedHostKey
  if (pinned === undefined) return
  toast.warning(`New SSH host key pinned for ${pinned.host}`, {
    description: `Compare it against the server before trusting this tunnel: ${pinned.fingerprint}`,
    duration: 15_000
  })
}
