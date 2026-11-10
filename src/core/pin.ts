import { existsSync, lstatSync, rmSync, rmdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Config } from './config.js'
import type { Ctx } from './ctx.js'
import { assertSessionId, listAgents, stopSession } from './claude.js'
import { EXIT, SbError } from './errors.js'
import { checkSettingsTarget, ensurePin, type TargetProblem } from './links.js'
import { resolveMuxForDir } from './mux.js'
import { assertSafeName, backupDir, muxLink, pinLink } from './paths.js'
import { ownershipOf, replaceSettings, writeJobFlags } from './jobs.js'
import { readRuntime, writeRuntime, type Runtime } from './runtime.js'
import { activityOf, callerJobId, loadSessions, loadSessionsWithWarnings, type Session } from './sessions.js'
import type { RestartOptions } from './swap.js'
import { ensureState, KEYCHAIN, tokenStatus } from './tokens.js'

// ---------------------------------------------------------------------------------------------------------------
// `sb pin` / `sb unpin` e a fila `runtime.pending` (design §4 "Sessão fixa", §7). ESTE CÓDIGO REESCREVE O
// `respawnFlags` DE UMA SESSÃO DO USUÁRIO E PODE PARÁ-LA. Regras que não se afrouxam:
//   - nunca pára um turno em andamento: só pára `activityOf(s, caller) ∈ {free, limit-blocked}`, com dados frescos
//     reconferidos imediatamente antes do `claude stop`; `busy`/`scheduled`/a sessão que chamou → `runtime.pending`;
//   - só reescreve com a entrada SEM `pid`: confirmado depois do `claude stop` E de novo, por último, dentro do
//     `transform` do `writeJobFlags` (o instante mais próximo da gravação). Um `pid` ali → nada é gravado, vai para a fila;
//   - o destino (`pins/<conta>.json` ou `mux/<mux>.json`) passa por `checkSettingsTarget` ANTES de qualquer gravação
//     (e de qualquer parada): token com JSON quebrado faria o claude ignorar o settings e cair no keychain;
//   - só mexe em sessões `background` NOSSAS (`--settings` em mux/ ou pins/); estranhas, legado e sem `--settings`: exit 3;
//   - `accounts` do mux da sessão é o limite duro: conta fora dele → exit 3, nada gravado;
//   - nada aqui é concorrente: tudo roda com o lock do estado tomado pelo CHAMADOR (`withLock`; o `watch` já o segura
//     no tick) e `stopSession` BLOQUEIA o laço de eventos (`Atomics.wait`, até 45 s): é um passo bloqueante, não o
//     intercale com trabalho que precise responder rápido a sinais.
// O backup (`backup/pin-<stamp>/<id>.state.json`) é cópia do `state.json` inteiro: se a sessão tem um `--settings`
// inline de terceiros com token, o token vai junto (arquivo 600 em diretório 700, como o resto do estado).
// ---------------------------------------------------------------------------------------------------------------

export type PinOutcome = { jobId: string; settings: string; result: 'rewritten' | 'stopped-and-rewritten' | 'queued' }

/** `gone`: o item saiu da fila SEM ser aplicado (a sessão sumiu, deixou de ser nossa ou o pedido não vale mais). */
export type PendingOutcome = PinOutcome | { jobId: string; result: 'gone' }

/** O `detail` do exit 1 de `claude stop` que falhou: o pedido FICOU na fila (o comando acrescenta o aviso do watch). */
export const STOP_FAILED_QUEUED_DETAIL = '  o pedido ficou na fila: o watch tenta de novo'

const usageError = (message: string, detail?: string): SbError => new SbError(message, EXIT.USAGE, detail)
const checkError = (message: string, detail?: string): SbError => new SbError(message, EXIT.CHECK_FAILED, detail)

const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]+/g
const redact = (s: string): string => s.replace(TOKEN_RE, '<token>')

/** Nunca lança: o log e o aviso são secundários e acontecem depois de efeitos que não se desfazem. */
function note(ctx: Ctx, line: string): void {
  try {
    ctx.log('watch', line)
  } catch {
    // o log é só informativo
  }
}

function tell(ctx: Ctx, msg: string): void {
  try {
    ctx.notify('switchboard', msg)
  } catch {
    // notificação é só informativa
  }
}

