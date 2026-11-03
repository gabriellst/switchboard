import { afterEach, describe, expect, test } from 'bun:test'
import { probeToken } from '../src/core/probe.js'
import type { FetchLike } from '../src/core/ctx.js'
import { FAKE_TOKEN, fakeApi, type FakeApi } from './helpers.js'

const H: Record<string, string> = {
  'anthropic-ratelimit-unified-5h-utilization': '0.24',
  'anthropic-ratelimit-unified-5h-reset': '1762195800',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.38',
  'anthropic-ratelimit-unified-7d-reset': '1762444800',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-reset': '1762195800',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
}

let lastCall: { url: string; init: Parameters<FetchLike>[1] }
function recordingFetch(status: number, headers: Record<string, string>): FetchLike {
  return async (url, init) => {
    lastCall = { url, init }
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    return { status, headers: { get: (n) => lower[n.toLowerCase()] ?? null } }
  }
}
const without = (...keys: string[]): Record<string, string> => Object.fromEntries(Object.entries(H).filter(([k]) => !keys.includes(k)))
const probe = (status: number, headers: Record<string, string>) =>
  probeToken(FAKE_TOKEN, { fetch: recordingFetch(status, headers), baseUrl: 'http://x' })

const OK = {
  ok: true as const,
  fiveHour: { utilization: 0.24, resetsAt: 1762195800, status: 'allowed' },
  sevenDay: { utilization: 0.38, resetsAt: 1762444800, status: 'allowed' },
  status: 'allowed',
  resetsAt: 1762195800,
  representativeClaim: 'five_hour',
}

