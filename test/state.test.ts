import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT, SbError } from '../src/core/errors.js'
import { symlinkAtomic, withLock, writeAtomic } from '../src/core/fsx.js'
import { checkSettingsTarget, currentAccount, ensurePin, pointMux } from '../src/core/links.js'
import { lockFile, muxLink, pinLink, tokenFile } from '../src/core/paths.js'
import { readRuntime, writeRuntime, type Runtime } from '../src/core/runtime.js'
import { ensureState, hasToken, loadSecret, saveToken } from '../src/core/tokens.js'
import { FAKE_TOKEN, sandbox } from './helpers.js'

const mode = (f: string): number => statSync(f).mode & 0o777
const kids: ChildProcess[] = []
afterEach(() => {
  for (const k of kids.splice(0)) k.kill('SIGKILL')
})

describe('writeAtomic / symlinkAtomic', () => {
  test('writeAtomic grava com o modo pedido, sem temporário, e sobrescreve', () => {
    const sb = sandbox()
    mkdirSync(sb.dir, { recursive: true })
    const f = join(sb.dir, 'a.txt')
    writeAtomic(f, 'um', 0o600)
    writeAtomic(f, 'dois', 0o600)
    expect(readFileSync(f, 'utf8')).toBe('dois')
    expect(mode(f)).toBe(0o600)
    expect(readdirSync(sb.dir).filter((n) => n.includes('a.txt'))).toEqual(['a.txt'])
  })

  test('writeAtomic: chamadas seguidas no mesmo processo não colidem no temporário', () => {
    const sb = sandbox()
    const f = join(sb.dir, 'b.txt')
    for (let i = 0; i < 50; i++) writeAtomic(f, String(i), 0o600)
    expect(readFileSync(f, 'utf8')).toBe('49')
    expect(readdirSync(sb.dir).filter((n) => n.startsWith('b.txt'))).toEqual(['b.txt'])
  })

  test('writeAtomic em symlink grava no alvo e preserva o link (também dangling)', () => {
    const sb = sandbox()
    const real = join(sb.dir, 'real.txt')
    const link = join(sb.dir, 'link.txt')
    writeFileSync(real, 'velho')
    symlinkSync(real, link)
    writeAtomic(link, 'novo', 0o600)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe('novo')
    // link relativo e alvo ainda inexistente
    const dangling = join(sb.dir, 'd.txt')
    symlinkSync('alvo.txt', dangling)
    writeAtomic(dangling, 'criado', 0o600)
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(sb.dir, 'alvo.txt'), 'utf8')).toBe('criado')
    expect(readdirSync(sb.dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  test('symlinkAtomic troca o alvo sem deixar temporário', () => {
    const sb = sandbox()
    const dir = join(sb.dir, 'links')
    mkdirSync(dir)
    const link = join(dir, 'l')
    symlinkAtomic(link, '/um')
    symlinkAtomic(link, '/dois')
    expect(readlinkSync(link)).toBe('/dois')
    expect(readdirSync(dir)).toEqual(['l'])
  })
})

describe('ensureState / tokens', () => {
  test('ensureState cria dirs 700 e keychain.json {} 600 (e é idempotente, corrigindo modos)', () => {
    const sb = sandbox()
    const p = sb.paths
    ensureState(p)
    for (const d of ['', 'tokens', 'mux', 'pins', 'log', 'backup']) expect(mode(join(p.stateDir, d))).toBe(0o700)
    const k = join(p.stateDir, 'tokens', 'keychain.json')
    expect(readFileSync(k, 'utf8')).toBe('{}')
    expect(mode(k)).toBe(0o600)
    chmodSync(join(p.stateDir, 'tokens'), 0o755)
    chmodSync(k, 0o644)
    writeFileSync(k, '{"env":{"CLAUDE_CODE_OAUTH_TOKEN":"x"}}')
    ensureState(p)
    expect(mode(join(p.stateDir, 'tokens'))).toBe(0o700)
    expect(mode(k)).toBe(0o600)
    expect(readFileSync(k, 'utf8')).toBe('{}')
  })

  test('saveToken grava 600 e loadSecret devolve o token', () => {
    const sb = sandbox()
    ensureState(sb.paths)
    expect(hasToken(sb.paths, 'admin1')).toBe(false)
    expect(loadSecret(sb.paths, 'admin1')).toBeNull()
    saveToken(sb.paths, 'admin1', FAKE_TOKEN)
    const f = tokenFile(sb.paths, 'admin1')
    expect(mode(f)).toBe(0o600)
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } })
    expect(loadSecret(sb.paths, 'admin1')).toBe(FAKE_TOKEN)
    expect(hasToken(sb.paths, 'admin1')).toBe(true)
    expect(readdirSync(join(sb.paths.stateDir, 'tokens')).sort()).toEqual(['admin1.json', 'keychain.json'])
  })

  test('saveToken cria o estado se faltar, recusa keychain e nome inválido, e o erro não vaza o token', () => {
    const sb = sandbox()
    saveToken(sb.paths, 'gabriel', FAKE_TOKEN)
    expect(mode(join(sb.paths.stateDir, 'tokens'))).toBe(0o700)
    for (const bad of ['keychain', '../x', 'A']) {
      let err: unknown
      try {
        saveToken(sb.paths, bad, FAKE_TOKEN)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(SbError)
      expect((err as SbError).exit).toBe(EXIT.USAGE)
      expect(`${(err as SbError).message}${(err as SbError).detail ?? ''}`).not.toContain(FAKE_TOKEN)
    }
    expect(JSON.parse(readFileSync(join(sb.paths.stateDir, 'tokens', 'keychain.json'), 'utf8'))).toEqual({})
    expect(() => saveToken(sb.paths, 'vazio', '')).toThrow(SbError)
  })

  test('loadSecret/hasToken: keychain, JSON inválido e sem token → null/false', () => {
    const sb = sandbox()
    ensureState(sb.paths)
    expect(loadSecret(sb.paths, 'keychain')).toBeNull()
    expect(hasToken(sb.paths, 'keychain')).toBe(false)
    writeFileSync(tokenFile(sb.paths, 'ruim'), '{nao json', { mode: 0o600 })
    writeFileSync(tokenFile(sb.paths, 'vazio'), '{}', { mode: 0o600 })
    expect(loadSecret(sb.paths, 'ruim')).toBeNull()
    expect(loadSecret(sb.paths, 'vazio')).toBeNull()
    expect(hasToken(sb.paths, 'ruim')).toBe(false)
  })
})

