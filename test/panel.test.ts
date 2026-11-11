import { describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseConfig } from '../src/core/config.js'
import { buildAccounts, buildPanel, type PanelData } from '../src/core/panel.js'
import { muxLink, tokenFile } from '../src/core/paths.js'
import { readRuntime } from '../src/core/runtime.js'
import { readUsage, type Measurement, type UsageFile } from '../src/core/usage.js'
import { bar, formatReset, renderAccounts, renderPanel } from '../src/report.js'
import { FAKE_TOKEN, populatedSandbox, sandbox } from './helpers.js'

const TZ = 'America/Fortaleza'
const NOW = Date.parse('2026-11-03T14:30:00Z') // 11:30 em Fortaleza
const RESET_5H = Date.parse('2026-11-03T18:50:00Z') / 1000 // 15:50 em Fortaleza, mesmo dia
const RESET_7D = Date.parse('2026-11-06T20:00:00Z') / 1000 // 06/11

const okM = (five: number, seven: number): Measurement => ({
  ok: true,
  fiveHour: { utilization: five, resetsAt: RESET_5H, status: 'allowed' },
  sevenDay: { utilization: seven, resetsAt: RESET_7D, status: 'allowed' },
  status: 'allowed',
  resetsAt: RESET_5H,
  measuredAt: NOW - 120_000,
})

/** Os números do painel do §7 do design (03/11 11:30). */
const DESIGN_PANEL_DATA: PanelData = {
  accounts: [
    {
      name: 'gabriel',
      measurement: okM(0.01, 0.15),
      muxes: [
        { mux: 'bk', role: 'preferred', position: 1 },
        { mux: 'pessoal', role: 'pool', position: 2 },
      ],
    },
    {
      name: 'admin1',
      measurement: okM(0.24, 0.38),
      muxes: [
        { mux: 'pessoal', role: 'preferred', position: 1 },
        { mux: 'bk', role: 'pool', position: 2 },
      ],
    },
    { name: 'outra', measurement: okM(0.24, 0.38), sameAs: 'admin1', muxes: [] },
    { name: 'keychain', muxes: [{ mux: 'berzerk', role: 'preferred' }] },
  ],
  mux: [
    { name: 'bk', current: 'gabriel', preferred: 'gabriel', pool: ['gabriel', 'admin1'] },
    { name: 'pessoal', current: 'admin1', preferred: 'admin1', pool: ['admin1', 'gabriel'] },
    { name: 'berzerk', current: 'keychain', preferred: 'keychain', pool: [] },
  ],
  total: { fiveHour: 0.125, sevenDay: 0.265, accounts: ['gabriel', 'admin1'] },
  auto: true,
  threshold: { fiveHour: 0.9, sevenDay: 0.95 },
  pins: [{ jobId: '95b0deff', account: 'admin1' }],
  measuredAt: NOW - 120_000,
}

const render = (d: PanelData, nowMs = NOW): string => renderPanel(d, { nowMs, timeZone: TZ })

