import { closeSync, fstatSync, openSync, readFileSync, readSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertSessionId, SESSION_ID_RE } from './claude.js'
import { loadConfig, parseDuration, type Config } from './config.js'
import type { Ctx } from './ctx.js'
import { EXIT, SbError } from './errors.js'
import { acquirePidFile, isAlive, mkdirPrivate, peekPidFile, releasePidFile, withLock, writeAtomic } from './fsx.js'
import { currentAccount, pointMux } from './links.js'
import { lockFile, runtimeFile, watchFile, watchPidFile } from './paths.js'
import { applyPending } from './pin.js'
import { availability, desiredAccount, type MuxEval } from './rules.js'
import { readRuntime, writeRuntime, type Runtime } from './runtime.js'
import { isLimitBlocked, type Session } from './sessions.js'
import { applySwap, loadSessionsDeduped, restartStale, type RestartOptions, type SwapOutcome } from './swap.js'
import { ensureState, hasToken, KEYCHAIN } from './tokens.js'
import { measureAll, readUsage, type UsageFile } from './usage.js'

// ---------------------------------------------------------------------------------------------------------------
// `sb watch`: o único processo longo. A cada ciclo, SOB O LOCK do estado: mede o uso (a cada `swap.probeEvery`), avalia
// cada mux, aplica as trocas (se `swap.auto`) ou avisa, reinicia as sessões antigas que ficaram livres e aplica a fila de
// pins. Ordem dentro do ciclo (importa):
//   0. `runtime.json` corrompido é posto de lado ANTES de tudo (todo consumidor lê o arquivo e lançaria);
//   1. medição; 2. overrides vencidos + varredura das sessões (snapshot de `limit-blocked`, lista "mantidas", poda de
//      `runtime.notified`) ANTES de qualquer troca, porque a troca pára exatamente essas sessões;
//   3. por mux: link ausente, troca interrompida, avaliação, cooldown, troca ou aviso;
//   4. `restartStale` nos muxes que não trocaram agora; 5. `applyPending`.
// `applySwap`, `restartStale` e `applyPending` leem e gravam `runtime.json` por conta própria: aqui nunca se carrega um
// `Runtime` por cima de uma dessas chamadas (ler → mudar → gravar, em passos curtos).
// `stopSession` BLOQUEIA o laço de eventos (até 45 s por sessão): o teto é de {@link STOPS_PER_TICK} paradas por ciclo,
// repartido entre trocas, reinícios e a fila (um objeto `throttle` compartilhado), e uma parada que falha recua.
// ---------------------------------------------------------------------------------------------------------------

export const WATCH_INTERVAL_MS = 30_000
/** Entre duas trocas AUTOMÁTICAS do mesmo mux (ideia do `cswap auto`), salvo se a conta atual está esgotada. */
export const SWAP_COOLDOWN_MS = 5 * 60_000
export const STOPS_PER_TICK = 3
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60_000
/**
 * Quanto o ciclo espera o lock. NÃO é 0: `withLock` confere o prazo ANTES de tomar um lock de pid morto, então com 0 um
 * lock órfão (queda no meio de um `sb swap`) travaria o watch para sempre. Ocupado por um pid vivo continua sendo "pula o ciclo".
 */
const LOCK_WAIT_MS = 250
/** Ciclos seguidos sem lock, com dono vivo que não é o watch, até avisar (≈ 90 s). */
const PERSISTENT_LOCK_TICKS = 3

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

export interface TickReport {
  skipped?: 'locked'
  /** houve sonda neste ciclo (a medição mais nova passava de `probeEvery`) */
  measured: boolean
  evaluations: MuxEval[]
  swaps: SwapOutcome[]
  /** por mux: o que o reinício das sessões antigas fez (para um mux que trocou agora, é a parte do `SwapOutcome`) */
  restarts: Record<string, ReturnType<typeof restartStale>>
  /** itens da fila de pins: aplicados, descartados (`gone`) ou ainda esperando (`queued`) */
  pending: ReturnType<typeof applyPending>
  /** o que o watch fez ou encontrou neste ciclo (sem token) */
  notices: string[]
  /** sessões vivas de mux sem `inFlight` no state.json (claude antigo): contam como ocupadas e o watch nunca as reinicia */
  kept: string[]
}

