import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseConfig, type Config } from '../src/core/config.js'
import type { FetchLike } from '../src/core/ctx.js'
import { withLock } from '../src/core/fsx.js'
import { usageFile } from '../src/core/paths.js'
import { groupOf, measureAll, poolTotal, readUsage, type Measurement, type UsageFile } from '../src/core/usage.js'
import { FAKE_TOKEN, sandbox, type Sandbox } from './helpers.js'

const TOKEN_B = 'sk-ant-oat01-' + 'y'.repeat(40)
const TOKEN_C = 'sk-ant-oat01-' + 'z'.repeat(40)

interface Reply {
  status?: number
  five?: number
  seven?: number
  reset5?: number
  reset7?: number
}

function headersOf(r: Reply): Record<string, string> {
  return {
    'anthropic-ratelimit-unified-5h-utilization': String(r.five ?? 0.24),
    'anthropic-ratelimit-unified-5h-reset': String(r.reset5 ?? 1762195800),
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': String(r.seven ?? 0.38),
    'anthropic-ratelimit-unified-7d-reset': String(r.reset7 ?? 1762444800),
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-reset': String(r.reset5 ?? 1762195800),
  }
}

/** fetch falso: responde por token (cabeçalho authorization) e conta as chamadas. */
function fakeFetch(byToken: Record<string, Reply>): { fetch: FetchLike; calls: { url: string; token: string }[] } {
  const calls: { url: string; token: string }[] = []
  const fetch: FetchLike = async (url, init) => {
    const token = (init.headers.authorization ?? '').replace('Bearer ', '')
    calls.push({ url, token })
    const reply = byToken[token] ?? {}
    const h = reply.status === 401 ? {} : headersOf(reply)
    return { status: reply.status ?? 200, headers: { get: (n) => h[n.toLowerCase()] ?? null } }
  }
  return { fetch, calls }
}

const cfgOf = (accounts: string[], mux: Record<string, string[]> = {}): Config =>
  parseConfig(
    JSON.stringify({
      switchboard: 1,
      accounts: Object.fromEntries(accounts.map((a) => [a, {}])),
      default: Object.keys(mux)[0],
      mux: Object.fromEntries(
        Object.entries(mux).map(([name, pool], i) => [name, { root: `/r${i}`, account: pool[0] ?? accounts[0], accounts: [...new Set([pool[0] ?? accounts[0], ...pool])], pool }]),
      ),
    }),
    'cfg',
  )

const T0 = 1_793_700_000_000
let sb: Sandbox

const ok = (five: number, seven: number, measuredAt = T0, reset5 = 100, reset7 = 200): Measurement => ({
  ok: true,
  fiveHour: { utilization: five, resetsAt: reset5, status: 'allowed' },
  sevenDay: { utilization: seven, resetsAt: reset7, status: 'allowed' },
  status: 'allowed',
  resetsAt: reset5,
  measuredAt,
})

