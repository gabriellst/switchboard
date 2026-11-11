import { chmodSync, copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { editConfig, ensureConfig, loadConfig, parseConfig, type Config, type ConfigEdit } from './config.js'
import type { Ctx } from './ctx.js'
import { psSnapshot, psTable, viewsIn, listViews } from './doctor.js'
import { EXIT, SbError } from './errors.js'
import { isAlive, mkdirPrivate, withLock, writeAtomic } from './fsx.js'
import { OLD_MARK, slashCommandFile, wrapperFile, zshrcLine, type InstallResult } from './install.js'
import { legacySource, ownershipOf } from './jobs.js'
import { checkSettingsTarget, pointMux } from './links.js'
import { resolveMuxForDir } from './mux.js'
import { assertSafeName, backupDir, muxLink, type Paths } from './paths.js'
import { migrateSession, migrationTarget } from './pin.js'
import { readRuntime } from './runtime.js'
import { KEYCHAIN, NAME_RE, normalizeRoot } from './schema.js'
import { loadSessionsWithWarnings } from './sessions.js'
import { ensureState, hasToken, loadSecret, saveToken } from './tokens.js'
import { fingerprint, measureAll } from './usage.js'

// ---------------------------------------------------------------------------------------------------------------
// `sb migrate` (design §10): do `claude-conta` (`~/.claude/contas`, `~/.claude/contas-fixas`) para o `sb`. REGRAS que não se afrouxam:
//   - o legado só é LIDO e COPIADO (para `plan.backup`); `~/.claude/contas*` só sai do lugar com `--finish`, quando nenhuma sessão,
//     view ou pedido da fila aponta mais para lá. O único arquivo legado alterado/removido antes disso é a linha `# claude-conta`
//     do `~/.zshrc` (com cópia no backup) e o `conta.md` (idem);
//   - TOKEN: `readLegacyToken` é a única leitura de segredo daqui; o valor só existe em memória (comparar duplicatas) e vai direto
//     para `saveToken`. Nunca entra no plano, na saída, no log nem em arquivo fora de `tokens/` — a cópia do legado no backup é a
//     exceção autorizada (cópia privada, 700/600). Mensagens de erro de arquivo de token são FIXAS: o texto de um `JSON.parse` que
//     falha pode citar um trecho do arquivo;
//   - `--simular` (e `planMigration`) não escreve NADA: nem diretório de estado, nem lock, nem log, nem medição;
//   - o `migrate` em si não pára nenhuma sessão: as paradas são reescritas na hora e as vivas vão para `runtime.pending`
//     (`reason: 'migrate'`). Quem as PARA é o `watch` (`claude stop`, três por ciclo) quando cada uma estiver livre, para
//     reescrever o `--settings`; a sessão volta nas contas novas quando o usuário a reabre. Turno em andamento ou trabalho
//     agendado nunca é interrompido (a sessão espera na fila). A saída tem de dizer isso e quantas são; nunca toca o keychain;
//   - cada passo é aditivo ou idempotente e as recusas vêm antes da primeira escrita: uma falha no meio deixa o legado inteiro e
//     usável, e rodar de novo termina o serviço sem duplicar nada.
// Uma config do sb que já existe NUNCA é sobrescrita: o plano mescla (só entra conta/mux/default que falta) e o aplicar grava
// só essas edições, com o texto, os comentários e o `swap` do usuário intactos.
// ---------------------------------------------------------------------------------------------------------------

const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]+/g
const redact = (s: string): string => s.replace(TOKEN_RE, '<token>')

const usageError = (message: string, detail?: string): SbError => new SbError(message, EXIT.USAGE, detail)
const checkError = (message: string, detail?: string): SbError => new SbError(message, EXIT.CHECK_FAILED, detail)

const legacyDir = (p: Paths): string => join(p.claudeDir, 'contas')
const fixasDir = (p: Paths): string => join(p.claudeDir, 'contas-fixas')
const contaMdFile = (p: Paths): string => join(p.claudeDir, 'commands', 'conta.md')

export interface MigrationPlan {
  /** contas a gravar em `tokens/`: de onde (só o caminho) e com que nome; NUNCA o valor */
  tokens: Array<{ from: string; account: string }>
  /** contas que parecem a mesma (mesmo token); o aplicar acrescenta as de mesma impressão numa medição */
  likelyDuplicates: string[][]
  /** a config resultante inteira (a do usuário mesclada com o que a migração acrescenta) */
  config: Config
  rewrites: Array<{ jobId: string; from: string; to: string; when: 'now' | 'when-free' }>
  stopVigia: number | null
  zshrc: { remove: string; add: string } | null
  command: { remove: string; add: string }
  backup: string
  /** `sb agents <mux>` para cada aba (view) aberta */
  reopen: string[]
  /** links `mux/<mux>.json` a criar (mux novo) ou refazer (mux coberto cujo link sumiu) */
  links: Array<{ mux: string; account: string }>
  warnings: string[]
}

