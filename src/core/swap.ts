import type { Config, MuxConfig } from './config.js'
import type { Ctx } from './ctx.js'
import { listAgents, stopSession, type StopOptions } from './claude.js'
import { EXIT, SbError } from './errors.js'
import { requireMux } from './accounts.js'
import { currentAccount, pointMux } from './links.js'
import { assertSafeName } from './paths.js'
import { availability, desiredAccount } from './rules.js'
import { readRuntime, writeRuntime, type Runtime } from './runtime.js'
import { activityOf, callerJobId, loadSessionsWithWarnings, startedAt, type Session } from './sessions.js'
import { KEYCHAIN } from './schema.js'
import { ensureState, hasToken } from './tokens.js'
import { readUsage, type Measurement } from './usage.js'

// ---------------------------------------------------------------------------------------------------------------
// Troca de conta de um mux (design §4, "Aplicar uma troca"). ESTE É O ÚNICO CÓDIGO QUE PARA SESSÕES EM ANDAMENTO.
// Regras que não se afrouxam:
//   - só pára sessão VIVA, do mux, iniciada ANTES da troca, e `free`/`limit-blocked` (a atividade é recalculada com
//     dados frescos imediatamente antes de cada `claude stop`: um turno que começou no meio-tempo vale `busy`);
//   - a sessão que chamou (`CLAUDE_JOB_DIR`), turnos em andamento, trabalho agendado, pins, estranhas, legado, outros
//     muxes e sessão sem `state.json` legível: NUNCA paradas;
//   - nada aqui é concorrente: tudo roda com o lock do estado tomado pelo CHAMADOR (`withLock`) e `stopSession`
//     BLOQUEIA o laço de eventos (`Atomics.wait`) até a sessão parar (até 45 s por sessão): é um passo bloqueante,
//     não o intercale com trabalho que precise de resposta rápida a sinais.
// ---------------------------------------------------------------------------------------------------------------

export interface SwapOutcome {
  mux: string
  from: string
  to: string
  /** paradas por nós (e confirmadas sem `pid`) */
  stopped: string[]
  /** estão num turno (ou não dá para ler o estado): esperam o fim; o `watch` tenta de novo */
  waitingBusy: string[]
  /** têm trabalho agendado: nunca paradas */
  keptScheduled: string[]
  failed: Array<{ id: string; error: string }>
}

export type Noop = { noop: true }

/** `stopSession` com o prazo/relógio injetáveis (só os testes mexem; o padrão é 45 s). */
export interface RestartOptions {
  stopTimeoutMs?: number
  stop?: StopOptions
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]+/g
const redact = (s: string): string => s.replace(TOKEN_RE, '<token>')

const usageError = (message: string, detail?: string): SbError => new SbError(message, EXIT.USAGE, detail)

/** Nunca lança: avisar é secundário e acontece depois de efeitos que não se desfazem. */
function tell(ctx: Ctx, title: string, msg: string): void {
  try {
    ctx.notify(title, msg)
  } catch {
    // notificação é só informativa
  }
}

function note(ctx: Ctx, line: string): void {
  try {
    ctx.log('watch', line)
  } catch {
    // o log é só informativo
  }
}

/**
 * Mesma ideia de `loadSessions`, mas cada aviso vai UMA vez para o `watch.log` (chave `warn:<aviso>` em
 * `runtime.notified`, que o chamador grava): quem faz polling não repete a linha a cada ciclo. Muda `runtime`.
 */
export function loadSessionsDeduped(ctx: Ctx, runtime: Runtime): Session[] {
  const { sessions, warnings } = loadSessionsWithWarnings(ctx)
  for (const w of warnings) {
    const key = `warn:${w}`
    if (runtime.notified[key] !== undefined) continue
    runtime.notified[key] = ctx.now()
    note(ctx, w)
  }
  return sessions
}

/**
 * Valida o destino de uma troca (não toca em nada): mux existe; `to ∈ mux.accounts`; `to` tem token (o `keychain`
 * não tem: o arquivo dele é sempre `{}` e `ensureState` o garante). Tudo exit 3.
 */
