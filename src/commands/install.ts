import { realpathSync } from 'node:fs'
import { defineCommand } from 'citty'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { EXIT, SbError } from '../core/errors.js'
import { findClaudeDir, planInstall, runInstall, type InstallResult } from '../core/install.js'
import { renderInstall } from '../report.js'
import { guarded } from './guard.js'

/** O `sb` que está rodando agora (runtime + cli.js), em caminhos absolutos: é o que o launchd e o wrapper vão chamar. */
function selfCommand(): { runtimeBin: string; cliPath: string } {
  const script = process.argv[1]
  if (!script) throw new SbError('não consegui descobrir o caminho do cli do sb', EXIT.CHECK_FAILED)
  return { runtimeBin: process.execPath, cliPath: realpathSync(script) }
}

export function install(ctx: Ctx, opts: { simular: boolean }): InstallResult {
  const plan = planInstall(ctx.paths, { ...selfCommand(), claudeDir: findClaudeDir(ctx.env) })
  return runInstall(ctx, plan, opts)
}

export default defineCommand({
  meta: { name: 'install', description: 'Instala o LaunchAgent do watch, o wrapper zsh do claude e o comando /sb' },
  args: {
    simular: { type: 'boolean', description: 'Só mostra o que faria (não grava nem chama o launchctl)' },
    json: { type: 'boolean', description: 'Saída em JSON' },
  },
  run: guarded(async ({ args }) => {
    const ctx = defaultCtx()
    const result = install(ctx, { simular: args.simular === true })
    process.stdout.write(args.json === true ? `${JSON.stringify(result, null, 2)}\n` : renderInstall(result, ctx.paths.home))
    if (result.launchd.status === 'failed') process.exitCode = EXIT.CHECK_FAILED
  }),
})