// ---------------------------------------------------------------------------------------------------- achar a sessão

/**
 * Prefixo mínimo: 4 hexadecimais (o id tem 8). Menos que isso casa com sessões demais por acaso, e o comando reescreve
 * o `state.json` de uma delas: a recusa é exit 3. Maiúsculas valem (viram minúsculas); o id completo vale mesmo que seja
 * prefixo de outro.
 */
const PREFIX_RE = /^[0-9a-f]{4,8}$/

function normalizePrefix(prefix: string): string {
  const p = prefix.toLowerCase()
  if (!PREFIX_RE.test(p)) {
    throw usageError(`prefixo de sessão inválido: ${JSON.stringify(redact(prefix).slice(0, 40))} — use de 4 a 8 caracteres hexadecimais (ex.: 95b0)`, '  veja os ids em `sb usage` ou `claude agents`')
  }
  return p
}

/** Uma sessão pelo prefixo do id. Nenhuma ou ambígua → exit 3 listando os ids. */
export function findSession(sessions: Session[], prefix: string): Session {
  const p = normalizePrefix(prefix)
  const exact = sessions.filter((s) => s.agent.id === p)
  if (exact.length === 1) return exact[0]!
  const hits = sessions.filter((s) => s.agent.id.startsWith(p))
  if (hits.length === 1) return hits[0]!
  if (hits.length === 0) {
    const ids = sessions.map((s) => s.agent.id)
    throw usageError(`nenhuma sessão em segundo plano começa com "${p}"`, `  sessões: ${ids.length > 0 ? ids.join(', ') : 'nenhuma'}`)
  }
  throw usageError(`o prefixo "${p}" é ambíguo (${hits.length} sessões)`, `  use mais caracteres; candidatas: ${hits.map((s) => s.agent.id).join(', ')}`)
}

/** `findSession`, com a mensagem própria para uma sessão que existe mas não é `background`. */
function pick(ctx: Ctx, sessions: Session[], prefix: string): Session {
  try {
    return findSession(sessions, prefix)
  } catch (e) {
    if (e instanceof SbError && e.exit === EXIT.USAGE) {
      const p = prefix.toLowerCase()
      if (PREFIX_RE.test(p) && !sessions.some((s) => s.agent.id.startsWith(p))) {
        const other = listAgents(ctx).find((a) => a.kind !== 'background' && a.id.startsWith(p))
        if (other !== undefined) throw usageError(`a sessão ${other.id} é do tipo ${other.kind}: só sessões em segundo plano (background) podem ser fixadas`)
      }
    }
    throw e
  }
}

/**
 * O mux de uma sessão: `owner.mux` quando ela é de um mux (o `--settings` manda, não a pasta); senão (pin) o da PASTA
 * (`agent.cwd`, o root mais profundo; sem root cai no `default`; sem `default` → exit 2). Um `owner.mux` que não está
 * mais na config → exit 3 (não adivinhamos outro). `home` expande o `~` dos roots (o `Paths.home` do Ctx).
 */
export function muxOfSession(cfg: Config, s: Session, home: string): string {
  if (s.owner.kind === 'mux') {
    if (!(s.owner.mux in cfg.mux)) {
      throw usageError(`a sessão ${s.agent.id} é do mux "${s.owner.mux}", que não está na config`, '  recrie o mux ou deixe a sessão como está')
    }
    return s.owner.mux
  }
  return resolveMuxForDir(cfg, s.agent.cwd, home)
}

// ------------------------------------------------------------------------------------------------------------ destino

interface Target {
  /** `null` = soltar */
  account: string | null
  mux: string
  /** `pins/<conta>.json` ou `mux/<mux>.json` */
  link: string
}

type Resolved = { kind: 'target'; target: Target } | { kind: 'unchanged' }

/**
 * Decide o destino SEM gravar nada. Recusas (exit 3): sessão que não é nossa (só `--settings` de mux/pin), conta fora de
 * `accounts` do mux, `unpin` de quem não está fixa. `unchanged`: a sessão já está no destino (fixa nessa conta, ou solta num `unpin`).
 */
