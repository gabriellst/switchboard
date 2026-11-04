import { describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runSwap } from '../src/commands/swap.js'
import { renderSwap, type SwapReport } from '../src/report.js'
import { loadConfig } from '../src/core/config.js'
import type { Ctx } from '../src/core/ctx.js'
import { EXIT, SbError, type ExitCode } from '../src/core/errors.js'
import { withLock } from '../src/core/fsx.js'
import { currentAccount, pointMux } from '../src/core/links.js'
import { logFile, muxLink, pinLink, runtimeFile, tokenFile, usageFile } from '../src/core/paths.js'
import { readRuntime, writeRuntime } from '../src/core/runtime.js'
import { applySwap, manualSwap, restartStale } from '../src/core/swap.js'
import { ensureState } from '../src/core/tokens.js'
import { FAKE_TOKEN, populatedSandbox, type Sandbox } from './helpers.js'

/** Relógio fixo: tudo o que é "antigo" nasceu antes, tudo o que é "novo" depois (a comparação é estrita). */
const NOW = 1_800_000_000_000
const OLD = NOW - 60_000
const NEW = NOW + 1_000
const RESET_5H_S = NOW / 1000 + 7_200

const IDS = {
  a: 'aaaaaaa1', // bk, free, antiga
  b: 'bbbbbbb2', // bk, limit-blocked, antiga
  c: 'ccccccc3', // bk, busy, antiga
  d: 'ddddddd4', // bk, scheduled, antiga
  e: 'eeeeeee5', // bk, free, NOVA
  f: 'fffffff6', // pin admin1, free
  g: 'abcdef07', // mux pessoal, free
  h: 'abcdef08', // bk, state.json malformado (viva): dono desconhecido
  i: 'abcdef09', // legado, free
  j: 'abcdef0a', // --settings de terceiros (com token inline), free
  k: 'abcdef0b', // sem --settings, free
  l: 'abcdef0c', // bk, free, antiga, já PARADA (sem pid)
}

type Kind = 'free' | 'limit-blocked' | 'busy' | 'scheduled'

const stateFor = (flags: string[], kind: Kind): Record<string, unknown> => {
  const base = { respawnFlags: flags }
  switch (kind) {
    case 'free':
      return { ...base, state: 'done', inFlight: { tasks: 0, queued: 0, kinds: [] } }
    case 'limit-blocked':
      return { ...base, state: 'blocked', needs: 'rate limited until 17:00', inFlight: { tasks: 0, queued: 1, kinds: [] } }
    case 'busy':
      return { ...base, state: 'working', inFlight: { tasks: 1, queued: 0, kinds: ['local_agent'] } }
    case 'scheduled':
      return { ...base, state: 'done', inFlight: { tasks: 0, queued: 0, kinds: ['session_cron'] } }
  }
}

function addSession(sb: Sandbox, id: string, settings: string[], kind: Kind, o: { startedAt?: number; pid?: number | null } = {}): void {
  const live = o.pid !== null
  sb.addJob({
    agent: { id, startedAt: o.startedAt ?? OLD, ...(live && { pid: o.pid ?? 4242, status: kind === 'busy' ? 'busy' : 'idle' }) },
    state: stateFor(settings, kind),
  })
}

const flags = (settings: string): string[] => ['--allowed-tools', 'Read', '--settings', settings, '--allowed-tools', 'Bash']

/** bk (pool gabriel→admin1), pessoal, berzerk (sem pool, keychain); usage com resets no futuro do relógio fixo. */
function world(): Sandbox {
  const sb = populatedSandbox()
  const p = sb.paths
  writeFileSync(
    p.configFile,
    JSON.stringify({
      switchboard: 1,
      accounts: { gabriel: {}, admin1: {}, solo: {} },
      default: 'bk',
      mux: {
        bk: { root: '~/bk', account: 'gabriel', accounts: ['gabriel', 'admin1'], pool: ['gabriel', 'admin1'] },
        pessoal: { root: '~/pessoal', account: 'admin1', accounts: ['admin1', 'gabriel', 'solo'], pool: ['admin1', 'gabriel'] },
        berzerk: { root: '~/bz', account: 'keychain', accounts: ['keychain', 'admin1'], pool: [] },
      },
    }),
  )
  ensureState(p)
  sb.addToken('solo')
  pointMux(p, 'pessoal', 'admin1')
  pointMux(p, 'berzerk', 'keychain')
  setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
  return sb
}

function setUsage(sb: Sandbox, util: Record<string, number | 'rate-limited'>): void {
  const latest: Record<string, unknown> = {}
  for (const [a, u] of Object.entries(util)) {
    latest[a] =
      u === 'rate-limited'
        ? { ok: false, error: 'rate-limited', httpStatus: 429, measuredAt: NOW }
        : {
            ok: true,
            fiveHour: { utilization: u, resetsAt: RESET_5H_S, status: 'allowed' },
            sevenDay: { utilization: 0.1, resetsAt: NOW / 1000 + 300_000, status: 'allowed' },
            status: 'allowed',
            resetsAt: RESET_5H_S,
            measuredAt: NOW,
          }
  }
  writeFileSync(usageFile(sb.paths), JSON.stringify({ latest, previous: {}, groups: [] }) + '\n')
}

