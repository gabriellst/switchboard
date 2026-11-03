import { describe, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { addMux, resolveMuxForDir, rmMux, setMux } from '../src/core/mux.js'
import { loadConfig } from '../src/core/config.js'
import { EXIT, SbError } from '../src/core/errors.js'
import { currentAccount } from '../src/core/links.js'
import { muxLink, tokenFile } from '../src/core/paths.js'
import { FAKE_TOKEN, sandbox, type Sandbox } from './helpers.js'

/** Sandbox com a config dada (texto) e tokens para as contas pedidas. */
function setup(config: unknown, tokens: string[] = ['gabriel', 'admin1']): Sandbox {
  const sb = sandbox()
  mkdirSync(dirname(sb.paths.configFile), { recursive: true })
  writeFileSync(sb.paths.configFile, typeof config === 'string' ? config : JSON.stringify(config, null, 2) + '\n')
  for (const a of tokens) sb.addToken(a)
  return sb
}

const registry = { switchboard: 1, accounts: { gabriel: {}, admin1: {} }, mux: {} }

const run = async (p: Promise<unknown>): Promise<SbError | undefined> => {
  try {
    await p
  } catch (e) {
    if (e instanceof SbError) return e
    throw e
  }
  return undefined
}

const exitOf = async (p: Promise<unknown>): Promise<number | undefined> => {
  try {
    await p
  } catch (e) {
    if (e instanceof SbError) return e.exit
    throw e
  }
  return undefined
}

const exists = (f: string): boolean => {
  try {
    lstatSync(f)
    return true
  } catch {
    return false
  }
}

describe('addMux', () => {
  test('add cria config, define default e aponta o link', async () => {
    const sb = setup(registry)
    await addMux(sb.ctx(), 'bk', { root: '~/bk', account: 'gabriel' })
    const cfg = await loadConfig(sb.paths)
    expect(cfg.default).toBe('bk')
    expect(cfg.mux.bk).toEqual({ root: '~/bk', account: 'gabriel', accounts: ['gabriel'], pool: [] })
    expect(currentAccount(sb.paths, 'bk')).toBe('gabriel')
    // o link resolve para o token (o claude abriria)
    expect(readFileSync(muxLink(sb.paths, 'bk'), 'utf8')).toContain(FAKE_TOKEN)
  })

  test('add sem config prévia (conta keychain): cria a config e o link do keychain', async () => {
    const sb = sandbox()
    await addMux(sb.ctx(), 'berzerk', { root: '~/berzerk', account: 'keychain' })
    const cfg = await loadConfig(sb.paths)
    expect(cfg.default).toBe('berzerk')
    expect(currentAccount(sb.paths, 'berzerk')).toBe('keychain')
  })

  test('o 2º mux não mexe no default; accounts/pool explícitos valem', async () => {
    const sb = setup(registry)
    await addMux(sb.ctx(), 'bk', { root: '~/bk', account: 'gabriel' })
    await addMux(sb.ctx(), 'pessoal', { root: '~/pessoal', account: 'admin1', accounts: ['admin1', 'gabriel'], pool: ['admin1', 'gabriel'] })
    const cfg = await loadConfig(sb.paths)
    expect(cfg.default).toBe('bk')
    expect(cfg.mux.pessoal).toEqual({ root: '~/pessoal', account: 'admin1', accounts: ['admin1', 'gabriel'], pool: ['admin1', 'gabriel'] })
    expect(currentAccount(sb.paths, 'pessoal')).toBe('admin1')
  })

  test('add com conta sem token → exit 3 com a dica; nada gravado', async () => {
    const sb = setup(registry, ['admin1'])
    const before = readFileSync(sb.paths.configFile, 'utf8')
    let err: unknown
    try {
      await addMux(sb.ctx(), 'bk', { root: '~/bk', account: 'gabriel' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SbError)
    expect((err as SbError).exit).toBe(EXIT.USAGE)
    expect((err as SbError).message).toContain('sb login gabriel')
    expect(readFileSync(sb.paths.configFile, 'utf8')).toBe(before)
    expect(exists(muxLink(sb.paths, 'bk'))).toBe(false)
  })

  test('add com pool fora de accounts → exit 2 e config intacta (e sem link)', async () => {
    const sb = setup(registry)
    const before = readFileSync(sb.paths.configFile, 'utf8')
    expect(await exitOf(addMux(sb.ctx(), 'bk', { root: '~/bk', account: 'gabriel', accounts: ['gabriel'], pool: ['admin1'] }))).toBe(EXIT.INVALID_CONFIG)
    expect(readFileSync(sb.paths.configFile, 'utf8')).toBe(before)
    expect(exists(muxLink(sb.paths, 'bk'))).toBe(false)
  })

  test('add com conta que tem token mas não está no registro → exit 3 "não registrada"; sem config prévia, nenhum arquivo fica para trás', async () => {
    const sb = setup(registry)
    sb.addToken('orfa')
    const before = readFileSync(sb.paths.configFile, 'utf8')
    const e = await run(addMux(sb.ctx(), 'bk', { root: '~/bk', account: 'orfa' }))
    expect(e?.exit).toBe(EXIT.USAGE)
    expect(e?.message).toContain('não está registrada')
    expect(readFileSync(sb.paths.configFile, 'utf8')).toBe(before)

    const bare = sandbox() // sem config
    bare.addToken('orfa')
    expect((await run(addMux(bare.ctx(), 'bk', { root: '~/bk', account: 'orfa' })))?.exit).toBe(EXIT.USAGE)
    expect(exists(bare.paths.configFile)).toBe(false)
    // edição que falha depois do ensureConfig (keychain + pool inválido) também desfaz o arquivo criado
    expect(await exitOf(addMux(bare.ctx(), 'bk', { root: '~/bk', account: 'keychain', pool: ['keychain'] }))).toBe(EXIT.INVALID_CONFIG)
    expect(exists(bare.paths.configFile)).toBe(false)
    expect(exists(muxLink(bare.paths, 'bk'))).toBe(false)
  })

  test('add/set: root que não é absoluto nem começa por ~ → exit 3, nada gravado', async () => {
    const sb = setup(registry)
    for (const root of ['bk', './bk', '../bk', '~bk', '']) {
      const e = await run(addMux(sb.ctx(), 'bk', { root, account: 'gabriel' }))
      expect(e?.exit).toBe(EXIT.USAGE)
      expect(e?.message).toContain('use um caminho absoluto ou começando por ~')
    }
    expect(Object.keys((await loadConfig(sb.paths)).mux)).toEqual([])
    await addMux(sb.ctx(), 'bk', { root: '~/bk', account: 'gabriel' })
    const before = readFileSync(sb.paths.configFile, 'utf8')
    expect((await run(setMux(sb.ctx(), 'bk', { root: 'relativo' })))?.exit).toBe(EXIT.USAGE)
    expect(readFileSync(sb.paths.configFile, 'utf8')).toBe(before)
    await addMux(sb.ctx(), 'abs', { root: '/tmp/abs', account: 'gabriel' }) // absoluto e `~` puro valem
    expect((await setMux(sb.ctx(), 'abs', { root: '~' })).changed).toEqual(['root'])
  })

  test('add: nome inválido (../x), mux repetido e root repetido não gravam nada', async () => {
    const sb = setup(registry)
    expect(await exitOf(addMux(sb.ctx(), '../x', { root: '~/x', account: 'gabriel' }))).toBe(EXIT.USAGE)
    expect(await exitOf(addMux(sb.ctx(), 'bk', { root: '~/bk', account: '../gabriel' }))).toBe(EXIT.USAGE)
    await addMux(sb.ctx(), 'bk', { root: '~/bk', account: 'gabriel' })
    const before = readFileSync(sb.paths.configFile, 'utf8')
    expect(await exitOf(addMux(sb.ctx(), 'bk', { root: '~/outro', account: 'gabriel' }))).toBe(EXIT.USAGE) // já existe
    expect(await exitOf(addMux(sb.ctx(), 'dois', { root: '~/bk', account: 'gabriel' }))).toBe(EXIT.INVALID_CONFIG) // root repetido
    expect(readFileSync(sb.paths.configFile, 'utf8')).toBe(before)
    expect(exists(muxLink(sb.paths, 'dois'))).toBe(false)
  })
})

describe('setMux', () => {
  const withComments = `{
  // meu registro
  "switchboard": 1,
  "accounts": { "gabriel": {}, "admin1": {} },
  "default": "bk",
  "mux": {
    // o principal
    "bk": { "root": "~/bk", "account": "gabriel", "accounts": ["gabriel", "admin1"], "pool": ["gabriel", "admin1"] }
  }
}
`

  test('set --pool muda a ordem e preserva comentários; não troca o link', async () => {
    const sb = setup(withComments)
    mkdirSync(join(sb.paths.stateDir, 'mux'), { recursive: true })
    symlinkSync(tokenFile(sb.paths, 'gabriel'), muxLink(sb.paths, 'bk'))
    const r = await setMux(sb.ctx(), 'bk', { pool: ['admin1', 'gabriel'] })
    expect(r.changed).toEqual(['pool'])
    const text = readFileSync(sb.paths.configFile, 'utf8')
    expect(text).toContain('// meu registro')
    expect(text).toContain('// o principal')
    expect((await loadConfig(sb.paths)).mux.bk!.pool).toEqual(['admin1', 'gabriel'])
    expect(currentAccount(sb.paths, 'bk')).toBe('gabriel')
  })

  test('set inválido → exit 2 e config intacta; mux inexistente → exit 3; preferida sem token → exit 3', async () => {
    const sb = setup(withComments, ['gabriel'])
    const before = readFileSync(sb.paths.configFile, 'utf8')
    expect(await exitOf(setMux(sb.ctx(), 'bk', { pool: ['fantasma'] }))).toBe(EXIT.INVALID_CONFIG)
    expect(await exitOf(setMux(sb.ctx(), 'nada', { pool: ['gabriel'] }))).toBe(EXIT.USAGE)
    expect(await exitOf(setMux(sb.ctx(), 'bk', { account: 'admin1' }))).toBe(EXIT.USAGE) // admin1 sem token
    expect(readFileSync(sb.paths.configFile, 'utf8')).toBe(before)
  })

  test('set --root e --default', async () => {
    const sb = setup(withComments)
    await addMux(sb.ctx(), 'outro', { root: '~/outro', account: 'admin1', accounts: ['admin1'] })
    const r = await setMux(sb.ctx(), 'outro', { root: '~/novo', default: true })
    expect(r.changed.sort()).toEqual(['default', 'root'])
    const cfg = await loadConfig(sb.paths)
    expect(cfg.mux.outro!.root).toBe('~/novo')
    expect(cfg.default).toBe('outro')
    expect((await setMux(sb.ctx(), 'outro', { root: '~/novo' })).changed).toEqual([]) // idempotente
  })
})

describe('rmMux', () => {
  test('rm do default é recusado; rm de outro mantém o link', async () => {
    const sb = setup(registry)
    await addMux(sb.ctx(), 'bk', { root: '~/bk', account: 'gabriel' })
    await addMux(sb.ctx(), 'pessoal', { root: '~/pessoal', account: 'admin1' })
    const before = readFileSync(sb.paths.configFile, 'utf8')
    expect(await exitOf(rmMux(sb.ctx(), 'bk'))).toBe(EXIT.USAGE)
    expect(readFileSync(sb.paths.configFile, 'utf8')).toBe(before)
    await rmMux(sb.ctx(), 'pessoal')
    expect(Object.keys((await loadConfig(sb.paths)).mux)).toEqual(['bk'])
    // sessões existentes continuam abrindo: o link fica (o doctor avisa o órfão)
    expect(readlinkSync(muxLink(sb.paths, 'pessoal'))).toBe(tokenFile(sb.paths, 'admin1'))
    expect(await exitOf(rmMux(sb.ctx(), 'pessoal'))).toBe(EXIT.USAGE) // já não existe
  })
})

describe('resolveMuxForDir', () => {
  const cfgOf = (sb: Sandbox, roots: Record<string, string>, def?: string) =>
    ({
      switchboard: 1,
      accounts: { gabriel: {} },
      ...(def ? { default: def } : {}),
      mux: Object.fromEntries(Object.entries(roots).map(([n, root]) => [n, { root, account: 'gabriel', accounts: ['gabriel'], pool: [] }])),
    }) as never as Awaited<ReturnType<typeof loadConfig>>

  test('root mais profundo vence; fora de todos → default', () => {
    const sb = sandbox()
    const home = sb.env.HOME!
    mkdirSync(join(home, 'p', 'berzerk', 'club'), { recursive: true })
    const cfg = cfgOf(sb, { bk: '~/p', berzerk: '~/p/berzerk' }, 'bk')
    expect(resolveMuxForDir(cfg, join(home, 'p', 'berzerk', 'club'), home)).toBe('berzerk')
    expect(resolveMuxForDir(cfg, join(home, 'p', 'berzerk'), home)).toBe('berzerk')
    expect(resolveMuxForDir(cfg, join(home, 'p'), home)).toBe('bk')
    expect(resolveMuxForDir(cfg, sb.dir, home)).toBe('bk') // fora de todos → default
  })

  test('compara por segmentos: /p/bk não contém /p/bkx', () => {
    const sb = sandbox()
    const home = sb.env.HOME!
    mkdirSync(join(home, 'p', 'bkx'), { recursive: true })
    mkdirSync(join(home, 'p', 'bk', 'sub'), { recursive: true })
    const cfg = cfgOf(sb, { bk: '~/p/bk', outro: '~/o' }, 'outro')
    expect(resolveMuxForDir(cfg, join(home, 'p', 'bkx'), home)).toBe('outro')
    expect(resolveMuxForDir(cfg, join(home, 'p', 'bk', 'sub'), home)).toBe('bk')
  })

  test('realpath: pasta dentro de symlink; pasta inexistente sob um root; root com barra final', () => {
    const sb = sandbox()
    const home = sb.env.HOME!
    mkdirSync(join(home, 'real', 'x'), { recursive: true })
    symlinkSync(join(home, 'real'), join(home, 'atalho'))
    const cfg = cfgOf(sb, { bk: '~/real/', outro: '~/o' }, 'outro')
    expect(resolveMuxForDir(cfg, join(home, 'atalho', 'x'), home)).toBe('bk')
    expect(resolveMuxForDir(cfg, join(home, 'real', 'ainda', 'nao', 'existe'), home)).toBe('bk')
  })

  test('HOME e pasta alcançados por um alias que não é o realpath (/var → /private/var)', () => {
    const sb = sandbox()
    const alias = `${sb.dir}-alias`
    symlinkSync(sb.dir, alias)
    const home = join(alias, 'home') // HOME "do ambiente" passando pelo alias
    mkdirSync(join(sb.env.HOME!, 'p', 'x'), { recursive: true })
    const cfg = cfgOf(sb, { bk: '~/p', fora: '~/o' }, 'fora')
    expect(resolveMuxForDir(cfg, join(alias, 'home', 'p', 'x'), home)).toBe('bk') // pasta pelo alias, root pelo alias
    expect(resolveMuxForDir(cfg, join(sb.env.HOME!, 'p', 'x'), home)).toBe('bk') // pasta pelo realpath, root pelo alias
    const abs = cfgOf(sb, { bk: join(alias, 'home', 'p') }, 'bk') // root absoluto escrito pelo alias
    expect(resolveMuxForDir(abs, join(sb.env.HOME!, 'p', 'x'), sb.env.HOME!)).toBe('bk')
    rmSync(alias)
  })

  test('sem default e fora de todos → exit 2', () => {
    const sb = sandbox()
    const home = sb.env.HOME!
    const cfg = cfgOf(sb, {})
    let err: unknown
    try {
      resolveMuxForDir(cfg, home, home)
    } catch (e) {
      err = e
    }
    expect((err as SbError).exit).toBe(EXIT.INVALID_CONFIG)
  })
})

describe('sb which', () => {
  test('dentro de bk imprime o caminho do link, e só ele', async () => {
    const sb = setup(registry)
    await addMux(sb.ctx(), 'bk', { root: '~/bk', account: 'gabriel' })
    await addMux(sb.ctx(), 'pessoal', { root: '~/pessoal', account: 'admin1' })
    mkdirSync(join(sb.env.HOME!, 'pessoal', 'sub'), { recursive: true })
    const r = sb.runSb(['which'], { cwd: join(sb.env.HOME!, 'pessoal', 'sub') })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`${muxLink(sb.paths, 'pessoal')}\n`)
    expect(r.stderr).toBe('')
    // pasta explícita, fora de tudo → default
    const d = sb.runSb(['which', sb.dir])
    expect(d.stdout).toBe(`${muxLink(sb.paths, 'bk')}\n`)
  })

  test('--json: { mux, settings, account }', async () => {
    const sb = setup(registry)
    await addMux(sb.ctx(), 'bk', { root: '~/bk', account: 'gabriel' })
    const r = sb.runSb(['which', '--json'], { cwd: sb.dir })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ mux: 'bk', settings: muxLink(sb.paths, 'bk'), account: 'gabriel' })
  })

  test('happy path em texto e --json: stdout exato', async () => {
    const sb = setup(registry)
    await addMux(sb.ctx(), 'bk', { root: '~/bk', account: 'gabriel' })
    const t = sb.runSb(['which'], { cwd: sb.dir })
    expect(t.code).toBe(0)
    expect(t.stdout).toBe(`${muxLink(sb.paths, 'bk')}\n`)
    const j = sb.runSb(['which', '--json'], { cwd: sb.dir })
    expect(j.code).toBe(0)
    expect(j.stdout).toBe(`${JSON.stringify({ mux: 'bk', settings: muxLink(sb.paths, 'bk'), account: 'gabriel' })}\n`)
  })

  // fail closed: um settings inválido faria o claude cair em silêncio no keychain (F6), então o wrapper tem de receber erro
  const BREAKS: Array<[string, (sb: Sandbox) => void, RegExp]> = [
    ['link ausente', (sb) => rmSync(muxLink(sb.paths, 'bk')), /link.*(ausente|não existe)/i],
    ['link quebrado (token sumiu)', (sb) => rmSync(tokenFile(sb.paths, 'gabriel')), /quebrado|aponta/i],
    ['token com JSON inválido', (sb) => writeFileSync(tokenFile(sb.paths, 'gabriel'), 'not json{'), /JSON inválido/i],
    ['token sem CLAUDE_CODE_OAUTH_TOKEN', (sb) => writeFileSync(tokenFile(sb.paths, 'gabriel'), '{"env":{}}'), /CLAUDE_CODE_OAUTH_TOKEN/],
  ]
  for (const [name, breakIt, msg] of BREAKS) {
    for (const flags of [[], ['--json']]) {
      test(`${name} (${flags.join('') || 'texto'}) → exit 1, stdout vazio, dica do doctor`, async () => {
        const sb = setup(registry)
        await addMux(sb.ctx(), 'bk', { root: '~/bk', account: 'gabriel' })
        breakIt(sb)
        const r = sb.runSb(['which', ...flags], { cwd: sb.dir })
        expect(r.code).toBe(EXIT.CHECK_FAILED)
        expect(r.stdout).toBe('')
        expect(r.stderr).toMatch(msg)
        expect(r.stderr).toContain('sb doctor --fix')
        expect(r.stderr).not.toMatch(/sk-ant-/)
      })
    }
  }

  test('erro: stdout vazio, mensagem em stderr, exit ≠ 0', () => {
    const sb = sandbox() // sem config
    const r = sb.runSb(['which'])
    expect(r.code).toBe(EXIT.INVALID_CONFIG)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('sb login')
  })
})

