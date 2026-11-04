import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPin } from '../src/commands/pin.js'
import { runUnpin } from '../src/commands/unpin.js'
import { runUsage, type UsageIO } from '../src/commands/usage.js'
import { loadConfig, parseConfig, type Config } from '../src/core/config.js'
import type { Ctx, FetchLike } from '../src/core/ctx.js'
import { EXIT, SbError, type ExitCode } from '../src/core/errors.js'
import { withLock } from '../src/core/fsx.js'
import { pointMux } from '../src/core/links.js'
import { buildPanel } from '../src/core/panel.js'
import { logFile, muxLink, pinLink, runtimeFile, tokenFile, usageFile } from '../src/core/paths.js'
import { applyPending, findSession, muxOfSession, pinSession, type PinOutcome } from '../src/core/pin.js'
import { readRuntime, writeRuntime } from '../src/core/runtime.js'
import { loadSessions, type Session } from '../src/core/sessions.js'
import { ensureState } from '../src/core/tokens.js'
import { renderPanel } from '../src/report.js'
import { filesUnder, FAKE_TOKEN, populatedSandbox, type AgentFixture, type Sandbox } from './helpers.js'

const NOW = 1_800_000_000_000
const ID = 'a1b2c3d4'
const ID2 = 'a1b2ffff'

type Kind = 'free' | 'limit-blocked' | 'busy' | 'scheduled' | 'stopped'

const stateFor = (flags: string[], kind: Kind): Record<string, unknown> => {
  const base = { respawnFlags: flags, cwd: '/tmp/proj', extra: { keep: 'me' } }
  switch (kind) {
    case 'free':
    case 'stopped':
      return { ...base, state: 'done', inFlight: { tasks: 0, queued: 0, kinds: [] } }
    case 'limit-blocked':
      return { ...base, state: 'blocked', needs: 'rate limited until 17:00', inFlight: { tasks: 0, queued: 1, kinds: [] } }
    case 'busy':
      return { ...base, state: 'working', inFlight: { tasks: 1, queued: 0, kinds: ['local_agent'] } }
    case 'scheduled':
      return { ...base, state: 'done', inFlight: { tasks: 0, queued: 0, kinds: ['session_cron'] } }
  }
}

function addSession(sb: Sandbox, id: string, flags: string[], kind: Kind, agent: Partial<AgentFixture> = {}): void {
  const live = kind !== 'stopped'
  sb.addJob({ agent: { id, ...(live && { pid: 4242, status: kind === 'busy' ? 'busy' : 'idle' }), ...agent }, state: stateFor(flags, kind) })
}

/** `--allowed-tools` repetido e o `--settings` do mux no meio: a ordem e as repetições têm que sobreviver. */
const flagsOf = (settings: string): string[] => ['--allowed-tools', 'Read', '--settings', settings, '--allowed-tools', 'Bash']

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
        pessoal: { root: '~/pessoal', account: 'solo', accounts: ['solo', 'gabriel'], pool: [] },
        berzerk: { root: '~/bz', account: 'keychain', accounts: ['keychain', 'admin1'], pool: [] },
      },
    }),
  )
  ensureState(p)
  sb.addToken('solo')
  pointMux(p, 'pessoal', 'solo')
  pointMux(p, 'berzerk', 'keychain')
  return sb
}

const ctxAt = (sb: Sandbox, over: Partial<Ctx> = {}): Ctx => sb.ctx({ now: () => NOW, ...over })
const asCaller = (sb: Sandbox, id: string): Ctx => ctxAt(sb, { env: { ...sb.env, CLAUDE_JOB_DIR: join(sb.paths.jobsDir, id) } })
const stateFile = (sb: Sandbox, id = ID): string => join(sb.paths.jobsDir, id, 'state.json')
const stateText = (sb: Sandbox, id = ID): string => readFileSync(stateFile(sb, id), 'utf8')
const flagsNow = (sb: Sandbox, id = ID): string[] => (JSON.parse(stateText(sb, id)) as { respawnFlags: string[] }).respawnFlags
const stops = (sb: Sandbox): string[][] => sb.calls().filter((c) => c.argv[0] === 'stop').map((c) => c.argv)
const agentsFile = (sb: Sandbox): Array<Record<string, unknown>> => JSON.parse(readFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'agents.json'), 'utf8'))
const hasPid = (sb: Sandbox, id = ID): boolean => agentsFile(sb).find((a) => a.id === id)?.pid !== undefined
const cfgOf = (sb: Sandbox) => loadConfig(sb.paths)
const backups = (sb: Sandbox): string[] => filesUnder(join(sb.paths.stateDir, 'backup'))
const pending = (sb: Sandbox) => readRuntime(sb.paths).pending
const watchLog = (sb: Sandbox): string => (existsSync(logFile(sb.paths, 'watch')) ? readFileSync(logFile(sb.paths, 'watch'), 'utf8') : '')

