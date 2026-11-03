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

export const tokenFile = (p: Paths, account: string): string => join(p.stateDir, 'tokens', `${account}.json`)
export const muxLink = (p: Paths, mux: string): string => join(p.stateDir, 'mux', `${mux}.json`)
export const pinLink = (p: Paths, account: string): string => join(p.stateDir, 'pins', `${account}.json`)
export const usageFile = (p: Paths): string => join(p.stateDir, 'usage.json')
export const runtimeFile = (p: Paths): string => join(p.stateDir, 'runtime.json')
export const lockFile = (p: Paths): string => join(p.stateDir, 'lock')
export const logFile = (p: Paths, which: 'watch' | 'login'): string => join(p.stateDir, 'log', `${which}.log`)
export const backupDir = (p: Paths, stamp: string): string => join(p.stateDir, 'backup', stamp)
