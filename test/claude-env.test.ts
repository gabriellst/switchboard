import { expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeBin, cleanEnv, SESSION_VARS } from '../src/core/claude.js'
import { FAKE_TOKEN, sandbox } from './helpers.js'

test('cleanEnv tira as 12 variáveis F10 e mantém o resto', () => {
  const env = Object.fromEntries([...SESSION_VARS, 'PATH'].map((k) => [k, '1']))
  expect(Object.keys(cleanEnv(env))).toEqual(['PATH'])
  expect(SESSION_VARS).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  expect(SESSION_VARS).toHaveLength(12)
})

test('cleanEnv ignora valores undefined e não altera o original', () => {
  const env = { PATH: '/bin', CLAUDECODE: '1', GONE: undefined }
  expect(cleanEnv(env)).toEqual({ PATH: '/bin' })
  expect(env.CLAUDECODE).toBe('1')
})

test('claudeBin: SWITCHBOARD_CLAUDE ou "claude" do PATH', () => {
  expect(claudeBin({ SWITCHBOARD_CLAUDE: '/t/fake' })).toBe('/t/fake')
  expect(claudeBin({})).toBe('claude')
  expect(claudeBin({ SWITCHBOARD_CLAUDE: '' })).toBe('claude')
})

test('claude falso: registra a chamada e diz se o token herdado vazou', () => {
  const sb = sandbox()
  const claude = claudeBin(sb.env)
  expect(existsSync(claude)).toBe(true)
  const ctx = sb.ctx()
  // ctx.run sem env explícito não repassa CLAUDE_CODE_OAUTH_TOKEN herdado
  const dirty = { ...sb.env, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }
  const inherited = sb.ctx({ env: dirty })
  expect(dirty.CLAUDE_CODE_OAUTH_TOKEN).toBe(FAKE_TOKEN) // o ambiente herdado TEM o token
  expect(inherited.run(claude, ['agents', '--json'], { cwd: sb.dir }).status).toBe(0)
  expect(ctx.run(claude, ['--version']).status).toBe(0)
  // env explícito é respeitado (é assim que um chamador injeta o token de uma conta)
  ctx.run(claude, ['x'], { env: { ...cleanEnv(sb.env), CLAUDE_CODE_OAUTH_TOKEN: 'explicit' } })
  const calls = sb.calls()
  expect(calls.map((c) => c.argv)).toEqual([['agents', '--json'], ['--version'], ['x']])
  expect(calls.map((c) => c.hasOauthEnv)).toEqual([false, false, true])
  expect(calls[0]!.cwd).toBe(sb.dir)
})

test('claude falso: setup-token imprime setup-token.txt', () => {
  const sb = sandbox()
  const r = sb.ctx().run(claudeBin(sb.env), ['setup-token'])
  expect(r.status).toBe(0)
  expect(r.stdout).toBe('')
  writeFileSync(join(sb.dir, 'fake-claude', 'setup-token.txt'), `link\n${FAKE_TOKEN}\n`)
  const r2 = sb.ctx().run(claudeBin(sb.env), ['setup-token'])
  expect(r2.stdout).toBe(`link\n${FAKE_TOKEN}\n`)
})
