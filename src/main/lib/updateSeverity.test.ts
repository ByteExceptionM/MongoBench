import { describe, expect, it } from 'vitest'
import { updateSeverity } from './updateSeverity'

describe('updateSeverity', () => {
  it('classifies a patch bump', () => {
    expect(updateSeverity('1.3.0', '1.3.1')).toBe('patch')
  })

  it('classifies a minor bump', () => {
    expect(updateSeverity('1.3.1', '1.4.0')).toBe('minor')
  })

  it('classifies a major bump', () => {
    expect(updateSeverity('1.3.1', '2.0.0')).toBe('major')
  })

  it('reports the highest differing segment, not the lowest', () => {
    expect(updateSeverity('1.3.1', '2.4.9')).toBe('major')
    expect(updateSeverity('1.3.1', '1.9.9')).toBe('minor')
  })

  it('returns null when the versions are equal', () => {
    expect(updateSeverity('1.3.1', '1.3.1')).toBeNull()
  })

  it('returns null when the candidate is older', () => {
    expect(updateSeverity('1.3.1', '1.3.0')).toBeNull()
    expect(updateSeverity('2.0.0', '1.9.9')).toBeNull()
  })

  it('tolerates a leading v', () => {
    expect(updateSeverity('v1.3.0', 'v1.3.1')).toBe('patch')
  })

  it('ignores prerelease and build suffixes', () => {
    expect(updateSeverity('1.3.0-beta.1', '1.4.0')).toBe('minor')
    expect(updateSeverity('1.3.0', '1.3.1+build.7')).toBe('patch')
  })

  it('treats versions differing only by prerelease suffix as no change', () => {
    expect(updateSeverity('1.3.1-beta.1', '1.3.1')).toBeNull()
  })

  it('returns null for unparseable versions', () => {
    expect(updateSeverity('1.3', '1.4')).toBeNull()
    expect(updateSeverity('', '1.0.0')).toBeNull()
    expect(updateSeverity('1.0.0', 'not-a-version')).toBeNull()
    expect(updateSeverity('1.0.0', '1.0.x')).toBeNull()
  })

  it('does not treat leading zeroes as a bigger number', () => {
    expect(updateSeverity('1.3.9', '1.3.10')).toBe('patch')
  })
})