export function assertSwapTarget(ctx: Ctx, cfg: Config, mux: string, to: string): MuxConfig {
  assertSafeName(mux)
  assertSafeName(to)
  const m = requireMux(cfg, mux)
  if (!m.accounts.includes(to)) {
    throw usageError(`a conta "${to}" não pertence ao mux "${mux}" (contas permitidas: ${m.accounts.join(', ')})`, `  anexe com \`sb attach ${to} ${mux}\``)
  }
  if (to !== KEYCHAIN && !hasToken(ctx.paths, to)) {
    throw usageError(`a conta "${to}" não tem token: rode \`sb login ${to}\``)
  }
  return m
}

/**
 * Aplica a troca: (1) `pointMux` (atômico; sessões novas já nascem na conta nova); (2) grava
 * `runtime.mux[mux] = { since, lastSwap }` ANTES de qualquer parada (uma 2ª passada de `restartStale` nunca pára
 * sessão que nasceu depois da troca); (3) `restartStale`; (4) notifica e registra em `watch.log` (sem token).
 * `respawnFlags` NÃO são reescritos: já apontam para `mux/<mux>.json`.
 *
 * EXIGE O LOCK JÁ TOMADO pelo chamador (`withLock`): lê-modifica-grava `runtime.json` e pára sessões. Trocar para a
 * conta que o link já aponta devolve `{ noop: true }` sem tocar em nada. Link do mux ausente → exit 1 (nunca troca
 * "a partir de nada"). Se a parada das sessões não puder nem começar (`claude agents` falhou), o link JÁ foi trocado:
 * o erro diz isso.
 */
export function applySwap(ctx: Ctx, cfg: Config, p: { mux: string; to: string; reason: string }, opts: RestartOptions = {}): SwapOutcome | Noop {
  assertSwapTarget(ctx, cfg, p.mux, p.to)
  const from = currentAccount(ctx.paths, p.mux)
  if (from === null) {
    throw new SbError(`mux "${p.mux}": o link do mux não existe ou não aponta para uma conta`, EXIT.CHECK_FAILED, '  rode `sb doctor --fix`')
  }
  if (from === p.to) return { noop: true }
  if (p.to === KEYCHAIN) ensureState(ctx.paths) // `tokens/keychain.json` = `{}`: o único "token" do keychain

  pointMux(ctx.paths, p.mux, p.to)
  const now = ctx.now()
  const runtime = readRuntime(ctx.paths)
  runtime.mux[p.mux] = { since: now, lastSwap: { at: now, from, to: p.to, reason: p.reason } }
  writeRuntime(ctx.paths, runtime)

  let rest: Omit<SwapOutcome, 'from' | 'to'>
  try {
    rest = restartStale(ctx, cfg, p.mux, opts)
  } catch (e) {
    if (!(e instanceof SbError)) throw e
    const msg = `mux ${p.mux}: o link já aponta para ${p.to}, mas não consegui tratar as sessões antigas: ${e.message}`
    note(ctx, msg)
    throw new SbError(msg, e.exit, '  as sessões antigas continuam como estavam; nenhuma foi parada por esta troca')
  }
  const outcome: SwapOutcome = { ...rest, from, to: p.to }

  const parts = [`${outcome.stopped.length} parada(s)`]
  if (outcome.waitingBusy.length > 0) parts.push(`${outcome.waitingBusy.length} aguardando o fim do turno`)
  if (outcome.keptScheduled.length > 0) parts.push(`${outcome.keptScheduled.length} com trabalho agendado mantida(s)`)
  if (outcome.failed.length > 0) parts.push(`${outcome.failed.length} falha(s) ao parar`)
  note(
    ctx,
    `troca no mux ${p.mux}: ${from} → ${p.to} (${p.reason}); paradas: [${outcome.stopped.join(', ')}]; aguardando: [${outcome.waitingBusy.join(', ')}]; agendadas: [${outcome.keptScheduled.join(', ')}]; falhas: [${outcome.failed.map((f) => `${f.id}: ${f.error}`).join('; ')}]`,
  )
  tell(ctx, 'switchboard', `Mux ${p.mux}: ${from} → ${p.to} (${p.reason}). ${parts.join(', ')}.`)
  return outcome
}

