import { defineCommand } from 'citty'
import { loadConfig } from '../core/config.js'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { assertSettingsTarget } from '../core/links.js'
import { resolveMuxForDir } from '../core/mux.js'
import { muxLink } from '../core/paths.js'
import { guarded } from './guard.js'

export interface WhichResult {
  mux: string
  settings: string
  account: string
}

/**
 * Só lê a config e o link (sem lock, sonda ou rede): o wrapper do zsh chama isto a cada `claude`.
 * Falha fechado: settings que o `claude` não aceitaria (ou ignoraria, caindo no keychain) → exit 1.
 */
export async function which(ctx: Ctx, dir: string): Promise<WhichResult> {
  const cfg = await loadConfig(ctx.paths)
  const mux = resolveMuxForDir(cfg, dir, ctx.paths.home)
  const settings = muxLink(ctx.paths, mux)
  return { mux, settings, account: assertSettingsTarget(settings, mux) }
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