describe('links', () => {
  test('pointMux troca o link de forma atômica e currentAccount lê', () => {
    const sb = sandbox()
    const p = sb.paths
    ensureState(p)
    sb.addToken('gabriel')
    sb.addToken('admin1')
    expect(currentAccount(p, 'bk')).toBeNull()
    pointMux(p, 'bk', 'gabriel')
    pointMux(p, 'bk', 'admin1')
    expect(currentAccount(p, 'bk')).toBe('admin1')
    expect(readdirSync(join(p.stateDir, 'mux'))).toEqual(['bk.json']) // nenhum temporário sobrou
    expect(readlinkSync(muxLink(p, 'bk'))).toBe(tokenFile(p, 'admin1'))
  })

  test('ensurePin cria o link da conta (idempotente) e devolve o caminho', () => {
    const sb = sandbox()
    const p = sb.paths
    ensureState(p)
    sb.addToken('admin1')
    expect(ensurePin(p, 'admin1')).toBe(pinLink(p, 'admin1'))
    expect(ensurePin(p, 'admin1')).toBe(pinLink(p, 'admin1'))
    expect(readlinkSync(pinLink(p, 'admin1'))).toBe(tokenFile(p, 'admin1'))
    expect(readdirSync(join(p.stateDir, 'pins'))).toEqual(['admin1.json'])
    expect(checkSettingsTarget(pinLink(p, 'admin1'))).toEqual({ ok: true, account: 'admin1' })
  })

  describe('checkSettingsTarget', () => {
    const setup = () => {
      const sb = sandbox()
      ensureState(sb.paths)
      return { sb, link: muxLink(sb.paths, 'bk') }
    }
    test('link ausente → missing-link', () => {
      const { link } = setup()
      expect(checkSettingsTarget(link)).toEqual({ ok: false, problem: 'missing-link' })
    })
    test('alvo inexistente → broken', () => {
      const { sb, link } = setup()
      pointMux(sb.paths, 'bk', 'gabriel')
      expect(checkSettingsTarget(link)).toEqual({ ok: false, problem: 'broken' })
    })
    test('JSON inválido → invalid-json (inclusive não-objeto)', () => {
      const { sb, link } = setup()
      for (const body of ['{nao json', '', 'null', '[]', '"x"']) {
        writeFileSync(tokenFile(sb.paths, 'gabriel'), body, { mode: 0o600 })
        pointMux(sb.paths, 'bk', 'gabriel')
        expect(checkSettingsTarget(link)).toEqual({ ok: false, problem: 'invalid-json' })
      }
    })
    test('sem CLAUDE_CODE_OAUTH_TOKEN → no-oauth (nunca "ok": cairia no keychain em silêncio)', () => {
      const { sb, link } = setup()
      for (const body of ['{}', '{"env":{}}', '{"env":{"CLAUDE_CODE_OAUTH_TOKEN":""}}', '{"env":{"CLAUDE_CODE_OAUTH_TOKEN":5}}', '{"env":"x"}', '{"outra":1}']) {
        writeFileSync(tokenFile(sb.paths, 'gabriel'), body, { mode: 0o600 })
        pointMux(sb.paths, 'bk', 'gabriel')
        expect(checkSettingsTarget(link)).toEqual({ ok: false, problem: 'no-oauth' })
      }
    })
    test('ok para token válido e para keychain {}', () => {
      const { sb, link } = setup()
      sb.addToken('gabriel')
      pointMux(sb.paths, 'bk', 'gabriel')
      expect(checkSettingsTarget(link)).toEqual({ ok: true, account: 'gabriel' })
      pointMux(sb.paths, 'bk', 'keychain') // ensureState criou tokens/keychain.json = {}
      expect(checkSettingsTarget(link)).toEqual({ ok: true, account: 'keychain' })
    })
    test('keychain só vale se o alvo é exatamente {}', () => {
      const { sb, link } = setup()
      pointMux(sb.paths, 'bk', 'keychain')
      const k = tokenFile(sb.paths, 'keychain')
      for (const body of ['{"env":{"CLAUDE_CODE_OAUTH_TOKEN":"x"}}', '{"a":1}', '{"env":{}}']) {
        writeFileSync(k, body)
        const r = checkSettingsTarget(link)
        expect(r.ok).toBe(false)
      }
      writeFileSync(k, ' { } \n') // {} com espaços continua sendo {}
      expect(checkSettingsTarget(link)).toEqual({ ok: true, account: 'keychain' })
      writeFileSync(k, '{nao json')
      expect(checkSettingsTarget(link)).toEqual({ ok: false, problem: 'invalid-json' })
    })
  })
})

