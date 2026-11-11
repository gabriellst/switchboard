import { EXIT, SbError } from '../core/errors.js'

export type ArgDef = { type?: string; alias?: string | string[] }

const camel = (s: string): string => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

export interface FlagSets {
  long: Set<string>
  short: Set<string>
  bools: Set<string>
  valued: Set<string>
}

/** As opções que o comando declara (nome, camelCase, kebab-case e aliases), mais `--help`/`-h`. */
export function flagSets(argsDef: Record<string, ArgDef> | undefined): FlagSets {
  const sets: FlagSets = { long: new Set(['help']), short: new Set(['h']), bools: new Set(), valued: new Set() }
  for (const [name, def] of Object.entries(argsDef ?? {})) {
    if (def.type === 'positional') continue
    const aliases = Array.isArray(def.alias) ? def.alias : def.alias ? [def.alias] : []
    for (const n of [name, camel(name), kebab(name), ...aliases]) {
      if (n.length === 1) sets.short.add(n)
      else sets.long.add(n)
      if (def.type === 'boolean') sets.bools.add(n)
      else sets.valued.add(n)
    }
  }
  return sets
}

/** `arg` começa com `-` (e não é `-` nem `--`): é uma opção que o comando declara? leva valor? */
export function matchFlag(sets: FlagSets, arg: string): { ok: boolean; takesValue: boolean } {
  if (arg.startsWith('--')) {
    const name = arg.slice(2).split('=')[0]!
    return { ok: sets.long.has(name) || (name.startsWith('no-') && sets.bools.has(name.slice(3))), takesValue: sets.valued.has(name) }
  }
  const letters = arg.slice(1).split('=')[0]!
  return { ok: [...letters].every((c) => sets.short.has(c)), takesValue: sets.valued.has(letters.slice(-1)) }
}

export const unknownFlag = (arg: string): SbError =>
  new SbError(`opção desconhecida: ${arg.split('=')[0]}`, EXIT.USAGE, '  nada foi feito; veja `sb <comando> --help` para as opções que existem')

/**
 * O citty ignora em silêncio o que não declarou (`sb migrate --simulate` aplicava a migração de verdade). Recusa com exit 3
 * toda opção que o comando não declara, antes de qualquer efeito. Aceita as formas que o citty aceita: `--flag`, `--flag=v`,
 * `--no-<booleana>`, o nome em camelCase/kebab-case, aliases (`-x`, agrupados `-xyz`) e `--help`/`-h` (o `runMain` os trata
 * antes de rodar). Para no primeiro `--` (o resto é posicional/passthrough, ex.: `sb run -- …`). `--version` só vale sozinho
 * na raiz (também tratado pelo `runMain`): aqui é opção desconhecida. Vale para o que vem DEPOIS do nome do subcomando; o que
 * vem antes (raiz, `mux`, `accounts`) é conferido por `validateArgv` (argv.ts), que o citty não deixa chegar até aqui.
 */
export function assertKnownFlags(argsDef: Record<string, ArgDef> | undefined, rawArgs: readonly string[]): void {
  const sets = flagSets(argsDef)
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!
    if (arg === '--') return
    if (!arg.startsWith('-') || arg === '-') continue
    const m = matchFlag(sets, arg)
    if (!m.ok) throw unknownFlag(arg)
    // `--every -5`: o valor de uma opção com valor pode ser um número negativo (a validação do valor é do comando)
    if (m.takesValue && !arg.includes('=') && /^-\d+(\.\d+)?$/.test(rawArgs[i + 1] ?? '')) i++
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