describe('probeToken', () => {
  test('200: request exato do F1 e parse numérico', async () => {
    const r = await probe(200, H)
    expect(r).toEqual(OK)
    expect(lastCall.url).toBe('http://x/v1/messages')
    expect(lastCall.init.method).toBe('POST')
    expect(lastCall.init.headers).toMatchObject({
      authorization: `Bearer ${FAKE_TOKEN}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    })
    expect(JSON.parse(lastCall.init.body)).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: 'user', content: 'ok' }],
    })
    expect(lastCall.init.signal).toBeInstanceOf(AbortSignal)
  })

  test('429 com cabeçalhos → ok com status rejected', async () => {
    const r = await probe(429, {
      ...H,
      'anthropic-ratelimit-unified-5h-utilization': '1.0',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-status': 'rejected',
    })
    expect(r).toMatchObject({
      ok: true,
      fiveHour: { utilization: 1, status: 'rejected' },
      status: 'rejected',
    })
  })

  test('baseUrl com barra final não duplica a barra', async () => {
    await probeToken(FAKE_TOKEN, { fetch: recordingFetch(200, H), baseUrl: 'http://x/' })
    expect(lastCall.url).toBe('http://x/v1/messages')
  })

  test('cabeçalhos opcionais ausentes: representativeClaim e overageStatus saem do objeto', async () => {
    const r = await probe(200, without('anthropic-ratelimit-unified-representative-claim'))
    expect(r.ok).toBe(true)
    expect('representativeClaim' in r).toBe(false)
    expect('overageStatus' in r).toBe(false)
    const r2 = await probe(200, { ...H, 'anthropic-ratelimit-unified-overage-status': 'rejected' })
    expect(r2).toMatchObject({ ok: true, overageStatus: 'rejected' })
  })

  test('nomes de cabeçalho case-insensitive (via headers.get)', async () => {
    const upper = Object.fromEntries(Object.entries(H).map(([k, v]) => [k.toUpperCase(), v]))
    expect(await probe(200, upper)).toEqual(OK)
  })

  test.each([
    [401, 'dead-token'],
    [403, 'dead-token'],
    [429, 'rate-limited'],
    [500, 'unexpected'],
  ] as const)('%i sem cabeçalhos → %s', async (status, error) => {
    expect(await probe(status, {})).toEqual({ ok: false, error, httpStatus: status })
  })

  test('fetch lança → network, sem token no resultado', async () => {
    const r = await probeToken(FAKE_TOKEN, {
      fetch: async () => {
        throw new Error(`boom ${FAKE_TOKEN}`)
      },
      baseUrl: 'http://x',
    })
    expect(r).toEqual({ ok: false, error: 'network' })
    expect(JSON.stringify(r)).not.toMatch(/sk-ant-/)
  })

  test('timeout → network (aborta pelo signal)', async () => {
    const hang: FetchLike = (_u, init) =>
      new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error(`abortado ${FAKE_TOKEN}`))))
    const r = await probeToken(FAKE_TOKEN, { fetch: hang, baseUrl: 'http://x', timeoutMs: 20 })
    expect(r).toEqual({ ok: false, error: 'network' })
  })

  test('utilization não numérica ou vazia → unexpected (nunca NaN)', async () => {
    for (const bad of ['', 'abc', ' ', 'NaN', 'Infinity']) {
      const r = await probe(200, { ...H, 'anthropic-ratelimit-unified-5h-utilization': bad })
      expect(r).toEqual({ ok: false, error: 'unexpected', httpStatus: 200 })
    }
  })

  test('reset não numérico → unexpected', async () => {
    const r = await probe(200, { ...H, 'anthropic-ratelimit-unified-7d-reset': 'amanhã' })
    expect(r).toEqual({ ok: false, error: 'unexpected', httpStatus: 200 })
  })

  test('utilization em percentual (>1) é repassada sem clamp', async () => {
    const r = await probe(200, { ...H, 'anthropic-ratelimit-unified-5h-utilization': '24' })
    expect(r).toMatchObject({ ok: true, fiveHour: { utilization: 24 } })
  })

  test('5h presente e 7d ausente → unexpected', async () => {
    for (const k of ['utilization', 'reset', 'status']) {
      const r = await probe(200, without(`anthropic-ratelimit-unified-7d-${k}`))
      expect(r).toEqual({ ok: false, error: 'unexpected', httpStatus: 200 })
    }
  })

  test('429 com 5h completo e 7d incompleto → rate-limited (mantém o sinal HTTP)', async () => {
    const r = await probe(429, without('anthropic-ratelimit-unified-7d-reset'))
    expect(r).toEqual({ ok: false, error: 'rate-limited', httpStatus: 429 })
  })

  test('429 com 5h-utilization não numérica → rate-limited', async () => {
    const r = await probe(429, { ...H, 'anthropic-ratelimit-unified-5h-utilization': 'abc' })
    expect(r).toEqual({ ok: false, error: 'rate-limited', httpStatus: 429 })
  })

  test('401/403 com cabeçalhos incompletos → dead-token; 200 incompleto segue unexpected', async () => {
    const bad = { ...H, 'anthropic-ratelimit-unified-5h-reset': '' }
    expect(await probe(401, bad)).toEqual({ ok: false, error: 'dead-token', httpStatus: 401 })
    expect(await probe(403, bad)).toEqual({ ok: false, error: 'dead-token', httpStatus: 403 })
    expect(await probe(500, bad)).toEqual({ ok: false, error: 'unexpected', httpStatus: 500 })
    expect(await probe(200, without('anthropic-ratelimit-unified-7d-utilization'))).toEqual({ ok: false, error: 'unexpected', httpStatus: 200 })
  })

  test('5h-status allowed_warning passa verbatim', async () => {
    const r = await probe(200, { ...H, 'anthropic-ratelimit-unified-5h-status': 'allowed_warning' })
    expect(r).toMatchObject({ ok: true, fiveHour: { status: 'allowed_warning' } })
  })

  test('status/reset globais ausentes → unexpected', async () => {
    expect(await probe(200, without('anthropic-ratelimit-unified-status'))).toEqual({ ok: false, error: 'unexpected', httpStatus: 200 })
    expect(await probe(200, without('anthropic-ratelimit-unified-reset'))).toEqual({ ok: false, error: 'unexpected', httpStatus: 200 })
  })

  describe('contra a API falsa (HTTP real em loopback)', () => {
    let api: FakeApi | undefined
    afterEach(() => api?.stop())

    test('fetch real: cabeçalhos HTTP chegam e o corpo é descartado', async () => {
      api = await fakeApi(() => new Response('{"secret":"corpo"}', { status: 429, headers: H }))
      const r = await probeToken(FAKE_TOKEN, { fetch: (u, i) => globalThis.fetch(u, i), baseUrl: api.url })
      expect(r).toMatchObject({ ok: true, fiveHour: { utilization: 0.24 } })
      expect(JSON.stringify(r)).not.toContain('corpo')
      expect(api.requests).toHaveLength(1)
      expect(new URL(api.requests[0]!.url).pathname).toBe('/v1/messages')
      expect(api.requests[0]!.headers.get('authorization')).toBe(`Bearer ${FAKE_TOKEN}`)
    })
  })
})
