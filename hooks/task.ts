import type { ItemStatus, Task, TaskItem } from '../types'

/**
 * The task list Claude keeps while it works, read from its own tool calls:
 * the desktop app's plan (mcp__ccd_turn__update_plan / wrap_up), TodoWrite
 * (terminal, VS Code) and TaskCreate / TaskUpdate (newer builds).
 */

type Args = Record<string, unknown>

const PLAN = 'mcp__ccd_turn__update_plan'
const WRAP = 'mcp__ccd_turn__wrap_up'

export const TASK_TOOLS = new Set([PLAN, WRAP, 'TodoWrite', 'TaskCreate', 'TaskUpdate'])

function status(value: unknown): ItemStatus {
  return value === 'completed' || value === 'in_progress' ? value : 'pending'
}

function isOver(task: Task | null): boolean {
  return task === null || task.finishedAt !== null || task.items.every(i => i.status === 'completed')
}

/** Folds a new list of items into the task, timing each new completion. */
function settle(prev: Task | null, items: TaskItem[], now: number, source: string): Task | null {
  if (items.length === 0) return null
  const fresh = isOver(prev)
  const base: Task = fresh || !prev
    ? { startedAt: now, items: [], doneAt: [], finishedAt: null, source }
    : prev
  const doneNow = items.filter(i => i.status === 'completed').length
  const doneAt = base.doneAt.slice(0, doneNow)
  for (let n = doneAt.length; n < doneNow; n += 1) doneAt.push(now)
  return {
    ...base,
    items,
    doneAt,
    finishedAt: doneNow === items.length ? now : null,
    source,
  }
}

function fromPlan(prev: Task | null, a: Args, now: number): Task | null {
  if (Array.isArray(a.items)) {
    const items = (a.items as Array<{ content?: unknown; status?: unknown }>).map(i => ({
      text: String(i.content ?? ''),
      status: status(i.status),
    }))
    return settle(isOver(prev) ? null : prev, items, now, 'plan')
  }
  if (!prev) return null
  const items = prev.items.map(i => ({ ...i }))
  if (a.advance === true) {
    const at = items.findIndex(i => i.status === 'in_progress')
    const running = items[at]
    if (running) running.status = 'completed'
    const next = items.find((i, n) => n > at && i.status === 'pending')
    if (next) next.status = 'in_progress'
  }
  if (Array.isArray(a.done)) {
    for (const n of a.done as number[]) {
      const item = items[n - 1]
      if (item) item.status = 'completed'
    }
  }
  const started = typeof a.start === 'number' ? items[a.start - 1] : undefined
  if (started) {
    for (const i of items) if (i.status === 'in_progress') i.status = 'pending'
    started.status = 'in_progress'
  }
  return settle(prev, items, now, 'plan')
}

/** The task after a tool call, or `undefined` when the call changes nothing. */
export function applyToolCall(prev: Task | null, tool: string, a: Args, now: number, createdId?: string): Task | null | undefined {
  if (tool === PLAN) return fromPlan(prev, a, now)
  if (tool === WRAP) {
    if (!prev || prev.finishedAt !== null) return undefined
    const items = prev.items.map(i => ({ ...i, status: 'completed' as const }))
    return settle(prev, items, now, prev.source)
  }
  if (tool === 'TodoWrite' && Array.isArray(a.todos)) {
    const items = (a.todos as Array<{ content?: unknown; status?: unknown }>).map(i => ({
      text: String(i.content ?? ''),
      status: status(i.status),
    }))
    return settle(prev, items, now, 'todo')
  }
  if (tool === 'TaskCreate') {
    const base = isOver(prev) ? [] : (prev?.items ?? [])
    const id = createdId ?? String(base.length + 1)
    const items = [...base, { text: String(a.subject ?? ''), status: 'pending' as const, id }]
    return settle(isOver(prev) ? null : prev, items, now, 'tasks')
  }
  if (tool === 'TaskUpdate' && prev) {
    const id = String(a.taskId ?? '')
    if (a.status === 'deleted') {
      return settle(prev, prev.items.filter(i => i.id !== id), now, prev.source)
    }
    if (a.status === undefined) return undefined
    const items = prev.items.map(i => (i.id === id ? { ...i, status: status(a.status) } : i))
    return settle(prev, items, now, prev.source)
  }
  return undefined
}

export type Estimate = {
  done: number
  total: number
  pct: number
  elapsedMs: number
  remainingMs: number | null
  totalMs: number | null
  current: string | null
}

/**
 * Time left: the pace of the steps finished so far, blended with the average
 * step of earlier tasks (learned across sessions) while few steps are done.
 */
export function estimate(task: Task, now: number, avgStepMs: number | null): Estimate {
  const total = task.items.length
  const done = task.items.filter(i => i.status === 'completed').length
  const end = task.finishedAt ?? now
  const elapsedMs = Math.max(0, end - task.startedAt)
  const current = task.items.find(i => i.status === 'in_progress')?.text ?? null
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  if (task.finishedAt !== null) {
    return { done, total, pct: 100, elapsedMs, remainingMs: 0, totalMs: elapsedMs, current: null }
  }
  const lastDone = task.doneAt[task.doneAt.length - 1] ?? task.startedAt
  const observed = done > 0 ? (lastDone - task.startedAt) / done : null
  let perStep: number | null = observed
  if (avgStepMs !== null) {
    perStep = observed === null ? avgStepMs : (observed * done + avgStepMs * 2) / (done + 2)
  }
  if (perStep === null) {
    return { done, total, pct, elapsedMs, remainingMs: null, totalMs: null, current }
  }
  const left = total - done
  const sinceLast = now - lastDone
  // The step running now has used part of its time already.
  const remainingMs = Math.max(perStep * left - sinceLast, perStep * 0.15 * left)
  return { done, total, pct, elapsedMs, remainingMs, totalMs: elapsedMs + remainingMs, current }
}
