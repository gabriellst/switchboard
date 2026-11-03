import { defineCommand } from 'citty'
import { detachAccount } from '../core/accounts.js'
import { defaultCtx } from '../core/ctx.js'
import { guarded } from './guard.js'

export default defineCommand({
  meta: { name: 'detach', description: 'Tira uma conta de um mux (recusa a preferida e a conta atual)' },
  args: {
    account: { type: 'positional', required: true, description: 'Conta' },
    mux: { type: 'positional', required: true, description: 'Mux' },
    json: { type: 'boolean', description: 'Saída em JSON' },
  },
  run: guarded(async ({ args }) => {
    const { changed } = await detachAccount(defaultCtx(), args.account, args.mux)
    process.stdout.write(
      args.json === true
        ? `${JSON.stringify({ account: args.account, mux: args.mux, changed })}\n`
        : `${args.account} saiu do mux ${args.mux} (${changed.join(', ')})\n`,
    )
  }),
})
