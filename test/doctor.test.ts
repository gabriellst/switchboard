import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDoctor } from '../src/commands/doctor.js'
import { diagnose, fix } from '../src/core/doctor.js'
import type { Ctx } from '../src/core/ctx.js'
import { EXIT } from '../src/core/errors.js'
import type { Finding } from '../src/core/findings.js'
import { checkSettingsTarget, pointMux } from '../src/core/links.js'
import { muxLink, pinLink, runtimeFile, tokenFile, usageFile, watchFile } from '../src/core/paths.js'
import { applyPending } from '../src/core/pin.js'
import { readRuntime } from '../src/core/runtime.js'
import { ensureState } from '../src/core/tokens.js'
import { loadConfig } from '../src/core/config.js'
import { filesUnder, FAKE_TOKEN, populatedSandbox, type AgentFixture, type Sandbox } from './helpers.js'

const NOW = 1_800_000_000_000
const ID = 'a1b2c3d4'
const ID2 = 'a1b2c3d5'

const ctxAt = (sb: Sandbox, over: Partial<Ctx> = {}): Ctx => sb.ctx({ now: () => NOW, ...over })

/** Sandbox em ordem: config, tokens 600, estado 700, link do mux, uso sem erro e watch com batimento vivo. */
function healthy(): Sandbox {
  const sb = populatedSandbox()
  writeFileSync(watchFile(sb.paths), `${JSON.stringify({ pid: process.pid, lastTick: NOW })}\n`)
  return sb
}

const writeConfig = (sb: Sandbox, cfg: unknown): void => writeFileSync(sb.paths.configFile, JSON.stringify(cfg))

const baseConfig = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  switchboard: 1,
  accounts: { gabriel: {}, admin1: {} },
  default: 'bk',
  mux: { bk: { root: '~/bk', account: 'gabriel', accounts: ['gabriel', 'admin1'], pool: ['gabriel', 'admin1'] } },
  ...over,
})

/** `severidade:código:assunto`, ordenado: compara o conjunto inteiro de achados de uma vez (um achado a mais também falha). */
const shape = (fs: Finding[]): string[] => fs.map((f) => `${f.severity}:${f.code}:${f.subject}`).sort()
const only = (fs: Finding[], code: string): Finding[] => fs.filter((f) => f.code === code)

type Kind = 'free' | 'busy' | 'stopped'
function addSession(sb: Sandbox, id: string, flags: string[], kind: Kind, agent: Partial<AgentFixture> = {}): void {
  const live = kind !== 'stopped'
  const inFlight = kind === 'busy' ? { tasks: 1, queued: 0, kinds: ['local_agent'] } : { tasks: 0, queued: 0, kinds: [] }
  sb.addJob({
    agent: { id, cwd: join(sb.env.HOME!, 'bk', 'proj'), ...(live && { pid: 4242, status: kind === 'busy' ? 'busy' : 'idle' }), ...agent },
    state: { respawnFlags: flags, cwd: '/tmp/proj', state: kind === 'busy' ? 'working' : 'done', inFlight, extra: { keep: 'me' } },
  })
}

const stateFile = (sb: Sandbox, id = ID): string => join(sb.paths.jobsDir, id, 'state.json')
const flagsNow = (sb: Sandbox, id = ID): string[] => (JSON.parse(readFileSync(stateFile(sb, id), 'utf8')) as { respawnFlags: string[] }).respawnFlags
const stops = (sb: Sandbox): string[][] => sb.calls().filter((c) => c.argv[0] === 'stop').map((c) => c.argv)
const putPs = (sb: Sandbox, ...lines: string[]): void => {
  mkdirSync(sb.env.FAKE_CLAUDE_DIR!, { recursive: true })
  writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'ps.txt'), `${lines.join('\n')}\n`)
}
const snapshotState = (sb: Sandbox, ...ids: string[]): string[] => ids.map((i) => readFileSync(stateFile(sb, i), 'utf8'))
const mode = (p: string): number => statSync(p).mode & 0o777

describe('diagnose — tudo em ordem', () => {
  test('estado saudável → nenhum achado', async () => {
    expect(await diagnose(ctxAt(healthy()))).toEqual([])
  })

  test('não escreve nada: estado, config e jobs idênticos depois', async () => {
    const sb = healthy()
    addSession(sb, ID, ['--settings', muxLink(sb.paths, 'bk')], 'free')
    const dirs = [sb.paths.stateDir, sb.paths.jobsDir]
    const snap = (): string[] => dirs.flatMap((d) => filesUnder(d)).sort().map((f) => `${f}\n${readFileSync(f, 'utf8')}`)
    const before = snap()
    await diagnose(ctxAt(sb))
    expect(snap()).toEqual(before)
  })
})

