#!/usr/bin/env bun
// `claude` falso para os testes (SWITCHBOARD_CLAUDE). Estado em FAKE_CLAUDE_DIR:
//   calls.jsonl            — uma linha por chamada: argv, cwd, hasOauthEnv, configDir (CLAUDE_CONFIG_DIR), onboarding
//                            (o `.claude.json` que o diretório tinha no momento da chamada), term, cols, pid.
//                            NUNCA grava valor de token (só se a variável existe).
//   setup-token.txt        — (opcional) o que `setup-token` imprime
//   setup-token.wait-enter — (opcional) `setup-token` só imprime depois de receber uma linha na entrada
//   setup-token.sleep      — (opcional) milissegundos que `setup-token` dorme antes de sair (simula travar)
//   setup-token.exit       — (opcional) código de saída de `setup-token`
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
  const text = opt('setup-token.txt')
  if (text !== null) process.stdout.write(text)
  const sleepMs = Number(opt('setup-token.sleep') ?? 0)
  if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs))
  process.exit(Number(opt('setup-token.exit') ?? 0))
}
process.exit(0)
