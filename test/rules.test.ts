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
/** 429 sem os cabeçalhos unified; `streak` = quantas sondas seguidas vieram assim (1ª = ainda não confirma esgotamento) */
const limited = (streak?: number): Measurement => ({ ok: false, error: 'rate-limited', httpStatus: 429, measuredAt: NOW, ...(streak !== undefined && { streak }) }) as Measurement

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
  test('rate-limited (429 sem cabeçalhos) só esgota na 2ª sonda seguida, mesmo voltando (sem histerese)', () => {
    for (const m of [limited(2), limited(3), limited(10)]) {
      expect(av(m)).toBe('exhausted')
      expect(av(m, true)).toBe('exhausted')
    }
  })
  test('o 1º rate-limited seguido é unknown (um 429 sem cabeçalhos é mais provavelmente espúrio); sem `streak` (registro antigo) conta como o 1º', () => {
    for (const m of [limited(1), limited(), err('rate-limited')]) {
      expect(av(m)).toBe('unknown')
      expect(av(m, true)).toBe('unknown')
    }
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
    expect(eval_(latest)).toMatchObject({ desired: 'gabriel', reason: 'none-available' })
  })
  test('preferida sem medição fica (unknown conta como ok)', () => {
    expect(eval_({ admin1: mk(0.2, 0.3) })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    // FLIPPED (revisão): em reserva válida, preferida sem medição (falha nossa) não tira o mux dela
    expect(eval_({ admin1: mk(0.2, 0.3) }, { current: 'admin1' })).toMatchObject({ desired: 'admin1', reason: 'sticky' })
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

  describe('reserva atual válida não pula entre reservas (passo 5)', () => {
    const mux = { pool: ['gabriel', 'admin1', 'outra'], accounts: ['gabriel', 'admin1', 'outra', 'cliente-x'] }
    test('atual (reserva) disponível fica, mesmo com reserva anterior recuperada', () => {
      const latest = { gabriel: mk(0.95, 0.1), admin1: mk(0.2, 0.2), outra: mk(0.3, 0.3) }
      expect(eval_(latest, { mux, current: 'outra' })).toMatchObject({ desired: 'outra', current: 'outra', reason: 'pool' })
    })
    test('atual esgotada → 1ª disponível do pool', () => {
      const latest = { gabriel: mk(0.95, 0.1), admin1: mk(0.2, 0.2), outra: mk(0.95, 0.3) }
      expect(eval_(latest, { mux, current: 'outra' })).toMatchObject({ desired: 'admin1', reason: 'pool' })
    })
    // FLIPPED (revisão): `unknown` na reserva atual (timeout da sonda) não causa troca sozinho
    test('atual com timeout único (unknown) e outras disponíveis → fica (passo 5)', () => {
      const latest = { gabriel: mk(0.95, 0.1), admin1: mk(0.2, 0.2), outra: err('network') }
      expect(eval_(latest, { mux, current: 'outra' })).toMatchObject({ desired: 'outra', reason: 'pool' })
    })
    test('atual unknown e nenhuma outra disponível → fica', () => {
      const latest = { gabriel: mk(0.95, 0.1), admin1: mk(0.95, 0.2), outra: err('network') }
      expect(eval_(latest, { mux, current: 'outra' })).toMatchObject({ desired: 'outra', reason: 'pool' })
    })
    test('atual sem nenhuma medição (undefined) também fica', () => {
      const latest = { gabriel: mk(0.95, 0.1), admin1: mk(0.2, 0.2) }
      expect(eval_(latest, { mux, current: 'outra' })).toMatchObject({ desired: 'outra', reason: 'pool' })
    })
    test('atual que é duplicata da preferida não é mantida', () => {
      const latest = { gabriel: mk(0.95, 0.1), admin1: mk(0.2, 0.2), outra: mk(0.1, 0.1) }
      expect(eval_(latest, { mux, current: 'outra', groups: [['gabriel', 'outra']] })).toMatchObject({ desired: 'admin1', reason: 'pool' })
    })
    test('preferida volta a ficar disponível (abaixo do limiar − histerese) → vence a reserva atual', () => {
      const latest = { gabriel: mk(0.75, 0.1), admin1: mk(0.2, 0.2), outra: mk(0.3, 0.3) }
      expect(eval_(latest, { mux, current: 'outra' })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    })
    test('atual fora do pool (ex.: alvo de override removido do pool) → 1ª disponível', () => {
      const latest = { gabriel: mk(0.95, 0.1), admin1: mk(0.2, 0.2), outra: mk(0.3, 0.3), 'cliente-x': mk(0.1, 0.1) }
      expect(eval_(latest, { mux, current: 'cliente-x' })).toMatchObject({ desired: 'admin1', reason: 'pool' })
    })
  })

  describe('rate-limited / erros na preferida', () => {
    test('rate-limited na preferida (2ª seguida) → troca para o pool', () => {
      expect(eval_({ gabriel: limited(2), admin1: mk(0.2, 0.3) })).toMatchObject({ desired: 'admin1', reason: 'pool' })
    })
    test('o 1º rate-limited na preferida NÃO troca (unknown): nem sai dela, nem volta a ela de uma reserva só por isso', () => {
      expect(eval_({ gabriel: limited(1), admin1: mk(0.2, 0.3) })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
      expect(eval_({ gabriel: limited(1), admin1: mk(0.2, 0.3) }, { current: 'admin1' })).toMatchObject({ desired: 'admin1', reason: 'sticky' })
      expect(eval_({ gabriel: limited(1), admin1: mk(0.2, 0.3) }, { current: 'admin1' })).toMatchObject({ desired: 'admin1' })
    })
    test('o 1º rate-limited na atual (reserva) NÃO a tira de lá; o 2º tira', () => {
      const mux = { pool: ['gabriel', 'admin1', 'outra'], accounts: ['gabriel', 'admin1', 'outra'] }
      const at = (m: Measurement) => eval_({ gabriel: mk(0.95, 0.1), admin1: m, outra: mk(0.1, 0.1) }, { mux, current: 'admin1' })
      expect(at(limited(1))).toMatchObject({ desired: 'admin1', reason: 'pool' })
      expect(at(limited(2))).toMatchObject({ desired: 'outra', reason: 'pool' })
    })
    test('rate-limited na preferida → não volta enquanto não houver medição ok', () => {
      expect(eval_({ gabriel: limited(2), admin1: mk(0.2, 0.3) }, { current: 'admin1' })).toMatchObject({ desired: 'admin1', reason: 'pool' })
      expect(eval_({ gabriel: mk(0.2, 0.2), admin1: mk(0.2, 0.3) }, { current: 'admin1' })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    })
    // FLIPPED (revisão): na reserva válida, a preferida unknown não puxa de volta
    test('network / unexpected na preferida → fica onde está (unknown)', () => {
      for (const e of ['network', 'unexpected'] as const) {
        expect(eval_({ gabriel: err(e), admin1: mk(0.2, 0.3) })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
        expect(eval_({ gabriel: err(e), admin1: mk(0.2, 0.3) }, { current: 'admin1' })).toMatchObject({ desired: 'admin1', reason: 'sticky' })
      }
    })
    test('network na preferida, atual reserva esgotada → volta à preferida (não há lugar válido)', () => {
      expect(eval_({ gabriel: err('network'), admin1: mk(0.95, 0.3) }, { current: 'admin1' })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    })
    test('rate-limited na preferida: só volta com medição ok abaixo do limiar − 0.10', () => {
      const at = (g: Measurement) => eval_({ gabriel: g, admin1: mk(0.2, 0.3) }, { current: 'admin1' })
      expect(at(limited(2))).toMatchObject({ desired: 'admin1', reason: 'pool' })
      expect(at(mk(0.85, 0.1))).toMatchObject({ desired: 'admin1', reason: 'pool' })
      expect(at(mk(0.79, 0.1))).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    })
    test('TODAS as sondas falhando (tudo unknown) → nenhum mux se move', () => {
      const down = { gabriel: err('network'), admin1: err('unexpected'), 'cliente-x': err('network') }
      for (const current of ['gabriel', 'admin1', 'cliente-x']) {
        expect(eval_(down, { current }).desired).toBe(current)
        expect(eval_({}, { current }).desired).toBe(current)
      }
    })
  })

  describe('override', () => {
    const future = NOW + 60_000
    test('override ativo vence a preferida disponível', () => {
      const r = eval_({ gabriel: mk(0.1, 0.1), admin1: mk(0.2, 0.3) }, { override: { account: 'admin1', until: future } })
      expect(r).toMatchObject({ desired: 'admin1', reason: 'override' })
    })
    // FLIPPED (revisão): override esgotado é anulado e vale a regra normal (a preferida volta a valer)
    test('override esgotado → regra normal: preferida disponível vence', () => {
      const mux = { pool: ['gabriel', 'admin1', 'extra'], accounts: ['gabriel', 'admin1', 'extra'] }
      const latest = { gabriel: mk(0.1, 0.1), admin1: mk(0.95, 0.3), extra: mk(0.2, 0.2) }
      const r = eval_(latest, { mux, current: 'admin1', override: { account: 'admin1', until: future } })
      expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    })
    test('override esgotado e preferida esgotada → 1ª disponível da fila', () => {
      const mux = { pool: ['gabriel', 'admin1', 'extra'], accounts: ['gabriel', 'admin1', 'extra'] }
      const latest = { gabriel: mk(0.95, 0.1), admin1: mk(0.95, 0.3), extra: mk(0.2, 0.2) }
      const r = eval_(latest, { mux, current: 'admin1', override: { account: 'admin1', until: future } })
      expect(r).toMatchObject({ desired: 'extra', reason: 'pool' })
    })
    test('override esgotado e nada disponível → fica na atual com aviso (sem culpar só o pool)', () => {
      const latest = { gabriel: mk(0.95, 0.1), admin1: mk(0.95, 0.3) }
      const r = eval_(latest, { current: 'admin1', override: { account: 'admin1', until: future } })
      expect(r).toMatchObject({ desired: 'admin1', reason: 'none-available' })
      expect(r.warn).toContain('override')
      expect(r.warn).toContain('permanece em "admin1"')
    })
    test('override unknown e atual == override → fica (reason override)', () => {
      const r = eval_({ gabriel: mk(0.1, 0.1), admin1: err('network') }, { current: 'admin1', override: { account: 'admin1', until: future } })
      expect(r).toMatchObject({ desired: 'admin1', reason: 'override' })
    })
    test('override sem medição e atual ≠ override → anulado, regra normal', () => {
      const r = eval_({ gabriel: mk(0.1, 0.1) }, { current: 'gabriel', override: { account: 'admin1', until: future } })
      expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    })
    test('override unknown, atual ≠ override, na reserva válida → regra normal (sticky na reserva)', () => {
      const r = eval_({ gabriel: err('network'), admin1: mk(0.2, 0.2) }, { current: 'admin1', override: { account: 'cliente-x', until: future } })
      expect(r).toMatchObject({ desired: 'admin1', reason: 'sticky' })
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
    // FLIPPED (fix round 2): sticky usa stay(current): unknown (falha nossa) também fica
    test('atual sem medição (unknown) também é sticky', () => {
      const r = eval_({ gabriel: mk(0.1, 0.1) }, { current: 'admin1', returnOnReset: false })
      expect(r).toMatchObject({ desired: 'admin1', reason: 'sticky' })
    })
    test('atual com erro de rede (unknown) também é sticky; disponível, idem', () => {
      expect(eval_({ gabriel: mk(0.1, 0.1), admin1: err('network') }, { current: 'admin1', returnOnReset: false })).toMatchObject({ desired: 'admin1', reason: 'sticky' })
      expect(eval_({ gabriel: mk(0.1, 0.1), admin1: mk(0.2, 0.2) }, { current: 'admin1', returnOnReset: false })).toMatchObject({ desired: 'admin1', reason: 'sticky' })
    })
    test('atual esgotada ou morta não é sticky', () => {
      expect(eval_({ gabriel: mk(0.1, 0.1), admin1: err('dead-token') }, { current: 'admin1', returnOnReset: false })).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    })
    test('já na preferida → preferida', () => {
      const r = eval_({ gabriel: mk(0.1, 0.1) }, { current: 'gabriel', returnOnReset: false })
      expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
    })
  })
})

describe('desiredAccount — nunca ficar numa conta esgotada com a preferida utilizável (5b)', () => {
  const mux = { pool: ['gabriel', 'admin1'], accounts: ['gabriel', 'admin1', 'cliente-x'] }
  test('atual a 95%, preferida a 85% (histerese a segurava) → preferida', () => {
    const r = eval_({ gabriel: mk(0.85, 0.1), admin1: mk(0.95, 0.1) }, { mux, current: 'admin1' })
    expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
  })
  test('atual com token morto → preferida a 85%', () => {
    const r = eval_({ gabriel: mk(0.85, 0.1), admin1: err('dead-token') }, { mux, current: 'admin1' })
    expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
  })
  test('override vencido numa atual esgotada → preferida a 85%', () => {
    const r = eval_({ gabriel: mk(0.85, 0.1), admin1: mk(0.95, 0.1) }, { mux, current: 'admin1', override: { account: 'admin1', until: NOW - 1 } })
    expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
  })
  test('atual em accounts mas fora do pool e esgotada → preferida a 85%', () => {
    const r = eval_({ gabriel: mk(0.85, 0.1), admin1: mk(0.95, 0.1), 'cliente-x': mk(0.99, 0.1) }, { mux, current: 'cliente-x' })
    expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
  })
  test('preferida a 85% e reserva atual ainda boa → fica (a histerese continua valendo)', () => {
    const r = eval_({ gabriel: mk(0.85, 0.1), admin1: mk(0.2, 0.1) }, { mux, current: 'admin1' })
    expect(r).toMatchObject({ desired: 'admin1', reason: 'pool' })
  })
  test('preferida esgotada de fato → 5b não dispara', () => {
    const r = eval_({ gabriel: mk(0.95, 0.1), admin1: mk(0.95, 0.1) }, { mux, current: 'admin1' })
    expect(r).toMatchObject({ desired: 'admin1', reason: 'none-available' })
  })
})

describe('desiredAccount — destinos não têm histerese; duplicata e fora do registro não são "reserva"', () => {
  test.each([0.8, 0.85, 0.89])('reserva a %p é escolhida como destino', (u) => {
    expect(eval_({ gabriel: mk(0.95, 0.1), admin1: mk(u, 0.1) })).toMatchObject({ desired: 'admin1', reason: 'pool' })
  })
  test('atual duplicata da preferida: sem histerese de retorno e tratada como a própria preferida', () => {
    const mux = { pool: ['gabriel', 'outra', 'admin1'], accounts: ['gabriel', 'outra', 'admin1'] }
    const r = eval_({ gabriel: mk(0.85, 0.1), outra: mk(0.85, 0.1), admin1: mk(0.1, 0.1) }, { mux, current: 'outra', groups: [['gabriel', 'outra']] })
    expect(r).toMatchObject({ desired: 'outra', reason: 'preferred' })
  })
  test('atual fora de mux.accounts: sem histerese de retorno (preferida a 85% vale)', () => {
    const r = eval_({ gabriel: mk(0.85, 0.1), admin1: mk(0.1, 0.1) }, { current: 'estranha' })
    expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
  })
  test('aviso de none-available: "permanece em" só quando desired == current', () => {
    const stuck = eval_({ gabriel: mk(0.95, 0.1), admin1: mk(0.95, 0.1) }, { current: 'admin1' })
    expect(stuck.warn).toContain('permanece em "admin1"')
    const outside = eval_({ gabriel: mk(0.95, 0.1), admin1: mk(0.95, 0.1) }, { current: 'estranha' })
    expect(outside.desired).toBe('gabriel')
    expect(outside.warn).not.toContain('permanece')
    expect(outside.warn).toContain('estranha')
  })
})

function deepFreeze<T>(o: T): T {
  if (typeof o === 'object' && o !== null && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

describe('desiredAccount — ponto fixo (varredura aleatória com semente)', () => {
  test('realimentar `desired` como `current` converge em ≤ 2 passos, sem ciclo de 2, sem mutar a entrada', () => {
    let seed = 0x5eed1234
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
    const ACCOUNTS = ['p', 'a', 'b', 'c', 'x'] as const
    const kinds = [
      () => undefined,
      () => limited(2),
      () => limited(1),
      () => err('dead-token'),
      () => err('network'),
      () => err('unexpected'),
      () => err('no-token'),
      () => mk(pick([0.1, 0.5, 0.75, 0.79, 0.8, 0.85, 0.89, 0.9, 0.95, 0.99]), pick([0.1, 0.5, 0.9, 0.96])),
      () => mk(pick([0.1, 0.85, 0.95]), 0.1, { reset5h: SEC - 60 }),
      () => mk(0.1, 0.1, { status: 'rejected' }),
      () => mk(0.1, 0.1, { status5h: 'allowed_warning' }),
    ]
    for (let i = 0; i < 3000; i++) {
      const accounts = ACCOUNTS.slice(0, 3 + Math.floor(rnd() * 3)) as string[]
      const pref = pick(accounts)
      const pool = accounts.filter(() => rnd() < 0.7)
      if (rnd() < 0.5 && !pool.includes(pref)) pool.unshift(pref)
      const latest: Record<string, Measurement> = {}
      for (const a of accounts) {
        const m = pick(kinds)()
        if (m) latest[a] = m
      }
      const groups = rnd() < 0.3 ? [accounts.filter(() => rnd() < 0.5)].filter((g) => g.length >= 2) : []
      const override = rnd() < 0.3 ? { account: pick(accounts), until: rnd() < 0.5 ? NOW + 1000 : NOW - 1 } : undefined
      const start = rnd() < 0.1 ? 'fora' : pick(accounts)
      const x: Extra = { mux: { account: pref, accounts, pool }, groups, override, current: start, returnOnReset: rnd() < 0.7 }
      deepFreeze(x)
      deepFreeze(latest)
      const run = (cur: string): MuxEval => eval_(latest, { ...x, current: cur })
      const d1 = run(start).desired
      const d2 = run(d1).desired
      const d3 = run(d2).desired
      const ctx = JSON.stringify({ i, start, d1, d2, d3, pref, pool, groups, override, latest, rr: x.returnOnReset })
      expect(d3, ctx).toBe(d2) // ponto fixo em ≤ 2 iterações
      expect(d2, ctx).toBe(d1) // na verdade em 1: depois de mover, ficar; logo nunca há ciclo de 2
    }
  })
})

describe('desiredAccount — fix round 2 (step 3 sticky, step 4, duplicata fora do registro)', () => {
  test('step 4: preferida fora do pool e esgotada, atual é OUTRA conta → vai para o pool, não para a preferida', () => {
    const r = eval_(
      { gabriel: mk(0.95, 0.1), 'cliente-x': mk(0.95, 0.1), admin1: mk(0.2, 0.2) },
      { mux: { pool: ['admin1'] }, current: 'cliente-x', override: { account: 'cliente-x', until: NOW + 60_000 } },
    )
    expect(r).toMatchObject({ desired: 'admin1', reason: 'pool' })
    expect(r.warn).toBeUndefined()
  })
  test('step 4: atual é a preferida → fica com aviso "permanece" (desired == current)', () => {
    const r = eval_({ gabriel: mk(0.95, 0.1), admin1: mk(0.2, 0.2) }, { mux: { pool: ['admin1'] }, current: 'gabriel' })
    expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred-outside-pool' })
    expect(r.warn).toContain('permanece em "gabriel"')
  })
  test('step 4: atual é duplicata da preferida em accounts → fica nela (preferred-outside-pool)', () => {
    const mux = { pool: ['admin1'], accounts: ['gabriel', 'zz', 'admin1'] }
    const r = eval_({ gabriel: mk(0.95, 0.1), zz: mk(0.95, 0.1), admin1: mk(0.95, 0.2) }, { mux, current: 'zz', groups: [['gabriel', 'zz']] })
    expect(r).toMatchObject({ desired: 'zz', reason: 'preferred-outside-pool' })
    expect(r.warn).toContain('permanece em "zz"')
  })
  test('step 4 pulado e nada disponível → none-available mantém a atual (aviso coerente)', () => {
    const r = eval_(
      { gabriel: mk(0.95, 0.1), 'cliente-x': mk(0.95, 0.1), admin1: mk(0.95, 0.2) },
      { mux: { pool: ['admin1'] }, current: 'cliente-x' },
    )
    expect(r).toMatchObject({ desired: 'cliente-x', reason: 'none-available' })
    expect(r.warn).toContain('permanece em "cliente-x"')
  })
  test('duplicata da preferida FORA de mux.accounts não "fica": vai para a preferida', () => {
    const r = eval_({ gabriel: mk(0.1, 0.1), zz: mk(0.1, 0.1) }, { current: 'zz', groups: [['gabriel', 'zz']] })
    expect(r).toMatchObject({ desired: 'gabriel', reason: 'preferred' })
  })
})
