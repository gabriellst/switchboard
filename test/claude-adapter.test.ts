import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listAgents, stopSession, type AgentEntry } from '../src/core/claude.js'
import { EXIT, SbError } from '../src/core/errors.js'
import { ownershipOf, type Ownership, readJobState, replaceSettings, settingsValues, writeJobFlags } from '../src/core/jobs.js'
import { muxLink, pinLink, resolvePaths, type Paths } from '../src/core/paths.js'
import { pointMux } from '../src/core/links.js'
import { FAKE_TOKEN, populatedSandbox, sandbox, type Sandbox } from './helpers.js'

const FIXTURES = join(import.meta.dir, 'fixtures', 'claude')
const JOBS = join(FIXTURES, 'jobs')
const JOB_IDS = readdirSync(JOBS).sort() // todo diretório novo em fixtures/claude/jobs entra nos testes de contrato
const AGENTS_TEXT = readFileSync(join(FIXTURES, 'agents.json'), 'utf8')

/** Captura o `SbError` de uma chamada síncrona (falha o teste se não lançar ou lançar outra coisa). */
function sbError(fn: () => unknown): SbError {
  try {
    fn()
  } catch (e) {
    if (e instanceof SbError) return e
    throw e
  }
  throw new Error('não lançou SbError')
}

const fakeFile = (sb: Sandbox, name: string): string => join(sb.env.FAKE_CLAUDE_DIR!, name)
const writeFake = (sb: Sandbox, name: string, text: string): void => {
  mkdirSync(sb.env.FAKE_CLAUDE_DIR!, { recursive: true })
  writeFileSync(fakeFile(sb, name), text)
}
const readFake = (sb: Sandbox, name: string): string => readFileSync(fakeFile(sb, name), 'utf8')
const fakeAgents = (sb: Sandbox): AgentEntry[] => JSON.parse(readFake(sb, 'agents.json')) as AgentEntry[]

/** Paths com a mesma forma dos que as fixtures citam (`~/.local/state/switchboard/...`), HOME no sandbox. */
const fixturePaths = (sb: Sandbox): Paths => resolvePaths({ HOME: sb.env.HOME, SWITCHBOARD_JOBS_DIR: JOBS })

