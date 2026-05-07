import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, XCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { TimezoneSelect } from './TimezoneSelect'
import { api, ApiError } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'
import { cn } from '@/lib/utils'
import type {
  AuthMechanism,
  ConnectionConfig,
  ConnectionInput,
  ConnectionTestResult,
  ReadPreference,
  UuidEncoding
} from '@shared/types'

type FormState = {
  name: string
  uri: string
  username: string
  password: string
  authSource: string
  authMechanism: AuthMechanism
  tls: boolean
  serverSelectionTimeoutMS: string
  appName: string
  directConnection: boolean
  replicaSet: string
  readPreference: ReadPreference | 'default'
  uuidEncoding: UuidEncoding
  timezone: string
  authorizedOnly: boolean
  maxPoolSize: string
  minPoolSize: string
  connectTimeoutMS: string
  socketTimeoutMS: string
  retryWrites: 'default' | 'on' | 'off'
  retryReads: 'default' | 'on' | 'off'
}

const emptyForm = (): FormState => ({
  name: '',
  uri: 'mongodb://localhost:27017',
  username: '',
  password: '',
  authSource: '',
  authMechanism: 'DEFAULT',
  tls: false,
  serverSelectionTimeoutMS: '3000',
  appName: 'MongoBench',
  directConnection: false,
  replicaSet: '',
  readPreference: 'default',
  uuidEncoding: 'default',
  timezone: 'UTC',
  authorizedOnly: false,
  maxPoolSize: '',
  minPoolSize: '',
  connectTimeoutMS: '',
  socketTimeoutMS: '',
  retryWrites: 'default',
  retryReads: 'default'
})

const fromConnection = (conn: ConnectionConfig): FormState => ({
  name: conn.name,
  uri: conn.uri,
  username: conn.username ?? '',
  password: '',
  authSource: conn.authSource ?? '',
  authMechanism: conn.authMechanism ?? 'DEFAULT',
  tls: conn.tls ?? false,
  serverSelectionTimeoutMS: String(conn.serverSelectionTimeoutMS ?? 3000),
  appName: conn.appName ?? 'MongoBench',
  directConnection: conn.directConnection ?? false,
  replicaSet: conn.replicaSet ?? '',
  readPreference: conn.readPreference ?? 'default',
  uuidEncoding: conn.uuidEncoding ?? 'default',
  timezone: conn.timezone ?? 'UTC',
  authorizedOnly: conn.authorizedOnly ?? false,
  maxPoolSize: conn.maxPoolSize !== undefined ? String(conn.maxPoolSize) : '',
  minPoolSize: conn.minPoolSize !== undefined ? String(conn.minPoolSize) : '',
  connectTimeoutMS: conn.connectTimeoutMS !== undefined ? String(conn.connectTimeoutMS) : '',
  socketTimeoutMS: conn.socketTimeoutMS !== undefined ? String(conn.socketTimeoutMS) : '',
  retryWrites: conn.retryWrites === undefined ? 'default' : conn.retryWrites ? 'on' : 'off',
  retryReads: conn.retryReads === undefined ? 'default' : conn.retryReads ? 'on' : 'off'
})

