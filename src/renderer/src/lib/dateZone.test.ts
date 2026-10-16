import { describe, expect, it } from 'vitest'
import { formatIsoInZone } from './dateZone'

describe('formatIsoInZone', () => {
  const zones = ['UTC', 'Europe/Berlin', 'America/New_York']
  const instants = [
    '0001-01-01T00:00:00.000Z',
    '1850-06-01T00:00:00.000Z',
    '1970-01-01T00:00:00.000Z',
    '2024-03-31T01:30:00.000Z',
    '9999-12-31T23:59:59.999Z'
  ]

  for (const zone of zones) {
    for (const instant of instants) {
      it(`reads back ${instant} rendered in ${zone} as the same instant`, () => {
        const d = new Date(instant)
        expect(new Date(formatIsoInZone(d, zone)).getTime()).toBe(d.getTime())
      })
    }
  }

  it('renders the zone offset for ordinary dates', () => {
    expect(formatIsoInZone(new Date('2024-01-01T00:00:00.000Z'), 'Europe/Berlin')).toBe(
      '2024-01-01T01:00:00.000+01:00'
    )
    expect(formatIsoInZone(new Date('2024-07-01T12:00:00.000Z'), 'America/New_York')).toBe(
      '2024-07-01T08:00:00.000-04:00'
    )
  })

  it('falls back to UTC for local-mean-time offsets and years outside 1000-9999', () => {
    expect(formatIsoInZone(new Date('1850-06-01T00:00:00.000Z'), 'Europe/Berlin')).toBe(
      '1850-06-01T00:00:00.000Z'
    )
    expect(formatIsoInZone(new Date('0999-06-01T00:00:00.000Z'), 'Etc/GMT-1')).toBe(
      '0999-06-01T00:00:00.000Z'
    )
    expect(formatIsoInZone(new Date('9999-12-31T23:59:59.999Z'), 'Europe/Berlin')).toBe(
      '9999-12-31T23:59:59.999Z'
    )
  })

  it('falls back to UTC for years before the common era', () => {
    const d = new Date('-001000-06-01T00:00:00.000Z')
    expect(formatIsoInZone(d, 'Etc/GMT-1')).toBe(d.toISOString())
  })
})
