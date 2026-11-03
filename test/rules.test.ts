import { describe, expect, test } from 'bun:test'
import type { MuxConfig, SwapConfig } from '../src/core/config.js'
import { availability, desiredAccount, HYSTERESIS, type MuxEval } from '../src/core/rules.js'
import type { Measurement, UsageFile } from '../src/core/usage.js'

const NOW = 1_800_000_000_000
const SEC = NOW / 1000
const TH = { fiveHour: 0.9, sevenDay: 0.95 }

interface MkOpts {
  reset5h?: number
  reset7d?: number
  status?: string
  resetsAt?: number
  status5h?: string
  status7d?: string
}

/** Medição `ok`; resets em NOW/1000 + 3600 salvo indicação. */
function mk(u5: number, u7: number, o: MkOpts = {}): Measurement {
  return {
    ok: true,
    fiveHour: { utilization: u5, resetsAt: o.reset5h ?? SEC + 3600, status: o.status5h ?? 'allowed' },
    sevenDay: { utilization: u7, resetsAt: o.reset7d ?? SEC + 3600, status: o.status7d ?? 'allowed' },
    status: o.status ?? 'allowed',
    resetsAt: o.resetsAt ?? SEC + 3600,
    measuredAt: NOW,
  }
}
const err = (error: 'dead-token' | 'rate-limited' | 'network' | 'unexpected' | 'no-token'): Measurement =>
  ({ ok: false, error, measuredAt: NOW }) as Measurement

const bk: MuxConfig = { root: '/r', account: 'gabriel', accounts: ['gabriel', 'admin1', 'cliente-x'], pool: ['gabriel', 'admin1'] }
const swapOf = (returnOnReset = true): SwapConfig => ({ auto: true, threshold: TH, returnOnReset, probeEvery: '5m' })

interface Extra {
  current?: string
  mux?: Partial<MuxConfig>
  groups?: string[][]
  returnOnReset?: boolean
  override?: { account: string; until: number }
}
function eval_(latest: Record<string, Measurement>, x: Extra = {}): MuxEval {
  const usage: UsageFile = { latest, previous: {}, groups: x.groups ?? [] }
  return desiredAccount({
    name: 'bk',
    mux: { ...bk, ...x.mux },
    current: x.current ?? 'gabriel',
    usage,
    swap: swapOf(x.returnOnReset),
    override: x.override,
    nowMs: NOW,
  })
}

describe('availability', () => {
  const av = (m: Measurement | undefined, returning = false) => availability(m, TH, NOW, { returning })

  test('sem medição → unknown', () => expect(av(undefined)).toBe('unknown'))
  test('no-token e dead-token → exhausted', () => {
    expect(av(err('no-token'))).toBe('exhausted')
    expect(av(err('dead-token'))).toBe('exhausted')
  })
  test('rate-limited → exhausted, mesmo voltando (sem histerese)', () => {
    expect(av(err('rate-limited'))).toBe('exhausted')
    expect(av(err('rate-limited'), true)).toBe('exhausted')
  })
  test('network e unexpected → unknown', () => {
    expect(av(err('network'))).toBe('unknown')
    expect(av(err('unexpected'))).toBe('unknown')
  })
  test('abaixo dos limiares → available', () => expect(av(mk(0.5, 0.5))).toBe('available'))
  test('5h ≥ 90% → exhausted; 7d ≥ 95% → exhausted', () => {
    expect(av(mk(0.92, 0.1))).toBe('exhausted')
    expect(av(mk(0.1, 0.96))).toBe('exhausted')
  })
  test('limiar exatamente igual conta como esgotada', () => {
    expect(av(mk(0.9, 0.1))).toBe('exhausted')
    expect(av(mk(0.1, 0.95))).toBe('exhausted')
    expect(av(mk(0.89, 0.94))).toBe('available')
  })
  test('status da janela que não começa com allowed esgota com utilização baixa', () => {
    expect(av(mk(0.1, 0.1, { status5h: 'rejected' }))).toBe('exhausted')
    expect(av(mk(0.1, 0.1, { status7d: 'rejected' }))).toBe('exhausted')
  })
  test('allowed_warning não esgota por si', () => {
    expect(av(mk(0.5, 0.5, { status5h: 'allowed_warning', status7d: 'allowed_warning' }))).toBe('available')
  })
  test('status geral rejected com resetsAt futuro → exhausted; passado → available', () => {
    expect(av(mk(0.1, 0.1, { status: 'rejected' }))).toBe('exhausted')
    expect(av(mk(0.1, 0.1, { status: 'rejected', resetsAt: SEC - 1 }))).toBe('available')
  })
  test('reset da janela esgotada já passou → available (sem medição nova)', () => {
    expect(av(mk(0.99, 0.2, { reset5h: SEC - 60 }))).toBe('available')
    expect(av(mk(0.2, 0.99, { reset7d: SEC - 60 }))).toBe('available')
    expect(av(mk(0.99, 0.2, { reset5h: SEC }))).toBe('available') // resetsAt == agora: já passou
  })
  test('reset passou em UMA janela, mas a outra continua esgotada → exhausted', () => {
    expect(av(mk(0.99, 0.99, { reset5h: SEC - 60 }))).toBe('exhausted')
  })
  test('histerese: ao voltar, margem de 10 pontos; HYSTERESIS = 0.10', () => {
    expect(HYSTERESIS).toBe(0.1)
    expect(av(mk(0.85, 0.1), true)).toBe('exhausted')
    expect(av(mk(0.85, 0.1), false)).toBe('available')
    expect(av(mk(0.75, 0.1), true)).toBe('available')
    expect(av(mk(0.1, 0.86), true)).toBe('exhausted')
    expect(av(mk(0.1, 0.84), true)).toBe('available')
  })
  test('histerese não vale depois do reset', () => {
    expect(av(mk(0.85, 0.1, { reset5h: SEC - 1 }), true)).toBe('available')
  })
})

