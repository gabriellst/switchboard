import { SbError } from '../core/errors.js'

/** citty engole exceções do run (imprime stack, exit 0). Erros nossos saem limpos e com exit code. */
export function guarded<T>(fn: (ctx: T) => Promise<void>): (ctx: T) => Promise<void> {
  return async (ctx) => {
    try {
      await fn(ctx)
    } catch (e) {
      if (e instanceof SbError) {
        console.error(`✗ ${e.message}${e.detail ? `\n  ${e.detail}` : ''}`)
        process.exitCode = e.exit
        return
      }
      throw e
    }
  }
}
