import { defineCommand } from 'citty'
import { loadConfig } from '../core/config.js'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { EXIT, SbError } from '../core/errors.js'
import { withLock } from '../core/fsx.js'
import { assertSafeName } from '../core/paths.js'
import { pinSession, type PinOutcome } from '../core/pin.js'
import type { RestartOptions } from '../core/swap.js'
import { guarded } from './guard.js'

export interface PinArgs {
  session: string
  /** `null`/ausente = soltar (`sb unpin`) */
  account?: string | null
  json?: boolean
}

export interface PinRun {
  outcome: PinOutcome
  text: string
}

/** Texto em português do que aconteceu; só ids, nomes de conta e caminhos (nunca token). */
function describe(o: PinOutcome, account: string | null): string {
  const what = account === null ? `solta (volta para o mux ${muxName(o.settings)})` : `fixada na conta ${account}`
  switch (o.result) {
    case 'rewritten':
      return `sessão ${o.jobId} ${what}: estava parada, os flags foram reescritos (backup em backup/)\nreabra a sessão para ela usar a nova conta\n`
    case 'stopped-and-rewritten':
      return `sessão ${o.jobId} parada e ${what}\nreabra a sessão para ela usar a nova conta\n`
    case 'queued':
      return `sessão ${o.jobId} está ocupada (ou foi ela quem chamou o sb): o pedido ficou na fila (runtime.pending)\no \`sb watch\` aplica quando ela ficar livre; se ele não estiver rodando, o pedido espera\n`
  }
}

function muxName(settings: string): string {
  // o `settings` do pedido é o link do mux (`<estado>/mux/<mux>.json`); o nome sai do basename sem ler nada
  const base = settings.split('/').at(-1) ?? ''
  return base.replace(/\.json$/, '')
}

/**
 * `sb pin <sessão> <conta>` / `sb unpin <sessão>` (conta `null`). Nomes do argv validados antes de qualquer coisa;
 * config, decisão, parada e gravação rodam dentro do lock do estado (ocupado → exit 5 depois de `waitMs`).
 */
export async function runPinCommand(ctx: Ctx, args: PinArgs, opts: { waitMs?: number } & RestartOptions = {}): Promise<PinRun> {
  const account = args.account ?? null
  if (account !== null) assertSafeName(account)
  const { waitMs, ...restart } = opts
  const outcome = await withLock(
    ctx.paths,
    async () => {
      const cfg = await loadConfig(ctx.paths)
      return pinSession(ctx, cfg, args.session, account, restart)
    },
    waitMs === undefined ? {} : { waitMs },
  )
  const text =
    args.json === true
      ? `${JSON.stringify({ jobId: outcome.jobId, account, settings: outcome.settings, result: outcome.result }, null, 2)}\n`
      : describe(outcome, account)
  return { outcome, text }
}

export const runPin = (ctx: Ctx, args: PinArgs & { account: string }, opts: { waitMs?: number } & RestartOptions = {}): Promise<PinRun> => runPinCommand(ctx, args, opts)

export default defineCommand({
  meta: { name: 'pin', description: 'Fixa uma sessão em segundo plano numa conta (fica fora de todo swap); a conta tem que estar em accounts do mux da sessão' },
  args: {
    session: { type: 'positional', required: true, description: 'Sessão (prefixo de 4 a 8 caracteres hexadecimais do id)' },
    account: { type: 'positional', required: true, description: 'Conta' },
    json: { type: 'boolean', description: 'Saída em JSON (sem token)' },
  },
  run: guarded(async ({ args }) => {
    if (args._.length > 2) throw new SbError(`argumento a mais: ${JSON.stringify(args._[2])} (uso: sb pin <sessão> <conta>)`, EXIT.USAGE)
    const { text } = await runPin(defaultCtx(), { session: args.session, account: args.account, json: args.json === true })
    process.stdout.write(text)
  }),
})
