import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Config } from './config.js'
import type { Ctx } from './ctx.js'
import { mkdirPrivate, writeAtomic } from './fsx.js'
import { usageFile, type Paths } from './paths.js'
import { probeToken, type ProbeResult } from './probe.js'
import { KEYCHAIN } from './schema.js'
import { loadSecret } from './tokens.js'

export type Measurement = (ProbeResult | { ok: false; error: 'no-token' }) & {
  /** ms desde a época (`ctx.now()`); `resetsAt` das janelas é em segundos */
  measuredAt: number
}

export interface UsageFile {
  /** última medição de cada conta do registro */
  latest: Record<string, Measurement>
  /** a medição anterior à `latest` (base da detecção de duplicatas) */
  previous: Record<string, Measurement>
  /** contas que são, na prática, a mesma; cada grupo na ordem do registro (o 1º é o representante) */
  groups: string[][]
}

const emptyUsage = (): UsageFile => ({ latest: {}, previous: {}, groups: [] })

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function isWindow(v: unknown): boolean {
  return isObj(v) && isNum(v.utilization) && isNum(v.resetsAt) && typeof v.status === 'string'
}

function isMeasurement(v: unknown): v is Measurement {
  if (!isObj(v) || !isNum(v.measuredAt) || typeof v.ok !== 'boolean') return false
  return v.ok ? isWindow(v.fiveHour) && isWindow(v.sevenDay) : typeof v.error === 'string'
}

function pickMeasurements(v: unknown): Record<string, Measurement> {
  const out: Record<string, Measurement> = {}
  if (!isObj(v)) return out
  for (const [account, m] of Object.entries(v)) if (isMeasurement(m)) out[account] = m
  return out
}

/**
 * Lê `usage.json`. Nunca lança: arquivo ausente, ilegível, corrompido ou de outro formato → vazio;
 * entradas inválidas dentro de um arquivo bom são descartadas (a próxima medição as refaz).
 */
export function readUsage(paths: Paths): UsageFile {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(usageFile(paths), 'utf8'))
  } catch {
    return emptyUsage()
  }
  if (!isObj(raw)) return emptyUsage()
  const groups = Array.isArray(raw.groups)
    ? raw.groups.filter((g): g is string[] => Array.isArray(g) && g.length >= 2 && g.every((a) => typeof a === 'string'))
    : []
  return { latest: pickMeasurements(raw.latest), previous: pickMeasurements(raw.previous), groups }
}

/** Impressão de uma medição `ok`: as quatro grandezas que a API repete para a mesma conta. */
function fingerprint(m: Measurement | undefined): string | null {
  if (!m?.ok) return null
  return `${m.fiveHour.resetsAt}|${m.sevenDay.resetsAt}|${m.fiveHour.utilization}|${m.sevenDay.utilization}`
}

/**
 * Duplicata (§6): contas cuja impressão é igual em `latest` E em `previous` (as duas `ok`).
 * Só vale depois de duas medições seguidas; uma igualdade isolada pode ser coincidência.
 * Cada grupo segue a ordem do registro; a ordem dos grupos, a do primeiro membro.
 */
function computeGroups(order: string[], latest: Record<string, Measurement>, previous: Record<string, Measurement>): string[][] {
  const byKey = new Map<string, string[]>()
  for (const account of order) {
    const now = fingerprint(latest[account])
    const before = fingerprint(previous[account])
    if (now === null || before === null) continue
    const key = `${now}#${before}`
    byKey.set(key, [...(byKey.get(key) ?? []), account])
  }
  return [...byKey.values()].filter((g) => g.length >= 2)
}

