import { defineCommand } from 'citty'
import { loadConfig } from '../core/config.js'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { currentAccount } from '../core/links.js'
import { resolveMuxForDir } from '../core/mux.js'
import { muxLink } from '../core/paths.js'
import { guarded } from './guard.js'

export interface WhichResult {
  mux: string
  settings: string
  account: string | null
}

/** Só lê a config e o `readlink`: sem sonda, sem rede, sem lock. O wrapper do zsh chama isto a cada `claude`. */
export async function which(ctx: Ctx, dir: string): Promise<WhichResult> {
  const cfg = await loadConfig(ctx.paths)
  const mux = resolveMuxForDir(cfg, dir, ctx.paths.home)
  return { mux, settings: muxLink(ctx.paths, mux), account: currentAccount(ctx.paths, mux) }
}

export default defineCommand({
  meta: { name: 'which', description: 'Caminho do settings do mux da pasta (stdout só com o caminho)' },
  args: {
    dir: { type: 'positional', required: false, description: 'Pasta (padrão: a atual)' },
    json: { type: 'boolean', description: 'Saída em JSON: { mux, settings, account }' },
  },
  run: guarded(async ({ args }) => {
    const r = await which(defaultCtx(), args.dir ?? process.cwd())
    process.stdout.write(args.json === true ? `${JSON.stringify(r)}\n` : `${r.settings}\n`)
  }),
})
