import { Database } from 'lucide-react'

export function Welcome() {
  return (
    <section className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
        <Database className="h-7 w-7" />
      </div>
      <h2 className="text-xl font-semibold tracking-tight">Pick a collection</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Connect to a server in the sidebar, expand a database, and click a collection to open it
        here.
      </p>
    </section>
  )
}
