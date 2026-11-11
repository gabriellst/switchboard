import { realpathSync } from 'node:fs'
import { defineCommand } from 'citty'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { EXIT, SbError } from '../core/errors.js'
import { findClaudeDir, planInstall, runInstall, stableRuntime, type InstallResult } from '../core/install.js'
import { renderInstall } from '../report.js'
import { guarded } from './guard.js'

/** O `sb` que está rodando agora (runtime + cli.js), em caminhos absolutos: é o que o launchd e o wrapper vão chamar. */
function selfCommand(env: Ctx['env']): { runtimeBin: string; cliPath: string } {
  const script = process.argv[1]
  if (!script) throw new SbError('não consegui descobrir o caminho do cli do sb', EXIT.CHECK_FAILED)
  return { runtimeBin: stableRuntime(env, process.execPath), cliPath: realpathSync(script) }
}

/**
 * O que o `install` exige e pode faltar (o `claude` no PATH; o caminho do próprio cli). Quem escreve ANTES de instalar (o
 * `sb migrate`) confere aqui primeiro: um `install` que lança no meio da migração deixaria o zshrc já trocado.
 */
export function installPreconditions(ctx: Ctx): void {
  selfCommand(ctx.env)
  findClaudeDir(ctx.env)
}

export function install(ctx: Ctx, opts: { simular: boolean }): InstallResult {
  const plan = planInstall(ctx.paths, { ...selfCommand(ctx.env), claudeDir: findClaudeDir(ctx.env) })
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
    // `different`: a linha antiga do zshrc continuaria carregando o que não é este wrapper — o relatório sai inteiro, mas o exit avisa
    if (result.launchd.status === 'failed' || result.zshrc.status === 'different') process.exitCode = EXIT.CHECK_FAILED
  }),
})
