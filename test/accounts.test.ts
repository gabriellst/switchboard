import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { attachAccount, detachAccount, removeAccount } from '../src/core/accounts.js'
import { loadConfig } from '../src/core/config.js'
import { EXIT, SbError } from '../src/core/errors.js'
import { currentAccount, pointMux } from '../src/core/links.js'
import { tokenFile } from '../src/core/paths.js'
import { ensureState } from '../src/core/tokens.js'
import { sandbox, type Sandbox } from './helpers.js'

const BASE = {
  switchboard: 1,
  accounts: { gabriel: {}, admin1: {}, cliente: {}, solta: {} },
  default: 'bk',
  mux: {
    bk: { root: '~/bk', account: 'gabriel', accounts: ['gabriel'], pool: ['gabriel'] },
    outro: { root: '~/outro', account: 'cliente', accounts: ['cliente'], pool: [] },
  },
}

/** Config BASE, tokens para tudo, exceto `semtoken` (registrada), e o link do bk apontando para gabriel. */
function setup(config: unknown = BASE): Sandbox {
  const sb = sandbox()
  mkdirSync(dirname(sb.paths.configFile), { recursive: true })
  const raw = config as { accounts: Record<string, unknown> }
  writeFileSync(sb.paths.configFile, JSON.stringify({ ...raw, accounts: { ...raw.accounts, semtoken: {} } }, null, 2) + '\n')
  ensureState(sb.paths)
  for (const a of ['gabriel', 'admin1', 'cliente', 'solta']) sb.addToken(a)
  pointMux(sb.paths, 'bk', 'gabriel')
  return sb
}

const run = async (p: Promise<unknown>): Promise<SbError | undefined> => {
  try {
    await p
  } catch (e) {
    if (e instanceof SbError) return e
    throw e
  }
  return undefined
}

describe('attachAccount', () => {
  test('--pool acrescenta a accounts e ao fim do pool; --at 1 põe na frente; repetir é idempotente (changed [])', async () => {
    const sb = setup()
    const r1 = await attachAccount(sb.ctx(), 'admin1', { mux: 'bk', pool: true })
    expect(r1.changed.sort()).toEqual(['accounts', 'pool'])
    let m = (await loadConfig(sb.paths)).mux.bk!
    expect(m.accounts).toEqual(['gabriel', 'admin1'])
    expect(m.pool).toEqual(['gabriel', 'admin1'])

    expect((await attachAccount(sb.ctx(), 'admin1', { mux: 'bk', pool: true })).changed).toEqual([])

    const r2 = await attachAccount(sb.ctx(), 'solta', { mux: 'bk', pool: 1 })
    expect(r2.changed.sort()).toEqual(['accounts', 'pool'])
    m = (await loadConfig(sb.paths)).mux.bk!
    expect(m.pool).toEqual(['solta', 'gabriel', 'admin1'])

    // posição explícita de quem já está no pool = mover; repetir a mesma posição não muda nada
    expect((await attachAccount(sb.ctx(), 'admin1', { mux: 'bk', pool: 1 })).changed).toEqual(['pool'])
    expect((await loadConfig(sb.paths)).mux.bk!.pool).toEqual(['admin1', 'solta', 'gabriel'])
    expect((await attachAccount(sb.ctx(), 'admin1', { mux: 'bk', pool: 1 })).changed).toEqual([])
    // posição além do fim = fim
    await attachAccount(sb.ctx(), 'admin1', { mux: 'bk', pool: 99 })
    expect((await loadConfig(sb.paths)).mux.bk!.pool).toEqual(['solta', 'gabriel', 'admin1'])
  })

  test('sem --pool: só entra em accounts (permitida); com o pool já existente, --pool sem posição não reordena', async () => {
    const sb = setup()
    expect((await attachAccount(sb.ctx(), 'admin1', { mux: 'bk' })).changed).toEqual(['accounts'])
    const m = (await loadConfig(sb.paths)).mux.bk!
    expect(m.accounts).toEqual(['gabriel', 'admin1'])
    expect(m.pool).toEqual(['gabriel'])
    await attachAccount(sb.ctx(), 'admin1', { mux: 'bk', pool: true })
    expect((await attachAccount(sb.ctx(), 'gabriel', { mux: 'bk', pool: true })).changed).toEqual([])
    expect((await loadConfig(sb.paths)).mux.bk!.pool).toEqual(['gabriel', 'admin1'])
  })

  test('attach --preferred muda mux.account e não troca o link atual', async () => {
    const sb = setup()
    const r = await attachAccount(sb.ctx(), 'admin1', { mux: 'bk', preferred: true })
    expect(r.changed.sort()).toEqual(['accounts', 'preferred'])
    expect((await loadConfig(sb.paths)).mux.bk!.account).toBe('admin1')
    expect(currentAccount(sb.paths, 'bk')).toBe('gabriel')
    expect((await attachAccount(sb.ctx(), 'admin1', { mux: 'bk', preferred: true })).changed).toEqual([])
  })

  test('conta sem token ou fora do registro → exit 3 com a dica do login; mux inexistente → exit 3; config intacta', async () => {
    const sb = setup()
    const before = readFileSync(sb.paths.configFile, 'utf8')
    for (const conta of ['semtoken', 'fantasma']) {
      const e = await run(attachAccount(sb.ctx(), conta, { mux: 'bk' }))
      expect(e?.exit).toBe(EXIT.USAGE)
      expect(e?.message).toContain(`sb login ${conta} --attach bk`)
    }
    // token no disco mas fora do registro também é recusado
    sb.addToken('orfa')
    expect((await run(attachAccount(sb.ctx(), 'orfa', { mux: 'bk' })))?.exit).toBe(EXIT.USAGE)
    const nomux = await run(attachAccount(sb.ctx(), 'admin1', { mux: 'nada' }))
    expect(nomux?.exit).toBe(EXIT.USAGE)
    expect(nomux?.message).toContain('nada')
    expect((await run(attachAccount(sb.ctx(), '../x', { mux: 'bk' })))?.exit).toBe(EXIT.USAGE)
    expect((await run(attachAccount(sb.ctx(), 'admin1', { mux: 'bk', pool: 0 })))?.exit).toBe(EXIT.USAGE)
    expect(readFileSync(sb.paths.configFile, 'utf8')).toBe(before)
  })

  test('attach keychain --pool → exit 3 (config inválida não é gravada); keychain sem pool é permitido', async () => {
    const sb = setup()
    const before = readFileSync(sb.paths.configFile, 'utf8')
    const e = await run(attachAccount(sb.ctx(), 'keychain', { mux: 'bk', pool: true }))
    expect(e?.exit).toBe(EXIT.USAGE)
    expect(readFileSync(sb.paths.configFile, 'utf8')).toBe(before)
    expect((await attachAccount(sb.ctx(), 'keychain', { mux: 'bk' })).changed).toEqual(['accounts'])
    expect((await loadConfig(sb.paths)).mux.bk!.accounts).toEqual(['gabriel', 'keychain'])
  })

  test('comentários da config sobrevivem', async () => {
    const sb = setup()
    const text = readFileSync(sb.paths.configFile, 'utf8')
    writeFileSync(sb.paths.configFile, `// topo\n${text}`)
    await attachAccount(sb.ctx(), 'admin1', { mux: 'bk', pool: true })
    expect(readFileSync(sb.paths.configFile, 'utf8')).toContain('// topo')
  })
})

