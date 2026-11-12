import { statSync } from 'node:fs'
import { defineCommand } from 'citty'
import { defaultCtx } from '../core/ctx.js'
import { EXIT, SbError } from '../core/errors.js'
import { exitLike, launch } from '../core/launch.js'
import { normalizeRoot } from '../core/schema.js'
import { guarded } from './guard.js'

export default defineCommand({
  meta: { name: 'agents', description: 'Abre `claude agents` na pasta do mux (ou em --cwd), com o settings dele (F6 checado antes)' },
  args: {
    mux: { type: 'positional', required: false, description: 'Mux (padrão: o da pasta atual)' },
    cwd: { type: 'string', description: 'Pasta da view (aceita ~; padrão: a raiz do mux). Sem o nome do mux, o mux é o dono desta pasta' },
  },
  run: guarded(async ({ args }) => {
    if (args._.length > 1) throw new SbError(`argumento a mais: ${JSON.stringify(args._[1])} (uso: sb agents [mux] [--cwd <pasta>])`, EXIT.USAGE)
    const ctx = defaultCtx()
    let dir: string | undefined
    if (args.cwd !== undefined) {
      dir = normalizeRoot(args.cwd, ctx.paths.home)
      let isDir = false
      try {
        isDir = statSync(dir).isDirectory()
      } catch {
        isDir = false
      }
      if (!isDir) throw new SbError(`--cwd não é uma pasta que existe: ${dir}`, EXIT.USAGE)
    }
    exitLike(await launch(ctx, { mux: args.mux, cwd: process.cwd(), mode: 'agents', ...(dir !== undefined && { dir }) }))
  }),
})
