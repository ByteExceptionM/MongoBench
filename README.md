# MongoBench

A modern, dark-mode-first MongoDB GUI. Built as a daily-driver alternative to MongoDB Compass.

> Status: early development

## Stack

- Electron + TypeScript (strict)
- Vite via `electron-vite` (separate main / preload / renderer builds)
- React 18, Zustand, TanStack Query
- Tailwind CSS + shadcn/ui
- Official `mongodb` Node.js driver, `bson` for EJSON (added in M1)

## Scripts

| Command             | What it does                                          |
| ------------------- | ----------------------------------------------------- |
| `npm run dev`       | Launch the app in development mode with HMR           |
| `npm run build`     | Build all three processes for production into `out/`  |
| `npm run typecheck` | Run the TypeScript project-references build (no emit) |
| `npm run lint`      | ESLint over `src/`                                    |
| `npm run format`    | Apply Prettier                                        |
| `npm test`          | Run Vitest                                            |

## Project layout

```
src/
├── main/      # Node.js side: window, services, IPC handlers
├── preload/   # contextBridge — typed API exposed to the renderer
├── renderer/  # React UI (Vite)
└── shared/    # Types and Zod schemas shared across processes
```

## License

MIT
