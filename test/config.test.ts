import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { editConfig, ensureConfig, InvalidConfigError, loadConfig, parseConfig, parseDuration } from '../src/core/config.js'
import { EXIT, SbError } from '../src/core/errors.js'
import { sandbox } from './helpers.js'

// o JSONC do §5 do design, com os comentários
const DESIGN_EXAMPLE = `{
  "$schema": "…/schema.json",
  "switchboard": 1,
  "accounts": {                         // só o registro; os tokens ficam em tokens/
    "gabriel": {}, "admin1": {}, "cliente-x": {}
  },
  "swap": {
    "auto": true,
    "threshold": { "fiveHour": 0.9, "sevenDay": 0.95 },
    "returnOnReset": true,
    "probeEvery": "5m"
  },
  "default": "bk",                      // mux para pastas que não casam com nenhum root
  "mux": {
    "bk": {
      "root": "~/Desktop/Projetos/bk-company",
      "account": "gabriel",                          // preferida
      "accounts": ["gabriel", "admin1", "cliente-x"], // pode usar
      "pool": ["gabriel", "admin1"]                  // hot-swap; a ordem é a prioridade
    },
    "pessoal": {
      "root": "~/Desktop/Projetos/pessoal",
      "account": "admin1",
      "accounts": ["admin1", "gabriel"],
      "pool": ["admin1", "gabriel"]                  // ordem própria, diferente da do bk
    },
    "berzerk": {
      "root": "~/Desktop/Projetos/berzerk",
      "account": "keychain",
      "accounts": ["keychain"],
      "pool": []                                     // nunca troca sozinho
    }
  }
}
`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
const EXAMPLE_OBJ: Obj = parseJsonc(DESIGN_EXAMPLE)

function detailOf(text: string, home?: string): string {
  try {
    parseConfig(text, 'x', home)
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidConfigError)
    return (e as SbError).detail ?? ''
  }
  throw new Error('esperava InvalidConfigError')
}

test('exemplo do §5 carrega com defaults', () => {
  const c = parseConfig(DESIGN_EXAMPLE, 'x')
  expect(c.swap).toEqual({ auto: true, threshold: { fiveHour: 0.9, sevenDay: 0.95 }, returnOnReset: true, probeEvery: '5m' })
  expect(c.mux.pessoal!.pool).toEqual(['admin1', 'gabriel'])
})

test('só o mínimo: defaults de swap e pool', () => {
  const c = parseConfig('{"switchboard":1,"accounts":{"a":{}},"default":"m","mux":{"m":{"root":"/r","account":"a","accounts":["a"]}}}', 'x')
  expect(c.swap).toEqual({ auto: true, threshold: { fiveHour: 0.9, sevenDay: 0.95 }, returnOnReset: true, probeEvery: '5m' })
  expect(c.mux.m!.pool).toEqual([])
})

test('config vazia (a que ensureConfig cria) é válida', () => {
  expect(parseConfig('{"switchboard":1,"accounts":{},"mux":{}}', 'x').mux).toEqual({})
})

test('conta registrada sem nenhum mux é válida', () => {
  const obj = structuredClone(EXAMPLE_OBJ)
  obj.accounts['solta'] = {}
  const c = parseConfig(JSON.stringify(obj), 'x')
  expect(Object.keys(c.accounts)).toContain('solta')
  expect(parseConfig('{"switchboard":1,"accounts":{"solta":{}},"mux":{}}', 'x').accounts).toEqual({ solta: {} })
})

test.each<[string, (c: Obj) => void, string]>([
  ['chave desconhecida', (c) => (c.mux.bk.swap = false), 'mux.bk'],
  ['account ∉ accounts', (c) => ((c.mux.bk.account = 'cliente-x'), (c.mux.bk.accounts = ['gabriel'])), 'mux.bk.account'],
  ['pool ⊄ accounts', (c) => (c.mux.pessoal.pool = ['admin1', 'cliente-x']), 'mux.pessoal.pool'],
  ['keychain no pool', (c) => (c.mux.berzerk.pool = ['keychain']), 'mux.berzerk.pool'],
  ['conta sem registro', (c) => delete c.accounts['cliente-x'], 'mux.bk.accounts'],
  ['keychain registrada', (c) => (c.accounts.keychain = {}), 'accounts.keychain'],
  ['default inexistente', (c) => (c.default = 'nada'), 'default'],
  ['root repetido', (c) => (c.mux.pessoal.root = c.mux.bk.root), 'mux.pessoal.root'],
])('%s → InvalidConfigError com o caminho', (_n, mutate, path) => {
  const obj = structuredClone(EXAMPLE_OBJ)
  mutate(obj)
  expect(() => parseConfig(JSON.stringify(obj), 'x')).toThrow(InvalidConfigError)
  try {
    parseConfig(JSON.stringify(obj), 'x')
  } catch (e) {
    expect((e as SbError).detail).toContain(path)
    expect((e as SbError).exit).toBe(EXIT.INVALID_CONFIG)
  }
})

