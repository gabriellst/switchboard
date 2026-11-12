import { afterAll, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { install as realInstall, installPreconditions } from '../src/commands/install.js'
import { runMigrate } from '../src/commands/migrate.js'
import { loadConfig } from '../src/core/config.js'
import type { Ctx } from '../src/core/ctx.js'
import { EXIT, SbError } from '../src/core/errors.js'
import { planInstall, runInstall } from '../src/core/install.js'
import { legacySource } from '../src/core/jobs.js'
import { applyMigration, finishMigration, planMigration, readLegacyToken, type MigrationPlan } from '../src/core/migrate.js'
import { muxLink, pinLink, tokenFile } from '../src/core/paths.js'
import { applyPending } from '../src/core/pin.js'
import { readRuntime, writeRuntime } from '../src/core/runtime.js'
import { pointMux } from '../src/core/links.js'
import { ensureState, saveToken } from '../src/core/tokens.js'
import { filesUnder, type AgentFixture, type Sandbox, sandbox } from './helpers.js'

const NOW = 1_800_000_000_000

// Tokens falsos montados por concatenação: nenhum literal `sk-ant-…` no código-fonte do teste.
const fakeToken = (c: string): string => 'sk-ant-' + 'oat01-' + c.repeat(40)
const TOKENS = { gabriel: fakeToken('g'), admin1: fakeToken('a'), outra: fakeToken('o') } as const
const TOKEN_ANY = /sk-ant-/

const ID_STOP_ATIVA = 'a1b2c3d1' // parada, ativa.json (forma absoluta, flags repetidos em volta)
const ID_LIVE_ATIVA = 'a1b2c3d2' // viva e livre, ativa.json (forma ~/…, subpasta do bk)
const ID_STOP_PIN = 'a1b2c3d3' // parada, contas-fixas/admin1.json (forma --settings=)
const ID_LIVE_PIN = 'a1b2c3d4' // viva e ocupada, contas-fixas/admin1.json
const ID_NONE = 'a1b2c3d5' // sem --settings: não é do claude-conta
const ID_OTHER = 'a1b2c3d6' // contas/outra.json direto: nem ativa nem fixa

// Processos de verdade só onde o `isAlive` real precisa de um pid; todos morrem no fim da suíte.
const children: Array<{ kill(): void }> = []
afterAll(() => {
  for (const c of children) c.kill()
})
function livePid(): number {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' })
  children.push(child)
  return child.pid!
}
function deadPid(): number {
  return spawnSync('true').pid!
}

const stateFor = (flags: string[], kind: 'free' | 'busy' | 'stopped'): Record<string, unknown> => ({
  respawnFlags: flags,
  cwd: '/tmp/proj',
  extra: { keep: 'me' },
  state: kind === 'busy' ? 'working' : 'done',
  inFlight: kind === 'busy' ? { tasks: 1, queued: 0, kinds: ['local_agent'] } : { tasks: 0, queued: 0, kinds: [] },
})

function addSession(sb: Sandbox, id: string, flags: string[], kind: 'free' | 'busy' | 'stopped', agent: Partial<AgentFixture> = {}): void {
  const live = kind !== 'stopped'
  sb.addJob({ agent: { id, ...(live && { pid: 4242, status: kind === 'busy' ? 'busy' : 'idle' }), ...agent }, state: stateFor(flags, kind) })
}

const homeOf = (sb: Sandbox): string => sb.env.HOME!
const contasOf = (sb: Sandbox): string => join(homeOf(sb), '.claude', 'contas')
const fixasOf = (sb: Sandbox): string => join(homeOf(sb), '.claude', 'contas-fixas')
const contaMd = (sb: Sandbox): string => join(homeOf(sb), '.claude', 'commands', 'conta.md')
const OLD_LINE = '[ -f ~/.claude/contas/wrapper.zsh ] && source ~/.claude/contas/wrapper.zsh  # claude-conta'
const CONTA_MD = '---\ndescription: Troca a conta Claude\n---\n!`claude-conta $ARGUMENTS 2>&1`\n'
const stateFile = (sb: Sandbox, id: string): string => join(sb.paths.jobsDir, id, 'state.json')
const flagsNow = (sb: Sandbox, id: string): string[] => (JSON.parse(readFileSync(stateFile(sb, id), 'utf8')) as { respawnFlags: string[] }).respawnFlags
const putPs = (sb: Sandbox, ...lines: string[]): void => {
  mkdirSync(sb.env.FAKE_CLAUDE_DIR!, { recursive: true })
  writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'ps.txt'), `${lines.join('\n')}\n`)
}
const VIEW_BK = (sb: Sandbox, pid = 111): string => `  ${pid} /Users/work/.local/bin/claude agents --cwd ${join(homeOf(sb), 'p', 'bk')}`
const VIGIA = (pid: number): string => `  ${pid} /usr/bin/python3 -I /Users/work/.local/bin/claude-conta _vigiar`

interface World {
  sb: Sandbox
  vigia: number
}

/** O legado FALSO inteiro, dentro do HOME do sandbox: contas, ativa, excluir, fixas, vigia, conta.md, zshrc, jobs e ps. */
function world(over: { tokens?: Partial<Record<keyof typeof TOKENS, string>>; noSessions?: boolean; noView?: boolean } = {}): World {
  const sb = sandbox()
  const home = homeOf(sb)
  const contas = contasOf(sb)
  const tokens = { ...TOKENS, ...over.tokens }
  mkdirSync(contas, { recursive: true })
  for (const [name, token] of Object.entries(tokens)) {
    writeFileSync(join(contas, `${name}.json`), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: token } }), { mode: 0o600 })
  }
  writeFileSync(join(contas, 'padrao.json'), '{}')
  symlinkSync('gabriel.json', join(contas, 'ativa.json'))
  writeFileSync(join(contas, 'excluir'), '# Raízes que ficam no login do keychain.\n\n~/p/berzerk\n')
  writeFileSync(join(contas, 'wrapper.zsh'), '# wrapper do claude-conta\n')
  const vigia = livePid()
  writeFileSync(join(contas, 'vigia.pid'), `${vigia}\n`)
  mkdirSync(fixasOf(sb), { recursive: true })
  symlinkSync(join(contas, 'admin1.json'), join(fixasOf(sb), 'admin1.json'))
  mkdirSync(dirname(contaMd(sb)), { recursive: true })
  writeFileSync(contaMd(sb), CONTA_MD)
  writeFileSync(join(home, '.zshrc'), `export A=1\n${OLD_LINE}\nalias x=y\n`)
  for (const d of ['bk', 'bk/sub', 'berzerk']) mkdirSync(join(home, 'p', d), { recursive: true })
  mkdirSync(join(home, 'Library', 'Caches'), { recursive: true }) // onde o bun do claude falso cria o cache; o resto de Library (LaunchAgents) o --simular não pode tocar
  if (!over.noSessions) {
    const ativa = join(contas, 'ativa.json')
    const bk = join(home, 'p', 'bk')
    addSession(sb, ID_STOP_ATIVA, ['--allowed-tools', 'Read', '--settings', ativa, '--allowed-tools', 'Bash'], 'stopped', { cwd: bk })
    addSession(sb, ID_LIVE_ATIVA, ['--settings', '~/.claude/contas/ativa.json'], 'free', { cwd: join(bk, 'sub') })
    addSession(sb, ID_STOP_PIN, [`--settings=${join(fixasOf(sb), 'admin1.json')}`], 'stopped', { cwd: bk })
    addSession(sb, ID_LIVE_PIN, ['--settings', join(fixasOf(sb), 'admin1.json')], 'busy', { cwd: bk })
    addSession(sb, ID_NONE, ['--allowed-tools', 'Read'], 'stopped', { cwd: bk })
    addSession(sb, ID_OTHER, ['--settings', join(contas, 'outra.json')], 'stopped', { cwd: bk })
  }
  putPs(sb, ...(over.noView ? [] : [VIEW_BK(sb)]), VIGIA(vigia))
  return { sb, vigia }
}

interface Rig {
  ctx: Ctx
  kills: string[]
  launchctl: string[][]
}

/** `ctx` do teste: `kill` e `launchctl` NUNCA são de verdade; `ps` e o `claude` falsos passam direto. */
function rig(sb: Sandbox, over: Partial<Ctx> = {}, killStatus = 0): Rig {
  const base = sb.ctx({ now: () => NOW, ...over })
  const kills: string[] = []
  const launchctl: string[][] = []
  const run: Ctx['run'] = (cmd, args, opts) => {
    if (cmd === 'kill') {
      kills.push(args.join(' '))
      return { status: killStatus, stdout: '', stderr: '' }
    }
    if (cmd === 'launchctl') {
      launchctl.push([cmd, ...args])
      return { status: 0, stdout: '', stderr: '' }
    }
    return base.run(cmd, args, opts)
  }
  return { ctx: { ...base, run }, kills, launchctl }
}

const installFor =
  (sb: Sandbox) =>
  (c: Ctx) =>
    runInstall(c, planInstall(c.paths, { runtimeBin: '/usr/local/bin/bun', cliPath: join(sb.dir, 'cli.js'), claudeDir: dirname(sb.env.SWITCHBOARD_CLAUDE!) }), { simular: false, uid: 501, sleep: () => undefined })

async function migrate(w: World, over: Partial<Ctx> = {}): Promise<{ r: Rig; plan: MigrationPlan; res: Awaited<ReturnType<typeof applyMigration>> }> {
  const r = rig(w.sb, over)
  const plan = await planMigration(r.ctx)
  const res = await applyMigration(r.ctx, plan, { install: installFor(w.sb) })
  return { r, plan, res }
}