/** Todas as sessões do cenário principal (a..l). */
function addAll(sb: Sandbox): void {
  const p = sb.paths
  const bk = flags(muxLink(p, 'bk'))
  addSession(sb, IDS.a, bk, 'free')
  addSession(sb, IDS.b, bk, 'limit-blocked')
  addSession(sb, IDS.c, bk, 'busy')
  addSession(sb, IDS.d, bk, 'scheduled')
  addSession(sb, IDS.e, bk, 'free', { startedAt: NEW })
  addSession(sb, IDS.f, flags(pinLink(p, 'admin1')), 'free')
  addSession(sb, IDS.g, flags(muxLink(p, 'pessoal')), 'free')
  // h: viva, state.json que não é JSON → `job: null`, dono desconhecido
  sb.addJob({ agent: { id: IDS.h, startedAt: OLD, pid: 4242, status: 'idle' } })
  mkdirSync(join(p.jobsDir, IDS.h), { recursive: true })
  writeFileSync(join(p.jobsDir, IDS.h, 'state.json'), '{ nao eh json')
  addSession(sb, IDS.i, flags(join(p.claudeDir, 'contas', 'x.json')), 'free')
  addSession(sb, IDS.j, ['--settings', JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } })], 'free')
  addSession(sb, IDS.k, ['--allowed-tools', 'Read'], 'free')
  addSession(sb, IDS.l, bk, 'free', { pid: null })
}

const stops = (sb: Sandbox): string[] => sb.calls().filter((c) => c.argv[0] === 'stop').map((c) => c.argv[1]!)
const agentsFile = (sb: Sandbox): Array<Record<string, unknown>> => JSON.parse(readFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'agents.json'), 'utf8'))
const live = (sb: Sandbox, id: string): boolean => agentsFile(sb).find((a) => a.id === id)?.pid !== undefined
const ctxAt = (sb: Sandbox, over: Partial<Ctx> = {}): Ctx => sb.ctx({ now: () => NOW, ...over })

/** Ctx cujo `run` chama `hook(args)` antes de delegar ao claude falso (o `claude stop`/`agents` de cada chamada). */
function hooked(sb: Sandbox, hook: (args: string[]) => { status: number; stderr?: string } | void, over: Partial<Ctx> = {}): Ctx {
  const base = ctxAt(sb)
  return ctxAt(sb, {
    run: (cmd, args, opts) => {
      const r = hook(args)
      if (r) return { status: r.status, stdout: '', stderr: r.stderr ?? '' }
      return base.run(cmd, args, opts)
    },
    ...over,
  })
}

/** O CLI usa o relógio real: as sessões "antigas" passam a ser do passado real e a "nova" (e) do futuro real. */
function realClock(sb: Sandbox): void {
  const list = agentsFile(sb)
  for (const a of list) a.startedAt = a.startedAt === NEW ? Date.now() + 3_600_000 : 1_700_000_000_000
  writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'agents.json'), JSON.stringify(list))
}

const watchLog = (sb: Sandbox): string => {
  try {
    return readFileSync(logFile(sb.paths, 'watch'), 'utf8')
  } catch {
    return ''
  }
}

/** Bytes de tudo o que uma troca recusada não pode mexer: link do mux, runtime.json, config e watch.log. */
function snapshot(sb: Sandbox): Record<string, string | null> {
  const bytes = (f: string): string | null => {
    try {
      return readFileSync(f, 'utf8')
    } catch {
      return null
    }
  }
  const link = (f: string): string | null => {
    try {
      return lstatSync(f).isSymbolicLink() ? `-> ${readlinkSync(f)}` : `arquivo: ${readFileSync(f, 'utf8')}`
    } catch {
      return null
    }
  }
  return {
    link: link(muxLink(sb.paths, 'bk')),
    runtime: bytes(runtimeFile(sb.paths)),
    config: bytes(sb.paths.configFile),
    watchLog: bytes(logFile(sb.paths, 'watch')),
  }
}

async function catching(fn: () => unknown): Promise<SbError> {
  try {
    await fn()
  } catch (e) {
    if (e instanceof SbError) return e
    throw e
  }
  throw new Error('esperava um SbError')
}

