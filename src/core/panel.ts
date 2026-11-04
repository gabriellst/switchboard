import type { Config, Threshold } from './config.js'
import { currentAccount } from './links.js'
import type { Paths } from './paths.js'
import type { Session } from './sessions.js'
import type { Runtime } from './runtime.js'
import { KEYCHAIN } from './schema.js'
import { tokenStatus } from './tokens.js'
import { groupOf, poolTotal, type Measurement, type UsageFile } from './usage.js'

export type MuxRole = 'preferred' | 'pool' | 'allowed'

export interface MuxMembership {
  mux: string
  role: MuxRole
  /** posição (1-based) no pool do mux, quando a conta está nele (a preferida também) */
  position?: number
}

export interface PanelData {
  accounts: Array<{ name: string; measurement?: Measurement; sameAs?: string; muxes: MuxMembership[] }>
  mux: Array<{ name: string; current: string | null; preferred: string; pool: string[]; override?: { account: string; until: number } }>
  total: ReturnType<typeof poolTotal>
  auto: boolean
  threshold: Threshold
  /** sessões fixas (`owner.kind == 'pin'`, vivas ou paradas); vazio se não deu para listar as sessões */
  pins: Array<{ jobId: string; account: string }>
  measuredAt: number | null
}

export interface AccountInfo {
  name: string
  /** `dead` = a última medição foi 401/403 (só vale se o arquivo de token está ok) */
  token: 'ok' | 'missing' | 'invalid-json' | 'dead'
  measurement?: Measurement
  sameAs?: string
  /** aparece em `accounts` de pelo menos um mux */
  attached: boolean
  muxes: MuxMembership[]
}

const RANK: Record<MuxRole, number> = { preferred: 0, pool: 1, allowed: 2 }

/** Papel da conta em cada mux que a lista; preferida primeiro, depois o pool por posição, depois as permitidas. */
function membershipsOf(cfg: Config, account: string): MuxMembership[] {
  const out: MuxMembership[] = []
  for (const [mux, m] of Object.entries(cfg.mux)) {
    if (!m.accounts.includes(account)) continue
    const idx = m.pool.indexOf(account)
    const role: MuxRole = m.account === account ? 'preferred' : idx >= 0 ? 'pool' : 'allowed'
    out.push({ mux, role, ...(idx >= 0 && { position: idx + 1 }) })
  }
  // ordenação estável: empates ficam na ordem da config
  return out.sort((a, b) => RANK[a.role] - RANK[b.role] || (a.position ?? 0) - (b.position ?? 0))
}

/** O representante do grupo de duplicatas, se `account` é uma cópia (e o representante está no registro). */
function sameAsOf(cfg: Config, usage: UsageFile, account: string): string | undefined {
  const rep = groupOf(usage, account)[0]!
  return rep !== account && rep in cfg.accounts ? rep : undefined
}

export function buildPanel(cfg: Config, usage: UsageFile, runtime: Runtime, paths: Paths, sessions: Session[] = []): PanelData {
  const registry = Object.keys(cfg.accounts)
  const usesKeychain = Object.values(cfg.mux).some((m) => m.accounts.includes(KEYCHAIN))
  const names = usesKeychain ? [...registry, KEYCHAIN] : registry
  const accounts = names.map((name) => {
    const measurement = usage.latest[name]
    const sameAs = sameAsOf(cfg, usage, name)
    return { name, ...(measurement && { measurement }), ...(sameAs && { sameAs }), muxes: membershipsOf(cfg, name) }
  })
  const times = registry.map((a) => usage.latest[a]?.measuredAt).filter((t): t is number => t !== undefined)
  return {
    accounts,
    mux: Object.entries(cfg.mux).map(([name, m]) => {
      const override = runtime.overrides[name]
      return {
        name,
        current: currentAccount(paths, name),
        preferred: m.account,
        pool: m.pool,
        ...(override && { override: { account: override.account, until: override.until } }),
      }
    }),
    total: poolTotal(cfg, usage),
    auto: cfg.swap.auto,
    threshold: cfg.swap.threshold,
    pins: sessions.flatMap((s) => (s.owner.kind === 'pin' ? [{ jobId: s.agent.id, account: s.owner.account }] : [])),
    measuredAt: times.length > 0 ? Math.max(...times) : null,
  }
}

/** A central de contas: todas as contas do registro, anexadas a algum mux ou não. Não mede nada. */
export function buildAccounts(cfg: Config, usage: UsageFile, paths: Paths): AccountInfo[] {
  return Object.keys(cfg.accounts).map((name) => {
    const measurement = usage.latest[name]
    const sameAs = sameAsOf(cfg, usage, name)
    const muxes = membershipsOf(cfg, name)
    const file = tokenStatus(paths, name)
    const dead = measurement?.ok === false && measurement.error === 'dead-token'
    return {
      name,
      token: file === 'ok' && dead ? 'dead' : file,
      ...(measurement && { measurement }),
      ...(sameAs && { sameAs }),
      attached: muxes.length > 0,
      muxes,
    }
  })
}
