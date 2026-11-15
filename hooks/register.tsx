import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { Limits, Prefs, Running, Task, Win } from '../types'
import { dayKey, mondayOf, scanLedger } from './ledger'
import { TASK_TOOLS, applyToolCall } from './task'
import { DEFAULT_PREFS, drawBand, drawPane, fmtClock, fmtDur, spinnerSuffix, toUI, weekly, weeklySummary, type View } from './view'

/**
 * Medidor: a band above the prompt with the task's progress and time left, what
 * is running now, the plan's 5-hour and weekly windows with a projection, the
 * month's usage, and alerts before a limit runs out. `/gastos` opens the full
 * report. Also: a chime and a notification when a long task ends, a nudge
 * toward Sonnet for simple prompts when the week is tight, a numbers-only sync
 * of the ledger between computers through OneDrive, and a Monday summary.
 * Everything is read locally; nothing here calls a model or spends tokens.
 */

type $T = EngineInterface

const PANE = 'medidor'
const HOUR = 3_600_000
const LONG_TURN_MS = 90_000
const NUDGE_EVERY_MS = HOUR

// Change a tag when that value's fields change: an older stored value is then
// read as the initial one instead of in the wrong shape.
const taskA = atom({ plugin: 'medidor', key: 'task' } as const, null as Task | null, { shape: 'task-1' })
const limitsA = atom({ plugin: 'medidor', key: 'limits' } as const, null as Limits | null, { shape: 'limits-1' })
const ledgerA = atom({ plugin: 'medidor', key: 'ledger' } as const, null, { shape: 'ledger-2' })
const runningA = atom({ plugin: 'medidor', key: 'running' } as const, [] as Running[], { shape: 'running-1' })
const prefsA = atom({ plugin: 'medidor', key: 'prefs' } as const, DEFAULT_PREFS, { shape: 'prefs-1' })
const nowA = atom({ plugin: 'medidor', key: 'now' } as const, 0)
const turnA = atom({ plugin: 'medidor', key: 'turnStartedAt' } as const, null as number | null)
const ctxA = atom({ plugin: 'medidor', key: 'context' } as const, null as number | null)
const avgA = atom({ plugin: 'medidor', key: 'stepAvgMs' } as const, null as number | null)
const modelA = atom({ plugin: 'medidor', key: 'lastModel' } as const, null as string | null)
const ratioA = atom({ plugin: 'medidor', key: 'ratio' } as const, null as number | null)
const hiddenA = atom({ plugin: 'medidor', key: 'isHidden' } as const, false)

async function readView($: $T): Promise<View> {
  const [task, limits, ledger, tick, context, turnStartedAt, stepAvgMs, running, prefs, ratio, clock] = await Promise.all([
    read($, taskA),
    read($, limitsA),
    read($, ledgerA),
    read($, nowA),
    read($, ctxA),
    read($, turnA),
    read($, avgA),
    read($, runningA),
    read($, prefsA),
    read($, ratioA),
    $.clock.now(),
  ])
  return { task, limits, ledger, now: Math.max(tick, clock), context, turnStartedAt, stepAvgMs, running, prefs, ratio }
}

function toWin(r: SessionRateLimit): Win {
  const at = r.resetsAt ? Date.parse(r.resetsAt) : NaN
  return { pct: r.percentUsed, resetsAt: Number.isFinite(at) ? at : null }
}

// ---------- alerts ----------

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

    const proj = weekly({ ...EMPTY_VIEW, limits, now })
    if (proj?.proj != null && proj.proj >= 100 && proj.hitAt && wk.pct < 100 && now - (wk.resetsAt - 7 * 24 * HOUR) > 12 * HOUR) {
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
    const fiveSteps: Array<[number, string]> = [
      [95, `🔴 Janela de 5 h em 95%. Zera às ${when}.`],
      [80, `⚠️ Janela de 5 h em 80%. Zera às ${when}.`],
    ]
    const hit = fiveSteps.find(([level]) => fh.pct >= level)
    if (hit) await alertOnce($, `5h:${fh.resetsAt}`, hit[0], hit[1])
  }
}

const EMPTY_VIEW: View = {
  task: null,
  limits: null,
  ledger: null,
  now: 0,
  context: null,
  turnStartedAt: null,
  stepAvgMs: null,
  running: [],
  prefs: DEFAULT_PREFS,
  ratio: null,
}

