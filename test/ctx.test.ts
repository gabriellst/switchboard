import { expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { defaultCtx } from '../src/core/ctx.js'
import { logFile } from '../src/core/paths.js'
import { FAKE_TOKEN, sandbox } from './helpers.js'

test('log acrescenta "ISO linha" e troca tokens por <token>', () => {
  const sb = sandbox()
  const ctx = sb.ctx({ now: () => Date.UTC(2026, 10, 3, 12, 0, 0) })
  ctx.log('watch', `swap com ${FAKE_TOKEN} e sk-ant-api03-AbC_d-1`)
  ctx.log('watch', 'segunda')
  const text = readFileSync(logFile(sb.paths, 'watch'), 'utf8')
  expect(text).toBe('2026-11-03T12:00:00.000Z swap com <token> e <token>\n2026-11-03T12:00:00.000Z segunda\n')
  expect(text).not.toMatch(/sk-ant-/)
  expect(statSync(logFile(sb.paths, 'watch')).mode & 0o777).toBe(0o600)
})

test('defaultCtx lê os paths do env e usa o relógio real', () => {
  const sb = sandbox()
  const ctx = defaultCtx(sb.env)
  expect(ctx.paths).toEqual(sb.paths)
  expect(Math.abs(ctx.now() - Date.now())).toBeLessThan(1000)
})

test('notify é no-op com SWITCHBOARD_NO_NOTIFY (nenhum osascript)', () => {
  const sb = sandbox()
  expect(sb.env.SWITCHBOARD_NO_NOTIFY).toBe('1')
  expect(() => defaultCtx(sb.env).notify('t', 'm')).not.toThrow()
})

test('run captura status/stdout/stderr e não repassa token herdado por padrão', () => {
  const sb = sandbox()
  const ctx = defaultCtx({ ...sb.env, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, CLAUDECODE: '1' })
  const r = ctx.run('sh', ['-c', 'echo "[$CLAUDE_CODE_OAUTH_TOKEN|$CLAUDECODE|$SWITCHBOARD_NO_NOTIFY]"; echo err >&2; exit 3'])
  expect(r).toEqual({ status: 3, stdout: '[||1]\n', stderr: 'err\n' })
  expect(ctx.run('definitely-not-a-binary-xyz', []).status).toBeNull()
})

test('fetch real libera o corpo da resposta (sondas repetidas do watch não acumulam conexões)', async () => {
  let cancelled = false
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      // corpo que nunca termina: só acaba se o cliente o descartar
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('x'))
        },
        cancel() {
          cancelled = true
        },
      })
      return new Response(body, { status: 429, headers: { 'x-probe': 'sim' } })
    },
  })
  try {
    const ctx = defaultCtx(sandbox().env)
    const res = await ctx.fetch(`http://127.0.0.1:${server.port}/`, { method: 'POST', headers: {}, body: '{}' })
    expect(res.status).toBe(429)
    expect(res.headers.get('x-probe')).toBe('sim') // cabeçalhos continuam legíveis depois de liberar o corpo
    const deadline = Date.now() + 3000
    while (!cancelled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    expect(cancelled).toBe(true)
  } finally {
    void server.stop(true)
  }
})