describe('contrato: fixtures reais em test/fixtures/claude', () => {
  test('o diretório de fixtures tem as sessões e o agents.json', () => {
    expect(JOB_IDS.length).toBeGreaterThanOrEqual(16)
  })

  test('agents.json parseia via listAgents (pid/status opcionais, só nas vivas)', () => {
    const sb = sandbox()
    writeFake(sb, 'agents.json', AGENTS_TEXT)
    const list = listAgents(sb.ctx())
    const raw = JSON.parse(AGENTS_TEXT) as Record<string, unknown>[]
    expect(list).toHaveLength(raw.length)
    expect(list.map((a) => a.id)).toEqual(raw.map((a) => a.id as string))
    for (const a of list) {
      expect(typeof a.startedAt).toBe('number')
      expect(a.pid === undefined || typeof a.pid === 'number').toBe(true)
      expect(a.status === undefined || typeof a.status === 'string').toBe(true)
      expect(a.pid === undefined).toBe(a.status === undefined) // vivas têm os dois; paradas, nenhum
    }
    expect(list.filter((a) => a.pid !== undefined).length).toBe(13)
    expect(list.filter((a) => a.pid === undefined).length).toBe(3)
    // cada sessão do agents.json tem o seu state.json de fixture e vice-versa
    expect([...list.map((a) => a.id)].sort()).toEqual(JOB_IDS)
  })

  test.each(JOB_IDS)('jobs/%s/state.json parseia com readJobState', (id) => {
    const sb = sandbox()
    const raw = JSON.parse(readFileSync(join(JOBS, id, 'state.json'), 'utf8')) as Record<string, unknown>
    const st = readJobState(fixturePaths(sb), id)
    expect(st).not.toBeNull()
    expect(st!.respawnFlags).toEqual(raw.respawnFlags as string[])
    expect(st!.respawnFlags.every((f) => typeof f === 'string')).toBe(true)
    expect(st!.state).toBe(raw.state as string)
    expect(st!.inFlight === undefined).toBe(raw.inFlight === undefined)
    // chaves que o adaptador não conhece continuam lá (looseObject)
    expect((st as Record<string, unknown>).sessionId).toBe(raw.sessionId as string)
  })

  const expectedOwnership = (text: string): Ownership => {
    const flags = (JSON.parse(text) as { respawnFlags: string[] }).respawnFlags
    const settings = flags.flatMap((f, i) => (f === '--settings' ? [flags[i + 1]!] : f.startsWith('--settings=') ? [f.slice(11)] : []))
    const v = settings.at(-1)
    if (v === undefined) return { kind: 'none' }
    let m: RegExpMatchArray | null
    if ((m = v.match(/^~\/\.local\/state\/switchboard\/mux\/(.+)\.json$/))) return { kind: 'mux', mux: m[1]! }
    if ((m = v.match(/^~\/\.local\/state\/switchboard\/pins\/(.+)\.json$/))) return { kind: 'pin', account: m[1]! }
    if (v.startsWith('~/.claude/contas/') || v.startsWith('~/.claude/contas-fixas/')) return { kind: 'legacy' }
    return { kind: 'foreign', path: v }
  }

  test.each(JOB_IDS)('ownershipOf(jobs/%s) = o esperado pelo --settings da fixture', (id) => {
    const sb = sandbox()
    const text = readFileSync(join(JOBS, id, 'state.json'), 'utf8')
    const flags = readJobState(fixturePaths(sb), id)!.respawnFlags
    expect(ownershipOf(flags, fixturePaths(sb))).toEqual(expectedOwnership(text))
  })

  test('README: foreign (55ee66ff), none (66ff7788), legacy (77889900), pin (88990011)', () => {
    const sb = sandbox()
    const p = fixturePaths(sb)
    const own = (id: string) => ownershipOf(readJobState(p, id)!.respawnFlags, p)
    expect(own('55ee66ff')).toEqual({ kind: 'foreign', path: '/tmp/outro.json' })
    expect(own('66ff7788')).toEqual({ kind: 'none' })
    expect(own('77889900')).toEqual({ kind: 'legacy' })
    expect(own('88990011')).toEqual({ kind: 'pin', account: 'admin1' })
  })

  test('aa001122 (state.json obsoleto, sem pid) e 99001122 (running, sem drainableMonitors) parseiam como o README diz', () => {
    const sb = sandbox()
    const p = fixturePaths(sb)
    const stale = readJobState(p, 'aa001122')!
    expect(stale.state).toBe('done')
    expect(stale.inFlight).toMatchObject({ tasks: 1, queued: 0, kinds: ['session_cron'], drainableMonitors: 0 })
    expect((stale.inFlight as Record<string, unknown>).selfWake).toBe(true) // chave que o adaptador não conhece passa intacta
    expect(ownershipOf(stale.respawnFlags, p)).toEqual({ kind: 'mux', mux: 'bk' })
    writeFake(sb, 'agents.json', AGENTS_TEXT)
    expect(listAgents(sb.ctx()).find((a) => a.id === 'aa001122')!.pid).toBeUndefined() // sem pid: o job é obsoleto

    const running = readJobState(p, '99001122')!
    expect(running.state).toBe('running')
    expect(running.inFlight).toEqual({ tasks: 1, queued: 0, kinds: ['session_cron'] })
    expect(running.inFlight!.drainableMonitors).toBeUndefined()
    expect(ownershipOf(running.respawnFlags, p)).toEqual({ kind: 'mux', mux: 'bk' })
  })

  test('as fixtures cobrem mux, pin, legacy, foreign e none (um caso novo sem esperado falha aqui)', () => {
    const sb = sandbox()
    const p = fixturePaths(sb)
    const kinds = new Set(JOB_IDS.map((id) => ownershipOf(readJobState(p, id)!.respawnFlags, p).kind))
    expect([...kinds].sort()).toEqual(['foreign', 'legacy', 'mux', 'none', 'pin'])
  })

  test.each(JOB_IDS)('replaceSettings(jobs/%s): ordem e demais flags intactos, --settings novo no fim', (id) => {
    const sb = sandbox()
    const p = fixturePaths(sb)
    const flags = readJobState(p, id)!.respawnFlags
    const newPath = muxLink(p, 'bk')
    const out = replaceSettings(flags, newPath, p)
    expect(out.slice(-2)).toEqual(['--settings', newPath])
    // o resto: exatamente os flags originais menos os --settings NOSSOS (os de terceiros ficam), na mesma ordem
    const rest: string[] = []
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i]!
      const value = f === '--settings' ? flags[i + 1]! : f.startsWith('--settings=') ? f.slice(11) : undefined
      if (value === undefined) rest.push(f)
      else {
        const ours = ['mux', 'pin', 'legacy'].includes(ownershipOf([`--settings=${value}`], p).kind)
        if (!ours) rest.push(...(f === '--settings' ? [f, value] : [f]))
        if (f === '--settings') i++
      }
    }
    expect(out.slice(0, -2)).toEqual(rest)
    const count = (a: string[], x: string) => a.filter((v) => v === x).length
    expect(count(out, '--allowed-tools')).toBe(count(flags, '--allowed-tools'))
    // depois da troca a sessão é do mux
    expect(ownershipOf(out, p)).toEqual({ kind: 'mux', mux: 'bk' })
  })
})