function resolveTarget(ctx: Ctx, cfg: Config, s: Session, account: string | null): Resolved {
  const id = s.agent.id
  if (s.owner.kind !== 'mux' && s.owner.kind !== 'pin') {
    const why = s.job === null ? 'sem state.json legível' : s.owner.kind === 'none' ? 'sem --settings' : s.owner.kind === 'legacy' ? 'do claude-conta (legado)' : 'com --settings de terceiros'
    throw usageError(`a sessão ${id} não é gerenciada pelo sb (${why}): o sb não mexe nela`, '  `sb doctor` mostra o que dá para adotar')
  }
  const mux = muxOfSession(cfg, s, ctx.paths.home)
  if (account === null) {
    if (s.owner.kind !== 'pin') return { kind: 'unchanged' } // já está solta (usa o mux); `pinSession` recusa e cancela o pedido antigo
    return { kind: 'target', target: { account: null, mux, link: muxLink(ctx.paths, mux) } }
  }
  assertSafeName(account)
  const allowed = cfg.mux[mux]!.accounts
  if (!allowed.includes(account)) {
    throw usageError(`a conta "${account}" não pertence ao mux "${mux}" da sessão ${id} (contas permitidas: ${allowed.join(', ')})`, `  anexe com \`sb attach ${account} ${mux}\``)
  }
  if (s.owner.kind === 'pin' && s.owner.account === account) return { kind: 'unchanged' }
  return { kind: 'target', target: { account, mux, link: pinLink(ctx.paths, account) } }
}

const PIN_PROBLEM: Record<TargetProblem, string> = {
  'missing-link': 'o link da sessão fixa não existe',
  broken: 'o link da sessão fixa está quebrado (não aponta para um token em tokens/)',
  'invalid-json': 'o token tem JSON inválido (o claude ignoraria o settings e cairia no keychain)',
  'no-oauth': 'o token não tem CLAUDE_CODE_OAUTH_TOKEN',
}

/**
 * Deixa o destino pronto e CONFERE (exit 1, e nada fica para trás): para um pin, o token da conta tem que estar ok ANTES
 * de `ensurePin` (senão ficaria um `pins/<conta>.json` apontando para um token ruim); depois `ensurePin` e
 * `checkSettingsTarget(link)`. Para soltar, só `checkSettingsTarget(mux/<mux>.json)`: nunca cria nada.
 */
function prepareTarget(ctx: Ctx, t: Target): void {
  if (t.account === null) {
    const c = checkSettingsTarget(t.link)
    if (!c.ok) throw checkError(`mux "${t.mux}": o link do mux não serve para soltar a sessão (${PIN_PROBLEM[c.problem] ?? c.problem}; ${t.link})`, '  rode `sb doctor --fix`')
    return
  }
  const account = t.account
  if (account === KEYCHAIN) ensureState(ctx.paths) // `tokens/keychain.json` = `{}`: o único "token" do keychain
  else {
    const st = tokenStatus(ctx.paths, account)
    if (st !== 'ok') {
      throw checkError(st === 'invalid-json' ? `a conta "${account}": ${PIN_PROBLEM['invalid-json']}` : `a conta "${account}" não tem token utilizável`, `  rode \`sb login ${account}\` ou \`sb doctor --fix\``)
    }
  }
  const existed = existsLink(t.link)
  ensurePin(ctx.paths, account)
  const c = checkSettingsTarget(t.link)
  if (!c.ok || c.account !== account) {
    if (!existed) rmSync(t.link, { force: true })
    throw checkError(`a conta "${account}": ${c.ok ? 'o link aponta para outra conta' : PIN_PROBLEM[c.problem]} (${t.link})`, '  rode `sb doctor --fix`')
  }
}

