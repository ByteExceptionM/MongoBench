/**
 * Payloads for the update flow plus the pushes main sends the renderer
 * outside of any request it made.
 */

export type UpdateSeverity = 'patch' | 'minor' | 'major'

export type UpdateCheckResult =
  | { available: false }
  | {
      available: true
      version: string
      currentVersion: string
      severity: UpdateSeverity
    }

/** Pushed on `updater:progress` while a download runs. */
export type UpdateProgress = {
  percent: number
}

/**
 * Pushed on `connections:dropped` when main tears a connection down on its
 * own — today only when its SSH tunnel dies. The renderer has already been
 * told the connection is live, so without this the sidebar would keep
 * claiming so until the next query happened to fail.
 */
export type ConnectionDropped = {
  connectionId: string
  reason: string
}
