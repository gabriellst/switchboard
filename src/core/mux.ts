import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { editConfig, loadConfig, type Config, type ConfigEdit } from './config.js'
import type { Ctx } from './ctx.js'
import { EXIT, SbError } from './errors.js'
import { withLock } from './fsx.js'
import { pointMux } from './links.js'
import { assertSafeName } from './paths.js'
import { KEYCHAIN, normalizeRoot } from './schema.js'
import { ensureConfig } from './config.js'
import { ensureState, hasToken } from './tokens.js'

const usage = (message: string, detail?: string): SbError => new SbError(message, EXIT.USAGE, detail)

/** realpath que aceita caminho inexistente: resolve o ancestral mais próximo que existe e reanexa o resto. */
function realpathLoose(path: string): string {
  const abs = resolve(path)
  let head = abs
  const tail: string[] = []
  while (!existsSync(head)) {
    const up = dirname(head)
    if (up === head) return abs
    tail.unshift(head.slice(up.length).replace(/^[/\\]+/, ''))
    head = up
  }
  try {
    return join(realpathSync(head), ...tail)
  } catch {
    return abs
  }
}

/** `dir` está em `root` ou abaixo dele? Por segmentos de caminho: `/p/bk` não contém `/p/bkx`. */
function contains(root: string, dir: string): boolean {
  const rel = relative(root, dir)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const depth = (p: string): number => p.split(sep).filter(Boolean).length

/**
 * O mux de uma pasta: o root MAIS PROFUNDO que a contém (realpath nos dois lados, `~` expandido pelo `home`),
 * senão `cfg.default`. Sem default e fora de todo root → exit 2.
 */
export function resolveMuxForDir(cfg: Config, dir: string, home: string): string {
  const target = realpathLoose(dir)
  let best: { name: string; depth: number } | undefined
  for (const [name, m] of Object.entries(cfg.mux)) {
    const root = realpathLoose(normalizeRoot(m.root, home))
    if (!contains(root, target)) continue
    const d = depth(root)
    if (!best || d > best.depth) best = { name, depth: d }
  }
  if (best) return best.name
  if (cfg.default !== undefined && cfg.default in cfg.mux) return cfg.default
  throw new SbError(
    `a pasta ${target} não está em nenhum mux e a config não tem \`default\``,
    EXIT.INVALID_CONFIG,
    '  defina `default` na config com o nome de um mux',
  )
}

export interface AddMuxOpts {
  root: string
  account: string
  /** padrão: `[account]` */
  accounts?: string[]
  /** padrão: `[]` (o mux nunca troca sozinho) */
  pool?: string[]
}

/**
 * Cria o mux na config e aponta `mux/<nome>.json` para a preferida. O 1º mux vira `default` no MESMO
 * lote de edições (tudo-ou-nada: a config só é válida com os dois). Preferida sem token → exit 3.
 */
export async function addMux(ctx: Ctx, name: string, o: AddMuxOpts): Promise<{ madeDefault: boolean }> {
  assertSafeName(name)
  assertSafeName(o.account)
  for (const a of [...(o.accounts ?? []), ...(o.pool ?? [])]) assertSafeName(a)
  if (!o.root) throw usage('--root não pode ser vazio')

  return withLock(ctx.paths, async () => {
    const hasConfig = existsSync(ctx.paths.configFile)
    const cfg = hasConfig ? await loadConfig(ctx.paths) : undefined
    if (cfg && name in cfg.mux) throw usage(`o mux "${name}" já existe`, `  mude-o com \`sb mux set ${name} …\``)
    if (o.account !== KEYCHAIN && !hasToken(ctx.paths, o.account)) {
      throw usage(`a conta preferida "${o.account}" não tem token: rode \`sb login ${o.account}\``)
    }
    if (!hasConfig) await ensureConfig(ctx.paths)

    const madeDefault = cfg?.default === undefined
    const edits: ConfigEdit[] = [
      { path: ['mux', name], value: { root: o.root, account: o.account, accounts: o.accounts ?? [o.account], pool: o.pool ?? [] } },
    ]
    if (madeDefault) edits.push({ path: ['default'], value: name })
    await editConfig(ctx.paths, edits)

    ensureState(ctx.paths)
    pointMux(ctx.paths, name, o.account)
    return { madeDefault }
  })
}

export interface SetMuxOpts {
  root?: string
  account?: string
  accounts?: string[]
  pool?: string[]
  /** torna este mux o `default` */
  default?: boolean
}

/**
 * Só edita a config (campos que mudam de fato). Não mexe no link: a conta atual não troca; a nova
 * preferência vale no próximo ciclo do `watch` ou com `sb swap`.
 */
export async function setMux(ctx: Ctx, name: string, p: SetMuxOpts): Promise<{ changed: string[] }> {
  assertSafeName(name)
  for (const a of [p.account, ...(p.accounts ?? []), ...(p.pool ?? [])]) if (a !== undefined) assertSafeName(a)
  if (p.root === '') throw usage('--root não pode ser vazio')

  return withLock(ctx.paths, async () => {
    const cfg = await loadConfig(ctx.paths)
    const m = cfg.mux[name]
    if (!m) throw usage(`mux inexistente: "${name}"`, `  muxes: ${Object.keys(cfg.mux).join(', ') || 'nenhum'}`)
    if (p.account !== undefined && p.account !== m.account && p.account !== KEYCHAIN && !hasToken(ctx.paths, p.account)) {
      throw usage(`a conta preferida "${p.account}" não tem token: rode \`sb login ${p.account}\``)
    }
    const edits: ConfigEdit[] = []
    const changed: string[] = []
    const set = (field: 'root' | 'account' | 'accounts' | 'pool', value: string | string[] | undefined): void => {
      if (value === undefined || JSON.stringify(value) === JSON.stringify(m[field])) return
      edits.push({ path: ['mux', name, field], value })
      changed.push(field)
    }
    set('root', p.root)
    set('account', p.account)
    set('accounts', p.accounts)
    set('pool', p.pool)
    if (p.default && cfg.default !== name) {
      edits.push({ path: ['default'], value: name })
      changed.push('default')
    }
    if (edits.length > 0) await editConfig(ctx.paths, edits)
    return { changed }
  })
}

/** Tira o mux da config e MANTÉM `mux/<nome>.json` (sessões abertas continuam abrindo; o doctor avisa o órfão). Recusa o `default`. */
export async function rmMux(ctx: Ctx, name: string): Promise<void> {
  assertSafeName(name)
  await withLock(ctx.paths, async () => {
    const cfg = await loadConfig(ctx.paths)
    if (!(name in cfg.mux)) throw usage(`mux inexistente: "${name}"`, `  muxes: ${Object.keys(cfg.mux).join(', ') || 'nenhum'}`)
    if (cfg.default === name) {
      throw usage(`"${name}" é o mux default`, `  torne outro o default antes: \`sb mux set <outro> --default\``)
    }
    await editConfig(ctx.paths, [{ path: ['mux', name], value: undefined }])
  })
}
