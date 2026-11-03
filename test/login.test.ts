import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runLogin } from '../src/commands/login.js'
import { loadConfig } from '../src/core/config.js'
import { defaultCtx, type Ctx } from '../src/core/ctx.js'
import { EXIT, SbError } from '../src/core/errors.js'
import { extractTokens, login, runSetupToken } from '../src/core/login.js'
import { logFile, tokenFile } from '../src/core/paths.js'
import { FAKE_TOKEN, fakeApi, populatedSandbox, sandbox, type FakeApi, type Sandbox } from './helpers.js'

const URL_LINE = 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz'
const H: Record<string, string> = {
  'anthropic-ratelimit-unified-5h-utilization': '0.24',
  'anthropic-ratelimit-unified-5h-reset': '1762195800',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.38',
  'anthropic-ratelimit-unified-7d-reset': '1762444800',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-reset': '1762195800',
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor: passou do prazo')
    await sleep(50)
  }
}

const fake = (sb: Sandbox, name: string, content: string): void => {
  mkdirSync(sb.env.FAKE_CLAUDE_DIR!, { recursive: true })
  writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, name), content)
}
/** O claude falso imprime a URL e depois o token (como o `setup-token` de verdade). */
const fakeOutput = (sb: Sandbox, text = `Abrindo o navegador...\n${URL_LINE}\n\nSeu token:\n${FAKE_TOKEN}\n`): void => fake(sb, 'setup-token.txt', text)

/** Ctx do sandbox com a API falsa de verdade (porta efêmera) e `fetch` real em loopback. */
function ctxFor(sb: Sandbox, api: FakeApi, over: Partial<Ctx> = {}): Ctx {
  const env = { ...sb.env, SWITCHBOARD_API_BASE: api.url }
  return sb.ctx({ env, fetch: defaultCtx(env).fetch, ...over })
}

const writeConfig = (sb: Sandbox, cfg: unknown): void => {
  mkdirSync(dirname(sb.paths.configFile), { recursive: true })
  writeFileSync(sb.paths.configFile, typeof cfg === 'string' ? cfg : JSON.stringify(cfg, null, 2) + '\n')
}
const BASE_CFG = { switchboard: 1, accounts: {}, mux: { bk: { root: '~/bk', account: 'ref', accounts: ['ref'], pool: [] } }, default: 'bk' }
const withRef = (): Sandbox => {
  const sb = sandbox()
  writeConfig(sb, { ...BASE_CFG, accounts: { ref: {} } })
  sb.addToken('ref')
  return sb
}

const readLog = (sb: Sandbox): string => {
  try {
    return readFileSync(logFile(sb.paths, 'login'), 'utf8')
  } catch {
    return ''
  }
}

