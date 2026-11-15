import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { Limits, Task, Win } from '../types'
import { dayKey, scanLedger } from './ledger'
import { TASK_TOOLS, applyToolCall } from './task'
import { drawBand, drawPane, fmtClock, spinnerSuffix, toUI, weekly, type View } from './view'

/**
 * Medidor: a band above the prompt with the task's progress and time left, the
 * plan's 5-hour and weekly windows with a projection, the month's usage, and
 * alerts before a limit runs out. `/gastos` opens the full report in a pane.
 * Everything is read locally; nothing here calls a model or spends tokens.
 */

type $T = EngineInterface

const PANE = 'medidor'
const HOUR = 3_600_000

// Change a tag when that value's fields change: an older stored value is then
// read as the initial one instead of in the wrong shape.
const taskA = atom({ plugin: 'medidor', key: 'task' } as const, null as Task | null, { shape: 'task-1' })
const limitsA = atom({ plugin: 'medidor', key: 'limits' } as const, null as Limits | null, { shape: 'limits-1' })
const ledgerA = atom({ plugin: 'medidor', key: 'ledger' } as const, null, { shape: 'ledger-1' })
const nowA = atom({ plugin: 'medidor', key: 'now' } as const, 0)
const turnA = atom({ plugin: 'medidor', key: 'turnStartedAt' } as const, null as number | null)
const ctxA = atom({ plugin: 'medidor', key: 'context' } as const, null as number | null)
const avgA = atom({ plugin: 'medidor', key: 'stepAvgMs' } as const, null as number | null)
const hiddenA = atom({ plugin: 'medidor', key: 'isHidden' } as const, false)

async function readView($: $T): Promise<View> {
  const [task, limits, ledger, tick, context, turnStartedAt, stepAvgMs, clock] = await Promise.all([
    read($, taskA),
    read($, limitsA),
    read($, ledgerA),
    read($, nowA),
    read($, ctxA),
    read($, turnA),
    read($, avgA),
    $.clock.now(),
  ])
  return { task, limits, ledger, now: Math.max(tick, clock), context, turnStartedAt, stepAvgMs }
}

function toWin(r: SessionRateLimit): Win {
  const at = r.resetsAt ? Date.parse(r.resetsAt) : NaN
  return { pct: r.percentUsed, resetsAt: Number.isFinite(at) ? at : null }
}

type Alerts = Record<string, number>

async function alertOnce($: $T, key: string, level: number, text: string) {
  const alerts = ((await $.store.get('alerts')) as Alerts | undefined) ?? {}
  if ((alerts[key] ?? 0) >= level) return
  alerts[key] = level
  const keys = Object.keys(alerts)
  for (const old of keys.slice(0, Math.max(0, keys.length - 30))) delete alerts[old]
  await $.store.set('alerts', alerts)
  $.ui.toast(text, { timeoutMs: 9000 })
}

async function checkAlerts($: $T, limits: Limits) {
  const now = await $.clock.now()
  const wk = limits.weekly
  if (wk && wk.resetsAt && wk.resetsAt > now) {
    const when = fmtClock(wk.resetsAt, now)
    const steps: Array<[number, string]> = [
      [100, `Limite semanal atingido. Ele zera ${when}.`],
      [90, `🔴 90% do limite semanal usado. Zera ${when}: guarde o resto para o essencial.`],
      [75, `⚠️ 75% do limite semanal usado. Zera ${when}.`],
      [50, `Metade do limite semanal usado. Zera ${when}.`],
    ]
    const hit = steps.find(([level]) => wk.pct >= level)
    if (hit) await alertOnce($, `week:${wk.resetsAt}`, hit[0], hit[1])

    const proj = weekly({ task: null, limits, ledger: null, now, context: null, turnStartedAt: null, stepAvgMs: null })
    if (proj?.proj !== null && proj?.proj !== undefined && proj.proj >= 100 && proj.hitAt && wk.pct < 100 && now - (wk.resetsAt - 7 * 24 * HOUR) > 12 * HOUR) {
      await alertOnce(
        $,
        `proj:${wk.resetsAt}:${dayKey(now)}`,
        1,
        `No ritmo atual o limite semanal acaba ${fmtClock(proj.hitAt, now)}, antes de zerar. Use o Sonnet para tarefas simples.`,
      )
    }
  }
  const fh = limits.fiveHour
  if (fh && fh.resetsAt && fh.resetsAt > now) {
    const when = fmtClock(fh.resetsAt, now)
    const hit = ([[95, `🔴 Janela de 5 h em 95%. Zera às ${when}.`], [80, `⚠️ Janela de 5 h em 80%. Zera às ${when}.`]] as Array<[number, string]>).find(
      ([level]) => fh.pct >= level,
    )
    if (hit) await alertOnce($, `5h:${fh.resetsAt}`, hit[0], hit[1])
  }
}

async function applyLimits($: $T, rateLimits: readonly SessionRateLimit[]) {
  if (rateLimits.length === 0) return
  const prev = await read($, limitsA)
  const next: Limits = { fiveHour: prev?.fiveHour ?? null, weekly: prev?.weekly ?? null, at: await $.clock.now() }
  for (const r of rateLimits) {
    if (r.kind === 'five_hour') next.fiveHour = toWin(r)
    if (r.kind === 'seven_day') next.weekly = toWin(r)
  }
  await update($, limitsA, () => next)
  // The windows are the account's: kept so every new session starts with them.
  await $.store.set('limits', next)
  await checkAlerts($, next)
}