/** Bytes de tudo o que uma recusa não pode mexer: state.json, runtime.json, pins/ (nomes e alvos), backup/. */
function snapshot(sb: Sandbox, id = ID): Record<string, unknown> {
  const pins = join(sb.paths.stateDir, 'pins')
  return {
    state: existsSync(stateFile(sb, id)) ? stateText(sb, id) : null,
    runtime: existsSync(runtimeFile(sb.paths)) ? readFileSync(runtimeFile(sb.paths), 'utf8') : null,
    pins: readdirSync(pins).map((n) => [n, readlinkSync(join(pins, n))]),
    backups: backups(sb),
    stops: stops(sb),
  }
}

function catching(fn: () => unknown, exit: ExitCode): SbError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(SbError)
    expect((e as SbError).exit).toBe(exit)
    return e as SbError
  }
  throw new Error('esperava um SbError')
}

/** Ctx cujo `run` chama `hook(args)` antes de delegar ao claude falso (mexe no agents.json "no meio do caminho"). */
function hooked(sb: Sandbox, hook: (args: string[]) => void, over: Partial<Ctx> = {}): Ctx {
  const base = ctxAt(sb)
  return ctxAt(sb, {
    run: (cmd, args, opts) => {
      hook(args)
      return base.run(cmd, args, opts)
    },
    ...over,
  })
}

const goLive = (sb: Sandbox, id = ID): void => {
  const list = agentsFile(sb)
  const e = list.find((a) => a.id === id)!
  e.pid = 4242
  e.status = 'idle'
  e.state = 'done'
  writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'agents.json'), JSON.stringify(list))
}

describe('pinSession — sessão parada', () => {
  test('reescreve já: resto dos flags em ordem, --settings do pin no fim, backup feito, modo e demais chaves preservados', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'stopped')
    chmodSync(stateFile(sb), 0o600)
    const before = stateText(sb)
    const cfg = await cfgOf(sb)

    const o = pinSession(ctxAt(sb), cfg, ID, 'admin1')

    expect(o).toEqual({ jobId: ID, settings: pinLink(sb.paths, 'admin1'), result: 'rewritten' })
    expect(flagsNow(sb)).toEqual(['--allowed-tools', 'Read', '--allowed-tools', 'Bash', '--settings', pinLink(sb.paths, 'admin1')])
    expect(stops(sb)).toEqual([]) // já estava parada: nada de `claude stop`
    expect(readlinkSync(pinLink(sb.paths, 'admin1'))).toBe(tokenFile(sb.paths, 'admin1'))
    expect(statSync(stateFile(sb)).mode & 0o777).toBe(0o600)
    expect((JSON.parse(stateText(sb)) as { extra: unknown }).extra).toEqual({ keep: 'me' })
    const b = backups(sb)
    expect(b.length).toBe(1)
    expect(b[0]!.endsWith(`${ID}.state.json`)).toBe(true)
    expect(readFileSync(b[0]!, 'utf8')).toBe(before)
    expect(pending(sb)).toEqual([])
  })

  test('prefixo de 4 hex basta; maiúsculas valem', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'stopped')
    const o = pinSession(ctxAt(sb), await cfgOf(sb), 'A1B2', 'admin1')
    expect(o.jobId).toBe(ID)
  })

  test('re-fixar em outra conta (owner pin) reescreve; fixar de novo na mesma → exit 3 sem tocar nada', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(pinLink(sb.paths, 'gabriel')), 'stopped')
    const cfg = await cfgOf(sb)
    expect(pinSession(ctxAt(sb), cfg, ID, 'admin1').result).toBe('rewritten')
    expect(flagsNow(sb).at(-1)).toBe(pinLink(sb.paths, 'admin1'))
    const snap = snapshot(sb)
    catching(() => pinSession(ctxAt(sb), cfg, ID, 'admin1'), EXIT.USAGE)
    expect(snapshot(sb)).toEqual(snap)
  })
})

