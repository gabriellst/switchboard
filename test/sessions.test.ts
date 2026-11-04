import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEntry } from '../src/core/claude.js'
import { EXIT, SbError } from '../src/core/errors.js'
import type { JobState } from '../src/core/jobs.js'
import { logFile } from '../src/core/paths.js'
import { activityOf, callerJobId, hasScheduledWork, isLimitBlocked, loadSessions, loadSessionsWithWarnings, startedAt, type Activity, type Session } from '../src/core/sessions.js'
import { FAKE_TOKEN, sandbox, type Sandbox } from './helpers.js'

const FIXTURES = join(import.meta.dir, 'fixtures', 'claude')
const JOBS = join(FIXTURES, 'jobs')
const JOB_IDS = readdirSync(JOBS).sort() // todo fixture nova entra aqui e precisa de linha no README
const AGENTS_TEXT = readFileSync(join(FIXTURES, 'agents.json'), 'utf8')
const README = readFileSync(join(FIXTURES, 'README.md'), 'utf8')

/** `fixture → Activity esperada`, lida da tabela do README (última coluna: primeiro trecho entre crases). */
function readmeActivities(): Map<string, Activity> {
  const out = new Map<string, Activity>()
  for (const line of README.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    const id = cells[1]?.match(/^`([0-9a-f]{8})`$/)?.[1]
    const act = cells[cells.length - 2]?.match(/^`([a-z-]+)`/)?.[1]
    if (id !== undefined && act !== undefined) out.set(id, act as Activity)
  }
  return out
}
const README_ACTIVITIES = readmeActivities()

/** Oráculo escrito à mão a partir das regras (NÃO do README): fixture → Activity esperada. */
const EXPECTED: Record<string, Activity> = {
  a1b2c3d4: 'busy', // working/busy, tasks 1, kinds local_agent: trabalho dentro do turno
  b2c3d4e5: 'free', // done/idle, inFlight vazio
  c3d4e5f6: 'stopped', // sem pid
  d4e5f6a7: 'stopped', // limite, mas sem pid: estado obsoleto
  e5f6a7b8: 'limit-blocked', // viva, ociosa, tasks 0, queued 1
  f6a7b8c9: 'busy', // limite, mas tasks 4
  '11aa22bb': 'scheduled', // session_cron
  '22bb33cc': 'scheduled', // session_cron + wake
  '33cc44dd': 'scheduled', // monitor (antes de busy)
  '44dd55ee': 'scheduled', // cron one-shot ainda visível
  '55ee66ff': 'free', // settings de terceiros, ociosa
  '66ff7788': 'free', // sem --settings, ociosa
  '77889900': 'free', // legado, ociosa
  '88990011': 'free', // pin, ociosa
  '99001122': 'scheduled', // running, inFlight sem drainableMonitors, session_cron
  aa001122: 'stopped', // state.json obsoleto com cron, sem pid
}

/** Contexto com o `claude` falso devolvendo o agents.json das fixtures e os state.json das fixtures; HOME no sandbox. */
function fixtureCtx(sb: Sandbox, over: { now?: () => number } = {}) {
  mkdirSync(sb.env.FAKE_CLAUDE_DIR!, { recursive: true })
  writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'agents.json'), AGENTS_TEXT)
  // `~/.local/state/switchboard/...` das fixtures vira o estado deste HOME
  return sb.ctx({ ...over, env: { ...sb.env, SWITCHBOARD_STATE_DIR: undefined, SWITCHBOARD_JOBS_DIR: JOBS } })
}

const agent = (over: Partial<AgentEntry> = {}): AgentEntry => ({
  id: 'a1b2c3d4',
  cwd: '/tmp/proj',
  kind: 'background',
  startedAt: 1_700_000_000_000,
  sessionId: 'a1b2c3d4-0000-4000-8000-000000000000',
  name: 'n',
  state: 'done',
  pid: 4242,
  status: 'idle',
  ...over,
})

/** `Session` sintética. `pid: undefined` explícito = sem pid. */
function session(a: Partial<AgentEntry> = {}, job: JobState | null = { respawnFlags: [] }): Session {
  const ag = agent(a)
  return { agent: ag, job, owner: { kind: 'none' }, live: ag.pid != null }
}
const jobWith = (over: Partial<JobState> = {}): JobState => ({ respawnFlags: [], ...over })
const inFlight = (over: Partial<NonNullable<JobState['inFlight']>> = {}): NonNullable<JobState['inFlight']> => ({ tasks: 0, queued: 0, kinds: [], ...over })
const noPid = { pid: undefined, status: undefined } as const

