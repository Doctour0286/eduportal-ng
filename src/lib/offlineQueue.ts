// Offline-first write queue.
//
// Persists queued writes to IndexedDB so they survive a page reload, app
// restart, or the browser/webview killing the tab in the background — the
// previous version held everything in a plain in-memory array and silently
// lost every queued write on refresh.
//
// Storage is isolated behind a small adapter (see `storageAdapter` below) so
// this stays portable: swap the adapter for one backed by AsyncStorage/SQLite
// and the queueWrite/getQueue/clearFromQueue/queueSize API below — and every
// call site in services/* — needs no changes if this app is ever ported to
// React Native. No `window`/`document` references leak outside the adapter.

export type QueuedWrite = {
  id: string
  table: string
  operation: 'insert' | 'update' | 'delete'
  payload: Record<string, unknown>
  timestamp: number
}

// ─── Storage adapter ───────────────────────────────────────────────────────
// Swap this implementation to port to a different persistence layer
// (e.g. React Native + AsyncStorage/SQLite). Callers below never touch
// IndexedDB directly.

interface QueueStorageAdapter {
  getAll(): Promise<QueuedWrite[]>
  put(item: QueuedWrite): Promise<void>
  remove(id: string): Promise<void>
}

const DB_NAME = 'eduskola_offline'
const DB_VERSION = 1
const STORE_NAME = 'write_queue'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// IndexedDB-backed adapter. Used whenever the API is available (browser tabs
// and Capacitor/webview-wrapped native builds both have it).
class IndexedDbAdapter implements QueueStorageAdapter {
  private dbPromise: Promise<IDBDatabase> | null = null

  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDb()
    return this.dbPromise
  }

  async getAll(): Promise<QueuedWrite[]> {
    const db = await this.getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).getAll()
      request.onsuccess = () => resolve(request.result as QueuedWrite[])
      request.onerror = () => reject(request.error)
    })
  }

  async put(item: QueuedWrite): Promise<void> {
    const db = await this.getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(item)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  async remove(id: string): Promise<void> {
    const db = await this.getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }
}

// Last-resort fallback for environments with no IndexedDB (very old browsers,
// some test/SSR contexts). Not persisted — same behaviour as the old queue.
// This only exists so the app never throws; it does not solve offline
// durability by itself.
class InMemoryAdapter implements QueueStorageAdapter {
  private items = new Map<string, QueuedWrite>()

  async getAll(): Promise<QueuedWrite[]> {
    return [...this.items.values()]
  }

  async put(item: QueuedWrite): Promise<void> {
    this.items.set(item.id, item)
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id)
  }
}

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined'
  } catch {
    return false
  }
}

const storageAdapter: QueueStorageAdapter = hasIndexedDb()
  ? new IndexedDbAdapter()
  : new InMemoryAdapter()

if (!hasIndexedDb()) {
  // eslint-disable-next-line no-console
  console.warn(
    'offlineQueue: IndexedDB unavailable — falling back to in-memory queue. ' +
      'Queued writes will NOT survive a reload/restart in this environment.'
  )
}

// ─── Public API ─────────────────────────────────────────────────────────────
// Same shape as before, now async because persistence requires it. Every
// existing call site sits inside an already-`async` function, so callers
// just need `await` added in front of each call.

export async function queueWrite(
  table: string,
  operation: QueuedWrite['operation'],
  payload: Record<string, unknown>
): Promise<string> {
  const id = crypto.randomUUID()
  await storageAdapter.put({ id, table, operation, payload, timestamp: Date.now() })
  return id
}

export async function getQueue(): Promise<QueuedWrite[]> {
  return storageAdapter.getAll()
}

export async function clearFromQueue(id: string): Promise<void> {
  await storageAdapter.remove(id)
}

export async function queueSize(): Promise<number> {
  const all = await storageAdapter.getAll()
  return all.length
}
