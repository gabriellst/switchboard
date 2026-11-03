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
//   setup-token.spawn-on-term — (opcional) ignora SIGHUP; ao receber SIGTERM nasce um `sleep` filho (pid em pids.txt) e
//                            o fake fica preso (no máximo 40 s)
//   setup-token.hang-ignore-hup — (opcional) ignora SIGHUP/SIGTERM, grava o próprio pid e o de um `sleep` filho
//                            em pids.txt e fica preso (no máximo 40 s: nunca sobra processo para sempre)
//   agents.json            — o que `agents [--json] [--all]` imprime (ausente: `[]`)
//   stop-fail              — (opcional) `stop <id>` falha (exit 1, mensagem em stderr)
//   stop-stuck             — (opcional) `stop <id>` sai 0 mas o `pid` nunca some (sessão que não para)
//   stop-lag               — (opcional) número N: o `pid` só some na N-ésima chamada de `agents` depois do `stop`
//   stop.json              — estado do atraso (`{ id, polls }`), gerado pelo próprio fake
// `stop <id>` tira `pid`/`status` da entrada de agents.json e põe `state: 'stopped'`; id desconhecido → exit 1.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  if (opt('setup-token.spawn-on-term') !== null) {
    process.on('SIGHUP', () => undefined)
    process.on('SIGTERM', () => {
      const child = Bun.spawn(['sleep', '40'], { stdio: ['ignore', 'ignore', 'ignore'] })
      appendFileSync(join(dir, 'pids.txt'), `${child.pid}\n`)
    })
    appendFileSync(join(dir, 'pids.txt'), `${process.pid}\n`)
    await new Promise((r) => setTimeout(r, 40_000))
    process.exit(0)
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
const readAgents = (): Record<string, unknown>[] => {
  const text = opt('agents.json')
  return text === null ? [] : (JSON.parse(text) as Record<string, unknown>[])
}
const stopEntry = (id: string): boolean => {
  const list = readAgents()
  const entry = list.find((a) => a.id === id)
  if (!entry) return false
  delete entry.pid
  delete entry.status
  entry.state = 'stopped'
  writeFileSync(join(dir, 'agents.json'), JSON.stringify(list, null, 2) + '\n')
  return true
}

if (argv[0] === 'agents') {
  const pending = opt('stop.json')
  if (pending !== null) {
    const p = JSON.parse(pending) as { id: string; polls: number }
    if (p.polls <= 0) {
      stopEntry(p.id)
      rmSync(join(dir, 'stop.json'))
    } else writeFileSync(join(dir, 'stop.json'), JSON.stringify({ ...p, polls: p.polls - 1 }))
  }
  process.stdout.write(opt('agents.json') ?? '[]\n')
  process.exit(0)
}
if (argv[0] === 'stop') {
  const id = argv[1] ?? ''
  if (opt('stop-fail') !== null) {
    console.error(`fake-claude: stop ${id} falhou (stop-fail)`)
    process.exit(1)
  }
  if (!readAgents().some((a) => a.id === id)) {
    console.error(`fake-claude: sessão desconhecida: ${id}`)
    process.exit(1)
  }
  if (opt('stop-stuck') !== null) process.exit(0)
  const lag = Number(opt('stop-lag') ?? 0)
  if (lag > 0) writeFileSync(join(dir, 'stop.json'), JSON.stringify({ id, polls: lag - 1 }))
  else stopEntry(id)
  process.exit(0)
}
process.exit(0)