export interface MigrationResult {
  backup: string
  /** contas gravadas em `tokens/` agora */
  tokens: string[]
  /** muxes acrescentados à config agora */
  muxes: string[]
  rewrites: Array<{ jobId: string; result: 'rewritten' | 'queued' | 'unchanged' | 'gone' | 'failed'; message?: string }>
  vigia: 'none' | 'stopped' | 'failed'
  zshrc: 'replaced' | 'unchanged'
  command: 'moved' | 'absent'
  install: InstallResult
  likelyDuplicates: string[][]
  reopen: string[]
  warnings: string[]
}

export interface MigrateDeps {
  /** o `sb install` (grava wrapper/plist/`sb.md` e carrega o LaunchAgent); injetado para o núcleo não conhecer o `argv` */
  install(ctx: Ctx): InstallResult
  /** as precondições do `install` (ex.: `claude` no PATH): lança antes de a migração escrever qualquer coisa */
  check?(ctx: Ctx): void
}

// ------------------------------------------------------------------------------------------------------- leitura

/**
 * A ÚNICA leitura de segredo da migração: `~/.claude/contas/<name>.json` → `env.CLAUDE_CODE_OAUTH_TOKEN`. `null` se o
 * arquivo não existe, não é JSON, não tem token ou o nome tenta sair de `contas/`. Nunca lança nem devolve parte do arquivo.
 */
export function readLegacyToken(paths: Paths, name: string): string | null {
  if (name === '' || name === '.' || name === '..' || /[\\/\0]/.test(name)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(legacyDir(paths), `${name}.json`), 'utf8'))
  } catch {
    return null
  }
  const env = (raw as { env?: unknown } | null)?.env
  const token = (env as { CLAUDE_CODE_OAUTH_TOKEN?: unknown } | null | undefined)?.CLAUDE_CODE_OAUTH_TOKEN
  return typeof token === 'string' && token !== '' ? token : null
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const exists = (p: string): boolean => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

const readIfExists = (p: string): string | undefined => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

/** Nomes (sem `.json`) dos arquivos de conta em `contas/`, menos `ativa` e `padrao`; ordenados. */
function legacyAccountNames(paths: Paths): string[] {
  const out: string[] = []
  for (const f of readdirSync(legacyDir(paths))) {
    if (!f.endsWith('.json')) continue
    const name = f.slice(0, -'.json'.length)
    if (name === 'ativa' || name === 'padrao') continue
    try {
      if (!statSync(join(legacyDir(paths), f)).isFile()) continue
    } catch {
      continue // link pendurado
    }
    out.push(name)
  }
  return out.sort()
}

/** A conta ativa do claude-conta: o alvo do symlink `ativa.json`. `padrao` é o keychain. `null` = não deu para saber. */
function activeAccount(paths: Paths, importable: string[]): string | null {
  let target: string
  try {
    target = readlinkSync(join(legacyDir(paths), 'ativa.json'))
  } catch {
    return null
  }
  const name = basename(target).replace(/\.json$/, '')
  if (name === 'padrao') return KEYCHAIN
  return importable.includes(name) ? name : null
}

const normPath = (raw: string, home: string): string | null => (/^(\/|~$|~\/)/.test(raw) ? normalizeRoot(raw, home) : null)

function tildify(p: string, home: string): string {
  const h = resolve(home)
  if (p === h) return '~'
  return p.startsWith(h + sep) ? `~${p.slice(h.length)}` : p
}

function within(root: string, dir: string): boolean {
  const rel = relative(root, dir)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Raízes de `contas/excluir` (uma por linha; `#` comenta): ficam no keychain. Ordenadas e sem repetição. */
function excludedRoots(paths: Paths, warnings: string[]): Array<{ norm: string; root: string }> {
  const text = readIfExists(join(legacyDir(paths), 'excluir'))
  const seen = new Map<string, string>()
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const norm = normPath(line, paths.home)
    if (norm === null) {
      warnings.push(`excluir: a linha ${JSON.stringify(redact(line).slice(0, 80))} não é um caminho absoluto nem começa por ~; ignorada`)
      continue
    }
    seen.set(norm, tildify(norm, paths.home))
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([norm, root]) => ({ norm, root }))
}

/** `--cwd X` / `--cwd=X` dos argumentos de uma view. */
function cwdOf(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--cwd') return args[i + 1]
    if (a.startsWith('--cwd=')) return a.slice('--cwd='.length)
  }
  return undefined
}

/** Nome de mux válido a partir do basename da pasta; `null` se nada aproveitável sobra. */
function muxNameFrom(path: string): string | null {
  const s = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+/, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return NAME_RE.test(s) ? s : null
}

