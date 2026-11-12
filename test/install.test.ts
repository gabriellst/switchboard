import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from 'bun:test'
import type { Ctx } from '../src/core/ctx.js'
import { SbError } from '../src/core/errors.js'
import { findClaudeDir, findClaudeDirs, LAUNCH_LABEL, stableRuntime, planInstall, plistFile, runInstall, slashCommandFile, wrapperFile } from '../src/core/install.js'
import { muxLink, resolvePaths } from '../src/core/paths.js'
import { renderInstall } from '../src/report.js'
import { FAKE_TOKEN, filesUnder, populatedSandbox, sandbox, type Sandbox } from './helpers.js'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const FAKE_CLAUDE = join(import.meta.dir, 'fake-claude.ts')
const UID = process.getuid!()
/** ambiente mínimo para os `zsh` que não são o wrapper em ação: nada do ambiente real (HOME, PATH, ~/.zshenv) entra */
const isolatedEnv = (sb: Sandbox): Record<string, string> => ({ HOME: sb.paths.home, PATH: '/usr/bin:/bin' })

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
  expect(data.ThrottleInterval).toBe(30) // watch que sai (5 = lock, 2 = config) não é relançado a cada ~10 s
  expect(data.StandardOutPath).toBe(join(sb.paths.stateDir, 'log', 'watch.out'))
  expect(data.StandardErrorPath).toBe(join(sb.paths.stateDir, 'log', 'watch.out'))
  const env = data.EnvironmentVariables as Record<string, string>
  expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'SWITCHBOARD_CONFIG', 'SWITCHBOARD_JOBS_DIR', 'SWITCHBOARD_STATE_DIR'])
  expect(env.HOME).toBe(sb.paths.home)
  expect(env.SWITCHBOARD_CONFIG).toBe(sb.paths.configFile)
  expect(env.SWITCHBOARD_STATE_DIR).toBe(sb.paths.stateDir)
  expect(env.SWITCHBOARD_JOBS_DIR).toBe(sb.paths.jobsDir)
  expect(env.PATH!.split(':')).toContain(claudeDir)
  expect(env.PATH!.split(':')[0]).toBe(claudeDir) // o claude escolhido vem antes de qualquer outro
})

test('plist: grava os caminhos RESOLVIDOS (XDG_*) de quem instala: o watch usa o mesmo estado que o CLI e o wrapper', () => {
  const sb = sandbox()
  const env = { HOME: sb.paths.home, XDG_STATE_HOME: join(sb.dir, 'xdg-state'), XDG_CONFIG_HOME: join(sb.dir, 'xdg-config') }
  const paths = resolvePaths(env)
  expect(paths.stateDir).toBe(join(sb.dir, 'xdg-state', 'switchboard')) // o XDG vale para o CLI...
  const plist = byFile(planInstall(paths, { runtimeBin: process.execPath, cliPath: CLI, claudeDir: join(sb.dir, 'claude-bin') }), plistFile(paths))
  mkdirSync(join(plist.file, '..'), { recursive: true })
  writeFileSync(plist.file, plist.content)
  const e = plistAsJson(plist.file).EnvironmentVariables as Record<string, string>
  expect(e.SWITCHBOARD_STATE_DIR).toBe(join(sb.dir, 'xdg-state', 'switchboard')) // ...e agora vale para o watch também
  expect(e.SWITCHBOARD_CONFIG).toBe(join(sb.dir, 'xdg-config', 'switchboard', 'config.jsonc'))
  expect(e.SWITCHBOARD_JOBS_DIR).toBe(join(sb.paths.home, '.claude', 'jobs'))
  expect(Object.keys(e).some((k) => /XDG/.test(k))).toBe(false)
})