describe('invariantes: caminho exato e mensagem em português', () => {
  test('conta sem registro aponta o índice', () => {
    const obj = structuredClone(EXAMPLE_OBJ)
    delete obj.accounts['cliente-x']
    expect(detailOf(JSON.stringify(obj))).toContain('mux.bk.accounts.2: ')
  })
  test('pool ⊄ accounts aponta o índice', () => {
    const obj = structuredClone(EXAMPLE_OBJ)
    obj.mux.pessoal.pool = ['admin1', 'cliente-x']
    expect(detailOf(JSON.stringify(obj))).toContain('mux.pessoal.pool.1: ')
  })
  test('keychain no pool: mensagem própria', () => {
    const obj = structuredClone(EXAMPLE_OBJ)
    obj.mux.berzerk.pool = ['keychain']
    expect(detailOf(JSON.stringify(obj))).toMatch(/mux\.berzerk\.pool\.0: .*keychain.*pool/)
  })
  test('repetição em accounts e em pool', () => {
    const obj = structuredClone(EXAMPLE_OBJ)
    obj.mux.bk.accounts = ['gabriel', 'admin1', 'gabriel']
    obj.mux.bk.pool = ['admin1', 'admin1']
    const d = detailOf(JSON.stringify(obj))
    expect(d).toContain('mux.bk.accounts.2: ')
    expect(d).toContain('mux.bk.pool.1: ')
    expect(d).toMatch(/repet/)
  })
  test('default é obrigatório se há mux', () => {
    const obj = structuredClone(EXAMPLE_OBJ)
    delete obj.default
    expect(detailOf(JSON.stringify(obj))).toMatch(/default: .*obrigat/)
  })
  test('default sem mux nenhum também é erro (default ∈ mux)', () => {
    expect(detailOf('{"switchboard":1,"accounts":{},"default":"bk","mux":{}}')).toContain('default: ')
  })
  test('account fora de accounts, mensagem em português', () => {
    const obj = structuredClone(EXAMPLE_OBJ)
    obj.mux.bk.account = 'admin1'
    obj.mux.bk.accounts = ['gabriel']
    expect(detailOf(JSON.stringify(obj))).toMatch(/mux\.bk\.account: .*accounts/)
  })
  test('chave desconhecida: mensagem em português com o nome da chave', () => {
    const obj = structuredClone(EXAMPLE_OBJ)
    obj.extra = 1
    expect(detailOf(JSON.stringify(obj))).toMatch(/\(raiz\): chave desconhecida.*"extra"/)
  })
  test('nome de conta inválido', () => {
    const obj = structuredClone(EXAMPLE_OBJ)
    obj.accounts['Cliente X'] = {}
    expect(detailOf(JSON.stringify(obj))).toContain('Cliente X')
  })
  test('accounts vazio num mux (min 1)', () => {
    const obj = structuredClone(EXAMPLE_OBJ)
    obj.mux.berzerk.accounts = []
    expect(detailOf(JSON.stringify(obj))).toContain('mux.berzerk.accounts')
  })
  test('switchboard != 1', () => {
    const obj = structuredClone(EXAMPLE_OBJ)
    obj.switchboard = 2
    expect(detailOf(JSON.stringify(obj))).toContain('switchboard')
  })
  test('probeEvery inválido', () => {
    const obj = structuredClone(EXAMPLE_OBJ)
    obj.swap.probeEvery = '5x'
    expect(detailOf(JSON.stringify(obj))).toContain('swap.probeEvery')
  })
  test('threshold fora de (0, 1]', () => {
    const obj = structuredClone(EXAMPLE_OBJ)
    obj.swap.threshold.fiveHour = 1.5
    expect(detailOf(JSON.stringify(obj))).toContain('swap.threshold.fiveHour')
  })
  test('vários problemas viram uma linha cada', () => {
    const obj = structuredClone(EXAMPLE_OBJ)
    obj.default = 'nada'
    obj.accounts.keychain = {}
    expect(detailOf(JSON.stringify(obj)).split('\n').length).toBeGreaterThanOrEqual(2)
  })
})

