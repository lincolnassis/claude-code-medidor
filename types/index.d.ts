export type ItemStatus = 'pending' | 'in_progress' | 'completed'

export type TaskItem = { text: string; status: ItemStatus; id?: string }

/** The task list Claude keeps while it works, and when each step finished. */
export type Task = {
  startedAt: number
  items: TaskItem[]
  doneAt: number[]
  finishedAt: number | null
  source: string
}

/** One rate-limit window: percent used and when it resets (ms). */
export type Win = { pct: number; resetsAt: number | null }

export type Limits = { fiveHour: Win | null; weekly: Win | null; at: number }

export type Totals = { usd: number; tokens: number; out: number; requests: number }

export type ModelRow = { model: string; usd: number; tokens: number }

export type ProjectRow = { name: string; usd: number; tokens: number }

export type DayRow = { date: string; usd: number }

/** Usage summed from the local transcripts (~/.claude/projects). */
export type Ledger = {
  at: number
  today: Totals
  week: Totals
  month: Totals
  monthProjUsd: number
  weekByModel: ModelRow[]
  monthByModel: ModelRow[]
  monthByProject: ProjectRow[]
  days: DayRow[]
  sonnetSavingWeek: number
  files: number
  skipped: number
}

declare module 'claude-code' {
  interface PluginState {
    medidor: {
      task: Shaped<Task | null>
      limits: Shaped<Limits | null>
      ledger: Shaped<Ledger | null>
      now: number
      turnStartedAt: number | null
      context: number | null
      stepAvgMs: number | null
      isHidden: boolean
    }
  }
}