describe('listAgents', () => {
  test('roda `claude agents --json --all` em HOME, sem o token herdado', () => {
    const sb = sandbox()
    writeFake(sb, 'agents.json', AGENTS_TEXT)
    const ctx = sb.ctx({ env: { ...sb.env, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } })
    listAgents(ctx)
    const [call] = sb.calls()
    expect(call!.argv).toEqual(['agents', '--json', '--all'])
    expect(call!.cwd).toBe(sb.env.HOME!)
    expect(call!.hasOauthEnv).toBe(false)
  })

  test('mantém chaves extras da entrada (looseObject) e aceita lista vazia', () => {
    const sb = sandbox()
    writeFake(sb, 'agents.json', '[]')
    expect(listAgents(sb.ctx())).toEqual([])
    sb.addJob({ agent: { id: 'a1b2c3d4', pid: 7, status: 'idle', extra: 'x' } as never })
    const [a] = listAgents(sb.ctx())
    expect(a!.pid).toBe(7)
    expect((a as Record<string, unknown>).extra).toBe('x')
  })

  test('formato inesperado → exit 4, em português, recomendando sb doctor', () => {
    const sb = sandbox()
    writeFake(sb, 'agents.json', '{"x":1}')
    const e = sbError(() => listAgents(sb.ctx()))
    expect(e.exit).toBe(EXIT.CLAUDE)
    expect(e.message).toContain('sb doctor')
    expect(e.message).toMatch(/lista|array/i)
    expect(e.message).not.toContain('"x"') // não despeja a saída crua
  })

  test.each([
    ['campo obrigatório ausente', { cwd: '/a', kind: 'k', startedAt: 1, sessionId: 's', name: 'n', state: 'done' }, 'id'],
    ['startedAt com tipo errado', { id: 'a1b2c3d4', cwd: '/a', kind: 'k', startedAt: '1', sessionId: 's', name: 'n', state: 'done' }, 'startedAt'],
    ['pid com tipo errado', { id: 'a1b2c3d4', cwd: '/a', kind: 'k', startedAt: 1, sessionId: 's', name: 'n', state: 'done', pid: 'x' }, 'pid'],
    ['entrada que não é objeto', 'texto', 'entrada'],
  ])('entrada inesperada (%s) → exit 4 nomeando o campo', (_name, entry, field) => {
    const sb = sandbox()
    writeFake(sb, 'agents.json', JSON.stringify([entry]))
    const e = sbError(() => listAgents(sb.ctx()))
    expect(e.exit).toBe(EXIT.CLAUDE)
    expect(e.message).toContain(field)
    expect(e.message).toContain('sb doctor')
  })

  test('saída que não é JSON → exit 4, trecho curto e sem token', () => {
    const sb = sandbox()
    writeFake(sb, 'agents.json', `Error: ${FAKE_TOKEN} ${'x'.repeat(500)}`)
    const e = sbError(() => listAgents(sb.ctx()))
    expect(e.exit).toBe(EXIT.CLAUDE)
    expect(e.message).toContain('sb doctor')
    expect(e.message + (e.detail ?? '')).not.toMatch(/sk-ant-/)
    expect(e.message.length).toBeLessThan(400)
  })

  test('claude que sai com erro → exit 4', () => {
    const sb = sandbox()
    const ctx = sb.ctx({ run: () => ({ status: 2, stdout: '', stderr: `boom ${FAKE_TOKEN}` }) })
    const e = sbError(() => listAgents(ctx))
    expect(e.exit).toBe(EXIT.CLAUDE)
    expect(e.message + (e.detail ?? '')).not.toMatch(/sk-ant-/)
  })

  test('claude ausente / saída vazia → exit 4', () => {
    const sb = sandbox()
    expect(sbError(() => listAgents(sb.ctx({ run: () => ({ status: null, stdout: '', stderr: 'ENOENT' }) }))).exit).toBe(EXIT.CLAUDE)
    expect(sbError(() => listAgents(sb.ctx({ run: () => ({ status: 0, stdout: '  \n', stderr: '' }) }))).exit).toBe(EXIT.CLAUDE)
  })
})