describe('pinSession — sessão viva', () => {
  test('livre → `claude stop` e reescrita (stopped-and-rewritten)', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'free')
    const o = pinSession(ctxAt(sb), await cfgOf(sb), ID, 'admin1')
    expect(o.result).toBe('stopped-and-rewritten')
    expect(stops(sb)).toEqual([['stop', ID]])
    expect(hasPid(sb)).toBe(false)
    expect(flagsNow(sb).slice(-2)).toEqual(['--settings', pinLink(sb.paths, 'admin1')])
    expect(backups(sb).length).toBe(1)
  })

  test('limit-blocked também é parada e reescrita', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'limit-blocked')
    expect(pinSession(ctxAt(sb), await cfgOf(sb), ID, 'admin1').result).toBe('stopped-and-rewritten')
    expect(stops(sb)).toEqual([['stop', ID]])
  })

  test.each<Kind>(['busy', 'scheduled'])('%s → vai para runtime.pending; nada é parado nem reescrito', async (kind) => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), kind)
    const before = stateText(sb)
    const o = pinSession(ctxAt(sb), await cfgOf(sb), ID, 'admin1')
    expect(o).toEqual({ jobId: ID, settings: pinLink(sb.paths, 'admin1'), result: 'queued' })
    expect(pending(sb)).toEqual([{ jobId: ID, settings: pinLink(sb.paths, 'admin1'), reason: 'pin', requestedAt: NOW }])
    expect(stateText(sb)).toBe(before)
    expect(stops(sb)).toEqual([])
    expect(hasPid(sb)).toBe(true)
  })

  test('viva sem state.json legível ou sem inFlight conta como ocupada: fila', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'free')
    const noFlight = { respawnFlags: flagsOf(muxLink(sb.paths, 'bk')), state: 'done' }
    writeFileSync(stateFile(sb), JSON.stringify(noFlight))
    expect(pinSession(ctxAt(sb), await cfgOf(sb), ID, 'admin1').result).toBe('queued')
    expect(stops(sb)).toEqual([])
  })

  test('a que chamou (CLAUDE_JOB_DIR) nunca é parada na hora, mesmo livre → fila', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'free')
    const before = stateText(sb)
    const o = pinSession(asCaller(sb, ID), await cfgOf(sb), ID, 'admin1')
    expect(o.result).toBe('queued')
    expect(stops(sb)).toEqual([])
    expect(stateText(sb)).toBe(before)
    expect(pending(sb).map((i) => i.jobId)).toEqual([ID])
  })

  test('um pedido novo para a mesma sessão substitui o antigo; `unpin` cancela um `pin` que ainda estava na fila', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'busy')
    const cfg = await cfgOf(sb)
    pinSession(ctxAt(sb, { now: () => NOW }), cfg, ID, 'admin1')
    // mesma sessão, agora pedindo `unpin`: já está solta (owner mux) → recusa e limpa o pedido antigo
    const e = catching(() => pinSession(ctxAt(sb, { now: () => NOW + 5 }), cfg, ID, null), EXIT.USAGE)
    expect(e.message).toContain('não está fixa')
    expect(pending(sb)).toEqual([])
  })

  test('o `claude stop` falha → exit 1, nada reescrito, pedido fica na fila', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'free')
    writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'stop-fail'), '')
    const before = stateText(sb)
    catching(() => pinSession(ctxAt(sb), cfgSync(sb), ID, 'admin1'), EXIT.CHECK_FAILED)
    expect(stateText(sb)).toBe(before)
    expect(backups(sb)).toEqual([])
    expect(pending(sb).map((i) => i.jobId)).toEqual([ID])
  })

  test('um turno que começou entre a listagem e o stop → não pára, fila', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'free')
    let agentsCalls = 0
    // a 1ª listagem (decisão) vê a sessão livre; a 2ª (dados frescos) já a vê ocupada
    const ctx = hooked(sb, (args) => {
      if (args[0] !== 'agents') return
      if (++agentsCalls === 2) addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'busy')
    })
    const o = pinSession(ctx, cfgSync(sb), ID, 'admin1')
    expect(o.result).toBe('queued')
    expect(stops(sb)).toEqual([])
  })
})

/** `loadConfig` é assíncrono; para os testes que precisam do `cfg` dentro de um callback síncrono. */
function cfgSync(sb: Sandbox): Config {
  return parseConfig(readFileSync(sb.paths.configFile, 'utf8'), 'cfg')
}

describe('pinSession — guarda contra pid entre a decisão e a escrita', () => {
  test('parada na decisão, mas ganhou pid antes da escrita → NÃO reescreve, vai para a fila', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'stopped')
    const before = stateText(sb)
    // dispara só depois do backup (a listagem de dentro do writeJobFlags): o último instante antes de gravar
    const ctx = hooked(sb, (args) => {
      if (args[0] === 'agents' && backups(sb).length > 0 && !hasPid(sb)) goLive(sb)
    })
    const o = pinSession(ctx, await cfgOf(sb), ID, 'admin1')
    expect(o.result).toBe('queued')
    expect(stateText(sb)).toBe(before)
    expect(pending(sb).map((i) => i.jobId)).toEqual([ID])
    expect(stops(sb)).toEqual([])
  })

  test('ganhou pid antes mesmo do backup (reabertura logo após a decisão) → fila, sem backup', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'stopped')
    let n = 0
    const ctx = hooked(sb, (args) => {
      if (args[0] === 'agents' && ++n === 2) goLive(sb) // 1ª = carga; 2ª = a conferência antes de gravar
    })
    const o = pinSession(ctx, cfgSync(sb), ID, 'admin1')
    expect(o.result).toBe('queued')
    expect(backups(sb)).toEqual([])
  })
})

