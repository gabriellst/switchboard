import { defineCommand } from 'citty'
import { loadConfig } from '../core/config.js'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { EXIT, SbError } from '../core/errors.js'
import { withLock } from '../core/fsx.js'
import { assertSafeName } from '../core/paths.js'
import { pinSession, STOP_FAILED_QUEUED_DETAIL, type PinOutcome } from '../core/pin.js'
import type { RestartOptions } from '../core/swap.js'
import { watchStatus, type WatchStatus } from '../core/watch.js'
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

/** A linha sobre o `watch`, que é quem aplica a fila: confirma quando ele roda, avisa (⚠) quando não. */
function watchLine(w: WatchStatus): string {
  switch (w.state) {
    case 'running':
      return 'o `sb watch` está rodando e aplica o pedido quando a sessão ficar livre\n'
    case 'stale':
      return '⚠ o `sb watch` parece parado (o processo morreu ou o último ciclo foi há mais de 90 s): o pedido só será aplicado quando ele voltar; rode `sb watch`\n'
    case 'absent':
      return '⚠ o `sb watch` não está rodando: o pedido só será aplicado quando você iniciá-lo (`sb watch`)\n'
  }
}

/** Texto em português do que aconteceu; só ids, nomes de conta e caminhos (nunca token). `w`: o estado do watch (só importa na fila). */
function describe(o: PinOutcome, account: string | null, w: WatchStatus): string {
  const what = account === null ? `solta (volta para o mux ${muxName(o.settings)})` : `fixada na conta ${account}`
  switch (o.result) {
    case 'rewritten':
      return `sessão ${o.jobId} ${what}: estava parada, os flags foram reescritos (backup em backup/)\nreabra a sessão para ela usar a nova conta\n`
    case 'stopped-and-rewritten':
      return `sessão ${o.jobId} parada e ${what}\nreabra a sessão para ela usar a nova conta\n`
    case 'queued':
      return `sessão ${o.jobId} está ocupada (ou foi ela quem chamou o sb): o pedido ficou na fila (runtime.pending)\n${watchLine(w)}`
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
  let outcome: PinOutcome
  try {
    outcome = await withLock(
      ctx.paths,
      async () => {
        const cfg = await loadConfig(ctx.paths)
        return pinSession(ctx, cfg, args.session, account, restart)
      },
      waitMs === undefined ? {} : { waitMs },
    )
  } catch (e) {
    // `claude stop` falhou: o pedido também ficou na fila, e sem watch ele não anda
    if (e instanceof SbError && e.exit === EXIT.CHECK_FAILED && e.detail === STOP_FAILED_QUEUED_DETAIL) {
      const w = watchStatus(ctx)
      if (w.state !== 'running') throw new SbError(e.message, e.exit, `${e.detail}\n  ${watchLine(w).trimEnd()}`)
    }
    throw e
  }
  // só a fila depende do watch: confere o batimento depois do lock (o `pin` não toca em `watch.json`)
  const watch = outcome.result === 'queued' ? watchStatus(ctx) : undefined
  const text =
    args.json === true
      ? `${JSON.stringify({ jobId: outcome.jobId, account, settings: outcome.settings, result: outcome.result, ...(watch !== undefined && { watch: watch.state }) }, null, 2)}\n`
      : describe(outcome, account, watch ?? { state: 'absent' })
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