describe('diagnose — erros', () => {
  test('config.invalid (JSON quebrado ou ausente) → erro; o resto que não depende da config continua', async () => {
    const sb = healthy()
    writeFileSync(sb.paths.configFile, '{ "switchboard": ')
    chmodSync(tokenFile(sb.paths, 'admin1'), 0o644)
    const fs = await diagnose(ctxAt(sb))
    expect(shape(fs)).toEqual(['error:config.invalid:config', 'error:token.perms:admin1'])
    expect(only(fs, 'config.invalid')[0]!.message).toContain('config inválida')

    rmSync(sb.paths.configFile)
    expect(only(await diagnose(ctxAt(sb)), 'config.invalid')[0]!.message).toContain('config não encontrada')
  })

  test('config.no-token: conta registrada sem tokens/<conta>.json', async () => {
    const sb = healthy()
    rmSync(tokenFile(sb.paths, 'admin1'))
    expect(shape(await diagnose(ctxAt(sb)))).toEqual(['error:config.no-token:admin1'])
  })

  test('config.no-token não vale para keychain (nunca guarda token)', async () => {
    const sb = healthy()
    writeConfig(sb, baseConfig({ mux: { bk: { root: '~/bk', account: 'gabriel', accounts: ['gabriel', 'admin1', 'keychain'], pool: [] } } }))
    ensureState(sb.paths)
    expect(shape(await diagnose(ctxAt(sb)))).toEqual([])
  })

  test.each<[string, (sb: Sandbox) => void]>([
    ['link ausente', (sb) => rmSync(muxLink(sb.paths, 'bk'))],
    ['arquivo comum no lugar do link', (sb) => (rmSync(muxLink(sb.paths, 'bk')), writeFileSync(muxLink(sb.paths, 'bk'), '{}'))],
    ['link para fora de tokens/', (sb) => (rmSync(muxLink(sb.paths, 'bk')), symlinkSync(join(sb.dir, 'x.json'), muxLink(sb.paths, 'bk')))],
    ['alvo apagado (link pendurado)', (sb) => rmSync(tokenFile(sb.paths, 'gabriel'))],
  ])('link.broken: mux com %s', async (_n, damage) => {
    const sb = healthy()
    damage(sb)
    const fs = await diagnose(ctxAt(sb))
    expect(only(fs, 'link.broken').map((f) => `${f.severity}:${f.subject}`)).toEqual(['error:mux/bk'])
  })

  test('link.broken: pin quebrado (arquivo comum) e pin pendurado; pin válido e ausente não reclamam', async () => {
    const sb = healthy()
    symlinkSync(tokenFile(sb.paths, 'gabriel'), pinLink(sb.paths, 'gabriel')) // válido
    writeFileSync(pinLink(sb.paths, 'admin1'), '{}') // arquivo comum
    const fs = await diagnose(ctxAt(sb))
    expect(only(fs, 'link.broken').map((f) => f.subject)).toEqual(['pins/admin1'])
    expect(only(fs, 'link.broken')[0]!.severity).toBe('error')
  })

  test('link.broken: sessão presa a um pin cujo link sumiu (ela não abriria)', async () => {
    const sb = healthy()
    addSession(sb, ID, ['--settings', pinLink(sb.paths, 'admin1')], 'stopped')
    expect(only(await diagnose(ctxAt(sb)), 'link.broken').map((f) => f.subject)).toEqual(['pins/admin1'])
  })

  test('token.invalid-json (F6): o mux aponta para o token ruim → erro no token E no link; a mensagem não traz o conteúdo', async () => {
    const sb = healthy()
    writeFileSync(tokenFile(sb.paths, 'gabriel'), `{ "env": { "CLAUDE_CODE_OAUTH_TOKEN": "${FAKE_TOKEN}"`, { mode: 0o600 })
    const fs = await diagnose(ctxAt(sb))
    expect(shape(fs)).toEqual(['error:link.broken:mux/bk', 'error:token.invalid-json:gabriel'])
    expect(JSON.stringify(fs)).not.toMatch(/sk-ant-/)
  })

  test('token.invalid-json: JSON válido mas não objeto também conta', async () => {
    const sb = healthy()
    writeFileSync(tokenFile(sb.paths, 'admin1'), '["x"]', { mode: 0o600 })
    expect(shape(await diagnose(ctxAt(sb)))).toEqual(['error:token.invalid-json:admin1'])
  })

  test('token.invalid-json: tokens/keychain.json com qualquer coisa além de {}', async () => {
    const sb = healthy()
    writeConfig(sb, baseConfig({ mux: { bk: { root: '~/bk', account: 'gabriel', accounts: ['gabriel', 'admin1', 'keychain'], pool: [] } } }))
    ensureState(sb.paths)
    writeFileSync(tokenFile(sb.paths, 'keychain'), `{"env":{"CLAUDE_CODE_OAUTH_TOKEN":"${FAKE_TOKEN}"}}`, { mode: 0o600 })
    const fs = await diagnose(ctxAt(sb))
    expect(shape(fs)).toEqual(['error:token.invalid-json:keychain'])
    expect(JSON.stringify(fs)).not.toMatch(/sk-ant-/)
  })

  test('token.no-oauth: JSON válido sem CLAUDE_CODE_OAUTH_TOKEN', async () => {
    const sb = healthy()
    writeFileSync(tokenFile(sb.paths, 'admin1'), '{"env":{}}', { mode: 0o600 })
    expect(shape(await diagnose(ctxAt(sb)))).toEqual(['error:token.no-oauth:admin1'])
  })

  test('token.dead: última medição 401/403; sem erro de sonda ou com outro erro não conta', async () => {
    const sb = healthy()
    const usage = JSON.parse(readFileSync(usageFile(sb.paths), 'utf8')) as { latest: Record<string, unknown> }
    usage.latest.admin1 = { ok: false, error: 'dead-token', httpStatus: 401, measuredAt: 1_700_000_000_000 }
    usage.latest.gabriel = { ok: false, error: 'network', measuredAt: 1_700_000_000_000 }
    writeFileSync(usageFile(sb.paths), JSON.stringify(usage))
    expect(shape(await diagnose(ctxAt(sb)))).toEqual(['error:token.dead:admin1'])
  })

  test('token.perms: ≠ 600', async () => {
    const sb = healthy()
    chmodSync(tokenFile(sb.paths, 'admin1'), 0o644)
    const fs = await diagnose(ctxAt(sb))
    expect(shape(fs)).toEqual(['error:token.perms:admin1'])
    expect(fs[0]!.message).toContain('644')
  })

  test('session.no-settings: sessão (parada ou viva) sob o root do mux, sem --settings', async () => {
    const sb = healthy()
    addSession(sb, ID, ['--allowed-tools', 'Read'], 'stopped')
    addSession(sb, ID2, [], 'free')
    const fs = await diagnose(ctxAt(sb))
    expect(shape(fs)).toEqual([`error:session.no-settings:${ID}`, `error:session.no-settings:${ID2}`])
  })

  test('session.no-settings: fora de todo root vale o mux default (como o `sb which`)', async () => {
    const sb = healthy()
    addSession(sb, ID, [], 'stopped', { cwd: '/tmp/fora' })
    expect(shape(await diagnose(ctxAt(sb)))).toEqual([`error:session.no-settings:${ID}`])
  })

  test('session.no-settings: não vale no mux cuja conta atual é keychain, nem com state.json ilegível, nem para sessão que já tem settings', async () => {
    const sb = healthy()
    writeConfig(
      sb,
      baseConfig({
        accounts: { gabriel: {}, admin1: {} },
        mux: {
          bk: { root: '~/bk', account: 'gabriel', accounts: ['gabriel', 'admin1'], pool: ['gabriel', 'admin1'] },
          bz: { root: '~/bz', account: 'keychain', accounts: ['keychain'], pool: [] },
        },
      }),
    )
    ensureState(sb.paths)
    pointMux(sb.paths, 'bz', 'keychain')
    addSession(sb, ID, [], 'stopped', { cwd: join(sb.env.HOME!, 'bz', 'x') }) // keychain: roda no keychain, certo
    addSession(sb, ID2, ['--settings', muxLink(sb.paths, 'bk')], 'free') // já tem
    addSession(sb, 'a1b2c3d6', [], 'free')
    writeFileSync(stateFile(sb, 'a1b2c3d6'), '{ "respawnFlags": [') // viva, ilegível: nunca adotada
    const fs = await diagnose(ctxAt(sb))
    expect(shape(fs)).toEqual(['warn:claude.format:a1b2c3d6'])
  })

  test('view.no-settings: `claude agents` sem --settings, ou com settings de terceiros', async () => {
    const sb = healthy()
    const link = muxLink(sb.paths, 'bk')
    putPs(
      sb,
      '  101 /usr/local/bin/claude agents --cwd /x',
      `  102 /usr/local/bin/claude agents --cwd /x --settings ${link}`, // ok
      `  103 /usr/local/bin/claude agents --settings=${link}`, // ok
      '  104 /usr/local/bin/claude agents --settings /tmp/outro.json',
      `  105 /usr/local/bin/claude agents --json --all`, // a listagem do watch: não é uma view
      '  106 /usr/bin/vim agents.txt',
      '  107 /usr/local/bin/claude -p agents',
    )
    const fs = await diagnose(ctxAt(sb))
    expect(shape(fs)).toEqual(['error:view.no-settings:pid 101', 'error:view.no-settings:pid 104'])
  })

  test('view.no-settings: a linha literal do ps do usuário (`claude agents --cwd <pasta>`, sem --settings)', async () => {
    const sb = healthy()
    putPs(sb, '  4321 /Users/work/.local/bin/claude agents --cwd /Users/work/Desktop/Projetos/bk-company')
    const fs = await diagnose(ctxAt(sb))
    expect(shape(fs)).toEqual(['error:view.no-settings:pid 4321'])
    expect(only(fs, 'view.no-settings')[0]!.message).not.toContain('/Users/work/Desktop') // a linha de comando nunca vai para o achado
  })

  test('view.no-settings: settings inline com token nunca vai para o achado', async () => {
    const sb = healthy()
    putPs(sb, `  101 claude agents --settings {"env":{"CLAUDE_CODE_OAUTH_TOKEN":"${FAKE_TOKEN}"}}`)
    const fs = await diagnose(ctxAt(sb))
    expect(shape(fs)).toEqual(['error:view.no-settings:pid 101'])
    expect(JSON.stringify(fs)).not.toMatch(/sk-ant-/)
  })
})