/** The highest weekly percent each window reached, for the Monday summary. */
async function notePeak($: $T, win: Win) {
  if (win.resetsAt === null) return
  const peaks = ((await $.store.get('week-peaks')) as Record<string, number> | undefined) ?? {}
  const key = String(win.resetsAt)
  if ((peaks[key] ?? -1) >= win.pct) return
  peaks[key] = win.pct
  const keys = Object.keys(peaks).sort()
  for (const old of keys.slice(0, Math.max(0, keys.length - 8))) delete peaks[old]
  await $.store.set('week-peaks', peaks)
}

/** The peak of the last weekly window that has already reset. */
async function lastPeak($: $T, now: number): Promise<number | null> {
  const peaks = ((await $.store.get('week-peaks')) as Record<string, number> | undefined) ?? {}
  const ended = Object.keys(peaks)
    .map(Number)
    .filter(at => at <= now)
    .sort((a, b) => b - a)[0]
  return ended === undefined ? null : (peaks[String(ended)] ?? null)
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
  if (next.weekly) await notePeak($, next.weekly)
  await checkAlerts($, next)
}

// ---------- the ledger ----------

// The module's own timers: a reload starts them over, which is fine.
let ticker: Timer | null = null
let scanTimer: Timer | null = null
let isScanning = false

async function refreshLedger($: $T) {
  if (isScanning) return
  isScanning = true
  try {
    const limits = await read($, limitsA)
    const prefs = await read($, prefsA)
    const now = await $.clock.now()
    const resetsAt = limits?.weekly?.resetsAt ?? null
    const weekStart = resetsAt !== null && resetsAt > now ? resetsAt - 7 * 24 * HOUR : null
    const ledger = await scanLedger($, weekStart, prefs.sync)
    await update($, ledgerA, () => ledger)
    // How many points of the weekly limit one unit of use costs, learned from
    // this week: the official percent over what the ledger counted since the
    // window opened. Kept, so a fresh window still has a figure.
    const pct = limits?.weekly?.pct ?? 0
    if (weekStart !== null && pct >= 2 && ledger.week.usd > 0.5) {
      const ratio = pct / ledger.week.usd
      await update($, ratioA, () => ratio)
      await $.store.set('ratio', ratio)
    }
    await mondaySummary($, now)
  } catch (err) {
    $.ui.log(`medidor: não consegui somar o histórico (${String(err)})`, { to: 'debug' })
  } finally {
    isScanning = false
  }
}

/** Once a week, the first time the mod runs that week: last week in one note. */
async function mondaySummary($: $T, now: number) {
  const week = dayKey(mondayOf(now))
  if ((await $.store.get('summary-week')) === week) return
  const ledger = await read($, ledgerA)
  if (!ledger) return
  const text = weeklySummary(ledger, await lastPeak($, now), await read($, ratioA))
  await $.store.set('summary-week', week)
  if (!text) return
  $.ui.log(text)
  $.ui.toast('📊 Resumo da semana passada: veja a nota na conversa ou /gastos.', { timeoutMs: 8000 })
}

async function openPane($: $T) {
  return $.ui.open({ id: PANE, title: 'Medidor de uso' })
}

// ---------- the chime ----------

async function finishedTurn($: $T, startedAt: number, now: number) {
  const prefs = await read($, prefsA)
  if (!prefs.sound || now - startedAt < LONG_TURN_MS) return
  const task = await read($, taskA)
  const text =
    task && task.finishedAt !== null && task.finishedAt >= startedAt
      ? `✓ Tarefa concluída em ${fmtDur(now - task.startedAt)} (${task.items.length} etapas).`
      : `✓ O Claude terminou depois de ${fmtDur(now - startedAt)}. Sua vez.`
  $.ui.toast(text, { timeoutMs: 8000 })
  await Promise.allSettled([$.audio.play({ asset: 'assets/pronto.wav' }), $.ui.notify(text, { title: 'Claude Code' })])
}

// ---------- the Sonnet nudge ----------

const HEAVY_WORDS =
  /(c[oó]digo|implement|refator|debug|depur|bug|erro|arquitet|analis|anális|planej|projeto|script|sql|dax|python|dashboard|mod\b|plugin|test)/i

function isSimple(text: string): boolean {
  const t = text.trim()
  if (t.length === 0 || t.length > 180) return false
  if (t.includes('```') || t.split('\n').length > 3) return false
  return !HEAVY_WORDS.test(t)
}