const emptyReport = (): TickReport => ({ measured: false, evaluations: [], swaps: [], restarts: {}, pending: [], notices: [], kept: [] })

/** O que sobrevive entre ciclos do MESMO processo (fora do lock, não pode ir para o `runtime.json`). */
export interface WatchMemory {
  lockedTicks: number
  lockNotified: boolean
}

export const newMemory = (): WatchMemory => ({ lockedTicks: 0, lockNotified: false })

export interface TickOptions {
  /** `stopTimeoutMs`/`stop` do `RestartOptions` (os testes injetam relógio e espera); o `throttle` é do próprio ciclo */
  restart?: Omit<RestartOptions, 'throttle'>
  /** padrão {@link STOPS_PER_TICK} */
  maxStops?: number
  memory?: WatchMemory
}

// ------------------------------------------------------------------------------------------------------ runtime.json

function mutateRuntime(ctx: Ctx, fn: (r: Runtime) => void): void {
  const r = readRuntime(ctx.paths)
  const before = JSON.stringify(r)
  fn(r)
  if (JSON.stringify(r) !== before) writeRuntime(ctx.paths, r)
}

/** JSON corrompido (queda de energia sem fsync): move para `runtime.json.corrupt-<ts>`, avisa e recomeça vazio — nunca trava em loop. */
function recoverRuntime(ctx: Ctx, report: TickReport): void {
  try {
    readRuntime(ctx.paths)
  } catch (e) {
    if (!(e instanceof SbError)) throw e
    const file = runtimeFile(ctx.paths)
    const aside = `${file}.corrupt-${new Date(ctx.now()).toISOString().replace(/[:.]/g, '-')}`
    renameSync(file, aside)
    const msg = `runtime.json estava corrompido: movi para ${aside} e recomecei vazio (overrides e pedidos pendentes foram perdidos)`
    note(ctx, msg)
    tell(ctx, msg)
    report.notices.push(msg)
  }
}

/** Etapas que rodaram / falharam neste ciclo: uma pane de etapa só se encerra quando um ciclo roda a etapa sem falhar. */
interface Steps {
  ran: Set<string>
  failed: Set<string>
}

/**
 * Uma falha de uma etapa (`agents`, `pins`, `swap:<mux>`, `semlink:<mux>`): sempre no relatório do ciclo; no log e na
 * notificação só na PRIMEIRA vez de cada pane. A chave é `err:<etapa>:<exit>` (nunca o texto: `claude agents` inclui um
 * trecho da saída, que varia); {@link clearRecovered} a apaga no fim do primeiro ciclo em que a etapa roda sem falhar,
 * então uma nova pane avisa de novo.
 */
function fail(ctx: Ctx, report: TickReport, steps: Steps, step: string, e: SbError, runtime?: Runtime): void {
  const msg = redact(e.message)
  steps.ran.add(step)
  steps.failed.add(step)
  report.notices.push(`${step}: ${msg}`)
  const key = `err:${step}:${e.exit}`
  let first = false
  const mark = (r: Runtime): void => {
    if (r.notified[key] !== undefined) return
    r.notified[key] = ctx.now()
    first = true
  }
  if (runtime !== undefined) mark(runtime)
  else mutateRuntime(ctx, mark)
  if (first) {
    note(ctx, `${step}: ${msg}`)
    tell(ctx, `Problema no watch (${step}): ${msg}`)
  }
}

/** Apaga as chaves `err:` das etapas que rodaram neste ciclo sem falhar (a pane acabou). */
function clearRecovered(ctx: Ctx, steps: Steps): void {
  mutateRuntime(ctx, (r) => {
    for (const key of Object.keys(r.notified)) {
      if (!key.startsWith('err:')) continue
      const step = key.slice(4, key.lastIndexOf(':'))
      if (steps.ran.has(step) && !steps.failed.has(step)) delete r.notified[key]
    }
  })
}