describe('diagnose — avisos', () => {
  test('state.perms: raiz e subdiretórios ≠ 700', async () => {
    const sb = healthy()
    chmodSync(sb.paths.stateDir, 0o755)
    chmodSync(join(sb.paths.stateDir, 'tokens'), 0o750)
    const fs = await diagnose(ctxAt(sb))
    expect(shape(fs)).toEqual(['warn:state.perms:estado', 'warn:state.perms:tokens'])
    expect(fs.find((f) => f.subject === 'tokens')!.message).toContain('750')
  })

  test('pool.duplicates: contas com o mesmo uso no mesmo pool', async () => {
    const sb = healthy()
    const usage = JSON.parse(readFileSync(usageFile(sb.paths), 'utf8')) as { groups: string[][] }
    usage.groups = [['gabriel', 'admin1']]
    writeFileSync(usageFile(sb.paths), JSON.stringify(usage))
    expect(shape(await diagnose(ctxAt(sb)))).toEqual(['warn:pool.duplicates:bk'])
  })

  test('pool.duplicates: duplicata com só uma das contas no pool não conta', async () => {
    const sb = healthy()
    writeConfig(sb, baseConfig({ mux: { bk: { root: '~/bk', account: 'gabriel', accounts: ['gabriel', 'admin1'], pool: ['gabriel'] } } }))
    const usage = JSON.parse(readFileSync(usageFile(sb.paths), 'utf8')) as { groups: string[][] }
    usage.groups = [['gabriel', 'admin1']]
    writeFileSync(usageFile(sb.paths), JSON.stringify(usage))
    expect(shape(await diagnose(ctxAt(sb)))).toEqual([])
  })

  test('pool.preferred-outside: pool não vazio sem a preferida; pool vazio não avisa', async () => {
    const sb = healthy()
    writeConfig(sb, baseConfig({ mux: { bk: { root: '~/bk', account: 'gabriel', accounts: ['gabriel', 'admin1'], pool: ['admin1'] } } }))
    expect(shape(await diagnose(ctxAt(sb)))).toEqual(['warn:pool.preferred-outside:bk'])
    writeConfig(sb, baseConfig({ mux: { bk: { root: '~/bk', account: 'gabriel', accounts: ['gabriel', 'admin1'], pool: [] } } }))
    expect(shape(await diagnose(ctxAt(sb)))).toEqual([])
  })

  test('account.unattached: conta registrada que nenhum mux usa', async () => {
    const sb = healthy()
    writeConfig(sb, baseConfig({ accounts: { gabriel: {}, admin1: {}, extra: {} } }))
    sb.addToken('extra')
    expect(shape(await diagnose(ctxAt(sb)))).toEqual(['warn:account.unattached:extra'])
  })

  test('link.orphan: link de mux que saiu da config, pin de conta removida e token sem registro', async () => {
    const sb = healthy()
    symlinkSync(tokenFile(sb.paths, 'gabriel'), muxLink(sb.paths, 'velho')) // mux removido da config (rmMux mantém o link)
    symlinkSync(tokenFile(sb.paths, 'gabriel'), pinLink(sb.paths, 'sumida')) // conta removida (removeAccount deixa o pin)
    symlinkSync(tokenFile(sb.paths, 'gabriel'), pinLink(sb.paths, 'keychain')) // keychain nunca é órfã
    sb.addToken('sumida') // e o token que removeAccount não apagou
    const fs = await diagnose(ctxAt(sb))
    expect(shape(fs)).toEqual(['warn:link.orphan:mux/velho', 'warn:link.orphan:pins/sumida', 'warn:link.orphan:tokens/sumida'].sort())
  })

  test('session.legacy e session.foreign: avisos, nunca erro', async () => {
    const sb = healthy()
    addSession(sb, ID, ['--settings', join(sb.paths.claudeDir, 'contas', 'ativa.json')], 'stopped')
    addSession(sb, ID2, ['--settings', '/tmp/terceiros.json'], 'free')
    expect(shape(await diagnose(ctxAt(sb)))).toEqual([`warn:session.foreign:${ID2}`, `warn:session.legacy:${ID}`])
  })

  test('view.legacy: view aberta com o settings do claude-conta', async () => {
    const sb = healthy()
    putPs(sb, `  301 claude agents --cwd /x --settings ${join(sb.paths.claudeDir, 'contas', 'ativa.json')}`)
    expect(shape(await diagnose(ctxAt(sb)))).toEqual(['warn:view.legacy:pid 301'])
  })

  test('watch.stopped: sem batimento, pid morto ou ciclo atrasado (> 90 s); 80 s ainda está vivo', async () => {
    const sb = healthy()
    const put = (v: unknown): void => writeFileSync(watchFile(sb.paths), JSON.stringify(v))
    rmSync(watchFile(sb.paths))
    expect(shape(await diagnose(ctxAt(sb)))).toEqual(['warn:watch.stopped:watch'])
    put({ pid: 2_147_483_000, lastTick: NOW })
    expect(shape(await diagnose(ctxAt(sb)))).toEqual(['warn:watch.stopped:watch'])
    put({ pid: process.pid, lastTick: NOW - 91_000 })
    expect(shape(await diagnose(ctxAt(sb)))).toEqual(['warn:watch.stopped:watch'])
    put({ pid: process.pid, lastTick: NOW - 80_000 })
    expect(shape(await diagnose(ctxAt(sb)))).toEqual([])
  })

  test('claude.format: lista de agentes em formato inesperado → aviso; sessões e views continuam sendo checadas pelo que dá', async () => {
    const sb = healthy()
    mkdirSync(sb.env.FAKE_CLAUDE_DIR!, { recursive: true })
    writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'agents.json'), '{"nao":"uma lista"}')
    putPs(sb, '  101 claude agents')
    const fs = await diagnose(ctxAt(sb))
    expect(shape(fs)).toEqual(['error:view.no-settings:pid 101', 'warn:claude.format:claude'])
  })

  test('claude.format: state.json de sessão viva em formato novo → aviso com o id, sem conteúdo, e a sessão não vira session.no-settings', async () => {
    const sb = healthy()
    addSession(sb, ID, [], 'free')
    writeFileSync(stateFile(sb), JSON.stringify({ respawnFlags: 'agora é texto', token: FAKE_TOKEN }))
    const fs = await diagnose(ctxAt(sb))
    expect(shape(fs)).toEqual([`warn:claude.format:${ID}`])
    expect(JSON.stringify(fs)).not.toMatch(/sk-ant-/)
  })
})