describe('applySwap', () => {
  test('reponta o link e para só as livres e limit-blocked ANTERIORES ao swap; o resto fica intacto', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    const o = applySwap(ctxAt(sb), cfg, { mux: 'bk', to: 'admin1', reason: 'teste' })

    expect(currentAccount(sb.paths, 'bk')).toBe('admin1')
    expect(o).toEqual({ mux: 'bk', from: 'gabriel', to: 'admin1', stopped: [IDS.a, IDS.b], waitingBusy: [IDS.c], keptScheduled: [IDS.d], failed: [] })
    expect(stops(sb)).toEqual([IDS.a, IDS.b])
    for (const id of [IDS.a, IDS.b]) expect(live(sb, id)).toBe(false)
    // tudo o mais continua vivo, ou parado como já estava (l)
    for (const id of [IDS.c, IDS.d, IDS.e, IDS.f, IDS.g, IDS.h, IDS.i, IDS.j, IDS.k]) expect(live(sb, id)).toBe(true)
    expect(live(sb, IDS.l)).toBe(false)
    // `respawnFlags` intactos (o link é quem mudou)
    const st = JSON.parse(readFileSync(join(sb.paths.jobsDir, IDS.a, 'state.json'), 'utf8')) as { respawnFlags: string[] }
    expect(st.respawnFlags).toEqual(flags(muxLink(sb.paths, 'bk')))
    // lastSwap e since
    expect(readRuntime(sb.paths).mux.bk).toEqual({ since: NOW, lastSwap: { at: NOW, from: 'gabriel', to: 'admin1', reason: 'teste' } })
  })

  test('viva com state.json legível mas SEM inFlight: nunca parada, vai para waitingBusy', async () => {
    const sb = world()
    addAll(sb)
    const noFlight = 'abcdef0d'
    sb.addJob({ agent: { id: noFlight, startedAt: OLD, pid: 4242, status: 'idle' }, state: { respawnFlags: flags(muxLink(sb.paths, 'bk')), state: 'done' } })
    const cfg = await loadConfig(sb.paths)
    const o = applySwap(ctxAt(sb), cfg, { mux: 'bk', to: 'admin1', reason: 'teste' }) as { stopped: string[]; waitingBusy: string[] }
    expect(o.stopped).toEqual([IDS.a, IDS.b])
    expect(o.waitingBusy).toEqual([IDS.c, noFlight])
    expect(stops(sb)).not.toContain(noFlight)
    expect(live(sb, noFlight)).toBe(true)
  })

  test('limite: sessão com startedAt == since (igual, não anterior) NÃO é parada', async () => {
    const sb = world()
    addAll(sb)
    addSession(sb, IDS.a, flags(muxLink(sb.paths, 'bk')), 'free', { startedAt: NOW })
    const cfg = await loadConfig(sb.paths)
    const o = applySwap(ctxAt(sb), cfg, { mux: 'bk', to: 'admin1', reason: 'teste' }) as { stopped: string[] }
    expect(o.stopped).toEqual([IDS.b])
    expect(stops(sb)).toEqual([IDS.b])
    expect(live(sb, IDS.a)).toBe(true)
  })

  test('claude agents falha depois do pointMux → exit 4, o link já trocou, nada parado, e a dica diz que o watch tenta de novo', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    const ctx = hooked(sb, (args) => (args[0] === 'agents' ? { status: 1, stderr: 'boom' } : undefined))
    const err = await catching(() => applySwap(ctx, cfg, { mux: 'bk', to: 'admin1', reason: 'teste' }))
    expect(err.exit).toBe(EXIT.CLAUDE)
    expect(err.message).toContain('o link já aponta para admin1')
    expect(err.detail).toContain('watch')
    expect(currentAccount(sb.paths, 'bk')).toBe('admin1')
    expect(stops(sb)).toEqual([])
  })

  test('swap para a conta atual → noop, nada é tocado', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    expect(applySwap(ctxAt(sb), cfg, { mux: 'bk', to: 'gabriel', reason: 'x' })).toEqual({ noop: true })
    expect(stops(sb)).toEqual([])
    expect(existsSync(runtimeFile(sb.paths))).toBe(false)
    expect(existsSync(logFile(sb.paths, 'watch'))).toBe(false)
  })

  test('valida: mux inexistente, conta fora de accounts e conta sem token → exit 3, link e sessões intocados', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    const ctx = ctxAt(sb)
    expect((await catching(() => applySwap(ctx, cfg, { mux: 'nada', to: 'admin1', reason: 'x' }))).exit).toBe(EXIT.USAGE)
    expect((await catching(() => applySwap(ctx, cfg, { mux: 'bk', to: 'solo', reason: 'x' }))).exit).toBe(EXIT.USAGE)
    expect((await catching(() => applySwap(ctx, cfg, { mux: '../x', to: 'admin1', reason: 'x' }))).exit).toBe(EXIT.USAGE)
    rmTokenOf(sb, 'admin1')
    expect((await catching(() => applySwap(ctx, cfg, { mux: 'bk', to: 'admin1', reason: 'x' }))).exit).toBe(EXIT.USAGE)
    expect(currentAccount(sb.paths, 'bk')).toBe('gabriel')
    expect(stops(sb)).toEqual([])
    expect(existsSync(runtimeFile(sb.paths))).toBe(false)
  })

  test('link do mux ausente → exit 1 (nunca troca a partir de nada)', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    rmSync(muxLink(sb.paths, 'bk'))
    expect((await catching(() => applySwap(ctxAt(sb), cfg, { mux: 'bk', to: 'admin1', reason: 'x' }))).exit).toBe(EXIT.CHECK_FAILED)
    expect(stops(sb)).toEqual([])
  })

  test('a sessão que chamou (CLAUDE_JOB_DIR) nunca é parada: vai para waitingBusy', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    const ctx = ctxAt(sb, { env: { ...sb.env, CLAUDE_JOB_DIR: join(sb.paths.jobsDir, IDS.a) } })
    const o = applySwap(ctx, cfg, { mux: 'bk', to: 'admin1', reason: 'teste' }) as { stopped: string[]; waitingBusy: string[] }
    expect(o.stopped).toEqual([IDS.b])
    expect(o.waitingBusy).toEqual([IDS.a, IDS.c])
    expect(stops(sb)).toEqual([IDS.b])
    expect(live(sb, IDS.a)).toBe(true)
  })

  test('agendada na conta de origem esgotada → UMA notificação, mesmo em dois chamados; nunca é parada', async () => {
    const sb = world()
    addAll(sb)
    setUsage(sb, { gabriel: 'rate-limited', admin1: 0.2 })
    const cfg = await loadConfig(sb.paths)
    const sent: string[] = []
    const ctx = ctxAt(sb, { notify: (t, m) => void sent.push(`${t}|${m}`) })
    applySwap(ctx, cfg, { mux: 'bk', to: 'admin1', reason: 'esgotou' })
    const again = restartStale(ctx, cfg, 'bk')
    expect(again.keptScheduled).toEqual([IDS.d])
    const sched = sent.filter((s) => s.includes('ficou na conta esgotada'))
    expect(sched).toHaveLength(1)
    expect(sched[0]).toContain(IDS.d)
    expect(sched[0]).toContain('gabriel')
    expect(sent.join('\n')).not.toMatch(/sk-ant-/)
    expect(Object.keys(readRuntime(sb.paths).notified)).toContain(`sched:${IDS.d}:gabriel`)
    expect(live(sb, IDS.d)).toBe(true)
    expect(stops(sb)).not.toContain(IDS.d)
  })

  test('agendada com a conta de origem disponível → mantida, sem notificação de agendada', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    const sent: string[] = []
    const ctx = ctxAt(sb, { notify: (t, m) => void sent.push(`${t}|${m}`) })
    applySwap(ctx, cfg, { mux: 'bk', to: 'admin1', reason: 'manual' })
    expect(sent.filter((s) => s.includes('ficou na conta esgotada'))).toEqual([])
    expect(sent).toHaveLength(1) // só o aviso da troca
  })

  test('stopSession falhando para uma sessão → vai para failed e o resto segue', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    const ctx = hooked(sb, (args) => (args[0] === 'stop' && args[1] === IDS.a ? { status: 1, stderr: 'boom' } : undefined))
    const o = applySwap(ctx, cfg, { mux: 'bk', to: 'admin1', reason: 'teste' }) as { stopped: string[]; failed: Array<{ id: string; error: string }> }
    expect(o.failed.map((f) => f.id)).toEqual([IDS.a])
    expect(o.stopped).toEqual([IDS.b])
    expect(live(sb, IDS.a)).toBe(true)
    expect(currentAccount(sb.paths, 'bk')).toBe('admin1') // a troca vale mesmo assim
  })

  test('`claude stop` que não consegue derrubar o pid no prazo → failed (sem esperar 45 s)', async () => {
    const sb = world()
    addAll(sb)
    writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'stop-stuck'), '')
    const cfg = await loadConfig(sb.paths)
    const o = applySwap(ctxAt(sb), cfg, { mux: 'bk', to: 'admin1', reason: 'teste' }, { stopTimeoutMs: 1_000, stop: { pollMs: 500, sleep: () => undefined } }) as {
      stopped: string[]
      failed: Array<{ id: string }>
    }
    expect(o.stopped).toEqual([])
    expect(o.failed.map((f) => f.id)).toEqual([IDS.a, IDS.b])
  })

  test('sessão que já parou sozinha antes do stop (sem pid) não gera `claude stop` nem falha', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    // enquanto `a` é parada, `b` termina por conta própria
    const ctx = hooked(sb, (args) => {
      if (args[0] === 'stop' && args[1] === IDS.a) {
        const list = agentsFile(sb)
        const b = list.find((x) => x.id === IDS.b)!
        delete b.pid
        delete b.status
        writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'agents.json'), JSON.stringify(list))
      }
    })
    const o = applySwap(ctx, cfg, { mux: 'bk', to: 'admin1', reason: 'teste' }) as { stopped: string[]; failed: unknown[] }
    expect(stops(sb)).toEqual([IDS.a])
    expect(o.stopped).toEqual([IDS.a])
    expect(o.failed).toEqual([])
  })

  test('um turno que começa DEPOIS da listagem e antes do stop: reconferido, vai para waitingBusy e não é parado', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    // enquanto `a` é parada, o usuário manda um prompt para `b`
    const ctx = hooked(sb, (args) => {
      if (args[0] === 'stop' && args[1] === IDS.a) addSession(sb, IDS.b, flags(muxLink(sb.paths, 'bk')), 'busy')
    })
    const o = applySwap(ctx, cfg, { mux: 'bk', to: 'admin1', reason: 'teste' }) as { stopped: string[]; waitingBusy: string[] }
    expect(stops(sb)).toEqual([IDS.a])
    expect(o.stopped).toEqual([IDS.a])
    expect(o.waitingBusy).toEqual([IDS.c, IDS.b])
    expect(live(sb, IDS.b)).toBe(true)
  })

  test('sessão reaberta (startedAt novo) entre a listagem e o stop não é parada', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    const ctx = hooked(sb, (args) => {
      if (args[0] === 'stop' && args[1] === IDS.a) addSession(sb, IDS.b, flags(muxLink(sb.paths, 'bk')), 'free', { startedAt: NEW })
    })
    const o = applySwap(ctx, cfg, { mux: 'bk', to: 'admin1', reason: 'teste' }) as { stopped: string[] }
    expect(stops(sb)).toEqual([IDS.a])
    expect(o.stopped).toEqual([IDS.a])
  })

  test('`since` e o link já estão gravados quando a PRIMEIRA parada acontece', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    const seen: Array<{ since: number | undefined; link: string | null }> = []
    const ctx = hooked(sb, (args) => {
      if (args[0] === 'stop') seen.push({ since: readRuntime(sb.paths).mux.bk?.since, link: currentAccount(sb.paths, 'bk') })
    })
    applySwap(ctx, cfg, { mux: 'bk', to: 'admin1', reason: 'teste' })
    expect(seen).toEqual([
      { since: NOW, link: 'admin1' },
      { since: NOW, link: 'admin1' },
    ])
  })

  test('duas passadas seguidas não param duas vezes; sessão reaberta depois da troca fica de fora', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    const ctx = ctxAt(sb)
    applySwap(ctx, cfg, { mux: 'bk', to: 'admin1', reason: 'teste' })
    // o usuário reabre `a` (mesmo id, startedAt novo) e outra passada acontece
    addSession(sb, IDS.a, flags(muxLink(sb.paths, 'bk')), 'free', { startedAt: NEW })
    const second = restartStale(ctx, cfg, 'bk')
    expect(second).toEqual({ mux: 'bk', stopped: [], waitingBusy: [IDS.c], keptScheduled: [IDS.d], failed: [] })
    expect(stops(sb)).toEqual([IDS.a, IDS.b])
  })

  test('sem troca registrada (sem `since`) nada é parado', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    expect(restartStale(ctxAt(sb), cfg, 'bk')).toEqual({ mux: 'bk', stopped: [], waitingBusy: [], keptScheduled: [], failed: [] })
    expect(stops(sb)).toEqual([])
  })

  test('aviso de state.json ilegível entra UMA vez no watch.log, em várias passadas', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    const ctx = ctxAt(sb)
    applySwap(ctx, cfg, { mux: 'bk', to: 'admin1', reason: 'teste' })
    restartStale(ctx, cfg, 'bk')
    restartStale(ctx, cfg, 'bk')
    const warns = watchLog(sb).split('\n').filter((l) => l.includes(`sessão ${IDS.h}`))
    expect(warns).toHaveLength(1)
  })

  test('runtime.json, watch.log e notificações não têm token (nem o de uma sessão estranha com token inline)', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    const sent: string[] = []
    applySwap(ctxAt(sb, { notify: (t, m) => void sent.push(`${t}|${m}`) }), cfg, { mux: 'bk', to: 'admin1', reason: 'teste' })
    expect(readFileSync(runtimeFile(sb.paths), 'utf8')).not.toMatch(/sk-ant-/)
    expect(watchLog(sb)).not.toMatch(/sk-ant-/)
    expect(watchLog(sb)).toContain('troca no mux bk: gabriel → admin1')
    expect(sent.join('\n')).not.toMatch(/sk-ant-/)
  })

  test('trocar para o keychain só aponta o link para tokens/keychain.json (`{}`)', async () => {
    const sb = world()
    pointMux(sb.paths, 'berzerk', 'admin1')
    const cfg = await loadConfig(sb.paths)
    const o = applySwap(ctxAt(sb), cfg, { mux: 'berzerk', to: 'keychain', reason: 'manual' })
    expect(o).toMatchObject({ from: 'admin1', to: 'keychain' })
    expect(readlinkSync(muxLink(sb.paths, 'berzerk'))).toBe(tokenFile(sb.paths, 'keychain'))
    expect(readFileSync(tokenFile(sb.paths, 'keychain'), 'utf8')).toBe('{}')
  })
})

