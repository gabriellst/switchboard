import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { cleanEnv } from './claude.js'
import { logFile, resolvePaths, type Paths } from './paths.js'

export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; headers: { get(n: string): string | null } }>

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
) => { status: number | null; stdout: string; stderr: string }

export interface Ctx {
  paths: Paths
  env: Record<string, string | undefined>
  /** ms desde a época */
  now(): number
  fetch: FetchLike
  run: Runner
  notify(title: string, msg: string): void
  log(file: 'watch' | 'login', line: string): void
}

const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]+/g
const redact = (s: string): string => s.replace(TOKEN_RE, '<token>')

/** Acrescenta `ISO linha` (token redigido) em `log/<file>.log`. Recebe `now` para os testes controlarem o relógio. */
export function makeLog(paths: Paths, now: () => number): Ctx['log'] {
  return (file, line) => {
    const f = logFile(paths, file)
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 })
    appendFileSync(f, `${new Date(now()).toISOString()} ${redact(line)}\n`, { mode: 0o600 })
  }
}

export function defaultCtx(env: Record<string, string | undefined> = process.env): Ctx {
  const paths = resolvePaths(env)
  const now = () => Date.now()
  // Sem `opts.env`, o filho recebe o ambiente do Ctx SEM as variáveis F10:
  // nunca repassamos um CLAUDE_CODE_OAUTH_TOKEN herdado. Quem precisa de um token
  // passa `env` explícito.
  const run: Runner = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? cleanEnv(env),
      timeout: opts.timeoutMs,
      encoding: 'utf8',
    })
    // binário inexistente / timeout: status null e o motivo em stderr
    return { status: r.status ?? null, stdout: r.stdout ?? '', stderr: r.stderr || r.error?.message || '' }
  }
  return {
    paths,
    env,
    now,
    // A sonda só lê status e cabeçalhos: o corpo é descartado na hora, senão cada sonda do `watch`
    // deixa uma conexão/stream pendurado até o GC.
    fetch: async (url, init) => {
      const res = await globalThis.fetch(url, init)
      await res.body?.cancel().catch(() => undefined)
      return { status: res.status, headers: res.headers }
    },
    run,
    notify(title, msg) {
      if (env.SWITCHBOARD_NO_NOTIFY) return
      const q = (s: string) => `"${redact(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      run('osascript', ['-e', `display notification ${q(msg)} with title ${q(title)}`], { env: cleanEnv(env), timeoutMs: 5000 })
    },
    log: makeLog(paths, now),
  }
}