describe('renderPanel', () => {
  test('render bate com o painel do design', () => {
    const out = render(DESIGN_PANEL_DATA)
    expect(out).toContain('gabriel   ░░░░░░░░░░  1%  ██░░░░░░░░ 15%   bk (preferida) · pessoal (2º do pool)')
    expect(out).toContain('admin1    ██░░░░░░░░ 24%  ████░░░░░░ 38%   pessoal (preferida) · bk (2º do pool)')
    expect(out).toContain('reseta 15:50')
    expect(out).toContain('reseta 06/11')
    expect(out).toContain('          reseta 15:50    reseta 06/11')
    expect(out).toContain('└ outra (mesma conta que admin1)')
    expect(out).toContain('keychain  não medido')
    expect(out).toContain('berzerk   keychain  keychain   sem hot-swap')
    expect(out).toContain('bk        gabriel   gabriel    gabriel → admin1')
    expect(out).toContain('pessoal   admin1    admin1     admin1 → gabriel')
    expect(out).toContain('total     5h 13% · semanal 27%')
    expect(out).toContain('auto-swap ligado (90% / 95%)')
    expect(out).toContain('planos forem iguais')
    expect(out).toContain('(média das contas do pool; só vale como "quanto do total" se os planos forem iguais)')
    expect(out).toContain('sessões fixas: 95b0deff → admin1')
    expect(out).toContain('medido há 2 min')
    // o cabeçalho e o rodapé do design
    expect(out).toContain('conta     5h              semanal          muxes')
    expect(out).toContain('mux       atual     preferida  pool (ordem = prioridade)')
  })

  test('a nota do pool vem logo abaixo da linha total', () => {
    const lines = render(DESIGN_PANEL_DATA).split('\n')
    const i = lines.findIndex((l) => l.startsWith('total '))
    expect(lines[i + 1]).toContain('média das contas do pool')
  })

  test('nunca imprime float cru', () => {
    const d: PanelData = { ...DESIGN_PANEL_DATA, total: { fiveHour: 0.1234567, sevenDay: 0.30000000000000004, accounts: [] } }
    const out = render(d)
    expect(out).toContain('5h 12% · semanal 30%')
    expect(out).not.toMatch(/\d\.\d{4}/)
  })

  test('override aparece com a expiração', () => {
    const d: PanelData = {
      ...DESIGN_PANEL_DATA,
      mux: [{ name: 'bk', current: 'admin1', preferred: 'gabriel', pool: ['gabriel', 'admin1'], override: { account: 'admin1', until: RESET_5H * 1000 } }],
    }
    expect(render(d)).toContain('admin1 (manual até 15:50)')
  })

  test('override vencido não aparece', () => {
    const d: PanelData = {
      ...DESIGN_PANEL_DATA,
      mux: [{ name: 'bk', current: 'admin1', preferred: 'gabriel', pool: ['gabriel', 'admin1'], override: { account: 'admin1', until: NOW - 1 } }],
    }
    expect(render(d)).not.toContain('manual')
  })

  test('erro de sonda aparece no lugar das barras', () => {
    const d: PanelData = {
      ...DESIGN_PANEL_DATA,
      accounts: [
        { name: 'morta', measurement: { ok: false, error: 'dead-token', httpStatus: 401, measuredAt: NOW }, muxes: [{ mux: 'bk', role: 'preferred', position: 1 }] },
        { name: 'solta', measurement: { ok: false, error: 'no-token', measuredAt: NOW }, muxes: [] },
        { name: 'cheia', measurement: { ok: false, error: 'rate-limited', httpStatus: 429, streak: 2, measuredAt: NOW }, muxes: [] },
        { name: 'talvez', measurement: { ok: false, error: 'rate-limited', httpStatus: 429, streak: 1, measuredAt: NOW }, muxes: [] },
        { name: 'offline', measurement: { ok: false, error: 'network', measuredAt: NOW }, muxes: [] },
        { name: 'nova', muxes: [] },
      ],
    }
    const out = render(d)
    expect(out).toContain('token morto (401)')
    expect(out).toContain('sem token')
    expect(out).toContain('limite atingido (429)')
    expect(out).toContain('429 sem cabeçalhos (a confirmar)')
    expect(out).toContain('sem rede')
    expect(out).toContain('ainda sem medição')
    expect(out).toMatch(/morta {5}token morto \(401\) +bk \(preferida\)/) // os muxes continuam na coluna deles
    expect(out).not.toContain('█')
    expect(out).not.toContain('░')
  })

  test('conta sem mux é marcada', () => {
    const d: PanelData = { ...DESIGN_PANEL_DATA, accounts: [{ name: 'solta', measurement: okM(0.5, 0.5), muxes: [] }] }
    expect(render(d)).toMatch(/solta .*sem mux/)
  })

  test('100% mantém as colunas alinhadas', () => {
    const d: PanelData = { ...DESIGN_PANEL_DATA, accounts: [{ name: 'a', measurement: okM(1, 0.5), muxes: [] }, { name: 'b', measurement: okM(0.5, 0.5), muxes: [] }] }
    const lines = render(d).split('\n')
    const a = lines.find((l) => l.startsWith('a '))!
    const b = lines.find((l) => l.startsWith('b '))!
    expect(a.lastIndexOf('█████░░░░░ 50%')).toBe(b.lastIndexOf('█████░░░░░ 50%')) // coluna semanal
  })

  test('mux sem link atual mostra — e não quebra', () => {
    const d: PanelData = { ...DESIGN_PANEL_DATA, mux: [{ name: 'bk', current: null, preferred: 'gabriel', pool: ['gabriel'] }] }
    expect(render(d)).toMatch(/bk +— +gabriel +gabriel/)
  })

  test('sem pins e sem medição: sem a linha de pins, "nunca medido"', () => {
    const out = render({ ...DESIGN_PANEL_DATA, pins: [], measuredAt: null, total: { fiveHour: null, sevenDay: null, accounts: [] } })
    expect(out).not.toContain('sessões fixas')
    expect(out).toContain('nunca medido')
    expect(out).toContain('5h — · semanal —')
  })

  test('auto desligado', () => {
    expect(render({ ...DESIGN_PANEL_DATA, auto: false })).toContain('auto-swap desligado (90% / 95%)')
  })

  test('sem contas registradas: dica de login', () => {
    const out = render({ ...DESIGN_PANEL_DATA, accounts: [], mux: [], pins: [] })
    expect(out).toContain('sb login <conta>')
  })
})

