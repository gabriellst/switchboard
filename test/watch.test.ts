import { spawn } from 'node:child_process'
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPin } from '../src/commands/pin.js'
import { runUnpin } from '../src/commands/unpin.js'
import { parseConfig, type Config } from '../src/core/config.js'
import { defaultCtx, type Ctx } from '../src/core/ctx.js'
import { EXIT, SbError } from '../src/core/errors.js'
import { withLock } from '../src/core/fsx.js'
import { currentAccount, pointMux } from '../src/core/links.js'
import { lockFile, logFile, muxLink, pinLink, runtimeFile, usageFile, watchFile, watchPidFile } from '../src/core/paths.js'
import { pinSession } from '../src/core/pin.js'
import { readRuntime, writeRuntime } from '../src/core/runtime.js'
import { newMemory, tick, watchLoop, watchStatus, type TickOptions } from '../src/core/watch.js'
import { renderTick } from '../src/report.js'
import { fakeApi, FAKE_TOKEN, populatedSandbox, type FakeApi, type Sandbox } from './helpers.js'

const NOW = 1_800_000_000_000
const MIN = 60_000
const OLD = NOW - MIN
const RESET_5H_S = NOW / 1000 + 7_200
const RESET_7D_S = NOW / 1000 + 300_000
const TOKEN_B = 'sk-ant-oat01-' + 'y'.repeat(40)
const DEAD_PID = 99_999_999

const A1 = 'aaaaaaa1'
const A2 = 'aaaaaaa2'
const A3 = 'aaaaaaa3'
const A4 = 'aaaaaaa4'
const BUSY = 'ccccccc3'
const ID = 'a1b2c3d4'

/** Sem espera real entre as consultas do `claude stop`. */
const fast: TickOptions = { restart: { stop: { pollMs: 1, sleep: () => undefined } } }

type Kind = 'free' | 'limit-blocked' | 'busy' | 'noflight'

const stateFor = (flags: string[], kind: Kind): Record<string, unknown> => {
  const base = { respawnFlags: flags }
  switch (kind) {
    case 'free':
      return { ...base, state: 'done', inFlight: { tasks: 0, queued: 0, kinds: [] } }
    case 'limit-blocked':
      return { ...base, state: 'blocked', needs: 'rate limited until 17:00', detail: `limite ${FAKE_TOKEN}`, inFlight: { tasks: 0, queued: 1, kinds: [] } }
    case 'busy':
      return { ...base, state: 'working', inFlight: { tasks: 1, queued: 0, kinds: ['local_agent'] } }
    case 'noflight':
      return { ...base, state: 'done' }
  }
}

const flagsOf = (settings: string): string[] => ['--allowed-tools', 'Read', '--settings', settings, '--allowed-tools', 'Bash']

function addSession(sb: Sandbox, id: string, kind: Kind, o: { startedAt?: number; settings?: string } = {}): void {
  sb.addJob({
    agent: { id, startedAt: o.startedAt ?? OLD, pid: 4242, status: kind === 'busy' ? 'busy' : 'idle' },
    state: stateFor(flagsOf(o.settings ?? muxLink(sb.paths, 'bk')), kind),
  })
}

/** bk (gabriel → admin1) com tokens DISTINTOS (com o mesmo token a sonda dá uma medição só e vira "duplicata"). */
function world(): Sandbox {
  const sb = populatedSandbox()
  sb.addToken('admin1', TOKEN_B)
  return sb
}

type U = number | { five: number; reset?: number } | 'rate-limited'

/** Grava `usage.json`: `at` é o `measuredAt` (recente = nenhuma sonda no ciclo). */
function setUsage(sb: Sandbox, util: Record<string, U>, at = NOW): void {
  const latest: Record<string, unknown> = {}
  for (const [a, u] of Object.entries(util)) {
    if (u === 'rate-limited') {
      latest[a] = { ok: false, error: 'rate-limited', httpStatus: 429, measuredAt: at }
      continue
    }
    const five = typeof u === 'number' ? u : u.five
    const reset = typeof u === 'number' ? RESET_5H_S : (u.reset ?? RESET_5H_S)
    latest[a] = {
      ok: true,
      fiveHour: { utilization: five, resetsAt: reset, status: 'allowed' },
      sevenDay: { utilization: 0.1, resetsAt: RESET_7D_S, status: 'allowed' },
      status: 'allowed',
      resetsAt: reset,
      measuredAt: at,
    }
  }
  writeFileSync(usageFile(sb.paths), JSON.stringify({ latest, previous: {}, groups: [] }) + '\n')
}

function harness(sb: Sandbox) {
  const notes: string[] = []
  const at = (now = NOW, over: Partial<Ctx> = {}): Ctx => sb.ctx({ now: () => now, notify: (_t, m) => void notes.push(m), ...over })
  return { notes, at }
}

const cfgOf = (sb: Sandbox): Config => parseConfig(readFileSync(sb.paths.configFile, 'utf8'), 'cfg', sb.paths.home)
const writeConfig = (sb: Sandbox, swap: Record<string, unknown> = {}): void =>
  writeFileSync(
    sb.paths.configFile,
    JSON.stringify({
      switchboard: 1,
      accounts: { gabriel: {}, admin1: {} },
      swap,
      default: 'bk',
      mux: { bk: { root: '~/bk', account: 'gabriel', accounts: ['gabriel', 'admin1'], pool: ['gabriel', 'admin1'] } },
    }),
  )
const stops = (sb: Sandbox): string[] => sb.calls().filter((c) => c.argv[0] === 'stop').map((c) => c.argv[1]!)
const watchLog = (sb: Sandbox): string => (existsSync(logFile(sb.paths, 'watch')) ? readFileSync(logFile(sb.paths, 'watch'), 'utf8') : '')
const lines = (text: string, needle: string): number => text.split('\n').filter((l) => l.includes(needle)).length
const bkLink = (sb: Sandbox): string | null => currentAccount(sb.paths, 'bk')
const flagsNow = (sb: Sandbox, id: string): string[] => (JSON.parse(readFileSync(join(sb.paths.jobsDir, id, 'state.json'), 'utf8')) as { respawnFlags: string[] }).respawnFlags
/** `claude agents` passa a devolver lixo (exit 4 no adaptador). */
function breakAgents(sb: Sandbox): void {
  mkdirSync(sb.env.FAKE_CLAUDE_DIR!, { recursive: true })
  writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'agents.json'), 'isto não é json')
}

