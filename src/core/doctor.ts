import { chmodSync, existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { claudeBin } from './claude.js'
import { InvalidConfigError, loadConfig, type Config } from './config.js'
import type { Ctx } from './ctx.js'
import { SbError } from './errors.js'
import { ADOPT_QUEUED_NOTE, type Finding, type FindingCode, type Severity } from './findings.js'
import { isAlive, mkdirPrivate, writeAtomic } from './fsx.js'
import { ownershipOf } from './jobs.js'
import { checkSettingsTarget, currentAccount, ensurePin, pointMux, type TargetProblem } from './links.js'
import { resolveMuxForDir } from './mux.js'
import { assertSafeName, muxLink, pinLink, tokenFile } from './paths.js'
import { adoptSession } from './pin.js'
import { readRuntime } from './runtime.js'
import { NAME_RE } from './schema.js'
import { loadSessionsWithWarnings, type Session } from './sessions.js'
import { KEYCHAIN, SUBDIRS, tokenStatus } from './tokens.js'
import { readUsage } from './usage.js'
import { watchStatus } from './watch.js'

// ---------------------------------------------------------------------------------------------------------------
// `sb doctor`: acha todo estado em que uma sessão poderia rodar CALADA na conta errada (link quebrado, JSON de token
// inválido, sessão ou view sem `--settings`: F6) e a higiene em volta; `--fix` conserta o que é seguro. `diagnose` só
// LÊ (nada de `ensureState`, sonda ou lock) e nunca inclui conteúdo de arquivo de token nem a linha de comando de um
// processo (um `--settings` inline pode ter token). `fix` EXIGE O LOCK JÁ TOMADO pelo chamador.
// Assunto (`subject`) de cada código: `config`, conta (`config.no-token`, `token.*`, `account.unattached`), `mux/<mux>` e
// `pins/<conta>` (`link.*`), `tokens/<conta>` (`link.orphan` de token), `estado` ou o subdiretório (`state.perms`), mux
// (`pool.*`), id da sessão (`session.*`, `claude.format` de uma sessão), `pid <n>` (`view.*`), `watch` e `claude`.
// ---------------------------------------------------------------------------------------------------------------

export interface FixAction {
  code: FindingCode
  subject: string
  ok: boolean
  message: string
}

const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]+/g
const redact = (s: string): string => s.replace(TOKEN_RE, '<token>')

/** `SWITCHBOARD_PS` (binário de teste) ou o `ps` do sistema. */
const psBin = (env: Ctx['env']): string => env.SWITCHBOARD_PS || 'ps'

type Add = (severity: Severity, code: FindingCode, subject: string, message: string) => void

/** Nomes (sem `.json`) dos `*.json` de um diretório do estado com nome de conta/mux válido; ausente → vazio. */
function jsonNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json') && NAME_RE.test(f.slice(0, -'.json'.length)))
      .map((f) => f.slice(0, -'.json'.length))
      .sort()
  } catch {
    return []
  }
}

const modeOf = (path: string): number | null => {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return null
  }
}

const octal = (m: number): string => m.toString(8).padStart(3, '0')

// ---------------------------------------------------------------------------------------------------------- estado

function checkStatePerms(ctx: Ctx, add: Add): void {
  const dirs: Array<[string, string]> = [['estado', ctx.paths.stateDir], ...SUBDIRS.map((d): [string, string] => [d, join(ctx.paths.stateDir, d)])]
  for (const [subject, dir] of dirs) {
    const m = modeOf(dir)
    if (m !== null && m !== 0o700) add('warn', 'state.perms', subject, `${dir} está em ${octal(m)}; deveria ser 700 (guarda tokens)`)
  }
}

// ---------------------------------------------------------------------------------------------------------- tokens