describe('bar e formatReset', () => {
  test('bar: 10 células e percentual', () => {
    expect(bar(0)).toBe('░░░░░░░░░░  0%')
    expect(bar(0.15)).toBe('██░░░░░░░░ 15%')
    expect(bar(0.38)).toBe('████░░░░░░ 38%')
    expect(bar(1)).toBe('██████████ 100%')
    expect(bar(1.2)).toBe('██████████ 120%') // sem clamp no número, só nas células
  })

  test('formatReset: mesmo dia → HH:MM; outro dia → dd/mm (no fuso pedido)', () => {
    expect(formatReset(RESET_5H, NOW, TZ)).toBe('15:50')
    expect(formatReset(RESET_7D, NOW, TZ)).toBe('06/11')
    // 02:30 UTC de 04/11 ainda é 03/11 em Fortaleza (23:30)
    expect(formatReset(Date.parse('2026-11-04T02:30:00Z') / 1000, NOW, TZ)).toBe('23:30')
    // meia-noite local: hora 00, não 24
    expect(formatReset(Date.parse('2026-11-04T03:00:00Z') / 1000, NOW, TZ)).toBe('04/11')
    expect(formatReset(Date.parse('2026-11-03T03:05:00Z') / 1000, NOW, TZ)).toBe('00:05')
  })
})

describe('buildPanel', () => {
  const cfg = parseConfig(
    JSON.stringify({
      switchboard: 1,
      accounts: { gabriel: {}, admin1: {}, outra: {}, solta: {} },
      swap: { auto: false, threshold: { fiveHour: 0.8, sevenDay: 0.9 } },
      default: 'bk',
      mux: {
        bk: { root: '/r1', account: 'gabriel', accounts: ['gabriel', 'admin1', 'outra'], pool: ['gabriel', 'admin1'] },
        berzerk: { root: '/r2', account: 'keychain', accounts: ['keychain'], pool: [] },
      },
    }),
    'cfg',
  )
  const usage: UsageFile = {
    latest: { gabriel: okM(0.1, 0.2), admin1: okM(0.3, 0.4), outra: okM(0.3, 0.4) },
    previous: { admin1: okM(0.3, 0.4), outra: okM(0.3, 0.4) },
    groups: [['admin1', 'outra']],
  }

  test('monta contas (registro + keychain), papéis, duplicata, mux e total', () => {
    const sb = sandbox()
    mkdirSync(dirname(muxLink(sb.paths, 'bk')), { recursive: true })
    symlinkSync(tokenFile(sb.paths, 'admin1'), muxLink(sb.paths, 'bk'))
    const runtime = readRuntime(sb.paths)
    runtime.overrides.bk = { account: 'admin1', until: NOW + 1000 }
    const d = buildPanel(cfg, usage, runtime, sb.paths)

    expect(d.accounts.map((a) => a.name)).toEqual(['gabriel', 'admin1', 'outra', 'solta', 'keychain'])
    expect(d.accounts[0]!.muxes).toEqual([{ mux: 'bk', role: 'preferred', position: 1 }])
    expect(d.accounts[1]!.muxes).toEqual([{ mux: 'bk', role: 'pool', position: 2 }])
    expect(d.accounts[2]!.muxes).toEqual([{ mux: 'bk', role: 'allowed' }])
    expect(d.accounts[2]!.sameAs).toBe('admin1')
    expect(d.accounts[1]!.sameAs).toBeUndefined()
    expect(d.accounts[3]!.muxes).toEqual([])
    expect(d.accounts[3]!.measurement).toBeUndefined()
    expect(d.accounts[4]!.muxes).toEqual([{ mux: 'berzerk', role: 'preferred' }])
    expect(d.mux).toEqual([
      { name: 'bk', current: 'admin1', preferred: 'gabriel', pool: ['gabriel', 'admin1'], override: { account: 'admin1', until: NOW + 1000 } },
      { name: 'berzerk', current: null, preferred: 'keychain', pool: [] }, // sem link: null, e o painel renderiza
    ])
    expect(d.total.accounts).toEqual(['gabriel', 'admin1'])
    expect(d.auto).toBe(false)
    expect(d.threshold).toEqual({ fiveHour: 0.8, sevenDay: 0.9 })
    expect(d.pins).toEqual([])
    expect(d.measuredAt).toBe(NOW - 120_000)
    expect(() => renderPanel(d, { nowMs: NOW, timeZone: TZ })).not.toThrow()
  })

  test('papéis ordenados: preferida, pool por posição, permitida', () => {
    const c = parseConfig(
      JSON.stringify({
        switchboard: 1,
        accounts: { a: {}, b: {} },
        default: 'm1',
        mux: {
          m1: { root: '/r1', account: 'b', accounts: ['a', 'b'], pool: ['b', 'a'] },
          m2: { root: '/r2', account: 'b', accounts: ['a', 'b'] },
          m3: { root: '/r3', account: 'a', accounts: ['a'], pool: ['a'] },
        },
      }),
      'cfg',
    )
    const sb = sandbox()
    const d = buildPanel(c, { latest: {}, previous: {}, groups: [] }, readRuntime(sb.paths), sb.paths)
    expect(d.accounts.find((a) => a.name === 'a')!.muxes).toEqual([
      { mux: 'm3', role: 'preferred', position: 1 },
      { mux: 'm1', role: 'pool', position: 2 },
      { mux: 'm2', role: 'allowed' },
    ])
  })
})