describe('fixtures de test/fixtures/claude: Activity do README', () => {
  test('o mapa literal e o README têm uma entrada para cada state.json de fixture (e só elas)', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(JOB_IDS)
    expect([...README_ACTIVITIES.keys()].sort()).toEqual(JOB_IDS)
  })

  test.each(JOB_IDS)('fixture %s → a Activity esperada (mapa literal e README coincidem)', (id) => {
    const sb = sandbox()
    const s = loadSessions(fixtureCtx(sb)).find((x) => x.agent.id === id)
    expect(s).toBeDefined()
    expect(s!.job).not.toBeNull() // toda fixture tem state.json: nenhuma cai na regra "viva sem job → busy"
    expect(activityOf(s!)).toBe(EXPECTED[id]!)
    expect(README_ACTIVITIES.get(id)).toBe(EXPECTED[id]!) // README editado e divergente falha aqui
  })

  test('pertença: mux, pin, legacy, foreign, none (pelo --settings das fixtures)', () => {
    const sb = sandbox()
    const by = new Map(loadSessions(fixtureCtx(sb)).map((s) => [s.agent.id, s.owner]))
    expect(by.get('a1b2c3d4')).toEqual({ kind: 'mux', mux: 'bk' })
    expect(by.get('88990011')).toEqual({ kind: 'pin', account: 'admin1' })
    expect(by.get('77889900')).toEqual({ kind: 'legacy' })
    expect(by.get('55ee66ff')).toEqual({ kind: 'foreign', path: '/tmp/outro.json' })
    expect(by.get('66ff7788')).toEqual({ kind: 'none' })
  })

  test('live = tem pid; só entradas background', () => {
    const sb = sandbox()
    const ctx = fixtureCtx(sb)
    sb.addJob({ agent: { id: '0badf00d', kind: 'interactive', pid: 7 } }) // junta uma não-background ao agents.json
    const list = loadSessions(ctx)
    expect(list.every((s) => s.agent.kind === 'background')).toBe(true)
    expect(list.find((s) => s.agent.id === '0badf00d')).toBeUndefined()
    expect(list.every((s) => s.live === (s.agent.pid !== undefined))).toBe(true)
    expect(list.filter((s) => s.live)).toHaveLength(13)
  })

  test('hasScheduledWork: local_* não é agendado (a1b2c3d4, f6a7b8c9); aa001122 não tem pid; 99001122 e 22bb33cc sim', () => {
    const sb = sandbox()
    const by = new Map(loadSessions(fixtureCtx(sb)).map((s) => [s.agent.id, s]))
    const has = (id: string) => hasScheduledWork(by.get(id)!.job, by.get(id)!.agent)
    expect(has('a1b2c3d4')).toBe(false)
    expect(has('f6a7b8c9')).toBe(false)
    expect(has('aa001122')).toBe(false)
    expect(has('99001122')).toBe(true)
    expect(has('22bb33cc')).toBe(true)
    expect(has('33cc44dd')).toBe(true)
    expect(isLimitBlocked(by.get('e5f6a7b8')!)).toBe(true)
    expect(isLimitBlocked(by.get('d4e5f6a7')!)).toBe(false) // parada: sem pid
    expect(isLimitBlocked(by.get('f6a7b8c9')!)).toBe(false) // tasks 4
  })
})

describe('hasScheduledWork', () => {
  const live = agent()
  test.each([
    ['session_cron', { kinds: ['session_cron'] }],
    ['monitor', { kinds: ['monitor'] }],
    ['wake sem kinds', { kinds: [], wake: { at: 1, reason: 'r', fires: 1 } }],
    ['session_cron junto de local_bash', { kinds: ['local_bash', 'session_cron'] }],
  ])('%s → true', (_n, f) => {
    expect(hasScheduledWork(jobWith({ inFlight: inFlight(f) }), live)).toBe(true)
  })

  test.each([
    ['kinds vazio', inFlight()],
    ['só local_bash', inFlight({ tasks: 1, kinds: ['local_bash'] })],
    ['só local_agent', inFlight({ tasks: 1, kinds: ['local_agent'] })],
    ['drainableMonitors sozinho não conta (regra antiga, abandonada)', inFlight({ drainableMonitors: 2 })],
    ['wake null', inFlight({ wake: null })],
    ['selfWake sozinho não conta', inFlight({ selfWake: true })],
  ])('%s → false', (_n, f) => {
    expect(hasScheduledWork(jobWith({ inFlight: f }), live)).toBe(false)
  })

  test('JobState montado à mão sem `kinds` não lança (TypeError) e não é agendado', () => {
    const job = { respawnFlags: [], inFlight: { tasks: 1, queued: 0 } } as unknown as JobState
    expect(hasScheduledWork(job, live)).toBe(false)
    expect(hasScheduledWork({ ...job, inFlight: { tasks: 1, queued: 0, wake: { at: 1 } } } as unknown as JobState, live)).toBe(true)
  })

  test('sem pid, sem inFlight ou sem job → false (state.json obsoleto não conta)', () => {
    const cron = jobWith({ inFlight: inFlight({ kinds: ['session_cron'], selfWake: true }) })
    expect(hasScheduledWork(cron, agent(noPid))).toBe(false)
    expect(hasScheduledWork(jobWith(), live)).toBe(false)
    expect(hasScheduledWork(null, live)).toBe(false)
  })
})