describe('root repetido', () => {
  test('`~` expandido e path.resolve: ~/x, /h/x e /h/x/ são o mesmo root', () => {
    const base = { switchboard: 1, accounts: { a: {} }, default: 'm1' }
    const mk = (r1: string, r2: string): string =>
      JSON.stringify({
        ...base,
        mux: { m1: { root: r1, account: 'a', accounts: ['a'] }, m2: { root: r2, account: 'a', accounts: ['a'] } },
      })
    expect(detailOf(mk('~/x', '/h/x'), '/h')).toContain('mux.m2.root')
    expect(detailOf(mk('/h/x', '/h/x/'), '/h')).toContain('mux.m2.root')
    expect(detailOf(mk('/h/a/../x', '/h/x'), '/h')).toContain('mux.m2.root')
    expect(() => parseConfig(mk('~/x', '/h/y'), 'x', '/h')).not.toThrow()
    expect(() => parseConfig(mk('~/x', '~/y'), 'x')).not.toThrow()
    expect(detailOf(mk('~/x', '~/x/'), undefined)).toContain('mux.m2.root')
  })
})

test('chave duplicada é erro', () =>
  expect(() => parseConfig('{"switchboard":1,"accounts":{},"mux":{},"mux":{}}', 'x')).toThrow(/chave duplicada: "mux"/))

test('chave duplicada aninhada informa o caminho', () => {
  expect(() => parseConfig('{"switchboard":1,"accounts":{"a":{},"a":{}},"mux":{}}', 'x')).toThrow(/chave duplicada: "accounts\.a"/)
})

test('JSONC malformado → InvalidConfigError', () => {
  expect(() => parseConfig('{"switchboard":', 'x')).toThrow(InvalidConfigError)
})

test('comentários e vírgula final são aceitos', () => {
  expect(parseConfig('{ // c\n "switchboard": 1, "accounts": {}, "mux": {},\n}', 'x').switchboard).toBe(1)
})

test('InvalidConfigError é SbError com exit 2', () => {
  const e = new InvalidConfigError('m', 'd')
  expect(e).toBeInstanceOf(SbError)
  expect(e.exit).toBe(2)
  expect(e.detail).toBe('d')
})

test('arquivo ausente → exit 2 com dica de `sb login`', async () => {
  const sb = sandbox()
  expect(existsSync(sb.paths.configFile)).toBe(false)
  const err = await loadConfig(sb.paths).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(InvalidConfigError)
  expect((err as SbError).exit).toBe(EXIT.INVALID_CONFIG)
  expect(`${(err as SbError).message}\n${(err as SbError).detail}`).toContain('sb login')
  expect((err as SbError).message).toContain(sb.paths.configFile)
})

test('loadConfig lê o arquivo e usa o HOME do sandbox no root', async () => {
  const sb = sandbox()
  mkdirSync(join(sb.paths.configFile, '..'), { recursive: true })
  writeFileSync(sb.paths.configFile, DESIGN_EXAMPLE)
  expect((await loadConfig(sb.paths)).default).toBe('bk')
  const obj = structuredClone(EXAMPLE_OBJ)
  obj.mux.pessoal.root = `${sb.paths.home}/Desktop/Projetos/bk-company` // = ~/Desktop/Projetos/bk-company
  writeFileSync(sb.paths.configFile, JSON.stringify(obj))
  await expect(loadConfig(sb.paths)).rejects.toThrow(InvalidConfigError)
})

test('loadConfig de arquivo inválido cita o arquivo', async () => {
  const sb = sandbox()
  mkdirSync(join(sb.paths.configFile, '..'), { recursive: true })
  writeFileSync(sb.paths.configFile, '{"switchboard":1,"accounts":{},"mux":{},"mux":{}}')
  const err = (await loadConfig(sb.paths).catch((e: unknown) => e)) as SbError
  expect(err).toBeInstanceOf(InvalidConfigError)
  expect(err.message).toContain(sb.paths.configFile)
})