const parseInt = (raw: string): number | undefined => {
  if (raw.trim().length === 0) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function buildInput(form: FormState): ConnectionInput {
  const input: ConnectionInput = {
    name: form.name.trim(),
    uri: form.uri.trim()
  }
  if (form.username.trim().length > 0) input.username = form.username.trim()
  if (form.password.length > 0) input.password = form.password
  if (form.authSource.trim().length > 0) input.authSource = form.authSource.trim()
  if (form.authMechanism !== 'DEFAULT') input.authMechanism = form.authMechanism
  if (form.tls) input.tls = true
  const sst = parseInt(form.serverSelectionTimeoutMS)
  if (sst !== undefined) input.serverSelectionTimeoutMS = sst
  if (form.appName.trim().length > 0) input.appName = form.appName.trim()
  if (form.directConnection) input.directConnection = true
  if (form.replicaSet.trim().length > 0) input.replicaSet = form.replicaSet.trim()
  if (form.readPreference !== 'default') input.readPreference = form.readPreference
  if (form.uuidEncoding !== 'default') input.uuidEncoding = form.uuidEncoding
  if (form.timezone.trim().length > 0 && form.timezone.trim() !== 'UTC') {
    input.timezone = form.timezone.trim()
  }
  if (form.authorizedOnly) input.authorizedOnly = true
  const maxPool = parseInt(form.maxPoolSize)
  if (maxPool !== undefined) input.maxPoolSize = maxPool
  const minPool = parseInt(form.minPoolSize)
  if (minPool !== undefined) input.minPoolSize = minPool
  const ct = parseInt(form.connectTimeoutMS)
  if (ct !== undefined) input.connectTimeoutMS = ct
  const st = parseInt(form.socketTimeoutMS)
  if (st !== undefined) input.socketTimeoutMS = st
  if (form.retryWrites !== 'default') input.retryWrites = form.retryWrites === 'on'
  if (form.retryReads !== 'default') input.retryReads = form.retryReads === 'on'
  return input
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  connection?: ConnectionConfig
}

export function ConnectionFormDialog({ open, onOpenChange, connection }: Props) {
  const isEdit = connection !== undefined
  const [form, setForm] = useState<FormState>(emptyForm)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!open) return
    setForm(connection ? fromConnection(connection) : emptyForm())
    setTestResult(null)
    setTestError(null)
    setAdvancedOpen(false)
  }, [open, connection])

  const input = useMemo(() => buildInput(form), [form])

  const validation = useMemo(() => {
    if (input.name.length === 0) return 'Name is required'
    if (input.uri.length === 0) return 'URI is required'
    if (!input.uri.startsWith('mongodb://') && !input.uri.startsWith('mongodb+srv://')) {
      return 'URI must start with mongodb:// or mongodb+srv://'
    }
    return null
  }, [input])

  const testMutation = useMutation({
    mutationFn: () => api.connections.test(input, connection?.id),
    onSuccess: (result) => {
      setTestResult(result)
      setTestError(null)
    },
    onError: (error: unknown) => {
      setTestResult(null)
      setTestError(error instanceof ApiError ? error.message : String(error))
    }
  })

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (isEdit && connection) {
        return api.connections.update({ id: connection.id, patch: input })
      }
      return api.connections.create(input)
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.connections })
      toast.success(`${saved.name} ${isEdit ? 'updated' : 'created'}`)
      onOpenChange(false)
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.message : String(error)
      toast.error(`Failed to save: ${message}`)
    }
  })

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit connection' : 'New connection'}</DialogTitle>
          <DialogDescription>
            Connection strings, credentials, and per-connection options. Passwords are stored
            encrypted via the OS keystore.
          </DialogDescription>
        </DialogHeader>

        <div className="-mr-2 grid min-h-0 flex-1 gap-5 overflow-y-auto pr-2">
          <Field label="Name" htmlFor="conn-name">
            <Input
              id="conn-name"
              placeholder="Local development"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              autoFocus
            />
          </Field>

          <Field
            label="Connection string"
            htmlFor="conn-uri"
            hint="mongodb:// or mongodb+srv:// — credentials may be embedded or filled below."
          >
            <Input
              id="conn-uri"
              placeholder="mongodb://user:password@host:27017/db"
              value={form.uri}
              onChange={(e) => update('uri', e.target.value)}
              spellCheck={false}
              className="font-mono text-xs"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Username" htmlFor="conn-username">
              <Input
                id="conn-username"
                value={form.username}
                onChange={(e) => update('username', e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field
              label={isEdit && connection?.hasStoredPassword ? 'Password (saved)' : 'Password'}
              htmlFor="conn-password"
              hint={
                isEdit && connection?.hasStoredPassword
                  ? 'Leave blank to keep the saved password.'
                  : undefined
              }
            >
              <Input
                id="conn-password"
                type="password"
                value={form.password}
                onChange={(e) => update('password', e.target.value)}
                autoComplete="new-password"
                placeholder={isEdit && connection?.hasStoredPassword ? '••••••••' : 'optional'}
              />
            </Field>
          </div>

          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="-mx-1 flex items-center gap-1 rounded-md px-1 py-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          >
            {advancedOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Advanced options
          </button>

          {advancedOpen && (
            <div className="grid gap-5 rounded-md border bg-card/40 p-4">
              <Section title="Authentication">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Auth mechanism" htmlFor="conn-mech">
                    <Select
                      value={form.authMechanism}
                      onValueChange={(v) => update('authMechanism', v as AuthMechanism)}
                    >
                      <SelectTrigger id="conn-mech">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="DEFAULT">Default</SelectItem>
                        <SelectItem value="SCRAM-SHA-256">SCRAM-SHA-256</SelectItem>
                        <SelectItem value="SCRAM-SHA-1">SCRAM-SHA-1</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Auth source" htmlFor="conn-authsource">
                    <Input
                      id="conn-authsource"
                      placeholder="admin"
                      value={form.authSource}
                      onChange={(e) => update('authSource', e.target.value)}
                    />
                  </Field>
                </div>
              </Section>

              <Section title="Topology">
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label="Replica set"
                    htmlFor="conn-rs"
                    hint="Optional explicit replica-set name."
                  >
                    <Input
                      id="conn-rs"
                      placeholder="rs0"
                      value={form.replicaSet}
                      onChange={(e) => update('replicaSet', e.target.value)}
                    />
                  </Field>
                  <Field label="Read preference" htmlFor="conn-readpref">
                    <Select
                      value={form.readPreference}
                      onValueChange={(v) =>
                        update('readPreference', v as FormState['readPreference'])
                      }
                    >
                      <SelectTrigger id="conn-readpref">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Default (primary)</SelectItem>
                        <SelectItem value="primary">primary</SelectItem>
                        <SelectItem value="primaryPreferred">primaryPreferred</SelectItem>
                        <SelectItem value="secondary">secondary</SelectItem>
                        <SelectItem value="secondaryPreferred">secondaryPreferred</SelectItem>
                        <SelectItem value="nearest">nearest</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <ToggleRow
                  id="conn-direct"
                  label="Direct connection"
                  hint="Skip topology discovery, talk to one node only."
                  checked={form.directConnection}
                  onCheckedChange={(v) => update('directConnection', v)}
                />
              </Section>

              <Section title="Pool & timeouts">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Max pool size" htmlFor="conn-maxpool">
                    <Input
                      id="conn-maxpool"
                      type="number"
                      min={1}
                      max={10000}
                      placeholder="100"
                      value={form.maxPoolSize}
                      onChange={(e) => update('maxPoolSize', e.target.value)}
                    />
                  </Field>
                  <Field label="Min pool size" htmlFor="conn-minpool">
                    <Input
                      id="conn-minpool"
                      type="number"
                      min={0}
                      max={10000}
                      placeholder="0"
                      value={form.minPoolSize}
                      onChange={(e) => update('minPoolSize', e.target.value)}
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Connect (ms)" htmlFor="conn-ctimeout">
                    <Input
                      id="conn-ctimeout"
                      type="number"
                      min={500}
                      max={120000}
                      placeholder="30000"
                      value={form.connectTimeoutMS}
                      onChange={(e) => update('connectTimeoutMS', e.target.value)}
                    />
                  </Field>
                  <Field label="Socket (ms)" htmlFor="conn-stimeout">
                    <Input
                      id="conn-stimeout"
                      type="number"
                      min={500}
                      max={600000}
                      placeholder="0 = off"
                      value={form.socketTimeoutMS}
                      onChange={(e) => update('socketTimeoutMS', e.target.value)}
                    />
                  </Field>
                  <Field label="Server select (ms)" htmlFor="conn-timeout">
                    <Input
                      id="conn-timeout"
                      type="number"
                      min={1000}
                      max={60000}
                      value={form.serverSelectionTimeoutMS}
                      onChange={(e) => update('serverSelectionTimeoutMS', e.target.value)}
                    />
                  </Field>
                </div>
              </Section>

              <Section title="Behavior">
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label="UUID encoding"
                    htmlFor="conn-uuid"
                    hint="How BSON Binary values render in the table."
                  >
                    <Select
                      value={form.uuidEncoding}
                      onValueChange={(v) => update('uuidEncoding', v as UuidEncoding)}
                    >
                      <SelectTrigger id="conn-uuid">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Default — only subType 04</SelectItem>
                        <SelectItem value="java">Java legacy — also subType 03</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="App name" htmlFor="conn-appname">
                    <Input
                      id="conn-appname"
                      value={form.appName}
                      onChange={(e) => update('appName', e.target.value)}
                    />
                  </Field>
                </div>
                <Field
                  label="Display timezone"
                  htmlFor="conn-tz"
                  hint="Dates render in this zone in the table and editor. Stored values stay UTC."
                >
                  <TimezoneSelect
                    id="conn-tz"
                    value={form.timezone}
                    onChange={(v) => update('timezone', v)}
                  />
                </Field>
                <ToggleRow
                  id="conn-auth-only"
                  label="Hide databases without permissions"
                  hint="Only list databases and collections the authenticated user has any privilege on. Off shows everything the server returns."
                  checked={form.authorizedOnly}
                  onCheckedChange={(v) => update('authorizedOnly', v)}
                />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Retry writes" htmlFor="conn-rwrites">
                    <Select
                      value={form.retryWrites}
                      onValueChange={(v) => update('retryWrites', v as FormState['retryWrites'])}
                    >
                      <SelectTrigger id="conn-rwrites">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Default</SelectItem>
                        <SelectItem value="on">On</SelectItem>
                        <SelectItem value="off">Off</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Retry reads" htmlFor="conn-rreads">
                    <Select
                      value={form.retryReads}
                      onValueChange={(v) => update('retryReads', v as FormState['retryReads'])}
                    >
                      <SelectTrigger id="conn-rreads">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Default</SelectItem>
                        <SelectItem value="on">On</SelectItem>
                        <SelectItem value="off">Off</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
              </Section>

              <Section title="TLS / SSL">
                <ToggleRow
                  id="conn-tls"
                  label="Use TLS"
                  hint="Enabled automatically for mongodb+srv://."
                  checked={form.tls}
                  onCheckedChange={(v) => update('tls', v)}
                />
              </Section>
            </div>
          )}

          <TestStatus pending={testMutation.isPending} result={testResult} error={testError} />
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => testMutation.mutate()}
            disabled={validation !== null || testMutation.isPending || saveMutation.isPending}
          >
            {testMutation.isPending && <Loader2 className="animate-spin" />}
            Test connection
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={validation !== null || saveMutation.isPending}
          >
            {saveMutation.isPending && <Loader2 className="animate-spin" />}
            {isEdit ? 'Save changes' : 'Create connection'}
          </Button>
        </DialogFooter>

        {validation !== null && <p className="text-xs text-destructive">{validation}</p>}
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  htmlFor,
  hint,
  children
}: {
  label: string
  htmlFor: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <Label
        htmlFor={htmlFor}
        className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
      >
        {label}
      </Label>
      {children}
      {hint && <p className="text-[10px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
        {title}
      </h3>
      <div className="grid gap-3">{children}</div>
    </section>
  )
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onCheckedChange
}: {
  id: string
  label: string
  hint?: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/40 px-3 py-2">
      <div className="grid min-w-0 gap-0.5">
        <Label htmlFor={id} className="cursor-pointer text-xs font-medium">
          {label}
        </Label>
        {hint && <span className="text-[10px] leading-snug text-muted-foreground">{hint}</span>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function TestStatus({
  pending,
  result,
  error
}: {
  pending: boolean
  result: ConnectionTestResult | null
  error: string | null
}) {
  if (!pending && !result && !error) return null
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md border p-3 text-sm',
        result?.ok && 'border-success/30 bg-success/5 text-success',
        error !== null && 'border-destructive/30 bg-destructive/5 text-destructive',
        pending && 'border-border bg-card text-muted-foreground'
      )}
    >
      {pending && <Loader2 className="mt-0.5 h-4 w-4 animate-spin" />}
      {result?.ok && <CheckCircle2 className="mt-0.5 h-4 w-4" />}
      {error !== null && <XCircle className="mt-0.5 h-4 w-4" />}
      <div className="flex-1">
        {pending && 'Probing server…'}
        {result?.ok && (
          <>
            <div className="font-medium">Connected</div>
            <div className="text-xs opacity-80">
              {result.serverVersion ? `MongoDB ${result.serverVersion} · ` : ''}
              {result.latencyMs} ms latency
            </div>
          </>
        )}
        {error !== null && (
          <>
            <div className="font-medium">Connection failed</div>
            <div className="text-xs opacity-80">{error}</div>
          </>
        )}
      </div>
    </div>
  )
}