describe('CLI sb mux', () => {
  test('mux list, add, set, rm pela CLI', () => {
    const sb = setup(registry)
    expect(sb.runSb(['mux', 'add', 'bk', '--root', '~/bk', '--account', 'gabriel', '--accounts', 'gabriel,admin1', '--pool', 'gabriel,admin1']).code).toBe(0)
    const list = sb.runSb(['mux', '--json'])
    expect(list.code).toBe(0)
    const j = JSON.parse(list.stdout) as Array<{ name: string; default: boolean; current: string | null; pool: string[] }>
    expect(j).toMatchObject([{ name: 'bk', default: true, current: 'gabriel', pool: ['gabriel', 'admin1'] }])
    const human = sb.runSb(['mux', 'list'])
    expect(human.code).toBe(0)
    expect(human.stdout).toContain('bk')
    const set = sb.runSb(['mux', 'set', 'bk', '--pool', 'admin1,gabriel'])
    expect(set.code).toBe(0)
    expect(set.stdout).toContain('sb swap')
    expect(sb.runSb(['mux', 'rm', 'bk']).code).toBe(EXIT.USAGE) // é o default
    expect(sb.runSb(['mux', 'add', '../x', '--root', '~/x', '--account', 'gabriel']).code).toBe(EXIT.USAGE)
  })
})