describe('measureAll', () => {
  test('mesmo token salvo em duas contas → uma chamada só', async () => {
    sb = sandbox()
    sb.addToken('admin1')
    sb.addToken('outra')
    const api = fakeFetch({})
    const u = await measureAll(sb.ctx({ fetch: api.fetch, now: () => T0 }), cfgOf(['admin1', 'outra']), { maxAgeMs: 60_000 })
    expect(api.calls).toHaveLength(1)
    expect(u.latest.admin1).toBeDefined()
    expect(u.latest.admin1).toEqual(u.latest.outra!)
    expect(u.latest.admin1).toMatchObject({ ok: true, measuredAt: T0 })
  })

  test('tokens distintos → uma chamada por token', async () => {
    sb = sandbox()
    sb.addToken('a', FAKE_TOKEN)
    sb.addToken('b', TOKEN_B)
    sb.addToken('c', FAKE_TOKEN)
    const api = fakeFetch({ [FAKE_TOKEN]: { five: 0.1 }, [TOKEN_B]: { five: 0.5 } })
    const u = await measureAll(sb.ctx({ fetch: api.fetch, now: () => T0 }), cfgOf(['a', 'b', 'c']), { maxAgeMs: 0 })
    expect(api.calls.map((c) => c.token).sort()).toEqual([FAKE_TOKEN, TOKEN_B].sort())
    expect((u.latest.a as { fiveHour: { utilization: number } }).fiveHour.utilization).toBe(0.1)
    expect(u.latest.c).toEqual(u.latest.a!)
    expect((u.latest.b as { fiveHour: { utilization: number } }).fiveHour.utilization).toBe(0.5)
  })

  test('cache: medição com 30 s não sonda de novo com maxAgeMs 60 s', async () => {
    sb = sandbox()
    sb.addToken('admin1')
    const api = fakeFetch({})
    let now = T0
    const ctx = sb.ctx({ fetch: api.fetch, now: () => now })
    const cfg = cfgOf(['admin1'])
    await measureAll(ctx, cfg, { maxAgeMs: 60_000 })
    now = T0 + 30_000
    const u = await measureAll(ctx, cfg, { maxAgeMs: 60_000 })
    expect(api.calls).toHaveLength(1)
    expect(u.latest.admin1!.measuredAt).toBe(T0)
    expect(u.previous.admin1).toBeUndefined() // pulada: nada de previous ← latest
    now = T0 + 60_000 // exatamente maxAgeMs: não é "mais nova"
    const v = await measureAll(ctx, cfg, { maxAgeMs: 60_000 })
    expect(api.calls).toHaveLength(2)
    expect(v.latest.admin1!.measuredAt).toBe(T0 + 60_000)
    expect(v.previous.admin1!.measuredAt).toBe(T0)
  })

  test('relógio no futuro (medição com idade negativa) não vale como cache', async () => {
    sb = sandbox()
    sb.addToken('admin1')
    const api = fakeFetch({})
    const cfg = cfgOf(['admin1'])
    await measureAll(sb.ctx({ fetch: api.fetch, now: () => T0 + 999_999 }), cfg, { maxAgeMs: 60_000 })
    await measureAll(sb.ctx({ fetch: api.fetch, now: () => T0 }), cfg, { maxAgeMs: 60_000 })
    expect(api.calls).toHaveLength(2)
  })

  test('sem token → { ok:false, error:"no-token" } e nenhuma chamada', async () => {
    sb = sandbox()
    const api = fakeFetch({})
    const u = await measureAll(sb.ctx({ fetch: api.fetch, now: () => T0 }), cfgOf(['sem-token']), { maxAgeMs: 60_000 })
    expect(api.calls).toHaveLength(0)
    expect(u.latest['sem-token']).toEqual({ ok: false, error: 'no-token', measuredAt: T0 })
  })

  test('no-token não fica preso no cache: token salvo depois é medido na hora', async () => {
    sb = sandbox()
    const api = fakeFetch({})
    const ctx = sb.ctx({ fetch: api.fetch, now: () => T0 + 1000 })
    const cfg = cfgOf(['nova'])
    await measureAll(ctx, cfg, { maxAgeMs: 60_000 })
    sb.addToken('nova')
    const u = await measureAll(ctx, cfg, { maxAgeMs: 60_000 })
    expect(api.calls).toHaveLength(1)
    expect(u.latest.nova).toMatchObject({ ok: true })
  })

  test('keychain nunca é medida (nem com token no disco, nem registrada à força)', async () => {
    sb = sandbox()
    sb.addToken('keychain') // lixo no disco: loadSecret já recusa, e a medição nem pergunta
    sb.addToken('admin1')
    const api = fakeFetch({})
    const cfg = cfgOf(['admin1'])
    const forced = { ...cfg, accounts: { keychain: {}, ...cfg.accounts } } as Config
    const u = await measureAll(sb.ctx({ fetch: api.fetch, now: () => T0 }), forced, { maxAgeMs: 0 })
    expect(api.calls).toHaveLength(1)
    expect(Object.keys(u.latest)).toEqual(['admin1'])
  })

  test('só mede contas do registro; entradas de contas removidas saem do arquivo', async () => {
    sb = sandbox()
    sb.addToken('registrada')
    sb.addToken('fora')
    mkdirSync(dirname(usageFile(sb.paths)), { recursive: true })
    writeFileSync(usageFile(sb.paths), JSON.stringify({ latest: { fora: ok(0.1, 0.1) }, previous: { fora: ok(0.1, 0.1) }, groups: [['fora', 'x']] }))
    const api = fakeFetch({})
    const u = await measureAll(sb.ctx({ fetch: api.fetch, now: () => T0 }), cfgOf(['registrada']), { maxAgeMs: 0 })
    expect(api.calls).toHaveLength(1)
    expect(Object.keys(u.latest)).toEqual(['registrada'])
    expect(Object.keys(u.previous)).toEqual([])
    expect(u.groups).toEqual([])
    expect(readUsage(sb.paths)).toEqual(u)
  })

  test('previous ← latest antes de gravar a nova; grava e relê igual', async () => {
    sb = sandbox()
    sb.addToken('admin1')
    const replies: Record<string, Reply> = { [FAKE_TOKEN]: { five: 0.1 } }
    const api = fakeFetch(replies)
    let now = T0
    const ctx = sb.ctx({ fetch: api.fetch, now: () => now })
    const cfg = cfgOf(['admin1'])
    const first = await measureAll(ctx, cfg, { maxAgeMs: 0 })
    expect(first.previous.admin1).toBeUndefined()
    replies[FAKE_TOKEN] = { five: 0.3 }
    now = T0 + 5000
    const second = await measureAll(ctx, cfg, { maxAgeMs: 0 })
    expect(second.previous.admin1).toEqual(first.latest.admin1!)
    expect(second.latest.admin1).toMatchObject({ measuredAt: T0 + 5000, fiveHour: { utilization: 0.3 } })
    expect(readUsage(sb.paths)).toEqual(second)
  })

  test('erros da sonda ficam registrados como medição (401 → dead-token)', async () => {
    sb = sandbox()
    sb.addToken('morta')
    const api = fakeFetch({ [FAKE_TOKEN]: { status: 401 } })
    const u = await measureAll(sb.ctx({ fetch: api.fetch, now: () => T0 }), cfgOf(['morta']), { maxAgeMs: 0 })
    expect(u.latest.morta).toEqual({ ok: false, error: 'dead-token', httpStatus: 401, measuredAt: T0 })
  })

  test('a sonda usa ctx.fetch com a base de SWITCHBOARD_API_BASE (padrão: api.anthropic.com)', async () => {
    sb = sandbox()
    sb.addToken('admin1')
    const api = fakeFetch({})
    const cfg = cfgOf(['admin1'])
    await measureAll(sb.ctx({ fetch: api.fetch, now: () => T0, env: { ...sb.env, SWITCHBOARD_API_BASE: 'http://api.invalid:1234' } }), cfg, { maxAgeMs: 0 })
    const { SWITCHBOARD_API_BASE: _drop, ...noBase } = sb.env
    await measureAll(sb.ctx({ fetch: api.fetch, now: () => T0, env: noBase }), cfg, { maxAgeMs: 0 })
    expect(api.calls.map((c) => c.url)).toEqual(['http://api.invalid:1234/v1/messages', 'https://api.anthropic.com/v1/messages'])
  })

  test('duplicata só depois de duas medições iguais seguidas', async () => {
    sb = sandbox()
    sb.addToken('admin1', FAKE_TOKEN)
    sb.addToken('outra', TOKEN_B)
    sb.addToken('terceira', TOKEN_C)
    // tokens distintos, mesmos cabeçalhos para admin1 e outra; a terceira é diferente
    const api = fakeFetch({ [FAKE_TOKEN]: { five: 0.24 }, [TOKEN_B]: { five: 0.24 }, [TOKEN_C]: { five: 0.7 } })
    let now = T0
    const ctx = sb.ctx({ fetch: api.fetch, now: () => now })
    const cfg = cfgOf(['admin1', 'outra', 'terceira'])
    const first = await measureAll(ctx, cfg, { maxAgeMs: 0 })
    expect(first.groups).toEqual([])
    now += 1000
    const second = await measureAll(ctx, cfg, { maxAgeMs: 0 })
    expect(second.groups).toEqual([['admin1', 'outra']])
    expect(readUsage(sb.paths).groups).toEqual([['admin1', 'outra']])
    expect(groupOf(second, 'outra')).toEqual(['admin1', 'outra'])
    expect(groupOf(second, 'terceira')).toEqual(['terceira'])
  })

  test('igualdade só na última medição não forma grupo; outra conta com erro também não', async () => {
    sb = sandbox()
    sb.addToken('a', FAKE_TOKEN)
    sb.addToken('b', TOKEN_B)
    sb.addToken('c', TOKEN_C)
    const replies: Record<string, Reply> = { [FAKE_TOKEN]: { five: 0.1 }, [TOKEN_B]: { five: 0.2 }, [TOKEN_C]: { five: 0.1 } }
    const api = fakeFetch(replies)
    let now = T0
    const ctx = sb.ctx({ fetch: api.fetch, now: () => now })
    const cfg = cfgOf(['a', 'b', 'c'])
    await measureAll(ctx, cfg, { maxAgeMs: 0 })
    replies[TOKEN_B] = { five: 0.1 } // agora a, b e c coincidem no latest, mas b diferia no previous
    now += 1000
    expect((await measureAll(ctx, cfg, { maxAgeMs: 0 })).groups).toEqual([['a', 'c']])
    replies[TOKEN_B] = { five: 0.2 } // b volta a divergir
    replies[TOKEN_C] = { status: 401 } // c cai: latest com erro não agrupa
    now += 1000
    expect((await measureAll(ctx, cfg, { maxAgeMs: 0 })).groups).toEqual([])
  })

  test('measureAll não toma o lock sozinho: o chamador sem lock envolve em withLock', async () => {
    sb = sandbox()
    sb.addToken('admin1')
    const api = fakeFetch({})
    const ctx = sb.ctx({ fetch: api.fetch, now: () => T0 })
    // Segurando o lock (como o watch), measureAll roda sem esperar por ele (se tomasse, daria exit 5).
    const u = await withLock(sb.paths, () => measureAll(ctx, cfgOf(['admin1']), { maxAgeMs: 0 }), { waitMs: 200 })
    expect(u.latest.admin1).toMatchObject({ ok: true })
  })
})