describe('isLimitBlocked', () => {
  const blocked = (f = inFlight({ queued: 1 })) => jobWith({ state: 'blocked', needs: 'rate limited — wait and retry · resets 20:00', inFlight: f })

  test('viva, bloqueada por limite, tasks 0, ociosa (queued 1) → true', () => {
    expect(isLimitBlocked(session({}, blocked()))).toBe(true)
    expect(isLimitBlocked(session({}, blocked(inFlight())))).toBe(true) // queued 0 também
  })

  test.each([
    ['sem pid', session(noPid, blocked())],
    ['status busy', session({ status: 'busy' }, blocked())],
    ['tasks > 0', session({}, blocked(inFlight({ tasks: 4, kinds: ['local_agent'] })))],
    ['state running', session({}, jobWith({ state: 'running', needs: 'rate limited', inFlight: inFlight() }))],
    ['needs de outra coisa', session({}, jobWith({ state: 'blocked', needs: 'permission to run X', inFlight: inFlight() }))],
    ['needs ausente', session({}, jobWith({ state: 'blocked', inFlight: inFlight() }))],
    ['sem inFlight', session({}, jobWith({ state: 'blocked', needs: 'rate limited' }))],
    ['sem job', session({}, null)],
  ])('%s → false', (_n, s) => {
    expect(isLimitBlocked(s)).toBe(false)
  })
})

