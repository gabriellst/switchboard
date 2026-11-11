#!/usr/bin/env node
import { runCommand, runMain } from 'citty'
import { validateArgv } from './commands/argv.js'
import { EXIT, SbError } from './core/errors.js'
import { main } from './main.js'

/**
 * O `runMain` do citty mostra a ajuda se `--help`/`-h` aparece EM QUALQUER lugar. Em `sb run … -- --help` isso
 * é do `claude`: sem ajuda do `sb` antes do `--`, vai direto ao comando.
 */
function passthroughRun(raw: string[]): boolean {
  const dd = raw.indexOf('--')
  return raw[0] === 'run' && dd !== -1 && !raw.slice(0, dd).some((a) => a === '--help' || a === '-h')
}

const rawArgs = process.argv.slice(2)
// o argv inteiro é conferido antes de o citty despachar qualquer coisa (ver argv.ts): opção desconhecida = exit 3, sem efeito
const running: Promise<void> = validateArgv(main, rawArgs).then(() => (passthroughRun(rawArgs) ? runCommand(main, { rawArgs }).then(() => undefined) : runMain(main)))
running.catch((e: unknown) => {
  if (e instanceof SbError) {
    console.error(`✗ ${e.message}${e.detail ? `\n${e.detail}` : ''}`)
    process.exitCode = e.exit
  } else {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = EXIT.CHECK_FAILED
  }
})
