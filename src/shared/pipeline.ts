import { isDocument } from './writeOps'

/** Stage operators that write to the database; only a shell pipeline may end with one. */
export const WRITE_STAGES: ReadonlySet<string> = new Set(['$out', '$merge'])

/** Stage operators MongoBench cannot run: a change stream never returns a complete result. */
export const UNSUPPORTED_STAGES: ReadonlySet<string> = new Set(['$changeStream'])

/** First stage operator MongoBench refuses to run, or null when the pipeline can run. */
export function findRejectedStage(stages: readonly unknown[]): string | null {
  for (const stage of stages) {
    if (!isDocument(stage)) continue
    const key = Object.keys(stage).find((k) => WRITE_STAGES.has(k) || UNSUPPORTED_STAGES.has(k))
    if (key !== undefined) return key
  }
  return null
}

/** Why a stage reported by `findRejectedStage` cannot run. */
export function rejectedStageMessage(stage: string): string {
  return WRITE_STAGES.has(stage)
    ? `${stage} writes to the database; Aggregation mode only reads, run it in Shell mode`
    : `${stage} never ends, so it cannot run here`
}

/** The `$out` / `$merge` operator ending a pipeline that writes, or null when the last stage reads. */
export function finalWriteStage(stages: readonly unknown[]): string | null {
  const last = stages[stages.length - 1]
  if (!isDocument(last)) return null
  return Object.keys(last).find((k) => WRITE_STAGES.has(k)) ?? null
}

/**
 * Why a pipeline ending in `$out` / `$merge` cannot run, or null; earlier stages must all read.
 * @returns The reason, prefixed with the offending stage's position ("Stage 2: …").
 */
export function writePipelineError(stages: readonly unknown[]): string | null {
  for (const [index, stage] of stages.slice(0, -1).entries()) {
    const rejected = findRejectedStage([stage])
    if (rejected === null) continue
    const reason = WRITE_STAGES.has(rejected)
      ? `${rejected} must be the last stage`
      : rejectedStageMessage(rejected)
    return `Stage ${index + 1}: ${reason}`
  }
  return null
}
