import type { FetchLike } from './ctx.js'

export interface Window {
  /** fração 0–1, repassada como veio (sem clamp) */
  utilization: number
  /** epoch em segundos */
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

/**
 * Sonda mínima (F1): uma mensagem de 1 token no haiku; o uso vem dos cabeçalhos unified.
 * Os cabeçalhos são lidos qualquer que seja o status HTTP (conta esgotada responde 429 com eles).
 * O corpo da resposta nunca é lido. O token só vai no cabeçalho da requisição: nenhum campo
 * do resultado, nem erro, o carrega.
 */
export async function probeToken(
  token: string,
  opts: { fetch: FetchLike; baseUrl: string; timeoutMs?: number },
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
  if (h.get(PREFIX + '5h-utilization') !== null) {
    const fiveHour = windowOf(h, '5h')
    const sevenDay = windowOf(h, '7d')
    const status = str(h, 'status')
    const resetsAt = num(h, 'reset')
    // Cabeçalhos incompletos ou ilegíveis: nada de resultado parcial nem NaN.
    if (!fiveHour || !sevenDay || status === undefined || resetsAt === undefined) {
      return { ok: false, error: 'unexpected', httpStatus }
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
  if (httpStatus === 401 || httpStatus === 403) return { ok: false, error: 'dead-token', httpStatus }
  if (httpStatus === 429) return { ok: false, error: 'rate-limited', httpStatus }
  return { ok: false, error: 'unexpected', httpStatus }
}