function existsLink(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

// --------------------------------------------------------------------------------------------------------------- fila

const isQueued = (i: Runtime['pending'][number]): boolean => i.reason === 'pin' || i.reason === 'unpin'

/** Tira de `runtime.pending` os pedidos pin/unpin da sessão (`adopt`/`migrate` são de outras tarefas). `true` se mudou. */
function dropPending(runtime: Runtime, jobId: string): boolean {
  const n = runtime.pending.length
  runtime.pending = runtime.pending.filter((i) => !(isQueued(i) && i.jobId === jobId))
  return runtime.pending.length !== n
}

/** O pedido mais recente da sessão vence: um `unpin` substitui um `pin` que ainda esperava. */
function enqueue(ctx: Ctx, runtime: Runtime, jobId: string, t: Target): void {
  dropPending(runtime, jobId)
  runtime.pending.push({ jobId, settings: t.link, reason: t.account === null ? 'unpin' : 'pin', requestedAt: ctx.now() })
  writeRuntime(ctx.paths, runtime)
}

// ------------------------------------------------------------------------------------------------------------ aplicar

type Settled =
  | { result: 'rewritten' | 'stopped-and-rewritten' }
  | { result: 'unchanged' }
  | { result: 'gone' }
  | { result: 'queued'; why: 'busy' | 'raced' | 'stop-failed' | 'unreadable'; detail?: string }

const stamp = (ctx: Ctx): string => `pin-${new Date(ctx.now()).toISOString().replace(/[:.]/g, '-')}`

/** Arquivo de backup que ainda não existe (sufixo `-2`, `-3`…): um backup anterior nunca é sobrescrito. */
function freshBackup(ctx: Ctx, id: string): string {
  const base = stamp(ctx)
  for (let n = 1; ; n++) {
    const file = `${backupDir(ctx.paths, n === 1 ? base : `${base}-${n}`)}/${id}.state.json`
    if (!existsSync(file)) return file
  }
}

/**
 * O passo comum de `pinSession` e `applyPending` para UMA sessão: reconfere tudo com dados frescos, decide e (só se a
 * sessão está sem `pid`) reescreve. Lança `SbError` para recusas, destino ruim e falha de gravação; devolve `queued`
 * quando a sessão está ocupada, ganhou `pid` no meio-tempo ou o `claude stop` falhou. `expectLink`: o `settings` de um
 * item da fila (tem que coincidir com o destino recalculado; senão o item não vale mais → exit 3). Com `expectLink`
 * (caminho da fila), uma sessão cujo `state.json` não pôde ser lido (`job === null`: ausente ou meio gravado num tick)
 * NÃO é recusada como estranha: não dá para saber de quem ela é, então volta `queued`/`unreadable` e o item espera.
 * No comando direto (`expectLink` ausente) continua exit 3.
 */
function settle(ctx: Ctx, cfg: Config, id: string, account: string | null, expectLink: string | undefined, opts: RestartOptions, first?: Session): Settled {
  const caller = callerJobId(ctx.env)
  const s = first ?? loadSessions(ctx).find((x) => x.agent.id === id)
  if (s === undefined) return { result: 'gone' }
  if (s.job === null && expectLink !== undefined) return { result: 'queued', why: 'unreadable' }
  const r = resolveTarget(ctx, cfg, s, account)
  if (r.kind === 'unchanged') return { result: 'unchanged' }
  const t = r.target
  if (expectLink !== undefined && t.link !== expectLink) throw usageError(`o pedido da sessão ${id} não vale mais (o destino mudou)`)
  if (s.job === null) throw checkError(`a sessão ${id} não tem state.json legível: não dá para reescrever os flags`, '  rode `sb doctor`')
  const flags = s.job.respawnFlags
  const next = replaceSettings(flags, t.link, ctx.paths)
  if (next.length === flags.length && next.every((v, i) => v === flags[i])) return { result: 'unchanged' }
  prepareTarget(ctx, t) // destino conferido ANTES de parar ou gravar qualquer coisa

  let stopped = false
  const act = activityOf(s, caller)
  if (act === 'free' || act === 'limit-blocked') {
    // dados frescos: um turno pode ter começado desde a listagem (a que chamou continua `busy` por `activityOf`)
    const f = loadSessions(ctx).find((x) => x.agent.id === id)
    if (f === undefined) return { result: 'gone' }
    const again = activityOf(f, caller)
    if (again === 'free' || again === 'limit-blocked') {
      // o `watch` reparte um teto de paradas por ciclo entre trocas, reinícios e esta fila: sem saldo, o pedido espera o próximo
      if (opts.throttle !== undefined) {
        if (opts.throttle.stops <= 0) return { result: 'queued', why: 'busy' }
        opts.throttle.stops--
      }
      // `stopSession` devolve false numa sessão já parada: o `pid` é conferido ANTES (ver `activityOf`: 'free' ⇒ vivo)
      const ok = stopSession(ctx, id, opts.stopTimeoutMs, opts.stop)
      const after = listAgents(ctx).find((a) => a.id === id)
      if (after !== undefined && after.pid != null) {
        return { result: 'queued', why: 'stop-failed', detail: ok ? 'o `claude stop` terminou, mas a sessão continua viva' : '`claude stop` falhou ou a sessão não parou no prazo' }
      }
      stopped = ok
    } else if (again !== 'stopped') return { result: 'queued', why: 'busy' }
  } else if (act !== 'stopped') return { result: 'queued', why: 'busy' }

  // Escrita: `pid` conferido aqui (antes de fazer o backup) e de novo dentro do transform (imediatamente antes de gravar)
  const pre = listAgents(ctx).find((a) => a.id === id)
  if (pre !== undefined && pre.pid != null) return { result: 'queued', why: 'raced' }
  const backup = freshBackup(ctx, id)
  let raced = false
  const ok = writeJobFlags(
    ctx.paths,
    id,
    (cur) => {
      const e = listAgents(ctx).find((a) => a.id === id)
      if (e !== undefined && e.pid != null) {
        raced = true
        return cur // igual ao atual: nada é gravado
      }
      return replaceSettings(cur, t.link, ctx.paths)
    },
    backup,
  )
  if (raced) {
    rmSync(backup, { force: true }) // nada foi gravado: o backup é só ruído
    try {
      rmdirSync(dirname(backup))
    } catch {
      // diretório não vazio ou já removido
    }
    return { result: 'queued', why: 'raced' }
  }
  if (!ok) {
    throw checkError(
      `não consegui reescrever os flags da sessão ${id}${stopped ? ' (ela JÁ foi parada)' : ''}; o backup está em ${backup}`,
      '  rode o comando de novo; se persistir, `sb doctor`',
    )
  }
  return { result: stopped ? 'stopped-and-rewritten' : 'rewritten' }
}

/**
 * `sb pin <sessão> <conta>` (`account`) ou `sb unpin <sessão>` (`null`: volta para `mux/<mux da sessão>.json`).
 * EXIGE O LOCK JÁ TOMADO pelo chamador (`withLock`): lê-modifica-grava `runtime.json`, reescreve `state.json` e pode
 * parar a sessão (bloqueante). Parada → reescreve já; livre/limit-blocked e não é a que chamou → para e reescreve;
 * ocupada, agendada, a que chamou, ou que ganhou `pid` no meio-tempo → `runtime.pending` (o `watch` aplica).
 * `claude stop` que falha → exit 1 (nada reescrito) e o pedido FICA na fila. Já estar no destino → exit 3 (e o pedido
 * antigo, se havia, é cancelado); o mesmo vale para toda recusa exit 3 sobre a sessão achada (conta fora de `accounts`,
 * sessão estranha, mux fora da config, sessão sumida): o pedido mais recente vence. Exit 1 (falha transitória) não cancela.
 * O `runtime.json` é lido ANTES de qualquer efeito (corrompido → exit 1 sem tocar em nada).
 */
export function pinSession(ctx: Ctx, cfg: Config, prefix: string, account: string | null, opts: RestartOptions = {}): PinOutcome {
  if (account !== null) assertSafeName(account)
  normalizePrefix(prefix)
  const runtime = readRuntime(ctx.paths)
  const s = pick(ctx, loadSessions(ctx), prefix)
  const id = s.agent.id
  let r: Resolved
  let settled: Settled
  try {
    r = resolveTarget(ctx, cfg, s, account)
    settled = settle(ctx, cfg, id, account, undefined, opts, s)
  } catch (e) {
    // Regra das recusas: o pedido mais recente vence. Uma recusa por regra (exit 3) sobre uma sessão que EXISTE cancela o
    // pedido antigo dela, como `unchanged`; falha transitória (exit 1: token quebrado, claude fora do ar) não cancela.
    // Sessão VIVA com `state.json` ilegível (`job === null`) também é transitória: o dono vira `none` só porque não deu para ler.
    const unreadable = s.live && s.job === null
    if (e instanceof SbError && e.exit === EXIT.USAGE && !unreadable && dropPending(runtime, id)) writeRuntime(ctx.paths, runtime)
    throw e
  }
  const link = r.kind === 'target' ? r.target.link : ''

  switch (settled.result) {
    case 'gone':
      if (dropPending(runtime, id)) writeRuntime(ctx.paths, runtime)
      throw usageError(`a sessão ${id} sumiu da lista do claude`)
    case 'unchanged':
      if (dropPending(runtime, id)) writeRuntime(ctx.paths, runtime) // o pedido antigo não vale mais
      throw usageError(account === null ? `a sessão ${id} não está fixa` : `a sessão ${id} já está fixa na conta ${account}`, '  nada a fazer')
    case 'queued': {
      if (r.kind !== 'target') throw checkError(`estado inesperado na sessão ${id}`)
      enqueue(ctx, runtime, id, r.target)
      note(ctx, `${account === null ? 'unpin' : `pin ${account}`}: sessão ${id} na fila (${settled.why})`)
      if (settled.why === 'stop-failed') {
        throw checkError(`não consegui parar a sessão ${id}: ${settled.detail ?? 'falha ao parar'}; nada foi reescrito`, STOP_FAILED_QUEUED_DETAIL)
      }
      return { jobId: id, settings: link, result: 'queued' }
    }
    default:
      if (dropPending(runtime, id)) writeRuntime(ctx.paths, runtime)
      note(ctx, `${account === null ? 'unpin' : `pin ${account}`}: sessão ${id} ${settled.result}`)
      return { jobId: id, settings: link, result: settled.result }
  }
}

/** Texto de aviso que não repete a cada ciclo do `watch`: chave em `runtime.notified` (o chamador grava). */
function noteOnce(ctx: Ctx, runtime: Runtime, key: string, line: string): void {
  if (runtime.notified[key] !== undefined) return
  runtime.notified[key] = ctx.now()
  note(ctx, line)
}

/**
 * Aplica a fila `runtime.pending` (itens `pin`/`unpin`; `adopt`/`migrate` ficam intocados) — usado pelo `watch`.
 * EXIGE O LOCK JÁ TOMADO (o `watch` já o segura no tick; `pin`/`unpin` usam `withLock`): lê e grava `runtime.json`.
 * Bloqueante (`claude stop`). Por item, a mesma lógica de `pinSession` com dados frescos:
 *   - sessão sumida, ou que deixou de ser nossa / cujo pedido não vale mais (conta fora de `accounts`, `settings`
 *     adulterado) → `gone` e sai da fila, com uma linha SEM conteúdo no log;
 *   - `state.json` da sessão ilegível agora (ausente ou meio gravado: `job === null`) → continua na fila, NUNCA descartado
 *     (não dá para saber de quem é; o aviso vai ao log uma vez). Só `legacy`/`foreign`/`none` COM state legível são estranhas;
 *   - ocupada/a que chamou/ganhou `pid`/`claude stop` falhou/destino quebrou → continua na fila (`queued`; os avisos
 *     de falha vão ao log UMA vez por motivo). O `watch` não deve notificar `queued`: é "ainda esperando";
 *   - livre → para e reescreve (`stopped-and-rewritten`); parada → reescreve (`rewritten`); notifica.
 *   - sessão que já está no destino (alguém fixou à mão) → sai da fila, sem aparecer no resultado.
 * Idempotente: um item aplicado sai da fila, então uma 2ª chamada não reescreve nem pára nada.
 */
export function applyPending(ctx: Ctx, cfg: Config, opts: RestartOptions = {}): PendingOutcome[] {
  const runtime = readRuntime(ctx.paths)
  const items = runtime.pending.filter(isQueued)
  if (items.length === 0) return []
  const before = JSON.stringify(runtime)
  const removed = new Set<Runtime['pending'][number]>()
  const out: PendingOutcome[] = []

  // vários pedidos da mesma sessão (não deveria haver): só o mais recente vale
  const latest = new Map<string, Runtime['pending'][number]>()
  for (const i of items) {
    const prev = latest.get(i.jobId)
    if (prev !== undefined) removed.add(prev)
    latest.set(i.jobId, i)
  }

  try {
    for (const item of latest.values()) {
      const jobId = typeof item.jobId === 'string' ? item.jobId : ''
      try {
        assertSessionId(jobId)
        if (typeof item.settings !== 'string') throw usageError(`pedido pendente da sessão ${jobId} sem destino`)
        const owner = ownershipOf(['--settings', item.settings], ctx.paths)
        // o destino do pedido tem que ser um dos NOSSOS links; o `unpin` vale para qualquer mux, o `pin` para uma conta
        const account = item.reason === 'pin' && owner.kind === 'pin' ? owner.account : null
        if (item.reason === 'pin' ? owner.kind !== 'pin' : owner.kind !== 'mux') throw usageError(`pedido pendente da sessão ${jobId} com destino inválido`)
        const r = settle(ctx, cfg, jobId, account, item.settings, opts)
        if (!(r.result === 'queued' && r.why === 'unreadable')) delete runtime.notified[`pin:${jobId}:unreadable`] // lido de novo: um próximo apagão volta a avisar
        switch (r.result) {
          case 'gone':
            removed.add(item)
            out.push({ jobId, result: 'gone' })
            note(ctx, `pin: sessão ${jobId} sumiu; o pedido saiu da fila`)
            break
          case 'unchanged':
            removed.add(item)
            note(ctx, `pin: sessão ${jobId} já está no destino pedido; o pedido saiu da fila`)
            break
          case 'queued':
            out.push({ jobId, settings: item.settings, result: 'queued' })
            if (r.why === 'unreadable') noteOnce(ctx, runtime, `pin:${jobId}:unreadable`, `pin: sessão ${jobId} continua na fila (state.json ilegível agora; tento de novo no próximo ciclo)`)
            else if (r.why !== 'busy') noteOnce(ctx, runtime, `pin:${jobId}:${r.why}`, `pin: sessão ${jobId} continua na fila (${r.why === 'raced' ? 'ganhou pid antes da gravação' : (r.detail ?? 'falha ao parar')})`)
            break
          default:
            removed.add(item)
            delete runtime.notified[`pin:${jobId}:stop-failed`]
            out.push({ jobId, settings: item.settings, result: r.result })
            note(ctx, `pin: sessão ${jobId} ${r.result} (${item.reason})`)
            tell(ctx, `Sessão ${jobId}: ${item.reason === 'pin' ? `fixada em ${account}` : 'solta do pin'}${r.result === 'stopped-and-rewritten' ? '; reabra-a para valer' : ''}.`)
        }
      } catch (e) {
        if (!(e instanceof SbError)) throw e
        if (e.exit === EXIT.USAGE) {
          // recusa por regra (sessão estranha, conta fora de accounts, pedido adulterado): o pedido não vale mais
          removed.add(item)
          out.push({ jobId, result: 'gone' })
          note(ctx, `pin: pedido da sessão ${jobId || '?'} descartado: ${redact(e.message)}`)
        } else {
          // falha que pode passar (token quebrado agora, state.json ilegível, claude fora do ar): fica na fila, avisa uma vez
          out.push({ jobId, settings: typeof item.settings === 'string' ? item.settings : '', result: 'queued' })
          noteOnce(ctx, runtime, `pin:${jobId}:err:${e.exit}`, `pin: sessão ${jobId} continua na fila: ${redact(e.message)}`)
        }
      }
    }
  } finally {
    runtime.pending = runtime.pending.filter((i) => !removed.has(i))
    if (JSON.stringify(runtime) !== before) writeRuntime(ctx.paths, runtime)
  }
  return out
}

// ------------------------------------------------------------------------------------------------------------ painel

/**
 * Sessões fixas para o painel (`owner.kind == 'pin'`, vivas ou paradas). `claude agents` falhando NÃO é erro do painel:
 * devolve `unavailable: true` (o chamador mostra um aviso discreto) e nunca lança por causa disso.
 */
export function pinnedSessions(ctx: Ctx): { sessions: Session[]; unavailable: boolean } {
  try {
    return { sessions: loadSessionsWithWarnings(ctx).sessions, unavailable: false }
  } catch (e) {
    if (e instanceof SbError) return { sessions: [], unavailable: true }
    throw e
  }
}