/** Cabeçalhos `unified` da sonda para uma utilização de 5 h. */
function probeHeaders(five: number): Record<string, string> {
  return {
    'anthropic-ratelimit-unified-5h-utilization': String(five),
    'anthropic-ratelimit-unified-5h-reset': String(RESET_5H_S),
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '0.1',
    'anthropic-ratelimit-unified-7d-reset': String(RESET_7D_S),
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-reset': String(RESET_5H_S),
  }
}

/** API falsa que responde por token: `FAKE_TOKEN` = gabriel, `TOKEN_B` = admin1. */
const apiWith = (gabriel: number, admin1: number): Promise<FakeApi> =>
  fakeApi((req) => {
    const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '')
    return new Response('{}', { status: 200, headers: probeHeaders(token === TOKEN_B ? admin1 : gabriel) })
  })

const withApi = (sb: Sandbox, api: FakeApi, now = NOW, notes?: string[]): Ctx =>
  sb.ctx({ now: () => now, env: { ...sb.env, SWITCHBOARD_API_BASE: api.url }, fetch: defaultCtx(sb.env).fetch, ...(notes && { notify: (_t: string, m: string) => void notes.push(m) }) })

describe('tick — medir e trocar', () => {
  test('preferida a 92% → troca para a 2ª do pool, para as livres, notifica', async () => {
    const sb = world()
    addSession(sb, A1, 'free')
    addSession(sb, BUSY, 'busy')
    const api = await apiWith(0.92, 0.2)
    const notes: string[] = []
    try {
      const report = await tick(withApi(sb, api, NOW, notes), cfgOf(sb), fast)
      expect(report.measured).toBe(true)
      expect(api.requests.length).toBe(2) // um token cada
      expect(bkLink(sb)).toBe('admin1')
      expect(report.swaps).toHaveLength(1)
      expect(report.swaps[0]).toMatchObject({ mux: 'bk', from: 'gabriel', to: 'admin1', stopped: [A1], waitingBusy: [BUSY] })
      expect(report.restarts.bk).toMatchObject({ stopped: [A1] })
      expect(stops(sb)).toEqual([A1])
      expect(notes.some((m) => m.includes('admin1'))).toBe(true)
      expect(readRuntime(sb.paths).mux.bk?.lastSwap).toMatchObject({ from: 'gabriel', to: 'admin1', reason: 'gabriel em 92% de 5h' })
      expect(watchLog(sb)).toContain('gabriel em 92% de 5h')
      expect(JSON.stringify(report) + watchLog(sb)).not.toMatch(/sk-ant-/)
    } finally {
      api.stop()
    }
  })

  test('auto false → não troca; notifica uma vez em dois ticks', async () => {
    const sb = world()
    writeConfig(sb, { auto: false })
    setUsage(sb, { gabriel: 0.95, admin1: 0.2 })
    const h = harness(sb)
    const r1 = await tick(h.at(NOW), cfgOf(sb), fast)
    const r2 = await tick(h.at(NOW + 30_000), cfgOf(sb), fast)
    expect(bkLink(sb)).toBe('gabriel')
    expect(r1.swaps).toEqual([])
    expect(r1.evaluations[0]).toMatchObject({ current: 'gabriel', desired: 'admin1' })
    expect(r2.evaluations[0]).toMatchObject({ desired: 'admin1' })
    expect(h.notes.filter((m) => m.includes('admin1'))).toHaveLength(1)
    expect(stops(sb)).toEqual([])
  })

  test('reset da preferida passou → volta para ela', async () => {
    const sb = world()
    pointMux(sb.paths, 'bk', 'admin1')
    writeRuntime(sb.paths, { mux: { bk: { since: NOW - 20 * MIN, lastSwap: { at: NOW - 20 * MIN, from: 'gabriel', to: 'admin1', reason: 'x' } } }, overrides: {}, pending: [], notified: {} })
    // gabriel mostra 95%, mas a janela dela resetou há 1 min: volta a valer
    setUsage(sb, { gabriel: { five: 0.95, reset: NOW / 1000 - 60 }, admin1: 0.5 })
    const report = await tick(harness(sb).at(NOW), cfgOf(sb), fast)
    expect(bkLink(sb)).toBe('gabriel')
    expect(report.swaps[0]).toMatchObject({ from: 'admin1', to: 'gabriel' })
    expect(readRuntime(sb.paths).mux.bk?.lastSwap?.reason).toContain('gabriel')
  })

  test('medição recente (< probeEvery) → nenhuma chamada à API; medição velha → mede', async () => {
    const sb = world()
    const api = await apiWith(0.3, 0.2)
    try {
      setUsage(sb, { gabriel: 0.3, admin1: 0.2 }, NOW - MIN) // probeEvery padrão: 5 min
      const fresh = await tick(withApi(sb, api), cfgOf(sb), fast)
      expect(fresh.measured).toBe(false)
      expect(api.requests).toHaveLength(0)

      const stale = await tick(withApi(sb, api, NOW + 10 * MIN), cfgOf(sb), fast)
      expect(stale.measured).toBe(true)
      expect(api.requests).toHaveLength(2)

      // conta nova no registro (sem medição): mede mesmo com as outras recentes
      writeConfig(sb)
      const cfg = cfgOf(sb)
      cfg.accounts.recem = {}
      sb.addToken('recem', 'sk-ant-oat01-' + 'z'.repeat(40))
      const fresh2 = await tick(withApi(sb, api, NOW + 11 * MIN), cfg, fast)
      expect(fresh2.measured).toBe(true)
    } finally {
      api.stop()
    }
  })

  test('medição desconhecida (falha de rede) nunca causa troca', async () => {
    const sb = world()
    writeFileSync(
      usageFile(sb.paths),
      JSON.stringify({ latest: { gabriel: { ok: false, error: 'network', measuredAt: NOW }, admin1: { ok: false, error: 'network', measuredAt: NOW } }, previous: {}, groups: [] }),
    )
    const report = await tick(harness(sb).at(NOW), cfgOf(sb), fast)
    expect(report.swaps).toEqual([])
    expect(bkLink(sb)).toBe('gabriel')
  })

  test('override vencido é apagado; o vigente fica', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    pointMux(sb.paths, 'bk', 'admin1')
    writeRuntime(sb.paths, { mux: {}, overrides: { bk: { account: 'admin1', until: NOW - 1_000 }, outro: { account: 'x', until: NOW + MIN } }, pending: [], notified: {} })
    await tick(harness(sb).at(NOW), cfgOf(sb), fast)
    expect(readRuntime(sb.paths).overrides).toEqual({ outro: { account: 'x', until: NOW + MIN } })
  })

  test('link do mux ausente → aponta para a preferida e registra', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    rmSync(muxLink(sb.paths, 'bk'))
    expect(bkLink(sb)).toBeNull()
    const report = await tick(harness(sb).at(NOW), cfgOf(sb), fast)
    expect(bkLink(sb)).toBe('gabriel')
    expect(report.notices.join('\n')).toContain('apontei para a preferida gabriel')
    expect(watchLog(sb)).toContain('o link não existia')
  })

  test('uma sessão ocupada na troca é reiniciada num ciclo seguinte, quando fica livre', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.95, admin1: 0.2 })
    addSession(sb, BUSY, 'busy')
    const h = harness(sb)
    const r1 = await tick(h.at(NOW), cfgOf(sb), fast)
    expect(r1.swaps[0]?.waitingBusy).toEqual([BUSY])
    expect(stops(sb)).toEqual([])
    addSession(sb, BUSY, 'free') // o turno acabou
    setUsage(sb, { gabriel: 0.95, admin1: 0.2 }, NOW + 30_000)
    const r2 = await tick(h.at(NOW + 30_000), cfgOf(sb), fast)
    expect(r2.swaps).toEqual([])
    expect(r2.restarts.bk?.stopped).toEqual([BUSY])
    expect(stops(sb)).toEqual([BUSY])
  })
})