/** Retrato do disco sob `root`: diretórios (com modo), links (com alvo) e arquivos (com modo e conteúdo). */
function snapshot(root: string, skip: (path: string) => boolean = () => false): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = join(d, e.name)
      if (skip(f)) continue
      const st = lstatSync(f)
      if (st.isSymbolicLink()) out.push(`L ${f} -> ${readlinkSync(f)}`)
      else if (st.isDirectory()) {
        out.push(`D ${f} ${(st.mode & 0o777).toString(8)}`)
        walk(f)
      } else out.push(`F ${f} ${(st.mode & 0o777).toString(8)} ${readFileSync(f, 'utf8')}`)
    }
  }
  walk(root)
  return out
}
// o claude falso é um script bun: rodá-lo com HOME no sandbox cria o cache do bun em home/Library (ruído do teste, não do sb)
const skipFakeClaude = (path: string): boolean => path.includes('/fake-claude') || path.includes('/home/Library/Caches/bun')

/** Arquivos do sandbox que contêm algo parecido com token, fora do que PODE tê-lo: `tokens/` e as cópias de `contas*`. */
function leaks(sb: Sandbox): string[] {
  const allowed = (f: string): boolean => /\/tokens\//.test(f) || /\/contas(-fixas)?\//.test(f)
  const all: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) walk(f)
      else all.push(f)
    }
  }
  walk(sb.dir)
  return all.filter((f) => !allowed(f) && TOKEN_ANY.test(readFileSync(f, 'utf8')))
}

const mode = (p: string): number => statSync(p).mode & 0o777
const catching = async (fn: () => Promise<unknown>): Promise<SbError> => {
  try {
    await fn()
  } catch (e) {
    if (e instanceof SbError) return e
    throw e
  }
  throw new Error('esperava um SbError')
}

// ------------------------------------------------------------------------------------------------------- plano

describe('readLegacyToken', () => {
  test('lê só o token; arquivo ausente, sem token ou lixo → null (e o erro nunca carrega o conteúdo)', () => {
    const { sb } = world()
    expect(readLegacyToken(sb.paths, 'gabriel')).toBe(TOKENS.gabriel)
    expect(readLegacyToken(sb.paths, 'nao-existe')).toBeNull()
    expect(readLegacyToken(sb.paths, 'padrao')).toBeNull() // {} = keychain
    writeFileSync(join(contasOf(sb), 'lixo.json'), `{ "env": ${TOKENS.outra} lixo`)
    expect(readLegacyToken(sb.paths, 'lixo')).toBeNull()
    writeFileSync(join(contasOf(sb), 'vazio.json'), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: '' } }))
    expect(readLegacyToken(sb.paths, 'vazio')).toBeNull()
  })

  test('nome com caminho (../, /) não escapa de contas/', () => {
    const { sb } = world()
    writeFileSync(join(homeOf(sb), 'fora.json'), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKENS.outra } }))
    expect(readLegacyToken(sb.paths, '../../fora')).toBeNull()
    expect(readLegacyToken(sb.paths, 'a/b')).toBeNull()
  })
})

describe('legacySource (de onde vem o --settings legado)', () => {
  const { paths } = sandbox()
  const contas = join(paths.claudeDir, 'contas')
  const fixas = join(paths.claudeDir, 'contas-fixas')
  test('as quatro formas de escrever o caminho; vale o último dos NOSSOS', () => {
    expect(legacySource(['--settings', join(contas, 'ativa.json')], paths)).toEqual({ dir: 'contas', name: 'ativa' })
    expect(legacySource([`--settings=${join(fixas, 'admin1.json')}`], paths)).toEqual({ dir: 'contas-fixas', name: 'admin1' })
    expect(legacySource(['--settings', '~/.claude/contas/ativa.json'], paths)).toEqual({ dir: 'contas', name: 'ativa' })
    expect(legacySource(['--settings', join(fixas, 'a.json'), '--settings', '/tmp/terceiros.json'], paths)).toEqual({ dir: 'contas-fixas', name: 'a' })
    expect(legacySource(['--settings', join(fixas, 'a.json'), '--settings', join(paths.stateDir, 'mux', 'bk.json')], paths)).toBeNull() // o último nosso é do sb
  })
  test('não é legado, ou o nome do arquivo não vale → null', () => {
    expect(legacySource([], paths)).toBeNull()
    expect(legacySource(['--settings', '/tmp/x.json'], paths)).toBeNull()
    expect(legacySource(['--settings', join(fixas, 'Nome Ruim.json')], paths)).toBeNull()
    expect(legacySource(['--settings', join(contas, 'ativa.txt')], paths)).toBeNull()
  })
})

