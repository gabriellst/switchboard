import { expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { filesUnder, FAKE_TOKEN, populatedSandbox } from './helpers.js'

// [args, exit esperado]; cada task que cria comando acrescenta casos. O teste checa vazamento, não sucesso:
// uma recusa por regra (exit 3) também precisa sair limpa.
const CASES: Array<[string[], number]> = [
  [['--version'], 0],
  [[], 0],
  [['usage', '--json'], 0],
  [['accounts', '--json'], 0],
  [['mux'], 0],
  [['which', '--json'], 0],
  [['attach', 'admin1', 'bk', '--pool'], 0], // admin1 já está no pool do bk: idempotente
  [['detach', 'admin1', 'bk'], 0],
  [['accounts', 'rm', 'admin1'], 3], // sem --yes: recusa
]

test.each(CASES)('sem token na saída: sb %p', (args, code) => {
  const sb = populatedSandbox() // config + tokens FAKE_TOKEN + usage + jobs (cresce com as tasks)
  const tokens = filesUnder(sb.paths.stateDir).filter((f) => f.includes('/tokens/'))
  expect(tokens.length).toBeGreaterThan(0) // o cenário tem segredo de verdade; senão o teste seria vazio
  for (const f of tokens) expect(readFileSync(f, 'utf8')).toContain(FAKE_TOKEN)
  const before = new Map(tokens.map((f) => [f, readFileSync(f, 'utf8')]))

  const r = sb.runSb(args)

  expect(r.code).toBe(code)
  expect(r.stdout + r.stderr).not.toMatch(/sk-ant-/)
  // nada fora de tokens/ (estado, config, jobs) pode conter token, antes ou depois do comando
  const outside = [
    ...filesUnder(sb.paths.stateDir).filter((f) => !f.includes('/tokens/')),
    ...filesUnder(sb.paths.jobsDir),
    sb.paths.configFile,
  ]
  expect(outside.length).toBeGreaterThan(1)
  for (const f of outside) expect(readFileSync(f, 'utf8')).not.toMatch(/sk-ant-/)
  // e os tokens continuam intactos e 600
  for (const [f, content] of before) {
    expect(readFileSync(f, 'utf8')).toBe(content)
    expect(statSync(f).mode & 0o777).toBe(0o600)
  }
})

test('sb --version imprime a versão do package.json', () => {
  const sb = populatedSandbox()
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  expect(sb.runSb(['--version']).stdout.trim()).toBe(pkg.version)
})