describe('tick — cooldown de 5 min', () => {
  test('não troca sozinho duas vezes em menos de 5 min; depois do prazo troca', async () => {
    const sb = world()
    const h = harness(sb)
    setUsage(sb, { gabriel: 0.95, admin1: 0.2 })
    await tick(h.at(NOW), cfgOf(sb), fast)
    expect(bkLink(sb)).toBe('admin1')

    // a preferida volta a servir 1 min depois: o cooldown segura
    setUsage(sb, { gabriel: 0.3, admin1: 0.5 }, NOW + MIN)
    const held = await tick(h.at(NOW + MIN), cfgOf(sb), fast)
    expect(held.evaluations[0]).toMatchObject({ current: 'admin1', desired: 'gabriel' })
    expect(held.swaps).toEqual([])
    expect(bkLink(sb)).toBe('admin1')

    setUsage(sb, { gabriel: 0.3, admin1: 0.5 }, NOW + 6 * MIN)
    const done = await tick(h.at(NOW + 6 * MIN), cfgOf(sb), fast)
    expect(done.swaps[0]).toMatchObject({ from: 'admin1', to: 'gabriel' })
    expect(bkLink(sb)).toBe('gabriel')
  })

  test('exceto se a conta atual está esgotada', async () => {
    const sb = world()
    const h = harness(sb)
    setUsage(sb, { gabriel: 0.95, admin1: 0.2 })
    await tick(h.at(NOW), cfgOf(sb), fast)
    setUsage(sb, { gabriel: 0.3, admin1: 0.95 }, NOW + MIN)
    const r = await tick(h.at(NOW + MIN), cfgOf(sb), fast)
    expect(r.swaps[0]).toMatchObject({ from: 'admin1', to: 'gabriel' })
    expect(readRuntime(sb.paths).mux.bk?.lastSwap?.reason).toBe('admin1 em 95% de 5h')
  })
})