describe('desiredAccount', () => {
  test('preferida disponível → preferida', () => {
    expect(eval_({ gabriel: mk(0.01, 0.15) })).toMatchObject({ mux: 'bk', current: 'gabriel', desired: 'gabriel', reason: 'preferred' })
  })
  test('preferida 5h ≥ 90% → 2ª do pool', () => {
    expect(eval_({ gabriel: mk(0.92, 0.1), admin1: mk(0.2, 0.3) })).toMatchObject({ desired: 'admin1', reason: 'pool' })
  })
  test('preferida 7d ≥ 95% → 2ª do pool', () => {
    expect(eval_({ gabriel: mk(0.1, 0.96), admin1: mk(0.2, 0.3) })).toMatchObject({ desired: 'admin1', reason: 'pool' })
  })
  test('status rejected com utilização baixa → esgotada', () => {
    expect(eval_({ gabriel: mk(0.1, 0.1, { status: 'rejected' }), admin1: mk(0.2, 0.3) })).toMatchObject({ desired: 'admin1', reason: 'pool' })
    expect(eval_({ gabriel: mk(0.1, 0.1, { status5h: 'rejected' }), admin1: mk(0.2, 0.3) })).toMatchObject({ desired: 'admin1', reason: 'pool' })
  })
  test('allowed_warning na preferida não esgota', () => {
    const w = mk(0.5, 0.5, { status5h: 'allowed_warning', status: 'allowed_warning' })
    expect(eval_({ gabriel: w, admin1: mk(0.2, 0.3) })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
  })
  test('limiar exatamente igual (0.9) → troca', () => {
    expect(eval_({ gabriel: mk(0.9, 0.1), admin1: mk(0.2, 0.3) })).toMatchObject({ desired: 'admin1', reason: 'pool' })
  })
  test('reset passou sem medição nova → volta à preferida', () => {
    const ex = mk(0.99, 0.2, { reset5h: SEC - 60 })
    expect(eval_({ gabriel: ex, admin1: mk(0.2, 0.3) }, { current: 'admin1' })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
  })
  test('histerese: em admin1, preferida a 85% não volta; a 75% volta', () => {
    expect(eval_({ gabriel: mk(0.85, 0.1), admin1: mk(0.2, 0.3) }, { current: 'admin1' })).toMatchObject({ desired: 'admin1', reason: 'pool' })
    expect(eval_({ gabriel: mk(0.75, 0.1), admin1: mk(0.2, 0.3) }, { current: 'admin1' })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
  })
  test('histerese não vale quando já está na preferida (85% < 90% → fica)', () => {
    expect(eval_({ gabriel: mk(0.85, 0.1), admin1: mk(0.2, 0.3) }, { current: 'gabriel' })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
  })
  test('preferida fora do pool e esgotada → fica nela com aviso', () => {
    const r = eval_({ gabriel: mk(0.95, 0.1), admin1: mk(0.2, 0.3) }, { mux: { pool: ['admin1'] }, current: 'gabriel' })
    expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred-outside-pool' })
    expect(r.warn).toBeString()
    expect(r.warn!.length).toBeGreaterThan(0)
  })
  test('preferida fora do pool e disponível → preferida, sem aviso', () => {
    const r = eval_({ gabriel: mk(0.1, 0.1), admin1: mk(0.2, 0.3) }, { mux: { pool: ['admin1'] }, current: 'admin1' })
    expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    expect(r.warn).toBeUndefined()
  })
  test('pool vazio → nunca troca', () => {
    const r = eval_({ gabriel: mk(0.99, 0.99) }, { mux: { pool: [] }, current: 'admin1' })
    expect(r).toMatchObject({ desired: 'admin1', current: 'admin1', reason: 'no-pool' })
  })
  test('duplicata da preferida é pulada', () => {
    const mux = { pool: ['gabriel', 'outra', 'admin1'], accounts: ['gabriel', 'outra', 'admin1'] }
    const latest = { gabriel: mk(0.95, 0.1), outra: mk(0.95, 0.1), admin1: mk(0.2, 0.3) }
    expect(eval_(latest, { mux, groups: [['gabriel', 'outra']] })).toMatchObject({ desired: 'admin1', reason: 'pool' })
  })
  test('duplicata da preferida na 2ª posição, preferida na 1ª, é pulada', () => {
    const mux = { pool: ['gabriel', 'outra'], accounts: ['gabriel', 'outra'] }
    const latest = { gabriel: mk(0.95, 0.1), outra: mk(0.1, 0.1) } // medições divergentes de propósito: o grupo manda
    const r = eval_(latest, { mux, groups: [['gabriel', 'outra']] })
    expect(r).toMatchObject({ desired: 'gabriel', reason: 'none-available' })
    expect(r.warn).toBeString()
  })
  test('grupo repetido no pool é visitado uma vez só (grupos de 3 membros)', () => {
    const mux = { pool: ['gabriel', 'a', 'b', 'c', 'admin1'], accounts: ['gabriel', 'a', 'b', 'c', 'admin1'] }
    const latest = { gabriel: mk(0.95, 0.1), a: mk(0.1, 0.1), b: mk(0.1, 0.1), c: mk(0.1, 0.1), admin1: mk(0.2, 0.3) }
    // a, b, c são a mesma conta (grupo de 3), diferente da preferida: o destino é a 1ª delas
    expect(eval_(latest, { mux, groups: [['a', 'b', 'c']] })).toMatchObject({ desired: 'a', reason: 'pool' })
  })
  test('grupo de 3 que inclui a preferida: os três são pulados', () => {
    const mux = { pool: ['gabriel', 'a', 'b', 'admin1'], accounts: ['gabriel', 'a', 'b', 'admin1'] }
    const latest = { gabriel: mk(0.95, 0.1), a: mk(0.1, 0.1), b: mk(0.1, 0.1), admin1: mk(0.2, 0.3) }
    expect(eval_(latest, { mux, groups: [['gabriel', 'a', 'b']] })).toMatchObject({ desired: 'admin1', reason: 'pool' })
  })
  test('destino sem medição ou com token morto é pulado', () => {
    const mux = { pool: ['gabriel', 'semmed', 'morta', 'admin1'], accounts: ['gabriel', 'semmed', 'morta', 'admin1'] }
    const latest = { gabriel: mk(0.95, 0.1), morta: err('dead-token'), admin1: mk(0.2, 0.3) }
    expect(eval_(latest, { mux })).toMatchObject({ desired: 'admin1', reason: 'pool' })
  })
  test('destino com erro de rede (unknown) também é pulado', () => {
    const latest = { gabriel: mk(0.95, 0.1), admin1: err('network') }
    expect(eval_(latest).reason).toBe('none-available')
  })
  test('preferida sem medição fica (unknown conta como ok)', () => {
    expect(eval_({ admin1: mk(0.2, 0.3) })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    expect(eval_({ admin1: mk(0.2, 0.3) }, { current: 'admin1' })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
  })
  test('nenhuma disponível → fica na atual com aviso', () => {
    const r = eval_({ gabriel: mk(0.95, 0.1), admin1: mk(0.95, 0.1) }, { current: 'admin1' })
    expect(r).toMatchObject({ desired: 'admin1', current: 'admin1', reason: 'none-available' })
    expect(r.warn).toBeString()
  })
  test('nenhuma disponível e current fora de mux.accounts → preferida', () => {
    const r = eval_({ gabriel: mk(0.95, 0.1), admin1: mk(0.95, 0.1) }, { current: 'estranha' })
    expect(r).toMatchObject({ desired: 'gabriel', current: 'estranha', reason: 'none-available' })
    expect(r.warn).toBeString()
  })

  describe('rate-limited / erros na preferida', () => {
    test('rate-limited na preferida → troca para o pool', () => {
      expect(eval_({ gabriel: err('rate-limited'), admin1: mk(0.2, 0.3) })).toMatchObject({ desired: 'admin1', reason: 'pool' })
    })
    test('rate-limited na preferida → não volta enquanto não houver medição ok', () => {
      expect(eval_({ gabriel: err('rate-limited'), admin1: mk(0.2, 0.3) }, { current: 'admin1' })).toMatchObject({ desired: 'admin1', reason: 'pool' })
      expect(eval_({ gabriel: mk(0.2, 0.2), admin1: mk(0.2, 0.3) }, { current: 'admin1' })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    })
    test('network / unexpected na preferida → fica (unknown)', () => {
      for (const e of ['network', 'unexpected'] as const) {
        expect(eval_({ gabriel: err(e), admin1: mk(0.2, 0.3) })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
        expect(eval_({ gabriel: err(e), admin1: mk(0.2, 0.3) }, { current: 'admin1' })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
      }
    })
  })

  describe('override', () => {
    const future = NOW + 60_000
    test('override ativo vence a preferida disponível', () => {
      const r = eval_({ gabriel: mk(0.1, 0.1), admin1: mk(0.2, 0.3) }, { override: { account: 'admin1', until: future } })
      expect(r).toMatchObject({ desired: 'admin1', reason: 'override' })
    })
    test('override esgotado → fila sem a preferida', () => {
      const mux = { pool: ['gabriel', 'admin1', 'extra'], accounts: ['gabriel', 'admin1', 'extra'] }
      const latest = { gabriel: mk(0.1, 0.1), admin1: mk(0.95, 0.3), extra: mk(0.2, 0.2) }
      const r = eval_(latest, { mux, override: { account: 'admin1', until: future } })
      expect(r).toMatchObject({ desired: 'extra', reason: 'pool' })
    })
    test('override esgotado e fila vazia → none-available, nunca a preferida por reason pool', () => {
      const latest = { gabriel: mk(0.1, 0.1), admin1: mk(0.95, 0.3) }
      const r = eval_(latest, { current: 'admin1', override: { account: 'admin1', until: future } })
      expect(r).toMatchObject({ desired: 'admin1', reason: 'none-available' })
      expect(r.warn).toBeString()
    })
    test('override sem medição (unknown) não vale', () => {
      const r = eval_({ gabriel: mk(0.1, 0.1) }, { current: 'gabriel', override: { account: 'admin1', until: future } })
      expect(r.reason).not.toBe('override')
    })
    test('override vencido → preferida (inclusive até == agora)', () => {
      const latest = { gabriel: mk(0.1, 0.1), admin1: mk(0.2, 0.3) }
      expect(eval_(latest, { current: 'admin1', override: { account: 'admin1', until: NOW - 1 } })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
      expect(eval_(latest, { current: 'admin1', override: { account: 'admin1', until: NOW } })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    })
    test('pool vazio vence o override', () => {
      const r = eval_({ admin1: mk(0.1, 0.1) }, { mux: { pool: [] }, current: 'gabriel', override: { account: 'admin1', until: future } })
      expect(r).toMatchObject({ desired: 'gabriel', reason: 'no-pool' })
    })
  })

  describe('returnOnReset false (sticky)', () => {
    test('em admin1 disponível, fica', () => {
      const r = eval_({ gabriel: mk(0.1, 0.1), admin1: mk(0.2, 0.3) }, { current: 'admin1', returnOnReset: false })
      expect(r).toMatchObject({ desired: 'admin1', reason: 'sticky' })
    })
    test('admin1 esgotada → volta à preferida disponível', () => {
      const r = eval_({ gabriel: mk(0.1, 0.1), admin1: mk(0.95, 0.3) }, { current: 'admin1', returnOnReset: false })
      expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    })
    test('atual fora do pool → não é sticky, volta à preferida', () => {
      const r = eval_({ gabriel: mk(0.1, 0.1), 'cliente-x': mk(0.1, 0.1) }, { current: 'cliente-x', returnOnReset: false })
      expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    })
    test('atual sem medição (unknown) não é sticky', () => {
      const r = eval_({ gabriel: mk(0.1, 0.1) }, { current: 'admin1', returnOnReset: false })
      expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    })
    test('já na preferida → preferida', () => {
      const r = eval_({ gabriel: mk(0.1, 0.1) }, { current: 'gabriel', returnOnReset: false })
      expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    })
  })
})