/** `tokens/keychain.json` só pode ser `{}`: qualquer outra coisa faria a sessão do mux keychain rodar noutra conta. */
function keychainFileState(ctx: Ctx): 'absent' | 'empty' | 'other' {
  let text: string
  try {
    text = readFileSync(tokenFile(ctx.paths, KEYCHAIN), 'utf8')
  } catch {
    return 'absent'
  }
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0 ? 'empty' : 'other'
  } catch {
    return 'other'
  }
}

function checkTokens(ctx: Ctx, cfg: Config | null, add: Add): void {
  const files = jsonNames(join(ctx.paths.stateDir, 'tokens'))
  for (const name of files) {
    const m = modeOf(tokenFile(ctx.paths, name))
    if (m !== null && m !== 0o600) add('error', 'token.perms', name, `tokens/${name}.json está em ${octal(m)}; deveria ser 600 (o token ficaria legível por outros usuários)`)
  }
  if (files.includes(KEYCHAIN) && keychainFileState(ctx) === 'other') {
    add('error', 'token.invalid-json', KEYCHAIN, 'tokens/keychain.json deveria ser exatamente {}: com outro conteúdo a sessão do mux keychain rodaria noutra conta')
  }
  // sem config legível, vale o que há em tokens/
  const accounts = (cfg ? Object.keys(cfg.accounts) : files).filter((a) => a !== KEYCHAIN)
  const usage = readUsage(ctx.paths)
  for (const a of accounts) {
    if (!existsSync(tokenFile(ctx.paths, a))) {
      if (cfg) add('error', 'config.no-token', a, `a conta "${a}" está registrada mas não tem tokens/${a}.json: rode \`sb login ${a}\``)
      continue
    }
    switch (tokenStatus(ctx.paths, a)) {
      case 'invalid-json':
        add('error', 'token.invalid-json', a, `tokens/${a}.json não é um JSON válido de settings: o claude o ignoraria e a sessão cairia no keychain; rode \`sb login ${a}\``)
        break
      case 'missing':
        add('error', 'token.no-oauth', a, `tokens/${a}.json não tem env.CLAUDE_CODE_OAUTH_TOKEN; rode \`sb login ${a}\``)
        break
      case 'ok': {
        const last = usage.latest[a]
        if (last && !last.ok && last.error === 'dead-token') {
          add('error', 'token.dead', a, `a última medição de "${a}" foi recusada (HTTP ${last.httpStatus ?? 401}): o token foi revogado ou expirou; rode \`sb login ${a}\``)
        }
        break
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------------------ config

function checkConfigShape(ctx: Ctx, cfg: Config, add: Add): void {
  const usage = readUsage(ctx.paths)
  for (const [name, m] of Object.entries(cfg.mux)) {
    for (const g of usage.groups) {
      const inPool = g.filter((a) => m.pool.includes(a))
      if (inPool.length >= 2) add('warn', 'pool.duplicates', name, `no pool do mux "${name}", ${inPool.join(' e ')} são a mesma conta (mesmo uso medido) e contam como uma`)
    }
    if (m.pool.length > 0 && !m.pool.includes(m.account)) {
      add('warn', 'pool.preferred-outside', name, `a preferida "${m.account}" do mux "${name}" está fora do pool: ele nunca sai dela sozinho (confira se não é engano)`)
    }
  }
  const attached = new Set(Object.values(cfg.mux).flatMap((m) => m.accounts))
  for (const a of Object.keys(cfg.accounts)) {
    if (!attached.has(a)) add('warn', 'account.unattached', a, `a conta "${a}" está registrada mas nenhum mux a usa (\`sb attach ${a} <mux>\`)`)
  }
}

// ------------------------------------------------------------------------------------------------------------ links

const PROBLEM: Record<TargetProblem, string> = {
  'missing-link': 'o link não existe (um claude novo nem abriria)',
  broken: 'o link está quebrado (não aponta para um token em tokens/)',
  'invalid-json': 'o token do alvo tem JSON inválido: o claude ignoraria o settings e a sessão cairia no keychain',
  'no-oauth': 'o token do alvo não tem CLAUDE_CODE_OAUTH_TOKEN',
}

function targetAccount(link: string): string | null {
  try {
    return basename(readlinkSync(link)).replace(/\.json$/, '')
  } catch {
    return null
  }
}

function linkMessage(link: string, problem: TargetProblem): string {
  if (problem === 'invalid-json' && targetAccount(link) === KEYCHAIN) return 'o alvo (tokens/keychain.json) deveria ser exatamente {}: com outro conteúdo a sessão rodaria noutra conta'
  return PROBLEM[problem]
}

/**
 * Confere os links de um tipo. `names`: o que existe em disco + o que a config ou uma sessão exige. Quebrado e conhecido
 * (ou usado por uma sessão) → erro `link.broken`; desconhecido (saiu da config) → `link.orphan`.
 */
function checkLinkSet(ctx: Ctx, kind: 'mux' | 'pins', names: string[], known: (n: string) => boolean, used: Set<string>, add: Add): void {
  for (const name of names) {
    const link = kind === 'mux' ? muxLink(ctx.paths, name) : pinLink(ctx.paths, name)
    const chk = checkSettingsTarget(link)
    const isKnown = known(name)
    if (!chk.ok && (isKnown || used.has(name))) {
      add('error', 'link.broken', `${kind}/${name}`, `${kind}/${name}.json: ${linkMessage(link, chk.problem)}`)
    } else if (!isKnown) {
      add('warn', 'link.orphan', `${kind}/${name}`, `${kind}/${name}.json sobrou de ${kind === 'mux' ? 'um mux' : 'uma conta'} que saiu da config; apague se nenhuma sessão o usa`)
    }
  }
}

function checkLinks(ctx: Ctx, cfg: Config | null, sessions: Session[], add: Add): void {
  const usedMux = new Set<string>()
  const usedPins = new Set<string>()
  for (const s of sessions) {
    if (s.owner.kind === 'mux') usedMux.add(s.owner.mux)
    else if (s.owner.kind === 'pin') usedPins.add(s.owner.account)
  }
  const muxNames = [...new Set([...jsonNames(join(ctx.paths.stateDir, 'mux')), ...(cfg ? Object.keys(cfg.mux) : [])])].sort()
  checkLinkSet(ctx, 'mux', muxNames, (n) => !cfg || n in cfg.mux, usedMux, add)
  const pinNames = [...new Set([...jsonNames(join(ctx.paths.stateDir, 'pins')), ...usedPins])].sort()
  checkLinkSet(ctx, 'pins', pinNames, (n) => !cfg || n in cfg.accounts || n === KEYCHAIN, usedPins, add)
  // token de conta que saiu do registro (`sb accounts rm` apaga, mas um ajuste manual da config deixa o arquivo)
  if (cfg) {
    for (const name of jsonNames(join(ctx.paths.stateDir, 'tokens'))) {
      if (name !== KEYCHAIN && !(name in cfg.accounts)) add('warn', 'link.orphan', `tokens/${name}`, `tokens/${name}.json é de uma conta que não está mais na config; apague se não for mais usada`)
    }
  }
}

// ------------------------------------------------------------------------------------------------------ sessões, views

/** `claude agents` + `state.json`: formato recusado → `claude.format`; o que deu para ler segue para as outras checagens. */
function loadSessions(ctx: Ctx, add: Add): Session[] {
  try {
    const { sessions, warnings } = loadSessionsWithWarnings(ctx)
    for (const w of warnings) {
      const id = /^sessão ([0-9a-f]{8})/.exec(w)?.[1] ?? 'claude'
      add('warn', 'claude.format', id, redact(w))
    }
    return sessions
  } catch (e) {
    if (!(e instanceof SbError)) throw e
    add('warn', 'claude.format', 'claude', redact(`${e.message}${e.detail ? ` ${e.detail.trim()}` : ''}`))
    return []
  }
}

function adoptQueued(ctx: Ctx): Set<string> {
  try {
    return new Set(readRuntime(ctx.paths).pending.filter((i) => i.reason === 'adopt').map((i) => i.jobId))
  } catch {
    return new Set() // runtime.json corrompido: o doctor só não sabe da fila
  }
}

function checkSessions(ctx: Ctx, cfg: Config | null, sessions: Session[], add: Add): void {
  const queued = adoptQueued(ctx)
  for (const s of sessions) {
    const id = s.agent.id
    // sem `state.json` legível o dono vira `none` só por falta de dados: nunca é "sem settings" (viva: já virou `claude.format`)
    if (s.job === null) continue
    switch (s.owner.kind) {
      case 'legacy':
        add('warn', 'session.legacy', id, `a sessão ${id} é do claude-conta (--settings em ~/.claude/contas*): o sb não mexe nela`)
        break
      case 'foreign':
        add('warn', 'session.foreign', id, `a sessão ${id} usa um --settings de terceiros (${s.owner.path}): o sb não sabe em que conta ela roda`)
        break
      case 'none': {
        if (!cfg) break
        let mux: string
        try {
          mux = resolveMuxForDir(cfg, s.agent.cwd, ctx.paths.home)
        } catch (e) {
          if (e instanceof SbError) break // sem mux nem default: nada a dizer
          throw e
        }
        const account = currentAccount(ctx.paths, mux) ?? cfg.mux[mux]!.account
        if (account === KEYCHAIN) break // sem --settings ela roda no keychain, que é a conta deste mux
        add(
          'error',
          'session.no-settings',
          id,
          `a sessão ${id} (${s.live ? 'viva' : 'parada'}, em ${s.agent.cwd}) está sob o mux "${mux}" mas não tem --settings: abre no keychain, não em ${account}` +
            (queued.has(id) ? `; ${ADOPT_QUEUED_NOTE} (o watch a aplica quando a sessão ficar livre)` : '; `sb doctor --fix` a adota'),
        )
        break
      }
    }
  }
}

/** Uma linha de `ps -axo pid=,command=`: o pid e a linha de comando inteira (quem usa NUNCA a repete numa saída: pode ter `--settings` inline com token). */
export function psTable(ctx: Ctx): Array<{ pid: number; command: string }> {
  const r = ctx.run(psBin(ctx.env), ['-axo', 'pid=,command='], { timeoutMs: 10_000 })
  if (r.status !== 0) return []
  const out: Array<{ pid: number; command: string }> = []
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S.*)$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), command: m[2]!.trim() })
  }
  return out
}

