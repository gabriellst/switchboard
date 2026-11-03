import { defineCommand } from 'citty'
import { loadConfig } from '../core/config.js'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { buildAccounts } from '../core/panel.js'
import { readUsage } from '../core/usage.js'
import { renderAccounts } from '../report.js'
import { guarded } from './guard.js'

/** Central de contas: lê config, tokens (só o estado) e a última medição; nunca mede nem usa a rede. */
export async function runAccounts(ctx: Ctx, opts: { json: boolean }, write: (text: string) => void = (t) => void process.stdout.write(t)): Promise<void> {
  const cfg = await loadConfig(ctx.paths)
  const rows = buildAccounts(cfg, readUsage(ctx.paths), ctx.paths)
  write(opts.json ? `${JSON.stringify(rows, null, 2)}\n` : renderAccounts(rows, { nowMs: ctx.now() }))
}

export default defineCommand({
  meta: { name: 'accounts', description: 'Todas as contas registradas: token, uso e em quais muxes aparecem' },
  args: { json: { type: 'boolean', description: 'Saída em JSON (sem token)' } },
  run: guarded(async ({ args }) => {
    await runAccounts(defaultCtx(), { json: args.json === true })
  }),
})
