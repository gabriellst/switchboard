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
 * Conta que o mux deve usar agora (puro). Ordem das regras (design §4):
 *
 * 1. pool vazio → current (nunca troca sozinho).
 * 2. override ativo (`nowMs < until`): disponível → ele; senão pula para 5 tratando a preferida como esgotada.
 * 3. sem override e a preferida não está esgotada (unknown conta como ok; `returning` quando
 *    current ≠ pref): `!returnOnReset` e current ≠ pref e current no pool e disponível → fica (sticky);
 *    senão a preferida.
 * 4. preferida esgotada e fora do pool → fica nela, com aviso.
 * 5. `current` se já é destino válido (no pool, ≠ preferida e não duplicata dela, `available`);
 *    senão a 1ª conta do pool, na ordem, que não seja da preferida (nem duplicata dela), sem repetir
 *    grupo de duplicatas, e disponível. Destinos usam `availability` SEM histerese.
 * 6. nenhuma → current, ou a preferida se current não está em `mux.accounts`; com aviso.
 *
 * Decisões onde o brief é silencioso:
 * - `current` fora de `mux.accounts` só importa no passo 6 (vira a preferida); em 'no-pool' devolve-se
 *   `current` como veio, porque "nunca troca sozinho".
 * - Grupo é marcado como visto ao ser visitado, disponível ou não: as cópias partilham a medição.
 * - O destino do passo 5 é a própria conta `c` visitada (não o representante do grupo).
 */
export function desiredAccount(input: {
  name: string
  mux: MuxConfig
  current: string
  usage: UsageFile
  swap: SwapConfig
  override?: { account: string; until: number }
  nowMs: number
}): MuxEval {
  const { name, mux, current, usage, swap, override, nowMs } = input
  const pref = mux.account
  const th = swap.threshold
  const pool = [...new Set(mux.pool)]
  const avail = (account: string, returning = false): Availability =>
    availability(usage.latest[account], th, nowMs, { returning })
  const done = (desired: string, reason: MuxEval['reason'], warn?: string): MuxEval =>
    warn === undefined ? { mux: name, current, desired, reason } : { mux: name, current, desired, reason, warn }

  if (pool.length === 0) return done(current, 'no-pool')

  const overrideActive = override !== undefined && nowMs < override.until
  if (overrideActive) {
    if (avail(override.account) === 'available') return done(override.account, 'override')
    // override esgotado: cai para o passo 5 com a preferida tratada como esgotada
  } else if (avail(pref, current !== pref) !== 'exhausted') {
    const sticky = !swap.returnOnReset && current !== pref && pool.includes(current) && avail(current) === 'available'
    return sticky ? done(current, 'sticky') : done(pref, 'preferred')
  } else if (!pool.includes(pref)) {
    return done(
      pref,
      'preferred-outside-pool',
      `Mux "${name}": a conta preferida "${pref}" está esgotada e fora do pool; não há troca possível, permanece nela.`,
    )
  }

  const prefGroup = groupOf(usage, pref)
  // Sem salto entre reservas: cada troca custa parar e reabrir sessões, e a ordem do pool serve para
  // ESCOLHER destino, não para pular quando uma reserva anterior se recupera. Se `current` já é um
  // destino válido (no pool, não é a preferida nem duplicata dela, e `available` sem histerese),
  // fica nela (reason 'pool', desired === current). `unknown` NÃO vale como válida aqui: uma reserva
  // com erro de rede só é deixada se outra estiver `available`; se nenhuma estiver, o passo 6
  // ('none-available') mantém `current`.
  if (current !== pref && pool.includes(current) && !prefGroup.includes(current) && avail(current) === 'available') {
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

  return done(
    mux.accounts.includes(current) ? current : pref,
    'none-available',
    `Mux "${name}": nenhuma conta do pool está disponível; permanece na conta atual.`,
  )
}