describe('manualSwap', () => {
  test('conta fora de accounts → exit 3; conta com token mas fora do mux também', async () => {
    const sb = world()
    const cfg = await loadConfig(sb.paths)
    expect((await catching(() => manualSwap(ctxAt(sb), cfg, 'bk', 'solo'))).exit).toBe(EXIT.USAGE)
    expect(currentAccount(sb.paths, 'bk')).toBe('gabriel')
    expect(readRuntime(sb.paths).overrides).toEqual({})
  })

  describe('troca manual RECUSADA não deixa nada para trás (link, runtime.json, config e watch.log byte a byte)', () => {
    const cases: Array<[string, (sb: Sandbox) => void, string | undefined, { clear?: boolean }, ExitCode]> = [
      ['link do mux ausente', (sb) => rmSync(muxLink(sb.paths, 'bk')), 'admin1', {}, EXIT.CHECK_FAILED],
      ['link do mux é um arquivo comum (conta atual ilegível)', (sb) => { rmSync(muxLink(sb.paths, 'bk')); writeFileSync(muxLink(sb.paths, 'bk'), '{}') }, 'admin1', {}, EXIT.CHECK_FAILED],
      ['link ausente, sem conta', (sb) => rmSync(muxLink(sb.paths, 'bk')), undefined, {}, EXIT.CHECK_FAILED],
      ['link ausente, --clear', (sb) => rmSync(muxLink(sb.paths, 'bk')), undefined, { clear: true }, EXIT.CHECK_FAILED],
      ['conta de destino sem token', (sb) => rmTokenOf(sb, 'admin1'), 'admin1', {}, EXIT.USAGE],
      ['conta fora de accounts', () => undefined, 'solo', {}, EXIT.USAGE],
      ['mux inexistente', () => undefined, 'admin1', {}, EXIT.USAGE],
    ]
    test.each(cases)('%s', async (name, setup, account, o, code) => {
      const sb = world()
      addAll(sb)
      const cfg = await loadConfig(sb.paths)
      setup(sb)
      const before = snapshot(sb)
      const mux = name === 'mux inexistente' ? 'nada' : 'bk'
      const err = await catching(() => manualSwap(ctxAt(sb), cfg, mux, account, o))
      expect(err.exit).toBe(code)
      expect(snapshot(sb)).toEqual(before)
      expect(stops(sb)).toEqual([])
    })

    test('mux sem pool com link ausente: não apaga override nem grava nada', async () => {
      const sb = world()
      const cfg = await loadConfig(sb.paths)
      const rt = readRuntime(sb.paths)
      rt.overrides.berzerk = { account: 'admin1', until: NOW + 1000 }
      writeRuntime(sb.paths, rt)
      rmSync(muxLink(sb.paths, 'berzerk'))
      const before = readFileSync(runtimeFile(sb.paths), 'utf8')
      expect((await catching(() => manualSwap(ctxAt(sb), cfg, 'berzerk', 'admin1'))).exit).toBe(EXIT.CHECK_FAILED)
      expect(readFileSync(runtimeFile(sb.paths), 'utf8')).toBe(before)
    })

    test('trocar para a preferida com link ausente: o override existente também fica', async () => {
      const sb = world()
      const cfg = await loadConfig(sb.paths)
      manualSwap(ctxAt(sb), cfg, 'bk', 'admin1')
      pointMux(sb.paths, 'bk', 'admin1')
      rmSync(muxLink(sb.paths, 'bk'))
      const before = snapshot(sb)
      expect((await catching(() => manualSwap(ctxAt(sb), cfg, 'bk', 'gabriel'))).exit).toBe(EXIT.CHECK_FAILED)
      expect(snapshot(sb)).toEqual(before)
    })

    test('--clear cuja conta escolhida pela regra não tem token: recusa (exit 3) e o override fica', async () => {
      const sb = world()
      const cfg = await loadConfig(sb.paths)
      manualSwap(ctxAt(sb), cfg, 'bk', 'admin1')
      expect(readRuntime(sb.paths).overrides.bk).toBeDefined()
      rmTokenOf(sb, 'gabriel') // a regra volta à preferida, que perdeu o token
      const before = snapshot(sb)
      const err = await catching(() => manualSwap(ctxAt(sb), cfg, 'bk', undefined, { clear: true }))
      expect(err.exit).toBe(EXIT.USAGE)
      expect(snapshot(sb)).toEqual(before)
      expect(currentAccount(sb.paths, 'bk')).toBe('admin1')
    })
  })

  test('grava o override até o reset da preferida (ms) e troca', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    const o = manualSwap(ctxAt(sb), cfg, 'bk', 'admin1')
    expect(o).toMatchObject({ from: 'gabriel', to: 'admin1', stopped: [IDS.a, IDS.b] })
    expect(readRuntime(sb.paths).overrides).toEqual({ bk: { account: 'admin1', until: RESET_5H_S * 1000 } })
    expect(readRuntime(sb.paths).mux.bk?.lastSwap?.reason).toBe('manual')
  })

  test('preferida sem medição ok, ou com reset já passado → até agora + 5 h', async () => {
    const sb = world()
    const cfg = await loadConfig(sb.paths)
    setUsage(sb, { gabriel: 'rate-limited', admin1: 0.2 })
    manualSwap(ctxAt(sb), cfg, 'bk', 'admin1')
    expect(readRuntime(sb.paths).overrides.bk).toEqual({ account: 'admin1', until: NOW + 5 * 3_600_000 })

    const sb2 = world()
    const cfg2 = await loadConfig(sb2.paths)
    manualSwap(ctxAt(sb2, { now: () => NOW + 10_000 * 1000 }), cfg2, 'bk', 'admin1') // reset (NOW+7200 s) já passou
    expect(readRuntime(sb2.paths).overrides.bk?.until).toBe(NOW + 10_000 * 1000 + 5 * 3_600_000)
  })

  test('trocar para a própria preferida apaga o override', async () => {
    const sb = world()
    const cfg = await loadConfig(sb.paths)
    const ctx = ctxAt(sb)
    manualSwap(ctx, cfg, 'bk', 'admin1')
    expect(readRuntime(sb.paths).overrides.bk).toBeDefined()
    const back = manualSwap(ctxAt(sb), cfg, 'bk', 'gabriel')
    expect(back).toMatchObject({ from: 'admin1', to: 'gabriel' })
    expect(readRuntime(sb.paths).overrides).toEqual({})
  })

  test('--clear apaga o override e volta à preferida disponível; --clear com conta → exit 3', async () => {
    const sb = world()
    const cfg = await loadConfig(sb.paths)
    manualSwap(ctxAt(sb), cfg, 'bk', 'admin1')
    expect((await catching(() => manualSwap(ctxAt(sb), cfg, 'bk', 'gabriel', { clear: true }))).exit).toBe(EXIT.USAGE)
    expect(currentAccount(sb.paths, 'bk')).toBe('admin1')
    const o = manualSwap(ctxAt(sb), cfg, 'bk', undefined, { clear: true })
    expect(o).toMatchObject({ from: 'admin1', to: 'gabriel' })
    expect(currentAccount(sb.paths, 'bk')).toBe('gabriel')
    expect(readRuntime(sb.paths).overrides).toEqual({})
  })

  test('--clear que não muda a conta: noop, mas o override some', async () => {
    const sb = world()
    const cfg = await loadConfig(sb.paths)
    const rt = readRuntime(sb.paths)
    rt.overrides.bk = { account: 'gabriel', until: NOW + 1000 }
    writeRuntime(sb.paths, rt)
    expect(manualSwap(ctxAt(sb), cfg, 'bk', undefined, { clear: true })).toEqual({ noop: true })
    expect(readRuntime(sb.paths).overrides).toEqual({})
  })

  test('sem conta: a próxima da fila com a preferida tratada como esgotada', async () => {
    const sb = world()
    const cfg = await loadConfig(sb.paths)
    const o = manualSwap(ctxAt(sb), cfg, 'bk')
    expect(o).toMatchObject({ from: 'gabriel', to: 'admin1' })
    // já está na reserva: a regra escolhe ficar → noop
    expect(manualSwap(ctxAt(sb), cfg, 'bk')).toEqual({ noop: true })
  })

  test('sem conta e nenhuma outra disponível → exit 1, nada muda', async () => {
    const sb = world()
    setUsage(sb, { gabriel: 0.4, admin1: 'rate-limited' })
    const cfg = await loadConfig(sb.paths)
    expect((await catching(() => manualSwap(ctxAt(sb), cfg, 'bk'))).exit).toBe(EXIT.CHECK_FAILED)
    expect(currentAccount(sb.paths, 'bk')).toBe('gabriel')
    expect(readRuntime(sb.paths).overrides).toEqual({})
  })

  test('mux sem pool: sem conta → exit 3; com a conta por extenso funciona e não guarda override', async () => {
    const sb = world()
    const cfg = await loadConfig(sb.paths)
    expect((await catching(() => manualSwap(ctxAt(sb), cfg, 'berzerk'))).exit).toBe(EXIT.USAGE)
    expect(manualSwap(ctxAt(sb), cfg, 'berzerk', 'keychain')).toEqual({ noop: true }) // já está no keychain
    expect(manualSwap(ctxAt(sb), cfg, 'berzerk', 'admin1')).toMatchObject({ from: 'keychain', to: 'admin1' })
    expect(manualSwap(ctxAt(sb), cfg, 'berzerk', 'keychain')).toMatchObject({ from: 'admin1', to: 'keychain' })
    expect(readRuntime(sb.paths).overrides).toEqual({})
  })

  test('sessões de OUTRO mux nunca são paradas por um swap do bk', async () => {
    const sb = world()
    addAll(sb)
    const cfg = await loadConfig(sb.paths)
    manualSwap(ctxAt(sb), cfg, 'bk', 'admin1')
    expect(stops(sb)).not.toContain(IDS.g)
    expect(stops(sb)).not.toContain(IDS.f)
  })
})

