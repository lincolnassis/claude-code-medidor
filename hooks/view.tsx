import type { ElementTable } from 'claude-code'

import type { Ledger, Limits, Prefs, Running, Task, Win } from '../types'
import { estimate, type Estimate } from './task'

/** Formatting, projections and the drawings: the band, the pane, VS Code's line. */

const DAY = 86_400_000
const HOUR = 3_600_000
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

export type View = {
  task: Task | null
  limits: Limits | null
  ledger: Ledger | null
  now: number
  context: number | null
  turnStartedAt: number | null
  stepAvgMs: number | null
  running: Running[]
  prefs: Prefs
  /** Points of the weekly limit per unit of the ledger's weight; null until learned. */
  ratio: number | null
}

/** A ledger weight as percent of the weekly limit, once the ratio is known. */
export function limitPct(v: View, weight: number): number | null {
  return v.ratio === null ? null : weight * v.ratio
}

export function fmtPct(n: number): string {
  if (n > 0 && n < 1) return '<1%'
  return n < 10 ? `${comma(n.toFixed(1)).replace(/,0$/, '')}%` : `${Math.round(n)}%`
}

/** 230% of a week → "2,3 semanas"; under one week, the percent. */
export function fmtWeeks(pct: number): string {
  if (pct < 100) return fmtPct(pct)
  const w = pct / 100
  return `${comma(w.toFixed(1))} semana${w >= 1.95 ? 's' : ''}`
}

export const DEFAULT_PREFS: Prefs = { sound: true, nudge: true, sync: true }

export type UI = {
  Box: ElementTable<'desktop'>['Box']
  Text: ElementTable<'desktop'>['Text']
  Button: ElementTable<'desktop'>['Button']
  Markdown: ElementTable<'desktop'>['Markdown']
  Svg: ElementTable<'desktop'>['Svg'] | null
}

export function toUI(T: ElementTable): UI {
  return { Box: T.Box, Text: T.Text, Button: T.Button, Markdown: T.Markdown, Svg: 'Svg' in T ? T.Svg : null }
}

// ---------- numbers ----------