describe('usage.json', () => {
  test('modo 600, JSON legível e nenhum token nem derivado dele', async () => {
    sb = sandbox()
    sb.addToken('a', FAKE_TOKEN)
    sb.addToken('b', TOKEN_B)
    sb.addToken('c', FAKE_TOKEN)
    const api = fakeFetch({})
    const ctx = sb.ctx({ fetch: api.fetch, now: () => T0 })
    const cfg = cfgOf(['a', 'b', 'c'])
    await measureAll(ctx, cfg, { maxAgeMs: 0 })
    await measureAll(ctx, cfg, { maxAgeMs: 0 })
    const file = usageFile(sb.paths)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain('sk-ant-')
    for (const t of [FAKE_TOKEN, TOKEN_B, TOKEN_C]) {
      for (const algo of ['sha256', 'sha1', 'md5']) {
        const d = createHash(algo).update(t).digest()
        for (const enc of ['hex', 'base64', 'base64url'] as const) {
          // prefixo basta: um fingerprint truncado também é derivado do token
          expect(text).not.toContain(d.toString(enc).slice(0, 12))
        }
      }
      expect(text).not.toContain(Buffer.from(t).toString('base64').slice(0, 12))
      expect(text).not.toContain(t.slice(13, 25))
    }
    // as chaves de nível superior são só as combinadas
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['groups', 'latest', 'previous'])
  })
})