describe('withLock', () => {
  test('dono vivo: segundo pedido espera e falha com exit 5; o lock do dono fica intacto', async () => {
    const sb = sandbox()
    ensureState(sb.paths)
    const child = spawn('sleep', ['5'], { stdio: 'ignore' })
    kids.push(child)
    writeFileSync(lockFile(sb.paths), String(child.pid), { mode: 0o600 })
    let ran = false
    const t0 = Date.now()
    const err = await withLock(sb.paths, async () => void (ran = true), { waitMs: 300 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SbError)
    expect((err as SbError).exit).toBe(EXIT.LOCKED)
    expect((err as SbError).message).toContain(String(child.pid))
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    expect(ran).toBe(false)
    expect(readFileSync(lockFile(sb.paths), 'utf8')).toBe(String(child.pid))
  })

  test('toma lock de pid morto (e de conteúdo ilegível e velho)', async () => {
    const sb = sandbox()
    ensureState(sb.paths)
    writeFileSync(lockFile(sb.paths), '999999')
    expect(await withLock(sb.paths, async () => readFileSync(lockFile(sb.paths), 'utf8'), { waitMs: 300 })).toBe(String(process.pid))
    expect(existsSync(lockFile(sb.paths))).toBe(false)
    writeFileSync(lockFile(sb.paths), 'lixo')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockFile(sb.paths), old, old)
    expect(await withLock(sb.paths, async () => 'ok', { waitMs: 300 })).toBe('ok')
    expect(readdirSync(sb.paths.stateDir).filter((n) => n.startsWith('lock'))).toEqual([])
  })

  test('lock com conteúdo ilegível mas recente (dono gravando o pid) não é tomado', async () => {
    const sb = sandbox()
    ensureState(sb.paths)
    writeFileSync(lockFile(sb.paths), '')
    const err = await withLock(sb.paths, async () => 1, { waitMs: 200 }).catch((e: unknown) => e)
    expect((err as SbError).exit).toBe(EXIT.LOCKED)
  })

  test('cria o diretório de estado se faltar; o lock tem o pid, modo 600, e some ao terminar (também com erro)', async () => {
    const sb = sandbox()
    const seen = await withLock(sb.paths, async () => ({ pid: readFileSync(lockFile(sb.paths), 'utf8'), m: mode(lockFile(sb.paths)) }))
    expect(seen).toEqual({ pid: String(process.pid), m: 0o600 })
    expect(existsSync(lockFile(sb.paths))).toBe(false)
    await expect(withLock(sb.paths, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(existsSync(lockFile(sb.paths))).toBe(false)
  })

  test('exclusão mútua no mesmo processo: seções críticas não se sobrepõem', async () => {
    const sb = sandbox()
    let inside = 0
    let maxInside = 0
    const order: number[] = []
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        withLock(sb.paths, async () => {
          inside++
          maxInside = Math.max(maxInside, inside)
          await new Promise((r) => setTimeout(r, 30))
          order.push(n)
          inside--
        }),
      ),
    )
    expect(maxInside).toBe(1)
    expect(order.sort()).toEqual([1, 2, 3, 4])
    expect(readdirSync(sb.paths.stateDir)).toEqual([])
  })

  test('não apaga o lock de outro dono ao terminar', async () => {
    const sb = sandbox()
    const child = spawn('sleep', ['5'], { stdio: 'ignore' })
    kids.push(child)
    await withLock(sb.paths, async () => {
      writeFileSync(lockFile(sb.paths), String(child.pid)) // alguém "tomou" o lock à força
    })
    expect(readFileSync(lockFile(sb.paths), 'utf8')).toBe(String(child.pid))
  })
})

