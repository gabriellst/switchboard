import { defineCommand } from 'citty'
import { attachAccount } from '../core/accounts.js'
import { defaultCtx } from '../core/ctx.js'
import { EXIT, SbError } from '../core/errors.js'
import { guarded } from './guard.js'

/** `--at N` (posição 1-based, implica `--pool`) ou `--pool` (fim da fila). */
export function parsePool(pool: boolean, at: string | undefined): boolean | number | undefined {
  if (at !== undefined) {
    if (!/^[1-9]\d*$/.test(at)) throw new SbError(`--at inválido: "${at}" (use um inteiro a partir de 1)`, EXIT.USAGE)
    return Number(at)
  }
  return pool ? true : undefined
}

export default defineCommand({
  meta: { name: 'attach', description: 'Anexa uma conta a um mux (accounts; com --pool entra na fila; --preferred a faz preferida)' },
  args: {
    account: { type: 'positional', required: true, description: 'Conta registrada (sb login)' },
    mux: { type: 'positional', required: true, description: 'Mux' },
    pool: { type: 'boolean', description: 'Põe a conta no pool (fim da fila)' },
    at: { type: 'string', description: 'Posição (1-based) no pool; implica --pool' },
    preferred: { type: 'boolean', description: 'Faz a conta a preferida do mux (a atual só muda no próximo ciclo do watch ou com sb swap)' },
    json: { type: 'boolean', description: 'Saída em JSON' },
  },
  run: guarded(async ({ args }) => {
    const pool = parsePool(args.pool === true, args.at)
    const { changed } = await attachAccount(defaultCtx(), args.account, {
      mux: args.mux,
      ...(pool !== undefined && { pool }),
      ...(args.preferred === true && { preferred: true }),
    })
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
