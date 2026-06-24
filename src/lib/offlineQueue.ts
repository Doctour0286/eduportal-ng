// Offline-first pattern carried forward from old madrasah app.
// Business logic only — no localStorage, no window references (React Native safe).

type QueuedWrite = {
  id: string
  table: string
  operation: 'insert' | 'update' | 'delete'
  payload: Record<string, unknown>
  timestamp: number
}

const queue: QueuedWrite[] = []

export function queueWrite(
  table: string,
  operation: QueuedWrite['operation'],
  payload: Record<string, unknown>
): string {
  const id = crypto.randomUUID()
  queue.push({ id, table, operation, payload, timestamp: Date.now() })
  return id
}

export function getQueue(): QueuedWrite[] {
  return [...queue]
}

export function clearFromQueue(id: string): void {
  const index = queue.findIndex(item => item.id === id)
  if (index !== -1) queue.splice(index, 1)
}

export function queueSize(): number {
  return queue.length
}