describe('renderSwap', () => {
  const base: SwapReport = {
    mux: 'bk',
    noop: false,
    from: 'gabriel',
    to: 'admin1',
    stopped: [],
    waitingBusy: [IDS.c],
    keptScheduled: [],
    failed: [],
    callerWaiting: false,
    override: null,
  }
  const text = (r: Partial<SwapReport>): string => renderSwap({ ...base, ...r }, { nowMs: NOW, timeZone: 'UTC' })

  test('sem sessão que chamou na espera: não fala dela', () => {
    const t = text({})
    expect(t).toContain(`aguardando o fim do turno: ${IDS.c}`)
    expect(t).not.toContain('que chamou')
  })

  test('com a sessão que chamou na espera: diz que ela NÃO é parada por este comando', () => {
    const t = text({ waitingBusy: [IDS.a, IDS.c], callerWaiting: true })
    expect(t).toContain('que chamou')
    expect(t).toContain('NÃO será parada')
    expect(t).toContain('watch')
  })

  test('override com reset conhecido: "reset da preferida"; sem reset (agora + 5 h): diz que é uma estimativa', () => {
    const known = text({ override: { account: 'admin1', until: NOW + 3_600_000, resetKnown: true } })
    expect(known).toContain('reset da preferida')
    expect(known).not.toContain('5 h')
    const guess = text({ override: { account: 'admin1', until: NOW + 5 * 3_600_000, resetKnown: false } })
    expect(guess).toContain('~5 h: a preferida não tem reset conhecido')
    expect(guess).not.toContain('reset da preferida')
  })

  test('runSwap: só marca callerWaiting quando o chamador (CLAUDE_JOB_DIR) está mesmo na espera', async () => {
    const sb = world()
    addAll(sb)
    const withCaller = await runSwap(ctxAt(sb, { env: { ...sb.env, CLAUDE_JOB_DIR: join(sb.paths.jobsDir, IDS.a) } }), { mux: 'bk', account: 'admin1' })
    expect(withCaller.report.callerWaiting).toBe(true)
    expect(withCaller.text).toContain('NÃO será parada')
    const sb2 = world()
    addAll(sb2)
    const without = await runSwap(ctxAt(sb2), { mux: 'bk', account: 'admin1' })
    expect(without.report.callerWaiting).toBe(false)
    expect(without.text).not.toContain('que chamou')
    expect(without.report.override).toEqual({ account: 'admin1', until: RESET_5H_S * 1000, resetKnown: true })
  })
})