describe('activityOf (precedência)', () => {
  const cron = jobWith({ inFlight: inFlight({ kinds: ['session_cron'] }) })
  const limit = jobWith({ state: 'blocked', needs: 'rate limited — wait', inFlight: inFlight({ queued: 1 }) })

  test('sem pid → stopped, mesmo com job bloqueado por limite ou com cron obsoleto', () => {
    expect(activityOf(session(noPid, limit))).toBe('stopped')
    expect(activityOf(session(noPid, cron))).toBe('stopped')
    expect(activityOf(session(noPid, null))).toBe('stopped')
    expect(activityOf(session({ ...noPid, id: 'a1b2c3d4' }, cron), 'a1b2c3d4')).toBe('stopped') // nem quem chamou, se já parou
  })

  test('limit-blocked com queued 1 não é busy', () => {
    expect(activityOf(session({}, limit))).toBe('limit-blocked')
  })

  test('limit-blocked com tasks > 0 é busy', () => {
    expect(activityOf(session({ status: 'busy' }, jobWith({ ...limit, inFlight: inFlight({ tasks: 4, kinds: ['local_agent', 'local_bash'] }) })))).toBe('busy')
  })

  test('sessão que chamou é busy mesmo livre, agendada ou limit-blocked', () => {
    expect(activityOf(session({}, jobWith()), 'a1b2c3d4')).toBe('busy')
    expect(activityOf(session({}, cron), 'a1b2c3d4')).toBe('busy')
    expect(activityOf(session({}, limit), 'a1b2c3d4')).toBe('busy')
    expect(activityOf(session({}, jobWith({ inFlight: inFlight() })), 'ffffffff')).toBe('free') // outro id: sem efeito
    expect(activityOf(session({}, jobWith({ inFlight: inFlight() })), undefined)).toBe('free')
  })

  test('kinds só com local_bash/local_agent → busy, NÃO scheduled (muda a regra conservadora antiga)', () => {
    const job = jobWith({ state: 'working', inFlight: inFlight({ tasks: 2, kinds: ['local_bash', 'local_agent'], drainableMonitors: 1 }) })
    expect(hasScheduledWork(job, agent())).toBe(false)
    expect(activityOf(session({ status: 'busy' }, job))).toBe('busy')
  })

  test('scheduled vem antes de limit-blocked e de busy', () => {
    expect(activityOf(session({ status: 'busy' }, jobWith({ inFlight: inFlight({ tasks: 1, kinds: ['monitor'] }) })))).toBe('scheduled')
    expect(activityOf(session({}, jobWith({ ...limit, inFlight: inFlight({ kinds: ['session_cron'] }) })))).toBe('scheduled')
  })

  test('busy por status, tasks ou queued; senão free', () => {
    expect(activityOf(session({ status: 'busy' }, jobWith()))).toBe('busy')
    expect(activityOf(session({}, jobWith({ inFlight: inFlight({ tasks: 1 }) })))).toBe('busy')
    expect(activityOf(session({}, jobWith({ inFlight: inFlight({ queued: 1 }) })))).toBe('busy') // fila que não é limite
    expect(activityOf(session({}, jobWith({ inFlight: inFlight() })))).toBe('free')
  })

  test('viva sem job (state.json ausente ou ilegível) → busy: nunca parar o que não dá para ler', () => {
    expect(activityOf(session({ status: 'idle' }, null))).toBe('busy')
    expect(activityOf(session({ status: 'busy' }, null))).toBe('busy')
    expect(activityOf(session({}, null), 'a1b2c3d4')).toBe('busy') // quem chamou
    expect(activityOf(session({ status: undefined }, null))).toBe('busy')
  })

  test('parada sem job → stopped', () => {
    expect(activityOf(session(noPid, null))).toBe('stopped')
  })

  test('parser tolerante: job.state qualquer, sem needs/wake/fan (com inFlight presente)', () => {
    for (const state of [undefined, 'running', 'stopped', 'done', 'working', 'blocked', 'algo-novo-do-claude']) {
      expect(activityOf(session({}, jobWith({ state, inFlight: inFlight() })))).toBe('free')
    }
    expect(activityOf(session({}, jobWith({ inFlight: inFlight({ fan: [] }) })))).toBe('free')
  })

  test('viva com state.json legível mas SEM inFlight → busy (falha fechada: não dá para confirmar que não há turno nem agendamento)', () => {
    for (const state of [undefined, 'done', 'blocked', 'running']) {
      expect(activityOf(session({}, jobWith({ state })))).toBe('busy')
    }
    expect(activityOf(session({}, jobWith({ state: 'blocked', needs: 'rate limited' })))).toBe('busy') // não vira limit-blocked sem inFlight
    expect(activityOf(session({ status: 'idle' }, jobWith()))).toBe('busy')
    expect(activityOf(session({ status: undefined }, jobWith()))).toBe('busy')
    expect(activityOf(session({}, jobWith()), 'a1b2c3d4')).toBe('busy') // quem chamou
  })

  test('sem inFlight: parada continua stopped (o pid manda); com inFlight vazio continua free', () => {
    expect(activityOf(session(noPid, jobWith()))).toBe('stopped')
    expect(activityOf(session({}, jobWith({ inFlight: inFlight() })))).toBe('free')
  })
})

describe('callerJobId', () => {
  test('basename de CLAUDE_JOB_DIR; undefined sem a variável', () => {
    expect(callerJobId({ CLAUDE_JOB_DIR: '/Users/x/.claude/jobs/0090cc81' })).toBe('0090cc81')
    expect(callerJobId({ CLAUDE_JOB_DIR: '/Users/x/.claude/jobs/0090cc81/' })).toBe('0090cc81')
    expect(callerJobId({})).toBeUndefined()
    expect(callerJobId({ CLAUDE_JOB_DIR: '' })).toBeUndefined()
    expect(callerJobId({ CLAUDE_JOB_DIR: undefined })).toBeUndefined()
  })
})

describe('startedAt', () => {
  test('devolve agent.startedAt em ms, sem tocar em processo', () => {
    expect(startedAt(session({ startedAt: 1_793_720_010_700 }))).toBe(1_793_720_010_700)
    const sb = sandbox()
    const s = loadSessions(fixtureCtx(sb)).find((x) => x.agent.id === 'a1b2c3d4')!
    expect(startedAt(s)).toBe(1793720010700)
  })
})