describe('detachAccount', () => {
  test('tira de accounts e pool; recusa preferida, conta atual e conta não anexada (exit 3)', async () => {
    const sb = setup()
    await attachAccount(sb.ctx(), 'admin1', { mux: 'bk', pool: true })
    await attachAccount(sb.ctx(), 'solta', { mux: 'bk' })
    expect((await detachAccount(sb.ctx(), 'solta', 'bk')).changed).toEqual(['accounts'])
    expect((await detachAccount(sb.ctx(), 'admin1', 'bk')).changed.sort()).toEqual(['accounts', 'pool'])
    const m = (await loadConfig(sb.paths)).mux.bk!
    expect(m.accounts).toEqual(['gabriel'])
    expect(m.pool).toEqual(['gabriel'])

    const pref = await run(detachAccount(sb.ctx(), 'gabriel', 'bk'))
    expect(pref?.exit).toBe(EXIT.USAGE)
    expect(pref?.message).toContain('sb attach <outra> bk --preferred')

    expect((await run(detachAccount(sb.ctx(), 'solta', 'bk')))?.exit).toBe(EXIT.USAGE) // não anexada
    expect((await run(detachAccount(sb.ctx(), 'solta', 'nada')))?.exit).toBe(EXIT.USAGE) // mux inexistente
  })

  test('config escrita numa linha só (como a do populatedSandbox): tirar o último elemento não corrompe o texto', async () => {
    const sb = setup()
    writeFileSync(
      sb.paths.configFile,
      '{ "switchboard": 1, "accounts": { "gabriel": {}, "admin1": {} }, "default": "bk", "mux": { "bk": { "root": "~/bk", "account": "gabriel", "accounts": ["gabriel", "admin1"], "pool": ["gabriel", "admin1"] } } }\n',
    )
    expect((await detachAccount(sb.ctx(), 'admin1', 'bk')).changed.sort()).toEqual(['accounts', 'pool'])
    const m = (await loadConfig(sb.paths)).mux.bk!
    expect(m.accounts).toEqual(['gabriel'])
    expect(m.pool).toEqual(['gabriel'])
  })

  test('recusa a conta atual do mux (depois de um swap), com a dica do swap', async () => {
    const sb = setup()
    await attachAccount(sb.ctx(), 'admin1', { mux: 'bk', pool: true })
    pointMux(sb.paths, 'bk', 'admin1') // o watch trocou para admin1
    const e = await run(detachAccount(sb.ctx(), 'admin1', 'bk'))
    expect(e?.exit).toBe(EXIT.USAGE)
    expect(e?.message).toContain('sb swap')
    expect((await loadConfig(sb.paths)).mux.bk!.accounts).toEqual(['gabriel', 'admin1'])
  })
})

