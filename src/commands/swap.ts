import { defineCommand } from 'citty'
import { loadConfig } from '../core/config.js'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { EXIT, SbError } from '../core/errors.js'
import { withLock } from '../core/fsx.js'
import { assertSafeName } from '../core/paths.js'
import { readRuntime } from '../core/runtime.js'
import { callerJobId } from '../core/sessions.js'
import { readUsage } from '../core/usage.js'
import { currentAccount } from '../core/links.js'
import { manualSwap, type RestartOptions } from '../core/swap.js'
import { renderSwap, type SwapReport } from '../report.js'
import { guarded } from './guard.js'

export interface SwapArgs {
  mux: string
  account?: string
  clear?: boolean
  json?: boolean
}

/**
 * `sb swap <mux> [conta] [--clear] [--json]`. Nomes do argv validados antes de qualquer coisa; tudo (config, override,
 * troca, parada) roda dentro do lock do estado (ocupado → exit 5 depois de `waitMs`). Sessões com falha ao parar não
 * desfazem a troca: a saída as lista e o exit é 1.
 */
export async function runSwap(ctx: Ctx, args: SwapArgs, opts: { waitMs?: number } & RestartOptions = {}): Promise<{ report: SwapReport; text: string }> {
  assertSafeName(args.mux)
  if (args.account !== undefined) assertSafeName(args.account)
  if (args.clear === true && args.account !== undefined) {
    throw new SbError('--clear não aceita conta: ele volta à conta que a regra escolhe', EXIT.USAGE, `  use \`sb swap ${args.mux} --clear\``)
  }
  const { waitMs, ...restart } = opts
  const report = await withLock(
    ctx.paths,
    async (): Promise<SwapReport> => {
      const cfg = await loadConfig(ctx.paths)
      const r = manualSwap(ctx, cfg, args.mux, args.account, { clear: args.clear === true }, restart)
      const o = readRuntime(ctx.paths).overrides[args.mux]
      const pref = cfg.mux[args.mux]?.account
      const m = pref === undefined ? undefined : readUsage(ctx.paths).latest[pref]
      const knownReset = m?.ok === true ? m.fiveHour.resetsAt * 1000 : undefined
      const override = o !== undefined && o.until > ctx.now() ? { account: o.account, until: o.until, resetKnown: o.until === knownReset } : null
      if ('noop' in r) {
        const at = currentAccount(ctx.paths, args.mux) ?? ''
        return { mux: args.mux, noop: true, from: at, to: at, stopped: [], waitingBusy: [], keptScheduled: [], failed: [], callerWaiting: false, override }
      }
      const caller = callerJobId(ctx.env)
      return { ...r, noop: false, callerWaiting: caller !== undefined && r.waitingBusy.includes(caller), override }
    },
    waitMs === undefined ? {} : { waitMs },
  )
  const text = args.json === true ? `${JSON.stringify(report, null, 2)}\n` : renderSwap(report, { nowMs: ctx.now() })
  return { report, text }
}

export default defineCommand({
  meta: { name: 'swap', description: 'Troca manual de conta de um mux (vale até o reset da preferida); só para sessões livres' },
  args: {
    mux: { type: 'positional', required: true, description: 'Mux' },
    account: { type: 'positional', required: false, description: 'Conta (sem ela: a próxima da fila, ignorando a preferida; mux sem pool exige a conta)' },
    clear: { type: 'boolean', description: 'Desfaz o override manual e volta à conta que a regra escolhe' },
    json: { type: 'boolean', description: 'Saída em JSON (sem token)' },
  },
  run: guarded(async ({ args }) => {
    if (args._.length > 2) throw new SbError(`argumento a mais: ${JSON.stringify(args._[2])} (uso: sb swap <mux> [conta])`, EXIT.USAGE)
    const { report, text } = await runSwap(defaultCtx(), {
      mux: args.mux,
      ...(args.account !== undefined && { account: args.account }),
      clear: args.clear === true,
      json: args.json === true,
    })
    process.stdout.write(text)
    if (report.failed.length > 0) process.exitCode = EXIT.CHECK_FAILED
  }),
})