async function maybeNudge($: $T, text: string) {
  const prefs = await read($, prefsA)
  const model = await read($, modelA)
  if (!prefs.nudge || !model || !/opus|fable|mythos/.test(model) || !isSimple(text)) return
  const now = await $.clock.now()
  const proj = weekly({ ...EMPTY_VIEW, limits: await read($, limitsA), now })
  const isTight = proj !== null && (proj.pct >= 40 || (proj.proj ?? 0) >= 90)
  if (!isTight) return
  const last = Number((await $.store.get('nudge-at')) ?? 0)
  if (now - last < NUDGE_EVERY_MS) return
  await $.store.set('nudge-at', now)
  $.ui.toast(
    `💡 Pedido simples no Opus com a semana em ${Math.round(proj.pct)}%. No Sonnet ele pesaria cerca de metade: /model sonnet (e /model opus para voltar).`,
    { timeoutMs: 10000 },
  )
}

// ---------- what is running ----------

function basename(path: unknown): string {
  return typeof path === 'string' ? (path.split(/[\\/]/).pop() ?? path) : ''
}

function short(text: unknown, max = 40): string {
  if (typeof text !== 'string') return ''
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function describe(tool: string, a: Record<string, unknown>): { tool: string; label: string; isAgent: boolean } {
  if (tool === 'Agent' || tool === 'Task') {
    return { tool: 'Agente', label: short(a.description ?? a.subagent_type), isAgent: true }
  }
  if (tool === 'Bash' || tool === 'PowerShell') return { tool, label: short(a.description ?? a.command), isAgent: false }
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    return { tool, label: basename(a.file_path ?? a.notebook_path), isAgent: false }
  }
  if (tool === 'Grep' || tool === 'Glob') return { tool, label: short(a.pattern), isAgent: false }
  if (tool === 'WebSearch') return { tool: 'Pesquisa', label: short(a.query), isAgent: false }
  if (tool === 'WebFetch') return { tool: 'Página', label: short(a.url), isAgent: false }
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__')
    return { tool: parts[parts.length - 1] ?? tool, label: '', isAgent: false }
  }
  return { tool, label: '', isAgent: false }
}

// ---------- the hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gastos',
      description: 'Abre o medidor de uso: limites, projeções, custo por modelo e projeto, opções',
    })
    const stored = (await $.store.get('limits')) as Limits | undefined
    if (stored && typeof stored === 'object' && 'at' in stored) await update($, limitsA, () => stored)
    const avg = await $.store.get('stepAvgMs')
    if (typeof avg === 'number') await update($, avgA, () => avg)
    const prefs = (await $.store.get('prefs')) as Partial<Prefs> | undefined
    if (prefs && typeof prefs === 'object') await update($, prefsA, () => ({ ...DEFAULT_PREFS, ...prefs }))
    const model = await $.store.get('last-model')
    if (typeof model === 'string') await update($, modelA, () => model)
    const ratio = await $.store.get('ratio')
    if (typeof ratio === 'number') await update($, ratioA, () => ratio)
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
    const startedAt = await read($, turnA)
    await update($, turnA, () => null)
    await update($, nowA, () => now)
    await update($, runningA, () => [])
    if (e.usage?.model) {
      const model = e.usage.model
      await update($, modelA, () => model)
      await $.store.set('last-model', model)
    }
    if (startedAt !== null && e.reason === 'answer') await finishedTurn($, startedAt, now)
    scanTimer?.cancel()
    scanTimer = $.clock.after(3000, () => {
      void refreshLedger($)
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // A finished task stays on the band until the next prompt.
    const task = await read($, taskA)
    if (task && task.finishedAt !== null) await update($, taskA, () => null)
    if (!e.command && !e.isMeta) await maybeNudge($, e.text)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const args = e as unknown as Record<string, unknown>

    // Claude's own task list: the desktop plan, TodoWrite, TaskCreate/Update.
    if (TASK_TOOLS.has(tool)) {
      const result = await next(e)
      try {
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
    }

    // Any other tool: shown as running until it returns.
    const id = String(e.tool_use_id)
    const run: Running = { id, ...describe(tool, args), startedAt: await $.clock.now() }
    await update($, runningA, list => [...list.filter(r => r.id !== id), run].slice(-20))
    try {
      return await next(e)
    } finally {
      await update($, runningA, list => list.filter(r => r.id !== id))
    }
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
    const peak = await lastPeak($, view.now)
    return drawPane(
      toUI($.ui.resolve(e)),
      view,
      e.surface === 'desktop',
      {
        refresh: () => {
          void refreshLedger($)
        },
        toggleHidden: () => {
          void update($, hiddenA, v => !v)
        },
        togglePref: key => {
          void update($, prefsA, p => ({ ...p, [key]: !p[key] })).then(() => read($, prefsA).then(p => $.store.set('prefs', p)))
        },
      },
      isHidden,
      peak,
      e.props.bodyColumns,
    )
  })
}
