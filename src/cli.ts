#!/usr/bin/env node
import { defineCommand, runMain } from 'citty'
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
  },
})

runMain(main).catch((e: unknown) => {
  if (e instanceof SbError) {
    console.error(`✗ ${e.message}${e.detail ? `\n${e.detail}` : ''}`)
    process.exitCode = e.exit
  } else {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = EXIT.CHECK_FAILED
  }
})
