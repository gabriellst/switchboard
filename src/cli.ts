#!/usr/bin/env node
import { defineCommand, runCommand, runMain } from 'citty'
import { usageArgs } from './commands/args.js'
import { EXIT, SbError } from './core/errors.js'

const main = defineCommand({
  meta: { name: 'sb', version: '0.1.0', description: 'Contas do Claude Code por pasta, com troca automática ao bater o limite' },
  // `sb` sem subcomando = `sb usage`; os args do usage ficam aqui também para o citty saber que
  // `--every 30` leva valor (senão tomaria o "30" por nome de subcomando).
  args: usageArgs,
  default: 'usage',
  // Subcomandos carregados sob demanda
  subCommands: {
    usage: () => import('./commands/usage.js').then((m) => m.default),
    accounts: () => import('./commands/accounts.js').then((m) => m.default),
    mux: () => import('./commands/mux.js').then((m) => m.default),
    login: () => import('./commands/login.js').then((m) => m.default),
    attach: () => import('./commands/attach.js').then((m) => m.default),
    detach: () => import('./commands/detach.js').then((m) => m.default),
    which: () => import('./commands/which.js').then((m) => m.default),
    agents: () => import('./commands/agents.js').then((m) => m.default),
    run: () => import('./commands/run.js').then((m) => m.default),
    swap: () => import('./commands/swap.js').then((m) => m.default),
    pin: () => import('./commands/pin.js').then((m) => m.default),
    unpin: () => import('./commands/unpin.js').then((m) => m.default),
    watch: () => import('./commands/watch.js').then((m) => m.default),
    install: () => import('./commands/install.js').then((m) => m.default),
  },
})

/**
 * O `runMain` do citty mostra a ajuda se `--help`/`-h` aparece EM QUALQUER lugar. Em `sb run … -- --help` isso
 * é do `claude`: sem ajuda do `sb` antes do `--`, vai direto ao comando.
 */
function passthroughRun(raw: string[]): boolean {
  const dd = raw.indexOf('--')
  return raw[0] === 'run' && dd !== -1 && !raw.slice(0, dd).some((a) => a === '--help' || a === '-h')
}

const rawArgs = process.argv.slice(2)
const running: Promise<void> = passthroughRun(rawArgs) ? runCommand(main, { rawArgs }).then(() => undefined) : runMain(main)
running.catch((e: unknown) => {
  if (e instanceof SbError) {
    console.error(`✗ ${e.message}${e.detail ? `\n${e.detail}` : ''}`)
    process.exitCode = e.exit
  } else {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = EXIT.CHECK_FAILED
  }
})