/**
 * Para as sessões antigas livres do mux e classifica o resto. Uma sessão só entra em jogo se é VIVA, `owner` é ESTE mux
 * e `startedAt < runtime.mux[mux].since` (sem `since` gravado nada é "antigo": nunca pára sem uma troca registrada):
 *   - `free`/`limit-blocked` → `stopSession`, depois de reconferir a atividade com dados frescos (um turno que
 *     começou desde a listagem vira `waitingBusy`; uma sessão reaberta tem `startedAt` novo e sai);
 *   - `busy` (inclui a que chamou e a viva sem `state.json` legível) → `waitingBusy`;
 *   - `scheduled` → `keptScheduled`, nunca parada; se a conta de origem (`lastSwap.from`) está `exhausted`, notifica UMA
 *     vez (`runtime.notified['sched:<id>:<from>']`, texto sem token).
 * "Parada" exige `stopSession === true` E a entrada sem `pid` numa nova leitura de `claude agents`; sessão que já estava
 * sem `pid` não gera `claude stop` (que falharia). Erro de uma sessão (`SbError`) vai para `failed` e as demais seguem.
 * Pins, estranhas, legado e outros muxes: intocados.
 *
 * EXIGE O LOCK JÁ TOMADO (grava `runtime.json`). Bloqueante (ver o topo do arquivo).
 */
export function restartStale(ctx: Ctx, cfg: Config, mux: string, opts: RestartOptions = {}): Omit<SwapOutcome, 'from' | 'to'> {
  assertSafeName(mux)
  const out: Omit<SwapOutcome, 'from' | 'to'> = { mux, stopped: [], waitingBusy: [], keptScheduled: [], failed: [] }
  const runtime = readRuntime(ctx.paths)
  const state = runtime.mux[mux]
  const before = JSON.stringify(runtime)
  const save = (): void => {
    if (JSON.stringify(runtime) !== before) writeRuntime(ctx.paths, runtime)
  }
  if (state === undefined || !Number.isFinite(state.since)) return out
  const { since } = state
  const caller = callerJobId(ctx.env)
  const usage = readUsage(ctx.paths)

  const isStale = (s: Session): boolean => s.live && s.owner.kind === 'mux' && s.owner.mux === mux && startedAt(s) < since

  const keepScheduled = (id: string): void => {
    out.keptScheduled.push(id)
    const from = state.lastSwap?.from
    if (from === undefined) return
    const key = `sched:${id}:${from}`
    if (runtime.notified[key] !== undefined) return
    const m: Measurement | undefined = usage.latest[from]
    if (availability(m, cfg.swap.threshold, ctx.now()) !== 'exhausted') return
    runtime.notified[key] = ctx.now()
    tell(ctx, 'switchboard', `Sessão ${id} (mux ${mux}) tem trabalho agendado e ficou na conta esgotada ${from}.`)
    note(ctx, `sessão ${id} (mux ${mux}) tem trabalho agendado e ficou na conta esgotada ${from}`)
  }

  const candidates: string[] = []
  try {
    for (const s of loadSessionsDeduped(ctx, runtime)) {
      if (!isStale(s)) continue
      const act = activityOf(s, caller)
      if (act === 'busy') out.waitingBusy.push(s.agent.id)
      else if (act === 'scheduled') keepScheduled(s.agent.id)
      else if (act === 'free' || act === 'limit-blocked') candidates.push(s.agent.id)
    }
  } catch (e) {
    save() // avisos já emitidos não se repetem
    throw e
  }

  try {
    for (const id of candidates) {
      try {
        // dados frescos: o que era livre na listagem pode ter começado um turno (ou sido reaberto) enquanto paramos as anteriores
        const fresh = loadSessionsDeduped(ctx, runtime).find((s) => s.agent.id === id)
        if (fresh === undefined || !isStale(fresh)) continue // já parou sozinha ou foi reaberta (startedAt novo): não é nossa
        const act = activityOf(fresh, caller)
        if (act === 'busy') {
          out.waitingBusy.push(id)
          continue
        }
        if (act === 'scheduled') {
          keepScheduled(id)
          continue
        }
        if (act !== 'free' && act !== 'limit-blocked') continue
        if (fresh.agent.pid == null) continue // sem pid: nada a parar (e `claude stop` falharia)
        if (!stopSession(ctx, id, opts.stopTimeoutMs, opts.stop)) {
          out.failed.push({ id, error: '`claude stop` falhou ou a sessão não parou no prazo' })
          continue
        }
        const after = listAgents(ctx).find((a) => a.id === id)
        if (after !== undefined && after.pid != null) {
          out.failed.push({ id, error: 'o `claude stop` terminou, mas a sessão continua viva' })
          continue
        }
        out.stopped.push(id)
      } catch (e) {
        if (!(e instanceof SbError)) throw e
        out.failed.push({ id, error: redact(e.message) })
      }
    }
  } finally {
    save()
  }
  return out
}

