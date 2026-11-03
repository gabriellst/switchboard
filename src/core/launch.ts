import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { claudeBin, cleanEnv } from './claude.js'
import { loadConfig, type Config } from './config.js'
import type { Ctx } from './ctx.js'
import { EXIT, SbError } from './errors.js'
import { assertSettingsTarget } from './links.js'
import { resolveMuxForDir } from './mux.js'
import { assertSafeName, muxLink, type Paths } from './paths.js'
import { normalizeRoot } from './schema.js'

export type LaunchOpts =
  | { mux?: string; cwd: string; mode: 'agents' }
  | { mux?: string; cwd: string; mode: 'run'; args: string[] }

export interface LaunchPlan {
  mux: string
  argv: string[]
}

/** O `--settings` é do `sb`: um segundo (o do usuário) faria o claude rodar noutra conta, calado. */
const isSettingsFlag = (a: string): boolean => a === '--settings' || a.startsWith('--settings=')

/**
 * Puro: decide o mux e o argv do `claude`, sem tocar o disco. `agents` → `agents --cwd <root> --settings <link>`;
 * `run` → `<args> --settings <link>`. Sem nome deduz pela pasta (root mais profundo, senão `default`).
 */
export function launchArgs(cfg: Config, paths: Paths, o: LaunchOpts): LaunchPlan {
  if (o.mux !== undefined) assertSafeName(o.mux)
  if (o.mode === 'run' && o.args.some(isSettingsFlag)) {
    throw new SbError('`--settings` não pode vir nos argumentos: o `sb` já passa o settings do mux', EXIT.USAGE, '  para outra conta, escolha outro mux (`sb run <mux> -- …`)')
  }
  const mux = o.mux ?? resolveMuxForDir(cfg, o.cwd, paths.home)
  const m = cfg.mux[mux]
  if (!m) throw new SbError(`mux inexistente: "${mux}"`, EXIT.USAGE, `  muxes: ${Object.keys(cfg.mux).join(', ') || 'nenhum'}`)
  const link = muxLink(paths, mux)
  return {
    mux,
    argv: o.mode === 'agents' ? ['agents', '--cwd', normalizeRoot(m.root, paths.home), '--settings', link] : [...o.args, '--settings', link],
  }
}

/** F6: o link do mux tem que levar a um token utilizável; senão o `claude` ignoraria o settings (ou a conta seria outra). */
export function preflight(paths: Paths, mux: string): void {
  assertSettingsTarget(muxLink(paths, mux), mux)
}

export interface LaunchHooks {
  /** costura de teste: acontece entre a 1ª checagem e a 2ª (o `watch` trocando o link, ou alguém quebrando o token) */
  afterPreflight?: () => void
}

export type LaunchResult = { code: number } | { signal: NodeJS.Signals }

const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/**
 * Checa o link (F6), checa DE NOVO logo antes do spawn (nada em cache) e roda o `claude` com stdio herdado e sem
 * as variáveis F10 (nunca um `CLAUDE_CODE_OAUTH_TOKEN` herdado). SIGINT/SIGTERM/SIGHUP no `sb` são repassados ao
 * filho; o resultado é o código ou o sinal dele. `claude` ausente → exit 4.
 */
export async function runClaude(ctx: Ctx, plan: LaunchPlan, hooks: LaunchHooks = {}): Promise<LaunchResult> {
  preflight(ctx.paths, plan.mux)
  hooks.afterPreflight?.()
  preflight(ctx.paths, plan.mux)

  const bin = claudeBin(ctx.env)
  return new Promise<LaunchResult>((resolve, reject) => {
    const child = spawn(bin, plan.argv, { stdio: 'inherit', env: cleanEnv(ctx.env) })
    const handlers = FORWARDED.map((sig) => {
      const handler = (): void => {
        // num terminal o Ctrl+C já chega ao filho (mesmo grupo de processos): repassar de novo seria um 2º Ctrl+C
        if (sig === 'SIGINT' && process.stdin.isTTY) return
        child.kill(sig)
      }
      process.on(sig, handler)
      return [sig, handler] as const
    })
    const done = (): void => {
      for (const [sig, handler] of handlers) process.off(sig, handler)
    }
    child.once('error', (e: NodeJS.ErrnoException) => {
      done()
      const why = e.code === 'ENOENT' ? `\`${bin}\` não foi encontrado` : e.message
      reject(new SbError(`não consegui abrir o claude: ${why}`, EXIT.CLAUDE, '  instale o Claude Code ou defina SWITCHBOARD_CLAUDE'))
    })
    child.once('exit', (code, signal) => {
      done()
      resolve(signal ? { signal } : { code: code ?? EXIT.CLAUDE })
    })
  })
}

/** Nome (se veio) vira argumento seguro antes de qualquer leitura; depois config → plano → `runClaude`. */
export async function launch(ctx: Ctx, o: LaunchOpts, hooks?: LaunchHooks): Promise<LaunchResult> {
  if (o.mux !== undefined) assertSafeName(o.mux)
  const cfg = await loadConfig(ctx.paths)
  return runClaude(ctx, launchArgs(cfg, ctx.paths, o), hooks)
}

/** O `sb` sai como o `claude` saiu: mesmo código, ou o mesmo sinal (reenviado a si mesmo, já sem os handlers). */
export function exitLike(r: LaunchResult): void {
  if ('code' in r) {
    process.exitCode = r.code
    return
  }
  process.kill(process.pid, r.signal)
  // se o sinal não matar (handler alheio, plataforma): sai com a convenção 128+n
  setTimeout(() => process.exit(128 + (constants.signals[r.signal] ?? 0)), 200)
}
