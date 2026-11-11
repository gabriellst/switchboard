import { EXIT, SbError } from '../core/errors.js'
import { assertKnownFlags, flagSets, matchFlag, unknownFlag, type ArgDef } from './guard.js'

interface CmdLike {
  args?: unknown
  subCommands?: unknown
}

const resolve = async (v: unknown): Promise<unknown> => (typeof v === 'function' ? await (v as () => unknown)() : await v)
const isHelp = (a: string): boolean => a === '--help' || a === '-h'

/**
 * O citty só entrega à folha o que vem DEPOIS do nome do subcomando e pula, sem avisar, as opções que vêm antes: `sb --simulate
 * migrate` aplicaria a migração, `sb mux --bogus set …` alteraria a config. Os pais (raiz, `mux`, `accounts`) não têm `run`, então
 * o `guarded` nunca os vê. Esta função confere o argv INTEIRO uma vez, antes de o citty despachar qualquer coisa, descendo a árvore
 * nível por nível:
 *
 * - com um subcomando adiante, QUALQUER opção antes do nome é recusada (exit 3): a que ninguém declara é "desconhecida"; a que o
 *   pai declara (`--json`, `--every`, que só valem sem subcomando, para o painel/listagem padrão) seria descartada pelo citty, então
 *   também é recusada, mandando pô-la depois do subcomando. Nada é realocado;
 * - sem subcomando adiante (o pai roda o padrão, `sb` = painel, `sb mux` = list), as opções têm de ser as declaradas no nível;
 * - na folha, confere o resto contra os args dela (o `guarded` repete a conferência, por segurança).
 *
 * `--help`/`-h` em qualquer lugar (antes de um `--`) e `--version`/`-v` sozinhos ficam com o `runMain`, que não executa nada.
 * Nome de subcomando que não existe também fica com o citty (erro, exit 1). Tudo depois de um `--` é passthrough.
 */
export async function validateArgv(root: CmdLike, rawArgs: readonly string[]): Promise<void> {
  const dd = rawArgs.indexOf('--')
  if ((dd === -1 ? rawArgs : rawArgs.slice(0, dd)).some(isHelp)) return
  if (rawArgs.length === 1 && (rawArgs[0] === '--version' || rawArgs[0] === '-v')) return

  let cmd: CmdLike = root
  let rest: readonly string[] = rawArgs
  for (;;) {
    const def = ((await resolve(cmd.args)) ?? {}) as Record<string, ArgDef>
    const subs = (await resolve(cmd.subCommands)) as Record<string, unknown> | undefined
    if (!subs || Object.keys(subs).length === 0) {
      assertKnownFlags(def, rest)
      return
    }
    const sets = flagSets(def)
    // o mesmo critério do citty para achar o nome (`findSubCommandIndex`): opção com valor leva o token seguinte junto
    let nameAt = -1
    let firstFlag: string | undefined
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!
      if (a === '--') break
      if (a.startsWith('-') && a !== '-') {
        firstFlag ??= a
        const m = matchFlag(sets, a)
        if (m.ok && m.takesValue && !a.includes('=')) i++
        continue
      }
      nameAt = i
      break
    }
    if (nameAt === -1) {
      assertKnownFlags(def, rest) // sem subcomando: o padrão do pai roda com estas opções
      return
    }
    const name = rest[nameAt]!
    if (firstFlag !== undefined) {
      const flag = firstFlag.split('=')[0]!
      if (!matchFlag(sets, firstFlag).ok) throw unknownFlag(firstFlag)
      throw new SbError(
        `a opção ${flag} vem antes do subcomando "${name}" e seria ignorada`,
        EXIT.USAGE,
        `  nada foi feito; ponha as opções depois do subcomando: sb ${name} ${flag} …`,
      )
    }
    if (!(name in subs)) return // subcomando desconhecido: erro do citty (exit 1)
    cmd = (await resolve(subs[name])) as CmdLike
    rest = rest.slice(nameAt + 1)
  }
}