describe('buildAccounts / renderAccounts (central de contas)', () => {
  const cfg = parseConfig(
    JSON.stringify({
      switchboard: 1,
      accounts: { gabriel: {}, admin1: {}, outra: {}, solta: {}, morta: {}, quebrada: {}, vazia: {} },
      default: 'bk',
      mux: { bk: { root: '/r1', account: 'gabriel', accounts: ['gabriel', 'admin1', 'outra'], pool: ['gabriel', 'admin1'] } },
    }),
    'cfg',
  )

  function setup() {
    const sb = sandbox()
    for (const a of ['gabriel', 'admin1', 'outra', 'solta', 'morta']) sb.addToken(a)
    writeFileSync(tokenFile(sb.paths, 'quebrada'), '{nao eh json', { mode: 0o600 })
    writeFileSync(tokenFile(sb.paths, 'vazia'), '{}', { mode: 0o600 })
    const usage: UsageFile = {
      latest: {
        gabriel: okM(0.1, 0.2),
        admin1: okM(0.3, 0.4),
        outra: okM(0.3, 0.4),
        morta: { ok: false, error: 'dead-token', httpStatus: 401, measuredAt: NOW },
      },
      previous: {},
      groups: [['admin1', 'outra']],
    }
    return { sb, usage }
  }

  test('todas as contas do registro, com estado do token, duplicata e papéis', () => {
    const { sb, usage } = setup()
    const rows = buildAccounts(cfg, usage, sb.paths)
    expect(rows.map((r) => r.name)).toEqual(['gabriel', 'admin1', 'outra', 'solta', 'morta', 'quebrada', 'vazia'])
    const by = Object.fromEntries(rows.map((r) => [r.name, r]))
    expect(by.gabriel).toMatchObject({ token: 'ok', attached: true, muxes: [{ mux: 'bk', role: 'preferred', position: 1 }] })
    expect(by.outra).toMatchObject({ token: 'ok', sameAs: 'admin1', attached: true, muxes: [{ mux: 'bk', role: 'allowed' }] })
    expect(by.solta).toMatchObject({ token: 'ok', attached: false, muxes: [] })
    expect(by.solta!.measurement).toBeUndefined()
    expect(by.morta!.token).toBe('dead')
    expect(by.quebrada!.token).toBe('invalid-json')
    expect(by.vazia!.token).toBe('missing')
    // token ausente (nenhum arquivo)
    const sb2 = sandbox()
    expect(buildAccounts(cfg, { latest: {}, previous: {}, groups: [] }, sb2.paths)[0]!.token).toBe('missing')
    // nenhum segredo no resultado
    expect(JSON.stringify(rows)).not.toContain('sk-ant-')
    expect(JSON.stringify(rows)).not.toContain(FAKE_TOKEN)
  })

  test('texto: estado do token, uso com reset, duplicata e `sem mux`', () => {
    const { sb, usage } = setup()
    const out = renderAccounts(buildAccounts(cfg, usage, sb.paths), { nowMs: NOW, timeZone: TZ })
    expect(out).toMatch(/gabriel +ok +5h +10% \(reseta 15:50\) · semanal +20% \(reseta 06\/11\) +bk \(preferida\)/)
    expect(out).toMatch(/outra +ok +mesma conta que admin1 +bk \(permitida\)/)
    expect(out).toMatch(/solta +ok +ainda sem medição +sem mux/)
    expect(out).toMatch(/morta +morto +token morto \(401\) +sem mux/)
    expect(out).toMatch(/quebrada +JSON inválido/)
    expect(out).toMatch(/vazia +sem token/)
  })

  test('sem contas: dica', () => {
    expect(renderAccounts([], { nowMs: NOW, timeZone: TZ })).toContain('sb login <conta>')
  })
})

test('readUsage do populatedSandbox é o formato novo (não vazio)', () => {
  const sb = populatedSandbox()
  expect(Object.keys(readUsage(sb.paths).latest)).toContain('gabriel')
})
