import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { Ctx } from '../src/core/ctx.js'
import { SbError } from '../src/core/errors.js'
import { findClaudeDir, LAUNCH_LABEL, planInstall, plistFile, runInstall, slashCommandFile, wrapperFile } from '../src/core/install.js'
import { muxLink } from '../src/core/paths.js'
import { FAKE_TOKEN, filesUnder, populatedSandbox, sandbox, type Sandbox } from './helpers.js'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const FAKE_CLAUDE = join(import.meta.dir, 'fake-claude.ts')
const UID = process.getuid!()

const planFor = (sb: Sandbox, over: Partial<{ runtimeBin: string; cliPath: string; claudeDir: string }> = {}) =>
  planInstall(sb.paths, { runtimeBin: process.execPath, cliPath: CLI, claudeDir: join(sb.dir, 'claude-bin'), ...over })
const byFile = (plan: ReturnType<typeof planInstall>, file: string): { file: string; content: string; mode: number } => {
  const f = plan.find((p) => p.file === file)
  if (!f) throw new Error(`plano sem ${file}: ${plan.map((p) => p.file).join(', ')}`)
  return f
}

/** `ctx.run` falso: registra cada chamada; nenhum `launchctl` de verdade roda nos testes. */
function fakeRun(status: (cmd: string, args: string[]) => number = () => 0): { calls: string[][]; run: Ctx['run'] } {
  const calls: string[][] = []
  return {
    calls,
    run: (cmd, args) => {
      calls.push([cmd, ...args])
      const code = status(cmd, args)
      return { status: code, stdout: '', stderr: code === 0 ? '' : 'erro do launchctl' }
    },
  }
}

const plistAsJson = (file: string): Record<string, unknown> => {
  const r = spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`plutil recusou ${file}: ${r.stderr}`)
  return JSON.parse(r.stdout) as Record<string, unknown>
}

// ---------------------------------------------------------------------------------------------
// plano (puro) e LaunchAgent

test('plan: três arquivos, nos caminhos do sandbox, com os modos esperados', () => {
  const sb = sandbox()
  const plan = planFor(sb)
  expect(plan.map((p) => p.file)).toEqual([plistFile(sb.paths), wrapperFile(sb.paths), slashCommandFile(sb.paths)])
  expect(plistFile(sb.paths)).toBe(join(sb.paths.home, 'Library', 'LaunchAgents', `${LAUNCH_LABEL}.plist`))
  expect(wrapperFile(sb.paths)).toBe(join(sb.paths.stateDir, 'wrapper.zsh'))
  expect(slashCommandFile(sb.paths)).toBe(join(sb.paths.home, '.claude', 'commands', 'sb.md'))
  for (const p of plan) expect(p.mode).toBe(0o644)
})

test('plist: label, ProgramArguments, KeepAlive, logs, ambiente mínimo e sem token', () => {
  const sb = sandbox()
  const claudeDir = '/opt/fake bin/claude-dir'
  const plan = planFor(sb, { claudeDir })
  const plist = byFile(plan, plistFile(sb.paths))
  expect(plist.content).not.toMatch(/sk-ant-/)
  mkdirSync(join(plist.file, '..'), { recursive: true })
  writeFileSync(plist.file, plist.content)
  const data = plistAsJson(plist.file)
  expect(data.Label).toBe('com.gabriellst.switchboard.watch')
  expect(data.ProgramArguments).toEqual([process.execPath, CLI, 'watch'])
  expect(data.RunAtLoad).toBe(true)
  expect(data.KeepAlive).toBe(true)
  expect(data.StandardOutPath).toBe(join(sb.paths.stateDir, 'log', 'watch.out'))
  expect(data.StandardErrorPath).toBe(join(sb.paths.stateDir, 'log', 'watch.out'))
  const env = data.EnvironmentVariables as Record<string, string>
  expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH'])
  expect(env.HOME).toBe(sb.paths.home)
  expect(env.PATH!.split(':')).toContain(claudeDir)
  expect(env.PATH!.split(':')[0]).toBe(claudeDir) // o claude escolhido vem antes de qualquer outro
})

