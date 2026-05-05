import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export type ChartPoint = { ts: number; value: number }

type Props = {
  points: ChartPoint[]
  color?: string
  height?: number
  /** Format the Y-axis tick labels and tooltip value. */
  formatY?: (v: number) => string
  /** Suffix shown after the y-tick value (e.g. " ms", "/s"). */
  unit?: string
  /** Optional fixed Y bounds (default: derived from data). */
  yMin?: number
  yMax?: number
  className?: string
  fillOpacity?: number
}

const PAD_LEFT = 44
const PAD_RIGHT = 12
const PAD_TOP = 8
const PAD_BOTTOM = 22

const defaultFormatY = (v: number): string =>
  v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v < 10 ? 1 : 0)

const formatTimeAgo = (ts: number): string => {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  return `${Math.round(min / 60)}h`
}

const formatTimeAt = (ts: number): string => {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Time-series chart with proper Y/X axes, gridlines and an interactive
 * hover crosshair. Uses a ResizeObserver to measure its container so the
 * SVG viewBox matches actual pixel dimensions — that keeps text at its
 * native size instead of getting stretched by `preserveAspectRatio="none"`.
 */
export function Chart({
  points,
  color = 'hsl(var(--primary))',
  height = 140,
  formatY = defaultFormatY,
  unit = '',
  yMin,
  yMax,
  className,
  fillOpacity = 0.15
}: Props) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(480)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    setWidth(Math.max(120, el.clientWidth))
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setWidth(Math.max(120, entry.contentRect.width))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const layout = useMemo(() => {
    if (points.length === 0) return null
    const min = yMin ?? Math.min(...points.map((p) => p.value), 0)
    const rawMax = yMax ?? Math.max(...points.map((p) => p.value), min + 1)
    const max = rawMax === min ? min + 1 : rawMax
    const plotW = width - PAD_LEFT - PAD_RIGHT
    const plotH = height - PAD_TOP - PAD_BOTTOM
    const xAt = (i: number): number => {
      if (points.length === 1) return PAD_LEFT + plotW / 2
      return PAD_LEFT + (i / (points.length - 1)) * plotW
    }
    const yAt = (v: number): number => PAD_TOP + plotH - ((v - min) / (max - min)) * plotH
    return { min, max, plotW, plotH, xAt, yAt }
  }, [points, height, width, yMin, yMax])

  if (!layout || points.length < 2) {
    return (
      <div
        ref={containerRef}
        className={cn('flex items-center justify-center text-xs text-muted-foreground', className)}
        style={{ height }}
      >
        collecting samples…
      </div>
    )
  }

  const { min, max, plotW, plotH, xAt, yAt } = layout

  // Y-axis ticks: 4 gridlines (top, 2/3, 1/3, bottom).
  const yTicks = [max, max - (max - min) / 3, min + (max - min) / 3, min]

  // X-axis labels: oldest (left), middle, newest (right).
  const firstTs = points[0]!.ts
  const midTs = points[Math.floor(points.length / 2)]!.ts

  // Build line + area paths.
  const linePts = points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(' ')
  const areaPts = `${PAD_LEFT},${PAD_TOP + plotH} ${linePts} ${(PAD_LEFT + plotW).toFixed(1)},${PAD_TOP + plotH}`

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    const localPx = ((e.clientX - rect.left) / rect.width) * width
    if (localPx < PAD_LEFT || localPx > PAD_LEFT + plotW) {
      setHoverIdx(null)
      return
    }
    const ratio = (localPx - PAD_LEFT) / plotW
    const idx = Math.round(ratio * (points.length - 1))
    setHoverIdx(Math.max(0, Math.min(points.length - 1, idx)))
  }

  const hoverPoint = hoverIdx !== null ? points[hoverIdx] : null

  return (
    <div ref={containerRef} className={cn('relative w-full', className)} style={{ height }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="block h-full w-full"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* Y gridlines */}
        {yTicks.map((v, i) => (
          <line
            key={`g${i}`}
            x1={PAD_LEFT}
            x2={PAD_LEFT + plotW}
            y1={yAt(v).toFixed(1)}
            y2={yAt(v).toFixed(1)}
            stroke="hsl(var(--border))"
            strokeOpacity={i === 3 ? 0.85 : 0.35}
            strokeDasharray={i === 3 ? '0' : '2 3'}
          />
        ))}

        {/* Y tick labels */}
        {yTicks.map((v, i) => (
          <text
            key={`t${i}`}
            x={PAD_LEFT - 6}
            y={yAt(v) + 3}
            textAnchor="end"
            className="fill-muted-foreground font-mono"
            style={{ fontSize: '9px' }}
          >
            {formatY(v)}
            {unit}
          </text>
        ))}

        {/* X tick labels */}
        <text
          x={PAD_LEFT}
          y={height - 6}
          textAnchor="start"
          className="fill-muted-foreground font-mono"
          style={{ fontSize: '9px' }}
        >
          {formatTimeAgo(firstTs)} ago
        </text>
        <text
          x={PAD_LEFT + plotW / 2}
          y={height - 6}
          textAnchor="middle"
          className="fill-muted-foreground font-mono"
          style={{ fontSize: '9px' }}
        >
          {formatTimeAgo(midTs)} ago
        </text>
        <text
          x={PAD_LEFT + plotW}
          y={height - 6}
          textAnchor="end"
          className="fill-muted-foreground font-mono"
          style={{ fontSize: '9px' }}
        >
          now
        </text>

        {/* Filled area + line */}
        <polygon points={areaPts} fill={color} fillOpacity={fillOpacity} />
        <polyline
          points={linePts}
          fill="none"
          stroke={color}
          strokeWidth={1.6}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Current-value dot */}
        <circle
          cx={xAt(points.length - 1).toFixed(1)}
          cy={yAt(points[points.length - 1]!.value).toFixed(1)}
          r={3}
          fill={color}
        />

        {/* Hover crosshair + tooltip */}
        {hoverPoint && hoverIdx !== null && (
          <>
            <line
              x1={xAt(hoverIdx).toFixed(1)}
              x2={xAt(hoverIdx).toFixed(1)}
              y1={PAD_TOP}
              y2={PAD_TOP + plotH}
              stroke="hsl(var(--foreground))"
              strokeOpacity={0.4}
              strokeDasharray="2 3"
            />
            <circle
              cx={xAt(hoverIdx).toFixed(1)}
              cy={yAt(hoverPoint.value).toFixed(1)}
              r={3.5}
              fill="hsl(var(--background))"
              stroke={color}
              strokeWidth={1.8}
            />
            <Tooltip
              x={xAt(hoverIdx)}
              plotWidth={plotW}
              plotLeft={PAD_LEFT}
              label={`${formatY(hoverPoint.value)}${unit}`}
              sub={formatTimeAt(hoverPoint.ts)}
            />
          </>
        )}
      </svg>
    </div>
  )
}

function Tooltip({
  x,
  plotWidth,
  plotLeft,
  label,
  sub
}: {
  x: number
  plotWidth: number
  plotLeft: number
  label: string
  sub: string
}) {
  const w = 70
  const h = 28
  let tx = x + 8
  if (tx + w > plotLeft + plotWidth) tx = x - 8 - w
  const ty = PAD_TOP + 4
  return (
    <g>
      <rect
        x={tx}
        y={ty}
        width={w}
        height={h}
        rx={3}
        fill="hsl(var(--popover))"
        stroke="hsl(var(--border))"
      />
      <text
        x={tx + 6}
        y={ty + 12}
        className="fill-foreground font-mono"
        style={{ fontSize: '10px', fontWeight: 600 }}
      >
        {label}
      </text>
      <text
        x={tx + 6}
        y={ty + 22}
        className="fill-muted-foreground font-mono"
        style={{ fontSize: '9px' }}
      >
        {sub}
      </text>
    </g>
  )
}
