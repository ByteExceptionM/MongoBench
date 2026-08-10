/** Update-flow payloads shared between main and renderer. */

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
