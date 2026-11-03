import { expect, test } from 'bun:test'
import { backupDir, lockFile, logFile, muxLink, pinLink, resolvePaths, runtimeFile, tokenFile, usageFile } from '../src/core/paths.js'

test('padrões a partir do HOME', () => {
  const p = resolvePaths({ HOME: '/h' })
  expect(p.home).toBe('/h')
  expect(p.configFile).toBe('/h/.config/switchboard/config.jsonc')
  expect(p.stateDir).toBe('/h/.local/state/switchboard')
  expect(p.jobsDir).toBe('/h/.claude/jobs')
  expect(p.claudeDir).toBe('/h/.claude')
  expect(p.launchAgentsDir).toBe('/h/Library/LaunchAgents')
  expect(p.zshrc).toBe('/h/.zshrc')
})

test('overrides SWITCHBOARD_* e XDG', () => {
  expect(resolvePaths({ HOME: '/h', XDG_STATE_HOME: '/s' }).stateDir).toBe('/s/switchboard')
  expect(resolvePaths({ HOME: '/h', SWITCHBOARD_STATE_DIR: '/x' }).stateDir).toBe('/x')
  expect(resolvePaths({ HOME: '/h', XDG_CONFIG_HOME: '/c' }).configFile).toBe('/c/switchboard/config.jsonc')
  expect(resolvePaths({ HOME: '/h', SWITCHBOARD_CONFIG: '/y/cfg.jsonc' }).configFile).toBe('/y/cfg.jsonc')
  expect(resolvePaths({ HOME: '/h', SWITCHBOARD_JOBS_DIR: '/j' }).jobsDir).toBe('/j')
})

test('SWITCHBOARD_* vence XDG; claudeDir e jobsDir não seguem o override do estado', () => {
  const p = resolvePaths({ HOME: '/h', XDG_STATE_HOME: '/s', SWITCHBOARD_STATE_DIR: '/x', SWITCHBOARD_JOBS_DIR: '/j' })
  expect(p.stateDir).toBe('/x')
  expect(p.claudeDir).toBe('/h/.claude')
})

test('sem HOME é erro claro (não cai em "undefined/…")', () => {
  expect(() => resolvePaths({})).toThrow(/HOME/)
})

test('caminhos derivados do estado', () => {
  const p = resolvePaths({ HOME: '/h', SWITCHBOARD_STATE_DIR: '/st' })
  expect(tokenFile(p, 'gabriel')).toBe('/st/tokens/gabriel.json')
  expect(muxLink(p, 'bk')).toBe('/st/mux/bk.json')
  expect(pinLink(p, 'admin1')).toBe('/st/pins/admin1.json')
  expect(usageFile(p)).toBe('/st/usage.json')
  expect(runtimeFile(p)).toBe('/st/runtime.json')
  expect(lockFile(p)).toBe('/st/lock')
  expect(logFile(p, 'watch')).toBe('/st/log/watch.log')
  expect(logFile(p, 'login')).toBe('/st/log/login.log')
  expect(backupDir(p, '20261103-101500')).toBe('/st/backup/20261103-101500')
})