describe('removeAccount', () => {
  test('sem --yes → exit 3; anexada → exit 3 listando os muxes; ok remove registro e token', async () => {
    const sb = setup()
    const before = readFileSync(sb.paths.configFile, 'utf8')
    expect((await run(removeAccount(sb.ctx(), 'solta', { yes: false })))?.exit).toBe(EXIT.USAGE)
    expect(readFileSync(sb.paths.configFile, 'utf8')).toBe(before)
    expect(existsSync(tokenFile(sb.paths, 'solta'))).toBe(true)

    await attachAccount(sb.ctx(), 'solta', { mux: 'bk' })
    await attachAccount(sb.ctx(), 'solta', { mux: 'outro' })
    const att = await run(removeAccount(sb.ctx(), 'solta', { yes: true }))
    expect(att?.exit).toBe(EXIT.USAGE)
    expect(att?.message).toContain('bk')
    expect(att?.message).toContain('outro')
    expect(existsSync(tokenFile(sb.paths, 'solta'))).toBe(true)
    await detachAccount(sb.ctx(), 'solta', 'bk')
    await detachAccount(sb.ctx(), 'solta', 'outro')

    await removeAccount(sb.ctx(), 'solta', { yes: true })
    expect(Object.keys((await loadConfig(sb.paths)).accounts)).not.toContain('solta')
    expect(existsSync(tokenFile(sb.paths, 'solta'))).toBe(false)
    expect(existsSync(tokenFile(sb.paths, 'gabriel'))).toBe(true)

    expect((await run(removeAccount(sb.ctx(), 'solta', { yes: true })))?.exit).toBe(EXIT.USAGE) // já não existe
    expect((await run(removeAccount(sb.ctx(), 'keychain', { yes: true })))?.exit).toBe(EXIT.USAGE)
    expect((await run(removeAccount(sb.ctx(), '../x', { yes: true })))?.exit).toBe(EXIT.USAGE)
  })
})

test('uma conta registrada sem mux é válida na config (accounts sem nenhum mux que a cite)', async () => {
  const sb = setup()
  const cfg = await loadConfig(sb.paths)
  expect(Object.keys(cfg.accounts)).toContain('solta')
  expect(Object.values(cfg.mux).some((m) => m.accounts.includes('solta'))).toBe(false)
})

describe('CLI attach / detach / accounts rm', () => {
  test('attach, detach e accounts rm pela CLI; `sb accounts` sem subcomando continua listando', () => {
    const sb = setup()
    const a = sb.runSb(['attach', 'admin1', 'bk', '--pool', '--json'])
    expect(a.code).toBe(0)
    expect(JSON.parse(a.stdout)).toEqual({ account: 'admin1', mux: 'bk', changed: ['accounts', 'pool'] })
    const again = sb.runSb(['attach', 'admin1', 'bk', '--pool'])
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('nada a mudar')
    expect(sb.runSb(['attach', 'solta', 'bk', '--at', '1']).code).toBe(0)
    expect(sb.runSb(['attach', 'solta', 'bk', '--at', 'x']).code).toBe(EXIT.USAGE)

    const list = sb.runSb(['accounts', '--json'])
    expect(list.code).toBe(0)
    expect((JSON.parse(list.stdout) as Array<{ name: string }>).map((r) => r.name)).toContain('solta')
    expect(sb.runSb(['accounts']).code).toBe(0)

    expect(sb.runSb(['detach', 'gabriel', 'bk']).code).toBe(EXIT.USAGE)
    expect(sb.runSb(['detach', 'solta', 'bk', '--json']).code).toBe(0)
    expect(sb.runSb(['accounts', 'rm', 'admin1']).code).toBe(EXIT.USAGE) // sem --yes
    expect(sb.runSb(['accounts', 'rm', 'admin1', '--yes']).code).toBe(EXIT.USAGE) // anexada
    const rm = sb.runSb(['accounts', 'rm', 'solta', '--yes'])
    expect(rm.code).toBe(0)
    expect(rm.stdout).not.toContain('sb accounts') // o `run` do pai não roda depois do subcomando (nada de listagem extra)
    expect(existsSync(tokenFile(sb.paths, 'solta'))).toBe(false)
  })
})
