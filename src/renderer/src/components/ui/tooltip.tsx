import { cloneElement, useEffect, useRef, useState, type ReactElement, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

type Side = 'top' | 'bottom'

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
 * rect; the tooltip itself is rendered into a portal at `document.body`
 * to escape the parent's overflow clipping (relevant for the document
 * table's scroll container).
 */
export function Tooltip({ content, children, delay = 350, side = 'top', disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState<{ top: number; left: number; placement: Side }>({
    top: 0,
    left: 0,
    placement: side
  })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

  const measure = (): void => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const gap = 8
    let placement: Side = side
    let top = placement === 'top' ? rect.top - gap : rect.bottom + gap
    if (placement === 'top' && top < 28) {
      placement = 'bottom'
      top = rect.bottom + gap
    } else if (placement === 'bottom' && top > window.innerHeight - 28) {
      placement = 'top'
      top = rect.top - gap
    }
    const left = Math.min(Math.max(rect.left + rect.width / 2, 16), window.innerWidth - 16)
    setBox({ top, left, placement })
  }

  const show = (): void => {
    if (disabled) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      measure()
      setOpen(true)
    }, delay)
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
            role="tooltip"
            className={cn(
              'pointer-events-none fixed z-[200] max-w-sm rounded-md border border-border bg-popover px-2 py-1 text-xs leading-snug text-popover-foreground shadow-lg',
              'animate-in fade-in-0 zoom-in-95 duration-100'
            )}
            style={{
              top: box.top,
              left: box.left,
              transform: box.placement === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)'
            }}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  )
}
