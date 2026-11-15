import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2026-11-15T20:00:00Z')
const HOUR = 3_600_000

const BAND = {
  plugin: 'medidor',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 6,
    bodyColumns: 200,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const SEED: Record<string, unknown> = {
  task: {
    shape: 'task-1',
    value: {
      startedAt: NOW - 10 * 60_000,
      items: [
        { text: 'Ler', status: 'completed' },
        { text: 'Escrever', status: 'completed' },
        { text: 'Testar', status: 'in_progress' },
        { text: 'Publicar', status: 'pending' },
      ],
      doneAt: [NOW - 6 * 60_000, NOW - 2 * 60_000],
      finishedAt: null,
      source: 'plan',
    },
  },
  limits: {
    shape: 'limits-1',
    value: {
      fiveHour: { pct: 23, resetsAt: NOW + 2 * HOUR },
      // Two days into the week at 40%: on pace for 140%.
      weekly: { pct: 40, resetsAt: NOW + 5 * 24 * HOUR },
      at: NOW,
    },
  },
  now: NOW,
  context: 34,
}

test('the band draws the task, the windows and the projection on every surface with a band', async ($, on) => {
  on('state.get', (_, e) => {
    const value = SEED[e.key]
    return { value: value === undefined ? { value: undefined, version: 0 } : { value, version: 1 } }
  })
  on('clock.now', () => ({ value: NOW }))

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Tarefa 2\/4/ }))?.text).toContain('Tarefa 2/4')
    expect(await ui.find({ type: 'Text', text: /^50%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /restantes/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^40%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /acaba/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Contexto 34%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the desktop plan is followed step by step', async ($, on) => {
  let clock = NOW
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: (clock += 60_000) }))
  on('ui.log', (_, e) => {
    throw new Error(`logged: ${JSON.stringify(e)}`)
  })
  const band = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const text = (await ui.find({ type: 'Text', text: /Tarefa/ }))?.text
    await ui.unmount()
    return text
  }

  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Um', status: 'in_progress' },
      { content: 'Dois', status: 'pending' },
    ],
  })
  expect(await band()).toContain('◆ Tarefa 0/2')

  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  expect(await band()).toContain('◆ Tarefa 1/2')

  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'ok' })
  expect(await band()).toContain('✓ Tarefa 2/2')
})

const TOTALS = { usd: 12.5, tokens: 4_200_000, out: 90_000, requests: 140 }
const LEDGER = {
  shape: 'ledger-1',
  value: {
    at: NOW,
    today: TOTALS,
    week: TOTALS,
    month: TOTALS,
    monthProjUsd: 26,
    weekByModel: [
      { model: 'Opus 5.5', usd: 10, tokens: 3_000_000 },
      { model: 'Sonnet 5.5', usd: 2.5, tokens: 1_200_000 },
    ],
    monthByModel: [],
    monthByProject: [{ name: 'Chats sem pasta', usd: 12.5, tokens: 4_200_000 }],
    days: Array.from({ length: 30 }, (_, n) => ({ date: `2026-10-${String(n + 1).padStart(2, '0')}`, usd: n % 5 })),
    sonnetSavingWeek: 5,
    files: 7,
    skipped: 0,
  },
}

test('the /gastos pane and the VS Code line draw on every surface', async ($, on) => {
  on('state.get', (_, e) => {
    const value = e.key === 'ledger' ? LEDGER : SEED[e.key]
    return { value: value === undefined ? { value: undefined, version: 0 } : { value, version: 1 } }
  })
  on('clock.now', () => ({ value: NOW }))
  // Beneath the plugin, standing for the engine: draws the line it is handed.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    const props = e.props as { word: string; suffix: string }
    return <Text>{`${props.word}${props.suffix}`}</Text>
  })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'medidor',
      component: 'Pane',
      requestId: 'medidor',
      surface,
      props: { title: 'Medidor de uso', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /Limites do plano/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Sonnet 5.5/ })).toBeDefined()
    await ui.unmount()
  }

  const line = await $.ui.mount({
    plugin: 'medidor',
    component: 'Spinner',
    surface: 'vscode',
    props: { word: 'Working', message: null, suffix: '', mode: 'tool-use' },
  })
  expect((await line.find({ type: 'Text', text: /Semana/ }))?.text).toContain('Semana 40%→140%')
  await line.unmount()
})

test('TodoWrite, as in the terminal and VS Code, drives the same band', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: NOW }))
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'A', status: 'completed', activeForm: 'A' },
      { content: 'B', status: 'in_progress', activeForm: 'B' },
      { content: 'C', status: 'pending', activeForm: 'C' },
    ],
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Tarefa/ }))?.text).toContain('Tarefa 1/3')
  await ui.unmount()
})
