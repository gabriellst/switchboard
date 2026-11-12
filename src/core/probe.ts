import type { FetchLike } from './ctx.js'

export interface Window {
  /** fração 0–1, repassada como veio (sem clamp) */
  utilization: number
  /** epoch em segundos; 0 = a API não mandou esta janela (não há janela ativa) */
  resetsAt: number
  status: string
}

export type ProbeResult =
  | {
      ok: true
      fiveHour: Window
      sevenDay: Window
      status: string
      resetsAt: number
      representativeClaim?: string
      overageStatus?: string
    }
  | { ok: false; error: 'dead-token' | 'rate-limited' | 'network' | 'unexpected'; httpStatus?: number }

const PREFIX = 'anthropic-ratelimit-unified-'
const PROBE_BODY = JSON.stringify({
  model: 'claude-haiku-4-5',
  max_tokens: 1,
  system: "You are Claude Code, Anthropic's official CLI for Claude.",
  messages: [{ role: 'user', content: 'ok' }],
})

type Headers = { get(n: string): string | null }

/** Os cabeçalhos de uso que a sonda conhece (só os nomes, sem o prefixo): servem ao diagnóstico de uma resposta que não deu para ler. */
const UNIFIED_NAMES = ['5h-utilization', '5h-reset', '5h-status', '7d-utilization', '7d-reset', '7d-status', 'status', 'reset', 'representative-claim', 'overage-status'] as const

/** O que a API devolveu, sem corpo e sem token: status HTTP e QUAIS cabeçalhos de uso vieram. */
export interface ProbeDiag {
  httpStatus: number
  unified: string[]
}

/** Número finito de um cabeçalho; vazio, em branco ou não numérico → undefined (nunca NaN). */
function num(h: Headers, name: string): number | undefined {
  const raw = h.get(PREFIX + name)?.trim()
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function str(h: Headers, name: string): string | undefined {
  return h.get(PREFIX + name)?.trim() || undefined
}

function windowOf(h: Headers, w: '5h' | '7d'): Window | undefined {
  const utilization = num(h, `${w}-utilization`)
  const resetsAt = num(h, `${w}-reset`)
  const status = str(h, `${w}-status`)
  if (utilization === undefined || resetsAt === undefined || status === undefined) return undefined
  return { utilization, resetsAt, status }
}

/** Janela que a API não mandou: sem uso e sem reset (`resetsAt` 0 = não há janela ativa). */
const ABSENT: Window = { utilization: 0, resetsAt: 0, status: 'allowed' }

const hasAny = (h: Headers, w: '5h' | '7d'): boolean => ['utilization', 'reset', 'status'].some((k) => h.get(`${PREFIX}${w}-${k}`) !== null)

/** Erro derivado só do status HTTP (sem dados de uso aproveitáveis nos cabeçalhos). */
function fromHttpStatus(httpStatus: number): ProbeResult {
  if (httpStatus === 401 || httpStatus === 403) return { ok: false, error: 'dead-token', httpStatus }
  if (httpStatus === 429) return { ok: false, error: 'rate-limited', httpStatus }
  return { ok: false, error: 'unexpected', httpStatus }
}

/**
 * Sonda mínima (F1): uma mensagem de 1 token no haiku; o uso vem dos cabeçalhos unified.
 * Os cabeçalhos são lidos qualquer que seja o status HTTP (conta esgotada responde 429 com eles).
 * O corpo da resposta nunca é lido. O token só vai no cabeçalho da requisição: nenhum campo
 * do resultado, nem erro, o carrega.
 */
export async function probeToken(
  token: string,
  opts: { fetch: FetchLike; baseUrl: string; timeoutMs?: number; onResponse?: (d: ProbeDiag) => void },
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let res: Awaited<ReturnType<FetchLike>>
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort()
        reject(new Error('timeout'))
      }, timeoutMs)
    })
    res = await Promise.race([
      opts.fetch(`${opts.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: PROBE_BODY,
        signal: ctl.signal,
      }),
      timeout,
    ])
  } catch {
    return { ok: false, error: 'network' }
  } finally {
    clearTimeout(timer)
  }

  const h = res.headers
  const httpStatus = res.status
  opts.onResponse?.({ httpStatus, unified: UNIFIED_NAMES.filter((n) => h.get(PREFIX + n) !== null) })
  // Uma janela pode vir AUSENTE por inteiro (visto em 12/11/2026: conta sem janela de 5 h ativa responde só com os 7d-*):
  // ausente = sem uso nela (0 %, sem reset, `resetsAt` 0). Janela INCOMPLETA (parte dos cabeçalhos) continua sendo erro.
  const has5 = hasAny(h, '5h')
  const has7 = hasAny(h, '7d')
  if (has5 || has7) {
    const fiveHour = has5 ? windowOf(h, '5h') : ABSENT
    const sevenDay = has7 ? windowOf(h, '7d') : ABSENT
    const status = str(h, 'status')
    const resetsAt = num(h, 'reset')
    // Cabeçalhos incompletos ou ilegíveis: nada de resultado parcial nem NaN, mas o sinal
    // HTTP não se perde (conta esgotada = 429 mesmo com formato de cabeçalho inesperado).
    if (!fiveHour || !sevenDay || status === undefined || resetsAt === undefined) {
      return fromHttpStatus(httpStatus)
    }
    const representativeClaim = str(h, 'representative-claim')
    const overageStatus = str(h, 'overage-status')
    return {
      ok: true,
      fiveHour,
      sevenDay,
      status,
      resetsAt,
      ...(representativeClaim !== undefined && { representativeClaim }),
      ...(overageStatus !== undefined && { overageStatus }),
    }
  }
  return fromHttpStatus(httpStatus)
}