/** Nome livre: o próprio, ou com `-2`, `-3`…; sem nome aproveitável, `<reserva>-1`, `<reserva>-2`… */
function allocateName(base: string | null, taken: Set<string>, fallback: string): string {
  let name: string
  if (base === null) {
    let n = 1
    while (taken.has(`${fallback}-${n}`)) n++
    name = `${fallback}-${n}`
  } else if (!taken.has(base)) name = base
  else {
    let n = 2
    for (;;) {
      const suffix = `-${n}`
      name = `${base.slice(0, 32 - suffix.length)}${suffix}`
      if (!taken.has(name)) break
      n++
    }
  }
  taken.add(name)
  return name
}

/** pid do vigia do claude-conta SE ele está vivo E a linha de comando dele contém `_vigiar` (o pid pode ter sido reaproveitado). */
function liveVigia(ctx: Ctx): number | null {
  const text = readIfExists(join(legacyDir(ctx.paths), 'vigia.pid'))
  const pid = text === undefined ? NaN : Number(text.trim())
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return null
  if (!isAlive(pid)) return null
  return psTable(ctx).some((r) => r.pid === pid && r.command.includes('_vigiar')) ? pid : null
}

const stampOf = (ctx: Ctx, prefix: string): string => `${prefix}-${new Date(ctx.now()).toISOString().replace(/[:.]/g, '-')}`

/** Diretório de backup que ainda não existe (sufixo `-2`, `-3`…): um backup anterior nunca é reaproveitado. */
function freshBackupDir(ctx: Ctx, prefix: string): string {
  const base = stampOf(ctx, prefix)
  for (let n = 1; ; n++) {
    const dir = backupDir(ctx.paths, n === 1 ? base : `${base}-${n}`)
    if (!exists(dir)) return dir
  }
}

// ------------------------------------------------------------------------------------------------------- plano

/**
 * Calcula a migração SEM escrever nada (lê o legado, a config do sb, `ps` e `claude agents`). Recusas: sem
 * `~/.claude/contas` (exit 3), sem nenhuma view `claude agents --cwd` aberta e sem `default` na config (exit 3: o mux
 * `default` não pode ser o do keychain), config do sb inválida (exit 2), `claude agents` ilegível (exit 4).
 */