test('plist: caminhos com & < > " \' e espaço saem escapados e o XML continua válido', () => {
  const sb = sandbox()
  const runtimeBin = `/opt/a&b/<x> "y"/it's bun`
  const cliPath = '/tmp/dir com espaço/cli&.js'
  const claudeDir = '/tmp/c<>&'
  const plist = byFile(planFor(sb, { runtimeBin, cliPath, claudeDir }), plistFile(sb.paths))
  expect(plist.content).not.toContain('/opt/a&b/') // & cru quebraria o XML
  mkdirSync(join(plist.file, '..'), { recursive: true })
  writeFileSync(plist.file, plist.content)
  expect(spawnSync('plutil', ['-lint', plist.file], { encoding: 'utf8' }).status).toBe(0)
  const data = plistAsJson(plist.file)
  expect(data.ProgramArguments).toEqual([runtimeBin, cliPath, 'watch'])
  expect((data.EnvironmentVariables as { PATH: string }).PATH.split(':')[0]).toBe(claudeDir)
})

test('/sb: frontmatter, corpo com `sb $ARGUMENTS` e instrução em português', () => {
  const sb = sandbox()
  const md = byFile(planFor(sb), slashCommandFile(sb.paths)).content
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md)
  expect(m).not.toBeNull()
  const [, front, body] = m!
  expect(front).toMatch(/^description: .+/m)
  expect(front).toMatch(/^argument-hint: .+/m)
  expect(front).toContain('allowed-tools: Bash(sb:*)')
  expect(front).toContain('disable-model-invocation: true')
  expect(body).toContain('!`sb $ARGUMENTS 2>&1`')
  expect(body).toMatch(/português/)
  expect(md).not.toMatch(/sk-ant-/)
})

test('wrapper gerado: sintaxe válida no zsh, com caminhos de aspas e espaços, e sem token', () => {
  const sb = sandbox()
  const runtimeBin = `/opt/it's here/bun`
  const cliPath = '/tmp/dir com espaço/cli.js'
  const w = byFile(planFor(sb, { runtimeBin, cliPath }), wrapperFile(sb.paths)).content
  expect(w).not.toMatch(/sk-ant-/)
  mkdirSync(sb.paths.stateDir, { recursive: true })
  writeFileSync(wrapperFile(sb.paths), w)
  const r = spawnSync('/bin/zsh', ['-n', wrapperFile(sb.paths)], { encoding: 'utf8' })
  expect(r.stderr).toBe('')
  expect(r.status).toBe(0)
})

// ---------------------------------------------------------------------------------------------
// runInstall (ctx.run falso: nunca o launchctl real)

test('launchctl: bootout (erro ignorado) e bootstrap gui/<uid> <plist> registrados', () => {
  const sb = sandbox()
  const { calls, run } = fakeRun((_, args) => (args[0] === 'bootout' ? 113 : 0))
  const res = runInstall(sb.ctx({ run }), planFor(sb), { simular: false })
  expect(calls).toEqual([
    ['launchctl', 'bootout', `gui/${UID}/${LAUNCH_LABEL}`],
    ['launchctl', 'bootstrap', `gui/${UID}`, plistFile(sb.paths)],
  ])
  expect(res.launchd.status).toBe('loaded')
  expect(res.launchd.domain).toBe(`gui/${UID}`)
})