const exitOf = async (p: Promise<unknown>): Promise<{ exit: number; message: string } | undefined> => {
  try {
    await p
  } catch (e) {
    if (e instanceof SbError) return { exit: e.exit, message: e.message + (e.detail ?? '') }
    throw e
  }
  return undefined
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let api: FakeApi | undefined
const okApi = async (): Promise<FakeApi> => (api = await fakeApi(() => new Response('{}', { status: 200, headers: H })))
const deadApi = async (): Promise<FakeApi> => (api = await fakeApi(() => new Response('{}', { status: 401 })))
afterEach(() => {
  api?.stop()
  api = undefined
})

describe('extractTokens', () => {
  test('ANSI, OSC e token quebrado na largura', () => {
    const raw = '\x1b]0;t\x07\x1b[32mToken:\x1b[0m\r\nsk-ant-oat01-' + 'a'.repeat(30) + '\r\n' + 'b'.repeat(20) + '\r\n\x1b[2K'
    expect(extractTokens(raw)[0]).toBe('sk-ant-oat01-' + 'a'.repeat(30) + 'b'.repeat(20))
  })
  test('devolve o juntado e depois o da linha (até 3, sem repetição); sem token → vazio', () => {
    const raw = 'sk-ant-oat01-' + 'a'.repeat(30) + '\r\n' + 'b'.repeat(20) + '\r\nx\r\n\r\ntexto com espaço\r\nsk-ant-oat01-' + 'c'.repeat(25) + '\r\n\r\nfim com espaço'
    const out = extractTokens(raw)
    expect(out).toEqual([
      'sk-ant-oat01-' + 'a'.repeat(30) + 'b'.repeat(20) + 'x',
      'sk-ant-oat01-' + 'a'.repeat(30),
      'sk-ant-oat01-' + 'c'.repeat(25),
    ])
    expect(extractTokens('nada aqui\r\n\x1b[2K')).toEqual([])
  })
  test('token completo no meio da linha não junta as linhas seguintes', () => {
    const raw = 'tok: sk-ant-oat01-' + 'a'.repeat(30) + ' fim\r\n' + 'b'.repeat(20) + '\r\n'
    expect(extractTokens(raw)).toEqual(['sk-ant-oat01-' + 'a'.repeat(30)])
  })
})

describe('runSetupToken (claude falso, PTY via script)', () => {
  test('URL, token, CLAUDE_CONFIG_DIR temporário (apagado), cleanEnv, 2000 colunas', async () => {
    const sb = sandbox()
    fakeOutput(sb)
    // o ambiente do chamador tem as variáveis que vazam: nenhuma pode chegar ao claude
    const ctx = sb.ctx({ env: { ...sb.env, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, CLAUDE_CONFIG_DIR: '/nao/usar', CLAUDECODE: '1' } })
    const urls: string[] = []
    const tokens = await runSetupToken(ctx, (u) => urls.push(u))
    expect(tokens).toEqual([FAKE_TOKEN])
    expect(urls).toEqual([URL_LINE])
    const calls = sb.calls()
    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.argv).toEqual(['setup-token'])
    expect(c.hasOauthEnv).toBe(false)
    expect(c.configDir).not.toBeNull()
    expect(c.configDir).not.toBe('/nao/usar')
    expect(c.onboarding).toEqual({ hasCompletedOnboarding: true, theme: 'dark' })
    expect(c.term).toBe('xterm-256color')
    expect(c.cols).toBe(2000)
    expect(existsSync(c.configDir!)).toBe(false)
  })

  test('claude que falha (exit 1) ou inexistente → exit 4, sem sobras', async () => {
    const sb = sandbox()
    fake(sb, 'setup-token.exit', '1')
    const failed = await exitOf(runSetupToken(sb.ctx(), () => undefined))
    expect(failed?.exit).toBe(EXIT.CLAUDE)
    const dir1 = sb.calls()[0]!.configDir!
    expect(existsSync(dir1)).toBe(false)

    const missing = await exitOf(runSetupToken(sb.ctx({ env: { ...sb.env, SWITCHBOARD_CLAUDE: join(sb.dir, 'nao-existe') } }), () => undefined))
    expect(missing?.exit).toBe(EXIT.CLAUDE)
    expect(missing?.message).toMatch(/claude/)
  })

  test('claude que sai 0 sem token → lista vazia (quem chama decide)', async () => {
    const sb = sandbox()
    expect(await runSetupToken(sb.ctx(), () => undefined)).toEqual([])
  })

  test('travado: limite curto → exit 4, diretório temporário apagado, claude falso morto', async () => {
    const sb = sandbox()
    fake(sb, 'setup-token.sleep', '60000')
    const t0 = Date.now()
    const r = await exitOf(runSetupToken(sb.ctx(), () => undefined, 600))
    expect(r?.exit).toBe(EXIT.CLAUDE)
    expect(Date.now() - t0).toBeLessThan(8_000)
    const c = sb.calls()[0]!
    expect(existsSync(c.configDir!)).toBe(false)
    await waitFor(() => !alive(c.pid!), 5_000) // nenhum processo órfão
  })

  test('sem URL: manda Enter (\\r) e o claude falso, que esperava, segue', async () => {
    const sb = sandbox()
    fake(sb, 'setup-token.wait-enter', '1')
    fakeOutput(sb)
    const tokens = await runSetupToken(sb.ctx(), () => undefined, 20_000, { enterAfterMs: 300, enterEveryMs: 300 })
    expect(tokens).toEqual([FAKE_TOKEN])
  })
})