describe('readJobState', () => {
  test('sem state.json → null', () => {
    const sb = sandbox()
    expect(readJobState(sb.paths, 'a1b2c3d4')).toBeNull()
  })

  test('tolera inFlight ausente, sem drainableMonitors e nulls dos campos opcionais', () => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'a1b2c3d4' }, state: { respawnFlags: [] } })
    expect(readJobState(sb.paths, 'a1b2c3d4')!.inFlight).toBeUndefined()
    sb.addJob({ agent: { id: 'b2c3d4e5' }, state: { respawnFlags: [], inFlight: { tasks: 0, queued: 0, kinds: [] }, needs: null, detail: null } })
    const st = readJobState(sb.paths, 'b2c3d4e5')!
    expect(st.inFlight).toMatchObject({ tasks: 0, queued: 0, kinds: [] })
    expect(st.inFlight!.drainableMonitors).toBeUndefined()
    expect(st.needs).toBeUndefined()
  })

  test.each([
    ['JSON inválido', '{"respawnFlags": ['],
    ['não é objeto', '[1]'],
    ['sem respawnFlags', '{"state":"done"}'],
    ['respawnFlags não é lista de texto', '{"respawnFlags":["--model",3]}'],
    ['inFlight sem kinds', '{"respawnFlags":[],"inFlight":{"tasks":1,"queued":0}}'],
  ])('%s → exit 4 com sb doctor', (_n, text) => {
    const sb = sandbox()
    mkdirSync(join(sb.paths.jobsDir, 'a1b2c3d4'), { recursive: true })
    writeFileSync(join(sb.paths.jobsDir, 'a1b2c3d4', 'state.json'), text)
    const e = sbError(() => readJobState(sb.paths, 'a1b2c3d4'))
    expect(e.exit).toBe(EXIT.CLAUDE)
    expect(e.message).toContain('sb doctor')
  })

  test('id fora do formato (../x) → exit 3, nunca sai do diretório de jobs', () => {
    const sb = sandbox()
    expect(sbError(() => readJobState(sb.paths, '../x')).exit).toBe(EXIT.USAGE)
    expect(sbError(() => readJobState(sb.paths, 'A1B2C3D4')).exit).toBe(EXIT.USAGE)
  })
})

describe('settingsValues', () => {
  test('formas `--settings X` e `--settings=X`, na ordem; ignora `--settings` sem valor', () => {
    expect(settingsValues(['--a', '--settings', 'x', '--model', 'm', '--settings=y', '--settings=', '--settings'])).toEqual(['x', 'y', ''])
    expect(settingsValues(['--allowed-tools', 'Read'])).toEqual([])
  })
})

