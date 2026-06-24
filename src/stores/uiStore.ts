import { create } from 'zustand'

type Toast = {
  id: string
  message: string
  type: 'success' | 'error' | 'info'
  undoFn?: () => void
}

type UiStore = {
  toasts: Toast[]
  isOffline: boolean
  pendingWrites: number
  addToast: (message: string, type: Toast['type'], undoFn?: () => void) => void
  removeToast: (id: string) => void
  setOffline: (offline: boolean) => void
  setPendingWrites: (count: number) => void
}

export const useUiStore = create<UiStore>((set) => ({
  toasts: [],
  isOffline: false,
  pendingWrites: 0,
  addToast: (message, type, undoFn) => {
    const id = crypto.randomUUID()
    set((state) => ({ toasts: [...state.toasts, { id, message, type, undoFn }] }))
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }, 4000)
  },
  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  setOffline: (isOffline) => set({ isOffline }),
  setPendingWrites: (pendingWrites) => set({ pendingWrites }),
}))