describe('login()', () => {
  test('claude falso: URL, token validado, salvo 600, conta registrada; log só com marcos', async () => {
    const sb = sandbox()
    writeConfig(sb, { switchboard: 1, accounts: {}, mux: {} })
    fakeOutput(sb)
    const a = await okApi()
    const urls: string[] = []
    const r = await login(ctxFor(sb, a), 'gabriel', { terminal: false, onUrl: (u) => urls.push(u) })
    expect(r).toEqual({ account: 'gabriel', created: true })
    expect(urls).toEqual([URL_LINE])
    const f = tokenFile(sb.paths, 'gabriel')
    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } })
    expect((await loadConfig(sb.paths)).accounts).toEqual({ gabriel: {} })
    const call = sb.calls()[0]!
    expect(call.hasOauthEnv).toBe(false)
    expect(call.configDir).toContain('/')
    expect(existsSync(call.configDir!)).toBe(false)
    // a sonda levou o token só no cabeçalho
    expect(a.requests).toHaveLength(1)
    expect(a.requests[0]!.headers.get('authorization')).toBe(`Bearer ${FAKE_TOKEN}`)
    const log = readLog(sb)
    expect(log).not.toMatch(/sk-ant-/)
    const marks = log.trim().split('\n').map((l) => l.slice(l.indexOf(' ') + 1))
    expect(marks.map((m) => m.split(' ')[0])).toEqual(['abrindo', 'url', 'validando', 'FIM'])
    expect(marks[3]).toBe('FIM ok')
  })

  test('sem config ainda: cria a config mínima e registra', async () => {
    const sb = sandbox()
    fakeOutput(sb)
    await login(ctxFor(sb, await okApi()), 'gabriel', { terminal: false })
    expect(Object.keys((await loadConfig(sb.paths)).accounts)).toEqual(['gabriel'])
  })

  test('conta que já existe: token trocado, created=false', async () => {
    const sb = withRef()
    fakeOutput(sb)
    const r = await login(ctxFor(sb, await okApi()), 'ref', { terminal: false })
    expect(r.created).toBe(false)
    expect(readFileSync(tokenFile(sb.paths, 'ref'), 'utf8')).toContain(FAKE_TOKEN)
  })

  test('sonda 401 → exit 1, nada salvo, config intacta, FIM falhou', async () => {
    const sb = withRef()
    const before = readFileSync(sb.paths.configFile, 'utf8')
    fakeOutput(sb)
    const r = await exitOf(login(ctxFor(sb, await deadApi()), 'nova', { terminal: false }))
    expect(r?.exit).toBe(EXIT.CHECK_FAILED)
    expect(r?.message).not.toMatch(/sk-ant-/)
    expect(existsSync(tokenFile(sb.paths, 'nova'))).toBe(false)
    expect(readFileSync(sb.paths.configFile, 'utf8')).toBe(before)
    expect(readLog(sb)).toContain('FIM falhou')
    expect(readLog(sb)).not.toMatch(/sk-ant-/)
  })

  test('claude sem token (exit 0, nada impresso) → exit 1 com dica do --terminal, nada salvo', async () => {
    const sb = withRef()
    const r = await exitOf(login(ctxFor(sb, await okApi()), 'nova', { terminal: false }))
    expect(r?.exit).toBe(EXIT.CHECK_FAILED)
    expect(r?.message).toContain('--terminal')
    expect(existsSync(tokenFile(sb.paths, 'nova'))).toBe(false)
  })

  test('usa o 1º candidato com sonda ok (o juntado falha, o da linha vale)', async () => {
    const sb = withRef()
    // o token encosta no fim da linha e a linha seguinte só tem [A-Za-z0-9_-]: o juntado vem primeiro, mas só o da linha autentica
    fakeOutput(sb, `${URL_LINE}\n${FAKE_TOKEN}\nzzzz\n`)
    expect(extractTokens(`${FAKE_TOKEN}\nzzzz\n`)).toEqual([FAKE_TOKEN + 'zzzz', FAKE_TOKEN])
    // 401 SEM cabeçalhos de uso (a sonda lê os cabeçalhos antes do status)
    const a = await fakeApi((req) => (req.headers.get('authorization') === `Bearer ${FAKE_TOKEN}` ? new Response('{}', { status: 200, headers: H }) : new Response('{}', { status: 401 })))
    api = a
    const r = await login(ctxFor(sb, a), 'nova', { terminal: false })
    expect(r.created).toBe(true)
    expect(readFileSync(tokenFile(sb.paths, 'nova'), 'utf8')).toContain(FAKE_TOKEN)
    expect(readFileSync(tokenFile(sb.paths, 'nova'), 'utf8')).not.toContain('zzzz')
    expect(a.requests).toHaveLength(2)
  })

  test('--terminal: token colado inválido → exit 3, sem gravar, sem chamar claude nem API', async () => {
    const sb = withRef()
    const a = await okApi()
    const pasted = 'isto-nao-e-um-token-' + 'y'.repeat(30)
    const r = await exitOf(login(ctxFor(sb, a), 'nova', { terminal: true, readPasted: async () => pasted }))
    expect(r?.exit).toBe(EXIT.USAGE)
    expect(r?.message).not.toContain(pasted)
    expect(existsSync(tokenFile(sb.paths, 'nova'))).toBe(false)
    expect(sb.calls()).toEqual([])
    expect(a.requests).toHaveLength(0)
  })

  test('--terminal: vazio cancela (exit 3); válido é sondado e salvo sem chamar o claude', async () => {
    const sb = withRef()
    const a = await okApi()
    expect((await exitOf(login(ctxFor(sb, a), 'nova', { terminal: true, readPasted: async () => '  ' })))?.exit).toBe(EXIT.USAGE)
    const r = await login(ctxFor(sb, a), 'nova', { terminal: true, readPasted: async () => ` ${FAKE_TOKEN}\n` })
    expect(r).toEqual({ account: 'nova', created: true })
    expect(sb.calls()).toEqual([])
    expect(statSync(tokenFile(sb.paths, 'nova')).mode & 0o777).toBe(0o600)
  })

  test('nome inválido ou "keychain" → exit 3, claude não chamado', async () => {
    const sb = withRef()
    fakeOutput(sb)
    const ctx = ctxFor(sb, await okApi())
    for (const name of ['keychain', 'Foo', '../x', 'a/b', '', 'x'.repeat(40)]) {
      const r = await exitOf(login(ctx, name, { terminal: false }))
      expect(r?.exit).toBe(EXIT.USAGE)
    }
    expect(sb.calls()).toEqual([])
  })

  test('--attach bk --pool: conta registrada, token 600 e mux.bk.accounts/pool com a conta no fim', async () => {
    const sb = withRef()
    fakeOutput(sb)
    const r = await login(ctxFor(sb, await okApi()), 'nova', { terminal: false, attach: { mux: 'bk', pool: true } })
    expect(r).toEqual({ account: 'nova', created: true, attached: ['accounts', 'pool'] })
    const cfg = await loadConfig(sb.paths)
    expect(cfg.accounts).toHaveProperty('nova')
    expect(cfg.mux.bk!.accounts).toEqual(['ref', 'nova'])
    expect(cfg.mux.bk!.pool).toEqual(['nova'])
    expect(cfg.mux.bk!.account).toBe('ref')
    expect(statSync(tokenFile(sb.paths, 'nova')).mode & 0o777).toBe(0o600)
    expect(readLog(sb)).toContain(' attach')
  })

  test('--attach com mux inexistente (ou sem config) → exit 3 ANTES de qualquer chamada ao claude', async () => {
    const sb = withRef()
    fakeOutput(sb)
    const ctx = ctxFor(sb, await okApi())
    const r = await exitOf(login(ctx, 'nova', { terminal: false, attach: { mux: 'nao-existe' } }))
    expect(r?.exit).toBe(EXIT.USAGE)
    expect(r?.message).toContain('mux inexistente')
    // pool inválido também é recusado antes do navegador
    expect((await exitOf(login(ctx, 'nova', { terminal: false, attach: { mux: 'bk', pool: 0 } })))?.exit).toBe(EXIT.USAGE)
    expect(sb.calls()).toEqual([])

    const bare = sandbox()
    fakeOutput(bare)
    const r2 = await exitOf(login(ctxFor(bare, await okApi()), 'nova', { terminal: false, attach: { mux: 'bk' } }))
    expect(r2?.exit).toBe(EXIT.USAGE)
    expect(bare.calls()).toEqual([])
    expect(existsSync(bare.paths.configFile)).toBe(false)
  })

  test('config inválida → exit 2 antes do claude', async () => {
    const sb = sandbox()
    writeConfig(sb, '{ nao é json')
    fakeOutput(sb)
    const r = await exitOf(login(ctxFor(sb, await okApi()), 'nova', { terminal: false }))
    expect(r?.exit).toBe(EXIT.INVALID_CONFIG)
    expect(sb.calls()).toEqual([])
  })

  test('sonda 401 com --attach → nada registrado nem anexado', async () => {
    const sb = withRef()
    const before = readFileSync(sb.paths.configFile, 'utf8')
    fakeOutput(sb)
    const r = await exitOf(login(ctxFor(sb, await deadApi()), 'nova', { terminal: false, attach: { mux: 'bk', pool: true, preferred: true } }))
    expect(r?.exit).toBe(EXIT.CHECK_FAILED)
    expect(readFileSync(sb.paths.configFile, 'utf8')).toBe(before)
    expect(existsSync(tokenFile(sb.paths, 'nova'))).toBe(false)
  })

  test('o attach falha depois do login → token e registro ficam, exit 3, mensagem manda rodar `sb attach`', async () => {
    const sb = withRef()
    const ctx = ctxFor(sb, await okApi())
    // o mux some entre a validação e o attach (quem edita a config no meio do login)
    const readPasted = async (): Promise<string> => {
      writeConfig(sb, { switchboard: 1, accounts: { ref: {} }, mux: {} })
      return FAKE_TOKEN
    }
    const r = await exitOf(login(ctx, 'nova', { terminal: true, readPasted, attach: { mux: 'bk', pool: true } }))
    expect(r?.exit).toBe(EXIT.USAGE)
    expect(r?.message).toContain('sb attach nova bk --pool')
    expect(r?.message).not.toMatch(/sk-ant-/)
    expect(readFileSync(tokenFile(sb.paths, 'nova'), 'utf8')).toContain(FAKE_TOKEN)
    expect(Object.keys((await loadConfig(sb.paths)).accounts).sort()).toEqual(['nova', 'ref'])
    expect(readLog(sb)).toContain('FIM falhou')
  })
})

