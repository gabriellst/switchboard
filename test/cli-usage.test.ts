import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { runAccounts } from '../src/commands/accounts.js'
import { runUsage, type UsageIO } from '../src/commands/usage.js'
import type { FetchLike } from '../src/core/ctx.js'
import { withLock } from '../src/core/fsx.js'
import { usageFile } from '../src/core/paths.js'
import { FAKE_TOKEN, fakeApi, sandbox, type FakeApi, type Sandbox } from './helpers.js'

const TOKEN_B = 'sk-ant-oat01-' + 'y'.repeat(40)

const headers = (five: number, seven: number): Record<string, string> => ({
  'anthropic-ratelimit-unified-5h-utilization': String(five),
  'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': String(seven),
  'anthropic-ratelimit-unified-7d-reset': String(Math.floor(Date.now() / 1000) + 5 * 86400),
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600),
})

let api: FakeApi | undefined
afterEach(() => {
  api?.stop()
  api = undefined
})

/** Config (gabriel+admin1 no mux bk; `solta` registrada sem mux), tokens distintos e API falsa por token. */
async function setup(over: { config?: string } = {}): Promise<Sandbox> {
  const sb = sandbox()
  mkdirSync(dirname(sb.paths.configFile), { recursive: true })
  writeFileSync(
    sb.paths.configFile,
    over.config ??
      JSON.stringify({
        switchboard: 1,
        accounts: { gabriel: {}, admin1: {}, solta: {} },
        default: 'bk',
        mux: { bk: { root: '/tmp/bk', account: 'gabriel', accounts: ['gabriel', 'admin1'], pool: ['gabriel', 'admin1'] } },
      }),
  )
  sb.addToken('gabriel', FAKE_TOKEN)
  sb.addToken('admin1', TOKEN_B)
  sb.addToken('solta', 'sk-ant-oat01-' + 'z'.repeat(40))
  api = await fakeApi((req) => {
    const t = (req.headers.get('authorization') ?? '').replace('Bearer ', '')
    return new Response('{}', { status: 200, headers: t === FAKE_TOKEN ? headers(0.01, 0.15) : t === TOKEN_B ? headers(0.24, 0.38) : headers(0.5, 0.6) })
  })
  sb.env.SWITCHBOARD_API_BASE = api.url
  return sb
}

