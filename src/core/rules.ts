import type { MuxConfig, SwapConfig, Threshold } from './config.js'
import { groupOf, type Measurement, type UsageFile } from './usage.js'

/** Margem (fração) abaixo do limiar que a preferida precisa atingir para a conta VOLTAR a ela. */
export const HYSTERESIS = 0.1

export type Availability = 'available' | 'exhausted' | 'unknown'

/**
 * Disponibilidade de uma conta (puro: `nowMs` vem de fora).
 *
 * - sem medição → unknown; `no-token`/`dead-token` → exhausted;
 * - `rate-limited` → exhausted: um 429 da sonda é o sinal de conta esgotada. Não há reset conhecido,
 *   então vale até a próxima medição `ok`; a histerese não se aplica a ele;
 * - `network`/`unexpected` → unknown (falha nossa, não da conta);
 * - medição ok: janela esgotada se `utilization ≥ limite − margem` ou `status` não começa com
 *   `allowed` (`allowed_warning` não esgota). Janela esgotada só vale até o `resetsAt` dela
 *   (passado o reset, a conta volta a valer mesmo sem medição nova). O `status` geral `rejected`
 *   com `resetsAt` futuro também esgota.
 * - `returning`: margem de {@link HYSTERESIS} (só para voltar à preferida vinda de uma reserva).
 */
export function availability(
  m: Measurement | undefined,
  th: Threshold,
  nowMs: number,
  opts: { returning?: boolean } = {},
): Availability {
  if (m === undefined) return 'unknown'
  if (!m.ok) {
    return m.error === 'no-token' || m.error === 'dead-token' || m.error === 'rate-limited' ? 'exhausted' : 'unknown'
  }
  const margin = opts.returning ? HYSTERESIS : 0
  const nowSec = nowMs / 1000
  const blocked = (w: { utilization: number; resetsAt: number; status: string }, limit: number): boolean =>
    (w.utilization >= limit - margin || !w.status.startsWith('allowed')) && nowSec < w.resetsAt
  if (blocked(m.fiveHour, th.fiveHour) || blocked(m.sevenDay, th.sevenDay)) return 'exhausted'
  if (m.status === 'rejected' && nowSec < m.resetsAt) return 'exhausted'
  return 'available'
}

export interface MuxEval {
  mux: string
  current: string
  desired: string
  reason: 'no-pool' | 'override' | 'preferred' | 'sticky' | 'preferred-outside-pool' | 'pool' | 'none-available'
  /** texto em português para quem opera (o watch/CLI decidem onde mostrar) */
  warn?: string
}

/**
 * Conta que o mux deve usar agora (puro: sem relógio, sem I/O, sem mutar a entrada).
 *
 * `stay(c)` = `c ∈ mux.accounts` e `availability(c) ≠ 'exhausted'`. Medição `unknown` (falha da NOSSA
 * sonda: rede, 5xx, sem medição) nunca, sozinha, tira o mux de um lugar válido: parar sessões por um
 * erro nosso custaria duas paradas. Só `exhausted` (medido, 429, token morto) empurra.
 *
 * 1. pool vazio → current (nunca troca sozinho).
 * 2. override ativo (`nowMs < until`; `until` é em MILISSEGUNDOS):
 *    disponível → ele; `unknown` e current == override → current ('override');
 *    senão (esgotado, ou unknown com current ≠ override) o override é ANULADO e segue a regra normal
 *    (a preferida volta a valer).
 * 3. preferida: `R` = current ≠ pref, current ∈ accounts e current ∉ groupOf(pref) ("reserva": só ela
 *    tem histerese no retorno; duplicata da preferida ou current fora de accounts não é reserva).
 *    `pa = availability(pref, { returning: R })`.
 *    - current == pref ou duplicata dela: `pa ≠ exhausted` → fica ('preferred');
 *    - senão: pa available → (`!returnOnReset` e current ∈ pool e available) 'sticky', senão pref;
 *             pa unknown   → `stay(current)` ? current 'sticky' (sem evidência para sair) : pref;
 *             pa exhausted → segue.
 * 4. preferida esgotada e fora do pool → fica nela, com aviso.
 * 5. `current` se já é destino válido (∈ pool, ≠ pref, ∉ groupOf(pref), `availability ≠ exhausted`:
 *    available OU unknown, sem histerese) → fica ('pool'; trocar custa parar sessões, e a ordem do
 *    pool escolhe destino, não faz saltar entre reservas). Senão a 1ª conta do pool, na ordem, fora do
 *    grupo da preferida, sem repetir grupo, `available` (destino: só available, sem histerese).
 * 5b. `availability(pref)` sem histerese == available → pref. Nunca ficar numa conta esgotada ou morta
 *    com a preferida utilizável: a histerese segura uma reserva ainda usável, não uma esgotada.
 * 6. nenhuma → current, ou a preferida se current ∉ mux.accounts; com aviso.
 *
 * Decisões onde o brief é silencioso:
 * - current duplicata da preferida conta como a própria preferida e é mantida (mesma conta, sem troca).
 * - current ∉ mux.accounts só importa nos passos 3 (não é reserva, sem histerese) e 6; em 'no-pool'
 *   devolve-se current como veio ("nunca troca sozinho").
 * - Grupo é marcado visto ao ser visitado, disponível ou não (as cópias partilham a medição); o
 *   destino do passo 5 é a própria conta visitada, não o representante.
 */
