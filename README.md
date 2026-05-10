<div align="center">

# MongoBench

A modern, dark-mode-first MongoDB GUI. Built as a daily-driver alternative to MongoDB Compass, focused on speed, density, and a polished editing experience.

[![Latest release](https://img.shields.io/github/v/release/ByteExceptionM/MongoBench?color=21DCEF&style=flat-square)](https://github.com/ByteExceptionM/MongoBench/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-1F232C?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/ByteExceptionM/MongoBench/ci.yml?branch=main&style=flat-square)](https://github.com/ByteExceptionM/MongoBench/actions)

</div>

![MongoBench main view](https://i.masel.io/ZIXO8/HokIQaKU21.png/raw)

## Highlights

- **Multiple connections, side-by-side.** Connect to as many clusters as you want; each runs an independent pool. Drag-reorder them in the sidebar, manage them with right-click context menus.
- **Three query modes per tab.** Switch a single tab between **Simple** (filter / projection / sort), **Aggregation** pipeline, and **Shell** (`db.coll.find().limit()` syntax) without losing state.
- **Mongo shell syntax everywhere.** Type `ObjectId("…")`, `ISODate("…")`, `UUID("…")`, `NumberLong("…")` etc. directly in filters and editors — MongoBench parses it into canonical EJSON before sending.
- **Optimistic concurrency on writes.** Every edit and delete includes a sha-256 hash precondition of the document; concurrent edits surface as conflicts instead of silently overwriting.
- **Built-in observability.** Per-connection dashboard with op rate, read/write/command latency, connection pool state, cache fill, network throughput, and a per-database storage breakdown.
- **Auto-update on Windows and Linux** via `electron-updater`, pulling directly from this repo's GitHub Releases.

## Screenshots

### Welcome screen

Saved connections at a glance with quick-connect buttons and inline tips.

![Welcome screen](https://i.masel.io/ZIXO8/pIrEHaLi39.png/raw)

### Connection form

Full driver-option surface — auth, topology, pool, timeouts, UUID encoding, display timezone.

![New connection dialog](https://i.masel.io/ZIXO8/huKuWAvE28.png/raw)

### Connection dashboard

Live per-connection stats. The hero shot above is the Overview tab; the Health tab focuses on document throughput, cursors, asserts, and a per-database breakdown.

![Connection dashboard — health](https://i.masel.io/ZIXO8/fogaDuMu69.png/raw)

### Document table

Type-aware rendering — `ObjectId`, `Date`, `Decimal128`, `UUID`, `Long`, `Binary`, regex — each with its own kind badge.

![Document table](https://i.masel.io/ZIXO8/NUlUBopA45.png/raw)

### Document row context menu

Right-click any row for **View**, **Edit**, **Duplicate**, **Copy**, **Delete**, plus a **Lookup ObjectId in…** submenu that jumps to the referencing collection.

![Row context menu with cross-collection ObjectId lookup](https://i.masel.io/ZIXO8/xOMAzUja46.png/raw)

### Document editor

Monaco editor with mongo shell helpers (`ObjectId(…)`, `ISODate(…)`, `NumberDecimal(…)`, `UUID(…)`). Hash-protected writes, view / edit / duplicate / insert modes.

![Edit document dialog](https://i.masel.io/ZIXO8/XEQaXIko38.png/raw)

### Query autocomplete

Operator autocomplete (`$eq`, `$in`, `$elemMatch`, `$geoWithin`, …) and field-name autocomplete from the most recent results.

![Operator autocomplete](https://i.masel.io/ZIXO8/mIhavoWU58.png/raw)
![Field-name autocomplete](https://i.masel.io/ZIXO8/KiTUxUkA81.png/raw)

### Indexes

Per-collection index manager — list with key spec, properties, size; create with full option surface (TTL, partial filter, collation, weights, 2dsphere, wildcard).

![Indexes dialog](https://i.masel.io/ZIXO8/ZuzImILI62.png/raw)

### Users

Per-database user management. Common-role shortcuts plus arbitrary custom roles.

![Manage users](https://i.masel.io/ZIXO8/royEDozi90.png/raw)
![New user dialog](https://i.masel.io/ZIXO8/codOjUZU83.png/raw)

### Command palette

`Ctrl+K` / `Cmd+K` — fuzzy subsequence search across every active connection, database, and collection. Picking a result expands the sidebar and scrolls the row into view.

![Command palette — connections](https://i.masel.io/ZIXO8/HeCAzubE08.png/raw)
![Command palette — collection search](https://i.masel.io/ZIXO8/RUcUvaJu02.png/raw)

## Features

### Connections

- Multiple **active connections** simultaneously, each with its own pool
- **Encrypted password storage** via OS keystore (Windows DPAPI, libsecret on Linux)
- **Test before save** — probes server, reports MongoDB version + ping latency
- **Drag-to-reorder** saved connections in the sidebar
- **Right-click context menu** per connection: connect / disconnect, edit, delete, new database, refresh, copy URI
- Full driver option surface, persisted per connection:
  - URI: `mongodb://` and `mongodb+srv://`
  - Auth: `SCRAM-SHA-256`, `SCRAM-SHA-1`, `DEFAULT`, custom `authSource`
  - Topology: `directConnection`, `replicaSet`, `readPreference` (5 modes)
  - Pool: `minPoolSize`, `maxPoolSize`
  - Timeouts: `connectTimeoutMS`, `socketTimeoutMS`, `serverSelectionTimeoutMS`
  - Behavior: `retryWrites`, `retryReads`, `appName`, `tls`
  - Display: `uuidEncoding` (default / Java legacy), IANA `timezone`, `authorizedOnly` filter

### Explorer

- Three-level tree: **connection → database → collection**
- Live status dot per connection (connected / disconnected / busy)
- Right-click on a **database**: new collection, manage users, drop, copy name
- Right-click on a **collection**: open, info, copy namespace, insert document, manage indexes, rename, drop
- Distinct icons for **collections vs. views**
- Hover-quick-create buttons on database rows
- Active tab is highlighted in the sidebar; opening a tab from the palette auto-expands and scrolls to the row

### Query modes

| Mode            | Surface                                   | Highlights                                                                                                             |
| --------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Simple**      | filter · projection · sort · skip · limit | EJSON or shell syntax, field-name autocomplete from last results                                                       |
| **Aggregation** | pipeline as `[{ $match: … }, …]`          | Monaco, full operator autocomplete                                                                                     |
| **Shell**       | `db.coll.find({…}).sort({…}).limit(n)`    | Curated subset of mongosh syntax — `find`, `findOne`, `aggregate`, `count`, `countDocuments`, `estimatedDocumentCount` |

- **Run:** click button or `Ctrl+Enter` / `Cmd+Enter`
- **Format:** `Shift+Alt+F` — custom formatter that preserves shell helpers
- **Operator autocomplete** for every standard query operator (`$eq`, `$in`, `$elemMatch`, `$geoWithin`, `$jsonSchema`, …)

### Documents

- Auto-sized table columns, drag-to-resize, per-collection persistence
- Multi-select with `Shift+Click` range select
- Right-click row: **view, edit, duplicate, delete, copy `_id`, jump to referenced ObjectId** (cross-collection lookup submenu)
- **View / edit modes:**
  - Canonical EJSON (`{ "$oid": "…" }`, `{ "$date": "…" }`, …) or relaxed display
  - Shell-syntax accepted on input, parsed before send
  - sha-256 hash precondition on `replaceOne` / `deleteOne` to catch concurrent edits
- **Bulk delete** via multi-select + confirm
- **Export** the current result set as JSON, CSV or TSV
- **Type-aware rendering** in the table:
  - `ObjectId` as hex string with kind badge
  - `Date` rendered in the connection's display timezone (IANA)
  - `UUID` (BSON subType 4 always; subType 3 only if `uuidEncoding: "java"`, with byte-reversal)
  - `Decimal128`, `Long` as exact strings
  - `Binary`, `Regex`, nested objects / arrays summarized

### Indexes

- List with name, key spec, type (1/-1/text/2dsphere/2d/hashed), TTL, uniqueness, sparseness, hidden flag, partial filter, collation, weights
- Create with full option surface: `unique`, `sparse`, `hidden`, `expireAfterSeconds`, `partialFilterExpression`, `collation`, `weights`, `default_language`, `language_override`, `textIndexVersion`, `2dsphereIndexVersion`, `bits`, `min`, `max`, `wildcardProjection`
- Drop with confirmation (`_id` index protected)
- Per-index size from `collStats`

### Users

- List per-database users with their roles
- Create with username, password, role assignments per database
- Common-role shortcuts: `read`, `readWrite`, `dbAdmin`, `dbOwner`, `userAdmin` — plus arbitrary custom roles
- Update password and / or roles independently (preserve unchanged fields)
- Drop with confirmation

### Database & collection ops

- Create / drop database (with confirmation, closes affected tabs)
- Create / rename / drop collection
- **Collection info dialog**: namespace, document count, average doc size, storage size (compressed + uncompressed), index count, free space, capped status

### Connection dashboard

Per-connection live view, sampled every 5 s, sliding 5-min history:

- **KPIs:** ops/sec, current connections (with cap), cache fill %, resident memory, total storage
- **Charts** with hover crosshair + tooltips:
  - Operation latency (read / write / command, µs)
  - Operations breakdown (query / insert / update / delete / getmore / command)
  - Network throughput (bytes in / out)
- **Storage pie:** top databases + aggregated "other" wedge, total in the center

### Command palette

- Trigger: `Ctrl+K` / `Cmd+K`
- Fuzzy subsequence matching with prefix-aware scoring across **all active connections** (databases + collections + saved connections)
- Pre-fetches collection metadata when opened so search is instant
- Result actions: open collection (auto-expand + scroll in sidebar), connect / disconnect

### Visual & interaction polish

- **Dark theme** with cool, neutral palette — no warm undertones
- **Geist Variable** for UI, **JetBrains Mono** for code; tabular numerals throughout
- Custom **Monaco theme** matching the app palette
- **Custom scrollbars** (Chromium): 10 px, transparent track, primary-tinted on grab
- **Status indicators** everywhere: spinners on pending operations, success / error toasts, hash-protected badges in the status bar

## Install

| Platform          | Download                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows (x64)** | `MongoBench-Setup-<version>-x64.exe` from [Releases](https://github.com/ByteExceptionM/MongoBench/releases/latest) — NSIS installer, per-user, no admin |
| **Linux (x64)**   | `MongoBench-<version>-x86_64.AppImage` — `chmod +x` and run                                                                                             |
| **Arch / AUR**    | PKGBUILD shipped under `packaging/arch/`  or via AUR: paru -S mongobench-git / yay -S mongobench-git                                                    |

Builds are **unsigned**. On first launch on Windows you'll see SmartScreen — click "More info → Run anyway".

### Auto-update

Installed builds check GitHub Releases at startup via `electron-updater`. New versions are downloaded in the background and applied on quit — no prompts, no clicks. AppImage updates self-replace; the Arch package updates via `pacman`.

## Develop

```bash
git clone https://github.com/ByteExceptionM/MongoBench
cd MongoBench
npm install
npm run dev          # launches the app with HMR
```

Useful scripts:

| Command              | What it does                                                    |
| -------------------- | --------------------------------------------------------------- |
| `npm run dev`        | Run the app with hot reload (renderer) and main-process restart |
| `npm run build`      | Build all three processes into `out/`                           |
| `npm run dist:win`   | Build a Windows NSIS installer into `dist/`                     |
| `npm run dist:linux` | Build a Linux AppImage into `dist/`                             |
| `npm run typecheck`  | TypeScript project-references build, no emit                    |
| `npm run lint`       | ESLint over `src/`                                              |
| `npm run format`     | Apply Prettier                                                  |
| `npm test`           | Vitest                                                          |

### Project layout

```
src/
├── main/        # Node side: window, services, IPC handlers, MongoClient pool
├── preload/     # contextBridge — typed API exposed to the renderer
├── renderer/    # React UI (Vite + Tailwind + shadcn/ui + Monaco)
└── shared/      # Types and Zod schemas shared across processes
```

### Stack

- **Electron 32** + **TypeScript** strict
- **electron-vite** — separate main / preload / renderer Vite configs
- **React 18** + **Zustand** + **TanStack Query**
- **Tailwind CSS v3** + **shadcn/ui** (Radix primitives)
- **Monaco** editor with custom `mongobench-dark` theme
- **mongodb** Node driver v7 + **bson** v7 (canonical / relaxed EJSON)
- **electron-builder** for packaging, **electron-updater** for self-update
- **Vitest** for unit tests

## Compatibility

- MongoDB **4.4+** (older versions may work but aren't tested)
- Auth mechanisms: `SCRAM-SHA-256`, `SCRAM-SHA-1`, `DEFAULT`
- TLS, replica sets, sharded clusters, direct connections
- IPv4 + IPv6, Atlas SRV, self-hosted, localhost

## Known limitations

- Builds are **unsigned** — Windows shows SmartScreen on first launch
- No **change-streams / live tail** UI yet
- Shell mode parses a curated subset of `db.coll.<op>(...)` syntax, not the full mongosh grammar
- macOS builds aren't published (the codebase runs on macOS in dev; binaries just aren't in the release matrix yet)

## License

[MIT](LICENSE).
