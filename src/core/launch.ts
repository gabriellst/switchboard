import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { isatty } from 'node:tty'
import { claudeBin, cleanEnv } from './claude.js'
import { loadConfig, type Config } from './config.js'
import type { Ctx } from './ctx.js'
import { EXIT, SbError } from './errors.js'
import { assertSettingsTarget } from './links.js'
import { resolveMuxForDir } from './mux.js'
import { assertSafeName, muxLink, type Paths } from './paths.js'
import { normalizeRoot } from './schema.js'

export type LaunchOpts =
  | { mux?: string; cwd: string; mode: 'agents'; /** `--cwd` do usuário, já absoluto: a pasta da view (padrão: o root do mux) */ dir?: string }
  | { mux?: string; cwd: string; mode: 'run'; args: string[] }

export interface LaunchPlan {
  mux: string
  argv: string[]
}

/** O `--settings` é do `sb`: um segundo (o do usuário) faria o claude rodar noutra conta, calado. */
const isSettingsFlag = (a: string): boolean => a === '--settings' || a.startsWith('--settings=')

/**
 * Puro: decide o mux e o argv do `claude`, sem tocar o disco. `agents` → `agents --cwd <root> --settings <link>`
 * (com `dir`, `--cwd <dir>`: uma aba por projeto dentro do mesmo mux).
 * `run` → `<args> --settings <link>`, com o `--settings` ANTES do primeiro `--` solto de `args` (depois dele tudo é
 * posicional para o claude: `-p -- texto --settings x` rodaria SEM o settings, no keychain, calado); sem `--` em
 * `args` vai no fim. Não vai na frente: com `enablePositionalOptions` uma opção da raiz não alcança subcomando.
 * `--settings`/`--settings=` do usuário só são recusados ANTES desse `--` (depois é texto dele; `--settings-file` passa).
 * Resíduo conhecido: uma flag com valor no fim de `args` (`--model` sem valor) engole o `--settings` (erro de digitação).
 * Sem nome deduz o mux pela pasta (root mais profundo, senão `default`).
 */
export function launchArgs(cfg: Config, paths: Paths, o: LaunchOpts): LaunchPlan {
  if (o.mux !== undefined) assertSafeName(o.mux)
  const split = o.mode === 'run' ? o.args.indexOf('--') : -1
  if (o.mode === 'run' && (split === -1 ? o.args : o.args.slice(0, split)).some(isSettingsFlag)) {
    throw new SbError('`--settings` não pode vir nos argumentos: o `sb` já passa o settings do mux', EXIT.USAGE, '  para outra conta, escolha outro mux (`sb run <mux> -- …`)')
  }
  const dir = o.mode === 'agents' ? o.dir : undefined
  // com `--cwd`, quem decide o mux é a pasta do --cwd (não a pasta atual); com nome, os dois têm de concordar:
  // as sessões dessa pasta são do mux dono dela (`sb which`), e uma view com o settings de outro as poria noutra conta
  const owner = dir !== undefined ? resolveMuxForDir(cfg, dir, paths.home) : undefined
  if (owner !== undefined && o.mux !== undefined && owner !== o.mux) {
    throw new SbError(`a pasta ${dir} é do mux "${owner}", não de "${o.mux}"`, EXIT.USAGE, `  rode \`sb agents ${owner} --cwd ${dir}\` (ou sem o nome do mux)`)
  }
  const mux = o.mux ?? owner ?? resolveMuxForDir(cfg, o.cwd, paths.home)
  const m = cfg.mux[mux]
  if (!m) throw new SbError(`mux inexistente: "${mux}"`, EXIT.USAGE, `  muxes: ${Object.keys(cfg.mux).join(', ') || 'nenhum'}`)
  const link = muxLink(paths, mux)
  if (o.mode === 'agents') return { mux, argv: ['agents', '--cwd', dir ?? normalizeRoot(m.root, paths.home), '--settings', link] }
  const at = split === -1 ? o.args.length : split
  return { mux, argv: [...o.args.slice(0, at), '--settings', link, ...o.args.slice(at)] }
}

/** F6: o link do mux tem que levar a um token utilizável; senão o `claude` ignoraria o settings (ou a conta seria outra). */
export function preflight(paths: Paths, mux: string): void {
  assertSettingsTarget(muxLink(paths, mux), mux)
}

export interface LaunchHooks {
  /** costura de teste: acontece entre a 1ª checagem e a 2ª (o `watch` trocando o link, ou alguém quebrando o token) */
  afterPreflight?: () => void
  /** costura de teste: força a resposta de "o stdin é um terminal?" (padrão: `isatty(0)`) */
  stdinIsTty?: boolean
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
  // lido UMA vez e sem tocar `process.stdin`: no node, acessá-lo põe O_NONBLOCK no pipe de stdin que o filho compartilha
  const ttyIn = hooks.stdinIsTty ?? isatty(0)
  return new Promise<LaunchResult>((resolve, reject) => {
    const child = spawn(bin, plan.argv, { stdio: 'inherit', env: cleanEnv(ctx.env) })
    const handlers = FORWARDED.map((sig) => {
      const handler = (): void => {
        // num terminal o Ctrl+C já chega ao filho (mesmo grupo de processos): repassar de novo seria um 2º Ctrl+C.
        // Consequência: com terminal, `kill -INT <pid do sb>` de outro shell não faz nada (use SIGTERM).
        if (sig === 'SIGINT' && ttyIn) return
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

/** Sinais que podem ser reenviados a si mesmo sem efeito colateral. SIGUSR1 (inspetor do node) e afins ficam de fora. */
const RERAISE = new Set<NodeJS.Signals>(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGKILL'])

/**
 * O `sb` sai como o `claude` saiu: mesmo código, ou o mesmo sinal (reenviado a si mesmo, já sem os handlers) quando
 * está na lista segura; qualquer outro sinal vira `exit(128+n)` direto.
 */
export function exitLike(r: LaunchResult): void {
  if ('code' in r) {
    process.exitCode = r.code
    return
  }
  const code = 128 + (constants.signals[r.signal] ?? 0)
  if (!RERAISE.has(r.signal)) process.exit(code)
  process.kill(process.pid, r.signal)
  // se o sinal não matar (handler alheio, plataforma): sai com a convenção 128+n
  setTimeout(() => process.exit(code), 200)
}