// The module's own timers: a reload starts them over, which is fine.
let ticker: Timer | null = null
let scanTimer: Timer | null = null
let isScanning = false

async function refreshLedger($: $T) {
  if (isScanning) return
  isScanning = true
  try {
    const limits = await read($, limitsA)
    const now = await $.clock.now()
    const resetsAt = limits?.weekly?.resetsAt ?? null
    const weekStart = resetsAt !== null && resetsAt > now ? resetsAt - 7 * 24 * HOUR : null
    const ledger = await scanLedger($, weekStart)
    await update($, ledgerA, () => ledger)
  } catch (err) {
    $.ui.log(`medidor: não consegui somar o histórico (${String(err)})`, { to: 'debug' })
  } finally {
    isScanning = false
  }
}

async function openPane($: $T) {
  return $.ui.open({ id: PANE, title: 'Medidor de uso' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gastos',
      description: 'Abre o medidor de uso: limites, projeções e custo por modelo e projeto',
    })
    const stored = (await $.store.get('limits')) as Limits | undefined
    if (stored && typeof stored === 'object' && 'at' in stored) await update($, limitsA, () => stored)
    const avg = await $.store.get('stepAvgMs')
    if (typeof avg === 'number') await update($, avgA, () => avg)
    const usage = await $.session.usage()
    await applyLimits($, usage.rateLimits)
    if (usage.context.percent !== undefined) await update($, ctxA, () => usage.context.percent ?? null)
    void refreshLedger($)
    return next(e)
  })

  on('command.run', { command: 'gastos' }, async $ => {
    await openPane($)
    void refreshLedger($)
    return { text: 'Medidor de uso aberto.' }
  })

  // The plan's windows and the context's fill, as the engine measures them.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await applyLimits($, e.rateLimits)
    if (e.changed.includes('context') && e.context.percent !== undefined) {
      await update($, ctxA, () => e.context.percent ?? null)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) return next(e)
    const now = await $.clock.now()
    await update($, turnA, () => now)
    await update($, nowA, () => now)
    ticker?.cancel()
    ticker = $.clock.every(5000, () => {
      void $.clock.now().then(t => update($, nowA, () => t))
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    ticker?.cancel()
    ticker = null
    const now = await $.clock.now()
    await update($, turnA, () => null)
    await update($, nowA, () => now)
    scanTimer?.cancel()
    scanTimer = $.clock.after(3000, () => {
      void refreshLedger($)
    })
    return next(e)
  })

  // A finished task stays on the band until the next prompt.
  on('prompt.submit', async ($, e, next) => {
    const task = await read($, taskA)
    if (task && task.finishedAt !== null) await update($, taskA, () => null)
    return next(e)
  })

  // Claude's own task list: the desktop plan, TodoWrite, TaskCreate/Update.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!TASK_TOOLS.has(tool)) return next(e)
    const result = await next(e)
    try {
      const args = e as unknown as Record<string, unknown>
      let createdId: string | undefined
      if (tool === 'TaskCreate') {
        const m = /#(\d+)|\bTask (\d+)/.exec(JSON.stringify(result))
        createdId = m?.[1] ?? m?.[2]
      }
      const now = await $.clock.now()
      const prev = await read($, taskA)
      const task = applyToolCall(prev, tool, args, now, createdId)
      if (task !== undefined) {
        await update($, taskA, () => task)
        await update($, nowA, () => now)
        const justFinished = task !== null && task.finishedAt !== null && (prev === null || prev.finishedAt === null)
        if (justFinished && task.items.length > 0) {
          // Learn how long a step takes, for the next task's first estimate.
          const per = ((task.finishedAt ?? now) - task.startedAt) / task.items.length
          const old = await read($, avgA)
          const avg = old === null ? per : old * 0.7 + per * 0.3
          await update($, avgA, () => avg)
          await $.store.set('stepAvgMs', avg)
        }
      }
    } catch (err) {
      $.ui.log(`medidor: lista de tarefas não lida (${String(err)})`, { to: 'debug' })
    }
    return result
  })

  // The band above the prompt (terminal, desktop app, mobile).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenA))) return next(e)
    const view = await readView($)
    const tree = drawBand(toUI($.ui.resolve(e)), view, e.props.bodyColumns, e.props.isWorking, e.surface === 'desktop', () => {
      void openPane($)
    })
    return tree ?? next(e)
  })

  // VS Code has no band: the working line carries the figures instead.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'vscode') return next(e)
    const suffix = spinnerSuffix(await readView($))
    if (suffix === '') return next(e)
    return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix}${suffix}` } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const view = await readView($)
    const isHidden = await read($, hiddenA)
    return drawPane(
      toUI($.ui.resolve(e)),
      view,
      e.surface === 'desktop',
      () => {
        void refreshLedger($)
      },
      () => {
        void update($, hiddenA, v => !v)
      },
      isHidden,
    )
  })
}
