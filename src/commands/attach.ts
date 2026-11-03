import { defineCommand } from 'citty'
import { attachAccount } from '../core/accounts.js'
import { defaultCtx } from '../core/ctx.js'
import { EXIT, SbError } from '../core/errors.js'
import { needsLogin } from '../core/login.js'
import { parsePool } from './args.js'
import { guarded } from './guard.js'
import { runLogin } from './login.js'

export default defineCommand({
  meta: { name: 'attach', description: 'Anexa uma conta a um mux (accounts; com --pool entra na fila; --preferred a faz preferida)' },
  args: {
    account: { type: 'positional', required: true, description: 'Conta (se ainda não existe, faz o login antes, como sb login --attach)' },
    mux: { type: 'positional', required: true, description: 'Mux' },
    pool: { type: 'boolean', description: 'Põe a conta no pool (fim da fila)' },
    at: { type: 'string', description: 'Posição (1-based) no pool; implica --pool' },
    preferred: { type: 'boolean', description: 'Faz a conta a preferida do mux (a atual só muda no próximo ciclo do watch ou com sb swap)' },
    json: { type: 'boolean', description: 'Saída em JSON' },
  },
  run: guarded(async ({ args }) => {
    const pool = parsePool(args.pool === true, args.at)
    const spec = { mux: args.mux, ...(pool !== undefined && { pool }), ...(args.preferred === true && { preferred: true }) }
    const ctx = defaultCtx()
    // conta que ainda não existe (sem registro ou sem token): faz o login com as mesmas regras e anexa (igual a `login --attach`)
    if (await needsLogin(ctx, args.account)) {
      if (args.json === true) {
        throw new SbError(`a conta "${args.account}" ainda não tem login: rode sem --json (o login em segundo plano não tem saída JSON)`, EXIT.USAGE)
      }
      await runLogin(ctx, { account: args.account, terminal: false, foreground: false, attach: spec })
      return
    }
    const { changed } = await attachAccount(ctx, args.account, spec)
    if (args.json === true) {
      process.stdout.write(`${JSON.stringify({ account: args.account, mux: args.mux, changed })}\n`)
      return
    }
    if (changed.length === 0) {
      process.stdout.write(`${args.account} já está assim no mux ${args.mux}: nada a mudar\n`)
      return
    }
    process.stdout.write(`${args.account} anexada ao mux ${args.mux} (${changed.join(', ')})\n`)
    if (changed.includes('preferred')) {
      process.stdout.write('a conta atual não mudou: a nova preferida vale no próximo ciclo do watch ou com `sb swap`\n')
    }
  }),
})