/** `claude agents` (a view interativa) vindos de `ps`; a listagem `--json` do próprio sb/watch não é view. */
export function listViews(ctx: Ctx): Array<{ pid: number; args: string[] }> {
  const names = new Set(['claude', basename(claudeBin(ctx.env))])
  const out: Array<{ pid: number; args: string[] }> = []
  for (const { pid, command } of psTable(ctx)) {
    const tokens = command.split(/\s+/)
    if (!names.has(basename(tokens[0]!)) || tokens[1] !== 'agents') continue
    const args = tokens.slice(2)
    if (args.includes('--json')) continue
    out.push({ pid, args })
  }
  return out
}

function checkViews(ctx: Ctx, add: Add): void {
  for (const v of listViews(ctx)) {
    const owner = ownershipOf(v.args, ctx.paths)
    const subject = `pid ${v.pid}`
    if (owner.kind === 'mux' || owner.kind === 'pin') continue
    if (owner.kind === 'legacy') {
      add('warn', 'view.legacy', subject, `a view do \`claude agents\` (pid ${v.pid}) usa o settings do claude-conta; reabra-a com \`sb agents <mux>\``)
    } else {
      add(
        'error',
        'view.no-settings',
        subject,
        `a view do \`claude agents\` (pid ${v.pid}) ${owner.kind === 'none' ? 'não tem --settings' : 'usa um --settings de terceiros'} do sb: as sessões que ela despachar rodariam noutra conta (keychain); feche-a e abra com \`sb agents <mux>\``,
      )
    }
  }
}