describe('sb swap (comando)', () => {
  test('--json: sem token, com o desfecho e o override; sessão que chamou espera', () => {
    const sb = world()
    addAll(sb)
    // usage com reset no futuro REAL: o CLI usa o relógio do sistema
    const realReset = Math.floor(Date.now() / 1000) + 7_200
    setUsage(sb, { gabriel: 0.4, admin1: 0.2 })
    const u = JSON.parse(readFileSync(usageFile(sb.paths), 'utf8')) as { latest: Record<string, { fiveHour: { resetsAt: number } }> }
    u.latest.gabriel!.fiveHour.resetsAt = realReset
    writeFileSync(usageFile(sb.paths), JSON.stringify(u))
    realClock(sb)

    const r = sb.runSb(['swap', 'bk', 'admin1', '--json'], { env: { CLAUDE_JOB_DIR: join(sb.paths.jobsDir, IDS.a) } })
    expect(r.code).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/sk-ant-/)
    const j = JSON.parse(r.stdout) as Record<string, unknown>
    expect(j).toMatchObject({ mux: 'bk', noop: false, from: 'gabriel', to: 'admin1', stopped: [IDS.b], waitingBusy: [IDS.a, IDS.c], keptScheduled: [IDS.d], failed: [] })
    expect(j.override).toEqual({ account: 'admin1', until: realReset * 1000, resetKnown: true })
    expect(j.callerWaiting).toBe(true)
    expect(stops(sb)).toEqual([IDS.b])
    for (const f of [runtimeFile(sb.paths), logFile(sb.paths, 'watch')]) expect(readFileSync(f, 'utf8')).not.toMatch(/sk-ant-/)
  })

  test('texto em português; nome fora de accounts, mux inexistente e nome inválido → exit 3', () => {
    const sb = world()
    const ok = sb.runSb(['swap', 'bk', 'admin1'])
    expect(ok.code).toBe(0)
    expect(ok.stdout).toContain('mux bk: gabriel → admin1')
    expect(ok.stdout).toContain('manual até')
    expect(sb.runSb(['swap', 'bk', 'solo']).code).toBe(EXIT.USAGE)
    expect(sb.runSb(['swap', 'nada', 'admin1']).code).toBe(EXIT.USAGE)
    expect(sb.runSb(['swap', '../x', 'admin1']).code).toBe(EXIT.USAGE)
    expect(sb.runSb(['swap', 'bk', '../x']).code).toBe(EXIT.USAGE)
    expect(sb.runSb(['swap', 'bk', 'admin1', 'extra']).code).toBe(EXIT.USAGE)
    expect(sb.runSb(['swap', 'bk', 'gabriel', '--clear']).code).toBe(EXIT.USAGE)
  })

  test('`sb swap berzerk` sem conta → exit 3; `sb swap berzerk keychain` é aceito', () => {
    const sb = world()
    const bare = sb.runSb(['swap', 'berzerk'])
    expect(bare.code).toBe(EXIT.USAGE)
    expect(bare.stderr).toContain('berzerk')
    const kc = sb.runSb(['swap', 'berzerk', 'keychain'])
    expect(kc.code).toBe(0)
    expect(kc.stdout).toContain('já está em keychain')
    expect(readlinkSync(muxLink(sb.paths, 'berzerk'))).toBe(tokenFile(sb.paths, 'keychain'))
  })

  test('--clear pelo CLI volta à preferida; swap para a conta atual é noop (exit 0)', () => {
    const sb = world()
    expect(sb.runSb(['swap', 'bk', 'admin1']).code).toBe(0)
    const again = sb.runSb(['swap', 'bk', 'admin1', '--json'])
    expect(JSON.parse(again.stdout)).toMatchObject({ noop: true, from: 'admin1', to: 'admin1' })
    const clear = sb.runSb(['swap', 'bk', '--clear', '--json'])
    expect(clear.code).toBe(0)
    expect(JSON.parse(clear.stdout)).toMatchObject({ noop: false, from: 'admin1', to: 'gabriel', override: null })
  })

  test('falha ao parar uma sessão: a saída diz qual e o exit é 1', () => {
    const sb = world()
    addAll(sb)
    writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'stop-fail'), '')
    realClock(sb)
    const r = sb.runSb(['swap', 'bk', 'admin1'])
    expect(r.code).toBe(EXIT.CHECK_FAILED)
    expect(r.stdout).toContain(`não consegui parar ${IDS.a}`)
    expect(currentAccount(sb.paths, 'bk')).toBe('admin1')
  })

  test('lock ocupado → exit 5, nada é tocado', async () => {
    const sb = world()
    addAll(sb)
    const ctx = ctxAt(sb)
    const err = await withLock(sb.paths, () => catching(() => runSwap(ctx, { mux: 'bk', account: 'admin1' }, { waitMs: 100 })))
    expect(err.exit).toBe(EXIT.LOCKED)
    expect(currentAccount(sb.paths, 'bk')).toBe('gabriel')
    expect(stops(sb)).toEqual([])
  })
})

function rmTokenOf(sb: Sandbox, account: string): void {
  rmSync(tokenFile(sb.paths, account))
}
