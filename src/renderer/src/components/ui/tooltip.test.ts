import { describe, expect, it } from 'vitest'
import { placeTooltip } from './tooltip'

const viewport = { width: 1266, height: 763 }
// The Run button: 16 px from the right edge, 48 px from the top.
const runButton = { top: 48, bottom: 80, left: 1186, width: 64 }
// A three-line explanation at the max-w-sm cap.
const reason = { width: 384, height: 58 }

describe('placeTooltip', () => {
  it('stays above the trigger while it fits there', () => {
    const trigger = { top: 300, bottom: 330, left: 500, width: 100 }
    expect(placeTooltip(trigger, reason, viewport, 'top')).toEqual({ top: 234, left: 358 })
  })

  it('moves below the trigger when the tooltip is taller than the room above', () => {
    expect(placeTooltip(runButton, reason, viewport, 'top').top).toBe(88)
  })

  it('keeps a wide tooltip next to the right edge inside the window', () => {
    const { left } = placeTooltip(runButton, reason, viewport, 'top')
    expect(left).toBe(viewport.width - 8 - reason.width)
  })

  it('keeps it inside the left edge', () => {
    const trigger = { top: 300, bottom: 330, left: 0, width: 20 }
    expect(placeTooltip(trigger, reason, viewport, 'top').left).toBe(8)
  })

  it('moves above when there is no room below', () => {
    const trigger = { top: 720, bottom: 750, left: 500, width: 100 }
    expect(placeTooltip(trigger, reason, viewport, 'bottom').top).toBe(654)
  })
})