describe('planMigration', () => {
  test('--simular não altera nenhum arquivo (retrato de tudo antes = depois), nem pela CLI', async () => {
    const w = world()
    const before = snapshot(w.sb.dir, skipFakeClaude)
    const plan = await planMigration(rig(w.sb).ctx)
    expect(plan.rewrites.length).toBeGreaterThan(0)
    expect(snapshot(w.sb.dir, skipFakeClaude)).toEqual(before)
    expect(existsSync(w.sb.paths.stateDir)).toBe(false) // nem o diretório de estado nasce
    expect(existsSync(w.sb.paths.configFile)).toBe(false)

    const cli = w.sb.runSb(['migrate', '--simular', '--json'])
    expect(cli.code).toBe(0)
    expect(JSON.parse(cli.stdout).plan.config.mux.bk.account).toBe('gabriel')
    expect(cli.stdout + cli.stderr).not.toMatch(TOKEN_ANY)
    expect(snapshot(w.sb.dir, skipFakeClaude)).toEqual(before)
  })

  test('muxes bk e berzerk como no §10; pool da ativa primeiro; default = 1º mux de view', async () => {
    const w = world()
    const { config } = await planMigration(rig(w.sb).ctx)
    expect(config.mux.bk).toEqual({ root: '~/p/bk', account: 'gabriel', accounts: ['admin1', 'gabriel', 'outra'], pool: ['gabriel', 'admin1', 'outra'] })
    expect(config.mux.berzerk).toEqual({ root: '~/p/berzerk', account: 'keychain', accounts: ['keychain'], pool: [] })
    expect(Object.keys(config.mux).sort()).toEqual(['berzerk', 'bk'])
    expect(Object.keys(config.accounts).sort()).toEqual(['admin1', 'gabriel', 'outra'])
    expect(config.default).toBe('bk')
  })

  test('tokens: tudo menos ativa e padrao; só origem e nome, nunca o valor; duplicata pelo mesmo token', async () => {
    const w = world({ tokens: { outra: TOKENS.admin1 } })
    const plan = await planMigration(rig(w.sb).ctx)
    expect(plan.tokens).toEqual([
      { from: join(contasOf(w.sb), 'admin1.json'), account: 'admin1' },
      { from: join(contasOf(w.sb), 'gabriel.json'), account: 'gabriel' },
      { from: join(contasOf(w.sb), 'outra.json'), account: 'outra' },
    ])
    expect(plan.likelyDuplicates).toEqual([['admin1', 'outra']])
    expect(JSON.stringify(plan)).not.toMatch(TOKEN_ANY)
  })

  test('rewrites: ativa → link do mux pela pasta, fixa → pins/<conta>; paradas now, vivas when-free; o resto fica de fora', async () => {
    const w = world()
    const plan = await planMigration(rig(w.sb).ctx)
    const ativa = join(contasOf(w.sb), 'ativa.json')
    const fixa = join(fixasOf(w.sb), 'admin1.json')
    expect(plan.rewrites).toEqual([
      { jobId: ID_STOP_ATIVA, from: ativa, to: muxLink(w.sb.paths, 'bk'), when: 'now' },
      { jobId: ID_LIVE_ATIVA, from: ativa, to: muxLink(w.sb.paths, 'bk'), when: 'when-free' },
      { jobId: ID_STOP_PIN, from: fixa, to: pinLink(w.sb.paths, 'admin1'), when: 'now' },
      { jobId: ID_LIVE_PIN, from: fixa, to: pinLink(w.sb.paths, 'admin1'), when: 'when-free' },
    ])
    // contas/outra.json direto não é ativa nem fixa: não se adivinha o destino; avisa e a sessão segue legada
    expect(plan.warnings.some((x) => x.includes(ID_OTHER))).toBe(true)
  })

  test('stopVigia: pid vivo E comando com _vigiar; pid vivo de outro programa, morto ou fora do ps → null', async () => {
    const w = world()
    expect((await planMigration(rig(w.sb).ctx)).stopVigia).toBe(w.vigia)

    putPs(w.sb, VIEW_BK(w.sb), `  ${w.vigia} /usr/bin/vim notas.txt`) // pid reaproveitado por outro programa
    expect((await planMigration(rig(w.sb).ctx)).stopVigia).toBeNull()

    putPs(w.sb, VIEW_BK(w.sb)) // vivo mas fora da tabela do ps
    expect((await planMigration(rig(w.sb).ctx)).stopVigia).toBeNull()

    const dead = deadPid()
    writeFileSync(join(contasOf(w.sb), 'vigia.pid'), `${dead}\n`)
    putPs(w.sb, VIEW_BK(w.sb), VIGIA(dead)) // o ps (falso) diz _vigiar, mas o processo não existe
    expect((await planMigration(rig(w.sb).ctx)).stopVigia).toBeNull()

    rmSync(join(contasOf(w.sb), 'vigia.pid'))
    expect((await planMigration(rig(w.sb).ctx)).stopVigia).toBeNull()
  })

  test('zshrc, comando, backup e reabertura', async () => {
    const w = world()
    const plan = await planMigration(rig(w.sb).ctx)
    const line = runInstall(rig(w.sb).ctx, planInstall(w.sb.paths, { runtimeBin: '/usr/local/bin/bun', cliPath: join(w.sb.dir, 'cli.js'), claudeDir: dirname(w.sb.env.SWITCHBOARD_CLAUDE!) }), { simular: true })
    expect(plan.zshrc).toEqual({ remove: OLD_LINE, add: line.zshrc.line }) // exatamente a linha que o install escreveria
    expect(plan.command).toEqual({ remove: contaMd(w.sb), add: join(homeOf(w.sb), '.claude', 'commands', 'sb.md') })
    expect(plan.backup.startsWith(join(w.sb.paths.stateDir, 'backup') + '/')).toBe(true)
    expect(plan.reopen).toEqual(['sb agents bk'])
  })

  test('a linha literal do ps do usuário vira um mux pelo basename da pasta', async () => {
    const w = world()
    const dir = join(homeOf(w.sb), 'Desktop', 'Projetos', 'bk-company')
    mkdirSync(dir, { recursive: true })
    putPs(w.sb, `  222 /Users/work/.local/bin/claude agents --cwd ${dir}`)
    const plan = await planMigration(rig(w.sb).ctx)
    expect(plan.config.mux['bk-company']).toEqual({
      root: '~/Desktop/Projetos/bk-company',
      account: 'gabriel',
      accounts: ['admin1', 'gabriel', 'outra'],
      pool: ['gabriel', 'admin1', 'outra'],
    })
    expect(plan.config.default).toBe('bk-company')
    expect(plan.reopen).toEqual(['sb agents bk-company'])
  })

  test('view com --cwd=, duas views na mesma pasta e a listagem --json do watch (não é view)', async () => {
    const w = world()
    const home = homeOf(w.sb)
    putPs(
      w.sb,
      `  1 claude agents --cwd=${join(home, 'p', 'bk')}`,
      `  2 claude agents --cwd ${join(home, 'p', 'bk')}/`,
      `  3 claude agents --json --all --cwd ${join(home, 'p', 'x')}`,
      `  4 claude agents --cwd ${join(home, 'p', 'bk')}`,
    )
    const plan = await planMigration(rig(w.sb).ctx)
    expect(Object.keys(plan.config.mux).sort()).toEqual(['berzerk', 'bk'])
    expect(plan.reopen).toEqual(['sb agents bk'])
  })

  describe('nomes de mux', () => {
    test('basename inválido é normalizado; vazio cai num nome de reserva; o plano segue válido', async () => {
      const w = world()
      const home = homeOf(w.sb)
      for (const d of ['Meu_Projeto.V2', '日本', 'x'.repeat(40)]) mkdirSync(join(home, d), { recursive: true })
      putPs(w.sb, `  1 claude agents --cwd ${join(home, 'Meu_Projeto.V2')}`, `  2 claude agents --cwd ${join(home, '日本')}`, `  3 claude agents --cwd ${join(home, 'x'.repeat(40))}`)
      const plan = await planMigration(rig(w.sb).ctx)
      expect(Object.keys(plan.config.mux).sort()).toEqual(['berzerk', 'meu_projeto-v2', 'mux-1', 'x'.repeat(32)])
      expect(plan.config.default).toBe('meu_projeto-v2')
      expect(plan.warnings.length).toBeGreaterThan(0)
    })

    test('mesmo basename em pastas diferentes: a primeira em ordem de caminho fica com o nome, a outra ganha -2', async () => {
      const w = world()
      const home = homeOf(w.sb)
      for (const d of ['a/app', 'b/app']) mkdirSync(join(home, d), { recursive: true })
      putPs(w.sb, `  1 claude agents --cwd ${join(home, 'b', 'app')}`, `  2 claude agents --cwd ${join(home, 'a', 'app')}`)
      const plan = await planMigration(rig(w.sb).ctx)
      expect(plan.config.mux.app!.root).toBe('~/a/app')
      expect(plan.config.mux['app-2']!.root).toBe('~/b/app')
      expect(plan.reopen.sort()).toEqual(['sb agents app', 'sb agents app-2'])
    })

    test('o nome do mux do keychain (excluir) vence uma view de mesmo basename', async () => {
      const w = world()
      const home = homeOf(w.sb)
      mkdirSync(join(home, 'outro', 'berzerk'), { recursive: true })
      putPs(w.sb, `  1 claude agents --cwd ${join(home, 'outro', 'berzerk')}`, VIEW_BK(w.sb))
      const plan = await planMigration(rig(w.sb).ctx)
      expect(plan.config.mux.berzerk!.account).toBe('keychain')
      expect(plan.config.mux['berzerk-2']).toMatchObject({ root: '~/outro/berzerk', account: 'gabriel' })
    })

    test('view dentro de uma raiz do excluir NÃO ganha mux (o berzerk não pode ser arrastado); a raiz repetida também não duplica', async () => {
      const w = world()
      const home = homeOf(w.sb)
      writeFileSync(join(contasOf(w.sb), 'excluir'), `~/p/berzerk\n${join(home, 'p', 'berzerk')}/\n`)
      mkdirSync(join(home, 'p', 'berzerk', 'sub'), { recursive: true })
      putPs(w.sb, VIEW_BK(w.sb), `  1 claude agents --cwd ${join(home, 'p', 'berzerk', 'sub')}`, `  2 claude agents --cwd ${join(home, 'p', 'berzerk')}`)
      const plan = await planMigration(rig(w.sb).ctx)
      expect(Object.keys(plan.config.mux).sort()).toEqual(['berzerk', 'bk'])
      expect(plan.warnings.some((x) => x.includes('berzerk'))).toBe(true)
      // a view continua precisando ser reaberta, e com o mux do keychain
      expect(plan.reopen.sort()).toEqual(['sb agents berzerk', 'sb agents berzerk --cwd ~/p/berzerk/sub', 'sb agents bk'])
    })
  })

  describe('recusas e casos de borda', () => {
    test('sem ~/.claude/contas → exit 3', async () => {
      const sb = sandbox()
      const e = await catching(() => planMigration(rig(sb).ctx))
      expect(e.exit).toBe(EXIT.USAGE)
      expect(e.message).toContain('nada a migrar')
    })

    test('sem nenhuma view aberta o default não existe: recusa (nunca o mux do keychain como default)', async () => {
      const w = world({ noView: true })
      const e = await catching(() => planMigration(rig(w.sb).ctx))
      expect(e.exit).toBe(EXIT.USAGE)
      expect(e.message).toContain('view')
    })

    test('view cujo --cwd não é uma pasta que existe (ex.: caminho com espaço truncado pelo ps) é pulada com aviso: nunca vira raiz de mux nem default', async () => {
      const w = world()
      const home = homeOf(w.sb)
      mkdirSync(join(home, 'Meu'), { recursive: true }) // o ps corta "Meu Projeto" em "Meu"… e aqui a pasta cortada existiria; a view de verdade é outra
      putPs(w.sb, VIEW_BK(w.sb), `  7 claude agents --cwd ${join(home, 'nao', 'existe')}`, `  8 claude agents --cwd ${join(home, 'p', 'bk', 'arquivo.txt')}`)
      writeFileSync(join(home, 'p', 'bk', 'arquivo.txt'), 'x') // existe, mas não é pasta
      const plan = await planMigration(rig(w.sb).ctx)
      expect(Object.keys(plan.config.mux).sort()).toEqual(['berzerk', 'bk'])
      expect(plan.warnings.filter((x) => x.includes('pid 7') || x.includes('pid 8')).length).toBe(2)
      expect(plan.reopen).toEqual(['sb agents bk'])

      // só a inexistente: não há de onde tirar o default
      putPs(w.sb, `  7 claude agents --cwd ${join(home, 'nao', 'existe')}`)
      const e = await catching(() => planMigration(rig(w.sb).ctx))
      expect(e.exit).toBe(EXIT.USAGE)
    })

    test('só views dentro do keychain: a recusa diz a verdade (há view, mas nenhuma serve de default) e aponta `sb mux set --default`', async () => {
      const w = world()
      putPs(w.sb, `  1 claude agents --cwd ${join(homeOf(w.sb), 'p', 'berzerk')}`)
      const e = await catching(() => planMigration(rig(w.sb).ctx))
      expect(e.exit).toBe(EXIT.USAGE)
      expect(e.message).not.toContain('não achei nenhuma view')
      expect(e.message).toContain('dentro de raízes do keychain')
      expect(`${e.message}\n${e.detail ?? ''}`).toContain('--default')
    })

    test('ativa.json → padrao.json: view no keychain, sem pool', async () => {
      const w = world()
      rmSync(join(contasOf(w.sb), 'ativa.json'))
      symlinkSync('padrao.json', join(contasOf(w.sb), 'ativa.json'))
      const plan = await planMigration(rig(w.sb).ctx)
      expect(plan.config.mux.bk).toEqual({ root: '~/p/bk', account: 'keychain', accounts: ['keychain', 'admin1', 'gabriel', 'outra'], pool: [] })
    })

    test('ativa.json ausente ou pendurado: a 1ª conta em ordem alfabética, com aviso', async () => {
      const w = world()
      rmSync(join(contasOf(w.sb), 'ativa.json'))
      let plan = await planMigration(rig(w.sb).ctx)
      expect(plan.config.mux.bk!.account).toBe('admin1')
      expect(plan.config.mux.bk!.pool).toEqual(['admin1', 'gabriel', 'outra'])
      expect(plan.warnings.some((x) => x.includes('ativa'))).toBe(true)
      symlinkSync('nao-existe.json', join(contasOf(w.sb), 'ativa.json'))
      plan = await planMigration(rig(w.sb).ctx)
      expect(plan.config.mux.bk!.account).toBe('admin1')
    })

    test('conta com nome inválido, chamada keychain, sem token ou com JSON quebrado é pulada com aviso (sem o conteúdo)', async () => {
      const w = world()
      const contas = contasOf(w.sb)
      writeFileSync(join(contas, 'Maiuscula.json'), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: fakeToken('m') } }))
      writeFileSync(join(contas, 'keychain.json'), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: fakeToken('k') } }))
      writeFileSync(join(contas, 'vazia.json'), '{}')
      writeFileSync(join(contas, 'quebrada.json'), `{ "env": { "CLAUDE_CODE_OAUTH_TOKEN": "${fakeToken('q')}"`)
      const plan = await planMigration(rig(w.sb).ctx)
      expect(plan.tokens.map((t) => t.account)).toEqual(['admin1', 'gabriel', 'outra'])
      for (const n of ['Maiuscula', 'keychain', 'vazia', 'quebrada']) expect(plan.warnings.some((x) => x.includes(n))).toBe(true)
      expect(JSON.stringify(plan)).not.toMatch(TOKEN_ANY)
    })

    test('nenhuma conta importável: o plano segue, com tudo no keychain', async () => {
      const w = world()
      for (const n of ['gabriel', 'admin1', 'outra']) rmSync(join(contasOf(w.sb), `${n}.json`))
      const plan = await planMigration(rig(w.sb).ctx)
      expect(plan.tokens).toEqual([])
      expect(plan.config.accounts).toEqual({})
      expect(plan.config.mux.bk).toEqual({ root: '~/p/bk', account: 'keychain', accounts: ['keychain'], pool: [] })
      expect(plan.warnings.some((x) => x.includes('nenhuma conta'))).toBe(true)
    })

    test('o claude falhando (agents) → exit 4, nada a decidir às cegas', async () => {
      const w = world()
      writeFileSync(join(w.sb.env.FAKE_CLAUDE_DIR!, 'agents.json'), 'isto não é json')
      const e = await catching(() => planMigration(rig(w.sb).ctx))
      expect(e.exit).toBe(EXIT.CLAUDE)
    })
  })

  describe('config do sb que já existe', () => {
    const existing = (w: World, text: string): void => {
      mkdirSync(dirname(w.sb.paths.configFile), { recursive: true })
      writeFileSync(w.sb.paths.configFile, text)
    }

    test('config inválida → exit 2 (nunca sobrescrita)', async () => {
      const w = world()
      existing(w, '{ "switchboard": ')
      const e = await catching(() => planMigration(rig(w.sb).ctx))
      expect(e.exit).toBe(EXIT.INVALID_CONFIG)
    })

    test('mescla: o que o usuário já tem (mux, default, swap) fica; só entra o que falta', async () => {
      const w = world()
      existing(
        w,
        JSON.stringify({
          switchboard: 1,
          accounts: { gabriel: {}, solo: {} },
          swap: { auto: false },
          default: 'pessoal',
          mux: { pessoal: { root: '~/pessoal', account: 'solo', accounts: ['solo'], pool: [] }, bk: { root: '~/outro-bk', account: 'solo', accounts: ['solo'], pool: [] } },
        }),
      )
      const plan = await planMigration(rig(w.sb).ctx)
      expect(plan.config.default).toBe('pessoal')
      expect(plan.config.swap.auto).toBe(false)
      expect(plan.config.mux.pessoal!.account).toBe('solo')
      expect(plan.config.mux.bk!.root).toBe('~/outro-bk') // o bk do usuário não é tocado…
      expect(plan.config.mux['bk-2']).toMatchObject({ root: '~/p/bk', account: 'gabriel' }) // …e o da view ganha outro nome
      expect(Object.keys(plan.config.accounts).sort()).toEqual(['admin1', 'gabriel', 'outra', 'solo'])
    })

    test('mux existente com a mesma raiz cobre a view: nada duplicado', async () => {
      const w = world()
      existing(w, JSON.stringify({ switchboard: 1, accounts: { gabriel: {} }, default: 'trabalho', mux: { trabalho: { root: '~/p/bk', account: 'gabriel', accounts: ['gabriel'], pool: [] } } }))
      const plan = await planMigration(rig(w.sb).ctx)
      expect(Object.keys(plan.config.mux).sort()).toEqual(['berzerk', 'trabalho'])
      expect(plan.reopen).toEqual(['sb agents trabalho'])
    })

    test('conta já registrada com token DIFERENTE do legado: o do sb vale e o plano avisa', async () => {
      const w = world()
      existing(w, JSON.stringify({ switchboard: 1, accounts: { gabriel: {} }, default: 'x', mux: { x: { root: '~/x', account: 'gabriel', accounts: ['gabriel'], pool: [] } } }))
      w.sb.addToken('gabriel', fakeToken('z'))
      const plan = await planMigration(rig(w.sb).ctx)
      expect(plan.tokens.map((t) => t.account)).toEqual(['admin1', 'outra'])
      expect(plan.warnings.some((x) => x.includes('gabriel'))).toBe(true)
    })
  })
})