/** Aviso que vai UMA vez (log + notificação) por chave de `runtime.notified`. `true` se foi agora. */
function noticeOnce(ctx: Ctx, report: TickReport, key: string, msg: string): boolean {
  let first = false
  mutateRuntime(ctx, (r) => {
    if (r.notified[key] !== undefined) return
    r.notified[key] = ctx.now()
    first = true
  })
  if (first) {
    note(ctx, msg)
    tell(ctx, msg)
    report.notices.push(msg)
  }
  return first
}

const PRUNABLE = ['warn:', 'muxwarn:', 'swap:', 'err:', 'sched:', 'stopfail:', 'kept:', 'limit:', 'pin:']
/** Prefixos cujo 2º segmento é o id da sessão: a chave morre junto com a sessão. */
const SESSION_KEYED = ['sched:', 'stopfail:', 'kept:', 'limit:', 'pin:']

/** Tira de `notified` o que passou de 7 dias e, se a lista de sessões carregou (`ids`), o que é de sessão que não existe mais. */
function prune(r: Runtime, now: number, ids: Set<string> | null): void {
  for (const [key, at] of Object.entries(r.notified)) {
    const prefix = PRUNABLE.find((p) => key.startsWith(p))
    if (prefix === undefined) continue
    const old = typeof at !== 'number' || now - at > PRUNE_AFTER_MS
    const id = SESSION_KEYED.includes(prefix) ? key.split(':')[1] : undefined
    const gone = ids !== null && id !== undefined && SESSION_ID_RE.test(id) && !ids.has(id)
    if (old || gone) delete r.notified[key]
  }
}

// ---------------------------------------------------------------------------------------------------------- sessões

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)