describe('recusas — nada é gravado', () => {
  test('conta fora de `accounts` do mux (o limite duro) → exit 3, state/runtime/pins/backup byte-idênticos', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'stopped')
    const snap = snapshot(sb)
    const e = catching(() => pinSession(ctxAt(sb), cfgSync(sb), ID, 'solo'), EXIT.USAGE)
    expect(e.message).toContain('solo')
    expect(e.message).toContain('bk')
    expect(snapshot(sb)).toEqual(snap)
  })

  test('o limite vale também para o mux da PASTA (owner pin): conta de outro mux → exit 3', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(pinLink(sb.paths, 'gabriel')), 'stopped', { cwd: join(sb.paths.home, 'pessoal', 'x') })
    const snap = snapshot(sb)
    // `pessoal` aceita solo e gabriel, mas não admin1
    catching(() => pinSession(ctxAt(sb), cfgSync(sb), ID, 'admin1'), EXIT.USAGE)
    expect(snapshot(sb)).toEqual(snap)
    expect(pinSession(ctxAt(sb), cfgSync(sb), ID, 'solo').result).toBe('rewritten')
  })

  test('prefixo inexistente, ambíguo, curto demais ou não hexadecimal → exit 3 (lista os ids)', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'stopped')
    addSession(sb, ID2, flagsOf(muxLink(sb.paths, 'bk')), 'stopped')
    const snap = snapshot(sb)
    const cfg = cfgSync(sb)
    expect(catching(() => pinSession(ctxAt(sb), cfg, 'dead', 'admin1'), EXIT.USAGE).message).toContain('dead')
    const amb = catching(() => pinSession(ctxAt(sb), cfg, 'a1b2', 'admin1'), EXIT.USAGE)
    expect(amb.message + (amb.detail ?? '')).toContain(ID)
    expect(amb.message + (amb.detail ?? '')).toContain(ID2)
    catching(() => pinSession(ctxAt(sb), cfg, 'a1b', 'admin1'), EXIT.USAGE)
    catching(() => pinSession(ctxAt(sb), cfg, 'zzzz', 'admin1'), EXIT.USAGE)
    catching(() => pinSession(ctxAt(sb), cfg, '../../x', 'admin1'), EXIT.USAGE)
    expect(snapshot(sb)).toEqual(snap)
  })

  test('sessão interativa → exit 3 com mensagem própria', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'free', { kind: 'interactive' })
    const before = stateText(sb)
    const e = catching(() => pinSession(ctxAt(sb), cfgSync(sb), ID, 'admin1'), EXIT.USAGE)
    expect(e.message).toContain('interactive')
    expect(stateText(sb)).toBe(before)
    expect(stops(sb)).toEqual([])
  })

  test.each([
    ['legado', (sb: Sandbox) => ['--settings', join(sb.paths.claudeDir, 'contas', 'x.json')]],
    ['de terceiros', () => ['--settings', '/tmp/outro.json']],
    ['sem --settings', () => ['--allowed-tools', 'Read']],
  ])('sessão estranha (%s) → exit 3, nunca tocada', async (_n, mk) => {
    const sb = world()
    addSession(sb, ID, mk(sb), 'stopped')
    const snap = snapshot(sb)
    catching(() => pinSession(ctxAt(sb), cfgSync(sb), ID, 'admin1'), EXIT.USAGE)
    catching(() => pinSession(ctxAt(sb), cfgSync(sb), ID, null), EXIT.USAGE)
    expect(snapshot(sb)).toEqual(snap)
  })

  test('destino com token de JSON quebrado → exit 1; nada gravado (nem o link do pin)', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'free')
    writeFileSync(tokenFile(sb.paths, 'admin1'), '{ quebrado')
    const snap = snapshot(sb)
    catching(() => pinSession(ctxAt(sb), cfgSync(sb), ID, 'admin1'), EXIT.CHECK_FAILED)
    expect(snapshot(sb)).toEqual(snap)
    expect(existsSync(pinLink(sb.paths, 'admin1'))).toBe(false)
  })

  test('destino sem CLAUDE_CODE_OAUTH_TOKEN → exit 1; nada gravado', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'busy') // nem na fila entra: valida antes
    writeFileSync(tokenFile(sb.paths, 'admin1'), '{"env":{}}')
    const snap = snapshot(sb)
    catching(() => pinSession(ctxAt(sb), cfgSync(sb), ID, 'admin1'), EXIT.CHECK_FAILED)
    expect(snapshot(sb)).toEqual(snap)
  })
})