describe('tick — paradas', () => {
  test('no máximo 3 paradas por ciclo; o resto fica para o próximo', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.95, admin1: 0.2 })
    for (const id of [A1, A2, A3, A4]) addSession(sb, id, 'free')
    const h = harness(sb)
    const r1 = await tick(h.at(NOW), cfgOf(sb), fast)
    expect(stops(sb)).toEqual([A1, A2, A3])
    expect(r1.swaps[0]?.stopped).toEqual([A1, A2, A3])
    expect(r1.swaps[0]?.deferred).toEqual([A4])
    expect(r1.restarts.bk?.deferred).toEqual([A4])

    const r2 = await tick(h.at(NOW + 30_000), cfgOf(sb), fast)
    expect(r2.restarts.bk?.stopped).toEqual([A4])
    expect(stops(sb)).toEqual([A1, A2, A3, A4])
  })

  test('parada que falha: não tenta de novo no mesmo since e notifica uma vez', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.95, admin1: 0.2 })
    addSession(sb, A1, 'free')
    writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'stop-fail'), '')
    const h = harness(sb)
    const r1 = await tick(h.at(NOW), cfgOf(sb), fast)
    expect(r1.swaps[0]?.failed).toHaveLength(1)
    expect(stops(sb)).toEqual([A1])
    expect(h.notes.filter((m) => m.includes('Não consegui parar'))).toHaveLength(1)
    expect(readRuntime(sb.paths).notified[`stopfail:${A1}:${NOW}`]).toBe(NOW)

    for (const t of [30_000, 60_000]) {
      const r = await tick(h.at(NOW + t), cfgOf(sb), fast)
      expect(r.restarts.bk?.deferred).toEqual([A1])
      expect(r.restarts.bk?.failed).toEqual([])
    }
    rmSync(join(sb.env.FAKE_CLAUDE_DIR!, 'stop-fail')) // mesmo funcionando de novo, o since é o mesmo: não tenta
    await tick(h.at(NOW + 90_000), cfgOf(sb), fast)
    expect(stops(sb)).toEqual([A1])
    expect(h.notes.filter((m) => m.includes('Não consegui parar'))).toHaveLength(1)
  })

  test('sessão que não morre (pid continua) também recua', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.95, admin1: 0.2 })
    addSession(sb, A1, 'free')
    writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'stop-stuck'), '')
    const h = harness(sb)
    const opts: TickOptions = { restart: { stopTimeoutMs: 500, stop: { pollMs: 250, sleep: () => undefined } } }
    const r1 = await tick(h.at(NOW), cfgOf(sb), opts)
    expect(r1.swaps[0]?.failed).toHaveLength(1)
    await tick(h.at(NOW + 30_000), cfgOf(sb), opts)
    expect(stops(sb)).toEqual([A1])
  })

  test('troca interrompida (link já aponta, since nunca foi gravado) → o watch grava e reinicia; o 2º ciclo não mexe', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.95, admin1: 0.2 })
    pointMux(sb.paths, 'bk', 'admin1') // caiu depois do pointMux
    writeRuntime(sb.paths, { mux: { bk: { since: NOW - 3 * 60 * MIN, lastSwap: { at: NOW - 3 * 60 * MIN, from: 'admin1', to: 'gabriel', reason: 'x' } } }, overrides: {}, pending: [], notified: {} })
    addSession(sb, A1, 'free') // aberta antes
    addSession(sb, 'eeeeeee5', 'free', { startedAt: NOW + 1_000 }) // nasceu depois: nunca é parada
    const h = harness(sb)
    const r1 = await tick(h.at(NOW), cfgOf(sb), fast)
    expect(r1.swaps).toEqual([])
    expect(r1.restarts.bk?.stopped).toEqual([A1])
    const rt = readRuntime(sb.paths).mux.bk
    expect(rt?.since).toBe(NOW)
    expect(rt?.lastSwap).toMatchObject({ from: 'gabriel', to: 'admin1' })

    await tick(h.at(NOW + 30_000), cfgOf(sb), fast)
    expect(readRuntime(sb.paths).mux.bk?.since).toBe(NOW) // idempotente
    expect(stops(sb)).toEqual([A1])
  })

  test('mux nunca trocado (sem lastSwap): nenhuma parada, mesmo com o link fora da preferida', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.95, admin1: 0.2 })
    pointMux(sb.paths, 'bk', 'admin1') // p.ex. `sb mux set` mudou a preferida depois
    addSession(sb, A1, 'free')
    await tick(harness(sb).at(NOW), cfgOf(sb), fast)
    expect(stops(sb)).toEqual([])
    expect(readRuntime(sb.paths).mux).toEqual({})
  })

  test('mux nunca trocado, link na preferida: nenhuma parada', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    addSession(sb, A1, 'free')
    await tick(harness(sb).at(NOW), cfgOf(sb), fast)
    expect(stops(sb)).toEqual([])
    expect(readRuntime(sb.paths).mux).toEqual({})
  })
})

describe('tick — fila de pins', () => {
  test('pending aplicado quando a sessão fica livre (e nada é notificado enquanto espera)', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    addSession(sb, ID, 'busy')
    const h = harness(sb)
    expect(pinSession(h.at(NOW), cfgOf(sb), ID, 'admin1').result).toBe('queued')

    const waiting = await tick(h.at(NOW + 30_000), cfgOf(sb), fast)
    expect(waiting.pending.map((p) => p.result)).toEqual(['queued'])
    expect(readRuntime(sb.paths).pending).toHaveLength(1)
    expect(h.notes).toEqual([])
    expect(stops(sb)).toEqual([])

    addSession(sb, ID, 'free')
    const done = await tick(h.at(NOW + 60_000), cfgOf(sb), fast)
    expect(done.pending.map((p) => p.result)).toEqual(['stopped-and-rewritten'])
    expect(readRuntime(sb.paths).pending).toEqual([])
    expect(flagsNow(sb, ID).at(-1)).toBe(pinLink(sb.paths, 'admin1'))
    expect(stops(sb)).toEqual([ID])
    expect(h.notes.filter((m) => m.includes('fixada em admin1'))).toHaveLength(1) // só o `applyPending` avisa
  })

  test('item descartado (a sessão sumiu) → uma notificação', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    addSession(sb, ID, 'busy')
    const h = harness(sb)
    pinSession(h.at(NOW), cfgOf(sb), ID, 'admin1')
    writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'agents.json'), '[]\n')
    const r = await tick(h.at(NOW + 30_000), cfgOf(sb), fast)
    expect(r.pending.map((p) => p.result)).toEqual(['gone'])
    expect(h.notes.filter((m) => m.includes(ID) && m.includes('descartado'))).toHaveLength(1)
    await tick(h.at(NOW + 60_000), cfgOf(sb), fast)
    expect(h.notes.filter((m) => m.includes('descartado'))).toHaveLength(1)
  })

  test('as paradas da fila dividem o mesmo teto do ciclo', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    const ids = [A1, A2, A3, A4]
    for (const id of ids) {
      addSession(sb, id, 'busy')
      pinSession(harness(sb).at(NOW), cfgOf(sb), id, 'admin1')
      addSession(sb, id, 'free')
    }
    const r = await tick(harness(sb).at(NOW + 30_000), cfgOf(sb), fast)
    expect(r.pending.filter((p) => p.result === 'stopped-and-rewritten')).toHaveLength(3)
    expect(r.pending.filter((p) => p.result === 'queued')).toHaveLength(1)
    expect(stops(sb)).toHaveLength(3)
  })
})