// ------------------------------------------------------------------------------------------------------ aplicar

describe('applyMigration', () => {
  test('sem `claude` no PATH o `sb install` não teria como rodar: recusa (exit 4) ANTES de qualquer escrita (zshrc, conta.md, tokens, backup)', async () => {
    const w = world()
    const plan = await planMigration(rig(w.sb).ctx)
    const semClaude = join(w.sb.dir, 'path-vazio')
    mkdirSync(semClaude, { recursive: true })
    const env = { ...w.sb.env, PATH: semClaude }
    delete (env as Record<string, string | undefined>).SWITCHBOARD_CLAUDE
    const r = rig(w.sb, { env, now: () => NOW })
    const before = snapshot(w.sb.dir, skipFakeClaude)
    // as dependências de verdade do comando: o `install` real, com as precondições dele
    const e = await catching(() => applyMigration(r.ctx, plan, { install: (c) => realInstall(c, { simular: false }), check: installPreconditions }))
    expect(e.exit).toBe(EXIT.CLAUDE)
    expect(e.message).toContain('claude')
    expect(snapshot(w.sb.dir, skipFakeClaude)).toEqual(before)
    expect(readFileSync(join(homeOf(w.sb), '.zshrc'), 'utf8')).toContain(OLD_LINE) // novos terminais continuam com o wrapper do claude-conta
    expect(existsSync(contaMd(w.sb))).toBe(true)
    expect(r.launchctl).toEqual([])
    expect(readRuntime(w.sb.paths).pending).toEqual([])
  })

  test('as precondições passam com o `claude` achável: a migração segue normalmente', async () => {
    const w = world()
    const r = rig(w.sb)
    const plan = await planMigration(r.ctx)
    const res = await applyMigration(r.ctx, plan, { install: installFor(w.sb), check: installPreconditions })
    expect(res.zshrc).toBe('replaced')
  })

  test('tokens 600 em tokens/ (700), config, links; keychain = {}', async () => {
    const w = world()
    const { res } = await migrate(w)
    const p = w.sb.paths
    for (const a of ['gabriel', 'admin1', 'outra']) {
      expect(mode(tokenFile(p, a))).toBe(0o600)
      expect(JSON.parse(readFileSync(tokenFile(p, a), 'utf8'))).toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKENS[a as keyof typeof TOKENS] } })
    }
    expect(mode(join(p.stateDir, 'tokens'))).toBe(0o700)
    expect(mode(p.stateDir)).toBe(0o700)
    expect(readFileSync(tokenFile(p, 'keychain'), 'utf8')).toBe('{}')
    expect(existsSync(tokenFile(p, 'padrao'))).toBe(false)
    expect(existsSync(tokenFile(p, 'ativa'))).toBe(false)

    const cfg = await loadConfig(p)
    expect(cfg.default).toBe('bk')
    expect(cfg.mux.bk!.pool).toEqual(['gabriel', 'admin1', 'outra'])
    expect(readlinkSync(muxLink(p, 'bk'))).toBe(tokenFile(p, 'gabriel'))
    expect(readlinkSync(muxLink(p, 'berzerk'))).toBe(tokenFile(p, 'keychain'))
    expect(res.tokens).toEqual(['admin1', 'gabriel', 'outra'])
    expect(res.muxes.sort()).toEqual(['berzerk', 'bk'])
  })

  test('paradas reescritas (resto dos flags intacto), viva na fila como migrate, pin → pins/admin1.json', async () => {
    const w = world()
    const { res } = await migrate(w)
    const p = w.sb.paths
    expect(flagsNow(w.sb, ID_STOP_ATIVA)).toEqual(['--allowed-tools', 'Read', '--allowed-tools', 'Bash', '--settings', muxLink(p, 'bk')])
    expect(flagsNow(w.sb, ID_STOP_PIN)).toEqual(['--settings', pinLink(p, 'admin1')])
    expect(readlinkSync(pinLink(p, 'admin1'))).toBe(tokenFile(p, 'admin1'))
    // vivas: intocadas, na fila
    expect(flagsNow(w.sb, ID_LIVE_ATIVA)).toEqual(['--settings', '~/.claude/contas/ativa.json'])
    expect(flagsNow(w.sb, ID_LIVE_PIN)).toEqual(['--settings', join(fixasOf(w.sb), 'admin1.json')])
    expect(readRuntime(p).pending).toEqual([
      { jobId: ID_LIVE_ATIVA, settings: muxLink(p, 'bk'), reason: 'migrate', requestedAt: NOW },
      { jobId: ID_LIVE_PIN, settings: pinLink(p, 'admin1'), reason: 'migrate', requestedAt: NOW },
    ])
    // nenhuma sessão foi parada
    expect(w.sb.calls().filter((c) => c.argv[0] === 'stop')).toEqual([])
    // sem --settings e a "contas/outra.json" direta ficam como estavam
    expect(flagsNow(w.sb, ID_NONE)).toEqual(['--allowed-tools', 'Read'])
    expect(flagsNow(w.sb, ID_OTHER)).toEqual(['--settings', join(contasOf(w.sb), 'outra.json')])
    expect(res.rewrites).toEqual([
      { jobId: ID_STOP_ATIVA, result: 'rewritten' },
      { jobId: ID_LIVE_ATIVA, result: 'queued' },
      { jobId: ID_STOP_PIN, result: 'rewritten' },
      { jobId: ID_LIVE_PIN, result: 'queued' },
    ])
  })

  test('vigia morto (kill só do pid certo), zshrc trocado com backup, conta.md no backup e sb.md gravado; o install vê a linha como present', async () => {
    const w = world()
    const { r, plan, res } = await migrate(w)
    expect(r.kills).toEqual([String(w.vigia)])
    expect(res.vigia).toBe('stopped')

    const zshrc = readFileSync(join(homeOf(w.sb), '.zshrc'), 'utf8')
    expect(zshrc).toBe(`export A=1\n${plan.zshrc!.add}\nalias x=y\n`)
    expect(zshrc).not.toContain('claude-conta')
    expect(readFileSync(join(plan.backup, 'zshrc'), 'utf8')).toBe(`export A=1\n${OLD_LINE}\nalias x=y\n`)
    expect(res.install.zshrc.status).toBe('present') // não acrescentou uma 2ª linha
    expect(zshrc.split('\n').filter((l) => l.endsWith('# switchboard')).length).toBe(1)

    expect(existsSync(contaMd(w.sb))).toBe(false)
    expect(readFileSync(join(plan.backup, 'conta.md'), 'utf8')).toBe(CONTA_MD)
    const sbMd = readFileSync(join(homeOf(w.sb), '.claude', 'commands', 'sb.md'), 'utf8')
    expect(sbMd).toContain('Bash(sb:*)')
    expect(r.launchctl.map((c) => c[1])).toEqual(['bootout', 'bootstrap'])
  })

  test('o vigia só morre se o pid ainda for do _vigiar na hora de matar (o plano pode estar velho)', async () => {
    const w = world()
    const r = rig(w.sb)
    const plan = await planMigration(r.ctx)
    expect(plan.stopVigia).toBe(w.vigia)
    putPs(w.sb, VIEW_BK(w.sb), `  ${w.vigia} /usr/bin/vim notas.txt`) // reaproveitado entre o plano e o aplicar
    const res = await applyMigration(r.ctx, plan, { install: installFor(w.sb) })
    expect(r.kills).toEqual([])
    expect(res.vigia).toBe('none')
  })

  test('kill que falha: o resto da migração segue, o resultado diz que o vigia NÃO parou', async () => {
    const w = world()
    const r = rig(w.sb, {}, 1)
    const plan = await planMigration(r.ctx)
    const res = await applyMigration(r.ctx, plan, { install: installFor(w.sb) })
    expect(res.vigia).toBe('failed')
    expect(res.warnings.some((x) => x.includes(String(w.vigia)))).toBe(true)
    expect(res.zshrc).toBe('replaced')
  })

  test('zshrc que já tem a linha do sb: a do claude-conta só sai; sem zshrc, o install acrescenta a do sb', async () => {
    const w = world()
    const line = runInstall(rig(w.sb).ctx, planInstall(w.sb.paths, { runtimeBin: '/usr/local/bin/bun', cliPath: join(w.sb.dir, 'cli.js'), claudeDir: dirname(w.sb.env.SWITCHBOARD_CLAUDE!) }), { simular: true }).zshrc.line
    writeFileSync(join(homeOf(w.sb), '.zshrc'), `a=1\n${line}\n${OLD_LINE}\nb=2\n`)
    await migrate(w)
    expect(readFileSync(join(homeOf(w.sb), '.zshrc'), 'utf8')).toBe(`a=1\n${line}\nb=2\n`)

    const w2 = world()
    rmSync(join(homeOf(w2.sb), '.zshrc'))
    const { plan, res } = await migrate(w2)
    expect(plan.zshrc).toBeNull()
    expect(res.zshrc).toBe('unchanged')
    expect(res.install.zshrc.status).toBe('appended')
  })

  test('sem vigia no plano, nada é morto', async () => {
    const w = world()
    rmSync(join(contasOf(w.sb), 'vigia.pid'))
    const { r, res } = await migrate(w)
    expect(r.kills).toEqual([])
    expect(res.vigia).toBe('none')
  })

  test('conta.md que é um link: o link vai para o backup como link e sai; o ALVO fica com o mesmo modo e conteúdo', async () => {
    const w = world()
    const target = join(homeOf(w.sb), 'dotfiles-conta.md')
    writeFileSync(target, CONTA_MD, { mode: 0o644 })
    rmSync(contaMd(w.sb))
    symlinkSync(target, contaMd(w.sb))
    const { plan, res } = await migrate(w)
    expect(res.command).toBe('moved')
    expect(lstatSync(contaMd(w.sb), { throwIfNoEntry: false })).toBeUndefined()
    expect(readFileSync(target, 'utf8')).toBe(CONTA_MD)
    expect(mode(target)).toBe(0o644)
    expect(lstatSync(join(plan.backup, 'conta.md')).isSymbolicLink()).toBe(true)
  })

  test('nada do claude-conta é apagado: contas/ e contas-fixas/ idênticos, e há cópia no backup (700/600, links preservados)', async () => {
    const w = world()
    const legacyBefore = snapshot(join(homeOf(w.sb), '.claude', 'contas')).concat(snapshot(fixasOf(w.sb)))
    const { plan } = await migrate(w)
    expect(snapshot(join(homeOf(w.sb), '.claude', 'contas')).concat(snapshot(fixasOf(w.sb)))).toEqual(legacyBefore)

    const copy = join(plan.backup, 'contas')
    expect(mode(plan.backup)).toBe(0o700)
    expect(mode(copy)).toBe(0o700)
    expect(mode(join(plan.backup, 'contas-fixas'))).toBe(0o700)
    for (const name of ['gabriel.json', 'admin1.json', 'outra.json', 'padrao.json', 'excluir', 'wrapper.zsh']) {
      expect(mode(join(copy, name))).toBe(0o600)
      expect(readFileSync(join(copy, name), 'utf8')).toBe(readFileSync(join(contasOf(w.sb), name), 'utf8'))
    }
    expect(readlinkSync(join(copy, 'ativa.json'))).toBe('gabriel.json') // symlink continua symlink
    // o link absoluto das fixas aponta para a CÓPIA, para o backup se bastar depois do --finish
    expect(readlinkSync(join(plan.backup, 'contas-fixas', 'admin1.json'))).toBe(join(copy, 'admin1.json'))
  })

  test('saída, log e todo arquivo fora de tokens/ e das cópias de contas* sem token', async () => {
    const w = world()
    const { res } = await migrate(w)
    expect(JSON.stringify(res)).not.toMatch(TOKEN_ANY)
    expect(leaks(w.sb)).toEqual([])
    // e o log do sb existe e também está limpo (a varredura acima o inclui)
    const files = filesUnder(w.sb.paths.stateDir).filter((f) => !f.includes('/tokens/'))
    expect(files.length).toBeGreaterThan(3)
  })

  test('mesma impressão numa medição = provável duplicata (measureAll), também sem token', async () => {
    const w = world()
    const hdr: Record<string, string> = {
      'anthropic-ratelimit-unified-5h-utilization': '0.25',
      'anthropic-ratelimit-unified-5h-reset': '1800005000',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.5',
      'anthropic-ratelimit-unified-7d-reset': '1800500000',
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-reset': '1800005000',
    }
    const { res } = await migrate(w, { fetch: async () => ({ status: 200, headers: { get: (n: string) => hdr[n.toLowerCase()] ?? null } }) })
    expect(res.likelyDuplicates).toEqual([['admin1', 'gabriel', 'outra']])
    expect(leaks(w.sb)).toEqual([])
  })

  test('a medição falhar não derruba a migração', async () => {
    const w = world()
    const { res } = await migrate(w) // fetch padrão do sandbox: rede desligada
    expect(res.likelyDuplicates).toEqual([])
    expect(res.install.launchd.status).toBe('loaded')
  })

  test('config inválida → recusa ANTES de qualquer escrita (legado, zshrc e estado intactos)', async () => {
    const w = world()
    const r = rig(w.sb)
    const plan = await planMigration(r.ctx)
    mkdirSync(dirname(w.sb.paths.configFile), { recursive: true })
    writeFileSync(w.sb.paths.configFile, '{ "switchboard": ')
    const skip = (f: string): boolean => skipFakeClaude(f) || f.startsWith(w.sb.paths.stateDir) // o lock cria o diretório de estado; o resto não
    const before = snapshot(w.sb.dir, skip)
    const e = await catching(() => applyMigration(r.ctx, plan, { install: installFor(w.sb) }))
    expect(e.exit).toBe(EXIT.INVALID_CONFIG)
    expect(snapshot(w.sb.dir, skip)).toEqual(before)
    expect(existsSync(join(w.sb.paths.stateDir, 'tokens'))).toBe(false)
    expect(r.kills).toEqual([])
  })

  test('falha no 1º passo (backup) não toca em nada do legado nem cria config', async () => {
    const w = world()
    const r = rig(w.sb)
    const plan = await planMigration(r.ctx)
    mkdirSync(w.sb.paths.stateDir, { recursive: true })
    writeFileSync(join(w.sb.paths.stateDir, 'backup'), 'um arquivo onde devia haver um diretório')
    const before = snapshot(homeOf(w.sb))
    await expect(applyMigration(r.ctx, plan, { install: installFor(w.sb) })).rejects.toThrow()
    expect(snapshot(homeOf(w.sb))).toEqual(before)
    expect(existsSync(w.sb.paths.configFile)).toBe(false)
    expect(existsSync(join(w.sb.paths.stateDir, 'tokens'))).toBe(false)
    expect(r.kills).toEqual([])
    expect(readFileSync(join(homeOf(w.sb), '.zshrc'), 'utf8')).toContain('# claude-conta')
  })

  test('falha no meio (install) deixa o legado inteiro e usável; rodar de novo termina o serviço sem duplicar nada', async () => {
    const w = world()
    const r = rig(w.sb)
    const plan = await planMigration(r.ctx)
    const legacy = snapshot(join(homeOf(w.sb), '.claude', 'contas')).concat(snapshot(fixasOf(w.sb)))
    const boom = (): never => {
      throw new SbError('launchctl indisponível', EXIT.CLAUDE)
    }
    const e = await catching(() => applyMigration(r.ctx, plan, { install: boom }))
    expect(e.message).toContain('sb install') // diz o que fazer
    expect(snapshot(join(homeOf(w.sb), '.claude', 'contas')).concat(snapshot(fixasOf(w.sb)))).toEqual(legacy)
    // a ativa continua apontando para uma conta com token legível
    expect(JSON.parse(readFileSync(join(contasOf(w.sb), 'ativa.json'), 'utf8')).env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKENS.gabriel)

    const again = await migrate(w)
    expect(again.res.install.zshrc.status).toBe('present')
    const zshrc = readFileSync(join(homeOf(w.sb), '.zshrc'), 'utf8')
    expect(zshrc.split('\n').filter((l) => l.endsWith('# switchboard')).length).toBe(1)
    expect(zshrc).not.toContain('claude-conta')
    expect(readRuntime(w.sb.paths).pending.length).toBe(2) // sem pedidos repetidos
  })

  test('rodar de novo depois de completo é seguro: config, links, tokens, sessões e fila iguais', async () => {
    const w = world()
    await migrate(w)
    const p = w.sb.paths
    // o usuário trocou o link do mux depois (swap): a migração não pode desfazer
    rmSync(muxLink(p, 'bk'))
    symlinkSync(tokenFile(p, 'outra'), muxLink(p, 'bk'))
    const keep = (): string[] => snapshot(p.stateDir, (f) => f.includes('/backup/') || f.includes('/log/') || f.endsWith('/usage.json') || f.endsWith('/lock'))
    const config = readFileSync(p.configFile, 'utf8')
    const before = keep()
    const jobs = snapshot(p.jobsDir)

    const second = await migrate(w)
    expect(readFileSync(p.configFile, 'utf8')).toBe(config)
    expect(keep()).toEqual(before)
    expect(snapshot(p.jobsDir)).toEqual(jobs)
    expect(second.plan.tokens).toEqual([])
    expect(second.res.muxes).toEqual([])
    expect(second.res.tokens).toEqual([])
    expect(readlinkSync(muxLink(p, 'bk'))).toBe(tokenFile(p, 'outra'))
  })

  test('config existente com conteúdo não é sobrescrita: texto, comentário e swap ficam; só entra o que falta', async () => {
    const w = world()
    mkdirSync(dirname(w.sb.paths.configFile), { recursive: true })
    const text = `// minha config\n{\n  "switchboard": 1,\n  "accounts": { "gabriel": {} },\n  "swap": { "auto": false },\n  "default": "pessoal",\n  "mux": { "pessoal": { "root": "~/pessoal", "account": "gabriel", "accounts": ["gabriel"], "pool": [] } }\n}\n`
    writeFileSync(w.sb.paths.configFile, text)
    w.sb.addToken('gabriel', TOKENS.gabriel)
    await migrate(w)
    const after = readFileSync(w.sb.paths.configFile, 'utf8')
    expect(after.startsWith('// minha config')).toBe(true)
    const cfg = await loadConfig(w.sb.paths)
    expect(cfg.swap.auto).toBe(false)
    expect(cfg.default).toBe('pessoal')
    expect(Object.keys(cfg.mux).sort()).toEqual(['berzerk', 'bk', 'pessoal'])
    expect(Object.keys(cfg.accounts).sort()).toEqual(['admin1', 'gabriel', 'outra'])
  })

  test('link de mux apagado por uma execução parcial é refeito; um link vivo (swap) não é tocado', async () => {
    const w = world()
    await migrate(w)
    const p = w.sb.paths
    rmSync(muxLink(p, 'berzerk'))
    await migrate(w)
    expect(readlinkSync(muxLink(p, 'berzerk'))).toBe(tokenFile(p, 'keychain'))
  })

  test('sessão que sumiu entre o plano e o aplicar → gone, sem derrubar o resto', async () => {
    const w = world()
    const r = rig(w.sb)
    const plan = await planMigration(r.ctx)
    const agents = join(w.sb.env.FAKE_CLAUDE_DIR!, 'agents.json')
    const list = (JSON.parse(readFileSync(agents, 'utf8')) as Array<{ id: string }>).filter((a) => a.id !== ID_STOP_ATIVA)
    writeFileSync(agents, JSON.stringify(list))
    const res = await applyMigration(r.ctx, plan, { install: installFor(w.sb) })
    expect(res.rewrites.find((x) => x.jobId === ID_STOP_ATIVA)?.result).toBe('gone')
    expect(flagsNow(w.sb, ID_STOP_PIN)).toEqual(['--settings', pinLink(w.sb.paths, 'admin1')])
  })

  test('pin de conta que o mux da pasta não permite não é reescrito (accounts é limite duro): fica legado, com aviso', async () => {
    const w = world()
    // a sessão fixa está na pasta do berzerk (accounts = [keychain]): admin1 ali seria arrastar o berzerk
    addSession(w.sb, ID_STOP_PIN, [`--settings=${join(fixasOf(w.sb), 'admin1.json')}`], 'stopped', { cwd: join(homeOf(w.sb), 'p', 'berzerk') })
    const { plan, res } = await migrate(w)
    expect(plan.rewrites.map((x) => x.jobId)).not.toContain(ID_STOP_PIN)
    expect(plan.warnings.some((x) => x.includes(ID_STOP_PIN))).toBe(true)
    expect(res.rewrites.map((x) => x.jobId)).not.toContain(ID_STOP_PIN)
    expect(flagsNow(w.sb, ID_STOP_PIN)).toEqual([`--settings=${join(fixasOf(w.sb), 'admin1.json')}`])
  })
})

