import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  Clock,
  Cpu,
  Database,
  FileEdit,
  FileMinus2,
  FilePlus2,
  Files,
  Gauge,
  HardDrive,
  Heart,
  Info,
  Layers,
  Loader2,
  MousePointer,
  Network,
  Plug,
  RefreshCw,
  Server,
  ServerCrash,
  Timer,
  Zap
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Sparkline } from '@/features/dashboard/Sparkline'
import { Chart, type ChartPoint } from '@/features/dashboard/Chart'
import { api, ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'
import { cn } from '@/lib/utils'
import { useServerStatsHistory, type StatsSample } from '@/store/serverStatsHistory'
import type { ConnectionConfig, ServerStats } from '@shared/types'

type Series = {
  /** Total ops/sec across all opcounters. */
  opsPerSec: ChartPoint[]
  /** Ops/sec broken out per opcounter family (all six). */
  opsPerSecByKind: {
    query: ChartPoint[]
    insert: ChartPoint[]
    update: ChartPoint[]
    delete: ChartPoint[]
    getmore: ChartPoint[]
    command: ChartPoint[]
  }
  /** Active connections over time. */
  connections: ChartPoint[]
  /** % of cache fill over time. */
  cacheFillPct: ChartPoint[]
  /** Resident memory MB over time. */
  residentMb: ChartPoint[]
  /** Average op latency µs over time (per family). */
  latencyMicros: { reads: ChartPoint[]; writes: ChartPoint[]; commands: ChartPoint[] }
  /** Network throughput bytes/sec (in + out). */
  bytesPerSec: ChartPoint[]
}

const PIE_COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--success))',
  '#fb923c',
  '#a78bfa',
  '#f472b6',
  '#facc15',
  '#60a5fa',
  '#34d399',
  '#94a3b8',
  '#fda4af'
]

