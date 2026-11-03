import { defineCommand } from 'citty'
import { loadConfig, type Config } from '../core/config.js'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { EXIT, SbError } from '../core/errors.js'
import { withLock } from '../core/fsx.js'
import { buildPanel } from '../core/panel.js'
import { readRuntime } from '../core/runtime.js'
import { measureAll, readUsage, type UsageFile } from '../core/usage.js'
import { renderPanel } from '../report.js'
import { usageArgs } from './args.js'
import { guarded } from './guard.js'

/** `sb usage` reaproveita medições de até 1 min (§6). */
const MAX_AGE_MS = 60_000
/**
 * Quanto `sb usage` espera o lock. Decisão: o lock pertence a quem grava o estado e é segurado só
 * durante uma gravação (`sb attach`/`swap`...) ou um tick do `watch` (por tick, não pelo laço todo).
 * Por isso uma espera curta, seguida do fallback para a última `usage.json`, basta: esperar até 30 s
 * por um painel é pior que mostrar a última medição e avisar. Nunca falha por isso (exit 0).
 */
const LOCK_WAIT_MS = 1_500
export const BUSY_NOTICE = '⚠ medição em andamento por outro processo; mostrando a última medição'

export interface UsageIO {
  write(text: string): void
  sleep(ms: number): Promise<void>
  isTTY: boolean
}

export interface UsageOpts {
  json: boolean
  watch: boolean
  /** segundos entre frames do `--watch` */
  everyS: number
  /** para os testes: encerra o `--watch` depois de N frames */
  maxFrames?: number
}

const defaultIO = (): UsageIO => ({
  write: (t) => void process.stdout.write(t),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  isTTY: process.stdout.isTTY === true,
})

/** Mede (com cache) sob o lock; lock ocupado → última medição, `busy: true`. */
async function measure(ctx: Ctx, cfg: Config): Promise<{ usage: UsageFile; busy: boolean }> {
  try {
    const usage = await withLock(ctx.paths, () => measureAll(ctx, cfg, { maxAgeMs: MAX_AGE_MS }), { waitMs: LOCK_WAIT_MS })
    return { usage, busy: false }
  } catch (e) {
    if (e instanceof SbError && e.exit === EXIT.LOCKED) return { usage: readUsage(ctx.paths), busy: true }
    throw e
  }
}

export async function runUsage(ctx: Ctx, opts: UsageOpts, io: UsageIO = defaultIO()): Promise<void> {
  for (let frame = 1; ; frame++) {
    const cfg = await loadConfig(ctx.paths)
    const { usage, busy } = await measure(ctx, cfg)
    const panel = buildPanel(cfg, usage, readRuntime(ctx.paths), ctx.paths)
    let text: string
    if (opts.json) {
      // `busy` fica fora do PanelData: é do comando, não do modelo
      text = `${JSON.stringify({ ...panel, busy }, null, opts.watch ? undefined : 2)}\n`
    } else {
      text = renderPanel(panel, { nowMs: ctx.now() }) + (busy ? `${BUSY_NOTICE}\n` : '')
    }
    // o frame inteiro é montado antes de limpar a tela: nada de painel piscando durante a medição
    io.write(opts.watch && io.isTTY && !opts.json ? `\x1b[2J\x1b[H${text}` : text)
    if (!opts.watch || (opts.maxFrames !== undefined && frame >= opts.maxFrames)) return
    await io.sleep(opts.everyS * 1000)
  }
}

/** `--every`: segundos inteiros ≥ 1. */
export function parseEvery(text: string): number {
  if (!/^[1-9]\d*$/.test(text)) throw new SbError(`--every inválido: "${text}" (use um número inteiro de segundos, ex.: 30)`, EXIT.USAGE)
  return Number(text)
}

export default defineCommand({
  meta: { name: 'usage', description: 'Painel de uso das contas e dos muxes' },
  args: usageArgs,
  run: guarded(async ({ args }) => {
    const everyS = parseEvery(String(args.every))
    await runUsage(defaultCtx(), { json: args.json === true, watch: args.watch === true, everyS })
  }),
})