export async function planMigration(ctx: Ctx): Promise<MigrationPlan> {
  const { paths } = ctx
  const home = paths.home
  if (!isDir(legacyDir(paths))) {
    throw usageError(`nada a migrar: ${legacyDir(paths)} não existe`, '  o claude-conta não está instalado aqui, ou a migração já foi finalizada com `sb migrate --finish`')
  }
  const warnings: string[] = []
  const existing: Config | null = existsSync(paths.configFile) ? await loadConfig(paths) : null

  // contas: o valor do token só vive neste Map, em memória
  const secrets = new Map<string, string>()
  for (const name of legacyAccountNames(paths)) {
    if (!NAME_RE.test(name)) {
      warnings.push(`conta ${JSON.stringify(name)} ignorada: o nome tem que ser minúsculas, números, - e _ (até 32); renomeie o arquivo e rode de novo`)
      continue
    }
    if (name === KEYCHAIN) {
      warnings.push('conta "keychain" ignorada: o nome é reservado (é a conta do keychain do Claude Code)')
      continue
    }
    const token = readLegacyToken(paths, name)
    if (token === null) {
      warnings.push(`conta "${name}" ignorada: o arquivo não tem um CLAUDE_CODE_OAUTH_TOKEN legível`)
      continue
    }
    secrets.set(name, token)
  }
  const importable = [...secrets.keys()]
  if (importable.length === 0) warnings.push('nenhuma conta com token em ~/.claude/contas: os muxes ficam no keychain')

  const byToken = new Map<string, string[]>()
  for (const [name, token] of secrets) byToken.set(token, [...(byToken.get(token) ?? []), name])
  const likelyDuplicates = [...byToken.values()].filter((g) => g.length >= 2).sort((a, b) => (a[0]! < b[0]! ? -1 : 1))

  const tokens: MigrationPlan['tokens'] = []
  for (const name of importable) {
    const have = loadSecret(paths, name)
    if (have === null) tokens.push({ from: join(legacyDir(paths), `${name}.json`), account: name })
    else if (have !== secrets.get(name)) warnings.push(`a conta "${name}" já existe no sb com outro token: mantive a do sb (o token do claude-conta não foi importado)`)
  }

  let active = activeAccount(paths, importable)
  if (active === null) {
    active = importable[0] ?? KEYCHAIN
    warnings.push(`não consegui saber a conta ativa (ativa.json ausente, pendurado ou apontando para uma conta não importada): usei "${active}"`)
  }
  const viewAccounts = active === KEYCHAIN ? [KEYCHAIN, ...importable] : importable
  const pool = active === KEYCHAIN ? [] : [active, ...importable.filter((a) => a !== active)]

  // muxes: o que o usuário já tem fica; entra só o que falta
  const existingRoots = new Map<string, string>() // raiz normalizada → mux
  for (const [name, m] of Object.entries(existing?.mux ?? {})) existingRoots.set(normalizeRoot(m.root, home), name)
  const taken = new Set(Object.keys(existing?.mux ?? {}))
  const created: Record<string, Config['mux'][string]> = {}
  const links: MigrationPlan['links'] = []
  const registered = new Set([...Object.keys(existing?.accounts ?? {}), ...importable])
  const usable = (account: string): boolean => account === KEYCHAIN || hasToken(paths, account) || secrets.has(account)
  const covered = (mux: string): void => {
    const m = existing!.mux[mux]!
    if (!exists(muxLink(paths, mux)) && (m.account === KEYCHAIN || registered.has(m.account)) && usable(m.account) && !links.some((l) => l.mux === mux)) links.push({ mux, account: m.account })
  }

  const excluded = excludedRoots(paths, warnings)
  for (const e of excluded) {
    const have = existingRoots.get(e.norm)
    if (have !== undefined) {
      covered(have)
      continue
    }
    const base = muxNameFrom(e.norm)
    const name = allocateName(base, taken, 'keychain')
    if (base !== name) warnings.push(`a pasta ${e.root} (keychain) virou o mux "${name}" (o nome da pasta colide ou não serve como nome de mux)`)
    created[name] = { root: e.root, account: KEYCHAIN, accounts: [KEYCHAIN], pool: [] }
    links.push({ mux: name, account: KEYCHAIN })
  }

  const views: Array<{ pid: number; norm: string }> = []
  for (const v of listViews(ctx)) {
    const raw = cwdOf(v.args)
    if (raw === undefined) {
      warnings.push(`a view do \`claude agents\` (pid ${v.pid}) não tem --cwd: não sei a pasta dela; reabra com \`sb agents <mux>\``)
      continue
    }
    const norm = normPath(raw, home)
    if (norm === null) {
      warnings.push(`a view do \`claude agents\` (pid ${v.pid}) tem um --cwd relativo: não sei a pasta dela; reabra com \`sb agents <mux>\``)
      continue
    }
    if (!isDir(norm)) {
      // ex.: caminho com espaço, que o ps/split corta: a raiz errada viraria um mux (ou o default) que nunca casa com a pasta de verdade
      warnings.push(`a view do \`claude agents\` (pid ${v.pid}) tem um --cwd que não é uma pasta existente (${tildify(norm, home)}); ignorada (caminho com espaço?); reabra com \`sb agents <mux>\``)
      continue
    }
    if (!views.some((x) => x.norm === norm)) views.push({ pid: v.pid, norm })
  }
  views.sort((a, b) => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0))

  const viewMuxes: string[] = []
  for (const v of views) {
    const root = tildify(v.norm, home)
    const inKeychain = excluded.find((e) => within(e.norm, v.norm))
    if (inKeychain !== undefined) {
      // um mux de conta aqui arrastaria a pasta do keychain para outra conta: a view usa o mux do keychain
      warnings.push(`a view em ${root} está dentro de ${inKeychain.root} (keychain): coberta pelo mux do keychain, sem mux próprio`)
      continue
    }
    const have = existingRoots.get(v.norm)
    if (have !== undefined) {
      covered(have)
      continue
    }
    const base = muxNameFrom(v.norm)
    const name = allocateName(base, taken, 'mux')
    if (base !== name) warnings.push(`a pasta ${root} virou o mux "${name}" (o nome da pasta colide ou não serve como nome de mux)`)
    created[name] = { root, account: active, accounts: viewAccounts, pool }
    links.push({ mux: name, account: active })
    viewMuxes.push(name)
  }

  const def = existing?.default ?? viewMuxes.slice().sort()[0]
  if (def === undefined) {
    throw views.length === 0
      ? usageError(
          'não achei nenhuma view `claude agents --cwd <pasta>` aberta (com pasta que exista): sem ela não sei qual mux deve ser o `default` (ele não pode ser o do keychain: toda pasta sem mux cairia no berzerk)',
          '  abra no cmux o `claude agents` de cada aba e rode `sb migrate --simular` de novo',
        )
      : usageError(
          'a config não tem `default` e nenhuma view aberta serve para criá-lo: elas estão dentro de raízes do keychain (excluir) ou já cobertas por muxes existentes (o `default` não pode ser o mux do keychain)',
          '  abra o `claude agents` de uma pasta fora do keychain, ou defina o default na config (`sb mux set <nome> --default`), e rode `sb migrate --simular` de novo',
        )
  }

  const raw = {
    ...(existing?.$schema !== undefined && { $schema: existing.$schema }),
    switchboard: 1,
    accounts: { ...(existing?.accounts ?? {}), ...Object.fromEntries(importable.filter((a) => !(a in (existing?.accounts ?? {}))).map((a) => [a, {}])) },
    ...(existing !== null && { swap: existing.swap }),
    default: def,
    mux: { ...(existing?.mux ?? {}), ...created },
  }
  const config = parseConfig(JSON.stringify(raw), paths.configFile, home)

  // sessões: o destino de cada uma sai dos flags dela (a mesma função que o `watch` usa ao aplicar a fila)
  const rewrites: MigrationPlan['rewrites'] = []
  const loaded = loadSessionsWithWarnings(ctx)
  for (const id of loaded.unreadable) {
    warnings.push(`sessão ${id}: state.json ilegível; não dá para saber se é do claude-conta (o --finish recusa enquanto ela existir)`)
  }
  for (const s of [...loaded.sessions].sort((a, b) => (a.agent.id < b.agent.id ? -1 : 1))) {
    if (s.job === null || s.owner.kind !== 'legacy') continue
    const src = legacySource(s.job.respawnFlags, paths)
    try {
      const t = migrationTarget(paths, config, s)
      rewrites.push({ jobId: s.agent.id, from: join(paths.claudeDir, src!.dir, `${src!.name}.json`), to: t.link, when: s.live ? 'when-free' : 'now' })
    } catch (e) {
      if (!(e instanceof SbError)) throw e
      warnings.push(`sessão ${s.agent.id}: ${redact(e.message)}`)
    }
  }

  const reopen = new Set<string>()
  for (const v of views) reopen.add(`sb agents ${resolveMuxForDir(config, v.norm, home)}`)

  const zshrcText = readIfExists(paths.zshrc)
  const oldLines = (zshrcText ?? '').split('\n').filter((l) => l.includes(OLD_MARK))

  return {
    tokens,
    likelyDuplicates,
    config,
    rewrites,
    stopVigia: liveVigia(ctx),
    zshrc: oldLines.length > 0 ? { remove: redact(oldLines.join('\n')), add: zshrcLine(wrapperFile(paths)) } : null,
    command: { remove: contaMdFile(paths), add: slashCommandFile(paths) },
    backup: freshBackupDir(ctx, 'migrate'),
    reopen: [...reopen].sort(),
    links,
    warnings,
  }
}