export function ConnectionDashboard({ connection }: { connection: ConnectionConfig }) {
  // The dashboard reads samples from `useServerStatsHistory`, which is
  // populated continuously by `ServerStatsCollector` regardless of which
  // tab the user is currently looking at. The local `useQuery` here is
  // only used so that *opening* the dashboard for the first time doesn't
  // sit empty for 5s — react-query's cache typically already holds a
  // recent sample from the collector's most recent push.
  const { data, isLoading, error, refetch, isRefetching, dataUpdatedAt } = useQuery({
    queryKey: queryKeys.serverStats(connection.id),
    queryFn: () => api.server.stats(connection.id)
    // No `refetchInterval` here — `ServerStatsCollector` owns the polling
    // schedule and pushes fresh samples into this query's cache.
  })

  const history = useServerStatsHistory((s) => s.histories[connection.id]) ?? EMPTY_HISTORY
  const series = useMemo<Series>(() => derive(history), [history])

  return (
    <section className="flex h-full flex-col">
      <header className="flex h-16 shrink-0 items-center justify-between border-b px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/30">
            <Server className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight">{connection.name}</span>
              {data && (
                <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-success">
                  live
                </span>
              )}
            </div>
            <div className="font-mono text-xs text-muted-foreground">
              {data?.host ?? '—'}
              {data && (
                <>
                  {' · '}MongoDB {data.version} · {data.process}
                  {data.storageEngine ? ` / ${data.storageEngine}` : ''}
                  {' · '}up {formatUptime(data.uptimeSeconds)}
                  {' · '}
                  {data.databases.length} dbs
                  {' · '}
                  {formatBytes(data.totalSizeOnDisk)}
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {dataUpdatedAt > 0 && (
            <div className="font-mono text-xs text-muted-foreground">
              updated {timeAgo(dataUpdatedAt)}
            </div>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void refetch()}
            disabled={isRefetching}
            aria-label="Refresh"
          >
            {isRefetching ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {isLoading && <LoadingState />}
        {error instanceof ApiError && <ErrorState message={error.message} />}
        {data && (
          <Tabs defaultValue="overview" className="grid gap-5">
            <TabsList className="self-start">
              <TabsTrigger value="overview" className="gap-1.5">
                <Gauge className="h-3 w-3" />
                Overview
              </TabsTrigger>
              <TabsTrigger value="performance" className="gap-1.5">
                <Zap className="h-3 w-3" />
                Performance
              </TabsTrigger>
              <TabsTrigger value="health" className="gap-1.5">
                <Heart className="h-3 w-3" />
                Health
              </TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="m-0">
              <Overview stats={data} series={series} />
            </TabsContent>
            <TabsContent value="performance" className="m-0">
              <Performance stats={data} series={series} />
            </TabsContent>
            <TabsContent value="health" className="m-0">
              <Health stats={data} series={series} />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </section>
  )
}

function LoadingState() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading server stats…
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      <ServerCrash className="mt-0.5 h-4 w-4" />
      <div>
        <div className="font-medium">Could not read server stats</div>
        <div className="text-xs opacity-80">{message}</div>
        <div className="mt-2 text-xs opacity-80">
          Reading <span className="font-mono">serverStatus</span> requires the{' '}
          <span className="font-mono">clusterMonitor</span> role (or a superset).
        </div>
      </div>
    </div>
  )
}

/* ---------- Tabs ---------- */

function Overview({ stats, series }: { stats: ServerStats; series: Series }) {
  const lastOpsPerSec = series.opsPerSec.at(-1)?.value ?? 0
  return (
    <div className="grid grid-cols-12 gap-4">
      <KpiStrip stats={stats} series={series} />

      <Card className="col-span-12 lg:col-span-8" title="Storage by database" icon={<HardDrive />}>
        <DatabasesPie databases={stats.databases} />
      </Card>
      <Card className="col-span-12 lg:col-span-4" title="Server" icon={<Info />}>
        <ServerInfoBlock stats={stats} />
      </Card>

      <Card className="col-span-12 lg:col-span-7" title="Operation latency" icon={<Timer />}>
        <LatencyBlock stats={stats} series={series} />
      </Card>
      <Card className="col-span-12 lg:col-span-5" title="Workload mix" icon={<Layers />}>
        <WorkloadMixBlock series={series} />
      </Card>

      <Card
        className="col-span-12"
        title="Operations / second"
        icon={<Gauge />}
        right={
          <span className="num-display font-mono text-base font-semibold">
            {lastOpsPerSec.toFixed(1)}{' '}
            <span className="text-xs font-normal text-muted-foreground">ops/s</span>
          </span>
        }
      >
        <OpsRateBlock stats={stats} series={series} />
      </Card>

      <Card className="col-span-12" title="Network" icon={<Network />}>
        <NetworkBlock stats={stats} series={series} />
      </Card>
    </div>
  )
}

/* ---------- Compact KPI strip ---------- */

function KpiStrip({ stats, series }: { stats: ServerStats; series: Series }) {
  const opsPs = series.opsPerSec.at(-1)?.value ?? 0
  const netPs = series.bytesPerSec.at(-1)?.value ?? 0
  const conn = stats.connections
  const connTotal = conn.current + conn.available
  const connPct = connTotal > 0 ? (conn.current / connTotal) * 100 : 0
  const hitRate =
    stats.cache && stats.cache.pagesRequested > 0
      ? (1 - stats.cache.pagesRead / stats.cache.pagesRequested) * 100
      : null
  const cachePct =
    stats.cache && stats.cache.maxBytesConfigured > 0
      ? (stats.cache.bytesInCache / stats.cache.maxBytesConfigured) * 100
      : null
  const totalDocs =
    stats.documents.inserted +
    stats.documents.returned +
    stats.documents.updated +
    stats.documents.deleted

  const tiles: Array<{
    label: string
    icon: React.ReactNode
    value: string
    detail: string
    series?: ChartPoint[]
    color?: string
  }> = [
    {
      label: 'ops / sec',
      icon: <Gauge />,
      value: opsPs < 10 ? opsPs.toFixed(1) : opsPs.toFixed(0),
      detail: `${formatNumber(stats.network.numRequests)} cumulative`,
      series: series.opsPerSec,
      color: 'hsl(var(--primary))'
    },
    {
      label: 'net / sec',
      icon: <Network />,
      value: formatBytesShort(netPs),
      detail: `${formatBytes(stats.network.bytesIn + stats.network.bytesOut)} total`,
      series: series.bytesPerSec,
      color: 'hsl(var(--success))'
    },
    {
      label: 'connections',
      icon: <Plug />,
      value: formatNumber(conn.current),
      detail: `${connPct.toFixed(0)}% of ${formatNumber(connTotal)}`,
      series: series.connections,
      color: '#fb923c'
    },
    {
      label: 'cache hit',
      icon: <Boxes />,
      value: hitRate !== null ? `${hitRate.toFixed(2)}%` : '—',
      detail: cachePct !== null ? `fill ${cachePct.toFixed(0)}%` : 'no cache stats',
      series: series.cacheFillPct,
      color: '#a78bfa'
    },
    {
      label: 'resident',
      icon: <Cpu />,
      value: `${formatNumber(stats.mem.residentMb)} MB`,
      detail: `${formatNumber(stats.mem.virtualMb)} MB virtual`,
      series: series.residentMb,
      color: '#f472b6'
    },
    {
      label: 'documents',
      icon: <Files />,
      value: formatCompact(totalDocs),
      detail: `${formatCompact(stats.documents.returned)} read · ${formatCompact(
        stats.documents.inserted + stats.documents.updated + stats.documents.deleted
      )} written`,
      color: '#facc15'
    },
    {
      label: 'storage',
      icon: <HardDrive />,
      value: formatBytes(stats.totalSizeOnDisk),
      detail: `${stats.databases.length} dbs`,
      color: '#60a5fa'
    },
    {
      label: 'uptime',
      icon: <Clock />,
      value: formatUptime(stats.uptimeSeconds),
      detail: `MongoDB ${stats.version}`,
      color: '#34d399'
    }
  ]

  return (
    <div className="col-span-12 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border bg-card px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <span className="[&_svg]:size-3" style={t.color ? { color: t.color } : undefined}>
              {t.icon}
            </span>
            {t.label}
          </div>
          <div className="num-display mt-1 font-mono text-xl font-semibold leading-tight">
            {t.value}
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
            {t.detail}
          </div>
          {t.series && t.series.length > 1 && (
            <Sparkline
              values={t.series.map((p) => p.value)}
              color={t.color ?? 'hsl(var(--primary))'}
              height={18}
              fillOpacity={0.18}
            />
          )}
        </div>
      ))}
    </div>
  )
}

function ServerInfoBlock({ stats }: { stats: ServerStats }) {
  const totalSize = stats.totalSizeOnDisk
  const emptyDbs = stats.databases.filter((d) => d.empty).length
  const biggest =
    stats.databases.length > 0
      ? [...stats.databases].sort((a, b) => b.sizeOnDisk - a.sizeOnDisk)[0]
      : null
  const rows: Array<[string, string]> = [
    ['Host', stats.host],
    ['Version', `MongoDB ${stats.version}`],
    ['Process', stats.process],
    ['Storage engine', stats.storageEngine ?? '—'],
    ['Uptime', formatUptime(stats.uptimeSeconds)],
    ['Databases', `${stats.databases.length}${emptyDbs > 0 ? ` (${emptyDbs} empty)` : ''}`],
    ['Total storage', formatBytes(totalSize)],
    ['Largest database', biggest ? `${biggest.name} · ${formatBytes(biggest.sizeOnDisk)}` : '—']
  ]
  return (
    <ul className="grid gap-1.5 text-xs">
      {rows.map(([k, v]) => (
        <li key={k} className="flex items-baseline justify-between gap-3">
          <span className="text-muted-foreground">{k}</span>
          <span className="truncate font-mono">{v}</span>
        </li>
      ))}
    </ul>
  )
}

function WorkloadMixBlock({ series }: { series: Series }) {
  const samples = [
    ['query', series.opsPerSecByKind.query.at(-1)?.value ?? 0, 'hsl(var(--primary))'],
    ['insert', series.opsPerSecByKind.insert.at(-1)?.value ?? 0, 'hsl(var(--success))'],
    ['update', series.opsPerSecByKind.update.at(-1)?.value ?? 0, '#fb923c'],
    ['delete', series.opsPerSecByKind.delete.at(-1)?.value ?? 0, '#f472b6'],
    ['getmore', series.opsPerSecByKind.getmore.at(-1)?.value ?? 0, '#60a5fa'],
    ['command', series.opsPerSecByKind.command.at(-1)?.value ?? 0, '#a78bfa']
  ] as const
  const total = samples.reduce((s, [, v]) => s + v, 0)
  return (
    <div className="grid gap-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">Last sample</span>
        <span className="num-display font-mono text-base font-semibold">
          {total.toFixed(total < 10 ? 1 : 0)}{' '}
          <span className="text-xs font-normal text-muted-foreground">ops/s</span>
        </span>
      </div>
      <div className="flex h-3 overflow-hidden rounded-full bg-muted">
        {samples.map(([label, v, color]) => {
          const pct = total > 0 ? (v / total) * 100 : 0
          if (pct === 0) return null
          return (
            <div
              key={label}
              style={{ width: `${pct}%`, backgroundColor: color }}
              title={`${label} — ${pct.toFixed(1)}%`}
            />
          )
        })}
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {samples.map(([label, v, color]) => {
          const pct = total > 0 ? (v / total) * 100 : 0
          return (
            <li key={label} className="flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-sm"
                style={{ backgroundColor: color }}
              />
              <span className="flex-1 truncate text-muted-foreground">{label}</span>
              <span className="num-display font-mono">{v.toFixed(v < 10 ? 1 : 0)}</span>
              <span className="num-display w-10 text-right font-mono text-muted-foreground">
                {pct.toFixed(0)}%
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Performance({ stats, series }: { stats: ServerStats; series: Series }) {
  return (
    <div className="grid grid-cols-12 gap-4">
      <Card className="col-span-12 lg:col-span-6" title="Connection pool" icon={<Plug />}>
        <ConnectionsBlock stats={stats} series={series} />
      </Card>
      {stats.cache && (
        <Card className="col-span-12 lg:col-span-6" title="WiredTiger cache" icon={<Boxes />}>
          <CacheBlock cache={stats.cache} series={series} />
        </Card>
      )}

      {stats.concurrent && (
        <>
          <Card className="col-span-6 lg:col-span-3" title="WT read tickets" icon={<Layers />}>
            <TicketBlock data={stats.concurrent.read} accent="hsl(var(--primary))" />
          </Card>
          <Card className="col-span-6 lg:col-span-3" title="WT write tickets" icon={<Layers />}>
            <TicketBlock data={stats.concurrent.write} accent="hsl(var(--success))" />
          </Card>
        </>
      )}

      <Card
        className={cn(
          'col-span-12',
          stats.concurrent ? 'lg:col-span-6' : stats.cache ? 'lg:col-span-12' : 'lg:col-span-6'
        )}
        title="Memory"
        icon={<Cpu />}
      >
        <MemoryBlock stats={stats} series={series} />
      </Card>
    </div>
  )
}

function Health({ stats, series }: { stats: ServerStats; series: Series }) {
  const totalAsserts =
    stats.asserts.regular + stats.asserts.warning + stats.asserts.user + stats.asserts.msg
  return (
    <div className="grid grid-cols-12 gap-4">
      <Card className="col-span-12 lg:col-span-6" title="Document throughput" icon={<Files />}>
        <DocumentsBlock stats={stats} series={series} />
      </Card>
      <Card className="col-span-12 lg:col-span-3" title="Cursors" icon={<MousePointer />}>
        <CursorsBlock stats={stats} />
      </Card>
      <Card className="col-span-12 lg:col-span-3" title="Asserts" icon={<AlertTriangle />}>
        <AssertsBlock stats={stats} totalAsserts={totalAsserts} />
      </Card>
      <Card className="col-span-12 lg:col-span-7" title="Database breakdown" icon={<Database />}>
        <DatabaseBreakdownBlock stats={stats} />
      </Card>
      <Card className="col-span-12 lg:col-span-5" title="Operation counters" icon={<Gauge />}>
        <OperationCountersBlock stats={stats} />
      </Card>
    </div>
  )
}

function DatabaseBreakdownBlock({ stats }: { stats: ServerStats }) {
  const sorted = [...stats.databases].sort((a, b) => b.sizeOnDisk - a.sizeOnDisk)
  const total = stats.totalSizeOnDisk
  const nonEmpty = stats.databases.filter((d) => !d.empty).length
  const avgSize = nonEmpty > 0 ? total / nonEmpty : 0
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-3 gap-3 border-b pb-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Databases</div>
          <div className="num-display font-mono text-2xl font-semibold">
            {formatNumber(stats.databases.length)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {stats.databases.filter((d) => d.empty).length} empty
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Total size</div>
          <div className="num-display font-mono text-2xl font-semibold">{formatBytes(total)}</div>
          <div className="text-[10px] text-muted-foreground">avg {formatBytes(avgSize)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Largest</div>
          <div className="num-display font-mono text-2xl font-semibold">
            {sorted[0] ? formatBytes(sorted[0].sizeOnDisk) : '—'}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">{sorted[0]?.name ?? '—'}</div>
        </div>
      </div>
      <ul className="grid max-h-64 gap-1 overflow-y-auto pr-1 text-xs">
        {sorted.map((d) => {
          const pct = total > 0 ? (d.sizeOnDisk / total) * 100 : 0
          return (
            <li key={d.name} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate font-mono">{d.name}</span>
              <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                />
              </div>
              <span className="num-display w-20 text-right font-mono text-muted-foreground">
                {formatBytes(d.sizeOnDisk)}
              </span>
              <span className="num-display w-12 text-right font-mono text-muted-foreground">
                {pct.toFixed(1)}%
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function OperationCountersBlock({ stats }: { stats: ServerStats }) {
  const rows: Array<[string, number, string]> = [
    ['query', stats.opcounters.query, 'hsl(var(--primary))'],
    ['insert', stats.opcounters.insert, 'hsl(var(--success))'],
    ['update', stats.opcounters.update, '#fb923c'],
    ['delete', stats.opcounters.delete, '#f472b6'],
    ['getmore', stats.opcounters.getmore, '#60a5fa'],
    ['command', stats.opcounters.command, '#a78bfa']
  ]
  const total = rows.reduce((s, [, v]) => s + v, 0)
  return (
    <div className="grid gap-3">
      <div className="flex items-baseline justify-between border-b pb-2">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          Cumulative since uptime
        </span>
        <span className="num-display font-mono text-base font-semibold">{formatNumber(total)}</span>
      </div>
      <ul className="grid gap-1.5 text-xs">
        {rows.map(([label, v, color]) => {
          const pct = total > 0 ? (v / total) * 100 : 0
          return (
            <li key={label} className="flex items-center gap-3">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-sm"
                style={{ backgroundColor: color }}
              />
              <span className="w-16 text-muted-foreground">{label}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full"
                  style={{
                    width: `${Math.min(100, Math.max(0, pct))}%`,
                    backgroundColor: color
                  }}
                />
              </div>
              <span className="num-display w-20 text-right font-mono">{formatNumber(v)}</span>
              <span className="num-display w-12 text-right font-mono text-muted-foreground">
                {pct.toFixed(1)}%
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* ---------- Card primitives ---------- */

function Card({
  title,
  icon,
  children,
  className,
  right
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
  className?: string
  right?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-5 transition-colors hover:border-border',
        className
      )}
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <span className="[&_svg]:size-3.5">{icon}</span>
          {title}
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

/* ---------- Blocks ---------- */

function LatencyBlock({ stats, series }: { stats: ServerStats; series: Series }) {
  const lat = stats.latencies
  if (!lat) {
    return (
      <div className="py-4 text-sm text-muted-foreground">
        Server didn&apos;t report opLatencies (older Mongo or limited role).
      </div>
    )
  }
  const items = [
    { label: 'reads', v: lat.reads, color: 'hsl(var(--primary))', s: series.latencyMicros.reads },
    {
      label: 'writes',
      v: lat.writes,
      color: 'hsl(var(--success))',
      s: series.latencyMicros.writes
    },
    { label: 'commands', v: lat.commands, color: '#a78bfa', s: series.latencyMicros.commands }
  ]
  return (
    <div className="grid gap-3">
      {items.map(({ label, v, color, s }) => {
        // Headline uses the latest interval's mean — the cumulative ratio
        // `latencyMicros / ops` would converge to the long-run average
        // and stop reflecting current traffic.
        const recentMicros = s.length > 0 ? (s[s.length - 1]?.value ?? 0) : 0
        return (
          <div key={label} className="grid gap-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">
                {label}
              </span>
              <div className="flex items-baseline gap-3 font-mono">
                <span className="num-display text-lg font-semibold text-foreground">
                  {formatMicros(recentMicros)}
                </span>
                <span className="text-xs text-muted-foreground">{formatNumber(v.ops)} ops</span>
              </div>
            </div>
            <Chart
              points={s}
              color={color}
              height={70}
              unit=" µs"
              formatY={(val) => formatMicrosShort(val)}
              yMin={0}
            />
          </div>
        )
      })}
    </div>
  )
}

function OpsRateBlock({ stats, series }: { stats: ServerStats; series: Series }) {
  const totalOps =
    stats.opcounters.insert +
    stats.opcounters.query +
    stats.opcounters.update +
    stats.opcounters.delete +
    stats.opcounters.getmore +
    stats.opcounters.command

  const tiles: Array<[string, ChartPoint[], string, number]> = [
    ['query', series.opsPerSecByKind.query, 'hsl(var(--primary))', stats.opcounters.query],
    ['insert', series.opsPerSecByKind.insert, 'hsl(var(--success))', stats.opcounters.insert],
    ['update', series.opsPerSecByKind.update, '#fb923c', stats.opcounters.update],
    ['delete', series.opsPerSecByKind.delete, '#f472b6', stats.opcounters.delete],
    ['getmore', series.opsPerSecByKind.getmore, '#60a5fa', stats.opcounters.getmore],
    ['command', series.opsPerSecByKind.command, '#a78bfa', stats.opcounters.command]
  ]

  return (
    <div className="grid gap-4">
      <Chart
        points={series.opsPerSec}
        color="hsl(var(--primary))"
        height={150}
        unit=" /s"
        formatY={(v) => v.toFixed(v < 10 ? 1 : 0)}
        yMin={0}
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map(([label, s, color, cumulative]) => (
          <div key={label} className="grid gap-1 rounded-md border bg-background/30 p-3">
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
              <span
                className="inline-block h-2 w-2 rounded-sm"
                style={{ backgroundColor: color }}
              />
              {label}
            </div>
            <div className="num-display font-mono text-lg font-semibold">
              {(s.at(-1)?.value ?? 0).toFixed(1)}
              <span className="text-xs font-normal text-muted-foreground">/s</span>
            </div>
            <Sparkline values={s.map((p) => p.value)} color={color} height={24} fillOpacity={0.2} />
            <div className="font-mono text-[10px] text-muted-foreground">
              {formatCompact(cumulative)} total
            </div>
          </div>
        ))}
      </div>
      <div className="font-mono text-xs text-muted-foreground">
        {formatNumber(totalOps)} cumulative since startup
      </div>
    </div>
  )
}

function ConnectionsBlock({ stats, series }: { stats: ServerStats; series: Series }) {
  const { current, available } = stats.connections
  const total = current + available
  const usedPct = total > 0 ? (current / total) * 100 : 0
  return (
    <div className="grid gap-4">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="num-display font-mono text-4xl font-semibold text-foreground">
            {formatNumber(current)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            of {formatNumber(total)} active connections
          </div>
        </div>
        <div className="text-right">
          <div className="num-display font-mono text-base font-semibold">{usedPct.toFixed(1)}%</div>
          <div className="text-xs text-muted-foreground">utilized</div>
        </div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${Math.min(100, Math.max(0, usedPct))}%` }}
        />
      </div>
      <Chart
        points={series.connections}
        color="hsl(var(--primary))"
        height={120}
        unit=" conn"
        formatY={(v) => v.toFixed(0)}
        yMin={0}
      />
      <div className="font-mono text-xs text-muted-foreground">
        {formatNumber(stats.connections.totalCreated)} total served since startup
      </div>
    </div>
  )
}

function DocumentsBlock({ stats, series }: { stats: ServerStats; series: Series }) {
  const items: Array<[string, number, string, React.ReactNode]> = [
    ['returned', stats.documents.returned, 'hsl(var(--primary))', <Files key="r" />],
    ['inserted', stats.documents.inserted, 'hsl(var(--success))', <FilePlus2 key="i" />],
    ['updated', stats.documents.updated, '#fb923c', <FileEdit key="u" />],
    ['deleted', stats.documents.deleted, '#f472b6', <FileMinus2 key="d" />]
  ]
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-4">
        {items.map(([label, value, color, icon]) => (
          <div key={label} className="grid gap-1">
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
              <span className="[&_svg]:size-3" style={{ color }}>
                {icon}
              </span>
              {label}
            </div>
            <div className="num-display font-mono text-2xl font-semibold">
              {formatNumber(value)}
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-2 border-t pt-3">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          Read throughput
        </div>
        <Chart
          points={series.opsPerSecByKind.query}
          color="hsl(var(--primary))"
          height={100}
          unit=" /s"
          formatY={(v) => v.toFixed(v < 10 ? 1 : 0)}
          yMin={0}
        />
      </div>
    </div>
  )
}

function CursorsBlock({ stats }: { stats: ServerStats }) {
  const { open, noTimeout, timedOut } = stats.cursors
  return (
    <div className="grid gap-3">
      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground">Open</div>
        <div className="num-display font-mono text-3xl font-semibold">{formatNumber(open)}</div>
      </div>
      <div className="grid grid-cols-2 gap-2 border-t pt-3 text-xs">
        <div>
          <div className="text-muted-foreground">no-timeout</div>
          <div className="font-mono">{formatNumber(noTimeout)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">timed out</div>
          <div className={cn('font-mono', timedOut > 0 && 'text-amber-400')}>
            {formatNumber(timedOut)}
          </div>
        </div>
      </div>
    </div>
  )
}

function TicketBlock({
  data,
  accent
}: {
  data: { available: number; out: number; total: number }
  accent: string
}) {
  const pct = data.total > 0 ? (data.out / data.total) * 100 : 0
  return (
    <div className="grid gap-3">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="num-display font-mono text-3xl font-semibold">{data.out}</div>
          <div className="text-xs text-muted-foreground">of {data.total} active</div>
        </div>
        <div className="num-display font-mono text-base font-semibold">{pct.toFixed(0)}%</div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full transition-all"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%`, backgroundColor: accent }}
        />
      </div>
      <div className="font-mono text-xs text-muted-foreground">{data.available} available</div>
    </div>
  )
}

function CacheBlock({
  cache,
  series
}: {
  cache: NonNullable<ServerStats['cache']>
  series: Series
}) {
  const fillPct =
    cache.maxBytesConfigured > 0 ? (cache.bytesInCache / cache.maxBytesConfigured) * 100 : 0
  const hitRate =
    cache.pagesRequested > 0 ? (1 - cache.pagesRead / cache.pagesRequested) * 100 : null
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">Fill</span>
          <span className="num-display font-mono text-sm">
            <span className="font-semibold">{formatBytes(cache.bytesInCache)}</span>{' '}
            <span className="text-muted-foreground">/ {formatBytes(cache.maxBytesConfigured)}</span>
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary"
            style={{ width: `${Math.min(100, Math.max(0, fillPct))}%` }}
          />
        </div>
      </div>
      <Chart
        points={series.cacheFillPct}
        color="hsl(var(--primary))"
        height={100}
        unit="%"
        formatY={(v) => v.toFixed(0)}
        yMin={0}
        yMax={100}
      />
      {hitRate !== null && (
        <div className="grid gap-1.5 border-t pt-3">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-muted-foreground">Hit rate</span>
            <span className="num-display font-mono text-sm font-semibold">
              {hitRate.toFixed(2)}%
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full', hitRate > 95 ? 'bg-success' : 'bg-amber-400')}
              style={{ width: `${Math.min(100, Math.max(0, hitRate))}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function MemoryBlock({ stats, series }: { stats: ServerStats; series: Series }) {
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-6">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Resident</div>
          <div className="num-display font-mono text-3xl font-semibold">
            {formatNumber(stats.mem.residentMb)}
            <span className="ml-1.5 text-base font-normal text-muted-foreground">MB</span>
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Virtual</div>
          <div className="num-display font-mono text-3xl font-semibold">
            {formatNumber(stats.mem.virtualMb)}
            <span className="ml-1.5 text-base font-normal text-muted-foreground">MB</span>
          </div>
        </div>
      </div>
      <div className="grid gap-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">Resident trend</div>
        <Chart
          points={series.residentMb}
          color="hsl(var(--success))"
          height={120}
          unit=" MB"
          formatY={(v) => v.toFixed(0)}
          yMin={0}
        />
      </div>
    </div>
  )
}

function AssertsBlock({ stats, totalAsserts }: { stats: ServerStats; totalAsserts: number }) {
  const isHealthy = totalAsserts === 0
  return (
    <div className="grid gap-3">
      <div className="flex items-baseline gap-3">
        <span
          className={cn(
            'num-display font-mono text-3xl font-semibold',
            !isHealthy && 'text-amber-400'
          )}
        >
          {formatNumber(totalAsserts)}
        </span>
        <span
          className={cn(
            'text-xs font-medium uppercase tracking-wider',
            isHealthy ? 'text-success' : 'text-amber-400'
          )}
        >
          {isHealthy ? 'healthy' : 'errors'}
        </span>
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t pt-3 text-xs">
        {[
          ['regular', stats.asserts.regular],
          ['warning', stats.asserts.warning],
          ['user', stats.asserts.user],
          ['msg', stats.asserts.msg],
          ['rollovers', stats.asserts.rollovers]
        ].map(([label, value]) => (
          <li key={label} className="flex justify-between">
            <span className="text-muted-foreground">{label}</span>
            <span className="font-mono">{formatNumber(value as number)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function NetworkBlock({ stats, series }: { stats: ServerStats; series: Series }) {
  const lastBps = series.bytesPerSec.at(-1)?.value ?? 0
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-3 gap-6">
        <Stat
          icon={<ArrowDownToLine />}
          label="In"
          value={formatBytes(stats.network.bytesIn)}
          color="text-primary"
        />
        <Stat
          icon={<ArrowUpFromLine />}
          label="Out"
          value={formatBytes(stats.network.bytesOut)}
          color="text-success"
        />
        <Stat
          icon={<Zap />}
          label="Requests"
          value={formatNumber(stats.network.numRequests)}
          color="text-amber-300"
        />
      </div>
      <div className="grid gap-2 border-t pt-3">
        <div className="flex items-baseline justify-between">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Throughput</div>
          <div className="num-display font-mono text-sm font-semibold">
            {formatBytes(lastBps)}
            <span className="text-xs font-normal text-muted-foreground">/s</span>
          </div>
        </div>
        <Chart
          points={series.bytesPerSec}
          color="hsl(var(--primary))"
          height={130}
          formatY={(v) => formatBytesShort(v)}
          yMin={0}
        />
      </div>
    </div>
  )
}

function Stat({
  icon,
  label,
  value,
  color
}: {
  icon: React.ReactNode
  label: string
  value: string
  color?: string
}) {
  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground',
          color
        )}
      >
        <span className="[&_svg]:size-3">{icon}</span>
        {label}
      </div>
      <div className="num-display mt-1 font-mono text-2xl font-semibold">{value}</div>
    </div>
  )
}

/* ---------- Pie chart ---------- */

const REST_COLOR = 'hsl(var(--muted-foreground) / 0.4)'

function DatabasesPie({ databases }: { databases: ServerStats['databases'] }) {
  const sortedAll = [...databases].sort((a, b) => b.sizeOnDisk - a.sizeOnDisk)
  const grandTotal = sortedAll.reduce((s, d) => s + d.sizeOnDisk, 0)
  const top = sortedAll.slice(0, 15)
  const restDbs = sortedAll.slice(15)
  const restSize = restDbs.reduce((s, d) => s + d.sizeOnDisk, 0)

  if (grandTotal === 0 || sortedAll.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No measurable storage in any database.
      </div>
    )
  }

  // Build the slice list — top-N plus an aggregated "Other" wedge so the
  // pie always sums to 100% of total storage across every database.
  const pieItems: Array<{ name: string; sizeOnDisk: number; isRest?: boolean }> = [...top]
  if (restDbs.length > 0 && restSize > 0) {
    pieItems.push({ name: `Other (${restDbs.length})`, sizeOnDisk: restSize, isRest: true })
  }
  const colorAt = (i: number, isRest?: boolean): string =>
    isRest ? REST_COLOR : PIE_COLORS[i % PIE_COLORS.length]!
  const segments = computeSegments(pieItems, grandTotal)

  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-8">
      <svg viewBox="0 0 200 200" className="h-44 w-44">
        <circle cx="100" cy="100" r="88" fill="hsl(var(--card))" stroke="hsl(var(--border))" />
        {segments.map((seg, i) => (
          <path
            key={seg.name}
            d={seg.path}
            fill={colorAt(i, pieItems[i]?.isRest)}
            stroke="hsl(var(--card))"
            strokeWidth={1.5}
          >
            <title>
              {seg.name} — {formatBytes(seg.value)} ({seg.pct.toFixed(1)}%)
            </title>
          </path>
        ))}
        <circle cx="100" cy="100" r="56" fill="hsl(var(--card))" />
        <text
          x="100"
          y="88"
          textAnchor="middle"
          className="fill-muted-foreground"
          style={{ fontSize: '11px' }}
        >
          {sortedAll.length} dbs
        </text>
        <text
          x="100"
          y="108"
          textAnchor="middle"
          className="fill-foreground font-mono"
          style={{ fontSize: '15px', fontWeight: 600 }}
        >
          {formatBytes(grandTotal)}
        </text>
        <text
          x="100"
          y="124"
          textAnchor="middle"
          className="fill-muted-foreground"
          style={{ fontSize: '9px' }}
        >
          total
        </text>
      </svg>
      <ul className="grid content-start gap-1 text-xs">
        {top.map((db, i) => {
          const pct = grandTotal > 0 ? (db.sizeOnDisk / grandTotal) * 100 : 0
          return (
            <li key={db.name} className="flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-sm"
                style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{db.name}</span>
              <span className="font-mono text-muted-foreground">{formatBytes(db.sizeOnDisk)}</span>
              <span className="num-display w-12 text-right font-mono text-muted-foreground">
                {pct.toFixed(1)}%
              </span>
            </li>
          )
        })}
        {restDbs.length > 0 && restSize > 0 && (
          <li className="flex items-center gap-2 border-t pt-1.5 text-muted-foreground">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-sm"
              style={{ backgroundColor: REST_COLOR }}
            />
            <span className="min-w-0 flex-1 truncate italic">Other ({restDbs.length} more)</span>
            <span className="font-mono">{formatBytes(restSize)}</span>
            <span className="num-display w-12 text-right font-mono">
              {((restSize / grandTotal) * 100).toFixed(1)}%
            </span>
          </li>
        )}
      </ul>
    </div>
  )
}

type Segment = { name: string; value: number; pct: number; path: string }

function computeSegments(
  items: Array<{ name: string; sizeOnDisk: number }>,
  total: number
): Segment[] {
  const cx = 100
  const cy = 100
  const r = 88
  let angle = -Math.PI / 2
  return items
    .filter((d) => d.sizeOnDisk > 0)
    .map((d) => {
      const slice = (d.sizeOnDisk / total) * 2 * Math.PI
      const x1 = cx + r * Math.cos(angle)
      const y1 = cy + r * Math.sin(angle)
      const next = angle + slice
      const x2 = cx + r * Math.cos(next)
      const y2 = cy + r * Math.sin(next)
      const large = slice > Math.PI ? 1 : 0
      const path =
        items.length === 1
          ? `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`
          : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`
      angle = next
      return {
        name: d.name,
        value: d.sizeOnDisk,
        pct: (d.sizeOnDisk / total) * 100,
        path
      }
    })
}

/* ---------- Helpers ---------- */

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) < 1000) return n.toFixed(0)
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  if (Math.abs(n) < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function formatMicros(micros: number): string {
  if (!Number.isFinite(micros) || micros < 0) return '—'
  if (micros < 1000) return `${micros.toFixed(0)} µs`
  if (micros < 1_000_000) return `${(micros / 1000).toFixed(2)} ms`
  return `${(micros / 1_000_000).toFixed(2)} s`
}

function formatMicrosShort(micros: number): string {
  if (!Number.isFinite(micros) || micros < 0) return '0'
  if (micros < 1000) return micros.toFixed(0)
  if (micros < 1_000_000) return `${(micros / 1000).toFixed(1)}k`
  return `${(micros / 1_000_000).toFixed(1)}M`
}

function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0'
  if (bytes < 1024) return `${bytes.toFixed(0)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

/* ---------- Time-series derivation ---------- */

const EMPTY_HISTORY: StatsSample[] = []

function derive(history: StatsSample[]): Series {
  const empty: Series = {
    opsPerSec: [],
    opsPerSecByKind: {
      query: [],
      insert: [],
      update: [],
      delete: [],
      getmore: [],
      command: []
    },
    connections: [],
    cacheFillPct: [],
    residentMb: [],
    latencyMicros: { reads: [], writes: [], commands: [] },
    bytesPerSec: []
  }
  if (history.length === 0) return empty

  for (const s of history) {
    empty.connections.push({ ts: s.ts, value: s.data.connections.current })
    if (s.data.cache && s.data.cache.maxBytesConfigured > 0) {
      empty.cacheFillPct.push({
        ts: s.ts,
        value: (s.data.cache.bytesInCache / s.data.cache.maxBytesConfigured) * 100
      })
    } else {
      empty.cacheFillPct.push({ ts: s.ts, value: 0 })
    }
    empty.residentMb.push({ ts: s.ts, value: s.data.mem.residentMb })
  }

  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1]
    const cur = history[i]
    if (!prev || !cur) continue
    const dt = (cur.ts - prev.ts) / 1000
    if (dt <= 0) continue

    const sumOps = (data: ServerStats): number =>
      data.opcounters.insert +
      data.opcounters.query +
      data.opcounters.update +
      data.opcounters.delete +
      data.opcounters.getmore +
      data.opcounters.command

    empty.opsPerSec.push({
      ts: cur.ts,
      value: Math.max(0, (sumOps(cur.data) - sumOps(prev.data)) / dt)
    })
    empty.opsPerSecByKind.query.push({
      ts: cur.ts,
      value: Math.max(0, (cur.data.opcounters.query - prev.data.opcounters.query) / dt)
    })
    empty.opsPerSecByKind.insert.push({
      ts: cur.ts,
      value: Math.max(0, (cur.data.opcounters.insert - prev.data.opcounters.insert) / dt)
    })
    empty.opsPerSecByKind.update.push({
      ts: cur.ts,
      value: Math.max(0, (cur.data.opcounters.update - prev.data.opcounters.update) / dt)
    })
    empty.opsPerSecByKind.delete.push({
      ts: cur.ts,
      value: Math.max(0, (cur.data.opcounters.delete - prev.data.opcounters.delete) / dt)
    })
    empty.opsPerSecByKind.getmore.push({
      ts: cur.ts,
      value: Math.max(0, (cur.data.opcounters.getmore - prev.data.opcounters.getmore) / dt)
    })
    empty.opsPerSecByKind.command.push({
      ts: cur.ts,
      value: Math.max(0, (cur.data.opcounters.command - prev.data.opcounters.command) / dt)
    })

    const bytesDelta =
      cur.data.network.bytesIn -
      prev.data.network.bytesIn +
      (cur.data.network.bytesOut - prev.data.network.bytesOut)
    empty.bytesPerSec.push({ ts: cur.ts, value: Math.max(0, bytesDelta / dt) })

    if (cur.data.latencies && prev.data.latencies) {
      empty.latencyMicros.reads.push({
        ts: cur.ts,
        value: intervalLatency(prev.data.latencies.reads, cur.data.latencies.reads)
      })
      empty.latencyMicros.writes.push({
        ts: cur.ts,
        value: intervalLatency(prev.data.latencies.writes, cur.data.latencies.writes)
      })
      empty.latencyMicros.commands.push({
        ts: cur.ts,
        value: intervalLatency(prev.data.latencies.commands, cur.data.latencies.commands)
      })
    }
  }

  return empty
}

/**
 * Per-interval mean op latency in microseconds. Diffs the cumulative
 * (`latencyMicros`, `ops`) counters between two consecutive samples so
 * the chart actually moves with recent traffic.
 */
function intervalLatency(
  prev: { latencyMicros: number; ops: number },
  cur: { latencyMicros: number; ops: number }
): number {
  const dOps = cur.ops - prev.ops
  if (dOps <= 0) return 0
  const dLatency = cur.latencyMicros - prev.latencyMicros
  return dLatency / dOps
}