describe('runDoctor — saída e exit', () => {
  test('tudo em ordem → exit 0 e "tudo em ordem"', async () => {
    const r = await runDoctor(ctxAt(healthy()), {})
    expect(r.exit).toBe(EXIT.OK)
    expect(r.findings).toEqual([])
    expect(r.text).toContain('tudo em ordem')
  })

  test('só avisos → exit 0, com o aviso na tela', async () => {
    const sb = healthy()
    rmSync(watchFile(sb.paths))
    const r = await runDoctor(ctxAt(sb), {})
    expect(r.exit).toBe(EXIT.OK)
    expect(r.text).toContain('watch.stopped')
    expect(r.text).not.toContain('tudo em ordem')
  })

  test('erro → exit 1; config inválida → exit 2 (mesmo com outro erro junto)', async () => {
    const sb = healthy()
    chmodSync(tokenFile(sb.paths, 'admin1'), 0o644)
    expect((await runDoctor(ctxAt(sb), {})).exit).toBe(EXIT.CHECK_FAILED)
    writeFileSync(sb.paths.configFile, 'não é json')
    const r = await runDoctor(ctxAt(sb), {})
    expect(r.exit).toBe(EXIT.INVALID_CONFIG)
    expect(r.text).toContain('config.invalid')
  })

  test('--json: { findings } com code/severity/subject/message; sem token mesmo com token.invalid-json', async () => {
    const sb = healthy()
    writeFileSync(tokenFile(sb.paths, 'admin1'), `{ "env": { "CLAUDE_CODE_OAUTH_TOKEN": "${FAKE_TOKEN}"`, { mode: 0o600 })
    const r = await runDoctor(ctxAt(sb), { json: true })
    expect(r.text).not.toMatch(/sk-ant-/)
    const out = JSON.parse(r.text) as { findings: Finding[]; fixes?: unknown }
    expect(out.fixes).toBeUndefined()
    expect(out.findings.map((f) => `${f.severity}:${f.code}:${f.subject}`)).toEqual(['error:token.invalid-json:admin1'])
    expect(Object.keys(out.findings[0]!).sort()).toEqual(['code', 'message', 'severity', 'subject'])
    expect(r.exit).toBe(EXIT.CHECK_FAILED)
  })

  test('pelo processo: `sb doctor --json` imprime só JSON, sem token, e respeita o exit', () => {
    const sb = healthy()
    writeFileSync(watchFile(sb.paths), `${JSON.stringify({ pid: process.pid, lastTick: Date.now() })}\n`)
    writeFileSync(tokenFile(sb.paths, 'admin1'), `{ "env": { "CLAUDE_CODE_OAUTH_TOKEN": "${FAKE_TOKEN}"`, { mode: 0o600 })
    const r = sb.runSb(['doctor', '--json'])
    expect(r.code).toBe(1)
    expect(r.stdout + r.stderr).not.toMatch(/sk-ant-/)
    expect((JSON.parse(r.stdout) as { findings: Finding[] }).findings.map((f) => f.code)).toEqual(['token.invalid-json'])

    const ok = healthy()
    writeFileSync(watchFile(ok.paths), `${JSON.stringify({ pid: process.pid, lastTick: Date.now() })}\n`)
    const clean = ok.runSb(['doctor'])
    expect(clean.code).toBe(0)
    expect(clean.stdout).toContain('tudo em ordem')

    rmSync(ok.paths.configFile)
    expect(ok.runSb(['doctor']).code).toBe(2)
  })
})

