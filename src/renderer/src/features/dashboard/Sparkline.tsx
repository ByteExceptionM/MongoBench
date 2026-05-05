import { useMemo } from 'react'
import { cn } from '@/lib/utils'

type Props = {
  values: number[]
  color?: string
  height?: number
  width?: number
  className?: string
  fillOpacity?: number
  yMin?: number
  yMax?: number
}

/**
 * Tiny inline SVG sparkline. Stretches to its container; the viewBox is
 * just an internal coordinate space. Renders a stroke + soft fill below
 * the line. Returns a placeholder when not enough samples have arrived.
 */
export function Sparkline({
  values,
  color = 'hsl(var(--primary))',
  height = 40,
  width = 200,
  className,
  fillOpacity = 0.12,
  yMin,
  yMax
}: Props) {
  const path = useMemo(() => {
    if (values.length < 2) return null
    const min = yMin ?? Math.min(...values)
    const max = yMax ?? Math.max(...values, min + 1)
    const range = Math.max(max - min, 1e-9)
    const stepX = width / (values.length - 1)
    const linePts: string[] = []
    for (let i = 0; i < values.length; i++) {
      const v = values[i] ?? min
      const x = i * stepX
      const y = height - ((v - min) / range) * height
      linePts.push(`${x.toFixed(2)},${y.toFixed(2)}`)
    }
    const line = linePts.join(' ')
    const area = `0,${height} ${line} ${width},${height}`
    return { line, area }
  }, [values, height, width, yMin, yMax])

  if (!path) {
    return (
      <div
        className={cn(
          'flex items-center justify-center text-[10px] text-muted-foreground',
          className
        )}
        style={{ height }}
      >
        collecting samples…
      </div>
    )
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn('h-full w-full', className)}
      preserveAspectRatio="none"
      style={{ height }}
    >
      <polygon points={path.area} fill={color} fillOpacity={fillOpacity} />
      <polyline
        points={path.line}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
