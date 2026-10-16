import {
  cloneElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type Ref
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

type Side = 'top' | 'bottom'

type Box = { top: number; left: number }

const GAP = 8
const EDGE_MARGIN = 8

/**
 * Places a tooltip of `size` next to `trigger`, on the other side when `side` lacks room.
 * @returns Viewport coordinates of the tooltip's top-left corner, kept inside the window.
 */
export function placeTooltip(
  trigger: { top: number; bottom: number; left: number; width: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  side: Side
): Box {
  const above = trigger.top - GAP - size.height
  const below = trigger.bottom + GAP
  const fitsAbove = above >= EDGE_MARGIN
  const fitsBelow = below + size.height <= viewport.height - EDGE_MARGIN
  const top = side === 'top' ? (fitsAbove ? above : below) : fitsBelow ? below : above
  const centered = trigger.left + trigger.width / 2 - size.width / 2
  const left = Math.max(EDGE_MARGIN, Math.min(centered, viewport.width - EDGE_MARGIN - size.width))
  return { top, left }
}

type TriggerProps = {
  ref?: Ref<HTMLElement>
  onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void
  onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void
  onFocus?: (e: React.FocusEvent<HTMLElement>) => void
  onBlur?: (e: React.FocusEvent<HTMLElement>) => void
}

type Props = {
  content: React.ReactNode
  children: ReactElement<TriggerProps>
  /** Delay in ms before the tooltip appears. */
  delay?: number
  /** Preferred side. Auto-flips when there's no room. */
  side?: Side
  /** Disable the tooltip while still rendering the trigger. */
  disabled?: boolean
}

/**
 * Lightweight tooltip — shares the app's popover/border/text-foreground
 * tokens so it doesn't look like the OS-native yellow `title` bubble.
 *
 * Positions via fixed coordinates measured against the trigger's bounding
 * rect and its own rendered size; the tooltip itself is rendered into a
 * portal at `document.body` to escape the parent's overflow clipping
 * (relevant for the document table's scroll container).
 */
export function Tooltip({ content, children, delay = 350, side = 'top', disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState<Box>({ top: 0, left: 0 })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)

  // Placement needs the rendered size; a layout effect corrects it before the first paint.
  useLayoutEffect(() => {
    const trigger = triggerRef.current
    const tooltip = tooltipRef.current
    if (!open || !trigger || !tooltip) return
    const next = placeTooltip(
      trigger.getBoundingClientRect(),
      { width: tooltip.offsetWidth, height: tooltip.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      side
    )
    setBox((prev) => (prev.top === next.top && prev.left === next.left ? prev : next))
  }, [open, content, side])

  const show = (): void => {
    if (disabled) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setOpen(true), delay)
  }
  const hide = (): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setOpen(false)
  }

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )

  // Hide if the user scrolls / resizes the viewport — the rect we measured
  // would be stale otherwise.
  useEffect(() => {
    if (!open) return
    const onChange = (): void => hide()
    window.addEventListener('scroll', onChange, true)
    window.addEventListener('resize', onChange)
    return () => {
      window.removeEventListener('scroll', onChange, true)
      window.removeEventListener('resize', onChange)
    }
  }, [open])

  const setRef = (el: HTMLElement | null): void => {
    triggerRef.current = el
    const orig = (children as { ref?: Ref<HTMLElement> }).ref
    if (typeof orig === 'function') orig(el)
    else if (orig && typeof orig === 'object') {
      const refObj = orig as { current: HTMLElement | null }
      refObj.current = el
    }
  }

  const childProps = children.props as TriggerProps
  const wrapped = cloneElement(children, {
    ref: setRef,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      childProps.onMouseEnter?.(e)
      show()
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      childProps.onMouseLeave?.(e)
      hide()
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      childProps.onFocus?.(e)
      show()
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(e)
      hide()
    }
  } as TriggerProps)

  const visibleContent = content !== null && content !== undefined && content !== ''

  return (
    <>
      {wrapped}
      {open &&
        visibleContent &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            className={cn(
              // w-max: a fixed box otherwise shrinks to the room right of `left` near the edge.
              'pointer-events-none fixed z-[200] w-max max-w-sm rounded-md border border-border bg-popover px-2 py-1 text-xs leading-snug text-popover-foreground shadow-lg',
              'animate-in fade-in-0 zoom-in-95 duration-100'
            )}
            style={{ top: box.top, left: box.left }}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  )
}