describe('tick — observação', () => {
  test('limit-blocked viva → um snapshot no watch.log, sem token', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    addSession(sb, A1, 'limit-blocked')
    const h = harness(sb)
    await tick(h.at(NOW), cfgOf(sb), fast)
    await tick(h.at(NOW + 30_000), cfgOf(sb), fast)
    const log = watchLog(sb)
    expect(lines(log, 'presa por limite')).toBe(1)
    expect(log).toContain('"owner":"mux:bk"')
    expect(log).toContain('"needs":"rate limited until 17:00"')
    expect(log).not.toMatch(/sk-ant-/)

    // saiu do limite e entrou de novo: novo snapshot
    addSession(sb, A1, 'free')
    await tick(h.at(NOW + 60_000), cfgOf(sb), fast)
    addSession(sb, A1, 'limit-blocked')
    await tick(h.at(NOW + 90_000), cfgOf(sb), fast)
    expect(lines(watchLog(sb), 'presa por limite')).toBe(2)
  })

  test('sessão viva sem inFlight vai para a lista "mantidas" (uma linha no log)', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    addSession(sb, A1, 'noflight')
    const h = harness(sb)
    const r1 = await tick(h.at(NOW), cfgOf(sb), fast)
    const r2 = await tick(h.at(NOW + 30_000), cfgOf(sb), fast)
    expect(r1.kept).toEqual([A1])
    expect(r2.kept).toEqual([A1])
    expect(lines(watchLog(sb), 'sem inFlight') + lines(watchLog(sb), 'não tem inFlight')).toBe(1)
  })

  test('aviso de state.json ilegível não se repete no log a cada ciclo', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    sb.addJob({ agent: { id: 'abcdef08', startedAt: OLD, pid: 4242, status: 'idle' } })
    mkdirSync(join(sb.paths.jobsDir, 'abcdef08'), { recursive: true })
    writeFileSync(join(sb.paths.jobsDir, 'abcdef08', 'state.json'), '{ nao eh json')
    const h = harness(sb)
    for (let i = 0; i < 3; i++) await tick(h.at(NOW + i * 30_000), cfgOf(sb), fast)
    expect(lines(watchLog(sb), 'sessão abcdef08:')).toBe(1)
  })

  test('`claude agents` fora do ar não derruba o ciclo; o erro vai ao log uma vez', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    writeRuntime(sb.paths, { mux: { bk: { since: OLD, lastSwap: { at: OLD, from: 'admin1', to: 'gabriel', reason: 'x' } } }, overrides: {}, pending: [], notified: {} })
    breakAgents(sb)
    const h = harness(sb)
    const r1 = await tick(h.at(NOW), cfgOf(sb), fast)
    await tick(h.at(NOW + 30_000), cfgOf(sb), fast)
    expect(r1.evaluations).toHaveLength(1)
    expect(r1.notices.join('\n')).toContain('não devolveu JSON')
    expect(lines(watchLog(sb), 'não devolveu JSON')).toBe(1)
  })

  test('poda de runtime.notified: antigas (> 7 dias) e de sessões que não existem mais', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    addSession(sb, A1, 'busy')
    const day = 24 * 60 * MIN
    writeRuntime(sb.paths, {
      mux: {},
      overrides: {},
      pending: [],
      notified: {
        'warn:velho': NOW - 8 * day,
        'warn:novo': NOW - day,
        'sched:deadbeef:gabriel': NOW - day,
        [`sched:${A1}:gabriel`]: NOW - day,
        'stopfail:deadbeef:1': NOW - day,
        [`stopfail:${A1}:1`]: NOW - day,
        'stopfail:cafecafe:2': NOW - 9 * day,
        'pin:deadbeef:unreadable': NOW - day,
        'swap:bk:admin1': NOW - 8 * day,
        'chave-de-outra-coisa': NOW - 30 * day,
      },
    })
    await tick(harness(sb).at(NOW), cfgOf(sb), fast)
    expect(Object.keys(readRuntime(sb.paths).notified).sort()).toEqual(['chave-de-outra-coisa', `sched:${A1}:gabriel`, `stopfail:${A1}:1`, 'warn:novo'].sort())
  })

  test('`claude agents` fora do ar: a poda só olha a idade (não apaga chave de sessão)', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    breakAgents(sb)
    writeRuntime(sb.paths, { mux: {}, overrides: {}, pending: [], notified: { [`stopfail:${A1}:1`]: NOW - 1_000 } })
    await tick(harness(sb).at(NOW), cfgOf(sb), fast)
    expect(readRuntime(sb.paths).notified[`stopfail:${A1}:1`]).toBe(NOW - 1_000)
  })
})