describe('--fix', () => {
  test('recria link quebrado, corrige 644 → 600 e adota sessão parada sem settings', async () => {
    const sb = healthy()
    rmSync(muxLink(sb.paths, 'bk'))
    chmodSync(tokenFile(sb.paths, 'admin1'), 0o644)
    addSession(sb, ID, ['--allowed-tools', 'Read', '--allowed-tools', 'Bash'], 'stopped')
    chmodSync(stateFile(sb), 0o600)

    // o link do mux é recriado ANTES da adoção: a adoção confere o destino
    const r = await runDoctor(ctxAt(sb), { fix: true })

    expect(checkSettingsTarget(muxLink(sb.paths, 'bk'))).toEqual({ ok: true, account: 'gabriel' })
    expect(mode(tokenFile(sb.paths, 'admin1'))).toBe(0o600)
    expect(flagsNow(sb)).toEqual(['--allowed-tools', 'Read', '--allowed-tools', 'Bash', '--settings', muxLink(sb.paths, 'bk')])
    expect(mode(stateFile(sb))).toBe(0o600)
    expect(JSON.parse(readFileSync(stateFile(sb), 'utf8')).extra).toEqual({ keep: 'me' })
    expect(filesUnder(join(sb.paths.stateDir, 'backup')).length).toBe(1)
    expect(stops(sb)).toEqual([])
    expect(r.exit).toBe(EXIT.OK)
    expect(r.findings).toEqual([]) // o relatório final é o de DEPOIS do conserto
    expect(r.fixes.map((f) => `${f.ok}:${f.code}:${f.subject}`).sort()).toEqual(['true:link.broken:mux/bk', `true:session.no-settings:${ID}`, 'true:token.perms:admin1'])
    expect(r.text).toContain('tudo em ordem')
  })

  test('link: reaproveita a conta atual quando ela serve; senão a preferida', async () => {
    const sb = healthy()
    // aponta para admin1 por um caminho fora de tokens/: quebrado, mas a conta atual (admin1) está em accounts e tem token
    rmSync(muxLink(sb.paths, 'bk'))
    symlinkSync(join(sb.dir, 'elsewhere', 'admin1.json'), muxLink(sb.paths, 'bk'))
    await runDoctor(ctxAt(sb), { fix: true })
    expect(checkSettingsTarget(muxLink(sb.paths, 'bk'))).toEqual({ ok: true, account: 'admin1' })

    // conta atual que não está em accounts do mux → volta para a preferida
    rmSync(muxLink(sb.paths, 'bk'))
    symlinkSync(join(sb.dir, 'elsewhere', 'outra.json'), muxLink(sb.paths, 'bk'))
    await runDoctor(ctxAt(sb), { fix: true })
    expect(checkSettingsTarget(muxLink(sb.paths, 'bk'))).toEqual({ ok: true, account: 'gabriel' })

    // arquivo comum no lugar do link
    rmSync(muxLink(sb.paths, 'bk'))
    writeFileSync(muxLink(sb.paths, 'bk'), '{}')
    await runDoctor(ctxAt(sb), { fix: true })
    expect(lstatSync(muxLink(sb.paths, 'bk')).isSymbolicLink()).toBe(true)
    expect(checkSettingsTarget(muxLink(sb.paths, 'bk')).ok).toBe(true)
  })

  test('link: conta atual sem token utilizável → a preferida; nenhuma utilizável → continua erro (exit 1), nada inventado', async () => {
    const sb = healthy()
    // mux em admin1, e admin1 perde o token: o link fica pendurado
    pointMux(sb.paths, 'bk', 'admin1')
    rmSync(tokenFile(sb.paths, 'admin1'))
    const r = await runDoctor(ctxAt(sb), { fix: true })
    expect(checkSettingsTarget(muxLink(sb.paths, 'bk'))).toEqual({ ok: true, account: 'gabriel' })
    expect(r.findings.map((f) => f.code)).toEqual(['config.no-token']) // faltou token: só `sb login` resolve
    expect(r.exit).toBe(EXIT.CHECK_FAILED)

    rmSync(tokenFile(sb.paths, 'gabriel'))
    const r2 = await runDoctor(ctxAt(sb), { fix: true })
    expect(r2.exit).toBe(EXIT.CHECK_FAILED)
    expect(r2.findings.some((f) => f.code === 'link.broken')).toBe(true)
    expect(r2.fixes.some((f) => f.code === 'link.broken' && !f.ok)).toBe(true)
  })

  test('link de mux keychain ausente: recria o link e tokens/keychain.json ({} se faltar)', async () => {
    const sb = healthy()
    writeConfig(sb, baseConfig({ mux: { bk: { root: '~/bk', account: 'keychain', accounts: ['keychain', 'gabriel'], pool: [] } } }))
    rmSync(muxLink(sb.paths, 'bk'))
    await runDoctor(ctxAt(sb), { fix: true })
    expect(readFileSync(tokenFile(sb.paths, 'keychain'), 'utf8')).toBe('{}')
    expect(checkSettingsTarget(muxLink(sb.paths, 'bk'))).toEqual({ ok: true, account: 'keychain' })
  })

  test('pin: recria pins/<conta>.json quebrado; pin de conta sem token e pin órfão ficam como estão', async () => {
    const sb = healthy()
    writeFileSync(pinLink(sb.paths, 'admin1'), '{}')
    symlinkSync(tokenFile(sb.paths, 'gabriel'), pinLink(sb.paths, 'sumida')) // órfão: o doctor não apaga
    await runDoctor(ctxAt(sb), { fix: true })
    expect(readlinkSync(pinLink(sb.paths, 'admin1'))).toBe(tokenFile(sb.paths, 'admin1'))
    expect(checkSettingsTarget(pinLink(sb.paths, 'admin1'))).toEqual({ ok: true, account: 'admin1' })
    expect(readlinkSync(pinLink(sb.paths, 'sumida'))).toBe(tokenFile(sb.paths, 'gabriel'))
  })

  test('permissões: diretórios de estado → 700; nenhum arquivo de token tem o conteúdo tocado', async () => {
    const sb = healthy()
    chmodSync(sb.paths.stateDir, 0o755)
    chmodSync(join(sb.paths.stateDir, 'pins'), 0o777)
    chmodSync(tokenFile(sb.paths, 'gabriel'), 0o640)
    const before = readFileSync(tokenFile(sb.paths, 'gabriel'), 'utf8')
    const r = await runDoctor(ctxAt(sb), { fix: true })
    expect(mode(sb.paths.stateDir)).toBe(0o700)
    expect(mode(join(sb.paths.stateDir, 'pins'))).toBe(0o700)
    expect(mode(tokenFile(sb.paths, 'gabriel'))).toBe(0o600)
    expect(readFileSync(tokenFile(sb.paths, 'gabriel'), 'utf8')).toBe(before)
    expect(r.exit).toBe(EXIT.OK)
  })

  test('com a config inválida ainda corrige permissões, e continua exit 2', async () => {
    const sb = healthy()
    writeFileSync(sb.paths.configFile, '{ ruim')
    chmodSync(tokenFile(sb.paths, 'admin1'), 0o644)
    const r = await runDoctor(ctxAt(sb), { fix: true })
    expect(mode(tokenFile(sb.paths, 'admin1'))).toBe(0o600)
    expect(r.exit).toBe(EXIT.INVALID_CONFIG)
  })

  test('sessão VIVA sem settings: nunca é tocada; vai para runtime.pending (adopt), uma vez só, e o erro continua (exit 1)', async () => {
    const sb = healthy()
    addSession(sb, ID, ['--allowed-tools', 'Read'], 'free')
    const before = snapshotState(sb, ID)

    const r = await runDoctor(ctxAt(sb), { fix: true })

    expect(snapshotState(sb, ID)).toEqual(before)
    expect(stops(sb)).toEqual([])
    expect(filesUnder(join(sb.paths.stateDir, 'backup'))).toEqual([])
    expect(readRuntime(sb.paths).pending).toEqual([{ jobId: ID, settings: muxLink(sb.paths, 'bk'), reason: 'adopt', requestedAt: NOW }])
    expect(r.exit).toBe(EXIT.CHECK_FAILED)
    expect(r.findings.map((f) => `${f.code}:${f.subject}`)).toEqual([`session.no-settings:${ID}`])
    expect(r.findings[0]!.message).toContain('fila')
    expect(r.fixes.map((f) => `${f.ok}:${f.code}`)).toEqual(['true:session.no-settings'])

    // rodar de novo não duplica nem reescreve o runtime
    const rt = readFileSync(runtimeFile(sb.paths), 'utf8')
    await runDoctor(ctxAt(sb, { now: () => NOW + 5_000 }), { fix: true })
    expect(readFileSync(runtimeFile(sb.paths), 'utf8')).toBe(rt)

    // o watch aplica: livre → para e reescreve com o link do mux da pasta
    expect(applyPending(ctxAt(sb), await loadConfig(sb.paths)).map((o) => o.result)).toEqual(['stopped-and-rewritten'])
    expect(stops(sb)).toEqual([['stop', ID]])
    expect(flagsNow(sb)).toEqual(['--allowed-tools', 'Read', '--settings', muxLink(sb.paths, 'bk')])
    expect(readRuntime(sb.paths).pending).toEqual([])
  })

  test('sessão ocupada sem settings: também só entra na fila', async () => {
    const sb = healthy()
    addSession(sb, ID, [], 'busy')
    await runDoctor(ctxAt(sb), { fix: true })
    expect(stops(sb)).toEqual([])
    expect(readRuntime(sb.paths).pending.map((i) => i.reason)).toEqual(['adopt'])
  })

  test('sessão parada que ganha pid entre o diagnóstico e a gravação: não reescreve, vai para a fila', async () => {
    const sb = healthy()
    addSession(sb, ID, [], 'stopped')
    const before = snapshotState(sb, ID)
    const base = ctxAt(sb)
    let seenAgents = 0
    // o `claude agents` devolve a sessão VIVA a partir da 2ª consulta (a da checagem imediatamente antes de gravar)
    const ctx = ctxAt(sb, {
      run: (cmd, args, opts) => {
        if (args[0] === 'agents' && ++seenAgents === 2) addSession(sb, ID, [], 'stopped', { pid: 4242, status: 'idle' })
        return base.run(cmd, args, opts)
      },
    })
    const fixes = await fix(ctx, await diagnose(ctxAt(sb)))
    expect(snapshotState(sb, ID)).toEqual(before)
    expect(readRuntime(sb.paths).pending.map((i) => i.reason)).toEqual(['adopt'])
    expect(fixes.some((f) => f.code === 'session.no-settings' && f.ok)).toBe(true)
  })

  test('destino quebrado e sem conserto: a sessão parada não é reescrita; o erro fica', async () => {
    const sb = healthy()
    writeFileSync(tokenFile(sb.paths, 'gabriel'), '{ quebrado', { mode: 0o600 }) // o link do mux aponta para um JSON inválido
    addSession(sb, ID, [], 'stopped')
    const before = snapshotState(sb, ID)
    const r = await runDoctor(ctxAt(sb), { fix: true })
    expect(snapshotState(sb, ID)).toEqual(before)
    expect(r.exit).toBe(EXIT.CHECK_FAILED)
    expect(r.fixes.find((f) => f.code === 'session.no-settings')!.ok).toBe(false)
    expect(r.findings.map((f) => f.code).sort()).toEqual(['link.broken', 'session.no-settings', 'token.invalid-json'])
  })

  test('legado, terceiros e state.json ilegível: --fix nunca reescreve', async () => {
    const sb = healthy()
    addSession(sb, ID, ['--settings', join(sb.paths.claudeDir, 'contas', 'ativa.json')], 'stopped')
    addSession(sb, ID2, ['--settings', '/tmp/terceiros.json'], 'stopped')
    addSession(sb, 'a1b2c3d6', [], 'stopped')
    writeFileSync(stateFile(sb, 'a1b2c3d6'), '{ "respawnFlags": [')
    const before = snapshotState(sb, ID, ID2, 'a1b2c3d6')
    const r = await runDoctor(ctxAt(sb), { fix: true })
    expect(snapshotState(sb, ID, ID2, 'a1b2c3d6')).toEqual(before)
    expect(filesUnder(join(sb.paths.stateDir, 'backup'))).toEqual([])
    expect(readRuntime(sb.paths).pending).toEqual([])
    expect(r.fixes).toEqual([])
    expect(r.exit).toBe(EXIT.OK) // só avisos
  })

  test('o que o --fix não conserta continua como erro: token inválido, view sem settings, sem token (exit 1)', async () => {
    const sb = healthy()
    writeFileSync(tokenFile(sb.paths, 'admin1'), '{ quebrado', { mode: 0o600 })
    rmSync(tokenFile(sb.paths, 'gabriel'))
    putPs(sb, '  101 claude agents')
    const bytes = readFileSync(tokenFile(sb.paths, 'admin1'), 'utf8')
    const r = await runDoctor(ctxAt(sb), { fix: true })
    expect(readFileSync(tokenFile(sb.paths, 'admin1'), 'utf8')).toBe(bytes)
    expect(r.exit).toBe(EXIT.CHECK_FAILED)
    expect(r.findings.map((f) => f.code).sort()).toEqual(['config.no-token', 'link.broken', 'token.invalid-json', 'view.no-settings'])
    expect(r.text).toContain('✗')
  })

  test('sem nada a consertar: não escreve nada (nem toca no runtime)', async () => {
    const sb = healthy()
    const snap = (): string[] => filesUnder(sb.paths.stateDir).sort().map((f) => `${f}\n${readFileSync(f, 'utf8')}`)
    const before = snap()
    const r = await runDoctor(ctxAt(sb), { fix: true })
    expect(snap()).toEqual(before)
    expect(r.fixes).toEqual([])
    expect(existsSync(runtimeFile(sb.paths))).toBe(false)
    expect(readdirSync(sb.paths.stateDir).includes('lock')).toBe(false) // o lock foi solto
  })

  test('--json com --fix: { findings, fixes } sem token', async () => {
    const sb = healthy()
    chmodSync(tokenFile(sb.paths, 'admin1'), 0o644)
    const r = await runDoctor(ctxAt(sb), { fix: true, json: true })
    expect(r.text).not.toMatch(/sk-ant-/)
    const out = JSON.parse(r.text) as { findings: Finding[]; fixes: Array<{ code: string; ok: boolean }> }
    expect(out.findings).toEqual([])
    expect(out.fixes.map((f) => `${f.ok}:${f.code}`)).toEqual(['true:token.perms'])
  })

  test('`fix` direto: só mexe no que os achados pedem', async () => {
    const sb = healthy()
    chmodSync(tokenFile(sb.paths, 'admin1'), 0o644)
    chmodSync(tokenFile(sb.paths, 'gabriel'), 0o644)
    const all = await diagnose(ctxAt(sb))
    await fix(ctxAt(sb), all.filter((f) => f.subject === 'admin1'))
    expect(mode(tokenFile(sb.paths, 'admin1'))).toBe(0o600)
    expect(mode(tokenFile(sb.paths, 'gabriel'))).toBe(0o644)
  })
})