describe('readUsage', () => {
  const empty: UsageFile = { latest: {}, previous: {}, groups: [] }

  test('arquivo ausente → vazio', () => {
    sb = sandbox()
    expect(existsSync(usageFile(sb.paths))).toBe(false)
    expect(readUsage(sb.paths)).toEqual(empty)
  })

  test.each([
    ['lixo', '{nao é json'],
    ['array', '[1,2]'],
    ['null', 'null'],
    ['formato antigo', JSON.stringify({ gabriel: { fiveHour: 0.4, sevenDay: 0.1, status: 'allowed', measuredAt: 1 } })],
    ['campos de tipo errado', JSON.stringify({ latest: 'x', previous: [], groups: { a: 1 } })],
  ])('arquivo corrompido (%s) → vazio, nunca lança', (_n, text) => {
    sb = sandbox()
    mkdirSync(dirname(usageFile(sb.paths)), { recursive: true })
    writeFileSync(usageFile(sb.paths), text)
    expect(readUsage(sb.paths)).toEqual(empty)
  })

  test('descarta só as entradas inválidas', () => {
    sb = sandbox()
    mkdirSync(dirname(usageFile(sb.paths)), { recursive: true })
    const good = ok(0.1, 0.2)
    writeFileSync(
      usageFile(sb.paths),
      JSON.stringify({ latest: { bom: good, ruim: { ok: true }, pior: 7 }, previous: {}, groups: [['a', 'b'], 'x', ['so-uma'], [1, 2]] }),
    )
    expect(readUsage(sb.paths)).toEqual({ latest: { bom: good }, previous: {}, groups: [['a', 'b']] })
  })
})

