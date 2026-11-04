import { defineCommand } from 'citty'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { EXIT, SbError } from '../core/errors.js'
import type { RestartOptions } from '../core/swap.js'
import { guarded } from './guard.js'
import { runPinCommand, type PinRun } from './pin.js'

export const runUnpin = (ctx: Ctx, args: { session: string; json?: boolean }, opts: { waitMs?: number } & RestartOptions = {}): Promise<PinRun> =>
  runPinCommand(ctx, { ...args, account: null }, opts)

export default defineCommand({
  meta: { name: 'unpin', description: 'Solta uma sessão fixa: ela volta para o link do mux da sua pasta' },
  args: {
    session: { type: 'positional', required: true, description: 'Sessão (prefixo de 4 a 8 caracteres hexadecimais do id)' },
    json: { type: 'boolean', description: 'Saída em JSON (sem token)' },
  },
  run: guarded(async ({ args }) => {
    if (args._.length > 1) throw new SbError(`argumento a mais: ${JSON.stringify(args._[1])} (uso: sb unpin <sessão>)`, EXIT.USAGE)
    const { text } = await runUnpin(defaultCtx(), { session: args.session, json: args.json === true })
    process.stdout.write(text)
  }),
})