/** Últimas `n` linhas legíveis de `timeline.jsonl` (lê só o fim do arquivo). */
function timelineTail(ctx: Ctx, id: string, n = 3): Array<{ at?: unknown; state?: string; detail?: string }> {
  let text: string
  try {
    const fd = openSync(join(ctx.paths.jobsDir, assertSessionId(id), 'timeline.jsonl'), 'r')
    try {
      const size = fstatSync(fd).size
      const len = Math.min(size, 262_144)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, size - len)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  const out: Array<{ at?: unknown; state?: string; detail?: string }> = []
  for (const line of text.split('\n').filter((l) => l.trim() !== '').slice(-n)) {
    try {
      const d = JSON.parse(line) as Record<string, unknown>
      out.push({ at: d.at, state: str(d.state, 40), detail: str(d.detail, 80) })
    } catch {
      // linha cortada pelo início da leitura
    }
  }
  return out
}

/**
 * Os campos do `observa.py snapshot` (spikes/sessoes) — responde a pergunta aberta do F12 (o item `queued` roda de novo com
 * outro token?). Sem token: o dono é só o nome do mux/pin (nunca o valor de `--settings`), `inFlight` só tem contagens e tipos.
 */
function snapshotOf(ctx: Ctx, s: Session): Record<string, unknown> {
  const j = s.job
  const f = j?.inFlight
  const owner = s.owner.kind === 'mux' ? `mux:${s.owner.mux}` : s.owner.kind === 'pin' ? `pin:${s.owner.account}` : s.owner.kind
  return {
    id: s.agent.id,
    at: new Date(ctx.now()).toISOString(),
    agents: { state: s.agent.state, status: s.agent.status, hasPid: s.agent.pid != null, kind: s.agent.kind, startedAt: s.agent.startedAt },
    job: {
      state: j?.state,
      tempo: str(j?.tempo, 40),
      inFlight: f == null ? null : { tasks: f.tasks, queued: f.queued, kinds: f.kinds, drainableMonitors: f.drainableMonitors, hasWake: f.wake != null },
      needs: str(j?.needs, 120),
      detail: str(j?.detail, 80),
      cliVersion: str(j?.cliVersion, 40),
    },
    owner,
    timeline: timelineTail(ctx, s.agent.id),
  }
}

/**
 * Varredura única das sessões, ANTES das trocas (a troca pára exatamente as que interessam aqui): 1ª vez que cada sessão
 * viva fica `limit-blocked` → um snapshot no `watch.log`; sessões vivas de mux sem `inFlight` → lista "mantidas" (uma linha
 * no log por sessão); poda de `runtime.notified`. `claude agents` fora do ar não derruba o ciclo: pula o que depende da lista.
 */
/** Devolve `true` quando alguma sessão viva DE MUX ficou presa por limite neste ciclo (é nova: ainda não tinha snapshot). */
function scanSessions(ctx: Ctx, runtime: Runtime, report: TickReport, steps: Steps): boolean {
  const now = ctx.now()
  let newlyBlocked = false
  let sessions: Session[] | null = null
  steps.ran.add('agents')
  try {
    sessions = loadSessionsDeduped(ctx, runtime)
  } catch (e) {
    if (!(e instanceof SbError)) throw e
    fail(ctx, report, steps, 'agents', e, runtime)
  }
  if (sessions !== null) {
    for (const s of sessions) {
      const id = s.agent.id
      const limit = `limit:${id}`
      if (!(s.live && isLimitBlocked(s))) delete runtime.notified[limit] // um novo bloqueio, depois, volta a ter snapshot
      else if (runtime.notified[limit] === undefined) {
        runtime.notified[limit] = now
        if (s.owner.kind === 'mux') newlyBlocked = true
        note(ctx, `sessão ${id} ficou presa por limite: ${JSON.stringify(snapshotOf(ctx, s))}`)
      }
      if (s.live && s.owner.kind === 'mux' && s.job !== null && s.job.inFlight == null) {
        report.kept.push(id)
        const key = `kept:${id}`
        if (runtime.notified[key] === undefined) {
          runtime.notified[key] = now
          note(ctx, `sessão ${id} (mux ${s.owner.mux}) mantida: o state.json não tem inFlight (versão antiga do claude?); conta como ocupada e o watch nunca a reinicia`)
        }
      }
    }
  }
  prune(runtime, now, sessions === null ? null : new Set(sessions.map((s) => s.agent.id)))
  return newlyBlocked
}

// ------------------------------------------------------------------------------------------------------------- troca

/** Por que a conta atual não serve mais (para o `reason` da troca e para o aviso), em português. */
function swapReason(cfg: Config, usage: UsageFile, ev: MuxEval, nowMs: number): string {
  const th = cfg.swap.threshold
  const m = usage.latest[ev.current]
  if (availability(m, th, nowMs) === 'exhausted' && m !== undefined) {
    if (!m.ok) {
      return m.error === 'rate-limited' ? `${ev.current} atingiu o limite (429)` : m.error === 'dead-token' ? `${ev.current} com token inválido` : `${ev.current} sem token`
    }
    const nowSec = nowMs / 1000
    const blocked = (w: { utilization: number; resetsAt: number; status: string }, limit: number): boolean =>
      (w.utilization >= limit || !w.status.startsWith('allowed')) && nowSec < w.resetsAt
    const pct = (u: number): string => `${Math.round(u * 100)}%`
    if (blocked(m.fiveHour, th.fiveHour)) return `${ev.current} em ${pct(m.fiveHour.utilization)} de 5h`
    if (blocked(m.sevenDay, th.sevenDay)) return `${ev.current} em ${pct(m.sevenDay.utilization)} de 7d`
    return `${ev.current} recusada pela API`
  }
  if (ev.reason === 'override') return `override manual em ${ev.desired}`
  if (ev.desired === cfg.mux[ev.mux]?.account) return `a preferida ${ev.desired} está disponível de novo`
  return 'regra do pool'
}

interface MuxCtx {
  ctx: Ctx
  cfg: Config
  usage: UsageFile
  report: TickReport
  restartOpts: RestartOptions
  swapped: Set<string>
  steps: Steps
}

/** Um mux por ciclo: link ausente → preferida; troca interrompida → grava `since`; avalia; cooldown; troca ou avisa. */
function handleMux(c: MuxCtx, mux: string): void {
  const { ctx, cfg, usage, report, steps } = c
  const m = cfg.mux[mux]!
  const now = ctx.now()
  let current = currentAccount(ctx.paths, mux)

  if (current === null) {
    const pref = m.account
    ensureState(ctx.paths)
    if (pref !== KEYCHAIN && !hasToken(ctx.paths, pref)) {
      fail(ctx, report, steps, `semlink:${mux}`, new SbError(`mux ${mux}: o link não existe e a preferida "${pref}" não tem token; rode \`sb login ${pref}\``, EXIT.CHECK_FAILED))
      return
    }
    pointMux(ctx.paths, mux, pref)
    const msg = `mux ${mux}: o link não existia; apontei para a preferida ${pref}`
    note(ctx, msg)
    report.notices.push(msg)
    current = pref
  }
  steps.ran.add(`semlink:${mux}`)

  // Troca interrompida entre `pointMux` e a gravação de `since` (a queda deixa o link na conta nova e `lastSwap.to` na antiga):
  // sem `since` o restartStale nunca reinicia as sessões antigas. Só vale com `lastSwap` registrado (sem ele o link pode
  // estar fora da preferida por um `sb mux set`, e `since` pararia sessões que ninguém pediu). Idempotente: grava `lastSwap.to = current`.
  const last = readRuntime(ctx.paths).mux[mux]?.lastSwap
  const here = current
  if (last !== undefined && last.to !== here) {
    mutateRuntime(ctx, (r) => {
      r.mux[mux] = { since: now, lastSwap: { at: now, from: last.to, to: here, reason: 'troca interrompida concluída pelo watch' } }
    })
    const msg = `mux ${mux}: o link já apontava para ${current} (última troca registrada: ${last.to}); registrei a troca para reiniciar as sessões antigas`
    note(ctx, msg)
    report.notices.push(msg)
  }

  const rt = readRuntime(ctx.paths)
  const ev = desiredAccount({ name: mux, mux: m, current, usage, swap: cfg.swap, ...(rt.overrides[mux] !== undefined && { override: rt.overrides[mux] }), nowMs: now })
  report.evaluations.push(ev)

  // avisos do mux (uma vez por texto; a chave some quando a condição passa, para um retorno voltar a avisar)
  if (ev.warn === undefined) {
    mutateRuntime(ctx, (r) => {
      for (const k of Object.keys(r.notified)) if (k.startsWith(`muxwarn:${mux}:`)) delete r.notified[k]
    })
  } else {
    noticeOnce(ctx, report, `muxwarn:${mux}:${ev.warn}`, ev.warn)
  }

  if (ev.desired === current) {
    mutateRuntime(ctx, (r) => {
      for (const k of Object.keys(r.notified)) if (k.startsWith(`swap:${mux}:`)) delete r.notified[k]
    })
    return
  }

  const reason = swapReason(cfg, usage, ev, now)
  if (!cfg.swap.auto) {
    noticeOnce(ctx, report, `swap:${mux}:${ev.desired}`, `Mux ${mux}: ${reason}; vale trocar de ${current} para ${ev.desired} (\`sb swap ${mux} ${ev.desired}\`; swap.auto está desligado)`)
    return
  }

  // cooldown: o mux não troca sozinho duas vezes em menos de 5 min, salvo se a conta atual está esgotada
  const lastAt = rt.mux[mux]?.lastSwap?.at
  const elapsed = lastAt === undefined ? Infinity : now - lastAt
  if (elapsed >= 0 && elapsed < SWAP_COOLDOWN_MS && availability(usage.latest[current], cfg.swap.threshold, now) !== 'exhausted') return

  const outcome = applySwap(ctx, cfg, { mux, to: ev.desired, reason }, c.restartOpts)
  if ('noop' in outcome) return
  c.swapped.add(mux)
  report.swaps.push(outcome)
  const { from: _from, to: _to, ...rest } = outcome
  report.restarts[mux] = rest
  report.notices.push(`mux ${mux}: ${outcome.from} → ${outcome.to} (${reason})`)
}

// ---------------------------------------------------------------------------------------------------------- o ciclo

/** Uma sonda que falhou na conta em uso é repetida depois disto, sem esperar o `probeEvery` (medição perdida = troca atrasada). */
const PROBE_RETRY_MS = 30_000

/** Contas em uso agora (a atual de cada mux) cuja última sonda falhou (rede, resposta estranha) há mais de `PROBE_RETRY_MS`. */
function failedCurrentProbe(ctx: Ctx, cfg: Config, usage: UsageFile, nowMs: number): boolean {
  for (const mux of Object.keys(cfg.mux)) {
    const account = currentAccount(ctx.paths, mux)
    if (account === null || account === KEYCHAIN) continue
    const m = usage.latest[account]
    if (m === undefined || m.ok || m.error === 'no-token') continue
    const age = nowMs - m.measuredAt
    if (!(age >= 0 && age < PROBE_RETRY_MS)) return true
  }
  return false
}

function needsMeasure(cfg: Config, usage: UsageFile, nowMs: number, everyMs: number): boolean {
  const registry = Object.keys(cfg.accounts)
  if (registry.length === 0) return false
  const times = registry.map((a) => usage.latest[a]?.measuredAt)
  if (times.some((t) => t === undefined)) return true // conta nova: ainda não medida
  const age = nowMs - Math.max(...(times as number[]))
  return !(age >= 0 && age < everyMs) // relógio que voltou também refaz a medição
}

async function runTick(ctx: Ctx, cfg: Config, opts: TickOptions, report: TickReport): Promise<void> {
  const now = ctx.now()
  recoverRuntime(ctx, report)

  const everyMs = parseDuration(cfg.swap.probeEvery)
  let usage = readUsage(ctx.paths)
  if (needsMeasure(cfg, usage, now, everyMs)) {
    usage = await measureAll(ctx, cfg, { maxAgeMs: everyMs })
    report.measured = true
  } else if (failedCurrentProbe(ctx, cfg, usage, now)) {
    // a sonda da conta em uso falhou: repete já (as contas medidas há menos de PROBE_RETRY_MS ficam no cache)
    usage = await measureAll(ctx, cfg, { maxAgeMs: Math.min(everyMs, PROBE_RETRY_MS) })
    report.measured = true
  }

  const restartOpts: RestartOptions = { ...opts.restart, throttle: { stops: opts.maxStops ?? STOPS_PER_TICK } }

  mutateRuntime(ctx, (r) => {
    for (const [mux, o] of Object.entries(r.overrides)) if (!(o.until > now)) delete r.overrides[mux]
  })
  const steps: Steps = { ran: new Set(), failed: new Set() }
  let newlyBlocked = false
  mutateRuntime(ctx, (r) => {
    newlyBlocked = scanSessions(ctx, r, report, steps)
  })
  // Uma sessão de mux ACABOU de ficar presa por limite: a conta dela pode ter acabado entre duas sondas (a janela de
  // 5 h enche rápido). Mede na hora, em vez de esperar o `probeEvery`, para a troca sair neste mesmo ciclo.
  if (newlyBlocked && !report.measured) {
    usage = await measureAll(ctx, cfg, { maxAgeMs: PROBE_RETRY_MS })
    report.measured = true
  }

  const c: MuxCtx = { ctx, cfg, usage, report, restartOpts, swapped: new Set(), steps }
  for (const mux of Object.keys(cfg.mux)) {
    steps.ran.add(`swap:${mux}`)
    try {
      handleMux(c, mux)
    } catch (e) {
      if (!(e instanceof SbError)) throw e
      fail(ctx, report, steps, e.exit === EXIT.CLAUDE ? 'agents' : `swap:${mux}`, e) // `claude` fora do ar é uma pane só, em qualquer etapa
    }
  }

  for (const mux of Object.keys(cfg.mux)) {
    if (c.swapped.has(mux)) continue // o `applySwap` já reiniciou as sessões deste mux, com o mesmo teto
    steps.ran.add('agents')
    try {
      report.restarts[mux] = restartStale(ctx, cfg, mux, restartOpts)
    } catch (e) {
      if (!(e instanceof SbError)) throw e
      fail(ctx, report, steps, 'agents', e)
    }
  }

  steps.ran.add('pins')
  try {
    report.pending = applyPending(ctx, cfg, restartOpts)
  } catch (e) {
    if (!(e instanceof SbError)) throw e
    fail(ctx, report, steps, e.exit === EXIT.CLAUDE ? 'agents' : 'pins', e)
  }
  // `applyPending` já avisa o que aplicou e nunca o que ainda espera (`queued`); o que saiu da fila sem ser aplicado, não
  for (const p of report.pending) {
    if (p.result === 'gone') {
      const msg = `O pedido de pin/unpin/adoção/migração da sessão ${p.jobId} foi descartado (a sessão sumiu ou o pedido não vale mais).`
      tell(ctx, msg)
      report.notices.push(msg)
    } else if (p.result !== 'queued') {
      report.notices.push(`sessão ${p.jobId}: ${p.result}`)
    }
  }
  clearRecovered(ctx, steps)
}

/**
 * Um ciclo, sob o lock (ocupado por um pid vivo → `{ skipped: 'locked' }`; lock de pid morto é tomado). Fora do lock não se
 * lê nem se grava estado. O lock é do ciclo, não do laço: comandos manuais passam entre os ciclos.
 */
export async function tick(ctx: Ctx, cfg: Config, opts: TickOptions = {}): Promise<TickReport> {
  const memory = opts.memory ?? newMemory()
  const report = emptyReport()
  let entered = false
  try {
    await withLock(
      ctx.paths,
      async () => {
        entered = true
        memory.lockedTicks = 0
        memory.lockNotified = false
        await runTick(ctx, cfg, opts, report)
      },
      { waitMs: LOCK_WAIT_MS },
    )
    return report
  } catch (e) {
    if (entered || !(e instanceof SbError) || e.exit !== EXIT.LOCKED) throw e
  }
  // Lock ocupado. Persistente (vários ciclos) com dono vivo que não é o watch: avisa uma vez e segue no próximo ciclo.
  report.skipped = 'locked'
  memory.lockedTicks++
  if (memory.lockedTicks >= PERSISTENT_LOCK_TICKS && !memory.lockNotified) {
    const owner = peekPidFile(lockFile(ctx.paths))
    if (owner?.pid !== undefined && owner.pid !== process.pid) {
      memory.lockNotified = true
      const msg = `outro processo sb (pid ${owner.pid}) segura o lock do estado há ${memory.lockedTicks} ciclos; o watch continua tentando`
      note(ctx, msg)
      tell(ctx, msg)
      report.notices.push(msg)
    }
  }
  return report
}

// ---------------------------------------------------------------------------------------------------------- batimento

export type WatchStatus = { state: 'running' | 'stale'; pid?: number; lastTick?: number } | { state: 'absent' }

/**
 * O `watch` está vivo? `<estado>/watch.json` `{ pid, lastTick }`: rodando = o pid existe E o último ciclo foi há menos de 3
 * intervalos; arquivo ausente = `absent`; o resto (pid morto, ciclo atrasado, arquivo ilegível) = `stale`.
 */
export function watchStatus(ctx: Ctx, intervalMs = WATCH_INTERVAL_MS): WatchStatus {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(watchFile(ctx.paths), 'utf8'))
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'stale' }
  }
  const r = raw as { pid?: unknown; lastTick?: unknown } | null
  if (typeof r?.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0 || typeof r.lastTick !== 'number' || !Number.isFinite(r.lastTick)) return { state: 'stale' }
  const age = ctx.now() - r.lastTick
  return { state: isAlive(r.pid) && age <= 3 * intervalMs ? 'running' : 'stale', pid: r.pid, lastTick: r.lastTick }
}