export function desiredAccount(input: {
  name: string
  mux: MuxConfig
  current: string
  usage: UsageFile
  swap: SwapConfig
  /** `until` em MILISSEGUNDOS desde a época (compara com `nowMs`) */
  override?: { account: string; until: number }
  nowMs: number
}): MuxEval {
  const { name, mux, current, usage, swap, override, nowMs } = input
  const pref = mux.account
  const th = swap.threshold
  const pool = [...new Set(mux.pool)]
  const avail = (account: string, returning = false): Availability =>
    availability(usage.latest[account], th, nowMs, { returning })
  const stay = (c: string): boolean => mux.accounts.includes(c) && avail(c) !== 'exhausted'
  const done = (desired: string, reason: MuxEval['reason'], warn?: string): MuxEval =>
    warn === undefined ? { mux: name, current, desired, reason } : { mux: name, current, desired, reason, warn }

  if (pool.length === 0) return done(current, 'no-pool')

  let voided: string | undefined // override ativo que não pôde valer
  if (override !== undefined && nowMs < override.until) {
    const oa = avail(override.account)
    if (oa === 'available') return done(override.account, 'override')
    if (oa === 'unknown' && current === override.account) return done(current, 'override')
    voided = override.account
  }

  const prefGroup = groupOf(usage, pref)
  const prefLike = current === pref || prefGroup.includes(current)
  const reserve = !prefLike && mux.accounts.includes(current)
  const pa = avail(pref, reserve)
  if (prefLike) {
    if (pa !== 'exhausted') return done(current, 'preferred')
  } else if (pa === 'available') {
    const sticky = !swap.returnOnReset && pool.includes(current) && avail(current) === 'available'
    return sticky ? done(current, 'sticky') : done(pref, 'preferred')
  } else if (pa === 'unknown') {
    return stay(current) ? done(current, 'sticky') : done(pref, 'preferred')
  }

  if (!pool.includes(pref)) {
    return done(
      pref,
      'preferred-outside-pool',
      `Mux "${name}": a conta preferida "${pref}" está esgotada e fora do pool; não há troca possível, permanece nela.`,
    )
  }

  if (current !== pref && pool.includes(current) && !prefGroup.includes(current) && avail(current) !== 'exhausted') {
    return done(current, 'pool')
  }
  const seen = new Set<string>()
  for (const c of pool) {
    if (prefGroup.includes(c)) continue
    const rep = groupOf(usage, c)[0]!
    if (seen.has(rep)) continue
    seen.add(rep)
    if (avail(c) === 'available') return done(c, 'pool')
  }

  if (avail(pref) === 'available') return done(pref, 'preferred')

  const desired = mux.accounts.includes(current) ? current : pref
  const cause = voided === undefined ? '' : `o override em "${voided}" não está utilizável e `
  const outcome =
    desired === current
      ? `permanece em "${current}".`
      : `a conta atual "${current}" não pertence ao mux; usa a preferida "${pref}".`
  return done(desired, 'none-available', `Mux "${name}": ${cause}nenhuma conta está disponível (preferida e pool); ${outcome}`)
}