// ----------------------------------------------------------------------------------------------------- aplicar

/** Copia `src` para `dst` sem seguir links; diretórios 700, arquivos 600; link absoluto para dentro do legado aponta para a cópia. */
function copyTree(src: string, dst: string, remap: Array<[string, string]>): void {
  const st = lstatSync(src)
  if (st.isSymbolicLink()) {
    let target = readlinkSync(src)
    if (isAbsolute(target)) {
      for (const [from, to] of remap) {
        if (target === from || target.startsWith(from + sep)) {
          target = to + target.slice(from.length)
          break
        }
      }
    }
    symlinkSync(target, dst)
  } else if (st.isDirectory()) {
    mkdirPrivate(dst)
    for (const name of readdirSync(src)) copyTree(join(src, name), join(dst, name), remap)
  } else if (st.isFile()) {
    copyFileSync(src, dst)
    chmodSync(dst, 0o600)
  }
}

function configEdits(fresh: { accounts: Record<string, unknown>; mux: Record<string, unknown>; default?: string | undefined }, target: Config): ConfigEdit[] {
  const edits: ConfigEdit[] = []
  for (const a of Object.keys(target.accounts)) if (!(a in fresh.accounts)) edits.push({ path: ['accounts', a], value: {} })
  for (const [name, m] of Object.entries(target.mux)) if (!(name in fresh.mux)) edits.push({ path: ['mux', name], value: m })
  if (fresh.default === undefined && target.default !== undefined) edits.push({ path: ['default'], value: target.default })
  return edits
}

/** Aplica as edições num objeto (sem tocar no disco) e valida o resultado com o mesmo parser da config. */
function validateEdits(ctx: Ctx, base: Config | null, edits: ConfigEdit[]): void {
  const obj: Record<string, unknown> & { accounts: Record<string, unknown>; mux: Record<string, unknown> } = {
    ...(base ?? { switchboard: 1 }),
    accounts: { ...(base?.accounts ?? {}) },
    mux: { ...(base?.mux ?? {}) },
  }
  for (const e of edits) {
    if (e.path[0] === 'accounts') obj.accounts[String(e.path[1])] = e.value
    else if (e.path[0] === 'mux') obj.mux[String(e.path[1])] = e.value
    else if (e.path[0] === 'default') obj.default = e.value
  }
  parseConfig(JSON.stringify(obj), ctx.paths.configFile, ctx.paths.home)
}

/** Grupos que se tocam viram um só (A~B e B~C → A,B,C); cada grupo e a lista, ordenados. */
function mergeGroups(groups: string[][]): string[][] {
  const out: Set<string>[] = []
  for (const g of groups) {
    const hit = out.filter((s) => g.some((a) => s.has(a)))
    const merged = new Set<string>(g)
    for (const s of hit) {
      for (const a of s) merged.add(a)
      out.splice(out.indexOf(s), 1)
    }
    out.push(merged)
  }
  return out.map((s) => [...s].sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1))
}

