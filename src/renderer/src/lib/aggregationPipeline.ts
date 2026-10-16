import {
  finalWriteStage,
  findRejectedStage,
  rejectedStageMessage,
  writePipelineError
} from '@shared/pipeline'
import { isDocument } from '@shared/writeOps'
import { parseMongoQuery } from './mongoQueryLang'

/** A pipeline ready to send; `documentPreserving` means every output row is a whole stored document. */
export type CompiledPipeline = { ejson: string; documentPreserving: boolean }
export type PipelineCompileResult = ({ ok: true } & CompiledPipeline) | { ok: false; error: string }

const DOCUMENT_PRESERVING_STAGES: ReadonlySet<string> = new Set([
  '$match',
  '$sort',
  '$skip',
  '$limit'
])

/**
 * Validates a parsed pipeline: an array of single-operator stages that can all run here.
 * @param options.allowFinalWrite also accepts a pipeline ending in `$out` / `$merge` (Shell mode).
 */
export function checkPipeline(
  value: unknown,
  options: { allowFinalWrite?: boolean } = {}
): PipelineCompileResult {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'Pipeline must be an array of stages, e.g. [{ $match: { … } }]' }
  }
  const allowFinalWrite = options.allowFinalWrite === true
  const writeIndex = allowFinalWrite && finalWriteStage(value) !== null ? value.length - 1 : -1
  let documentPreserving = true
  for (const [index, stage] of value.entries()) {
    const n = index + 1
    if (!isDocument(stage)) {
      return { ok: false, error: `Stage ${n} must be an object` }
    }
    const keys = Object.keys(stage)
    if (keys.length !== 1) return { ok: false, error: `Stage ${n} must have exactly one operator` }
    const operator = keys[0]!
    if (!operator.startsWith('$')) {
      return { ok: false, error: `Stage ${n}: "${operator}" is not a stage operator` }
    }
    const rejected = index === writeIndex ? null : findRejectedStage([stage])
    if (rejected !== null) {
      // Earlier stages passed, so writePipelineError describes this one unless it is the last.
      const error =
        (allowFinalWrite ? writePipelineError(value) : null) ??
        `Stage ${n}: ${rejectedStageMessage(rejected)}`
      return { ok: false, error }
    }
    if (!DOCUMENT_PRESERVING_STAGES.has(operator)) documentPreserving = false
  }
  return { ok: true, ejson: JSON.stringify(value), documentPreserving }
}

/** Compiles aggregation-mode source; callers handle blank input as "nothing to run". */
export function compilePipelineSource(source: string): PipelineCompileResult {
  const parsed = parseMongoQuery(source)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return checkPipeline(parsed.value)
}