describe('unpin (account = null)', () => {
  test('volta ao link do mux da PASTA da sessão', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(pinLink(sb.paths, 'gabriel')), 'stopped', { cwd: join(sb.paths.home, 'pessoal', 'proj') })
    const o = pinSession(ctxAt(sb), await cfgOf(sb), ID, null)
    expect(o).toEqual({ jobId: ID, settings: muxLink(sb.paths, 'pessoal'), result: 'rewritten' })
    expect(flagsNow(sb)).toEqual(['--allowed-tools', 'Read', '--allowed-tools', 'Bash', '--settings', muxLink(sb.paths, 'pessoal')])
  })

  test('sem mux pela pasta cai no default; viva e livre é parada e reescrita', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(pinLink(sb.paths, 'gabriel')), 'free', { cwd: '/tmp/em-lugar-nenhum' })
    const o = pinSession(ctxAt(sb), await cfgOf(sb), ID, null)
    expect(o).toEqual({ jobId: ID, settings: muxLink(sb.paths, 'bk'), result: 'stopped-and-rewritten' })
  })

  test('sessão que já é do mux → exit 3 (não está fixa)', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'stopped')
    const snap = snapshot(sb)
    expect(catching(() => pinSession(ctxAt(sb), cfgSync(sb), ID, null), EXIT.USAGE).message).toContain('não está fixa')
    expect(snapshot(sb)).toEqual(snap)
  })

  test('link do mux quebrado → exit 1; nada gravado', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(pinLink(sb.paths, 'gabriel')), 'stopped')
    writeFileSync(tokenFile(sb.paths, 'gabriel'), 'não é json')
    const snap = snapshot(sb)
    catching(() => pinSession(ctxAt(sb), cfgSync(sb), ID, null), EXIT.CHECK_FAILED)
    expect(snapshot(sb)).toEqual(snap)
  })

  test('mux da sessão (owner mux) que saiu da config → exit 3', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'fantasma')), 'stopped')
    const snap = snapshot(sb)
    catching(() => pinSession(ctxAt(sb), cfgSync(sb), ID, 'admin1'), EXIT.USAGE)
    expect(snapshot(sb)).toEqual(snap)
  })
})

describe('findSession / muxOfSession', () => {
  const mk = (id: string): Session => ({
    agent: { id, cwd: '/x', kind: 'background', startedAt: 1, sessionId: `${id}-0`, name: id, state: 'stopped' },
    job: null,
    owner: { kind: 'none' },
    live: false,
  })

  test('acha por prefixo único; id completo vale mesmo que seja prefixo de outro', () => {
    const list = [mk('a1b2c3d4'), mk('a1b2c3d5'), mk('ffff0000')]
    expect(findSession(list, 'ffff').agent.id).toBe('ffff0000')
    expect(findSession(list, 'a1b2c3d4').agent.id).toBe('a1b2c3d4')
    expect(catching(() => findSession(list, 'a1b2c3'), EXIT.USAGE).detail).toContain('a1b2c3d5')
    expect(catching(() => findSession([], 'a1b2'), EXIT.USAGE).detail).toContain('nenhuma')
  })

  test('muxOfSession: owner mux; senão a pasta; senão o default', async () => {
    const sb = world()
    const cfg = await cfgOf(sb)
    const base = mk(ID)
    const home = sb.paths.home
    expect(muxOfSession(cfg, { ...base, owner: { kind: 'mux', mux: 'berzerk' } }, home)).toBe('berzerk')
    expect(muxOfSession(cfg, { ...base, owner: { kind: 'pin', account: 'admin1' }, agent: { ...base.agent, cwd: join(home, 'bz', 'a') } }, home)).toBe('berzerk')
    expect(muxOfSession(cfg, { ...base, owner: { kind: 'pin', account: 'admin1' } }, home)).toBe('bk')
  })
})