// ------------------------------------------------------------------------------------------------------------ watch

function checkWatch(ctx: Ctx, add: Add): void {
  const w = watchStatus(ctx) // a mesma fonte do `sb pin`: pid vivo e último ciclo há ≤ 90 s (3 × 30 s)
  if (w.state === 'running') return
  const how =
    w.state === 'absent'
      ? 'sem batimento em watch.json'
      : w.pid !== undefined && !isAlive(w.pid)
        ? `o processo ${w.pid} morreu`
        : w.lastTick !== undefined
          ? `o último ciclo foi há ${Math.max(0, Math.round((ctx.now() - w.lastTick) / 1000))} s (esperado < 90 s)`
          : 'o batimento está ilegível'
  add('warn', 'watch.stopped', 'watch', `o sb watch não está rodando (${how}): sem ele não há troca automática nem fila de pins; rode \`sb install\` ou \`sb watch\``)
}

// ------------------------------------------------------------------------------------------------------- diagnóstico

const configProblem = (e: InvalidConfigError): string => {
  const lines = (e.detail ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.length > 1 ? `${e.message}; ${lines.join('; ')}` : e.message
}

/**
 * Todos os achados, erros antes de avisos. Config ausente ou inválida vira `config.invalid` (o que não depende dela
 * segue: permissões, tokens, links, views). Só lê.
 */
export async function diagnose(ctx: Ctx): Promise<Finding[]> {
  const out: Finding[] = []
  const add: Add = (severity, code, subject, message) => void out.push({ severity, code, subject, message })

  let cfg: Config | null = null
  try {
    cfg = await loadConfig(ctx.paths)
  } catch (e) {
    if (!(e instanceof InvalidConfigError)) throw e
    add('error', 'config.invalid', 'config', redact(configProblem(e)))
  }

  checkStatePerms(ctx, add)
  checkTokens(ctx, cfg, add)
  if (cfg) checkConfigShape(ctx, cfg, add)
  const sessions = loadSessions(ctx, add)
  checkLinks(ctx, cfg, sessions, add)
  checkSessions(ctx, cfg, sessions, add)
  checkViews(ctx, add)
  checkWatch(ctx, add)

  // estável: erros primeiro, cada grupo na ordem em que foi achado
  return [...out.filter((f) => f.severity === 'error'), ...out.filter((f) => f.severity === 'warn')]
}

// ------------------------------------------------------------------------------------------------------------- fix

/** A conta serve de alvo de link? `keychain` sim (o arquivo `{}` é criado se faltar); as outras precisam de token utilizável. */
function usable(ctx: Ctx, account: string): boolean {
  if (account === KEYCHAIN) return keychainFileState(ctx) !== 'other'
  return tokenStatus(ctx.paths, account) === 'ok'
}

function ensureKeychainFile(ctx: Ctx): void {
  if (keychainFileState(ctx) !== 'absent') return
  mkdirPrivate(join(ctx.paths.stateDir, 'tokens'))
  writeAtomic(tokenFile(ctx.paths, KEYCHAIN), '{}', 0o600)
}

const errMessage = (e: unknown): string => redact(e instanceof Error ? e.message : String(e))

/**
 * Conserta o que é seguro e devolve cada tentativa. EXIGE O LOCK JÁ TOMADO. Ordem: permissões → links → adoção (a adoção
 * confere o link do mux, que precisa estar de pé). Cada conserto reconfere o disco na hora (os achados podem estar
 * velhos). Nunca mexe em conteúdo de token, nunca apaga nada, nunca pára uma sessão: sessão PARADA sem `--settings` é
 * reescrita; VIVA vai para `runtime.pending` (`reason: 'adopt'`) e o watch a aplica. Legado e terceiros não são tocados.
 * O que depende da config (links, adoção) não roda com a config inválida.
 */
export async function fix(ctx: Ctx, findings: Finding[]): Promise<FixAction[]> {
  const actions: FixAction[] = []
  const done = (f: Finding, ok: boolean, message: string): void => void actions.push({ code: f.code, subject: f.subject, ok, message })
  const of = (code: FindingCode): Finding[] => findings.filter((f) => f.code === code)

  for (const f of of('state.perms')) {
    const dir = f.subject === 'estado' ? ctx.paths.stateDir : (SUBDIRS as readonly string[]).includes(f.subject) ? join(ctx.paths.stateDir, f.subject) : null
    if (dir === null) continue
    try {
      chmodSync(dir, 0o700)
      done(f, true, `${dir} → 700`)
    } catch (e) {
      done(f, false, `não consegui ajustar ${dir}: ${errMessage(e)}`)
    }
  }

  for (const f of of('token.perms')) {
    if (!NAME_RE.test(f.subject)) continue
    try {
      chmodSync(tokenFile(ctx.paths, f.subject), 0o600)
      done(f, true, `tokens/${f.subject}.json → 600`)
    } catch (e) {
      done(f, false, `não consegui ajustar tokens/${f.subject}.json: ${errMessage(e)}`)
    }
  }

  let cfg: Config | null = null
  try {
    cfg = await loadConfig(ctx.paths)
  } catch (e) {
    if (!(e instanceof InvalidConfigError)) throw e
  }
  if (cfg === null) return actions

  for (const f of of('link.broken')) fixLink(ctx, cfg, f, done)

  for (const f of of('session.no-settings')) {
    try {
      const r = adoptSession(ctx, cfg, f.subject)
      if (r === 'rewritten') done(f, true, `sessão ${f.subject} estava parada: --settings do mux acrescentado (backup em backup/)`)
      else if (r === 'queued') done(f, true, `sessão ${f.subject} está viva: pedido de adoção na fila (runtime.pending); o watch a aplica quando ela ficar livre`)
    } catch (e) {
      done(f, false, `sessão ${f.subject} não foi adotada: ${errMessage(e)}`)
    }
  }
  return actions
}

function fixLink(ctx: Ctx, cfg: Config, f: Finding, done: (f: Finding, ok: boolean, message: string) => void): void {
  const m = /^(mux|pins)\/([a-z0-9][a-z0-9_-]{0,31})$/.exec(f.subject)
  if (!m) return
  const kind = m[1] as 'mux' | 'pins'
  const name = assertSafeName(m[2]!)
  const link = kind === 'mux' ? muxLink(ctx.paths, name) : pinLink(ctx.paths, name)
  const chk = checkSettingsTarget(link)
  if (chk.ok) return // já conferido: o achado era velho
  // token ruim (JSON inválido, sem OAuth) não se conserta religando: é `sb login`
  if (chk.problem !== 'missing-link' && chk.problem !== 'broken') return

  let candidates: string[]
  if (kind === 'mux') {
    const mux = cfg.mux[name]
    if (!mux) return
    const cur = currentAccount(ctx.paths, name)
    candidates = [...new Set([cur, mux.account].filter((a): a is string => a !== null && mux.accounts.includes(a)))]
  } else {
    if (!(name in cfg.accounts) && name !== KEYCHAIN) return
    candidates = [name]
  }
  const account = candidates.find((a) => usable(ctx, a))
  if (account === undefined) {
    done(f, false, `${f.subject}: nenhuma conta candidata (${candidates.join(', ') || 'nenhuma'}) tem token utilizável; rode \`sb login\``)
    return
  }
  try {
    mkdirPrivate(join(ctx.paths.stateDir, kind))
    if (account === KEYCHAIN) ensureKeychainFile(ctx)
    if (kind === 'mux') pointMux(ctx.paths, name, account)
    else ensurePin(ctx.paths, account)
    const after = checkSettingsTarget(link)
    if (after.ok) done(f, true, `${f.subject}: link recriado → ${account}`)
    else done(f, false, `${f.subject}: recriei o link, mas ele continua inválido (${after.problem})`)
  } catch (e) {
    done(f, false, `${f.subject}: não consegui recriar o link: ${errMessage(e)}`)
  }
}