function writeHeartbeat(ctx: Ctx): void {
  try {
    const file = watchFile(ctx.paths)
    mkdirPrivate(dirname(file))
    writeAtomic(file, `${JSON.stringify({ pid: process.pid, lastTick: ctx.now() })}\n`, 0o600)
  } catch (e) {
    note(ctx, `não consegui gravar o batimento: ${redact((e as Error).message)}`)
  }
}

function removeHeartbeat(ctx: Ctx): void {
  try {
    const file = watchFile(ctx.paths)
    const cur = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }
    if (cur.pid === process.pid) rmSync(file, { force: true }) // só o que é nosso
  } catch {
    // ausente ou ilegível: nada a limpar
  }
}

// -------------------------------------------------------------------------------------------------------------- laço

const sleepUntil = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

export interface LoopOptions {
  /** encerra o laço (o comando liga isto a SIGTERM/SIGINT); interrompe a espera entre ciclos */
  signal?: AbortSignal
  /** para os testes: encerra depois de N ciclos */
  maxTicks?: number
  /** para os testes: a espera entre ciclos */
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>
  tick?: TickOptions
}

/**
 * O laço: um `tick` a cada `intervalMs`, o batimento `<estado>/watch.json` antes e depois de cada ciclo (um ciclo com paradas
 * passa de 90 s) e a config recarregada a cada ciclo — inválida → registra (uma vez por mensagem) e espera, sem trocar nada.
 * Nenhum erro derruba o laço. Sai limpo quando `signal` dispara (apaga o batimento, se ainda for o nosso).
 */
