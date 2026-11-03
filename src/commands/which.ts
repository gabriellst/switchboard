import { defineCommand } from 'citty'
import { loadConfig } from '../core/config.js'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { EXIT, SbError } from '../core/errors.js'
import { checkSettingsTarget, type TargetProblem } from '../core/links.js'
import { resolveMuxForDir } from '../core/mux.js'
import { muxLink } from '../core/paths.js'
import { guarded } from './guard.js'

export interface WhichResult {
  mux: string
  settings: string
  account: string
}

const PROBLEM: Record<TargetProblem, string> = {
  'missing-link': 'o link do mux não existe',
  broken: 'o link do mux está quebrado (não aponta para um token em tokens/)',
  'invalid-json': 'o token do mux tem JSON inválido (o claude ignoraria o settings e cairia no keychain)',
  'no-oauth': 'o token do mux não tem CLAUDE_CODE_OAUTH_TOKEN',
}

/**
 * Só lê a config e o link (sem lock, sonda ou rede): o wrapper do zsh chama isto a cada `claude`.
 * Falha fechado: settings que o `claude` não aceitaria (ou ignoraria, caindo no keychain) → exit 1.
 */
export async function which(ctx: Ctx, dir: string): Promise<WhichResult> {
  const cfg = await loadConfig(ctx.paths)
  const mux = resolveMuxForDir(cfg, dir, ctx.paths.home)
  const settings = muxLink(ctx.paths, mux)
  const check = checkSettingsTarget(settings)
  if (!check.ok) {
    throw new SbError(`mux "${mux}": ${PROBLEM[check.problem]} (${settings})`, EXIT.CHECK_FAILED, '  rode `sb doctor --fix`')
  }
  return { mux, settings, account: check.account }
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
