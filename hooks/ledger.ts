import type { EngineInterface } from 'claude-code'

import type { DayRow, Ledger, ModelRow, ProjectRow, Totals } from '../types'

/**
 * The usage ledger: every Claude Code session on this computer (desktop app,
 * VS Code, terminal) writes its transcript to ~/.claude/projects/**.jsonl,
 * and each assistant row there carries the request's token counts and model.
 * This file sums them by day, model and project. Nothing here calls a model.
 */

type $T = EngineInterface

/** in, out, cache read, cache write 5m, cache write 1h, requests */
type Tok = [number, number, number, number, number, number]

type FileEntry = {
  size: number
  mtime: number
  project: string
  days: Record<string, Record<string, Tok>>
  skipped?: boolean
}

type Cache = { v: 1; files: Record<string, FileEntry> }

const DAY = 86_400_000
const KEEP_DAYS = 62
const CACHE_KEY = 'ledger-cache-v1'

// API list prices per million tokens: input, output, cache read.
// Cache writes cost 1.25x input (5 min) or 2x input (1 h).
// Only used to compare the weight of each model: the Pro plan bills no tokens.
const PRICES: Array<[RegExp, number, number, number]> = [
  [/fable-5-2|mythos-5-2/, 8, 40, 0.2],
  [/fable|mythos/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus/, 5, 25, 0.5],
  [/sonnet-5-5/, 2, 10, 0.1],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet/, 3, 15, 0.3],
  [/haiku-5-5/, 0.1, 0.5, 0.01],
  [/haiku/, 1, 5, 0.1],
]

function priceOf(model: string): [number, number, number] {
  for (const [re, i, o, cr] of PRICES) {
    if (re.test(model)) return [i, o, cr]
  }
  return [4, 20, 0.2]
}

export function costOf(model: string, t: Tok): number {
  const [i, o, cr] = priceOf(model)
  return (t[0] * i + t[1] * o + t[2] * cr + t[3] * i * 1.25 + t[4] * i * 2) / 1e6
}

export function dayKey(ms: number): string {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** A friendly name for a model id: claude-opus-5-5 → Opus 5.5. */
export function modelName(id: string): string {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  if (!m) return id
  const [, fam = '', major = '', minor] = m
  const family = fam.charAt(0).toUpperCase() + fam.slice(1)
  return minor ? `${family} ${major}.${minor}` : `${family} ${major}`
}

function projectName(cwd: string | undefined): string {
  if (!cwd) return 'Desconhecido'
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  const last = parts[parts.length - 1] ?? cwd
  if (/^scratch-\d{4}-\d{2}-\d{2}/.test(last)) return 'Chats sem pasta'
  return last
}

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}

type Row = {
  type?: string
  uuid?: string
  timestamp?: string
  cwd?: string
  message?: { id?: string; model?: string; usage?: Usage }
}

function parseFile(text: string): Pick<FileEntry, 'project' | 'days'> {
  // Streaming writes one row per content block, each with the same usage:
  // keep the last row of each message id.
  const byId = new Map<string, { ts: number; model: string; usage: Usage }>()
  let cwd: string | undefined
  for (const line of text.split('\n')) {
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue
    let row: Row
    try {
      row = JSON.parse(line) as Row
    } catch {
      continue
    }
    const msg = row.message
    if (row.type !== 'assistant' || !msg?.usage || !msg.model || msg.model === '<synthetic>') continue
    cwd ??= row.cwd
    const ts = row.timestamp ? Date.parse(row.timestamp) : NaN
    if (!Number.isFinite(ts)) continue
    byId.set(msg.id ?? row.uuid ?? String(byId.size), { ts, model: msg.model, usage: msg.usage })
  }
  const days: FileEntry['days'] = {}
  for (const { ts, model, usage: u } of byId.values()) {
    const key = dayKey(ts)
    const perModel = (days[key] ??= {})
    const t = (perModel[model] ??= [0, 0, 0, 0, 0, 0])
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const w5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0)
    t[0] += u.input_tokens ?? 0
    t[1] += u.output_tokens ?? 0
    t[2] += u.cache_read_input_tokens ?? 0
    t[3] += w5m
    t[4] += w1h
    t[5] += 1
  }
  return { project: projectName(cwd), days }
}

async function configDir($: $T): Promise<string> {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom) return custom
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~'
  return `${home}/.claude`
}