test('launchctl: bootstrap que falha (mesmo depois de repetir) vira status failed, sem lançar e sem apagar os arquivos', () => {
  const sb = sandbox()
  const { calls, run } = fakeRun((_, args) => (args[0] === 'bootstrap' ? 5 : 0))
  const res = runInstall(sb.ctx({ run }), planFor(sb), { simular: false, sleep: () => undefined })
  expect(res.launchd.status).toBe('failed')
  expect(res.launchd.error).toContain('erro do launchctl')
  expect(calls.filter((c) => c[1] === 'bootstrap').length).toBeGreaterThan(1) // o bootout ainda pode estar derrubando o antigo
  expect(existsSync(plistFile(sb.paths))).toBe(true)
  expect(existsSync(wrapperFile(sb.paths))).toBe(true)
})

test('launchctl: bootstrap que só passa na segunda tentativa conta como carregado', () => {
  const sb = sandbox()
  let n = 0
  const { run } = fakeRun((_, args) => (args[0] === 'bootstrap' && n++ === 0 ? 5 : 0))
  const res = runInstall(sb.ctx({ run }), planFor(sb), { simular: false, sleep: () => undefined })
  expect(res.launchd.status).toBe('loaded')
})

test('grava os três arquivos (modos exatos), cria state/log 700 e não deixa temporários', () => {
  const sb = sandbox()
  const plan = planFor(sb)
  runInstall(sb.ctx({ run: fakeRun().run }), plan, { simular: false })
  for (const p of plan) {
    expect(readFileSync(p.file, 'utf8')).toBe(p.content)
    expect(statSync(p.file).mode & 0o777).toBe(p.mode)
  }
  expect(statSync(join(sb.paths.stateDir, 'log')).mode & 0o777).toBe(0o700) // o launchd não cria o diretório do StandardOutPath
  expect(statSync(sb.paths.stateDir).mode & 0o777).toBe(0o700)
  expect(filesUnder(sb.dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
})

test('--simular não grava nada, não chama o launchctl e não mexe no zshrc', () => {
  const sb = sandbox()
  writeFileSync(sb.paths.zshrc, 'export A=1\n')
  const before = filesUnder(sb.dir)
  const { calls, run } = fakeRun()
  const res = runInstall(sb.ctx({ run }), planFor(sb), { simular: true })
  expect(calls).toEqual([])
  expect(filesUnder(sb.dir)).toEqual(before)
  expect(existsSync(sb.paths.stateDir)).toBe(false)
  expect(existsSync(join(sb.paths.home, 'Library'))).toBe(false)
  expect(readFileSync(sb.paths.zshrc, 'utf8')).toBe('export A=1\n')
  expect(res.files.every((f) => f.status === 'would-write')).toBe(true)
  expect(res.launchd.status).toBe('skipped')
  expect(res.zshrc.status).toBe('would-append')
})

test('rodar de novo é idempotente: arquivos inalterados, uma única linha no zshrc, launchctl refeito', () => {
  const sb = sandbox()
  writeFileSync(sb.paths.zshrc, 'export A=1') // sem newline final de propósito
  const plan = planFor(sb)
  const { calls, run } = fakeRun()
  const ctx = sb.ctx({ run })
  const first = runInstall(ctx, plan, { simular: false })
  expect(first.files.map((f) => f.status)).toEqual(['written', 'written', 'written'])
  expect(first.zshrc.status).toBe('appended')
  const snapshot = [...plan.map((p) => readFileSync(p.file, 'utf8')), readFileSync(sb.paths.zshrc, 'utf8')]

  const second = runInstall(ctx, plan, { simular: false })
  expect(second.files.map((f) => f.status)).toEqual(['unchanged', 'unchanged', 'unchanged'])
  expect(second.zshrc.status).toBe('present')
  expect([...plan.map((p) => readFileSync(p.file, 'utf8')), readFileSync(sb.paths.zshrc, 'utf8')]).toEqual(snapshot)
  expect(calls.filter((c) => c[1] === 'bootstrap').length).toBe(2) // o plist pode ter mudado; recarregar é barato e idempotente
})

test('zshrc: sem claude-conta a linha é acrescentada uma vez (e o resto do arquivo fica igual)', () => {
  const sb = sandbox()
  writeFileSync(sb.paths.zshrc, 'export A=1\nalias x=y\n')
  runInstall(sb.ctx({ run: fakeRun().run }), planFor(sb), { simular: false })
  runInstall(sb.ctx({ run: fakeRun().run }), planFor(sb), { simular: false })
  const w = wrapperFile(sb.paths)
  expect(readFileSync(sb.paths.zshrc, 'utf8')).toBe(`export A=1\nalias x=y\n[ -f ${w} ] && source ${w}  # switchboard\n`)
})

test('zshrc: sem arquivo, ele é criado só com a linha; caminho com espaço sai entre aspas', () => {
  const sb = sandbox()
  const spaced = sandbox()
  const paths = { ...spaced.paths, stateDir: join(spaced.dir, 'meu estado'), zshrc: join(spaced.dir, 'zshrc-novo') }
  runInstall(spaced.ctx({ run: fakeRun().run, paths }), planInstall(paths, { runtimeBin: 'bun', cliPath: CLI, claudeDir: '/x' }), { simular: false })
  const w = join(paths.stateDir, 'wrapper.zsh')
  expect(readFileSync(paths.zshrc, 'utf8')).toBe(`[ -f '${w}' ] && source '${w}'  # switchboard\n`)
  // o que foi gravado precisa ser zsh válido e carregar o wrapper de verdade
  const r = spawnSync('/bin/zsh', ['-c', `source ${JSON.stringify(paths.zshrc)}; whence -w claude`], { encoding: 'utf8', env: { HOME: sb.paths.home, PATH: '/usr/bin:/bin' } })
  expect(r.stdout.trim()).toBe('claude: function')
})

test('zshrc com claude-conta não é alterado: o resultado manda rodar `sb migrate`', () => {
  const sb = sandbox()
  const text = 'export A=1\nsource ~/.claude/contas/wrapper.zsh  # claude-conta\n'
  writeFileSync(sb.paths.zshrc, text)
  const res = runInstall(sb.ctx({ run: fakeRun().run }), planFor(sb), { simular: false })
  expect(readFileSync(sb.paths.zshrc, 'utf8')).toBe(text)
  expect(res.zshrc.status).toBe('claude-conta')
  // os outros arquivos e o launchd seguem normalmente
  expect(existsSync(wrapperFile(sb.paths))).toBe(true)
  expect(res.launchd.status).toBe('loaded')
})

test('zshrc: linha `# switchboard` diferente (estado movido) não é reescrita; o resultado avisa', () => {
  const sb = sandbox()
  const text = '[ -f /velho/wrapper.zsh ] && source /velho/wrapper.zsh  # switchboard\n'
  writeFileSync(sb.paths.zshrc, text)
  const res = runInstall(sb.ctx({ run: fakeRun().run }), planFor(sb), { simular: false })
  expect(readFileSync(sb.paths.zshrc, 'utf8')).toBe(text)
  expect(res.zshrc.status).toBe('different')
})

test('zshrc que é symlink (dotfiles): grava no alvo e mantém o link', () => {
  const sb = sandbox()
  const real = join(sb.dir, 'dotfiles-zshrc')
  writeFileSync(real, 'export A=1\n')
  symlinkSync(real, sb.paths.zshrc)
  runInstall(sb.ctx({ run: fakeRun().run }), planFor(sb), { simular: false })
  expect(readFileSync(real, 'utf8')).toContain('# switchboard')
  expect(readFileSync(sb.paths.zshrc, 'utf8')).toBe(readFileSync(real, 'utf8'))
})

test('findClaudeDir: SWITCHBOARD_CLAUDE manda; senão procura `claude` executável no PATH; sem ele → erro', () => {
  const sb = sandbox()
  expect(findClaudeDir({ SWITCHBOARD_CLAUDE: FAKE_CLAUDE, PATH: '/usr/bin' })).toBe(join(import.meta.dir))
  const bin = join(sb.dir, 'bin')
  mkdirSync(bin, { recursive: true })
  expect(() => findClaudeDir({ PATH: bin })).toThrow(SbError)
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n')
  expect(() => findClaudeDir({ PATH: bin })).toThrow(SbError) // sem bit de execução não conta
  chmodSync(join(bin, 'claude'), 0o755)
  expect(findClaudeDir({ PATH: `/nao/existe:${bin}` })).toBe(bin)
})

// ---------------------------------------------------------------------------------------------
// comportamento do wrapper no zsh de verdade

/** Pasta com um `claude` que chama o claude falso (registra argv e se o token herdado chegou). */
function claudeShimDir(sb: Sandbox): string {
  const bin = join(sb.dir, 'shim-bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o755 })
  return bin
}

function runWrapper(sb: Sandbox, dir: string, args: string[], extraEnv: Record<string, string> = {}, over: Partial<Parameters<typeof planFor>[1]> = {}) {
  mkdirSync(sb.paths.stateDir, { recursive: true })
  writeFileSync(wrapperFile(sb.paths), byFile(planFor(sb, over), wrapperFile(sb.paths)).content)
  mkdirSync(dir, { recursive: true })
  const r = spawnSync('/bin/zsh', ['-c', `source "$1"; cd "$2" || exit 97; shift 2; claude "$@"`, 'zsh', wrapperFile(sb.paths), dir, ...args], {
    // sem `sb` no PATH de propósito: o wrapper tem os caminhos absolutos; o token herdado vai para provar que é retirado
    env: { ...sb.env, PATH: `${claudeShimDir(sb)}:/usr/bin:/bin`, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, ...extraEnv },
    encoding: 'utf8',
  })
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
}

test('wrapper: fora de sessão acrescenta --settings do mux da pasta e tira o token herdado', () => {
  const sb = populatedSandbox()
  const dir = join(sb.paths.home, 'bk', 'sub')
  const r = runWrapper(sb, dir, ['-p', 'oi'])
  expect(r.code).toBe(0)
  expect(sb.calls().map((c) => ({ argv: c.argv, cwd: c.cwd, hasOauthEnv: c.hasOauthEnv }))).toEqual([
    { argv: ['-p', 'oi', '--settings', muxLink(sb.paths, 'bk')], cwd: dir, hasOauthEnv: false },
  ])
  expect(r.stdout + r.stderr).not.toMatch(/sk-ant-/)
})

test('wrapper: pasta com espaços e argumentos com espaços chegam inteiros', () => {
  const sb = populatedSandbox()
  const dir = join(sb.paths.home, 'bk', 'meu projeto')
  const r = runWrapper(sb, dir, ['-p', 'duas palavras  e  espaços'])
  expect(r.code).toBe(0)
  expect(sb.calls()[0]!.argv).toEqual(['-p', 'duas palavras  e  espaços', '--settings', muxLink(sb.paths, 'bk')])
})

test('wrapper: pasta fora de qualquer root cai no mux default', () => {
  const sb = populatedSandbox()
  const r = runWrapper(sb, join(sb.dir, 'qualquer-outra'), ['-p', 'x'])
  expect(r.code).toBe(0) // config do sandbox: default = bk
  expect(sb.calls()[0]!.argv.slice(-2)).toEqual(['--settings', muxLink(sb.paths, 'bk')])
})

test('wrapper: --cwd X e --cwd=X mandam na escolha do mux (e o argumento segue intacto)', () => {
  const sb = populatedSandbox()
  // dois muxes: pessoal em ~/pessoal, bk em ~/bk (o default); a pasta atual não pertence a nenhum
  expect(sb.runSb(['mux', 'add', 'pessoal', '--root', '~/pessoal', '--account', 'admin1']).code).toBe(0)
  const alvo = join(sb.paths.home, 'pessoal', 'app')
  mkdirSync(alvo, { recursive: true })

  const outside = join(sb.dir, 'fora')
  expect(runWrapper(sb, outside, ['--cwd', alvo, '-p', 'a']).code).toBe(0)
  expect(runWrapper(sb, outside, [`--cwd=${alvo}`, '-p', 'b']).code).toBe(0)
  expect(runWrapper(sb, outside, ['-p', 'c']).code).toBe(0)
  const [a, b, c] = sb.calls().map((x) => x.argv)
  expect(a).toEqual(['--cwd', alvo, '-p', 'a', '--settings', muxLink(sb.paths, 'pessoal')])
  expect(b).toEqual([`--cwd=${alvo}`, '-p', 'b', '--settings', muxLink(sb.paths, 'pessoal')])
  expect(c).toEqual(['-p', 'c', '--settings', muxLink(sb.paths, 'bk')]) // sem --cwd: o default
})

test('wrapper: --settings explícito (as duas formas) passa direto, mas sem o token herdado', () => {
  const sb = populatedSandbox()
  const dir = join(sb.paths.home, 'bk')
  expect(runWrapper(sb, dir, ['--settings', '/x/y.json', '-p', 'oi']).code).toBe(0)
  expect(runWrapper(sb, dir, ['-p', 'oi', '--settings=/x/z.json']).code).toBe(0)
  const calls = sb.calls()
  expect(calls.map((c) => c.argv)).toEqual([
    ['--settings', '/x/y.json', '-p', 'oi'],
    ['-p', 'oi', '--settings=/x/z.json'],
  ])
  expect(calls.every((c) => c.hasOauthEnv === false)).toBe(true)
})

test('wrapper: subcomando de manutenção passa direto, sem --settings e sem o token herdado', () => {
  const sb = populatedSandbox()
  const dir = join(sb.paths.home, 'bk')
  const subs = ['auth', 'attach', 'logs', 'stop', 'kill', 'rm', 'respawn', 'mcp', 'plugin', 'plugins', 'doctor', 'update', 'upgrade', 'install', 'setup-token', 'daemon', 'purge', 'import', 'gateway', 'ultrareview', 'auto-mode', 'help']
  for (const s of subs) runWrapper(sb, dir, [s, 'arg']) // o código de saída é do claude falso (`stop` de id inexistente sai 1): só o argv e o ambiente contam
  const calls = sb.calls()
  expect(calls.length).toBe(subs.length)
  expect(calls.map((c) => c.argv)).toEqual(subs.map((s) => [s, 'arg']))
  expect(calls.every((c) => c.hasOauthEnv === false)).toBe(true)
})

test('wrapper: dentro de uma sessão (CLAUDECODE) passa direto, sem --settings', () => {
  const sb = populatedSandbox()
  const r = runWrapper(sb, join(sb.paths.home, 'bk'), ['-p', 'oi'], { CLAUDECODE: '1' })
  expect(r.code).toBe(0)
  expect(sb.calls().map((c) => c.argv)).toEqual([['-p', 'oi']])
})

test('wrapper: `sb which` falhando → mensagem, exit 1 e o claude não é chamado (link quebrado)', () => {
  const sb = populatedSandbox()
  rmSync(muxLink(sb.paths, 'bk')) // sem link o `claude` cairia no keychain
  const r = runWrapper(sb, join(sb.paths.home, 'bk'), ['-p', 'oi'])
  expect(r.code).toBe(1)
  expect(sb.calls()).toEqual([])
  expect(r.stderr).toContain('bk') // o erro do `sb which` aparece
  expect(r.stderr).toMatch(/claude/i)
  expect(r.stdout + r.stderr).not.toMatch(/sk-ant-/)
})

test('wrapper: `sb which` falhando por settings inválido (alvo com JSON quebrado) também não chama o claude', () => {
  const sb = populatedSandbox()
  writeFileSync(join(sb.paths.stateDir, 'tokens', 'gabriel.json'), '{ quebrado')
  const r = runWrapper(sb, join(sb.paths.home, 'bk'), ['-p', 'oi'])
  expect(r.code).toBe(1)
  expect(sb.calls()).toEqual([])
})

test('wrapper: executável do sb inexistente → exit 1 e o claude não é chamado', () => {
  const sb = populatedSandbox()
  const r = runWrapper(sb, join(sb.paths.home, 'bk'), ['-p', 'oi'], {}, { runtimeBin: join(sb.dir, 'nao-existe') })
  expect(r.code).toBe(1)
  expect(sb.calls()).toEqual([])
})

test('wrapper: `sb which` que sai 0 sem imprimir nada também falha fechado', () => {
  const sb = populatedSandbox()
  const r = runWrapper(sb, join(sb.paths.home, 'bk'), ['-p', 'oi'], {}, { runtimeBin: '/usr/bin/true' })
  expect(r.code).toBe(1)
  expect(sb.calls()).toEqual([])
})

test('wrapper: o código de saída do claude é o do wrapper', () => {
  const sb = populatedSandbox()
  mkdirSync(sb.env.FAKE_CLAUDE_DIR!, { recursive: true })
  writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'exit-code'), '7')
  expect(runWrapper(sb, join(sb.paths.home, 'bk'), ['-p', 'oi']).code).toBe(7)
})

// ---------------------------------------------------------------------------------------------
// o comando (só --simular: o launchctl de verdade nunca roda nos testes)

test('sb install --simular --json: lista o que faria e não grava nada', () => {
  const sb = populatedSandbox()
  const files = (): string[] => filesUnder(sb.dir).filter((f) => !f.includes('/Library/Caches/')) // cache do transpilador do bun (HOME do sandbox)
  const before = files()
  const r = sb.runSb(['install', '--simular', '--json'])
  expect(r.code).toBe(0)
  expect(files()).toEqual(before)
  expect(existsSync(plistFile(sb.paths))).toBe(false)
  const out = JSON.parse(r.stdout) as { simular: boolean; files: Array<{ file: string; status: string }>; launchd: { status: string }; zshrc: { status: string } }
  expect(out.simular).toBe(true)
  expect(out.files.map((f) => f.file)).toEqual([plistFile(sb.paths), wrapperFile(sb.paths), slashCommandFile(sb.paths)])
  expect(out.launchd.status).toBe('skipped')
  expect(r.stdout + r.stderr).not.toMatch(/sk-ant-/)
})

test('sb install --simular (texto): em português, com ~ no lugar da home', () => {
  const sb = populatedSandbox()
  const r = sb.runSb(['install', '--simular'])
  expect(r.code).toBe(0)
  expect(r.stdout).toMatch(/simula/i)
  expect(r.stdout).toContain('~/Library/LaunchAgents/com.gabriellst.switchboard.watch.plist')
  expect(r.stdout).not.toContain(sb.paths.home)
})

test('sb install --simular com claude-conta no zshrc: manda rodar `sb migrate`', () => {
  const sb = populatedSandbox()
  writeFileSync(sb.paths.zshrc, 'source ~/.claude/contas/wrapper.zsh  # claude-conta\n')
  const r = sb.runSb(['install', '--simular'])
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('sb migrate')
})

test('sb install sem claude no PATH: recusa com exit 4 e nada é gravado', () => {
  const sb = populatedSandbox()
  const empty = join(sb.dir, 'vazio')
  mkdirSync(empty)
  const r = sb.runSb(['install', '--simular'], { env: { SWITCHBOARD_CLAUDE: '', PATH: empty } })
  // process.execPath é absoluto: o bun roda mesmo com PATH vazio
  expect(r.code).toBe(4)
  expect(r.stderr).toContain('claude')
  expect(existsSync(plistFile(sb.paths))).toBe(false)
})