function note(ctx: Ctx, line: string): void {
  try {
    ctx.log('watch', redact(line))
  } catch {
    // o log é só informativo
  }
}

/**
 * Aplica o plano, SOB O LOCK. Ordem (as recusas primeiro, depois só passos aditivos/idempotentes, o legado por último):
 * recusas → backup (cópia) → tokens → config (só o que falta) → links → sessões (paradas reescritas, vivas na fila) → vigia →
 * linha do `~/.zshrc` → `conta.md` → `sb install` → medição (duplicatas). Não confia no plano para nada que muda: relê os
 * tokens, recalcula o destino de cada sessão, confere o vigia de novo e usa a config do disco.
 */
export async function applyMigration(ctx: Ctx, plan: MigrationPlan, deps: MigrateDeps): Promise<MigrationResult> {
  // as precondições do `sb install` (passo 9) antes do lock e de qualquer escrita: sem elas o install lançaria no fim, com o zshrc
  // e o `conta.md` já trocados e novos terminais com um `claude` que recusa
  deps.check?.(ctx)
  return withLock(ctx.paths, async () => {
    const { paths } = ctx
    const warnings = [...plan.warnings]
    if (!isDir(legacyDir(paths))) throw usageError(`nada a migrar: ${legacyDir(paths)} não existe`)
    if (dirname(plan.backup) !== join(paths.stateDir, 'backup') || exists(plan.backup)) {
      throw checkError(`o diretório de backup do plano não serve (${plan.backup}); rode \`sb migrate --simular\` de novo`)
    }

    // 0. recusas, antes de qualquer escrita
    const secrets = new Map<string, string>()
    for (const t of plan.tokens) {
      assertSafeName(t.account)
      const token = readLegacyToken(paths, t.account)
      if (token === null) throw checkError(`o token da conta "${t.account}" em ~/.claude/contas sumiu ou ficou ilegível desde o plano`, '  rode `sb migrate --simular` de novo')
      secrets.set(t.account, token)
    }
    const fresh: Config | null = existsSync(paths.configFile) ? await loadConfig(paths) : null
    const edits = configEdits(fresh ?? { accounts: {}, mux: {} }, plan.config)
    validateEdits(ctx, fresh, edits)
    for (const l of plan.links) {
      assertSafeName(l.mux)
      assertSafeName(l.account)
    }

    // 1. backup: cópia privada do legado (a única cópia de token fora de tokens/) e do zshrc
    mkdirPrivate(paths.stateDir)
    mkdirPrivate(join(paths.stateDir, 'backup'))
    mkdirPrivate(plan.backup)
    const remap: Array<[string, string]> = [
      [legacyDir(paths), join(plan.backup, 'contas')],
      [fixasDir(paths), join(plan.backup, 'contas-fixas')],
    ]
    if (exists(legacyDir(paths))) copyTree(legacyDir(paths), join(plan.backup, 'contas'), remap)
    if (exists(fixasDir(paths))) copyTree(fixasDir(paths), join(plan.backup, 'contas-fixas'), remap)
    if (exists(contaMdFile(paths))) copyTree(contaMdFile(paths), join(plan.backup, 'conta.md'), remap)
    if (exists(paths.zshrc)) copyFileSync(paths.zshrc, join(plan.backup, 'zshrc'))
    if (exists(join(plan.backup, 'zshrc'))) chmodSync(join(plan.backup, 'zshrc'), 0o600)

    // 2. tokens (o valor vai direto de readLegacyToken para saveToken)
    ensureState(paths)
    const imported: string[] = []
    for (const [account, token] of secrets) {
      if (loadSecret(paths, account) !== null) continue // já existe (outra rodada, ou o usuário criou): nunca sobrescreve
      saveToken(paths, account, token)
      imported.push(account)
    }

    // 3. config: só as edições que faltam, no texto do usuário
    const createdConfig = !existsSync(paths.configFile)
    if (createdConfig) await ensureConfig(paths)
    try {
      if (edits.length > 0) await editConfig(paths, edits)
    } catch (e) {
      if (createdConfig) rmSync(paths.configFile, { force: true })
      throw e
    }
    const cfg = await loadConfig(paths)
    const newMuxes = Object.keys(plan.config.mux).filter((m) => !(m in (fresh?.mux ?? {})))

    // 4. links: mux novo aponta para a preferida; mux que já existia só ganha o link se ele sumiu (um swap em curso não se desfaz)
    for (const l of plan.links) {
      if (!(l.mux in cfg.mux)) continue
      if (l.account !== KEYCHAIN && !hasToken(paths, l.account)) throw checkError(`a conta "${l.account}" do mux "${l.mux}" não tem token em tokens/`)
      if (newMuxes.includes(l.mux) || !exists(muxLink(paths, l.mux))) pointMux(paths, l.mux, l.account)
      const check = checkSettingsTarget(muxLink(paths, l.mux))
      if (!check.ok) throw checkError(`o link do mux "${l.mux}" ficou inválido (${check.problem}); rode \`sb doctor --fix\``)
    }

    // 5. sessões: paradas reescritas, vivas na fila (nunca se pára nenhuma aqui)
    const rewrites: MigrationResult['rewrites'] = []
    for (const r of plan.rewrites) {
      try {
        rewrites.push({ jobId: r.jobId, result: migrateSession(ctx, cfg, r.jobId) })
      } catch (e) {
        if (!(e instanceof SbError)) throw e
        rewrites.push({ jobId: r.jobId, result: 'failed', message: redact(e.message) })
        warnings.push(`sessão ${r.jobId}: não reescrita (${redact(e.message)})`)
      }
    }

    // 6. vigia do claude-conta: só se o pid AINDA é do _vigiar (o plano pode estar velho)
    let vigia: MigrationResult['vigia'] = 'none'
    if (plan.stopVigia !== null && liveVigia(ctx) === plan.stopVigia) {
      vigia = ctx.run('kill', [String(plan.stopVigia)]).status === 0 ? 'stopped' : 'failed'
      if (vigia === 'failed') warnings.push(`não consegui parar o vigia do claude-conta (pid ${plan.stopVigia}); pare-o à mão: kill ${plan.stopVigia}`)
    }

    // 7. ~/.zshrc: a linha do claude-conta vira a do sb (a cópia está no backup). Antes disso o `sb install` se recusaria a mexer no arquivo.
    let zshrc: MigrationResult['zshrc'] = 'unchanged'
    const current = readIfExists(paths.zshrc)
    if (current !== undefined && current.split('\n').some((l) => l.includes(OLD_MARK))) {
      const line = zshrcLine(wrapperFile(paths))
      const out: string[] = []
      let placed = current.split('\n').some((l) => l.trimEnd() === line) // já há uma linha do sb: a do claude-conta só sai
      for (const l of current.split('\n')) {
        if (!l.includes(OLD_MARK)) out.push(l)
        else if (!placed) {
          out.push(line)
          placed = true
        }
      }
      writeAtomic(paths.zshrc, out.join('\n'), statSync(paths.zshrc).mode & 0o777)
      zshrc = 'replaced'
    }

    // 8. /conta → backup; o /sb nasce no install
    let command: MigrationResult['command'] = 'absent'
    if (exists(contaMdFile(paths))) {
      // a cópia (ou o link, copiado como link) já está no backup desde o passo 1; aqui só sai o original, sem seguir link
      rmSync(contaMdFile(paths))
      command = 'moved'
    }

    // 9. sb install (wrapper, plist, sb.md, launchctl)
    let install: InstallResult
    try {
      install = deps.install(ctx)
    } catch (e) {
      if (!(e instanceof SbError)) throw e
      throw new SbError(`a migração foi aplicada, mas o \`sb install\` falhou: ${redact(e.message)}`, e.exit, '  rode `sb install` (e `sb migrate` de novo, se faltar algo); o claude-conta continua inteiro no backup e em ~/.claude/contas')
    }

    // 10. duplicatas por impressão (uma medição por token distinto). Falhar aqui não desfaz nada.
    let likely = plan.likelyDuplicates
    try {
      const usage = await measureAll(ctx, cfg, { maxAgeMs: 60_000 })
      const byPrint = new Map<string, string[]>()
      for (const a of Object.keys(cfg.accounts)) {
        const fp = fingerprint(usage.latest[a])
        if (fp !== null) byPrint.set(fp, [...(byPrint.get(fp) ?? []), a])
      }
      likely = mergeGroups([...plan.likelyDuplicates, ...[...byPrint.values()].filter((g) => g.length >= 2)])
    } catch {
      warnings.push('não consegui medir o uso das contas para procurar duplicatas; rode `sb usage`')
    }

    note(ctx, `migrate: ${imported.length} conta(s) importada(s), ${newMuxes.length} mux(es) novo(s), ${rewrites.length} sessão(ões); backup em ${plan.backup}`)
    return { backup: plan.backup, tokens: imported.sort(), muxes: newMuxes, rewrites, vigia, zshrc, command, install, likelyDuplicates: likely, reopen: plan.reopen, warnings }
  })
}