describe('tick — runtime.json e lock', () => {
  test('runtime.json corrompido → vai para runtime.json.corrupt-<ts>, notifica e o ciclo segue vazio', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    writeFileSync(runtimeFile(sb.paths), '{ "mux": { corrompido')
    const h = harness(sb)
    const r1 = await tick(h.at(NOW), cfgOf(sb), fast)
    const asides = readdirSync(sb.paths.stateDir).filter((n) => n.startsWith('runtime.json.corrupt-'))
    expect(asides).toHaveLength(1)
    expect(readFileSync(join(sb.paths.stateDir, asides[0]!), 'utf8')).toContain('corrompido')
    expect(h.notes.filter((m) => m.includes('corrompido'))).toHaveLength(1)
    expect(r1.evaluations).toHaveLength(1)
    expect(readRuntime(sb.paths).pending).toEqual([]) // lê sem lançar
    await tick(h.at(NOW + 30_000), cfgOf(sb), fast)
    expect(h.notes.filter((m) => m.includes('corrompido'))).toHaveLength(1)
  })

  test('lock ocupado por pid vivo → skipped, sem medir nem trocar', async () => {
    const sb = world()
    const api = await apiWith(0.95, 0.2)
    try {
      const report = await withLock(sb.paths, () => tick(withApi(sb, api), cfgOf(sb), fast))
      expect(report.skipped).toBe('locked')
      expect(report.measured).toBe(false)
      expect(api.requests).toHaveLength(0)
      expect(bkLink(sb)).toBe('gabriel')
    } finally {
      api.stop()
    }
  })

  test('lock de pid morto é tomado (waitMs 0 não tomaria)', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    writeFileSync(lockFile(sb.paths), String(DEAD_PID))
    const report = await tick(harness(sb).at(NOW), cfgOf(sb), fast)
    expect(report.skipped).toBeUndefined()
    expect(report.evaluations).toHaveLength(1)
    expect(existsSync(lockFile(sb.paths))).toBe(false) // largou no fim
  })

  test('lock de dono vivo que não é o watch, por vários ciclos → avisa uma vez e segue', async () => {
    const sb = world()
    writeFileSync(lockFile(sb.paths), String(process.ppid)) // um pid vivo qualquer, que não é o nosso
    const h = harness(sb)
    const memory = newMemory()
    const reports = []
    for (let i = 0; i < 5; i++) reports.push(await tick(h.at(NOW + i * 30_000), cfgOf(sb), { ...fast, memory }))
    expect(reports.every((r) => r.skipped === 'locked')).toBe(true)
    expect(h.notes.filter((m) => m.includes(`pid ${process.ppid}`))).toHaveLength(1)
    expect(lines(watchLog(sb), `pid ${process.ppid}`)).toBe(1)

    // o dono largou: o ciclo volta a andar e um novo episódio avisaria de novo
    rmSync(lockFile(sb.paths))
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 }, NOW + 5 * 30_000)
    const ok = await tick(h.at(NOW + 5 * 30_000), cfgOf(sb), { ...fast, memory })
    expect(ok.skipped).toBeUndefined()
    expect(memory.lockedTicks).toBe(0)
  })
})

describe('watchLoop', () => {
  test('config inválida → nenhum swap, erro no log (uma vez), batimento escrito e depois apagado', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.95, admin1: 0.2 })
    writeFileSync(sb.paths.configFile, '{ nope')
    const ctx = harness(sb).at(NOW)
    let sawHeartbeat = 0
    await watchLoop(ctx, 1, {
      maxTicks: 3,
      sleep: async () => {
        if (existsSync(watchFile(sb.paths))) sawHeartbeat++ // escrito mesmo com a config inválida
      },
      tick: fast,
    })
    expect(bkLink(sb)).toBe('gabriel')
    expect(lines(watchLog(sb), 'config inválida')).toBe(1)
    expect(watchLog(sb)).toContain('nada será trocado')
    expect(sawHeartbeat).toBe(2)
    expect(existsSync(watchFile(sb.paths))).toBe(false)
    expect(sb.calls().filter((c) => c.argv[0] === 'stop')).toEqual([])
  })

  test('recarrega a config a cada ciclo: corrigida, o laço volta a trocar', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.95, admin1: 0.2 })
    writeFileSync(sb.paths.configFile, '{ nope')
    const ctx = harness(sb).at(NOW)
    let n = 0
    await watchLoop(ctx, 1, {
      maxTicks: 2,
      sleep: async () => {
        if (++n === 1) writeConfig(sb)
      },
      tick: fast,
    })
    expect(bkLink(sb)).toBe('admin1')
    expect(watchLog(sb)).toContain('o ciclo voltou a funcionar')
  })

  test('batimento: { pid, lastTick } a cada ciclo; watchStatus running → absent ao sair limpo', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    const ctx = harness(sb).at(NOW)
    expect(watchStatus(ctx)).toEqual({ state: 'absent' })
    const seen: unknown[] = []
    await watchLoop(ctx, 1, {
      maxTicks: 2,
      sleep: async () => {
        seen.push(JSON.parse(readFileSync(watchFile(sb.paths), 'utf8')))
        expect(watchStatus(ctx).state).toBe('running')
      },
      tick: fast,
    })
    expect(seen).toEqual([{ pid: process.pid, lastTick: NOW }])
    expect(watchStatus(ctx)).toEqual({ state: 'absent' })
  })

  test('sinal (AbortSignal) interrompe a espera e sai limpo', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    const ac = new AbortController()
    const t0 = Date.now()
    const done = watchLoop(harness(sb).at(NOW), 60_000, { signal: ac.signal, tick: fast })
    setTimeout(() => ac.abort(), 300)
    await done
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(existsSync(watchFile(sb.paths))).toBe(false)
    expect(watchLog(sb)).toContain('watch encerrado')
  })

  test('sb watch: SIGTERM encerra com exit 0, apaga o batimento e não deixa processo', async () => {
    const sb = populatedSandbox()
    const child = spawn(process.execPath, [join(import.meta.dir, '..', 'src', 'cli.ts'), 'watch'], { env: sb.env, cwd: sb.dir, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')))
    const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
    const guard = setTimeout(() => child.kill('SIGKILL'), 20_000)
    try {
      const deadline = Date.now() + 10_000
      while (!existsSync(watchFile(sb.paths)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      expect(existsSync(watchFile(sb.paths))).toBe(true)
      expect((JSON.parse(readFileSync(watchFile(sb.paths), 'utf8')) as { pid: number }).pid).toBe(child.pid!)
      child.kill('SIGTERM')
      expect(await closed).toBe(0)
      expect(stderr).toBe('')
      expect(existsSync(watchFile(sb.paths))).toBe(false)
      expect(watchLog(sb)).toContain('watch encerrado')
    } finally {
      clearTimeout(guard)
      child.kill('SIGKILL')
    }
  })
})

describe('watchStatus', () => {
  const put = (sb: Sandbox, v: unknown): void => writeFileSync(watchFile(sb.paths), typeof v === 'string' ? v : JSON.stringify(v))

  test('rodando = pid vivo e ciclo há menos de 3 intervalos; o resto é parado', () => {
    const sb = populatedSandbox()
    const ctx = harness(sb).at(NOW)
    expect(watchStatus(ctx)).toEqual({ state: 'absent' })
    put(sb, { pid: process.pid, lastTick: NOW - 80_000 })
    expect(watchStatus(ctx).state).toBe('running')
    put(sb, { pid: process.pid, lastTick: NOW - 91_000 })
    expect(watchStatus(ctx).state).toBe('stale')
    put(sb, { pid: DEAD_PID, lastTick: NOW })
    expect(watchStatus(ctx).state).toBe('stale')
    put(sb, '{ ilegível')
    expect(watchStatus(ctx).state).toBe('stale')
    put(sb, { pid: 'x' })
    expect(watchStatus(ctx).state).toBe('stale')
  })
})

describe('sb pin / sb unpin — aviso de watch parado', () => {
  const queued = async (run: 'pin' | 'unpin', sb: Sandbox, json = false) => {
    const ctx = harness(sb).at(NOW)
    if (run === 'pin') {
      addSession(sb, ID, 'busy')
      return runPin(ctx, { session: ID, account: 'admin1', json })
    }
    addSession(sb, ID, 'busy', { settings: pinLink(sb.paths, 'admin1') })
    return runUnpin(ctx, { session: ID, json })
  }

  for (const run of ['pin', 'unpin'] as const) {
    test(`${run} na fila sem watch → ⚠ real; com watch vivo → sem aviso`, async () => {
      const a = world()
      const r = await queued(run, a)
      expect(r.outcome.result).toBe('queued')
      expect(r.text).toContain('⚠')
      expect(r.text).toContain('não está rodando')

      const b = world()
      writeFileSync(watchFile(b.paths), JSON.stringify({ pid: process.pid, lastTick: NOW - 10_000 }))
      const ok = await queued(run, b)
      expect(ok.text).not.toContain('⚠')
      expect(ok.text).toContain('está rodando')

      const c = world()
      writeFileSync(watchFile(c.paths), JSON.stringify({ pid: DEAD_PID, lastTick: NOW }))
      const stale = await queued(run, c)
      expect(stale.text).toContain('⚠')
      expect(stale.text).toContain('parece parado')
    })
  }

  test('--json da fila traz `watch`; os outros resultados não mudam de forma', async () => {
    const a = world()
    const j = JSON.parse((await queued('pin', a, true)).text) as Record<string, unknown>
    expect(j.result).toBe('queued')
    expect(j.watch).toBe('absent')

    const b = world()
    addSession(b, ID, 'free')
    b.addJob({ agent: { id: ID, startedAt: OLD }, state: stateFor(flagsOf(muxLink(b.paths, 'bk')), 'free') }) // parada
    const done = JSON.parse((await runPin(harness(b).at(NOW), { session: ID, account: 'admin1', json: true })).text) as Record<string, unknown>
    expect(done.result).toBe('rewritten')
    expect('watch' in done).toBe(false)
  })

  test('`claude stop` falhou (o pedido ficou na fila): o erro também avisa do watch', async () => {
    const sb = world()
    addSession(sb, ID, 'free')
    writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'stop-fail'), '')
    const err = (await runPin(harness(sb).at(NOW), { session: ID, account: 'admin1' }).catch((e: unknown) => e)) as SbError
    expect(err.exit).toBe(EXIT.CHECK_FAILED)
    expect(err.detail).toContain('ficou na fila')
    expect(err.detail).toContain('não está rodando')

    writeFileSync(watchFile(sb.paths), JSON.stringify({ pid: process.pid, lastTick: NOW }))
    const err2 = (await runPin(harness(sb).at(NOW), { session: ID, account: 'admin1' }).catch((e: unknown) => e)) as SbError
    expect(err2.detail).toContain('ficou na fila')
    expect(err2.detail).not.toContain('não está rodando')
  })
})

