import { EXIT, SbError } from '../core/errors.js'

type ArgDef = { type?: string; alias?: string | string[] }

const camel = (s: string): string => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

/**
 * O citty ignora em silêncio o que não declarou (`sb migrate --simulate` aplicava a migração de verdade). Recusa com exit 3
 * toda opção que o comando não declara, antes de qualquer efeito. Aceita as formas que o citty aceita: `--flag`, `--flag=v`,
 * `--no-<booleana>`, o nome em camelCase/kebab-case, aliases (`-x`, agrupados `-xyz`) e `--help`/`-h` (o `runMain` os trata
 * antes de rodar). Para no primeiro `--` (o resto é posicional/passthrough, ex.: `sb run -- …`). `--version` só vale sozinho
 * na raiz (também tratado pelo `runMain`): aqui é opção desconhecida.
 */
export function assertKnownFlags(argsDef: Record<string, ArgDef> | undefined, rawArgs: readonly string[]): void {
  const long = new Set<string>(['help'])
  const bools = new Set<string>()
  const valued = new Set<string>()
  const short = new Set<string>(['h'])
  for (const [name, def] of Object.entries(argsDef ?? {})) {
    if (def.type === 'positional') continue
    const names = [name, camel(name), kebab(name)]
    const aliases = Array.isArray(def.alias) ? def.alias : def.alias ? [def.alias] : []
    for (const n of [...names, ...aliases]) {
      if (n.length === 1) short.add(n)
      else long.add(n)
      if (def.type === 'boolean') bools.add(n)
      else valued.add(n)
    }
  }
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!
    if (arg === '--') return
    if (!arg.startsWith('-') || arg === '-') continue
    let ok: boolean
    let takesValue = false
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=')[0]!
      ok = long.has(name) || (name.startsWith('no-') && bools.has(name.slice(3)))
      takesValue = valued.has(name)
    } else {
      const letters = arg.slice(1).split('=')[0]!
      ok = [...letters].every((c) => short.has(c))
      takesValue = valued.has(letters.slice(-1))
    }
    // `--every -5`: o valor de uma opção com valor pode ser um número negativo (a validação do valor é do comando)
    if (ok && takesValue && !arg.includes('=') && /^-\d+(\.\d+)?$/.test(rawArgs[i + 1] ?? '')) i++
    if (!ok) throw new SbError(`opção desconhecida: ${arg.split('=')[0]}`, EXIT.USAGE, '  nada foi feito; veja `sb <comando> --help` para as opções que existem')
  }
}

interface GuardCtx {
  rawArgs: string[]
  cmd: { meta?: unknown; args?: unknown }
}

/**
 * citty engole exceções do run (imprime stack, exit 0). Erros nossos saem limpos e com exit code. Antes de rodar, recusa
 * opção desconhecida (ver `assertKnownFlags`).
 */
export function guarded<T extends GuardCtx>(fn: (ctx: T) => Promise<void>): (ctx: T) => Promise<void> {
  return async (ctx) => {
    try {
      const def = typeof ctx.cmd.args === 'function' ? await (ctx.cmd.args as () => unknown)() : await ctx.cmd.args
      assertKnownFlags(def as Record<string, ArgDef> | undefined, ctx.rawArgs)
      await fn(ctx)
    } catch (e) {
      if (e instanceof SbError) {
        // os `detail` já vêm com a indentação de dois espaços; só quem não a traz ganha uma
        console.error(`✗ ${e.message}${e.detail ? `\n${/^\s/.test(e.detail) ? '' : '  '}${e.detail}` : ''}`)
        process.exitCode = e.exit
        return
      }
      throw e
    }
  }
}