// ------------------------------------------------------------------------------------ fila (applyPending)

describe('applyPending com itens migrate', () => {
  async function applied(): Promise<{ w: World; r: Rig }> {
    const w = world()
    await migrate(w)
    return { w, r: rig(w.sb) }
  }

  test('viva e livre: o watch para e reescreve para o link do mux; a ocupada espera; livre depois, vai para pins/admin1', async () => {
    const { w, r } = await applied()
    const p = w.sb.paths
    const cfg = await loadConfig(p)
    const out = applyPending(r.ctx, cfg)
    expect(out).toEqual([
      { jobId: ID_LIVE_ATIVA, settings: muxLink(p, 'bk'), result: 'stopped-and-rewritten' },
      { jobId: ID_LIVE_PIN, settings: pinLink(p, 'admin1'), result: 'queued' },
    ])
    expect(w.sb.calls().filter((c) => c.argv[0] === 'stop').map((c) => c.argv)).toEqual([['stop', ID_LIVE_ATIVA]])
    expect(flagsNow(w.sb, ID_LIVE_ATIVA)).toEqual(['--settings', muxLink(p, 'bk')])
    expect(flagsNow(w.sb, ID_LIVE_PIN)).toEqual(['--settings', join(fixasOf(w.sb), 'admin1.json')]) // ocupada: intocada
    expect(readRuntime(p).pending.map((i) => i.jobId)).toEqual([ID_LIVE_PIN])

    addSession(w.sb, ID_LIVE_PIN, ['--settings', join(fixasOf(w.sb), 'admin1.json')], 'free', { cwd: join(homeOf(w.sb), 'p', 'bk') })
    expect(applyPending(r.ctx, cfg)).toEqual([{ jobId: ID_LIVE_PIN, settings: pinLink(p, 'admin1'), result: 'stopped-and-rewritten' }])
    expect(flagsNow(w.sb, ID_LIVE_PIN)).toEqual(['--settings', pinLink(p, 'admin1')])
    expect(readRuntime(p).pending).toEqual([])
    expect(applyPending(r.ctx, cfg)).toEqual([]) // idempotente
  })

  test('sessão parada no meio-tempo é reescrita sem `claude stop`', async () => {
    const { w, r } = await applied()
    addSession(w.sb, ID_LIVE_ATIVA, ['--settings', '~/.claude/contas/ativa.json'], 'stopped', { cwd: join(homeOf(w.sb), 'p', 'bk', 'sub') })
    const out = applyPending(r.ctx, await loadConfig(w.sb.paths))
    expect(out.find((o) => o.jobId === ID_LIVE_ATIVA)).toMatchObject({ result: 'rewritten' })
    expect(w.sb.calls().filter((c) => c.argv[0] === 'stop')).toEqual([])
  })

  test('o destino é recalculado: item com settings adulterado, de outro mux ou fora dos nossos links sai da fila sem tocar na sessão', async () => {
    const { w, r } = await applied()
    const p = w.sb.paths
    const cfg = await loadConfig(p)
    const item = (jobId: string, settings: string) => ({ jobId, settings, reason: 'migrate' as const, requestedAt: NOW })
    const rt = readRuntime(p)
    rt.pending = [
      item(ID_LIVE_ATIVA, pinLink(p, 'admin1')), // a sessão é da ativa: o destino certo é o mux
      item(ID_LIVE_PIN, '/tmp/evil.json'), // não é um link nosso
      item('a1b2c3d9', muxLink(p, 'bk')), // sessão inexistente
    ]
    writeRuntime(p, rt)
    const before = [ID_LIVE_ATIVA, ID_LIVE_PIN].map((i) => readFileSync(stateFile(w.sb, i), 'utf8'))
    const out = applyPending(r.ctx, cfg)
    expect(out.map((o) => `${o.jobId}:${o.result}`).sort()).toEqual([`${ID_LIVE_ATIVA}:gone`, `${ID_LIVE_PIN}:gone`, 'a1b2c3d9:gone'].sort())
    expect([ID_LIVE_ATIVA, ID_LIVE_PIN].map((i) => readFileSync(stateFile(w.sb, i), 'utf8'))).toEqual(before)
    expect(w.sb.calls().filter((c) => c.argv[0] === 'stop')).toEqual([])
    expect(readRuntime(p).pending).toEqual([])
  })

  test('pin de conta que o mux da pasta não permite é descartado, não aplicado', async () => {
    const { w, r } = await applied()
    const p = w.sb.paths
    // a sessão fixa agora vive na pasta do berzerk (accounts = [keychain])
    addSession(w.sb, ID_LIVE_PIN, ['--settings', join(fixasOf(w.sb), 'admin1.json')], 'free', { cwd: join(homeOf(w.sb), 'p', 'berzerk') })
    const out = applyPending(r.ctx, await loadConfig(p))
    expect(out.find((o) => o.jobId === ID_LIVE_PIN)).toEqual({ jobId: ID_LIVE_PIN, result: 'gone' })
    expect(flagsNow(w.sb, ID_LIVE_PIN)).toEqual(['--settings', join(fixasOf(w.sb), 'admin1.json')])
  })

  test('sessão que já foi migrada à mão (mux/pin) sai da fila sem mexer', async () => {
    const { w, r } = await applied()
    const p = w.sb.paths
    addSession(w.sb, ID_LIVE_ATIVA, ['--settings', muxLink(p, 'bk')], 'free', { cwd: join(homeOf(w.sb), 'p', 'bk', 'sub') })
    const out = applyPending(r.ctx, await loadConfig(p))
    expect(out.map((o) => o.jobId)).not.toContain(ID_LIVE_ATIVA)
    expect(readRuntime(p).pending.map((i) => i.jobId)).toEqual([ID_LIVE_PIN])
    expect(w.sb.calls().filter((c) => c.argv[0] === 'stop')).toEqual([])
  })

  test('a sessão que chamou nunca é parada: continua na fila', async () => {
    const { w } = await applied()
    const caller = rig(w.sb, { env: { ...w.sb.env, CLAUDE_JOB_DIR: join(w.sb.paths.jobsDir, ID_LIVE_ATIVA) } })
    const out = applyPending(caller.ctx, await loadConfig(w.sb.paths))
    expect(out.find((o) => o.jobId === ID_LIVE_ATIVA)?.result).toBe('queued')
    expect(w.sb.calls().filter((c) => c.argv[0] === 'stop')).toEqual([])
  })
})