describe('sb login / sb attach (CLI, sem TTY → desanexado)', () => {
  const finished = (sb: Sandbox): boolean => /FIM (ok|falhou)/.test(readLog(sb))

  test('sb login: imprime a URL e sai; o fim chega pelo login.log; nada vaza', async () => {
    const sb = withRef()
    fakeOutput(sb)
    const a = await okApi()
    const r = await sb.runSbAsync(['login', 'nova', '--attach', 'bk', '--pool'], { env: { SWITCHBOARD_API_BASE: a.url } })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(URL_LINE)
    expect(r.stdout + r.stderr).not.toMatch(/sk-ant-/)
    await waitFor(() => finished(sb))
    expect(readLog(sb)).toContain('FIM ok')
    const cfg = await loadConfig(sb.paths)
    expect(cfg.mux.bk!.pool).toEqual(['nova']) // o processo desanexado recebeu as mesmas opções de attach
    expect(readLog(sb)).not.toMatch(/sk-ant-/)
    expect(statSync(tokenFile(sb.paths, 'nova')).mode & 0o777).toBe(0o600)
  })

  test('sb login que falha cedo (claude sem token) → exit 1 e a razão na saída', async () => {
    const sb = withRef()
    const a = await okApi()
    const r = await sb.runSbAsync(['login', 'nova'], { env: { SWITCHBOARD_API_BASE: a.url } })
    expect(r.code).toBe(1)
    expect(r.stdout + r.stderr).toContain('--terminal')
    expect(r.stdout + r.stderr).not.toMatch(/sk-ant-/)
  })

  test('`sb attach nova bk`: conta inexistente faz login e anexa; conta existente só anexa (claude não chamado)', async () => {
    const sb = withRef()
    fakeOutput(sb)
    const a = await okApi()
    const r = await sb.runSbAsync(['attach', 'nova', 'bk', '--pool'], { env: { SWITCHBOARD_API_BASE: a.url } })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(URL_LINE)
    await waitFor(() => finished(sb))
    expect(readLog(sb)).toContain('FIM ok')
    const cfg = await loadConfig(sb.paths)
    expect(cfg.mux.bk!.accounts).toEqual(['ref', 'nova'])
    expect(cfg.mux.bk!.pool).toEqual(['nova'])
    expect(sb.calls()).toHaveLength(1)

    // `nova` já existe com token: só anexa (--preferred é só config), sem tocar no claude
    const r2 = await sb.runSbAsync(['attach', 'nova', 'bk', '--preferred'])
    expect(r2.code).toBe(0)
    expect(sb.calls()).toHaveLength(1)
    expect((await loadConfig(sb.paths)).mux.bk!.account).toBe('nova')
  })

  test('`sb attach` de conta registrada mas sem token também passa pelo login', async () => {
    const sb = withRef()
    writeConfig(sb, { ...BASE_CFG, accounts: { ref: {}, semtoken: {} } })
    const a = await okApi()
    const r = await sb.runSbAsync(['attach', 'semtoken', 'bk'], { env: { SWITCHBOARD_API_BASE: a.url } })
    expect(r.code).toBe(1) // claude falso sem token impresso → exit 1; o que importa: o login foi tentado
    expect(sb.calls()).toHaveLength(1)
  })

  test('mux inexistente → exit 3 antes de chamar o claude (login e attach)', async () => {
    const sb = withRef()
    fakeOutput(sb)
    for (const args of [['login', 'nova', '--attach', 'nao-existe'], ['attach', 'nova', 'nao-existe']]) {
      const r = await sb.runSbAsync(args)
      expect(r.code).toBe(3)
      expect(r.stderr).toContain('mux inexistente')
    }
    expect(sb.calls()).toEqual([])
  })

  test('nome inválido, "keychain" e --pool sem --attach → exit 3', async () => {
    const sb = withRef()
    for (const args of [['login', 'Foo'], ['login', 'keychain'], ['login', 'nova', '--pool'], ['login', 'nova', '--at', '2'], ['login', 'nova', '--preferred']]) {
      expect(sb.runSb(args).code).toBe(3)
    }
    expect(sb.calls()).toEqual([])
  })

  test('--terminal pela entrada: vazio cancela (exit 3); colado inválido recusa; nada gravado', () => {
    const sb = withRef()
    const empty = sb.runSb(['login', 'nova', '--terminal'], { input: '' })
    expect(empty.code).toBe(3)
    const bad = sb.runSb(['login', 'nova', '--terminal'], { input: 'nao-e-token\n' })
    expect(bad.code).toBe(3)
    expect(bad.stdout + bad.stderr).not.toContain('nao-e-token')
    expect(existsSync(tokenFile(sb.paths, 'nova'))).toBe(false)
    expect(sb.calls()).toEqual([])
  })

  test('attach --json sem login feito → exit 3 (o desanexado não tem JSON final)', () => {
    const sb = withRef()
    expect(sb.runSb(['attach', 'nova', 'bk', '--json']).code).toBe(3)
    expect(sb.calls()).toEqual([])
  })
})