describe('ownershipOf', () => {
  test('ownership pelo caminho do link, não pelo alvo', () => {
    const sb = populatedSandbox()
    const p = sb.paths
    pointMux(p, 'bk', 'gabriel') // mux/bk.json → tokens/gabriel.json
    expect(ownershipOf(['--settings', muxLink(p, 'bk')], p)).toEqual({ kind: 'mux', mux: 'bk' })
    expect(ownershipOf([`--settings=${pinLink(p, 'admin1')}`], p)).toEqual({ kind: 'pin', account: 'admin1' })
    expect(ownershipOf(['--settings', '~/.claude/contas/ativa.json'], p)).toEqual({ kind: 'legacy' })
    expect(ownershipOf(['--settings', '/tmp/outro.json'], p)).toEqual({ kind: 'foreign', path: '/tmp/outro.json' })
    expect(ownershipOf(['--model', 'opus'], p)).toEqual({ kind: 'none' })
  })

  test('não segue o link final: link de terceiros que aponta para o nosso mux continua foreign; o nosso, apontando para fora, continua mux', () => {
    const sb = populatedSandbox()
    const p = sb.paths
    const outside = join(sb.dir, 'terceiro.json')
    symlinkSync(muxLink(p, 'bk'), outside)
    expect(ownershipOf(['--settings', outside], p)).toEqual({ kind: 'foreign', path: outside })
    const elsewhere = join(sb.dir, 'alvo-qualquer.json')
    writeFileSync(elsewhere, '{}')
    symlinkSync(elsewhere, muxLink(p, 'outro'))
    expect(ownershipOf(['--settings', muxLink(p, 'outro')], p)).toEqual({ kind: 'mux', mux: 'outro' })
  })

  test('os dois sentidos do link final: arquivo REGULAR em mux/ é mux; link de dir estranho que aponta para tokens/ é foreign', () => {
    const sb = populatedSandbox()
    const p = sb.paths
    // arquivo regular dentro de mux/ (não link): é do mux pelo caminho
    writeFileSync(join(p.stateDir, 'mux', 'regular.json'), '{}')
    expect(ownershipOf(['--settings', join(p.stateDir, 'mux', 'regular.json')], p)).toEqual({ kind: 'mux', mux: 'regular' })
    // link num diretório de terceiros apontando PARA DENTRO de tokens/: o alvo não conta, o caminho é de terceiros
    const tok = join(p.stateDir, 'tokens')
    writeFileSync(join(tok, 'alvo.json'), '{}')
    const foreignDir = join(sb.dir, 'terceiros')
    mkdirSync(foreignDir)
    const viaLink = join(foreignDir, 'tok.json')
    symlinkSync(join(tok, 'alvo.json'), viaLink)
    expect(ownershipOf(['--settings', viaLink], p)).toEqual({ kind: 'foreign', path: viaLink })
  })

  test('o diretório é comparado por realpath (diretório pai via symlink, `..`, `~`)', () => {
    const sb = populatedSandbox()
    const p = sb.paths
    const viaLink = join(sb.dir, 'atalho-mux')
    symlinkSync(join(p.stateDir, 'mux'), viaLink)
    expect(ownershipOf(['--settings', join(viaLink, 'bk.json')], p)).toEqual({ kind: 'mux', mux: 'bk' })
    expect(ownershipOf(['--settings', join(p.stateDir, 'pins', '..', 'mux', 'bk.json')], p)).toEqual({ kind: 'mux', mux: 'bk' })
    expect(ownershipOf(['--settings', '~/.claude/contas-fixas/admin1.json'], p)).toEqual({ kind: 'legacy' })
    // `~` vira o HOME do ctx, não o do processo
    expect(ownershipOf(['--settings', '~/.claude/contas/x.json'], { ...p, home: '/nao/existe' })).toEqual({ kind: 'foreign', path: '~/.claude/contas/x.json' })
  })

  test('diretórios inexistentes ainda classificam (estado ainda não criado)', () => {
    const sb = sandbox()
    const p = fixturePaths(sb)
    expect(ownershipOf(['--settings', '~/.local/state/switchboard/mux/bk.json'], p)).toEqual({ kind: 'mux', mux: 'bk' })
  })

  test('vários nossos: vale o último; nosso vale mais que de terceiros, em qualquer ordem', () => {
    const sb = populatedSandbox()
    const p = sb.paths
    const flags = ['--settings', pinLink(p, 'admin1'), '--settings=/tmp/x.json', '--settings', muxLink(p, 'bk'), '--settings=/tmp/y.json']
    expect(ownershipOf(flags, p)).toEqual({ kind: 'mux', mux: 'bk' })
    expect(ownershipOf(['--settings=/tmp/x.json', '--settings', '/tmp/z.json'], p)).toEqual({ kind: 'foreign', path: '/tmp/z.json' })
  })

  test('relativo, fora de .json, nome inválido e JSON inline são foreign (nunca adivinhados)', () => {
    const sb = populatedSandbox()
    const p = sb.paths
    expect(ownershipOf(['--settings', 'mux/bk.json'], p)).toEqual({ kind: 'foreign', path: 'mux/bk.json' })
    expect(ownershipOf(['--settings', join(p.stateDir, 'mux', 'bk')], p)).toEqual({ kind: 'foreign', path: join(p.stateDir, 'mux', 'bk') })
    expect(ownershipOf(['--settings', join(p.stateDir, 'mux', 'Mau Nome.json')], p).kind).toBe('foreign')
    const inline = ownershipOf(['--settings', `{"env":{"CLAUDE_CODE_OAUTH_TOKEN":"${FAKE_TOKEN}"}}`], p)
    expect(inline.kind).toBe('foreign')
    expect(JSON.stringify(inline)).not.toMatch(/sk-ant-/) // JSON inline pode ter token: nunca vai no resultado
  })
})