// ------------------------------------------------------------------------------------------------------ finish

export interface FinishResult {
  simulated: boolean
  /** o que foi (ou seria) movido */
  moved: string[]
  /** onde foi parar (diretório de backup); `null` se não havia nada a mover */
  to: string | null
}

/**
 * Quem ainda aponta para `~/.claude/contas*`, ou a migração que ainda não aconteceu — cada linha é um motivo para NÃO mover:
 *   - a linha `# claude-conta` ainda está no `~/.zshrc` (sem `contas/` o `[ -f … ] && source` pula calado e todo `claude` novo
 *     roda no keychain: a conta do berzerk);
 *   - não há config do sb, ou nenhuma conta importada em `tokens/` (a migração evidentemente não foi aplicada);
 *   - sessão em segundo plano com `--settings` legado; sessão cujo `state.json` EXISTE e não se lê (não dá para provar que não
 *     é legado; sem `state.json` nenhum ela não tem flags e não conta); pedido `migrate` na fila; view do `claude agents` com o
 *     settings do claude-conta;
 *   - o `ps` falhou (sem a tabela não dá para dizer que não há view legada).
 */
function legacyBlockers(ctx: Ctx): string[] {
  const { paths } = ctx
  const lines: string[] = []
  const zshrc = readIfExists(paths.zshrc) ?? ''
  if (zshrc.split('\n').some((l) => l.includes(OLD_MARK))) {
    lines.push(`o ${paths.zshrc} ainda tem a linha "# claude-conta": sem ~/.claude/contas todo \`claude\` novo rodaria no keychain (rode \`sb migrate\`)`)
  }
  if (!existsSync(paths.configFile)) lines.push(`não há config do sb (${paths.configFile}): a migração não foi aplicada (rode \`sb migrate\`)`)
  const legacyNames = legacyAccountNames(paths).filter((n) => NAME_RE.test(n) && n !== KEYCHAIN && readLegacyToken(paths, n) !== null)
  if (legacyNames.length > 0 && !legacyNames.some((n) => loadSecret(paths, n) !== null)) {
    lines.push('nenhuma conta do claude-conta foi importada para tokens/ do sb: a migração não foi aplicada (rode `sb migrate`)')
  }
  const { sessions, unreadable } = loadSessionsWithWarnings(ctx)
  const legacy = sessions.filter((s) => s.owner.kind === 'legacy').map((s) => s.agent.id)
  if (legacy.length > 0) lines.push(`sessões ainda no settings do claude-conta: ${legacy.join(', ')}`)
  if (unreadable.length > 0) lines.push(`sessões com state.json ilegível (não dá para provar que não são do claude-conta; \`claude rm\` as que sobraram): ${unreadable.join(', ')}`)
  const queued = readRuntime(paths).pending.filter((i) => i.reason === 'migrate').map((i) => i.jobId)
  if (queued.length > 0) lines.push(`sessões vivas na fila da migração (o watch as PARA e reescreve quando ficarem livres): ${queued.join(', ')}`)
  const ps = psSnapshot(ctx)
  if (!ps.ok) lines.push('não consegui ler a tabela de processos (`ps` falhou): sem ela não dá para saber se há views do `claude agents` ainda no settings do claude-conta')
  const views = viewsIn(ctx, ps.rows).filter((v) => ownershipOf(v.args, paths).kind === 'legacy').map((v) => `pid ${v.pid}`)
  if (views.length > 0) lines.push(`views do \`claude agents\` abertas com o settings do claude-conta (reabra com \`sb agents <mux>\`): ${views.join(', ')}`)
  return lines
}