describe('applyPending', () => {
  const queue = (sb: Sandbox, items: Array<{ jobId: string; settings: string; reason: 'pin' | 'unpin' | 'adopt' | 'migrate' }>): void => {
    const r = readRuntime(sb.paths)
    r.pending = items.map((i) => ({ ...i, requestedAt: NOW }))
    writeRuntime(sb.paths, r)
  }

  test('ocupada → continua na fila; livre → para e reescreve; rodar de novo não faz nada (idempotente)', async () => {
    const sb = world()
    const bk = flagsOf(muxLink(sb.paths, 'bk'))
    addSession(sb, ID, bk, 'busy')
    const cfg = await cfgOf(sb)
    expect(pinSession(ctxAt(sb), cfg, ID, 'admin1').result).toBe('queued')
    const before = stateText(sb)

    // ainda ocupada: nada muda, o item fica
    const still = applyPending(ctxAt(sb), cfg)
    expect(still).toEqual([{ jobId: ID, settings: pinLink(sb.paths, 'admin1'), result: 'queued' }])
    expect(stateText(sb)).toBe(before)
    expect(stops(sb)).toEqual([])
    expect(pending(sb).length).toBe(1)

    // o turno acabou
    addSession(sb, ID, bk, 'free')
    const done = applyPending(ctxAt(sb), cfg)
    expect(done).toEqual([{ jobId: ID, settings: pinLink(sb.paths, 'admin1'), result: 'stopped-and-rewritten' }])
    expect(stops(sb)).toEqual([['stop', ID]])
    expect(flagsNow(sb).slice(-2)).toEqual(['--settings', pinLink(sb.paths, 'admin1')])
    expect(pending(sb)).toEqual([])

    const snap = snapshot(sb)
    expect(applyPending(ctxAt(sb), cfg)).toEqual([])
    expect(snapshot(sb)).toEqual(snap) // nem reescreveu nem parou de novo
  })

  test('a sessão já parada (acabou sozinha) é reescrita sem `claude stop`', async () => {
    const sb = world()
    const bk = flagsOf(muxLink(sb.paths, 'bk'))
    addSession(sb, ID, bk, 'busy')
    const cfg = await cfgOf(sb)
    pinSession(ctxAt(sb), cfg, ID, 'admin1')
    addSession(sb, ID, bk, 'stopped')
    expect(applyPending(ctxAt(sb), cfg)).toEqual([{ jobId: ID, settings: pinLink(sb.paths, 'admin1'), result: 'rewritten' }])
    expect(stops(sb)).toEqual([])
    expect(pending(sb)).toEqual([])
  })

  test('a que chamou continua na fila enquanto viva, mesmo livre', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'free')
    const cfg = await cfgOf(sb)
    pinSession(asCaller(sb, ID), cfg, ID, 'admin1')
    expect(applyPending(asCaller(sb, ID), cfg)[0]!.result).toBe('queued')
    expect(stops(sb)).toEqual([])
    expect(pending(sb).length).toBe(1)
    // outro processo (o watch) não é a sessão: aí sim aplica
    expect(applyPending(ctxAt(sb), cfg)[0]!.result).toBe('stopped-and-rewritten')
  })

  test('sessão sumida → gone, sai da fila, log sem conteúdo; as outras seguem', async () => {
    const sb = world()
    const bk = flagsOf(muxLink(sb.paths, 'bk'))
    addSession(sb, ID, bk, 'stopped')
    const cfg = await cfgOf(sb)
    queue(sb, [
      { jobId: 'deadbeef', settings: pinLink(sb.paths, 'admin1'), reason: 'pin' },
      { jobId: ID, settings: pinLink(sb.paths, 'admin1'), reason: 'pin' },
    ])
    const out = applyPending(ctxAt(sb), cfg)
    expect(out).toEqual([
      { jobId: 'deadbeef', result: 'gone' },
      { jobId: ID, settings: pinLink(sb.paths, 'admin1'), result: 'rewritten' },
    ])
    expect(pending(sb)).toEqual([])
    expect(watchLog(sb)).toContain('deadbeef')
    expect(watchLog(sb)).not.toMatch(/sk-ant-/)
  })

  test('itens de outros motivos (adopt/migrate) ficam intocados na fila', async () => {
    const sb = world()
    const cfg = await cfgOf(sb)
    queue(sb, [
      { jobId: 'deadbeef', settings: '/x', reason: 'adopt' },
      { jobId: 'deadbeef', settings: '/y', reason: 'migrate' },
    ])
    expect(applyPending(ctxAt(sb), cfg)).toEqual([])
    expect(pending(sb).map((i) => i.reason)).toEqual(['adopt', 'migrate'])
  })

  test('item adulterado (settings fora dos nossos links, conta fora de accounts) → sai da fila sem tocar na sessão', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'stopped')
    addSession(sb, ID2, flagsOf(muxLink(sb.paths, 'bk')), 'stopped')
    const cfg = await cfgOf(sb)
    const snap = [stateText(sb, ID), stateText(sb, ID2)]
    queue(sb, [
      { jobId: ID, settings: '/tmp/evil.json', reason: 'pin' },
      { jobId: ID2, settings: pinLink(sb.paths, 'solo'), reason: 'pin' }, // solo ∉ accounts do bk
    ])
    expect(applyPending(ctxAt(sb), cfg).map((o) => o.result)).toEqual(['gone', 'gone'])
    expect([stateText(sb, ID), stateText(sb, ID2)]).toEqual(snap)
    expect(pending(sb)).toEqual([])
  })

  test('alvo que quebrou depois do pedido: não reescreve, o item fica (aviso uma vez só)', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'stopped')
    const cfg = await cfgOf(sb)
    queue(sb, [{ jobId: ID, settings: pinLink(sb.paths, 'admin1'), reason: 'pin' }])
    writeFileSync(tokenFile(sb.paths, 'admin1'), '{ quebrado')
    const before = stateText(sb)
    expect(applyPending(ctxAt(sb), cfg)[0]!.result).toBe('queued')
    expect(applyPending(ctxAt(sb), cfg)[0]!.result).toBe('queued')
    expect(stateText(sb)).toBe(before)
    expect(pending(sb).length).toBe(1)
    expect(watchLog(sb).split('\n').filter((l) => l.includes(ID)).length).toBe(1)
  })

  test('sem fila: nada é lido além do runtime (nenhuma chamada ao claude)', async () => {
    const sb = world()
    expect(applyPending(ctxAt(sb), await cfgOf(sb))).toEqual([])
    expect(sb.calls()).toEqual([])
  })
})