describe('replaceSettings', () => {
  test('preserva ordem, --allowed-tools repetido e settings de terceiros; troca só os nossos', () => {
    const sb = populatedSandbox()
    const p = sb.paths
    const tools = Array.from({ length: 288 }, (_, i) => ['--allowed-tools', `Tool${i}`]).flat()
    const flags = [
      '--name', 'n',
      '--settings', pinLink(p, 'admin1'),
      ...tools.slice(0, 100),
      '--settings=/tmp/terceiro.json',
      '--model', 'opus',
      `--settings=${muxLink(p, 'bk')}`,
      ...tools.slice(100),
      '--settings', '~/.claude/contas/ativa.json',
      '--settings', '~/.claude/contas-fixas/admin1.json',
      '--verbose',
    ]
    const novo = muxLink(p, 'bk')
    const out = replaceSettings(flags, novo, p)
    expect(out).toEqual([
      '--name', 'n',
      ...tools.slice(0, 100),
      '--settings=/tmp/terceiro.json',
      '--model', 'opus',
      ...tools.slice(100),
      '--verbose',
      '--settings', novo,
    ])
    expect(out.filter((f) => f === '--allowed-tools')).toHaveLength(288)
    expect(flags).toHaveLength(589) // a entrada não é mutada
  })

  test('sem --settings ainda acrescenta; --settings sem valor no fim não vira `--settings --settings x`', () => {
    const sb = populatedSandbox()
    const p = sb.paths
    expect(replaceSettings(['--model', 'haiku'], '/n.json', p)).toEqual(['--model', 'haiku', '--settings', '/n.json'])
    expect(replaceSettings(['--model', 'haiku', '--settings'], '/n.json', p)).toEqual(['--model', 'haiku', '--settings', '/n.json'])
    expect(replaceSettings([], '/n.json', p)).toEqual(['--settings', '/n.json'])
  })
})

describe('stopSession', () => {
  const noSleep = { pollMs: 1, sleep: () => undefined }

  test('chama `claude stop <id>` sem token no ambiente e espera o pid sumir', () => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'a1b2c3d4', pid: 4242, status: 'idle', state: 'done' } })
    writeFake(sb, 'stop-lag', '3')
    const sleeps: number[] = []
    const ctx = sb.ctx({ env: { ...sb.env, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } })
    expect(stopSession(ctx, 'a1b2c3d4', 45_000, { pollMs: 7, sleep: (ms) => void sleeps.push(ms) })).toBe(true)
    const calls = sb.calls()
    expect(calls[0]!.argv).toEqual(['stop', 'a1b2c3d4'])
    expect(calls.every((c) => !c.hasOauthEnv)).toBe(true)
    expect(calls.slice(1).every((c) => c.argv.join(' ') === 'agents --json --all')).toBe(true)
    expect(calls.length).toBe(1 + 3) // o pid só some na 3ª consulta
    expect(sleeps).toEqual([7, 7]) // dorme entre consultas, não gira
    const a = fakeAgents(sb)[0]!
    expect(a.pid).toBeUndefined()
    expect(a.state).toBe('stopped')
  })

  test('sleep padrão (sem injetar): stop-lag 2 termina em poucas dezenas de ms e devolve true', () => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'a1b2c3d4', pid: 4242, status: 'idle', state: 'done' } })
    writeFake(sb, 'stop-lag', '2')
    const t0 = performance.now()
    expect(stopSession(sb.ctx(), 'a1b2c3d4', 2000, { pollMs: 1 })).toBe(true)
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(1500) // o prazo é 2 s: terminou porque o pid sumiu, não por estourar o tempo
    expect(sb.calls().filter((c) => c.argv[0] === 'agents').length).toBe(2)
  })

  test('pid some logo: uma consulta só e sem dormir', () => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'a1b2c3d4', pid: 4242, status: 'idle' } })
    let slept = 0
    expect(stopSession(sb.ctx(), 'a1b2c3d4', 45_000, { pollMs: 1, sleep: () => void slept++ })).toBe(true)
    expect(slept).toBe(0)
  })

  test('só para o id pedido', () => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'a1b2c3d4', pid: 1, status: 'idle' } })
    sb.addJob({ agent: { id: 'b2c3d4e5', pid: 2, status: 'idle' } })
    expect(stopSession(sb.ctx(), 'a1b2c3d4', 1_000, noSleep)).toBe(true)
    const list = fakeAgents(sb)
    expect(list.find((a) => a.id === 'a1b2c3d4')!.pid).toBeUndefined()
    expect(list.find((a) => a.id === 'b2c3d4e5')!.pid).toBe(2)
    expect(sb.calls().filter((c) => c.argv[0] === 'stop').map((c) => c.argv)).toEqual([['stop', 'a1b2c3d4']])
  })

  test('stop que falha → false (e nem consulta a lista)', () => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'a1b2c3d4', pid: 1, status: 'idle' } })
    writeFake(sb, 'stop-fail', '')
    expect(stopSession(sb.ctx(), 'a1b2c3d4', 1_000, noSleep)).toBe(false)
    expect(sb.calls().map((c) => c.argv[0])).toEqual(['stop'])
    expect(fakeAgents(sb)[0]!.pid).toBe(1)
  })

  test('sessão que não para: false ao estourar o prazo (relógio injetado, sem esperar de verdade)', () => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'a1b2c3d4', pid: 1, status: 'idle' } })
    writeFake(sb, 'stop-stuck', '')
    let t = 1_000_000
    const ctx = sb.ctx({ now: () => t })
    let sleeps = 0
    const r = stopSession(ctx, 'a1b2c3d4', 5_000, { pollMs: 1_000, sleep: (ms) => ((t += ms), void sleeps++) })
    expect(r).toBe(false)
    expect(sleeps).toBeGreaterThanOrEqual(4)
    expect(sleeps).toBeLessThanOrEqual(6)
  })

  test('relógio parado e sleep que não avança não vira laço infinito', () => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'a1b2c3d4', pid: 1, status: 'idle' } })
    writeFake(sb, 'stop-stuck', '')
    const ctx = sb.ctx({ now: () => 5 })
    expect(stopSession(ctx, 'a1b2c3d4', 100, { pollMs: 10, sleep: () => undefined })).toBe(false)
  })

  test('sessão que já não existe na lista conta como parada; id desconhecido para o claude → false', () => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'a1b2c3d4', pid: 1, status: 'idle' } })
    expect(stopSession(sb.ctx(), 'b2c3d4e5', 1_000, noSleep)).toBe(false) // o claude falso recusa id desconhecido
    // lista que perde a entrada depois do stop
    const ctx = sb.ctx({
      run: (cmd, args, o) => (args[0] === 'agents' ? { status: 0, stdout: '[]', stderr: '' } : sb.ctx().run(cmd, args, o)),
    })
    expect(stopSession(ctx, 'a1b2c3d4', 1_000, noSleep)).toBe(true)
  })

  test.each(['', 'a1b2c3d', 'a1b2c3d4e', 'A1B2C3D4', 'g1b2c3d4', '../x', 'a1b2c3d4 --all', '-a1b2c3d', 'a1b2c3d4\n'])('id %p fora do formato → exit 3 sem rodar nada', (id) => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'a1b2c3d4', pid: 1, status: 'idle' } })
    expect(sbError(() => stopSession(sb.ctx(), id, 1_000, noSleep)).exit).toBe(EXIT.USAGE)
    expect(sb.calls()).toEqual([])
  })

  test('formato inesperado do agents no meio da espera → exit 4 (não adivinha)', () => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'a1b2c3d4', pid: 1, status: 'idle' } })
    const ctx = sb.ctx({
      run: (cmd, args, o) => (args[0] === 'agents' ? { status: 0, stdout: '{"x":1}', stderr: '' } : sb.ctx().run(cmd, args, o)),
    })
    expect(sbError(() => stopSession(ctx, 'a1b2c3d4', 1_000, noSleep)).exit).toBe(EXIT.CLAUDE)
  })
})