describe('loadSessions', () => {
  test('sem state.json → job null (viva → busy, parada → stopped)', () => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'a1b2c3d4', pid: 9, status: 'busy' } })
    sb.addJob({ agent: { id: 'b2c3d4e5' } })
    const list = loadSessions(sb.ctx())
    expect(list.map((s) => [s.agent.id, s.job, s.owner, s.live])).toEqual([
      ['a1b2c3d4', null, { kind: 'none' }, true],
      ['b2c3d4e5', null, { kind: 'none' }, false],
    ])
    expect(activityOf(list[0]!)).toBe('busy')
    expect(activityOf(list[1]!)).toBe('stopped')
  })

  test.each([
    ['respawnFlags não é lista', `{"respawnFlags": "x"}`],
    ['inFlight sem kinds (formato futuro)', `{"respawnFlags": [], "state": "done", "inFlight": {"tasks": 1, "queued": 0}}`],
    ['JSON inválido', '{"respawnFlags": ['],
  ])('sessão VIVA e ociosa com state.json malformado (%s) → busy, e o aviso vai para o log sem conteúdo', (_n, text) => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'b2c3d4e5', pid: 10, status: 'idle' } })
    mkdirSync(join(sb.paths.jobsDir, 'b2c3d4e5'), { recursive: true })
    writeFileSync(join(sb.paths.jobsDir, 'b2c3d4e5', 'state.json'), text.replace('"x"', `"${FAKE_TOKEN}"`))
    const list = loadSessions(sb.ctx())
    expect(list[0]!.job).toBeNull()
    expect(activityOf(list[0]!)).toBe('busy') // pode ter cron/monitor/wake que não conseguimos ver
    const log = readFileSync(logFile(sb.paths, 'watch'), 'utf8')
    expect(log).toContain('b2c3d4e5')
    expect(log).not.toContain('sk-ant-')
  })

  test('state.json malformado não derruba a listagem: job null + aviso sem conteúdo (também no log)', () => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'a1b2c3d4', pid: 9, status: 'idle' }, state: { respawnFlags: ['--settings', '/tmp/x.json'], state: 'done' } })
    sb.addJob({ agent: { id: 'b2c3d4e5', pid: 10, status: 'idle' } })
    mkdirSync(join(sb.paths.jobsDir, 'b2c3d4e5'), { recursive: true })
    writeFileSync(join(sb.paths.jobsDir, 'b2c3d4e5', 'state.json'), `{"respawnFlags": "${FAKE_TOKEN}"}`) // forma errada, com um segredo dentro
    const ctx = sb.ctx()
    const r = loadSessionsWithWarnings(ctx)
    expect(r.sessions.map((s) => s.agent.id)).toEqual(['a1b2c3d4', 'b2c3d4e5'])
    expect(r.sessions[0]!.job).not.toBeNull()
    expect(r.sessions[1]!.job).toBeNull()
    expect(r.sessions[1]!.owner).toEqual({ kind: 'none' })
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('b2c3d4e5')
    expect(r.warnings[0]).not.toContain('sk-ant-')
    // loadSessions: mesma lista e o aviso vai para o log do watch, sem conteúdo
    expect(loadSessions(ctx).map((s) => s.job === null)).toEqual([false, true])
    const log = readFileSync(logFile(sb.paths, 'watch'), 'utf8')
    expect(log).toContain('b2c3d4e5')
    expect(log).not.toContain('sk-ant-')
  })

  test('JSON inválido também vira aviso; lista de agents malformada → exit 4 (não é culpa de uma sessão só)', () => {
    const sb = sandbox()
    sb.addJob({ agent: { id: 'a1b2c3d4', pid: 9, status: 'idle' } })
    mkdirSync(join(sb.paths.jobsDir, 'a1b2c3d4'), { recursive: true })
    writeFileSync(join(sb.paths.jobsDir, 'a1b2c3d4', 'state.json'), '{"respawnFlags": [')
    const r = loadSessionsWithWarnings(sb.ctx())
    expect(r.sessions[0]!.job).toBeNull()
    expect(r.warnings).toHaveLength(1)
    writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'agents.json'), '{"nao": "lista"}')
    let e: unknown
    try {
      loadSessions(sb.ctx())
    } catch (x) {
      e = x
    }
    expect(e).toBeInstanceOf(SbError)
    expect((e as SbError).exit).toBe(EXIT.CLAUDE)
  })

  test('não escreve nada nos jobs nem chama outra coisa além de `agents --json --all`', () => {
    const sb = sandbox()
    const ctx = fixtureCtx(sb)
    loadSessions(ctx)
    expect(sb.calls().map((c) => c.argv.join(' '))).toEqual(['agents --json --all'])
    expect(existsSync(join(JOBS, 'a1b2c3d4', 'state.json.tmp'))).toBe(false)
  })
})