describe('painel — sessões fixas', () => {
  test('buildPanel lista as sessões owner pin (vivas ou paradas) e a linha aparece no painel', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(pinLink(sb.paths, 'admin1')), 'stopped')
    addSession(sb, ID2, flagsOf(pinLink(sb.paths, 'gabriel')), 'free')
    addSession(sb, 'cccccccc', flagsOf(muxLink(sb.paths, 'bk')), 'free')
    const cfg = await cfgOf(sb)
    const usage = { latest: {}, previous: {}, groups: [] }
    const d = buildPanel(cfg, usage, readRuntime(sb.paths), sb.paths, loadSessions(ctxAt(sb)))
    expect(d.pins).toEqual([
      { jobId: ID, account: 'admin1' },
      { jobId: ID2, account: 'gabriel' },
    ])
    expect(renderPanel(d, { nowMs: NOW })).toContain(`sessões fixas: ${ID} → admin1, ${ID2} → gabriel`)
  })

  const okFetch: FetchLike = async () => ({ status: 200, headers: { get: () => null } })
  const io = (): UsageIO & { out: string[] } => {
    const out: string[] = []
    return { out, write: (s) => void out.push(s), sleep: async () => undefined, isTTY: false }
  }
  const fresh = (sb: Sandbox): void => {
    // medição "de agora": o `runUsage` reaproveita (cache de 1 min) e não precisa de rede
    const m = { ok: true, fiveHour: { utilization: 0.1, resetsAt: NOW / 1000 + 3600, status: 'allowed' }, sevenDay: { utilization: 0.1, resetsAt: NOW / 1000 + 9999, status: 'allowed' }, status: 'allowed', resetsAt: NOW / 1000 + 3600, measuredAt: NOW }
    writeFileSync(usageFile(sb.paths), JSON.stringify({ latest: { gabriel: m, admin1: m, solo: m }, previous: {}, groups: [] }))
  }

  test('runUsage mostra "sessões fixas: <id> → <conta>" e o --json traz pins', async () => {
    const sb = world()
    fresh(sb)
    addSession(sb, ID, flagsOf(pinLink(sb.paths, 'admin1')), 'stopped')
    const t = io()
    await runUsage(ctxAt(sb, { fetch: okFetch }), { json: false, watch: false, everyS: 30 }, t)
    expect(t.out.join('')).toContain(`sessões fixas: ${ID} → admin1`)
    const j = io()
    await runUsage(ctxAt(sb, { fetch: okFetch }), { json: true, watch: false, everyS: 30 }, j)
    expect(JSON.parse(j.out.join('')).pins).toEqual([{ jobId: ID, account: 'admin1' }])
  })

  test('`claude agents` falhando não derruba o painel: pins vazios, aviso discreto, sem lançar', async () => {
    const sb = world()
    fresh(sb)
    addSession(sb, ID, flagsOf(pinLink(sb.paths, 'admin1')), 'stopped')
    const base = ctxAt(sb, { fetch: okFetch })
    const ctx = { ...base, run: (cmd: string, args: string[], opts?: Parameters<Ctx['run']>[2]) => (args[0] === 'agents' ? { status: 1, stdout: '', stderr: 'boom' } : base.run(cmd, args, opts)) }
    const t = io()
    await runUsage(ctx, { json: false, watch: false, everyS: 30 }, t)
    const text = t.out.join('')
    expect(text).toContain('conta     5h')
    expect(text).not.toContain('sessões fixas:')
    expect(text).toContain('sessões fixas indisponíveis')
    const j = io()
    await runUsage(ctx, { json: true, watch: false, everyS: 30 }, j)
    const parsed = JSON.parse(j.out.join(''))
    expect(parsed.pins).toEqual([])
    expect(parsed.pinsUnavailable).toBe(true)
  })
})