const comma = (s: string) => s.replace('.', ',')

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`
}

export function fmtIn(ms: number): string {
  if (ms <= 0) return 'agora'
  if (ms >= DAY) {
    const d = Math.floor(ms / DAY)
    const h = Math.floor((ms % DAY) / HOUR)
    return h === 0 ? `${d} d` : `${d} d ${h} h`
  }
  return fmtDur(ms)
}

export function fmtTok(n: number): string {
  if (n >= 1e9) return `${comma((n / 1e9).toFixed(1))} bi`
  if (n >= 1e6) return `${comma((n / 1e6).toFixed(1))} mi`
  if (n >= 1e3) return `${Math.round(n / 1e3)} mil`
  return String(Math.round(n))
}

export function fmtClock(ms: number, now: number): string {
  const d = new Date(ms)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = new Date(now).toDateString() === d.toDateString()
  return sameDay ? hhmm : `${WEEKDAYS[d.getDay()]} ${hhmm}`
}

// ---------- projections ----------

export type Projection = {
  pct: number
  proj: number | null
  hitAt: number | null
  resetsAt: number | null
  perDay: number | null
  isReset: boolean
}

/** Linear projection of a window at its average pace so far. */
export function project(win: Win | null, spanMs: number, now: number, minElapsedMs: number): Projection | null {
  if (!win) return null
  const resetsAt = win.resetsAt
  if (resetsAt !== null && resetsAt <= now) {
    return { pct: 0, proj: null, hitAt: null, resetsAt: null, perDay: null, isReset: true }
  }
  if (resetsAt === null) return { pct: win.pct, proj: null, hitAt: null, resetsAt: null, perDay: null, isReset: false }
  const start = resetsAt - spanMs
  const elapsed = now - start
  const left = resetsAt - now
  const perDay = left > 0 ? Math.max(0, 100 - win.pct) / Math.max(left / DAY, 1 / 24) : null
  if (elapsed < minElapsedMs || win.pct <= 0) {
    return { pct: win.pct, proj: null, hitAt: null, resetsAt, perDay, isReset: false }
  }
  const proj = win.pct * (spanMs / elapsed)
  const hit = start + (elapsed * 100) / win.pct
  return { pct: win.pct, proj, hitAt: hit < resetsAt ? hit : null, resetsAt, perDay, isReset: false }
}

export function weekly(v: View) {
  return project(v.limits?.weekly ?? null, 7 * DAY, v.now, 3 * HOUR)
}

export function fiveHour(v: View) {
  return project(v.limits?.fiveHour ?? null, 5 * HOUR, v.now, 15 * 60_000)
}

// ---------- colors ----------

type Tone = 'success' | 'warning' | 'error'

const GRAD: Record<Tone | 'task' | 'month', [string, string]> = {
  success: ['#10b981', '#5eead4'],
  warning: ['#f59e0b', '#fcd34d'],
  error: ['#ef4444', '#fb7185'],
  task: ['#d97757', '#f4b183'],
  month: ['#6366f1', '#a78bfa'],
}

function tone(pct: number): Tone {
  if (pct >= 85) return 'error'
  if (pct >= 60) return 'warning'
  return 'success'
}

// ---------- bars ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function barSvg(pct: number, colors: [string, string], w: number, h: number, ghost: number | null, title: string): string {
  const p = Math.max(0, Math.min(100, pct))
  const fill = Math.max(p > 0 ? h : 0, (p / 100) * w)
  const r = h / 2
  let extra = ''
  if (ghost !== null && ghost > p) {
    const g = (Math.min(100, ghost) / 100) * w
    const over = ghost >= 100
    // The projection takes its own color: the fill stays the color of now.
    const gc = over ? GRAD.error : GRAD[tone(ghost)]
    extra =
      `<rect width="${g.toFixed(1)}" height="${h}" rx="${r}" fill="${gc[1]}" opacity="0.28"/>` +
      `<rect x="${Math.max(0, g - 2).toFixed(1)}" width="2" height="${h}" rx="1" fill="${gc[0]}" opacity="0.9"/>`
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<title>${esc(title)}</title>` +
    `<defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="0">` +
    `<stop offset="0" stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/>` +
    `</linearGradient></defs>` +
    `<rect width="${w}" height="${h}" rx="${r}" fill="#8888883a"/>` +
    extra +
    `<rect width="${fill.toFixed(1)}" height="${h}" rx="${r}" fill="url(#g)"/>` +
    `</svg>`
  )
}

function Bar(props: {
  u: UI
  pct: number
  colors: [string, string]
  title: string
  ghost?: number | null
  wide?: boolean
  interactive: boolean
}) {
  const { u, pct, colors, title, ghost = null, wide = false, interactive } = props
  const { Text, Svg } = u
  if (Svg) {
    // Not `h`: that name is the JSX factory.
    const w = wide ? 220 : 64
    const tall = wide ? 10 : 7
    return <Svg source={barSvg(pct, colors, w, tall, ghost, title)} alt={title} width={w} height={tall} isInteractive={interactive} />
  }
  const cells = wide ? 24 : 10
  const filled = Math.round((Math.min(100, pct) / 100) * cells)
  const shadow = ghost !== null ? Math.max(0, Math.round((Math.min(100, ghost) / 100) * cells) - filled) : 0
  return (
    <Text>
      <Text color={colors[0]}>{'█'.repeat(filled)}</Text>
      <Text color={GRAD[tone(ghost ?? 0)][0]} dimColor>{'▒'.repeat(shadow)}</Text>
      <Text dimColor>{'░'.repeat(Math.max(0, cells - filled - shadow))}</Text>
    </Text>
  )
}

// ---------- the band above the prompt ----------

type Segment = { key: string; width: number; node: JSX.Element }