async function walk($: $T, dir: string, depth: number, out: Array<{ path: string; size: number; mtime: number }>) {
  let entries
  try {
    entries = await $.fs.list(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`
    if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) {
      out.push({ path, size: entry.size, mtime: entry.mtimeMs })
    } else if (entry.kind === 'dir' && depth < 3) {
      await walk($, path, depth + 1, out)
    }
  }
}

/** Rescans the transcripts (only files that changed) and sums the ledger. */
export async function scanLedger($: $T, weekStart: number | null): Promise<Ledger> {
  const now = await $.clock.now()
  const root = `${await configDir($)}/projects`
  const found: Array<{ path: string; size: number; mtime: number }> = []
  await walk($, root, 0, found)

  const stored = (await $.store.get(CACHE_KEY)) as Cache | undefined
  const old = stored?.v === 1 ? stored.files : {}
  const files: Cache['files'] = {}
  let changed = false
  const cutoff = now - KEEP_DAYS * DAY
  for (const f of found) {
    if (f.mtime < cutoff) continue
    const prev = old[f.path]
    if (prev && prev.size === f.size && prev.mtime === f.mtime) {
      files[f.path] = prev
      continue
    }
    changed = true
    try {
      const text = (await $.fs.read(f.path)) as string
      files[f.path] = { size: f.size, mtime: f.mtime, ...parseFile(text) }
    } catch {
      // Over the 4 MiB read limit, or locked: counted as skipped.
      files[f.path] = { size: f.size, mtime: f.mtime, project: 'Desconhecido', days: {}, skipped: true }
    }
  }
  if (changed || Object.keys(old).length !== Object.keys(files).length) {
    await $.store.set(CACHE_KEY, { v: 1, files } satisfies Cache)
  }
  return summarize(files, now, weekStart)
}

function zero(): Totals {
  return { usd: 0, tokens: 0, out: 0, requests: 0 }
}

function add(into: Totals, model: string, t: Tok) {
  into.usd += costOf(model, t)
  into.tokens += t[0] + t[1] + t[2] + t[3] + t[4]
  into.out += t[1]
  into.requests += t[5]
}

function rows<T extends { usd: number }>(map: Map<string, T>): T[] {
  return [...map.values()].sort((a, b) => b.usd - a.usd)
}

function summarize(files: Cache['files'], now: number, weekStart: number | null): Ledger {
  const today = dayKey(now)
  const nowDate = new Date(now)
  const monthPrefix = today.slice(0, 7)
  const weekFrom = dayKey(weekStart ?? now - 6 * DAY)
  const monthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime()
  const daysInMonth = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 0).getDate()
  const firstChartDay = dayKey(now - 29 * DAY)

  const t = { today: zero(), week: zero(), month: zero() }
  const weekModels = new Map<string, ModelRow>()
  const monthModels = new Map<string, ModelRow>()
  const projects = new Map<string, ProjectRow>()
  const dayUsd = new Map<string, number>()
  let sonnetSaving = 0
  let skipped = 0

  for (const file of Object.values(files)) {
    if (file.skipped) skipped += 1
    for (const [date, perModel] of Object.entries(file.days)) {
      for (const [model, tok] of Object.entries(perModel)) {
        const usd = costOf(model, tok)
        const tokens = tok[0] + tok[1] + tok[2] + tok[3] + tok[4]
        if (date >= firstChartDay) dayUsd.set(date, (dayUsd.get(date) ?? 0) + usd)
        if (date === today) add(t.today, model, tok)
        if (date >= weekFrom) {
          add(t.week, model, tok)
          const name = modelName(model)
          const row = weekModels.get(name) ?? { model: name, usd: 0, tokens: 0 }
          row.usd += usd
          row.tokens += tokens
          weekModels.set(name, row)
          if (/opus|fable|mythos/.test(model)) {
            sonnetSaving += Math.max(0, usd - costOf('claude-sonnet-5-5', tok))
          }
        }
        if (date.startsWith(monthPrefix)) {
          add(t.month, model, tok)
          const name = modelName(model)
          const row = monthModels.get(name) ?? { model: name, usd: 0, tokens: 0 }
          row.usd += usd
          row.tokens += tokens
          monthModels.set(name, row)
          const p = projects.get(file.project) ?? { name: file.project, usd: 0, tokens: 0 }
          p.usd += usd
          p.tokens += tokens
          projects.set(file.project, p)
        }
      }
    }
  }

  const days: DayRow[] = []
  for (let i = 29; i >= 0; i -= 1) {
    const date = dayKey(now - i * DAY)
    days.push({ date, usd: dayUsd.get(date) ?? 0 })
  }
  const elapsedDays = Math.max(1, (now - monthStart) / DAY)

  return {
    at: now,
    today: t.today,
    week: t.week,
    month: t.month,
    monthProjUsd: (t.month.usd / elapsedDays) * daysInMonth,
    weekByModel: rows(weekModels),
    monthByModel: rows(monthModels),
    monthByProject: rows(projects).slice(0, 6),
    days,
    sonnetSavingWeek: sonnetSaving,
    files: Object.keys(files).length,
    skipped,
  }
}