describe('runLogin (notificação do processo desanexado)', () => {
  const io = (): { isTTY: boolean; write(t: string): void; err(t: string): void } => ({ isTTY: false, write: () => undefined, err: () => undefined })

  test('--foreground sem TTY: ao fim notifica (ok), sem token na mensagem', async () => {
    const sb = withRef()
    fakeOutput(sb)
    const sent: Array<[string, string]> = []
    const ctx = ctxFor(sb, await okApi(), { notify: (t, m) => void sent.push([t, m]) })
    await runLogin(ctx, { account: 'nova', terminal: false, foreground: true }, io())
    expect(sent).toHaveLength(1)
    expect(sent[0]![0]).toContain('nova')
    expect(sent.flat().join(' ')).not.toMatch(/sk-ant-/)
  })

  test('falha: notifica com a dica do --terminal e relança', async () => {
    const sb = withRef()
    const sent: Array<[string, string]> = []
    const ctx = ctxFor(sb, await deadApi(), { notify: (t, m) => void sent.push([t, m]) })
    fakeOutput(sb)
    const r = await exitOf(runLogin(ctx, { account: 'nova', terminal: false, foreground: true }, io()))
    expect(r?.exit).toBe(EXIT.CHECK_FAILED)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.join(' ')).toContain('sb login nova --terminal')
  })
})