export function drawBand(u: UI, v: View, cols: number, isWorking: boolean, interactive: boolean, onDetails: () => void) {
  const { Box, Text, Button } = u
  const segs: Segment[] = []
  const small = 'footnote' as const

  // The task Claude is working on.
  if (v.task) {
    const est = estimate(v.task, v.now, v.stepAvgMs)
    const title = est.current ? `Etapa atual: ${est.current}` : `Tarefa: ${est.done} de ${est.total} etapas`
    let right: string
    if (v.task.finishedAt !== null) right = `concluída em ${fmtDur(est.elapsedMs)}`
    else if (!isWorking) right = `pausada · ${fmtDur(est.elapsedMs)} até agora`
    else if (est.remainingMs === null) right = `calculando… · ${fmtDur(est.elapsedMs)}`
    else right = `~${fmtDur(est.remainingMs)} restantes · total ~${fmtDur(est.totalMs ?? 0)}`
    segs.push({
      key: 'task',
      width: 30 + right.length,
      node: (
        <Box flexDirection="row" alignItems="center" gap="xs">
          <Text size={small} color="claude" weight="semibold">
            {v.task.finishedAt !== null ? '✓' : '◆'} Tarefa {est.done}/{est.total}
          </Text>
          <Bar u={u} pct={est.pct} colors={GRAD.task} title={title} interactive={interactive} />
          <Text size={small} weight="semibold" tabular>{est.pct}%</Text>
          <Text size={small} dimColor tabular>{right}</Text>
        </Box>
      ),
    })
  } else if (isWorking && v.turnStartedAt !== null) {
    segs.push({
      key: 'task',
      width: 22,
      node: (
        <Text size={small} dimColor tabular>
          ⏱ {fmtDur(v.now - v.turnStartedAt)}
        </Text>
      ),
    })
  }

  // The weekly window, with where it lands at this pace.
  const wk = weekly(v)
  if (wk) {
    const t = tone(wk.pct)
    const projText = wk.isReset
      ? 'zerou'
      : wk.proj === null
        ? wk.resetsAt
          ? `↻ ${fmtClock(wk.resetsAt, v.now)}`
          : ''
        : wk.proj >= 100 && wk.hitAt
          ? `⚠ acaba ${fmtClock(wk.hitAt, v.now)}`
          : `→ ${Math.round(wk.proj)}%`
    const title =
      `Semana: ${wk.pct}% usado` +
      (wk.resetsAt ? ` · zera ${fmtClock(wk.resetsAt, v.now)} (em ${fmtIn(wk.resetsAt - v.now)})` : '') +
      (wk.proj !== null ? ` · no ritmo atual: ${Math.round(wk.proj)}% ao zerar` : '')
    segs.push({
      key: 'week',
      width: 19 + projText.length,
      node: (
        <Box flexDirection="row" alignItems="center" gap="xs">
          <Text size={small} dimColor>Semana</Text>
          <Bar u={u} pct={wk.pct} ghost={wk.proj} colors={GRAD[t]} title={title} interactive={interactive} />
          <Text size={small} weight="semibold" color={tone(wk.pct)} tabular>{Math.round(wk.pct)}%</Text>
          {projText !== '' && <Text size={small} color={wk.proj !== null && wk.proj >= 100 ? 'error' : undefined} dimColor={!(wk.proj !== null && wk.proj >= 100)}>{projText}</Text>}
        </Box>
      ),
    })
  }

  // The five-hour window.
  const fh = fiveHour(v)
  if (fh) {
    const title = `Janela de 5 horas: ${fh.pct}% usado` + (fh.resetsAt ? ` · zera às ${fmtClock(fh.resetsAt, v.now)}` : '')
    const reset = fh.isReset ? 'zerou' : fh.resetsAt ? `↻ ${fmtClock(fh.resetsAt, v.now)}` : ''
    segs.push({
      key: '5h',
      width: 15 + reset.length,
      node: (
        <Box flexDirection="row" alignItems="center" gap="xs">
          <Text size={small} dimColor>5h</Text>
          <Bar u={u} pct={fh.pct} ghost={fh.proj} colors={GRAD[tone(fh.pct)]} title={title} interactive={interactive} />
          <Text size={small} weight="semibold" color={tone(fh.pct)} tabular>{Math.round(fh.pct)}%</Text>
          {reset !== '' && <Text size={small} dimColor>{reset}</Text>}
        </Box>
      ),
    })
  }

  // What is running right now: tools and subagents.
  if (isWorking && v.running.length > 0) {
    const first = [...v.running].sort((a, b) => a.startedAt - b.startedAt)[0]
    if (first) {
      const agents = v.running.filter(r => r.isAgent).length
      const more = v.running.length - 1
      const label = `${first.tool}${first.label ? `: ${first.label}` : ''}`
      const tail = `${fmtDur(v.now - first.startedAt)}${more > 0 ? ` · +${more}` : ''}${agents > 0 ? ` · ${agents} agente${agents > 1 ? 's' : ''}` : ''}`
      segs.push({
        key: 'run',
        width: Math.min(34, label.length) + tail.length + 4,
        node: (
          <Box flexDirection="row" alignItems="center" gap="xs">
            <Text size={small} color="suggestion">⚙</Text>
            <Text size={small} wrap="truncate-end">{label.length > 34 ? `${label.slice(0, 33)}…` : label}</Text>
            <Text size={small} dimColor tabular>{tail}</Text>
          </Box>
        ),
      })
    }
  }

  // The month, as weeks' worth of the weekly limit (learned), else tokens.
  if (v.ledger) {
    const m = v.ledger
    const used = limitPct(v, m.month.usd)
    const proj = limitPct(v, m.monthProjUsd)
    // Compact: "1,6 sem → 3,4" (weeks' worth of the weekly limit).
    const weeksShort = (p: number) => (p < 100 ? fmtPct(p) : `${comma((p / 100).toFixed(1))} sem`)
    const main = used === null ? `${fmtTok(m.month.tokens)} tok` : weeksShort(used)
    const tail = proj === null ? '' : `→ ${weeksShort(proj)}`
    segs.push({
      key: 'month',
      width: 8 + main.length + tail.length,
      node: (
        <Box flexDirection="row" alignItems="center" gap="xs">
          <Text size={small} dimColor>Mês</Text>
          <Text size={small} weight="semibold" tabular>{main}</Text>
          {tail !== '' && <Text size={small} dimColor tabular>{tail}</Text>}
        </Box>
      ),
    })
  }

  // How full this conversation's context is.
  if (v.context !== null && v.context !== undefined) {
    const c = v.context
    segs.push({
      key: 'ctx',
      width: 14,
      node: (
        <Text size={small} dimColor={c < 70} color={c >= 85 ? 'error' : c >= 70 ? 'warning' : undefined} tabular>
          Contexto {Math.round(c)}%
        </Text>
      ),
    })
  }

  if (segs.length === 0) return null

  // Keep what fits, in priority order, then draw in reading order.
  // The desktop draws the band in a small proportional face: an estimated
  // cell takes about 0.85 of a real one there.
  const budget = Math.max(20, (cols - 12) / (interactive ? 0.85 : 1))
  const keep = new Set<string>()
  let used = 0
  for (const key of ['task', 'week', '5h', 'run', 'month', 'ctx']) {
    const s = segs.find(x => x.key === key)
    if (s && used + s.width <= budget) {
      keep.add(key)
      used += s.width + 3
    }
  }
  const shown = segs.filter(s => keep.has(s.key))
  const children: JSX.Element[] = []
  shown.forEach((s, n) => {
    if (n > 0) children.push(<Text dimColor>│</Text>)
    children.push(s.node)
  })

  return (
    <Box flexDirection="row" alignItems="center" gap="sm" flexWrap="nowrap">
      {children}
      <Button key="medidor-detalhes" plain label="Detalhes" onPress={onDetails} />
    </Box>
  )
}

