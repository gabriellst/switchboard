import { defineCommand } from 'citty'
import { defaultCtx } from '../core/ctx.js'
import { EXIT, SbError } from '../core/errors.js'
import { exitLike, launch } from '../core/launch.js'
import { guarded } from './guard.js'

export default defineCommand({
  meta: { name: 'agents', description: 'Abre `claude agents` na pasta do mux, com o settings dele (F6 checado antes)' },
  args: {
    mux: { type: 'positional', required: false, description: 'Mux (padrão: o da pasta atual)' },
  },
  run: guarded(async ({ args }) => {
    if (args._.length > 1) throw new SbError(`argumento a mais: ${JSON.stringify(args._[1])} (uso: sb agents [mux])`, EXIT.USAGE)
    exitLike(await launch(defaultCtx(), { mux: args.mux, cwd: process.cwd(), mode: 'agents' }))
  }),
})