test('runLogin: só o attach falhou depois do login → a notificação manda rodar `sb attach`, não o --terminal', async () => {
  const sb = withRef()
  fakeOutput(sb)
  const sent: Array<[string, string]> = []
  const ctx = ctxFor(sb, await okApi(), { notify: (t, m) => void sent.push([t, m]) })
  // o mux some entre o preflight e o attach: o claude falso não dá gancho, então a config é trocada na hora da sonda
  const realFetch = ctx.fetch
  ctx.fetch = async (url, init) => {
    writeConfig(sb, { switchboard: 1, accounts: { ref: {} }, mux: {} })
    return realFetch(url, init)
  }
  const r = await exitOf(runLogin(ctx, { account: 'nova', terminal: false, foreground: true, attach: { mux: 'bk', pool: true } }, { isTTY: false, write: () => undefined, err: () => undefined }))
  expect(r?.exit).toBe(EXIT.USAGE)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.join(' ')).toContain('sb attach nova bk --pool')
  expect(sent[0]!.join(' ')).not.toContain('--terminal')
  expect(sent.flat().join(' ')).not.toMatch(/sk-ant-/)
  expect(readFileSync(tokenFile(sb.paths, 'nova'), 'utf8')).toContain(FAKE_TOKEN) // token e registro ficaram
})

test('populatedSandbox: login de conta nova não toca nos tokens existentes', async () => {
  const sb = populatedSandbox()
  fakeOutput(sb)
  const before = readFileSync(tokenFile(sb.paths, 'gabriel'), 'utf8')
  await login(ctxFor(sb, await okApi()), 'novinha', { terminal: false })
  expect(readFileSync(tokenFile(sb.paths, 'gabriel'), 'utf8')).toBe(before)
})