// ------------------------------------------------------------------------------------------------- finish

describe('finishMigration', () => {
  test('recusa (exit 1, lista os ids) enquanto houver sessão legacy; nada é movido', async () => {
    const w = world()
    const r = rig(w.sb)
    const before = snapshot(join(homeOf(w.sb), '.claude', 'contas'))
    const e = await catching(() => finishMigration(r.ctx))
    expect(e.exit).toBe(EXIT.CHECK_FAILED)
    const text = `${e.message}\n${e.detail ?? ''}`
    for (const id of [ID_STOP_ATIVA, ID_LIVE_ATIVA, ID_STOP_PIN, ID_LIVE_PIN, ID_OTHER]) expect(text).toContain(id)
    expect(text).not.toContain(ID_NONE)
    expect(snapshot(join(homeOf(w.sb), '.claude', 'contas'))).toEqual(before)
    expect(existsSync(fixasOf(w.sb))).toBe(true)
  })

  test('recusa se a migração nunca foi aplicada: zshrc ainda com a linha do claude-conta, sem config do sb, sem tokens importados (tudo listado, nada movido)', async () => {
    const w = world({ noSessions: true }) // nenhuma sessão legacy: só os outros portões
    const before = snapshot(join(homeOf(w.sb), '.claude', 'contas')).concat(snapshot(fixasOf(w.sb)))
    const e = await catching(() => finishMigration(rig(w.sb).ctx))
    expect(e.exit).toBe(EXIT.CHECK_FAILED)
    const text = `${e.message}\n${e.detail ?? ''}`
    expect(text).toContain('.zshrc')
    expect(text).toContain('config')
    expect(text).toContain('tokens')
    expect(snapshot(join(homeOf(w.sb), '.claude', 'contas')).concat(snapshot(fixasOf(w.sb)))).toEqual(before)
    expect(existsSync(contasOf(w.sb))).toBe(true)
  })

  test('zshrc já trocado mas sem config/tokens do sb (migração pela metade) também recusa; só com a linha do claude-conta a recusa é só dela', async () => {
    const w = world({ noSessions: true })
    writeFileSync(join(homeOf(w.sb), '.zshrc'), 'export A=1\n')
    let e = await catching(() => finishMigration(rig(w.sb).ctx))
    expect(`${e.message}\n${e.detail ?? ''}`).not.toContain('.zshrc')
    expect(`${e.message}\n${e.detail ?? ''}`).toContain('config')
    await migrate(w)
    writeFileSync(join(homeOf(w.sb), '.zshrc'), `export A=1\n${OLD_LINE}\n`) // o usuário recolocou a linha antiga
    e = await catching(() => finishMigration(rig(w.sb).ctx))
    expect(`${e.message}\n${e.detail ?? ''}`).toContain('.zshrc')
    expect(existsSync(contasOf(w.sb))).toBe(true)
  })

  test('recusa com item migrate na fila, mesmo sem sessão legacy; nunca lê só a lista de sessões', async () => {
    const w = world({ noSessions: true })
    const p = w.sb.paths
    mkdirSync(p.stateDir, { recursive: true })
    const rt = readRuntime(p)
    rt.pending = [{ jobId: 'a1b2c3d1', settings: muxLink(p, 'bk'), reason: 'migrate', requestedAt: NOW }]
    writeRuntime(p, rt)
    const e = await catching(() => finishMigration(rig(w.sb).ctx))
    expect(e.exit).toBe(EXIT.CHECK_FAILED)
    expect(`${e.message}\n${e.detail ?? ''}`).toContain('a1b2c3d1')
    expect(existsSync(contasOf(w.sb))).toBe(true)
  })

  test('recusa se o ps falha: sem tabela de processos não dá para dizer que não há view legada', async () => {
    const w = world({ noSessions: true })
    await migrate(w)
    const r = rig(w.sb, { env: { ...w.sb.env, SWITCHBOARD_PS: '/usr/bin/false' } })
    const e = await catching(() => finishMigration(r.ctx))
    expect(e.exit).toBe(EXIT.CHECK_FAILED)
    expect(`${e.message}\n${e.detail ?? ''}`).toContain('ps')
    expect(existsSync(contasOf(w.sb))).toBe(true)
    // com o ps de volta passa
    expect((await finishMigration(rig(w.sb).ctx, { simular: true })).moved.length).toBe(2)
  })

  test('recusa com view do claude agents ainda no settings do claude-conta', async () => {
    const w = world({ noSessions: true })
    putPs(w.sb, `  333 claude agents --cwd /x --settings ${join(contasOf(w.sb), 'ativa.json')}`)
    const e = await catching(() => finishMigration(rig(w.sb).ctx))
    expect(e.exit).toBe(EXIT.CHECK_FAILED)
    expect(`${e.message}\n${e.detail ?? ''}`).toContain('333')
  })

  test('recusa com sessão de state.json ilegível (não dá para provar que não é legacy)', async () => {
    const w = world({ noSessions: true })
    addSession(w.sb, 'a1b2c3d7', [], 'stopped')
    writeFileSync(stateFile(w.sb, 'a1b2c3d7'), '{ "respawnFlags": [')
    const e = await catching(() => finishMigration(rig(w.sb).ctx))
    expect(e.exit).toBe(EXIT.CHECK_FAILED)
    expect(`${e.message}\n${e.detail ?? ''}`).toContain('a1b2c3d7')
  })

  test('sessão SEM state.json (parada, nunca teve flags) não bloqueia o --finish', async () => {
    const w = world({ noSessions: true })
    await migrate(w) // o --finish exige a migração aplicada (zshrc trocado, config e tokens do sb)
    addSession(w.sb, 'a1b2c3d8', [], 'stopped') // grava o state.json…
    rmSync(stateFile(w.sb, 'a1b2c3d8')) // …e some com ele
    const out = await finishMigration(rig(w.sb).ctx, { simular: true })
    expect(out.moved.length).toBe(2)
  })

  test('depois das reescritas move contas/ e contas-fixas/ para o backup (sem apagar), com --simular não move', async () => {
    const w = world()
    await migrate(w)
    const r = rig(w.sb)
    // o watch aplica a fila
    addSession(w.sb, ID_LIVE_PIN, ['--settings', join(fixasOf(w.sb), 'admin1.json')], 'free', { cwd: join(homeOf(w.sb), 'p', 'bk') })
    const cfg = await loadConfig(w.sb.paths)
    applyPending(r.ctx, cfg)
    // a sessão que apontava para contas/outra.json direto ainda é legacy: o usuário a reabre/troca à mão
    addSession(w.sb, ID_OTHER, ['--settings', muxLink(w.sb.paths, 'bk')], 'stopped', { cwd: join(homeOf(w.sb), 'p', 'bk') })
    putPs(w.sb, VIEW_BK(w.sb))

    const contasBefore = snapshot(contasOf(w.sb))
    const fixasBefore = snapshot(fixasOf(w.sb))
    const dry = await finishMigration(r.ctx, { simular: true })
    expect(dry.moved.length).toBe(2)
    expect(existsSync(contasOf(w.sb))).toBe(true)

    const done = await finishMigration(r.ctx)
    expect(done.moved.length).toBe(2)
    expect(existsSync(contasOf(w.sb))).toBe(false)
    expect(existsSync(fixasOf(w.sb))).toBe(false)
    expect(snapshot(join(done.to!, 'contas'))).toEqual(contasBefore.map((l) => l.replace(contasOf(w.sb), join(done.to!, 'contas'))))
    expect(snapshot(join(done.to!, 'contas-fixas'))).toEqual(fixasBefore.map((l) => l.replace(fixasOf(w.sb), join(done.to!, 'contas-fixas'))))
    expect(mode(done.to!)).toBe(0o700)

    // as sessões continuam abrindo: o --settings delas é do sb
    expect(existsSync(muxLink(w.sb.paths, 'bk'))).toBe(true)
    // de novo: nada a mover, sem erro
    expect((await finishMigration(r.ctx)).moved).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------- comando

describe('runMigrate (comando)', () => {
  test('--simular --json: o plano, sem token, nada gravado', async () => {
    const w = world()
    const before = snapshot(w.sb.dir, skipFakeClaude)
    const out = await runMigrate(rig(w.sb).ctx, { simular: true, json: true }, { install: installFor(w.sb) })
    expect(out.exit).toBe(0)
    const body = JSON.parse(out.text)
    expect(body.plan.tokens.length).toBe(3)
    expect(out.text).not.toMatch(TOKEN_ANY)
    expect(snapshot(w.sb.dir, skipFakeClaude)).toEqual(before)
  })

  test('--simular em texto: mostra muxes, sessões, vigia, zshrc, backup e a reabertura', async () => {
    const w = world()
    const out = await runMigrate(rig(w.sb).ctx, { simular: true }, { install: installFor(w.sb) })
    expect(out.text).toContain('Simulação')
    for (const s of ['bk', 'berzerk', ID_LIVE_ATIVA, String(w.vigia), 'claude-conta', 'sb agents bk']) expect(out.text).toContain(s)
    expect(out.text).not.toMatch(TOKEN_ANY)
  })

  test('aplicar imprime o resultado e os comandos para reabrir cada aba; --json também sem token', async () => {
    const w = world()
    const out = await runMigrate(rig(w.sb).ctx, {}, { install: installFor(w.sb) })
    expect(out.exit).toBe(0)
    expect(out.text).toContain('sb agents bk')
    expect(out.text).toContain(w.sb.paths.stateDir)
    expect(out.text).not.toMatch(TOKEN_ANY)

    const w2 = world()
    const json = await runMigrate(rig(w2.sb).ctx, { json: true }, { install: installFor(w2.sb) })
    expect(JSON.parse(json.text).result.muxes.sort()).toEqual(['berzerk', 'bk'])
    expect(json.text).not.toMatch(TOKEN_ANY)
  })

  test('--simular diz com todas as letras que o watch PARA cada sessão viva quando estiver livre, e quantas são', async () => {
    const w = world() // duas vivas (uma livre, uma ocupada) e quatro paradas
    const out = await runMigrate(rig(w.sb).ctx, { simular: true }, { install: installFor(w.sb) })
    expect(out.text).toContain('2 sessões vivas serão PARADAS pelo watch')
    expect(out.text).toContain('quando estiverem livres')
    expect(out.text).toContain('reabra')
    expect(out.text).toMatch(/meio de um turno|trabalho agendado/)
    expect(out.text).toContain('nunca é interrompida')
    expect(out.text).not.toContain('reescreve quando estiver livre') // a redação antiga escondia a parada
    expect(out.text).not.toMatch(TOKEN_ANY)
  })

  test('aplicar repete o aviso e a contagem (sessões vivas na fila)', async () => {
    const w = world()
    const out = await runMigrate(rig(w.sb).ctx, {}, { install: installFor(w.sb) })
    expect(out.text).toContain('2 sessões vivas serão PARADAS pelo watch')
    expect(out.text).toContain('quando estiverem livres')
    expect(out.text).toContain('nunca é interrompida')
    expect(out.text).not.toContain('o watch reescreve quando')
    expect(readRuntime(w.sb.paths).pending.filter((i) => i.reason === 'migrate').length).toBe(2)
  })

  test('uma sessão viva só: singular; nenhuma viva: nenhum aviso de parada', async () => {
    const one = world({ noSessions: true })
    addSession(one.sb, ID_LIVE_ATIVA, ['--settings', '~/.claude/contas/ativa.json'], 'free', { cwd: join(homeOf(one.sb), 'p', 'bk') })
    const plan1 = await runMigrate(rig(one.sb).ctx, { simular: true }, { install: installFor(one.sb) })
    expect(plan1.text).toContain('1 sessão viva será PARADA pelo watch quando estiver livre')
    const none = world({ noSessions: true })
    const plan0 = await runMigrate(rig(none.sb).ctx, { simular: true }, { install: installFor(none.sb) })
    expect(plan0.text).not.toContain('PARADA')
    const res0 = await runMigrate(rig(none.sb).ctx, {}, { install: installFor(none.sb) })
    expect(res0.text).not.toContain('PARADA')
  })

  test('--finish com sessão legacy → SbError exit 1', async () => {
    const w = world()
    const e = await catching(() => runMigrate(rig(w.sb).ctx, { finish: true }, { install: installFor(w.sb) }))
    expect(e.exit).toBe(EXIT.CHECK_FAILED)
  })
})

describe('sb migrate --manter-config (o usuário já montou contas e muxes no sb)', () => {
  const OWN = `{
  // a config que o usuário montou à mão
  "switchboard": 1,
  "accounts": { "nova": {} },
  "default": "tudo",
  "mux": { "tudo": { "root": "~/p", "account": "nova", "accounts": ["nova"], "pool": ["nova"] } }
}
`
  /** Legado falso + a config PRÓPRIA do sb (uma conta `nova`, um mux `tudo` em ~/p que é o default). */
  function ownWorld(over: Parameters<typeof world>[0] = {}): World {
    const w = world(over)
    ensureState(w.sb.paths)
    saveToken(w.sb.paths, 'nova', fakeToken('n'))
    mkdirSync(dirname(w.sb.paths.configFile), { recursive: true })
    writeFileSync(w.sb.paths.configFile, OWN)
    pointMux(w.sb.paths, 'tudo', 'nova')
    return w
  }

  test('plano: nenhuma conta importada, nenhum mux criado (nem o do keychain do excluir); sessões vão para o mux que já existe', async () => {
    const w = ownWorld()
    const plan = await planMigration(rig(w.sb).ctx, { keepConfig: true })
    expect(plan.tokens).toEqual([])
    expect(Object.keys(plan.config.mux)).toEqual(['tudo'])
    expect(Object.keys(plan.config.accounts)).toEqual(['nova'])
    expect(plan.config.default).toBe('tudo')
    const to = Object.fromEntries(plan.rewrites.map((r) => [r.jobId, r.to]))
    expect(to[ID_STOP_ATIVA]).toBe(muxLink(w.sb.paths, 'tudo'))
    expect(to[ID_LIVE_ATIVA]).toBe(muxLink(w.sb.paths, 'tudo'))
    // fixas numa conta que o sb não tem: não dá para reapontar; ficam avisadas (e travam o --finish)
    expect(to[ID_STOP_PIN]).toBeUndefined()
    expect(plan.warnings.join('\n')).toContain(ID_STOP_PIN)
  })

  test('aplicar: tokens/ só tem o que o usuário já tinha, a config fica byte a byte, a parada é reescrita e o zshrc trocado', async () => {
    const w = ownWorld()
    const r = rig(w.sb)
    const plan = await planMigration(r.ctx, { keepConfig: true })
    await applyMigration(r.ctx, plan, { install: installFor(w.sb) })
    expect(readdirSync(join(w.sb.paths.stateDir, 'tokens')).sort()).toEqual(['keychain.json', 'nova.json'])
    expect(readFileSync(w.sb.paths.configFile, 'utf8')).toBe(OWN)
    expect(flagsNow(w.sb, ID_STOP_ATIVA)).toContain(muxLink(w.sb.paths, 'tudo'))
    expect(flagsNow(w.sb, ID_STOP_ATIVA).join(' ')).not.toContain('contas/ativa.json')
    expect(readRuntime(w.sb.paths).pending.map((i) => i.jobId)).toContain(ID_LIVE_ATIVA)
    const zshrc = readFileSync(join(homeOf(w.sb), '.zshrc'), 'utf8')
    expect(zshrc).not.toContain('# claude-conta')
    expect(zshrc).toContain('# switchboard')
    expect(leaks(w.sb)).toEqual([])
  })

  test('sem config do sb → exit 3 (não há o que manter)', async () => {
    const w = world()
    const e = await catching(() => planMigration(rig(w.sb).ctx, { keepConfig: true }))
    expect(e?.exit).toBe(EXIT.USAGE)
  })

  test('pela CLI: `sb migrate --manter-config --simular` não importa conta e não grava nada', () => {
    const w = ownWorld()
    const before = snapshot(homeOf(w.sb), skipFakeClaude)
    const r = w.sb.runSb(['migrate', '--manter-config', '--simular'])
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain('gabriel        ←')
    expect(r.stdout).toContain('tudo')
    expect(r.stdout).not.toMatch(TOKEN_ANY)
    expect(snapshot(homeOf(w.sb), skipFakeClaude)).toEqual(before)
  })

  test('--finish depois: sem conta importada do claude-conta, mas com conta própria no sb, não é recusado por isso', async () => {
    const w = ownWorld({ noSessions: true })
    addSession(w.sb, ID_STOP_ATIVA, ['--settings', join(contasOf(w.sb), 'ativa.json')], 'stopped', { cwd: join(homeOf(w.sb), 'p', 'bk') })
    const r = rig(w.sb)
    await applyMigration(r.ctx, await planMigration(r.ctx, { keepConfig: true }), { install: installFor(w.sb) })
    const fin = await finishMigration(rig(w.sb).ctx)
    expect(existsSync(contasOf(w.sb))).toBe(false)
    expect(fin.moved.length).toBeGreaterThan(0)
  })
})