describe('sb / sb usage (subprocesso)', () => {
  test('`sb` sem argumentos mostra o painel e sai 0', async () => {
    const sb = await setup()
    const r = await sb.runSbAsync([])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('conta     5h')
    expect(r.stdout).toContain('gabriel   ░░░░░░░░░░  1%  ██░░░░░░░░ 15%   bk (preferida)')
    expect(r.stdout).toContain('admin1    ██░░░░░░░░ 24%  ████░░░░░░ 38%   bk (2º do pool)')
    expect(r.stdout).toContain('solta     ')
    expect(r.stdout).toContain('sem mux')
    expect(r.stdout).toContain('total     5h 13% · semanal 27%')
    expect(r.stdout).toContain('auto-swap ligado (90% / 95%)')
    expect(r.stdout).toContain('bk        —') // sem link no mux: mostra — e não quebra
    expect(r.stdout + r.stderr).not.toMatch(/sk-ant-/)
  })

  test('`sb usage --json` tem accounts/mux/total e nenhum token', async () => {
    const sb = await setup()
    const r = await sb.runSbAsync(['usage', '--json'])
    expect(r.code).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/sk-ant-/)
    const j = JSON.parse(r.stdout) as {
      accounts: Array<{ name: string; measurement?: { ok: boolean } }>
      mux: Array<{ name: string; current: string | null; preferred: string; pool: string[] }>
      total: { fiveHour: number; sevenDay: number; accounts: string[] }
      busy: boolean
    }
    expect(j.accounts.map((a) => a.name)).toEqual(['gabriel', 'admin1', 'solta'])
    expect(j.accounts[0]!.measurement!.ok).toBe(true)
    expect(j.mux).toEqual([{ name: 'bk', current: null, preferred: 'gabriel', pool: ['gabriel', 'admin1'] }])
    expect(j.total.accounts).toEqual(['gabriel', 'admin1'])
    expect(j.total.fiveHour).toBeCloseTo(0.125, 10)
    expect(j.busy).toBe(false)
  })

  test('mede com cache de 60 s: a segunda chamada não sonda de novo', async () => {
    const sb = await setup()
    await sb.runSbAsync(['usage', '--json'])
    expect(api!.requests.length).toBe(3)
    const r = await sb.runSbAsync(['usage', '--json'])
    expect(r.code).toBe(0)
    expect(api!.requests.length).toBe(3)
  })

  test('lock ocupado por outro processo: mostra a última medição, avisa e sai 0, sem sondar', async () => {
    const sb = await setup()
    await sb.runSbAsync(['usage', '--json']) // deixa uma medição em usage.json
    const before = readFileSync(usageFile(sb.paths), 'utf8')
    const calls = api!.requests.length
    // mede de novo (--json grava `latest` com 0 s de idade): força a releitura marcando as medições como velhas
    const old = JSON.parse(before) as { latest: Record<string, { measuredAt: number }> }
    for (const m of Object.values(old.latest)) m.measuredAt = 1_700_000_000_000
    writeFileSync(usageFile(sb.paths), JSON.stringify(old))
    let r!: { code: number; stdout: string; stderr: string }
    await withLock(sb.paths, async () => {
      r = await sb.runSbAsync(['usage'])
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('medição em andamento por outro processo')
    expect(r.stdout).toContain('██░░░░░░░░ 24%') // admin1 da última medição
    expect(api!.requests.length).toBe(calls) // não sondou
    expect(JSON.parse(readFileSync(usageFile(sb.paths), 'utf8'))).toEqual(old) // e não regravou
    // --json também avisa, por `busy`
    await withLock(sb.paths, async () => {
      r = await sb.runSbAsync(['usage', '--json'])
    })
    expect(r.code).toBe(0)
    expect((JSON.parse(r.stdout) as { busy: boolean }).busy).toBe(true)
  }, 15_000)

  test('sem config → exit 2 com dica', () => {
    const sb = sandbox()
    for (const args of [[], ['usage'], ['usage', '--json'], ['accounts']]) {
      const r = sb.runSb(args)
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('sb login <conta>')
    }
  })

  test('--every inválido → exit 3', async () => {
    const sb = await setup()
    for (const every of ['0', 'abc', '-5', '1.5']) {
      const r = await sb.runSbAsync(['usage', '--watch', '--every', every])
      expect(r.code).toBe(3)
      expect(r.stderr).toContain('--every')
    }
  })
})

describe('sb accounts (subprocesso)', () => {
  test('conta registrada sem mux → attached: false e linha `sem mux`', async () => {
    const sb = await setup()
    const j = JSON.parse((await sb.runSbAsync(['accounts', '--json'])).stdout) as Array<{ name: string; attached: boolean; token: string; muxes: unknown[] }>
    expect(j.map((a) => [a.name, a.attached, a.token])).toEqual([
      ['gabriel', true, 'ok'],
      ['admin1', true, 'ok'],
      ['solta', false, 'ok'],
    ])
    expect(j[2]!.muxes).toEqual([])
    const t = await sb.runSbAsync(['accounts'])
    expect(t.code).toBe(0)
    expect(t.stdout).toMatch(/solta +ok .*sem mux/)
    expect(t.stdout).toMatch(/gabriel +ok .*bk \(preferida\)/)
    expect(t.stdout + t.stderr).not.toMatch(/sk-ant-/)
    expect(api!.requests.length).toBe(0) // `accounts` nunca mede
  })

  test('usa a última medição de usage.json (token morto)', async () => {
    const sb = await setup()
    mkdirSync(dirname(usageFile(sb.paths)), { recursive: true })
    writeFileSync(
      usageFile(sb.paths),
      JSON.stringify({ latest: { solta: { ok: false, error: 'dead-token', httpStatus: 401, measuredAt: 1_700_000_000_000 } }, previous: {}, groups: [] }),
    )
    const j = JSON.parse((await sb.runSbAsync(['accounts', '--json'])).stdout) as Array<{ name: string; token: string }>
    expect(j.find((a) => a.name === 'solta')!.token).toBe('dead')
  })
})

describe('runUsage --watch (em processo)', () => {
  const okFetch: FetchLike = async () => ({ status: 200, headers: { get: (n) => headers(0.1, 0.2)[n.toLowerCase()] ?? null } })

  function io(): UsageIO & { out: string[]; sleeps: number[] } {
    const out: string[] = []
    const sleeps: number[] = []
    return { out, sleeps, write: (s) => void out.push(s), sleep: async (ms) => void sleeps.push(ms), isTTY: false }
  }

  test('desenha o 1º frame, espera --every s e redesenha; maxFrames encerra', async () => {
    const sb = await setup()
    const t = io()
    await runUsage(sb.ctx({ fetch: okFetch }), { json: false, watch: true, everyS: 7, maxFrames: 2 }, t)
    expect(t.out.length).toBe(2)
    expect(t.out[0]).toContain('conta     5h')
    expect(t.sleeps).toEqual([7000])
  })

  test('em TTY limpa a tela antes de cada frame; fora dele, não', async () => {
    const sb = await setup()
    const tty = { ...io(), isTTY: true }
    await runUsage(sb.ctx({ fetch: okFetch }), { json: false, watch: true, everyS: 1, maxFrames: 1 }, tty)
    expect(tty.out.join('')).toContain('\x1b[2J')
    const pipe = io()
    await runUsage(sb.ctx({ fetch: okFetch }), { json: false, watch: true, everyS: 1, maxFrames: 1 }, pipe)
    expect(pipe.out.join('')).not.toContain('\x1b')
  })

  test('sem --watch: um frame só, sem dormir', async () => {
    const sb = await setup()
    const t = io()
    await runUsage(sb.ctx({ fetch: okFetch }), { json: false, watch: false, everyS: 30 }, t)
    expect(t.out.length).toBe(1)
    expect(t.sleeps).toEqual([])
  })

  test('--watch --json: uma linha JSON por frame', async () => {
    const sb = await setup()
    const t = io()
    await runUsage(sb.ctx({ fetch: okFetch }), { json: true, watch: true, everyS: 1, maxFrames: 2 }, t)
    for (const frame of t.out) {
      expect(frame.endsWith('\n')).toBe(true)
      expect(frame.trimEnd().includes('\n')).toBe(false)
      expect(JSON.parse(frame).accounts.length).toBe(3)
    }
  })
})

test('runAccounts escreve a lista pelo io', async () => {
  const sb = await setup()
  const out: string[] = []
  await runAccounts(sb.ctx(), { json: true }, (s) => void out.push(s))
  expect(JSON.parse(out.join('')).length).toBe(3)
})