/**
 * Mede as contas do REGISTRO (`cfg.accounts`; `keychain` nunca) e grava `usage.json`.
 *
 * - Pula a conta cuja `latest.measuredAt` é mais nova que `maxAgeMs` (cache; `maxAgeMs: 0` força).
 *   Exceção: `no-token` não fica preso no cache (não custa chamada e o token pode ter sido salvo agora).
 *   Medição com idade negativa (relógio voltou) não vale como cache.
 * - Contas com o MESMO token fazem uma chamada só e recebem a mesma medição. A comparação de
 *   tokens é em memória (`Map<token, contas>`); nada derivado do token é gravado.
 * - Conta sem token → `{ ok:false, error:'no-token' }`, sem rede.
 * - `previous ← latest` antes de gravar a nova (só nas contas medidas agora). Entradas de contas
 *   que saíram do registro são descartadas.
 *
 * LOCK: esta função NÃO toma o lock do estado. O `watch` já o segura durante todo o laço; quem não o
 * tem (`sb usage`, `sb accounts`) envolve a chamada em `withLock(ctx.paths, () => measureAll(...))`,
 * senão duas medições concorrentes podem perder uma atualização. A gravação em si é atômica (600).
 */
export async function measureAll(ctx: Ctx, cfg: Config, opts: { maxAgeMs: number }): Promise<UsageFile> {
  const registry = Object.keys(cfg.accounts).filter((a) => a !== KEYCHAIN)
  const prev = readUsage(ctx.paths)
  const latest: Record<string, Measurement> = {}
  const previous: Record<string, Measurement> = {}
  for (const a of registry) {
    if (prev.latest[a]) latest[a] = prev.latest[a]
    if (prev.previous[a]) previous[a] = prev.previous[a]
  }

  const baseUrl = ctx.env.SWITCHBOARD_API_BASE ?? 'https://api.anthropic.com'
  const startedAt = ctx.now()
  const record = (account: string, m: Measurement): void => {
    if (latest[account]) previous[account] = latest[account]
    latest[account] = m
  }

  const byToken = new Map<string, string[]>() // só em memória
  for (const account of registry) {
    const cached = latest[account]
    if (cached && !(cached.ok === false && cached.error === 'no-token')) {
      const age = startedAt - cached.measuredAt
      if (age >= 0 && age < opts.maxAgeMs) continue
    }
    const token = loadSecret(ctx.paths, account)
    if (token === null) {
      record(account, { ok: false, error: 'no-token', measuredAt: ctx.now() })
      continue
    }
    byToken.set(token, [...(byToken.get(token) ?? []), account])
  }

  for (const [token, accounts] of byToken) {
    const result = await probeToken(token, { fetch: ctx.fetch, baseUrl })
    const measuredAt = ctx.now()
    for (const account of accounts) record(account, { ...result, measuredAt })
  }

  const usage: UsageFile = { latest, previous, groups: computeGroups(registry, latest, previous) }
  mkdirPrivate(dirname(usageFile(ctx.paths)))
  writeAtomic(usageFile(ctx.paths), JSON.stringify(usage, null, 2) + '\n', 0o600)
  return usage
}

/** O grupo de duplicatas da conta (ordem do registro), ou `[account]` se não tem duplicata. */
export function groupOf(usage: UsageFile, account: string): string[] {
  return usage.groups.find((g) => g.includes(account)) ?? [account]
}

/**
 * Total do pool: média, por janela, dos representantes (1º de cada grupo) das contas que estão no
 * `pool` de ALGUM mux e têm medição `ok`. O representante de uma duplicata conta uma vez, mesmo que
 * só a cópia esteja no pool (é a mesma conta). `accounts`: representantes, na ordem do registro.
 */
export function poolTotal(cfg: Config, usage: UsageFile): { fiveHour: number | null; sevenDay: number | null; accounts: string[] } {
  const inPool = new Set(Object.values(cfg.mux).flatMap((m) => m.pool))
  const reps: string[] = []
  for (const account of Object.keys(cfg.accounts)) {
    if (!inPool.has(account) || !usage.latest[account]?.ok) continue
    const rep = groupOf(usage, account)[0]!
    if (usage.latest[rep]?.ok && !reps.includes(rep)) reps.push(rep)
  }
  const wins = reps.map((a) => usage.latest[a]).filter((m): m is Extract<Measurement, { ok: true }> => m?.ok === true)
  if (wins.length === 0) return { fiveHour: null, sevenDay: null, accounts: [] }
  const avg = (pick: (m: Extract<Measurement, { ok: true }>) => number): number => wins.reduce((s, m) => s + pick(m), 0) / wins.length
  return { fiveHour: avg((m) => m.fiveHour.utilization), sevenDay: avg((m) => m.sevenDay.utilization), accounts: reps }
}
