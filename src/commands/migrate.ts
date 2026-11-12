import { defineCommand } from 'citty'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { EXIT, SbError, type ExitCode } from '../core/errors.js'
import type { InstallResult } from '../core/install.js'
import { applyMigration, finishMigration, planMigration, type MigrateDeps } from '../core/migrate.js'
import { renderFinish, renderMigration, renderMigrationPlan } from '../report.js'
import { guarded } from './guard.js'
import { install, installPreconditions } from './install.js'

export interface MigrateArgs {
  simular?: boolean
  finish?: boolean
  manterConfig?: boolean
  json?: boolean
}

const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]+/g
const json = (v: unknown): string => `${JSON.stringify(v, null, 2).replace(TOKEN_RE, '<token>')}\n`

/**
 * `sb migrate [--simular] [--finish] [--json]`. Sem `--finish`: planeja e, sem `--simular`, aplica (a saída lista o que fez e
 * os comandos para reabrir as abas). Com `--finish`: move `~/.claude/contas*` para o backup (recusa enquanto algo apontar para lá).
 * Exit: 0 · 1 recusa do `--finish`, `sb install` com problema ou erro de passo · 2 config inválida · 3 uso · 4 claude.
 * O JSON passa por uma redação final de `sk-ant-…`, embora o plano e o resultado nem carreguem token.
 */
export async function runMigrate(
  ctx: Ctx,
  args: MigrateArgs,
  deps: MigrateDeps = { install: (c) => install(c, { simular: false }), check: installPreconditions },
): Promise<{ text: string; exit: ExitCode }> {
  const home = ctx.paths.home
  if (args.finish === true) {
    const r = await finishMigration(ctx, { simular: args.simular === true })
    return { text: args.json === true ? json(r) : renderFinish(r, home), exit: EXIT.OK }
  }
  const plan = await planMigration(ctx, { keepConfig: args.manterConfig === true })
  if (args.simular === true) return { text: args.json === true ? json({ simular: true, plan }) : renderMigrationPlan(plan, home), exit: EXIT.OK }
  const result = await applyMigration(ctx, plan, deps)
  const bad = (i: InstallResult): boolean => i.launchd.status === 'failed' || i.zshrc.status === 'different'
  return {
    text: args.json === true ? json({ plan, result }) : renderMigration(result, home),
    exit: bad(result.install) || result.vigia === 'failed' ? EXIT.CHECK_FAILED : EXIT.OK,
  }
}

export default defineCommand({
  meta: { name: 'migrate', description: 'Migra o claude-conta para o sb (contas, muxes, sessões, zshrc); --finish move ~/.claude/contas* para o backup' },
  args: {
    simular: { type: 'boolean', description: 'Só mostra o plano (não grava nada nem para nenhum processo)' },
    'manter-config': { type: 'boolean', description: 'Não importa contas nem cria muxes: usa a config do sb que já existe; só reaponta as sessões e troca o terminal' },
    finish: { type: 'boolean', description: 'Move ~/.claude/contas e contas-fixas para o backup, quando nada mais aponta para lá' },
    json: { type: 'boolean', description: 'Saída em JSON (sem token)' },
  },
  run: guarded(async ({ args }) => {
    if (args._.length > 0) throw new SbError(`argumento a mais: ${JSON.stringify(args._[0])} (uso: sb migrate [--simular] [--manter-config] [--finish] [--json])`, EXIT.USAGE)
    const manterConfig = args['manter-config'] === true
    if (manterConfig && args.finish === true) throw new SbError('`--manter-config` não combina com `--finish`', EXIT.USAGE)
    const r = await runMigrate(defaultCtx(), { simular: args.simular === true, finish: args.finish === true, json: args.json === true, manterConfig })
    process.stdout.write(r.text)
    if (r.exit !== EXIT.OK) process.exitCode = r.exit
  }),
})