// ---------- VS Code: a suffix on the working line ----------

export function spinnerSuffix(v: View): string {
  const parts: string[] = []
  if (v.task) {
    const est: Estimate = estimate(v.task, v.now, v.stepAvgMs)
    parts.push(
      `◆ ${est.done}/${est.total} ${est.pct}%` + (est.remainingMs !== null ? ` · ~${fmtDur(est.remainingMs)} restantes` : ''),
    )
  }
  const wk = weekly(v)
  if (wk) parts.push(`Semana ${Math.round(wk.pct)}%` + (wk.proj !== null ? `→${Math.round(wk.proj)}%` : ''))
  const fh = fiveHour(v)
  if (fh) parts.push(`5h ${Math.round(fh.pct)}%`)
  return parts.length ? ` · ${parts.join(' · ')}` : ''
}

// ---------- the pane: /gastos ----------

function pctOr(v: View, weight: number): string {
  const p = limitPct(v, weight)
  return p === null ? '—' : fmtPct(p)
}

function weeksOr(v: View, weight: number): string {
  const p = limitPct(v, weight)
  return p === null ? '—' : fmtWeeks(p)
}

function chartSvg(days: Array<{ date: string; usd: number }>, w: number, h: number, fmt: (weight: number) => string): string {
  const max = Math.max(0.01, ...days.map(d => d.usd))
  const gap = 3
  const bw = (w - gap * (days.length - 1)) / days.length
  const bars = days
    .map((d, n) => {
      const bh = d.usd > 0 ? Math.max(2, (d.usd / max) * (h - 14)) : 1
      const x = n * (bw + gap)
      const y = h - 12 - bh
      const isToday = n === days.length - 1
      const [, mm, dd] = d.date.split('-')
      return (
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" ` +
        `fill="${isToday ? 'url(#t)' : 'url(#g)'}"><title>${dd}/${mm}: ${esc(fmt(d.usd))}</title></rect>`
      )
    })
    .join('')
  const first = days[0]?.date.split('-') ?? []
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g" x1="0" x2="0" y1="1" y2="0"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#a78bfa"/></linearGradient>` +
    `<linearGradient id="t" x1="0" x2="0" y1="1" y2="0"><stop offset="0" stop-color="#d97757"/><stop offset="1" stop-color="#f4b183"/></linearGradient></defs>` +
    bars +
    `<text x="0" y="${h - 1}" font-size="9" fill="#888" font-family="system-ui, sans-serif">${first[2] ?? ''}/${first[1] ?? ''}</text>` +
    `<text x="${w}" y="${h - 1}" font-size="9" fill="#888" text-anchor="end" font-family="system-ui, sans-serif">hoje</text>` +
    `</svg>`
  )
}

function sparkline(days: Array<{ usd: number }>): string {
  const marks = '▁▂▃▄▅▆▇█'
  const max = Math.max(0.01, ...days.map(d => d.usd))
  return days.map(d => (d.usd <= 0 ? ' ' : marks[Math.min(7, Math.floor((d.usd / max) * 7.999))])).join('')
}

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n')
}

const SHORT_DAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']

function dm(date: string): string {
  const [, mm, dd] = date.split('-')
  return `${dd}/${mm}`
}

function weekdayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return SHORT_DAYS[new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).getDay()] ?? date
}

/** The Monday note: last week in one paragraph, or null when there was no use. */
export function weeklySummary(L: Ledger, peakPct: number | null, ratio: number | null): string | null {
  const p = L.prevWeek
  if (p.totals.requests === 0) return null
  const share = p.byModel
    .slice(0, 3)
    .map(r => `${r.model} ${Math.round((r.usd / Math.max(0.0001, p.totals.usd)) * 100)}%`)
    .join(', ')
  const used = peakPct ?? (ratio === null ? null : p.totals.usd * ratio)
  const parts = [
    `📊 Resumo da semana passada (${dm(p.from)} a ${dm(p.to)}): ${p.totals.requests} respostas, ${fmtTok(p.totals.tokens)} tokens`,
    used !== null ? `${peakPct !== null ? 'limite semanal usado' : 'limite semanal usado (estimado)'}: ${fmtPct(used)}` : '',
    share ? `divisão do uso: ${share}` : '',
    p.topDay
      ? `dia mais pesado: ${weekdayOf(p.topDay.date)}${ratio !== null ? ` (${fmtPct(p.topDay.usd * ratio)} do limite)` : ''}`
      : '',
  ].filter(Boolean)
  return `${parts.join(' · ')}.`
}

export type PaneActions = {
  refresh: () => void
  toggleHidden: () => void
  togglePref: (key: keyof Prefs) => void
}

export function drawPane(u: UI, v: View, interactive: boolean, act: PaneActions, isHidden: boolean, peakPct: number | null) {
  const { Box, Text, Button, Markdown, Svg } = u
  const wk = weekly(v)
  const fh = fiveHour(v)
  const L = v.ledger

  const limitRow = (label: string, p: Projection | null, span: string) => {
    if (!p) return <Text dimColor>{label}: sem leitura ainda (aparece após a próxima resposta).</Text>
    const t = tone(p.pct)
    const lines: string[] = []
    if (p.isReset) lines.push('A janela zerou; o novo valor chega com a próxima resposta.')
    if (p.resetsAt) lines.push(`Zera ${fmtClock(p.resetsAt, v.now)} (em ${fmtIn(p.resetsAt - v.now)}).`)
    if (p.proj !== null) {
      lines.push(
        p.proj >= 100 && p.hitAt
          ? `⚠ No ritmo atual acaba ${fmtClock(p.hitAt, v.now)}, antes de zerar.`
          : `No ritmo atual chega a ${Math.round(p.proj)}% quando zerar.`,
      )
    }
    if (p.perDay !== null && span === 'semana' && !p.isReset) {
      lines.push(`Para chegar ao fim: até ${Math.round(p.perDay)}% por dia.`)
    }
    return (
      <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" alignItems="center" gap="sm">
          <Text weight="semibold">{label}</Text>
          <Bar u={u} pct={p.pct} ghost={p.proj} colors={GRAD[t]} title={`${label}: ${p.pct}%`} wide interactive={interactive} />
          <Text weight="bold" color={tone(p.pct)} tabular>{Math.round(p.pct)}%</Text>
        </Box>
        <Text dimColor>{lines.join(' ')}</Text>
      </Box>
    )
  }

  const est = v.task ? estimate(v.task, v.now, v.stepAvgMs) : null

  return (
    <Box flexDirection="column" gap="md" paddingX={1}>
      <Text size="heading" weight="bold">Limites do plano</Text>
      {limitRow('Semana', wk, 'semana')}
      {limitRow('Janela de 5 h', fh, '5h')}

      {v.running.length > 0 && (
        <Box flexDirection="column" gap="xs">
          <Text size="heading" weight="bold">Agora</Text>
          <Markdown
            text={[...v.running]
              .sort((a, b) => a.startedAt - b.startedAt)
              .map(r => `${r.isAgent ? '🤖' : '⚙'} **${r.tool}**${r.label ? ` · ${r.label.replace(/[|*_`]/g, ' ')}` : ''} · ${fmtDur(v.now - r.startedAt)}`)
              .join('  \n')}
          />
        </Box>
      )}

      {est && v.task && (
        <Box flexDirection="column" gap="xs">
          <Text size="heading" weight="bold">Tarefa atual</Text>
          <Box flexDirection="row" alignItems="center" gap="sm">
            <Bar u={u} pct={est.pct} colors={GRAD.task} title="Tarefa" wide interactive={interactive} />
            <Text weight="bold" tabular>{est.pct}%</Text>
            <Text dimColor>
              {est.done} de {est.total} etapas · {fmtDur(est.elapsedMs)}
              {est.remainingMs !== null && v.task.finishedAt === null ? ` · ~${fmtDur(est.remainingMs)} restantes` : ''}
            </Text>
          </Box>
          <Markdown
            text={v.task.items
              .map(i => `${i.status === 'completed' ? '✓' : i.status === 'in_progress' ? '▶' : '○'} ${i.text}`)
              .join('  \n')}
          />
        </Box>
      )}

      <Text size="heading" weight="bold">Consumo</Text>
      {L ? (
        <Box flexDirection="column" gap="sm">
          <Markdown
            text={table(
              ['', 'Do limite semanal', 'Tokens', 'Respostas'],
              [
                ['**Hoje**', pctOr(v, L.today.usd), fmtTok(L.today.tokens), String(L.today.requests)],
                ['**Semana**', wk && !wk.isReset ? fmtPct(wk.pct) : pctOr(v, L.week.usd), fmtTok(L.week.tokens), String(L.week.requests)],
                ['**Mês**', weeksOr(v, L.month.usd), fmtTok(L.month.tokens), String(L.month.requests)],
                ['**Projeção do mês**', weeksOr(v, L.monthProjUsd), '', ''],
              ],
            )}
          />
          <Text weight="semibold">Últimos 30 dias</Text>
          {Svg ? (
            <Svg
              source={chartSvg(L.days, 300, 70, n => (v.ratio === null ? `${Math.round(n * 100) / 100} (peso)` : `${fmtPct(n * v.ratio)} do limite semanal`))}
              alt="Uso por dia nos últimos 30 dias"
              width={300}
              height={70}
              isInteractive={interactive}
            />
          ) : (
            <Text color="#a78bfa">{sparkline(L.days)}</Text>
          )}
          {L.weekByModel.length > 0 && (
            <Markdown
              text={
                '**Por modelo (semana)**\n\n' +
                table(
                  ['Modelo', 'Do limite semanal', 'Parte do uso'],
                  L.weekByModel.map(r => [r.model, pctOr(v, r.usd), `${Math.round((r.usd / Math.max(0.0001, L.week.usd)) * 100)}%`]),
                )
              }
            />
          )}
          {L.monthByProject.length > 0 && (
            <Markdown
              text={
                '**Por projeto (mês)**\n\n' +
                table(['Projeto', 'Do limite semanal', 'Tokens'], L.monthByProject.map(r => [r.name, pctOr(v, r.usd), fmtTok(r.tokens)]))
              }
            />
          )}
          {L.sonnetSavingWeek > 0.05 && (
            <Text color="suggestion">
              💡 Se as tarefas desta semana feitas no Opus/Fable tivessem ido para o Sonnet 5.5, teria sobrado cerca de{' '}
              {v.ratio === null
                ? `${Math.round((L.sonnetSavingWeek / Math.max(0.0001, L.week.usd)) * 100)}% do uso da semana`
                : `${fmtPct(L.sonnetSavingWeek * v.ratio)} do limite semanal`}
              . Use o Sonnet para tarefas simples e guarde o Opus para as difíceis.
            </Text>
          )}
          {weeklySummary(L, peakPct, v.ratio) !== null && (
            <Box flexDirection="column" gap="xs">
              <Text weight="semibold">Semana passada</Text>
              <Text dimColor>{(weeklySummary(L, peakPct, v.ratio) ?? '').replace(/^📊 Resumo da semana passada /, '')}</Text>
            </Box>
          )}
          <Text dimColor size="footnote">
            {v.ratio === null
              ? 'Os % do limite aparecem assim que a semana tiver uso suficiente para o mod aprender o seu ritmo. '
              : 'Os % do limite (exceto o da semana, que é o oficial) são estimados: o mod compara o quanto você usou nesta semana com o quanto a barra semanal subiu, e cada modelo pesa diferente (o Opus pesa cerca de 2× o Sonnet). '}
            Lido dos registros deste computador ({L.files} conversas
            {L.skipped > 0 ? `, ${L.skipped} grandes demais para ler` : ''})
            {L.machines.length > 0 ? ` e de ${L.machines.join(', ')} pelo OneDrive` : ''}; atualizado {fmtClock(L.at, v.now)}.
          </Text>
        </Box>
      ) : (
        <Text dimColor>Somando o histórico…</Text>
      )}

      {v.context !== null && (
        <Text dimColor>
          Contexto desta conversa: {Math.round(v.context)}%{v.context >= 70 ? ' (perto de compactar; um chat novo sai mais barato)' : ''}
        </Text>
      )}

      <Box flexDirection="row" gap="sm" flexWrap="wrap">
        <Button key="medidor-atualizar" label="Atualizar" onPress={act.refresh} />
        <Button key="medidor-barra" label={isHidden ? 'Mostrar a barra' : 'Ocultar a barra'} onPress={act.toggleHidden} />
      </Box>
      <Text weight="semibold">Opções</Text>
      <Box flexDirection="column" gap="xs">
        <Button key="medidor-som" plain onPress={() => act.togglePref('sound')}>
          {v.prefs.sound ? '☑' : '☐'} Som e notificação quando uma tarefa longa termina
        </Button>
        <Button key="medidor-aviso" plain onPress={() => act.togglePref('nudge')}>
          {v.prefs.nudge ? '☑' : '☐'} Sugerir o Sonnet em pedidos simples quando o limite apertar
        </Button>
        <Button key="medidor-sync" plain onPress={() => act.togglePref('sync')}>
          {v.prefs.sync ? '☑' : '☐'} Somar outros computadores pelo OneDrive (só números por dia e modelo)
        </Button>
      </Box>
    </Box>
  )
}
