import { describe, expect, it } from 'vitest'
import { checkPipeline, compilePipelineSource } from './aggregationPipeline'

describe('checkPipeline', () => {
  it('accepts an empty pipeline as document-preserving', () => {
    expect(checkPipeline([])).toEqual({ ok: true, ejson: '[]', documentPreserving: true })
  })

  it('rejects a value that is not an array', () => {
    expect(checkPipeline({ $match: {} })).toEqual({
      ok: false,
      error: 'Pipeline must be an array of stages, e.g. [{ $match: { … } }]'
    })
  })

  it('rejects a stage that is not an object', () => {
    expect(checkPipeline([{ $match: {} }, 5])).toEqual({
      ok: false,
      error: 'Stage 2 must be an object'
    })
    expect(checkPipeline([[]])).toEqual({ ok: false, error: 'Stage 1 must be an object' })
  })

  it('rejects a stage with zero or two operators', () => {
    expect(checkPipeline([{}])).toEqual({
      ok: false,
      error: 'Stage 1 must have exactly one operator'
    })
    expect(checkPipeline([{ $match: {}, $sort: { a: 1 } }])).toEqual({
      ok: false,
      error: 'Stage 1 must have exactly one operator'
    })
  })

  it('rejects a key that is not a stage operator', () => {
    expect(checkPipeline([{ $match: {} }, { match: {} }])).toEqual({
      ok: false,
      error: 'Stage 2: "match" is not a stage operator'
    })
  })

  it('rejects write stages with their position', () => {
    expect(checkPipeline([{ $match: {} }, { $out: 'copy' }])).toEqual({
      ok: false,
      error:
        'Stage 2: $out writes to the database; Aggregation mode only reads, run it in Shell mode'
    })
    expect(checkPipeline([{ $merge: { into: 'copy' } }])).toEqual({
      ok: false,
      error:
        'Stage 1: $merge writes to the database; Aggregation mode only reads, run it in Shell mode'
    })
  })

  it('rejects a change stream with its position', () => {
    expect(checkPipeline([{ $match: {} }, { $changeStream: {} }])).toEqual({
      ok: false,
      error: 'Stage 2: $changeStream never ends, so it cannot run here'
    })
  })

  it('marks $match / $sort / $skip / $limit pipelines as document-preserving', () => {
    for (const stage of [{ $match: { a: 1 } }, { $sort: { a: 1 } }, { $skip: 5 }, { $limit: 5 }]) {
      const r = checkPipeline([stage])
      expect(r.ok && r.documentPreserving, JSON.stringify(stage)).toBe(true)
    }
    const all = checkPipeline([{ $match: {} }, { $sort: { a: -1 } }, { $skip: 1 }, { $limit: 2 }])
    expect(all.ok && all.documentPreserving).toBe(true)
  })

  it('marks reshaping pipelines as not document-preserving', () => {
    for (const stage of [
      { $project: { a: 1 } },
      { $group: { _id: '$a' } },
      { $unwind: '$a' },
      { $lookup: { from: 'b', localField: 'a', foreignField: 'a', as: 'b' } },
      { $sample: { size: 1 } },
      { $addFields: { b: 1 } }
    ]) {
      const r = checkPipeline([{ $match: {} }, stage])
      expect(r.ok, JSON.stringify(stage)).toBe(true)
      if (r.ok) expect(r.documentPreserving, JSON.stringify(stage)).toBe(false)
    }
  })

  it('returns the pipeline as EJSON', () => {
    const r = checkPipeline([{ $match: { _id: { $oid: '507f1f77bcf86cd799439011' } } }])
    expect(r.ok && r.ejson).toBe('[{"$match":{"_id":{"$oid":"507f1f77bcf86cd799439011"}}}]')
  })
})

describe('checkPipeline with allowFinalWrite', () => {
  const allowFinalWrite = { allowFinalWrite: true }

  it('accepts a final $out or $merge', () => {
    expect(checkPipeline([{ $match: { a: 1 } }, { $out: 'copy' }], allowFinalWrite)).toEqual({
      ok: true,
      ejson: '[{"$match":{"a":1}},{"$out":"copy"}]',
      documentPreserving: false
    })
    expect(checkPipeline([{ $merge: { into: 'copy' } }], allowFinalWrite).ok).toBe(true)
  })

  it('still accepts read pipelines', () => {
    expect(checkPipeline([{ $match: {} }, { $limit: 5 }], allowFinalWrite)).toEqual({
      ok: true,
      ejson: '[{"$match":{}},{"$limit":5}]',
      documentPreserving: true
    })
  })

  it('rejects a write stage before the end with its position', () => {
    expect(checkPipeline([{ $out: 'copy' }, { $match: {} }], allowFinalWrite)).toEqual({
      ok: false,
      error: 'Stage 1: $out must be the last stage'
    })
    expect(
      checkPipeline([{ $match: {} }, { $merge: { into: 'a' } }, { $out: 'b' }], allowFinalWrite)
    ).toEqual({ ok: false, error: 'Stage 2: $merge must be the last stage' })
  })

  it('rejects a change stream anywhere', () => {
    expect(checkPipeline([{ $changeStream: {} }, { $out: 'copy' }], allowFinalWrite)).toEqual({
      ok: false,
      error: 'Stage 1: $changeStream never ends, so it cannot run here'
    })
    expect(checkPipeline([{ $match: {} }, { $changeStream: {} }], allowFinalWrite)).toEqual({
      ok: false,
      error: 'Stage 2: $changeStream never ends, so it cannot run here'
    })
  })

  it('applies the stage shape rules to the final write stage', () => {
    expect(checkPipeline([{ $out: 'copy', $match: {} }], allowFinalWrite)).toEqual({
      ok: false,
      error: 'Stage 1 must have exactly one operator'
    })
  })
})

describe('compilePipelineSource', () => {
  it('compiles shell syntax with helpers', () => {
    const r = compilePipelineSource('[{ $match: { _id: ObjectId("507f1f77bcf86cd799439011") } }]')
    expect(r).toEqual({
      ok: true,
      ejson: '[{"$match":{"_id":{"$oid":"507f1f77bcf86cd799439011"}}}]',
      documentPreserving: true
    })
  })

  it('reports syntax errors from the parser', () => {
    const r = compilePipelineSource('[{ $match: }]')
    expect(r.ok).toBe(false)
  })

  it('reports a non-array source', () => {
    expect(compilePipelineSource('{ $match: {} }')).toEqual({
      ok: false,
      error: 'Pipeline must be an array of stages, e.g. [{ $match: { … } }]'
    })
  })

  it('rejects $out written in shell syntax', () => {
    expect(compilePipelineSource("[{ $out: 'copy' }]")).toEqual({
      ok: false,
      error:
        'Stage 1: $out writes to the database; Aggregation mode only reads, run it in Shell mode'
    })
  })
})
