#!/usr/bin/env bun
// `claude` falso para os testes (SWITCHBOARD_CLAUDE). Estado em FAKE_CLAUDE_DIR:
//   calls.jsonl      — uma linha por chamada: {"argv":[…],"cwd":…,"hasOauthEnv":bool}
//   setup-token.txt  — (opcional) o que `setup-token` imprime
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
appendFileSync(
  join(dir, 'calls.jsonl'),
  JSON.stringify({ argv, cwd: process.cwd(), hasOauthEnv: 'CLAUDE_CODE_OAUTH_TOKEN' in process.env }) + '\n',
)

if (argv[0] === 'setup-token') {
  const f = join(dir, 'setup-token.txt')
  if (existsSync(f)) process.stdout.write(readFileSync(f, 'utf8'))
}
process.exit(0)