/**
 * `sb migrate --finish`: move `~/.claude/contas` e `~/.claude/contas-fixas` para `backup/finish-<data>/` (nada é apagado).
 * Recusa (exit 1, com a lista) enquanto algo ainda apontar para lá, senão uma sessão parada não reabriria. `simular` só confere.
 */
export async function finishMigration(ctx: Ctx, opts: { simular?: boolean } = {}): Promise<FinishResult> {
  const simulated = opts.simular === true
  const run = async (): Promise<FinishResult> => {
    const { paths } = ctx
    const sources = [legacyDir(paths), fixasDir(paths)].filter(exists)
    if (sources.length === 0) return { simulated, moved: [], to: null }
    const blockers = legacyBlockers(ctx)
    if (blockers.length > 0) {
      throw checkError('ainda há quem aponte para o claude-conta: nada foi movido', blockers.map((b) => `  ${b}`).join('\n'))
    }
    const to = freshBackupDir(ctx, 'finish')
    if (simulated) return { simulated, moved: sources, to }
    mkdirPrivate(paths.stateDir)
    mkdirPrivate(join(paths.stateDir, 'backup'))
    mkdirPrivate(to)
    const moved: string[] = []
    for (const src of sources) {
      try {
        renameSync(src, join(to, basename(src)))
      } catch (e) {
        throw checkError(`não consegui mover ${src} para ${to} (${(e as NodeJS.ErrnoException).code ?? 'erro'}); ${moved.length > 0 ? `já movi: ${moved.join(', ')}` : 'nada foi movido'}`)
      }
      moved.push(src)
    }
    note(ctx, `migrate --finish: ${moved.length} diretório(s) movido(s) para ${to}`)
    return { simulated, moved, to }
  }
  return simulated ? run() : withLock(ctx.paths, run)
}