describe('comandos (runPin / runUnpin / CLI)', () => {
  test('runPin devolve o resultado e o texto em português; --json só tem caminhos', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'stopped')
    const { outcome, text } = await runPin(ctxAt(sb), { session: ID, account: 'admin1' })
    expect(outcome.result).toBe('rewritten')
    expect(text).toContain(ID)
    expect(text).toContain('admin1')
    const sb2 = world()
    addSession(sb2, ID, flagsOf(muxLink(sb2.paths, 'bk')), 'stopped')
    const j = await runPin(ctxAt(sb2), { session: ID, account: 'admin1', json: true })
    expect(JSON.parse(j.text)).toEqual({ jobId: ID, account: 'admin1', settings: pinLink(sb2.paths, 'admin1'), result: 'rewritten' })
  })

  test('texto da fila diz que o watch aplica', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'busy')
    const { outcome, text } = await runPin(ctxAt(sb), { session: ID, account: 'admin1' })
    expect(outcome.result).toBe('queued')
    expect(text).toContain('watch')
    expect(text).toContain('fila')
  })

  test('runUnpin volta ao mux; nome de conta inválido → exit 3 antes de qualquer coisa; lock ocupado → exit 5', async () => {
    const sb = world()
    addSession(sb, ID, flagsOf(pinLink(sb.paths, 'admin1')), 'stopped')
    const { outcome } = await runUnpin(ctxAt(sb), { session: ID })
    expect(outcome.settings).toBe(muxLink(sb.paths, 'bk'))

    let e: unknown
    try {
      await runPin(ctxAt(sb), { session: ID, account: '../x' })
    } catch (err) {
      e = err
    }
    expect((e as SbError).exit).toBe(EXIT.USAGE)

    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'stopped')
    let locked: unknown
    await withLock(sb.paths, async () => {
      try {
        await runPin(ctxAt(sb), { session: ID, account: 'admin1' }, { waitMs: 50 })
      } catch (err) {
        locked = err
      }
    })
    expect((locked as SbError).exit).toBe(EXIT.LOCKED)
  })

  test('CLI: sb pin/unpin fim a fim — sem token na saída, nos jobs nem no backup', () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'stopped')
    const r = sb.runSb(['pin', ID.slice(0, 6), 'admin1', '--json'])
    expect(r.code).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/sk-ant-/)
    expect(JSON.parse(r.stdout).result).toBe('rewritten')
    expect(flagsNow(sb).at(-1)).toBe(pinLink(sb.paths, 'admin1'))
    const u = sb.runSb(['unpin', ID])
    expect(u.code).toBe(0)
    expect(u.stdout).toContain('solta')
    expect(flagsNow(sb).at(-1)).toBe(muxLink(sb.paths, 'bk'))
    for (const f of [...filesUnder(sb.paths.jobsDir), ...backups(sb)]) expect(readFileSync(f, 'utf8')).not.toContain(FAKE_TOKEN)
    expect(lstatSync(pinLink(sb.paths, 'admin1')).isSymbolicLink()).toBe(true)
  })

  test('CLI: recusas saem com o código certo e mensagem em português', () => {
    const sb = world()
    addSession(sb, ID, flagsOf(muxLink(sb.paths, 'bk')), 'stopped')
    expect(sb.runSb(['pin', ID, 'solo']).code).toBe(3)
    expect(sb.runSb(['pin', 'ffffffff', 'admin1']).code).toBe(3)
    expect(sb.runSb(['pin', ID]).code).not.toBe(0) // falta a conta
    expect(sb.runSb(['unpin', ID, 'extra']).code).toBe(3)
    mkdirSync(join(sb.paths.stateDir, 'x'), { recursive: true })
    writeFileSync(tokenFile(sb.paths, 'admin1'), '{ quebrado')
    const bad = sb.runSb(['pin', ID, 'admin1'])
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('admin1')
  })
})
