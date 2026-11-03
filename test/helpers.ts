import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultCtx, makeLog, type Ctx } from '../src/core/ctx.js'
import { resolvePaths, tokenFile, usageFile, type Paths } from '../src/core/paths.js'

export const FAKE_TOKEN = 'sk-ant-oat01-' + 'x'.repeat(40)

export interface FakeCall {
  argv: string[]
  cwd: string
  hasOauthEnv: boolean
}

export interface Sandbox {
  dir: string
  env: Record<string, string>
  paths: Paths
  ctx(over?: Partial<Ctx>): Ctx
  runSb(args: string[], opts?: { env?: Record<string, string>; cwd?: string; input?: string }): { code: number; stdout: string; stderr: string }
  /** Como `runSb`, mas sem bloquear o event loop: serve quando o teste hospeda um `fakeApi` no mesmo processo. */
  runSbAsync(args: string[], opts?: { env?: Record<string, string>; cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }>
  /** Grava `tokens/<conta>.json` (600) direto, sem passar pelo código sob teste. */
  addToken(account: string, token?: string): void
  calls(): FakeCall[]
}

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const FAKE_CLAUDE = join(import.meta.dir, 'fake-claude.ts')

/**
 * Ambiente isolado: HOME, config, estado e jobs num tmpdir; `claude` falso; API falsa;
 * sem notificação. O env é construído do zero (só PATH vem do processo), então nada do
 * ambiente real — nem CLAUDE_CODE_OAUTH_TOKEN — entra.
 */
export function sandbox(): Sandbox {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sb-test-')))
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    SWITCHBOARD_CONFIG: join(dir, 'config', 'config.jsonc'),
    SWITCHBOARD_STATE_DIR: join(dir, 'state'),
    SWITCHBOARD_JOBS_DIR: join(dir, 'jobs'),
    SWITCHBOARD_CLAUDE: FAKE_CLAUDE,
    // Servidor falso: a Task da sonda sobe um HTTP local e sobrescreve esta porta.
    // Até lá, porta 9 (discard) em loopback: nunca chega a api.anthropic.com.
    SWITCHBOARD_API_BASE: 'http://127.0.0.1:9',
    SWITCHBOARD_NO_NOTIFY: '1',
    FAKE_CLAUDE_DIR: join(dir, 'fake-claude'),
  }
  return {
    dir,
    env,
    paths: resolvePaths(env),
    ctx: (over = {}) => {
      const base = defaultCtx(over.env ?? env) // `over.env` também vale para o `run` (herança de token etc.)
      return {
        ...base,
        log: makeLog(base.paths, over.now ?? base.now), // o relógio injetado vale também para o log
        // sem rede nos testes, mesmo que alguém esqueça de injetar o fetch falso
        fetch: () => Promise.reject(new Error('rede desligada nos testes: injete ctx({ fetch })')),
        ...over,
      }
    },
    runSb(args, opts = {}) {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        env: { ...env, ...opts.env },
        cwd: opts.cwd ?? dir,
        input: opts.input,
        encoding: 'utf8',
      })
      return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    runSbAsync(args, opts = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...opts.env }, cwd: opts.cwd ?? dir, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')))
        child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')))
        child.on('error', reject)
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
      })
    },
    addToken(account, token = FAKE_TOKEN) {
      const file = tokenFile(resolvePaths(env), account)
      mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
      writeFileSync(file, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: token } }), { mode: 0o600 })
      chmodSync(file, 0o600)
    },
    calls() {
      try {
        return readFileSync(join(env.FAKE_CLAUDE_DIR!, 'calls.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as FakeCall)
      } catch {
        return []
      }
    },
  }
}

/** Sandbox com config, tokens (FAKE_TOKEN, 600), usage e jobs. Cresce com as tasks. */
export function populatedSandbox(): Sandbox {
  const sb = sandbox()
  const p = sb.paths
  mkdirSync(join(p.configFile, '..'), { recursive: true })
  writeFileSync(
    p.configFile,
    '{ "switchboard": 1, "accounts": { "gabriel": {}, "admin1": {} }, "default": "bk", "mux": { "bk": { "root": "~/bk", "account": "gabriel", "accounts": ["gabriel", "admin1"], "pool": ["gabriel", "admin1"] } } }\n',
  )
  for (const d of ['', 'tokens', 'mux', 'pins', 'log', 'backup']) mkdirSync(join(p.stateDir, d), { recursive: true, mode: 0o700 })
  for (const a of ['gabriel', 'admin1']) {
    writeFileSync(tokenFile(p, a), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } }), { mode: 0o600 })
    chmodSync(tokenFile(p, a), 0o600)
  }
  // formato real do usage.json (`UsageFile`: latest/previous/groups); medida antiga o bastante para a sonda refazer
  const measured = (five: number, seven: number): Record<string, unknown> => ({
    ok: true,
    fiveHour: { utilization: five, resetsAt: 1_700_010_000, status: 'allowed' },
    sevenDay: { utilization: seven, resetsAt: 1_700_300_000, status: 'allowed' },
    status: 'allowed',
    resetsAt: 1_700_010_000,
    measuredAt: 1_700_000_000_000,
  })
  writeFileSync(
    usageFile(p),
    JSON.stringify({ latest: { gabriel: measured(0.4, 0.1), admin1: measured(0.2, 0.3) }, previous: {}, groups: [] }) + '\n',
  )
  mkdirSync(join(p.jobsDir, 'job1'), { recursive: true })
  writeFileSync(join(p.jobsDir, 'job1', 'state.json'), JSON.stringify({ id: 'job1', status: 'idle', flags: [] }) + '\n')
  return sb
}

/** Todos os arquivos (recursivo) sob `dir`, caminhos absolutos. */
export function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name)
      if (e.isDirectory()) walk(f)
      else out.push(f)
    }
  }
  try {
    walk(dir)
  } catch {
    // diretório inexistente → lista vazia
  }
  return out
}

export interface FakeApi {
  url: string
  stop(): void
  requests: Request[]
}

/** API HTTP falsa em loopback (porta efêmera). Quem sobe, para: `api.stop()`. Nunca toca a rede real. */
export async function fakeApi(handler: (req: Request) => Response | Promise<Response>): Promise<FakeApi> {
  const requests: Request[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      requests.push(req.clone() as unknown as Request)
      return handler(req)
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true), requests }
}
