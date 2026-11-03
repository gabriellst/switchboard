import { defineCommand } from 'citty'
import { defaultCtx } from '../core/ctx.js'
import { EXIT, SbError } from '../core/errors.js'
import { exitLike, launch } from '../core/launch.js'
import { guarded } from './guard.js'

/**
 * `sb run [mux] -- <args do claude>`: antes do `--` só o nome do mux (opcional); tudo depois é do `claude`,
 * sem reinterpretação (nem `--help`: ver cli.ts). Flag do `sb` sem `--` é recusada em vez de adivinhada.
 */
export function splitRunArgs(raw: string[]): { mux?: string; args: string[] } {
  const dd = raw.indexOf('--')
  const head = dd === -1 ? raw : raw.slice(0, dd)
  const args = dd === -1 ? [] : raw.slice(dd + 1)
  const bad = head.find((a) => a.startsWith('-'))
  if (bad !== undefined) throw new SbError(`opção desconhecida antes do \`--\`: ${JSON.stringify(bad)}`, EXIT.USAGE, '  os argumentos do claude vão depois: `sb run [mux] -- <args>`')
  if (head.length > 1) throw new SbError(`argumento a mais: ${JSON.stringify(head[1])}`, EXIT.USAGE, '  uso: `sb run [mux] -- <args do claude>`')
  return { mux: head[0], args }
}

export default defineCommand({
  meta: { name: 'run', description: 'Roda `claude <args>` com o settings do mux (uso: sb run [mux] -- <args>)' },
  args: {
    mux: { type: 'positional', required: false, description: 'Mux (padrão: o da pasta atual)' },
  },
  run: guarded(async ({ rawArgs }) => {
    const { mux, args } = splitRunArgs(rawArgs)
    exitLike(await launch(defaultCtx(), { mux, cwd: process.cwd(), mode: 'run', args }))
  }),
})
