import { create } from 'zustand'

type AppState = {
  activeConnectionIds: Set<string>
  markConnected: (id: string) => void
  markDisconnected: (id: string) => void
}

export const useAppStore = create<AppState>((set) => ({
  activeConnectionIds: new Set<string>(),
  markConnected: (id) =>
    set((state) => {
      const next = new Set(state.activeConnectionIds)
      next.add(id)
      return { activeConnectionIds: next }
    }),
  markDisconnected: (id) =>
    set((state) => {
      const next = new Set(state.activeConnectionIds)
      next.delete(id)
      return { activeConnectionIds: next }
    })
}))
