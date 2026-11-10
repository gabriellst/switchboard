import { defineCommand } from 'citty'
import { loadConfig } from '../core/config.js'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { EXIT, SbError } from '../core/errors.js'
import { tick, watchLoop, WATCH_INTERVAL_MS, type TickOptions, type TickReport } from '../core/watch.js'
import { renderTick } from '../report.js'
import { guarded } from './guard.js'

const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]+/g

/**
 * `sb watch --once`: um ciclo só (config inválida → exit 2; lock ocupado → exit 5). Não grava o batimento: quem grava é o laço,
 * e um `--once` não pode sobrescrever o pid do watch que está rodando.
 */
export async function runWatchOnce(ctx: Ctx, args: { json?: boolean } = {}, opts: TickOptions = {}): Promise<{ report: TickReport; text: string }> {
  const cfg = await loadConfig(ctx.paths)
  const report = await tick(ctx, cfg, opts)
  // mensagens de erro de terceiros já saem sem token; a redação aqui é a última barreira da saída `--json`
  const text = args.json === true ? `${JSON.stringify(report, null, 2).replace(TOKEN_RE, '<token>')}\n` : renderTick(report)
  return { report, text }
}

export default defineCommand({
  meta: { name: 'watch', description: 'Laço que mede o uso, troca a conta dos mux que esgotam, reinicia sessões antigas e aplica a fila de pins (um só por máquina)' },
  args: {
    once: { type: 'boolean', description: 'Um ciclo e sai' },
    json: { type: 'boolean', description: 'Saída em JSON (sem token; só com --once)' },
  },
  run: guarded(async ({ args }) => {
    const ctx = defaultCtx()
    if (args.once === true) {
      const { report, text } = await runWatchOnce(ctx, { json: args.json === true })
      process.stdout.write(text)
      if (report.skipped === 'locked') process.exitCode = EXIT.LOCKED
      return
    }
    if (args.json === true) throw new SbError('--json só vale com --once', EXIT.USAGE)
    const ac = new AbortController()
    const stop = (): void => ac.abort()
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    try {
      await watchLoop(ctx, WATCH_INTERVAL_MS, { signal: ac.signal })
    } finally {
      process.off('SIGTERM', stop)
      process.off('SIGINT', stop)
    }
  }),
})
