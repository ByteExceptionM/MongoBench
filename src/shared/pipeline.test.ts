import { describe, expect, it } from 'vitest'
import {
  finalWriteStage,
  findRejectedStage,
  rejectedStageMessage,
  UNSUPPORTED_STAGES,
  WRITE_STAGES,
  writePipelineError
} from './pipeline'

describe('WRITE_STAGES', () => {
  it('holds exactly the two stages that write', () => {
    expect([...WRITE_STAGES].sort()).toEqual(['$merge', '$out'])
  })
})

describe('UNSUPPORTED_STAGES', () => {
  it('holds $changeStream, which never returns a complete result', () => {
    expect([...UNSUPPORTED_STAGES]).toEqual(['$changeStream'])
  })
})

describe('findRejectedStage', () => {
  it('finds $out as the last stage', () => {
    expect(findRejectedStage([{ $match: { a: 1 } }, { $out: 'copy' }])).toBe('$out')
  })

  it('finds $merge as the last stage', () => {
    expect(findRejectedStage([{ $match: {} }, { $merge: { into: 'copy' } }])).toBe('$merge')
  })

  it('finds $changeStream as the first stage', () => {
    expect(findRejectedStage([{ $changeStream: {} }, { $match: {} }])).toBe('$changeStream')
  })

  it('finds a write stage at the first index', () => {
    expect(findRejectedStage([{ $out: 'copy' }, { $match: {} }])).toBe('$out')
  })

  it('returns the first rejected stage when there are several', () => {
    expect(findRejectedStage([{ $merge: { into: 'a' } }, { $out: 'b' }])).toBe('$merge')
    expect(findRejectedStage([{ $changeStream: {} }, { $out: 'b' }])).toBe('$changeStream')
  })

  it('finds a rejected operator in a stage object that has other keys too', () => {
    expect(findRejectedStage([{ $match: {}, $out: 'copy' }])).toBe('$out')
  })

  it('returns null for a read pipeline', () => {
    expect(
      findRejectedStage([
        { $match: { status: 'active' } },
        { $group: { _id: '$region', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 10 }
      ])
    ).toBeNull()
  })

  it('returns null for an empty pipeline', () => {
    expect(findRejectedStage([])).toBeNull()
  })

  it('ignores entries that are not stage objects', () => {
    expect(
      findRejectedStage([null, undefined, 1, '$out', ['$out'], [{ $changeStream: {} }]])
    ).toBeNull()
  })

  it('looks only at top-level stage operators', () => {
    // The server itself rejects $out / $merge inside $facet, $lookup and $unionWith pipelines.
    expect(
      findRejectedStage([
        { $facet: { copy: [{ $out: 'copy' }] } },
        { $lookup: { from: 'b', pipeline: [{ $merge: { into: 'c' } }], as: 'b' } },
        { $match: { $out: 1, $changeStream: 1 } }
      ])
    ).toBeNull()
  })
})

describe('rejectedStageMessage', () => {
  it.each(['$out', '$merge'])('says %s writes to the database', (stage) => {
    expect(rejectedStageMessage(stage)).toBe(
      `${stage} writes to the database; Aggregation mode only reads, run it in Shell mode`
    )
  })

  it('says $changeStream never ends', () => {
    expect(rejectedStageMessage('$changeStream')).toBe(
      '$changeStream never ends, so it cannot run here'
    )
  })
})

describe('finalWriteStage', () => {
  it.each([
    ['$out', [{ $match: {} }, { $out: 'copy' }]],
    ['$merge', [{ $merge: { into: 'copy' } }]]
  ])('finds %s ending the pipeline', (stage, stages) => {
    expect(finalWriteStage(stages)).toBe(stage)
  })

  it('returns null when the last stage reads', () => {
    expect(finalWriteStage([{ $out: 'copy' }, { $match: {} }])).toBeNull()
  })

  it('returns null for an empty pipeline', () => {
    expect(finalWriteStage([])).toBeNull()
  })

  it('returns null when the last entry is not a stage object', () => {
    expect(finalWriteStage([{ $match: {} }, '$out'])).toBeNull()
    expect(finalWriteStage([{ $match: {} }, [{ $out: 'copy' }]])).toBeNull()
    expect(finalWriteStage([{ $match: {} }, null])).toBeNull()
  })
})

describe('writePipelineError', () => {
  it('accepts read stages followed by the write stage', () => {
    expect(
      writePipelineError([{ $match: {} }, { $group: { _id: '$a' } }, { $out: 'copy' }])
    ).toBeNull()
  })

  it('accepts a pipeline that is only the write stage', () => {
    expect(writePipelineError([{ $merge: { into: 'copy' } }])).toBeNull()
  })

  it.each(['$out', '$merge'])(
    'says an earlier %s must be the last stage, naming its position',
    (stage) => {
      expect(writePipelineError([{ $match: {} }, { [stage]: 'a' }, { $out: 'copy' }])).toBe(
        `Stage 2: ${stage} must be the last stage`
      )
    }
  )

  it('rejects $changeStream before the write stage, naming its position', () => {
    expect(writePipelineError([{ $changeStream: {} }, { $out: 'copy' }])).toBe(
      `Stage 1: ${rejectedStageMessage('$changeStream')}`
    )
  })

  it('looks only at the stages before the last one', () => {
    expect(writePipelineError([{ $match: {} }, { $changeStream: {} }])).toBeNull()
  })
})
