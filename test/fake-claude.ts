#!/usr/bin/env bun
// `claude` falso para os testes (SWITCHBOARD_CLAUDE). Estado em FAKE_CLAUDE_DIR:
//   calls.jsonl            — uma linha por chamada: argv, cwd, hasOauthEnv, configDir (CLAUDE_CONFIG_DIR), onboarding
//                            (o `.claude.json` que o diretório tinha no momento da chamada), term, cols, pid.
//                            NUNCA grava valor de token (só se a variável existe).
//   setup-token.txt        — (opcional) o que `setup-token` imprime
//   setup-token.wait-enter — (opcional) `setup-token` só imprime depois de receber uma linha na entrada
//   setup-token.sleep      — (opcional) milissegundos que `setup-token` dorme antes de sair (simula travar)
//   setup-token.exit       — (opcional) código de saída de `setup-token`
//   setup-token.chunks     — (opcional) JSON com uma lista de textos: cada um é uma escrita, com 300 ms entre elas
//                            (no lugar de setup-token.txt; serve para cortar a URL entre duas escritas)
//   setup-token.hang-ignore-hup — (opcional) ignora SIGHUP/SIGTERM, grava o próprio pid e o de um `sleep` filho
//                            em pids.txt e fica preso (no máximo 40 s: nunca sobra processo para sempre)
// `agents`/`stop` entram na Task 14.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.FAKE_CLAUDE_DIR
if (!dir) {
  console.error('fake-claude: FAKE_CLAUDE_DIR não definido')
  process.exit(99)
}
mkdirSync(dir, { recursive: true })
const argv = process.argv.slice(2)
const configDir = process.env.CLAUDE_CONFIG_DIR
let onboarding: unknown = null
try {
  if (configDir) onboarding = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8'))
} catch {
  // sem .claude.json
}
appendFileSync(
  join(dir, 'calls.jsonl'),
  JSON.stringify({
    argv,
    cwd: process.cwd(),
    hasOauthEnv: 'CLAUDE_CODE_OAUTH_TOKEN' in process.env,
    configDir: configDir ?? null,
    onboarding,
    term: process.env.TERM ?? null,
    cols: process.stdout.columns ?? null,
    pid: process.pid,
  }) + '\n',
)

const opt = (name: string): string | null => {
  const f = join(dir, name)
  return existsSync(f) ? readFileSync(f, 'utf8') : null
}

if (argv[0] === 'setup-token') {
  if (opt('setup-token.wait-enter') !== null) {
    await new Promise<void>((resolve) => {
      process.stdin.once('data', () => resolve())
      process.stdin.resume()
    })
  }
  if (opt('setup-token.hang-ignore-hup') !== null) {
    process.on('SIGHUP', () => undefined)
    process.on('SIGTERM', () => undefined)
    const child = Bun.spawn(['sleep', '40'], { stdio: ['ignore', 'ignore', 'ignore'] })
    appendFileSync(join(dir, 'pids.txt'), `${process.pid}\n${child.pid}\n`)
    await new Promise((r) => setTimeout(r, 40_000))
    process.exit(0)
  }
  const chunks = opt('setup-token.chunks')
  if (chunks !== null) {
    const list = JSON.parse(chunks) as string[]
    for (const [i, c] of list.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, 300))
      process.stdout.write(c)
    }
  }
  const text = opt('setup-token.txt')
  if (text !== null) process.stdout.write(text)
  const sleepMs = Number(opt('setup-token.sleep') ?? 0)
  if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs))
  process.exit(Number(opt('setup-token.exit') ?? 0))
}
process.exit(0)