describe('writeJobFlags', () => {
  const FLAGS = ['--name', 'n', '--allowed-tools', 'Read', '--allowed-tools', 'Grep', '--settings', '/tmp/a.json']
  const setup = (extra: Record<string, unknown> = {}): { sb: Sandbox; file: string; backup: string } => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'a1b2c3d4' }, state: { state: 'done', respawnFlags: FLAGS, tokens: 5, ...extra } })
    mkdirSync(join(sb.paths.stateDir, 'backup'), { recursive: true })
    return { sb, file: join(sb.paths.jobsDir, 'a1b2c3d4', 'state.json'), backup: join(sb.paths.stateDir, 'backup', 'a1b2c3d4.state.json') }
  }

  test('faz backup do arquivo original, grava atômico 644, preserva os outros campos e confere', () => {
    const { sb, file, backup } = setup({ inFlight: { tasks: 0, queued: 0, kinds: [] }, sessionId: 'x' })
    const original = readFileSync(file, 'utf8')
    expect(writeJobFlags(sb.paths, 'a1b2c3d4', (f) => [...f.filter((x) => x !== '/tmp/a.json' && x !== '--settings'), '--settings', '/tmp/b.json'], backup)).toBe(true)
    expect(readFileSync(backup, 'utf8')).toBe(original)
    const now = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(now.respawnFlags).toEqual(['--name', 'n', '--allowed-tools', 'Read', '--allowed-tools', 'Grep', '--settings', '/tmp/b.json'])
    expect(now).toMatchObject({ state: 'done', tokens: 5, sessionId: 'x', inFlight: { tasks: 0, queued: 0, kinds: [] } })
    expect(statSync(file).mode & 0o777).toBe(0o644)
    expect(readdirSync(join(sb.paths.jobsDir, 'a1b2c3d4'))).toEqual(['state.json']) // sem temporário
    expect(readJobState(sb.paths, 'a1b2c3d4')!.respawnFlags.at(-1)).toBe('/tmp/b.json')
  })

  test.each([0o600, 0o644])('preserva o modo original do state.json (%o) e o backup fica 600 em diretório 700', (mode) => {
    const { sb, file } = setup()
    chmodSync(file, mode)
    const backup = join(sb.paths.stateDir, 'novo-backup', 'a1b2c3d4.state.json') // diretório ainda inexistente: nasce 700
    expect(writeJobFlags(sb.paths, 'a1b2c3d4', (f) => [...f, '--settings=' + JSON.stringify({ env: { X: 'segredo' } })], backup)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(mode) // 600 não vira legível por todos
    expect(statSync(backup).mode & 0o777).toBe(0o600)
    expect(statSync(join(sb.paths.stateDir, 'novo-backup')).mode & 0o777).toBe(0o700)
  })

  test('relê antes de gravar: campo que o daemon mudou entre a leitura e a escrita sobrevive', () => {
    const { sb, file, backup } = setup()
    const ok = writeJobFlags(sb.paths, 'a1b2c3d4', (f) => [...f, '--verbose'], backup, {
      afterBackup: () => {
        // o daemon regrava o arquivo (estado novo + flag que ele mesmo mudou) depois do backup
        const cur = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        writeFileSync(file, JSON.stringify({ ...cur, state: 'blocked', needs: 'novo', respawnFlags: [...(cur.respawnFlags as string[]), '--daemon-flag'] }, null, 2) + '\n')
      },
    })
    expect(ok).toBe(true)
    const now = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(now.state).toBe('blocked')
    expect(now.needs).toBe('novo')
    expect(now.respawnFlags).toEqual([...FLAGS, '--daemon-flag', '--verbose']) // transform sobre o conteúdo relido
    // o backup guarda o que foi de fato sobrescrito (a versão relida)
    expect((JSON.parse(readFileSync(backup, 'utf8')) as { state: string }).state).toBe('blocked')
  })

  test('backup pode ser um diretório (ex.: backupDir): grava <id>.state.json dentro', () => {
    const { sb } = setup()
    const dir = join(sb.paths.stateDir, 'backup', '2026-11-03')
    mkdirSync(dir, { recursive: true })
    expect(writeJobFlags(sb.paths, 'a1b2c3d4', (f) => [...f, '-x'], dir)).toBe(true)
    expect(readdirSync(dir)).toEqual(['a1b2c3d4.state.json'])
  })

  test('sem state.json → false; formato inesperado → exit 4 e nada é gravado; id inválido → exit 3', () => {
    const sb = sandbox()
    const bk = join(sb.dir, 'bk.json')
    expect(writeJobFlags(sb.paths, 'a1b2c3d4', (f) => f, bk)).toBe(false)
    const dir = join(sb.paths.jobsDir, 'a1b2c3d4')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), '{"state":"done"}')
    expect(sbError(() => writeJobFlags(sb.paths, 'a1b2c3d4', (f) => f, bk)).exit).toBe(EXIT.CLAUDE)
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe('{"state":"done"}')
    expect(sbError(() => writeJobFlags(sb.paths, '../x', (f) => f, bk)).exit).toBe(EXIT.USAGE)
  })

  test('transform que devolve algo que não é lista de texto → false e o arquivo fica como estava', () => {
    const { sb, file, backup } = setup()
    const before = readFileSync(file, 'utf8')
    expect(writeJobFlags(sb.paths, 'a1b2c3d4', (() => 'x') as never, backup)).toBe(false)
    expect(writeJobFlags(sb.paths, 'a1b2c3d4', (() => ['--ok', 3]) as never, backup)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  test('flags iguais: não regrava o arquivo (mtime/bytes intactos) e devolve true', () => {
    const { sb, file, backup } = setup()
    const before = readFileSync(file, 'utf8')
    expect(writeJobFlags(sb.paths, 'a1b2c3d4', (f) => [...f], backup)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  test('falha de gravação do backup → lança e não toca o state.json', () => {
    const { sb, file } = setup()
    const before = readFileSync(file, 'utf8')
    expect(() => writeJobFlags(sb.paths, 'a1b2c3d4', (f) => [...f, '-x'], join(sb.dir, 'arquivo', 'nao', 'existe', '\0x'))).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})