test('plist: `sb install` de verdade (subprocesso, launchctl falso) grava os três caminhos e nunca os seams de teste nem token', () => {
  const sb = sandbox()
  const shimDir = join(sb.dir, 'shim')
  mkdirSync(shimDir, { recursive: true })
  writeFileSync(join(shimDir, 'launchctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const r = sb.runSb(['install'], { env: { PATH: `${shimDir}:${process.env.PATH ?? '/usr/bin:/bin'}`, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, SWITCHBOARD_API_BASE: 'http://127.0.0.1:9' } })
  expect(r.code).toBe(0)
  const text = readFileSync(plistFile(sb.paths), 'utf8')
  const e = plistAsJson(plistFile(sb.paths)).EnvironmentVariables as Record<string, string>
  expect(Object.keys(e).sort()).toEqual(['HOME', 'PATH', 'SWITCHBOARD_CONFIG', 'SWITCHBOARD_JOBS_DIR', 'SWITCHBOARD_STATE_DIR'])
  expect(e.SWITCHBOARD_CONFIG).toBe(sb.env.SWITCHBOARD_CONFIG!)
  expect(e.SWITCHBOARD_STATE_DIR).toBe(sb.env.SWITCHBOARD_STATE_DIR!)
  expect(e.SWITCHBOARD_JOBS_DIR).toBe(sb.env.SWITCHBOARD_JOBS_DIR!)
  for (const seam of ['SWITCHBOARD_CLAUDE', 'SWITCHBOARD_API_BASE', 'SWITCHBOARD_PS', 'SWITCHBOARD_NO_NOTIFY', 'CLAUDE_CODE_OAUTH_TOKEN']) expect(text).not.toContain(seam)
  expect(text).not.toMatch(/sk-ant-/)
})

test('plist: os três caminhos entram ABSOLUTOS (valor relativo é resolvido contra a pasta de quem instala)', () => {
  const sb = sandbox()
  const rel = { ...sb.paths, configFile: 'rel/config.jsonc', stateDir: './rel-state', jobsDir: '../rel-jobs' }
  const plist = byFile(planInstall(rel, { runtimeBin: process.execPath, cliPath: CLI, claudeDir: join(sb.dir, 'claude-bin') }), plistFile(rel))
  mkdirSync(join(plist.file, '..'), { recursive: true })
  writeFileSync(plist.file, plist.content)
  const e = plistAsJson(plist.file).EnvironmentVariables as Record<string, string>
  expect(e.SWITCHBOARD_CONFIG).toBe(resolve('rel/config.jsonc'))
  expect(e.SWITCHBOARD_STATE_DIR).toBe(resolve('./rel-state'))
  expect(e.SWITCHBOARD_JOBS_DIR).toBe(resolve('../rel-jobs'))
  for (const k of ['SWITCHBOARD_CONFIG', 'SWITCHBOARD_STATE_DIR', 'SWITCHBOARD_JOBS_DIR']) expect(e[k]!.startsWith('/')).toBe(true)
})

// --- o que o `sb install` mostra sobre os caminhos do watch --------------------------------------

const OTHER = (sb: Sandbox) => ({ ...sb.paths, configFile: join(sb.dir, 'outra', 'config.jsonc'), stateDir: join(sb.dir, 'outra', 'state'), jobsDir: join(sb.dir, 'outra', 'jobs') })

test('install informa os caminhos que o watch vai usar (resultado, texto e --simular)', () => {
  const sb = sandbox()
  const res = runInstall(sb.ctx({ run: fakeRun().run }), planFor(sb), { simular: false })
  expect(res.watch).toEqual({ config: sb.paths.configFile, state: sb.paths.stateDir, jobs: sb.paths.jobsDir })
  expect(res.watchChanged).toEqual([])
  const text = renderInstall(res, sb.paths.home)
  for (const v of [sb.paths.configFile, sb.paths.stateDir, sb.paths.jobsDir]) expect(text).toContain(v)
  expect(text).not.toMatch(/→|mudou/)
  const sim = runInstall(sb.ctx({ run: fakeRun().run }), planFor(sb), { simular: true })
  expect(sim.watch).toEqual(res.watch)
  expect(renderInstall(sim, sb.paths.home)).toContain(sb.paths.stateDir)
})

test('plist existente com outro config/estado/jobs: avisa com antes → depois (exit 0, o plist é reescrito); igual não avisa', () => {
  const sb = sandbox()
  const old = OTHER(sb)
  runInstall(sb.ctx({ run: fakeRun().run }), planInstall(old, { runtimeBin: process.execPath, cliPath: CLI, claudeDir: join(sb.dir, 'claude-bin') }), { simular: false })
  // o `plistFile` depende só de launchAgentsDir (igual nos dois): o plist velho está no lugar que o novo vai ocupar
  const res = runInstall(sb.ctx({ run: fakeRun().run }), planFor(sb), { simular: false })
  expect(res.watchChanged).toEqual([
    { key: 'SWITCHBOARD_CONFIG', from: old.configFile, to: sb.paths.configFile },
    { key: 'SWITCHBOARD_STATE_DIR', from: old.stateDir, to: sb.paths.stateDir },
    { key: 'SWITCHBOARD_JOBS_DIR', from: old.jobsDir, to: sb.paths.jobsDir },
  ])
  const text = renderInstall(res, sb.paths.home)
  expect(text).toContain(`${old.stateDir} → ${sb.paths.stateDir}`)
  expect(text).toContain(`${old.configFile} → ${sb.paths.configFile}`)
  expect(text).toContain(`${old.jobsDir} → ${sb.paths.jobsDir}`)
  expect(text).toMatch(/⚠/)
  expect(plistAsJson(plistFile(sb.paths)).EnvironmentVariables).toMatchObject({ SWITCHBOARD_STATE_DIR: sb.paths.stateDir })
  // de novo, agora igual: nenhum aviso
  expect(runInstall(sb.ctx({ run: fakeRun().run }), planFor(sb), { simular: false }).watchChanged).toEqual([])
  // --simular também avisa (não grava)
  runInstall(sb.ctx({ run: fakeRun().run }), planInstall(old, { runtimeBin: process.execPath, cliPath: CLI, claudeDir: join(sb.dir, 'claude-bin') }), { simular: false }) // volta o plist velho
  const sim = runInstall(sb.ctx({ run: fakeRun().run }), planFor(sb), { simular: true })
  expect(sim.watchChanged.map((c) => c.key)).toEqual(['SWITCHBOARD_CONFIG', 'SWITCHBOARD_STATE_DIR', 'SWITCHBOARD_JOBS_DIR'])
  expect(plistAsJson(plistFile(sb.paths)).EnvironmentVariables).toMatchObject({ SWITCHBOARD_STATE_DIR: old.stateDir })
})

test('plist de antes desta versão (sem os caminhos): valia o padrão do HOME; só avisa se o novo for outro', () => {
  const sb = sandbox()
  const legacy = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin</string><key>HOME</key><string>${sb.paths.home}</string></dict></dict></plist>\n`
  mkdirSync(join(plistFile(sb.paths), '..'), { recursive: true })
  writeFileSync(plistFile(sb.paths), legacy)
  const def = resolvePaths({ HOME: sb.paths.home })
  const same = runInstall(sb.ctx({ run: fakeRun().run }), planInstall(def, { runtimeBin: process.execPath, cliPath: CLI, claudeDir: '/c' }), { simular: true })
  expect(same.watchChanged).toEqual([]) // o estado do sandbox NÃO é o padrão, mas aqui o ctx/paths é o padrão: nada mudou
  const res = runInstall(sb.ctx({ run: fakeRun().run }), planFor(sb), { simular: true })
  expect(res.watchChanged).toContainEqual({ key: 'SWITCHBOARD_STATE_DIR', from: def.stateDir, to: sb.paths.stateDir })
})

test('sb install (subprocesso): --json e texto trazem os caminhos; rodar de outro estado avisa antes → depois e sai 0', () => {
  const sb = sandbox()
  const shimDir = join(sb.dir, 'shim')
  mkdirSync(shimDir, { recursive: true })
  writeFileSync(join(shimDir, 'launchctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const env = { PATH: `${shimDir}:${process.env.PATH ?? '/usr/bin:/bin'}` }
  const first = sb.runSb(['install', '--json'], { env })
  expect(first.code).toBe(0)
  const j = JSON.parse(first.stdout)
  expect(j.watch).toEqual({ config: sb.env.SWITCHBOARD_CONFIG, state: sb.env.SWITCHBOARD_STATE_DIR, jobs: sb.env.SWITCHBOARD_JOBS_DIR })
  expect(j.watchChanged).toEqual([])
  // outro CONFIG (o estado e a linha do zshrc seguem iguais): aviso antes → depois, exit 0
  const newConfig = join(sb.dir, 'config-nova', 'config.jsonc')
  const second = sb.runSb(['install'], { env: { ...env, SWITCHBOARD_CONFIG: newConfig } })
  expect(second.code).toBe(0)
  expect(second.stdout).toContain(`SWITCHBOARD_CONFIG mudou: ${sb.env.SWITCHBOARD_CONFIG} → ${newConfig}`)
  expect(second.stdout).toContain(`config ${newConfig}`)
  // --simular a partir do shell de sempre: aponta a volta (e não grava)
  const sim = sb.runSb(['install', '--simular', '--json'], { env })
  expect(sim.code).toBe(0)
  expect(JSON.parse(sim.stdout).watchChanged).toEqual([{ key: 'SWITCHBOARD_CONFIG', from: newConfig, to: sb.env.SWITCHBOARD_CONFIG }])
  expect(plistAsJson(plistFile(sb.paths)).EnvironmentVariables).toMatchObject({ SWITCHBOARD_CONFIG: newConfig })
  // outro ESTADO também é mostrado (o exit 1 aqui é da linha do zshrc, que é de outro estado: comportamento que já existia)
  const newState = join(sb.dir, 'estado-novo')
  const third = sb.runSb(['install'], { env: { ...env, SWITCHBOARD_STATE_DIR: newState } })
  expect(third.stdout).toContain(`SWITCHBOARD_STATE_DIR mudou: ${sb.env.SWITCHBOARD_STATE_DIR} → ${newState}`)
  expect(first.stdout + second.stdout + sim.stdout + third.stdout).not.toMatch(/sk-ant-/)
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
  const r = spawnSync('/bin/zsh', ['-n', wrapperFile(sb.paths)], { encoding: 'utf8', env: isolatedEnv(sb) })
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
  const text = readFileSync(sb.paths.zshrc, 'utf8')
  expect(text.startsWith('export A=1\nalias x=y\n')).toBe(true)
  const added = text.slice('export A=1\nalias x=y\n'.length)
  expect(added.endsWith('  # switchboard\n')).toBe(true)
  expect(added.split('\n').length).toBe(2) // uma linha só
  expect(added).toContain(`[ -f ${w} ]`)
  expect(added).toContain(`source ${w}`)
  expect(added).toMatch(/\belse\b.*\bclaude\b.*return 1/) // sem o wrapper, o claude recusa em vez de rodar no keychain
})

test('zshrc: sem arquivo, ele é criado só com a linha; caminho com espaço sai entre aspas', () => {
  const sb = sandbox()
  const spaced = sandbox()
  const paths = { ...spaced.paths, stateDir: join(spaced.dir, 'meu estado'), zshrc: join(spaced.dir, 'zshrc-novo') }
  runInstall(spaced.ctx({ run: fakeRun().run, paths }), planInstall(paths, { runtimeBin: 'bun', cliPath: CLI, claudeDir: '/x' }), { simular: false })
  const w = join(paths.stateDir, 'wrapper.zsh')
  const text = readFileSync(paths.zshrc, 'utf8')
  expect(text).toContain(`[ -f '${w}' ]`)
  expect(text).toContain(`source '${w}'`)
  expect(text.endsWith('  # switchboard\n')).toBe(true)
  expect(text.split('\n').length).toBe(2)
  // o que foi gravado precisa ser zsh válido e carregar o wrapper de verdade
  const r = spawnSync('/bin/zsh', ['-c', `source ${JSON.stringify(paths.zshrc)}; whence -w claude`], { encoding: 'utf8', env: isolatedEnv(sb) })
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
  const text = '[ -f /velho/wrapper.zsh ] && source /velho/wrapper.zsh  # switchboard\n' // formato antigo (e/ou outro estado) conta como diferente
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

test('findClaudeDirs: TODAS as pastas do PATH com `claude`, o binário de verdade antes de scripts (ex.: o invólucro do cmux)', () => {
  const sb = sandbox()
  const wrapperDir = join(sb.dir, 'cmux-bin')
  const realDir = join(sb.dir, 'local-bin')
  for (const d of [wrapperDir, realDir]) mkdirSync(d, { recursive: true })
  // o invólucro vem PRIMEIRO no PATH e, sozinho, não acha o claude de verdade (foi o que quebrou o watch em 12/11/2026)
  writeFileSync(join(wrapperDir, 'claude'), '#!/usr/bin/env bash\nexit 127\n', { mode: 0o755 })
  writeFileSync(join(realDir, 'claude'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00]), { mode: 0o755 })
  expect(findClaudeDirs({ PATH: `${wrapperDir}:/nao/existe:${realDir}:${wrapperDir}` })).toEqual([realDir, wrapperDir])
  expect(findClaudeDir({ PATH: `${wrapperDir}:${realDir}` })).toBe(realDir)
  // só o script existe: serve (é o claude falso dos testes, ou uma instalação por script)
  expect(findClaudeDirs({ PATH: wrapperDir })).toEqual([wrapperDir])
})

test('plist: o PATH do watch leva todas as pastas do claude, na ordem dada', () => {
  const sb = sandbox()
  const plist = byFile(planInstall(sb.paths, { runtimeBin: '/rt/bin/node', cliPath: CLI, claudeDir: '/real/bin', claudeDirs: ['/real/bin', '/wrapper/bin'] }), plistFile(sb.paths))
  const path = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(plist.content)![1]!
  expect(path.split(':').slice(0, 3)).toEqual(['/real/bin', '/wrapper/bin', '/rt/bin'])
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

test('wrapper: dentro de uma sessão (CLAUDECODE) NÃO há passagem direta: `-p`, `agents` e `--bg` saem com --settings do mux e sem o token', () => {
  const sb = populatedSandbox()
  const dir = join(sb.paths.home, 'bk')
  const link = muxLink(sb.paths, 'bk')
  // um agente dentro da sessão roda `claude --bg …` / `claude agents`: se o daemon subir com o token da sessão, arrasta todos os muxes do keychain
  for (const args of [['-p', 'x'], ['agents'], ['--bg', 'x']]) expect(runWrapper(sb, dir, args, { CLAUDECODE: '1' }).code).toBe(0)
  expect(sb.calls().map((c) => ({ argv: c.argv, hasOauthEnv: c.hasOauthEnv }))).toEqual([
    { argv: ['-p', 'x', '--settings', link], hasOauthEnv: false },
    { argv: ['agents', '--settings', link], hasOauthEnv: false },
    { argv: ['--bg', 'x', '--settings', link], hasOauthEnv: false },
  ])
})

test('wrapper: dentro de uma sessão (CLAUDECODE) também falha fechado quando o `sb which` falha', () => {
  const sb = populatedSandbox()
  rmSync(muxLink(sb.paths, 'bk'))
  const r = runWrapper(sb, join(sb.paths.home, 'bk'), ['--bg', 'x'], { CLAUDECODE: '1' })
  expect(r.code).toBe(1)
  expect(sb.calls()).toEqual([])
})

test('wrapper: subcomando de manutenção dentro de uma sessão (CLAUDECODE) também sai sem o token herdado', () => {
  const sb = populatedSandbox()
  const dir = join(sb.paths.home, 'bk')
  for (const s of ['daemon', 'setup-token', 'auth', 'mcp']) runWrapper(sb, dir, [s, 'start'], { CLAUDECODE: '1' }) // o daemon herdaria o token e o levaria a todas as sessões
  const calls = sb.calls()
  expect(calls.map((c) => c.argv)).toEqual([['daemon', 'start'], ['setup-token', 'start'], ['auth', 'start'], ['mcp', 'start']])
  expect(calls.every((c) => c.hasOauthEnv === false)).toBe(true)
})

test('wrapper: --settings explícito dentro de uma sessão (CLAUDECODE) passa direto, sem o token herdado', () => {
  const sb = populatedSandbox()
  runWrapper(sb, join(sb.paths.home, 'bk'), ['--settings', '/x/y.json', '-p', 'oi'], { CLAUDECODE: '1' })
  expect(sb.calls().map((c) => ({ argv: c.argv, hasOauthEnv: c.hasOauthEnv }))).toEqual([{ argv: ['--settings', '/x/y.json', '-p', 'oi'], hasOauthEnv: false }])
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

// --- ronda de correção 1 -----------------------------------------------------------------------

test('wrapper: alias claude preexistente não derruba o wrapper (a função vence e leva --settings)', () => {
  const sb = populatedSandbox()
  mkdirSync(sb.paths.stateDir, { recursive: true })
  writeFileSync(wrapperFile(sb.paths), byFile(planFor(sb), wrapperFile(sb.paths)).content)
  const dir = join(sb.paths.home, 'bk')
  mkdirSync(dir, { recursive: true })
  // `alias claude=…` ANTES do source: o zsh expandiria o alias em `claude() {` e a definição falharia (claude seguiria alias, sem --settings)
  const script = `alias claude='claude --x'\nsource "$1"\ncd "$2" || exit 97\nclaude -p oi` // linhas separadas: o alias vale para as linhas seguintes
  const r = spawnSync('/bin/zsh', ['-c', script, 'zsh', wrapperFile(sb.paths), dir], {
    env: { ...sb.env, PATH: `${claudeShimDir(sb)}:/usr/bin:/bin`, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN },
    encoding: 'utf8',
  })
  expect(r.stderr).toBe('')
  expect(r.status).toBe(0)
  expect(sb.calls().map((c) => ({ argv: c.argv, hasOauthEnv: c.hasOauthEnv }))).toEqual([{ argv: ['-p', 'oi', '--settings', muxLink(sb.paths, 'bk')], hasOauthEnv: false }])
})

test('wrapper: --settings entra ANTES do primeiro `--` (depois dele seria argumento posicional) e os argumentos chegam intactos', () => {
  const sb = populatedSandbox()
  const dir = join(sb.paths.home, 'bk')
  const link = muxLink(sb.paths, 'bk')
  const cases: Array<[string[], string[]]> = [
    [['-p', 'oi'], ['-p', 'oi', '--settings', link]], // sem `--`: no fim
    [['-p', '--', 'texto'], ['-p', '--settings', link, '--', 'texto']], // `--` no meio
    [['--', 'texto'], ['--settings', link, '--', 'texto']], // `--` primeiro
    [['-p', '--', 'a', '--', 'b'], ['-p', '--settings', link, '--', 'a', '--', 'b']], // só o primeiro `--`
    [['-p', '--', '--settings', 'x'], ['-p', '--settings', link, '--', '--settings', 'x']], // `--settings` depois do `--` é texto, não desvio
    [[], ['--settings', link]],
    [['-p', 'duas  palavras', "it's", '"aspas"', '$HOME', '*', '', '--', 'a b', '$(echo x)', '`y`'], ['-p', 'duas  palavras', "it's", '"aspas"', '$HOME', '*', '', '--settings', link, '--', 'a b', '$(echo x)', '`y`']],
  ]
  for (const [args] of cases) expect(runWrapper(sb, dir, args).code).toBe(0)
  const calls = sb.calls()
  expect(calls.map((c) => c.argv)).toEqual(cases.map(([, want]) => want))
  expect(calls.every((c) => c.hasOauthEnv === false)).toBe(true)
})

test('wrapper: ramos do wrapper — o ambiente que o claude recebeu (token herdado) em cada um', () => {
  const sb = populatedSandbox()
  const dir = join(sb.paths.home, 'bk')
  runWrapper(sb, dir, ['daemon', 'start']) // 0: manutenção
  runWrapper(sb, dir, ['--settings=/x.json', '-p', 'a']) // 1: --settings explícito
  runWrapper(sb, dir, ['-p', 'a']) // 2: via sb which
  runWrapper(sb, dir, ['-p', 'a'], { CLAUDECODE: '1' }) // 3: dentro de sessão (sem ramo próprio: igual ao 2)
  runWrapper(sb, dir, ['-p', '--', '--settings']) // 4: `--settings` só como texto depois do `--` não conta como explícito
  expect(sb.calls().map((c) => c.hasOauthEnv)).toEqual([false, false, false, false, false])
  expect(sb.calls()[4]!.argv).toEqual(['-p', '--settings', muxLink(sb.paths, 'bk'), '--', '--settings'])
})

test('stableRuntime: prefere a entrada do PATH que resolve para o mesmo binário (symlink estável); senão o execPath', () => {
  const sb = sandbox()
  const stable = join(sb.dir, 'stable-bin')
  mkdirSync(stable, { recursive: true })
  const name = process.execPath.split('/').pop()!
  symlinkSync(process.execPath, join(stable, name))
  const other = join(sb.dir, 'other-bin')
  mkdirSync(other, { recursive: true })
  symlinkSync('/bin/ls', join(other, name)) // mesmo nome, outro binário: não conta
  expect(stableRuntime({ PATH: `/nao/existe:${other}:${stable}` }, process.execPath)).toBe(join(stable, name))
  expect(stableRuntime({ PATH: other }, process.execPath)).toBe(process.execPath)
  expect(stableRuntime({}, process.execPath)).toBe(process.execPath)
})

test('wrapper: runtime ou cli do sb sumiram → recusa, manda rodar `sb install` e o claude não é chamado', () => {
  const sb = populatedSandbox()
  const dir = join(sb.paths.home, 'bk')
  const a = runWrapper(sb, dir, ['-p', 'oi'], {}, { runtimeBin: join(sb.dir, 'node-velho') })
  const b = runWrapper(sb, dir, ['-p', 'oi'], {}, { cliPath: join(sb.dir, 'cli-sumiu.js') })
  for (const r of [a, b]) {
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('sb install')
    expect(r.stderr).not.toContain('sb doctor')
  }
  expect(sb.calls()).toEqual([])
})

test('zshrc de verdade: wrapper apagado → `claude` recusa (exit 1, mensagem manda rodar sb install) e o claude falso nunca roda', () => {
  const sb = populatedSandbox()
  runInstall(sb.ctx({ run: fakeRun().run }), planFor(sb), { simular: false })
  const env = { ...sb.env, PATH: `${claudeShimDir(sb)}:/usr/bin:/bin`, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }
  const run = (): { status: number | null; stderr: string } => spawnSync('/bin/zsh', ['-c', `source "$1"\nalias claude='claude --x'\nclaude -p oi`, 'zsh', sb.paths.zshrc], { env, encoding: 'utf8' })
  rmSync(wrapperFile(sb.paths))
  const r = run()
  expect(r.status).toBe(1)
  expect(r.stderr).toContain('sb install')
  expect(sb.calls()).toEqual([])
  // com o wrapper no lugar, a mesma linha do zshrc carrega a função de verdade
  runInstall(sb.ctx({ run: fakeRun().run }), planFor(sb), { simular: false })
  const ok = spawnSync('/bin/zsh', ['-c', `source "$1"; cd "${join(sb.paths.home, 'bk')}"; claude -p oi`, 'zsh', sb.paths.zshrc], { env, encoding: 'utf8' })
  expect(ok.status).toBe(0)
  expect(sb.calls().map((c) => c.argv)).toEqual([['-p', 'oi', '--settings', muxLink(sb.paths, 'bk')]])
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

test('sb install --simular com linha `# switchboard` diferente: relata o resto e sai 1', () => {
  const sb = populatedSandbox()
  writeFileSync(sb.paths.zshrc, '[ -f /velho/wrapper.zsh ] && source /velho/wrapper.zsh  # switchboard\n')
  const r = sb.runSb(['install', '--simular'])
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('com.gabriellst.switchboard.watch.plist') // o resto do relatório saiu
  expect(r.stdout).toContain('# switchboard')
  const j = sb.runSb(['install', '--simular', '--json'])
  expect(j.code).toBe(1)
  expect((JSON.parse(j.stdout) as { zshrc: { status: string } }).zshrc.status).toBe('different')
})