test('ensureConfig cria a config mínima com $schema e não sobrescreve', async () => {
  const sb = sandbox()
  await ensureConfig(sb.paths)
  const text = readFileSync(sb.paths.configFile, 'utf8')
  const obj = parseJsonc(text)
  expect(obj.switchboard).toBe(1)
  expect(obj.accounts).toEqual({})
  expect(obj.mux).toEqual({})
  expect(obj.$schema).toMatch(/^file:\/\/.*schema\.json$/)
  const c = await loadConfig(sb.paths)
  expect(c.mux).toEqual({})
  writeFileSync(sb.paths.configFile, DESIGN_EXAMPLE)
  await ensureConfig(sb.paths)
  expect(readFileSync(sb.paths.configFile, 'utf8')).toBe(DESIGN_EXAMPLE)
})

test('editConfig preserva comentários e recusa edição que quebra invariante', async () => {
  const sb = sandbox()
  mkdirSync(join(sb.paths.configFile, '..'), { recursive: true })
  writeFileSync(sb.paths.configFile, DESIGN_EXAMPLE)
  const c = await editConfig(sb.paths, [{ path: ['mux', 'bk', 'pool'], value: ['gabriel'] }])
  expect(c.mux.bk!.pool).toEqual(['gabriel'])
  const after = readFileSync(sb.paths.configFile, 'utf8')
  expect(after).toContain('// hot-swap')
  expect(after).toContain('// só o registro')
  expect(parseJsonc(after).mux.bk.pool).toEqual(['gabriel'])

  const before = readFileSync(sb.paths.configFile, 'utf8')
  await expect(editConfig(sb.paths, [{ path: ['mux', 'bk', 'pool'], value: ['nada'] }])).rejects.toThrow(InvalidConfigError)
  expect(readFileSync(sb.paths.configFile, 'utf8')).toBe(before)
})

test('editConfig aplica várias edições juntas (tudo ou nada) e cria/remove chaves', async () => {
  const sb = sandbox()
  mkdirSync(join(sb.paths.configFile, '..'), { recursive: true })
  writeFileSync(sb.paths.configFile, DESIGN_EXAMPLE)
  await editConfig(sb.paths, [
    { path: ['accounts', 'nova'], value: {} },
    { path: ['mux', 'bk', 'accounts', -1], value: 'nova' }, // -1 = inserir no fim
  ])
  const obj = parseJsonc(readFileSync(sb.paths.configFile, 'utf8'))
  expect(obj.accounts.nova).toEqual({})
  expect(obj.mux.bk.accounts).toEqual(['gabriel', 'admin1', 'cliente-x', 'nova'])
  const snapshot = readFileSync(sb.paths.configFile, 'utf8')
  await expect(
    editConfig(sb.paths, [
      { path: ['accounts', 'outra'], value: {} },
      { path: ['default'], value: 'nada' }, // a 2ª quebra: a 1ª também não vale
    ]),
  ).rejects.toThrow(InvalidConfigError)
  expect(readFileSync(sb.paths.configFile, 'utf8')).toBe(snapshot)
  await editConfig(sb.paths, [{ path: ['accounts', 'nova'], value: undefined }, { path: ['mux', 'bk', 'accounts', 3], value: undefined }])
  expect(parseJsonc(readFileSync(sb.paths.configFile, 'utf8')).accounts.nova).toBeUndefined()
})

test('editConfig sem arquivo → mesmo erro de loadConfig', async () => {
  const sb = sandbox()
  await expect(editConfig(sb.paths, [{ path: ['default'], value: 'x' }])).rejects.toThrow(InvalidConfigError)
  expect(existsSync(sb.paths.configFile)).toBe(false)
})

test('parseDuration', () => {
  expect([parseDuration('30s'), parseDuration('5m'), parseDuration('1h')]).toEqual([30_000, 300_000, 3_600_000])
  expect(() => parseDuration('5x')).toThrow()
  expect(() => parseDuration('0s')).toThrow()
  expect(() => parseDuration('')).toThrow()
  expect(() => parseDuration('m5')).toThrow()
})
