import { join } from 'node:path'
import { EXIT, SbError } from './errors.js'

export interface Paths {
  home: string
  configFile: string
  stateDir: string
  jobsDir: string
  claudeDir: string
  launchAgentsDir: string
  zshrc: string
}

type Env = Record<string, string | undefined>

/** Tudo parte de `env` (nunca de `os.homedir()`): é o que isola os testes. */
export function resolvePaths(env: Env): Paths {
  const home = env.HOME
  if (!home) throw new SbError('HOME não está definido', EXIT.USAGE)
  const claudeDir = join(home, '.claude')
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, '.config')
  const xdgState = env.XDG_STATE_HOME || join(home, '.local', 'state')
  return {
    home,
    configFile: env.SWITCHBOARD_CONFIG || join(xdgConfig, 'switchboard', 'config.jsonc'),
    stateDir: env.SWITCHBOARD_STATE_DIR || join(xdgState, 'switchboard'),
    jobsDir: env.SWITCHBOARD_JOBS_DIR || join(claudeDir, 'jobs'),
    claudeDir,
    launchAgentsDir: join(home, 'Library', 'LaunchAgents'),
    zshrc: join(home, '.zshrc'),
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

/**
 * Defesa em profundidade: nome de conta/mux vira nome de arquivo, então `../x` ou `a/b` não pode
 * chegar ao `join`. A config e a CLI já validam; aqui é a última barreira (`keychain` é um nome válido).
 */
export function assertSafeName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new SbError(`nome inválido: ${JSON.stringify(name)} — use minúsculas, números, - e _ (até 32, começando por letra ou número)`, EXIT.USAGE)
  }
  return name
}

export const tokenFile = (p: Paths, account: string): string => join(p.stateDir, 'tokens', `${assertSafeName(account)}.json`)
export const muxLink = (p: Paths, mux: string): string => join(p.stateDir, 'mux', `${assertSafeName(mux)}.json`)
export const pinLink = (p: Paths, account: string): string => join(p.stateDir, 'pins', `${assertSafeName(account)}.json`)
export const usageFile = (p: Paths): string => join(p.stateDir, 'usage.json')
export const runtimeFile = (p: Paths): string => join(p.stateDir, 'runtime.json')
export const lockFile = (p: Paths): string => join(p.stateDir, 'lock')
/** batimento do `sb watch` (`{ pid, lastTick }`): quem enfileira um pedido confere se o laço está vivo. */
export const watchFile = (p: Paths): string => join(p.stateDir, 'watch.json')
export const logFile = (p: Paths, which: 'watch' | 'login'): string => join(p.stateDir, 'log', `${which}.log`)
export const backupDir = (p: Paths, stamp: string): string => join(p.stateDir, 'backup', stamp)
/** pid do login em andamento (PTY): impede dois `setup-token` ao mesmo tempo. */
export const loginLockFile = (p: Paths): string => join(p.stateDir, 'log', 'login.pid')