export async function watchLoop(ctx: Ctx, intervalMs = WATCH_INTERVAL_MS, opts: LoopOptions = {}): Promise<void> {
  // um só laço por máquina (dois seriam corretos pelo lock, mas redundantes e brigariam pelo batimento)
  const pidFile = watchPidFile(ctx.paths)
  const got = await acquirePidFile(pidFile)
  if (!got.ok) {
    throw new SbError(
      got.pid === undefined ? `não consegui tomar ${pidFile}: outro sb watch pode estar rodando` : `já existe um sb watch rodando (pid ${got.pid})`,
      EXIT.LOCKED,
      `  se não há outro watch rodando, apague ${pidFile}`,
    )
  }
  const memory = newMemory()
  const sleep = opts.sleep ?? sleepUntil
  let lastError: string | undefined
  note(ctx, `watch iniciado (pid ${process.pid}, a cada ${Math.round(intervalMs / 1000)} s)`)
  try {
    for (let n = 0; ; ) {
      if (opts.signal?.aborted) break
      writeHeartbeat(ctx)
      try {
        const cfg = await loadConfig(ctx.paths)
        await tick(ctx, cfg, { ...opts.tick, memory })
        if (lastError !== undefined) note(ctx, 'o ciclo voltou a funcionar')
        lastError = undefined
      } catch (e) {
        const msg = redact(e instanceof SbError ? `${e.message}${e.detail ? `\n${e.detail}` : ''}` : e instanceof Error ? e.message : String(e))
        if (msg !== lastError) note(ctx, e instanceof SbError && e.exit === EXIT.INVALID_CONFIG ? `${msg}\nnada será trocado até a config voltar a valer` : `erro no ciclo: ${msg}`)
        lastError = msg
      }
      writeHeartbeat(ctx)
      n++
      if (opts.maxTicks !== undefined && n >= opts.maxTicks) break
      await sleep(intervalMs, opts.signal)
    }
  } finally {
    removeHeartbeat(ctx)
    releasePidFile(pidFile)
    note(ctx, 'watch encerrado')
  }
}