describe('poolTotal', () => {
  test('poolTotal: média dos representantes no pool de algum mux', () => {
    const cfg = cfgOf(['gabriel', 'admin1', 'outra', 'cliente-x'], { bk: ['gabriel', 'admin1'], ex: ['outra'] })
    const usage: UsageFile = {
      latest: { gabriel: ok(0.01, 0.15), admin1: ok(0.24, 0.38), outra: ok(0.24, 0.38), 'cliente-x': ok(0.9, 0.9) },
      previous: {},
      groups: [['admin1', 'outra']], // outra é duplicata de admin1
    }
    expect(poolTotal(cfg, usage)).toEqual({ fiveHour: 0.125, sevenDay: 0.265, accounts: ['gabriel', 'admin1'] })
  })

  test('duplicata no pool com o representante fora dele: conta o representante uma vez', () => {
    const cfg = cfgOf(['admin1', 'outra', 'g'], { bk: ['g', 'outra'] })
    const usage: UsageFile = {
      latest: { admin1: ok(0.5, 0.5), outra: ok(0.5, 0.5), g: ok(0.1, 0.3) },
      previous: {},
      groups: [['admin1', 'outra']],
    }
    expect(poolTotal(cfg, usage).accounts).toEqual(['admin1', 'g']) // ordem do registro
  })

  test('conta sem medição ok fica fora; nada medido → null', () => {
    const cfg = cfgOf(['a', 'b', 'c'], { m: ['a', 'b', 'c'] })
    const usage: UsageFile = {
      latest: { a: ok(0.2, 0.4), b: { ok: false, error: 'dead-token', measuredAt: T0 }, c: { ok: false, error: 'no-token', measuredAt: T0 } },
      previous: {},
      groups: [],
    }
    expect(poolTotal(cfg, usage)).toEqual({ fiveHour: 0.2, sevenDay: 0.4, accounts: ['a'] })
    expect(poolTotal(cfg, { latest: {}, previous: {}, groups: [] })).toEqual({ fiveHour: null, sevenDay: null, accounts: [] })
    expect(poolTotal(cfgOf(['a']), { latest: { a: ok(0.2, 0.4) }, previous: {}, groups: [] })).toEqual({ fiveHour: null, sevenDay: null, accounts: [] })
  })
})