describe('sb watch --once (CLI)', () => {
  test('um ciclo, --json sem token; não grava o batimento', () => {
    const sb = world()
    addSession(sb, A1, 'free')
    const r = sb.runSb(['watch', '--once', '--json'])
    expect(r.code).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/sk-ant-/)
    const j = JSON.parse(r.stdout) as { evaluations: unknown[]; measured: boolean; notices: string[] }
    expect(j.evaluations).toHaveLength(1)
    expect(existsSync(watchFile(sb.paths))).toBe(false)
  })

  test('texto em português; lock ocupado → exit 5; --json sem --once → exit 3; config inválida → exit 2', async () => {
    const sb = world()
    const ok = sb.runSb(['watch', '--once'])
    expect(ok.code).toBe(0)
    expect(ok.stdout).toContain('mux bk')

    const locked = await withLock(sb.paths, async () => sb.runSb(['watch', '--once']))
    expect(locked.code).toBe(EXIT.LOCKED)
    expect(locked.stdout).toContain('lock')

    expect(sb.runSb(['watch', '--json']).code).toBe(EXIT.USAGE)

    writeFileSync(sb.paths.configFile, '{ nope')
    expect(sb.runSb(['watch', '--once']).code).toBe(EXIT.INVALID_CONFIG)
  })
})

