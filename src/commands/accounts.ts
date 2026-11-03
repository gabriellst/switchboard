import { defineCommand } from 'citty'
import { removeAccount } from '../core/accounts.js'
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

const jsonArg = { json: { type: 'boolean', description: 'Saída em JSON (sem token)' } } as const

const list = defineCommand({
  meta: { name: 'list', description: 'Lista as contas registradas' },
  args: jsonArg,
  run: guarded(async ({ args }) => {
    await runAccounts(defaultCtx(), { json: args.json === true })
  }),
})

const rm = defineCommand({
  meta: { name: 'rm', description: 'Apaga o registro e o token de uma conta (recusa conta anexada)' },
  args: {
    account: { type: 'positional', required: true, description: 'Conta' },
    yes: { type: 'boolean', description: 'Confirma (apaga o token; só voltando a fazer sb login)' },
  },
  run: guarded(async ({ args }) => {
    await removeAccount(defaultCtx(), args.account, { yes: args.yes === true })
    process.stdout.write(`conta ${args.account} removida (registro e token)\n`)
  }),
})

// `default` em vez de `run` no pai: o citty roda o `run` do pai DEPOIS do subcomando, e `sb accounts rm` listaria em seguida.
export default defineCommand({
  meta: { name: 'accounts', description: 'Todas as contas registradas: token, uso e em quais muxes aparecem' },
  args: jsonArg, // o citty precisa saber que `--json` é booleano para achar o subcomando
  subCommands: { list, rm },
  default: 'list',
})