/**
 * Troca manual (`sb swap`). EXIGE O LOCK JÁ TOMADO. Fluxo:
 *  - `--clear` (sem conta): apaga o override e aplica a conta que a regra escolhe SEM override (pode ser a atual = noop);
 *  - com conta: `∈ accounts` (exit 3); sem conta: a que `desiredAccount` escolheria com a preferida tratada como
 *    esgotada (nenhuma → exit 1; se a atual já é essa reserva → noop); mux de pool vazio exige a conta por extenso (exit 3);
 *  - grava `overrides[mux] = { account, until }` (ms) ANTES de aplicar (um erro depois não deixa a troca sem o override);
 *    `until` = `fiveHour.resetsAt * 1000` da preferida se a medição é `ok` e futura, senão `agora + 5 h`. Trocar para a
 *    própria preferida apaga o override. Mux de pool vazio não guarda override (o `watch` nunca avalia esse mux; o
 *    "até o reset" não significaria nada);
 *  - depois `applySwap`; o override fica gravado mesmo quando a troca é noop (a conta já era a pedida).
 */
export function manualSwap(
  ctx: Ctx,
  cfg: Config,
  mux: string,
  account?: string,
  o: { clear?: boolean } = {},
  opts: RestartOptions = {},
): SwapOutcome | Noop {
  assertSafeName(mux)
  if (account !== undefined) assertSafeName(account)
  const m = requireMux(cfg, mux)
  const now = ctx.now()
  const usage = readUsage(ctx.paths)
  const current = currentAccount(ctx.paths, mux)
  const needCurrent = (): string => {
    if (current === null) throw new SbError(`mux "${mux}": o link do mux não existe ou não aponta para uma conta`, EXIT.CHECK_FAILED, '  rode `sb doctor --fix`')
    return current
  }

  if (o.clear === true) {
    if (account !== undefined) throw usageError('--clear não aceita conta: ele volta à conta que a regra escolhe', `  use \`sb swap ${mux} --clear\` ou \`sb swap ${mux} ${account}\``)
    const cur = needCurrent()
    const ev = desiredAccount({ name: mux, mux: m, current: cur, usage, swap: cfg.swap, nowMs: now })
    const runtime = readRuntime(ctx.paths)
    if (runtime.overrides[mux] !== undefined) {
      delete runtime.overrides[mux]
      writeRuntime(ctx.paths, runtime)
    }
    return applySwap(ctx, cfg, { mux, to: ev.desired, reason: 'override manual removido' }, opts)
  }

  const pool = [...new Set(m.pool)]
  let target = account
  if (target === undefined) {
    if (pool.length === 0) throw usageError(`o mux "${mux}" não tem pool: informe a conta por extenso (\`sb swap ${mux} <conta>\`)`)
    const cur = needCurrent()
    // a preferida (e, pelo grupo, as cópias dela) conta como esgotada: a pergunta é "para onde, se não for ela?"
    const asExhausted: Measurement = { ok: false, error: 'rate-limited', measuredAt: now }
    const patched = { ...usage, latest: { ...usage.latest, [m.account]: asExhausted } }
    const ev = desiredAccount({ name: mux, mux: m, current: cur, usage: patched, swap: cfg.swap, nowMs: now })
    if (ev.reason === 'none-available' || ev.reason === 'preferred-outside-pool' || ev.desired === m.account) {
      throw new SbError(`mux "${mux}": nenhuma outra conta está disponível além da preferida "${m.account}"`, EXIT.CHECK_FAILED, ev.warn === undefined ? undefined : `  ${ev.warn}`)
    }
    target = ev.desired
  }
  assertSwapTarget(ctx, cfg, mux, target)

  const runtime = readRuntime(ctx.paths)
  if (target === m.account || pool.length === 0) {
    if (runtime.overrides[mux] !== undefined) {
      delete runtime.overrides[mux]
      writeRuntime(ctx.paths, runtime)
    }
  } else {
    const five = usage.latest[m.account]
    const reset = five?.ok === true ? five.fiveHour.resetsAt * 1000 : undefined
    const until = reset !== undefined && reset > now ? reset : now + FIVE_HOURS_MS
    runtime.overrides[mux] = { account: target, until }
    writeRuntime(ctx.paths, runtime)
  }
  return applySwap(ctx, cfg, { mux, to: target, reason: account === undefined ? 'manual (próxima conta da fila)' : 'manual' }, opts)
}
