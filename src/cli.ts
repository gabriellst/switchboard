#!/usr/bin/env node
import { defineCommand, runMain } from 'citty'
import { EXIT, SbError } from './core/errors.js'

const main = defineCommand({
  meta: { name: 'sb', version: '0.1.0', description: 'Contas do Claude Code por pasta, com troca automática ao bater o limite' },
  // Subcomandos entram nas tasks seguintes, carregados sob demanda:
  //   status: () => import('./commands/status.js').then((m) => m.default),
  subCommands: {},
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