describe('rodada de correções 1', () => {
  const breakWith = (sb: Sandbox, text: string): void => {
    mkdirSync(sb.env.FAKE_CLAUDE_DIR!, { recursive: true })
    writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'agents.json'), text)
  }
  const errKeys = (sb: Sandbox): string[] => Object.keys(readRuntime(sb.paths).notified).filter((k) => k.startsWith('err:'))

  test('pane de uma etapa: um log e uma notificação por pane; texto variável não cria chave; recuperou limpa; nova pane avisa de novo', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    writeRuntime(sb.paths, { mux: { bk: { since: OLD, lastSwap: { at: OLD, from: 'admin1', to: 'gabriel', reason: 'x' } } }, overrides: {}, pending: [], notified: {} })
    const h = harness(sb)
    const out = (): number => h.notes.filter((m) => m.includes('não devolveu JSON')).length

    breakWith(sb, 'lixo um')
    await tick(h.at(NOW), cfgOf(sb), fast)
    breakWith(sb, 'outro lixo, bem diferente')
    await tick(h.at(NOW + 30_000), cfgOf(sb), fast)
    await tick(h.at(NOW + 60_000), cfgOf(sb), fast)
    expect(lines(watchLog(sb), 'não devolveu JSON')).toBe(1)
    expect(out()).toBe(1)
    expect(errKeys(sb)).toEqual(['err:agents:4']) // por etapa e exit, não pelo texto

    breakWith(sb, '[]\n') // voltou
    await tick(h.at(NOW + 90_000), cfgOf(sb), fast)
    expect(errKeys(sb)).toEqual([])

    breakWith(sb, 'quebrou de novo')
    await tick(h.at(NOW + 120_000), cfgOf(sb), fast)
    expect(lines(watchLog(sb), 'não devolveu JSON')).toBe(2)
    expect(out()).toBe(2)
    expect(errKeys(sb)).toEqual(['err:agents:4'])
  })

  test('mux sem link e sem token da preferida: avisa uma vez, a chave sai quando o link existe', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    rmSync(muxLink(sb.paths, 'bk'))
    rmSync(join(sb.paths.stateDir, 'tokens', 'gabriel.json'))
    const h = harness(sb)
    await tick(h.at(NOW), cfgOf(sb), fast)
    await tick(h.at(NOW + 30_000), cfgOf(sb), fast)
    expect(h.notes.filter((m) => m.includes('não tem token'))).toHaveLength(1)
    expect(errKeys(sb)).toHaveLength(1)
    sb.addToken('gabriel')
    await tick(h.at(NOW + 60_000), cfgOf(sb), fast)
    expect(bkLink(sb)).toBe('gabriel')
    await tick(h.at(NOW + 90_000), cfgOf(sb), fast)
    expect(errKeys(sb)).toEqual([])
  })

  test('fila de pins: parada que falha não é repetida no mesmo pedido; notifica uma vez', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    addSession(sb, ID, 'busy')
    const h = harness(sb)
    expect(pinSession(h.at(NOW), cfgOf(sb), ID, 'admin1').result).toBe('queued')
    addSession(sb, ID, 'free')
    writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'stop-fail'), '')
    for (const t of [30_000, 60_000, 90_000]) {
      const r = await tick(h.at(NOW + t), cfgOf(sb), fast)
      expect(r.pending.map((p) => p.result)).toEqual(['queued'])
    }
    expect(stops(sb)).toEqual([ID])
    expect(h.notes.filter((m) => m.includes('Não consegui parar'))).toHaveLength(1)
    rmSync(join(sb.env.FAKE_CLAUDE_DIR!, 'stop-fail')) // mesmo funcionando de novo, é o mesmo pedido
    await tick(h.at(NOW + 120_000), cfgOf(sb), fast)
    expect(stops(sb)).toEqual([ID])
    expect(readRuntime(sb.paths).pending).toHaveLength(1)

    // um pedido novo (requestedAt novo) volta a tentar
    expect(pinSession(h.at(NOW + 150_000), cfgOf(sb), ID, 'admin1').result).toBe('stopped-and-rewritten')
    expect(stops(sb)).toEqual([ID, ID])
  })

  describe('um só watch por máquina', () => {
    test('o laço recusa (exit 5) enquanto um vivo segura o pid file; pid morto é tomado e o arquivo some ao sair', async () => {
      const sb = world()
      setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
      writeFileSync(watchPidFile(sb.paths), String(process.ppid))
      const err = (await watchLoop(harness(sb).at(NOW), 1, { maxTicks: 1, tick: fast }).catch((e: unknown) => e)) as SbError
      expect(err).toBeInstanceOf(SbError)
      expect(err.exit).toBe(EXIT.LOCKED)
      expect(err.message).toContain(`pid ${process.ppid}`)
      expect(readFileSync(watchPidFile(sb.paths), 'utf8')).toBe(String(process.ppid))
      expect(existsSync(watchFile(sb.paths))).toBe(false)

      writeFileSync(watchPidFile(sb.paths), String(DEAD_PID))
      await watchLoop(harness(sb).at(NOW), 1, { maxTicks: 1, tick: fast })
      expect(existsSync(watchPidFile(sb.paths))).toBe(false)
    })

    test('CLI: segundo `sb watch` → exit 5; `--once` não é barrado', () => {
      const sb = world()
      writeFileSync(watchPidFile(sb.paths), String(process.ppid))
      const second = sb.runSb(['watch'])
      expect(second.code).toBe(EXIT.LOCKED)
      expect(second.stderr).toContain('watch')
      expect(sb.runSb(['watch', '--once']).code).toBe(0)
      expect(readFileSync(watchPidFile(sb.paths), 'utf8')).toBe(String(process.ppid))
    })
  })

  describe('renderTick mostra o que ficou para trás', () => {
    test('falhas, adiadas e aguardando o fim do turno (troca e reinício)', async () => {
      const sb = world()
      setUsage(sb, { gabriel: 0.95, admin1: 0.2 })
      addSession(sb, BUSY, 'busy')
      for (const id of [A1, A2, A3, A4]) addSession(sb, id, 'free')
      const h = harness(sb)
      const r1 = await tick(h.at(NOW), cfgOf(sb), fast)
      const t1 = renderTick(r1)
      expect(t1).toMatch(/aguardando.*ccccccc3/)
      expect(t1).toMatch(/adiadas.*aaaaaaa4/)

      const sb2 = world()
      setUsage(sb2, { gabriel: 0.95, admin1: 0.2 })
      addSession(sb2, A1, 'free')
      writeFileSync(join(sb2.env.FAKE_CLAUDE_DIR!, 'stop-fail'), '')
      const h2 = harness(sb2)
      const f1 = renderTick(await tick(h2.at(NOW), cfgOf(sb2), fast))
      expect(f1).toMatch(/não consegui parar aaaaaaa1/)
      const f2 = renderTick(await tick(h2.at(NOW + 30_000), cfgOf(sb2), fast)) // mux que não trocou agora (reinício)
      expect(f2).toMatch(/adiadas.*aaaaaaa1/)
    })
  })
})