describe('runtime', () => {
  test('readRuntime sem arquivo devolve estrutura vazia', () => {
    const sb = sandbox()
    expect(readRuntime(sb.paths)).toEqual({ mux: {}, overrides: {}, pending: [], notified: {} })
  })

  test('writeRuntime/readRuntime fazem round-trip (modo 600, sem temporário)', () => {
    const sb = sandbox()
    ensureState(sb.paths)
    const r: Runtime = {
      mux: { bk: { since: 1, lastSwap: { at: 2, from: 'gabriel', to: 'admin1', reason: 'limite' } } },
      overrides: { bk: { account: 'admin1', until: 99 } },
      pending: [{ jobId: 'j1', settings: '/x', reason: 'pin', requestedAt: 3 }],
      notified: { 'gabriel:5h': 4 },
    }
    writeRuntime(sb.paths, r)
    expect(readRuntime(sb.paths)).toEqual(r)
    expect(mode(join(sb.paths.stateDir, 'runtime.json'))).toBe(0o600)
    expect(readdirSync(sb.paths.stateDir).filter((n) => n.includes('runtime'))).toEqual(['runtime.json'])
  })

  test('arquivo parcial recebe os padrões; JSON corrompido é erro explícito (não zera em silêncio)', () => {
    const sb = sandbox()
    ensureState(sb.paths)
    const f = join(sb.paths.stateDir, 'runtime.json')
    writeFileSync(f, '{"mux":{"bk":{"since":1}}}')
    expect(readRuntime(sb.paths)).toEqual({ mux: { bk: { since: 1 } }, overrides: {}, pending: [], notified: {} })
    writeFileSync(f, '{corrompido')
    expect(() => readRuntime(sb.paths)).toThrow(SbError)
  })
})
