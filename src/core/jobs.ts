import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { assertSessionId } from './claude.js'
import { EXIT, SbError } from './errors.js'
import { writeAtomic } from './fsx.js'
import { assertSafeName, type Paths } from './paths.js'

// ---------------------------------------------------------------------------------------------------------------
// `~/.claude/jobs/<id>/state.json` e os flags de reabertura (`respawnFlags`). Formato INTERNO do Claude Code: só
// o que o `sb` usa é exigido; o resto passa intacto (looseObject). Divergência → `SbError` exit 4.
// ---------------------------------------------------------------------------------------------------------------

/** Campo opcional que o daemon às vezes grava como `null`: `null` e ausente são a mesma coisa. */
const opt = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === null ? undefined : v), schema.optional())

const InFlightSchema = z.looseObject({
  tasks: z.number(),
  queued: z.number(),
  kinds: z.array(z.string()),
  // ausente logo depois de um respawn (F13)
  drainableMonitors: z.number().optional(),
})

const JobStateSchema = z.looseObject({
  respawnFlags: z.array(z.string()),
  inFlight: opt(InFlightSchema),
  state: opt(z.string()),
  needs: opt(z.string()),
  detail: opt(z.string()),
  cwd: opt(z.string()),
})

export interface JobState {
  /** o argv com que o daemon reabre a sessão (preserva ordem e repetições) */
  respawnFlags: string[]
  /** pode faltar (sessão parada) ou não ter `drainableMonitors` */
  inFlight?: { tasks: number; queued: number; kinds: string[]; drainableMonitors?: number }
  state?: string
  needs?: string
  detail?: string
  cwd?: string
  [extra: string]: unknown
}

const DOCTOR = 'o formato interno do claude pode ter mudado numa atualização; rode `sb doctor`'

const jobFile = (paths: Paths, id: string): string => join(paths.jobsDir, assertSessionId(id), 'state.json')

interface Loaded {
  text: string
  raw: Record<string, unknown>
  state: JobState
}

/** `null` se o arquivo não existe; `SbError` exit 4 se existe e não tem a forma esperada. */
function load(file: string, id: string): Loaded | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new SbError(`não consegui ler o state.json da sessão ${id} (${(e as NodeJS.ErrnoException).code ?? 'erro'}); rode \`sb doctor\``, EXIT.CLAUDE)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new SbError(`o state.json da sessão ${id} não é JSON válido; ${DOCTOR}`, EXIT.CLAUDE)
  }
  const parsed = JobStateSchema.safeParse(raw)
  if (!parsed.success) {
    const field = parsed.error.issues[0]!.path.map(String).join('.') || 'raiz'
    throw new SbError(`formato inesperado no state.json da sessão ${id} (campo \`${field}\` ausente ou com tipo inesperado); ${DOCTOR}`, EXIT.CLAUDE)
  }
  return { text, raw: raw as Record<string, unknown>, state: parsed.data as JobState }
}

/** `state.json` da sessão; `null` se não existe; `SbError` exit 4 se tem formato inesperado; id fora de 8 hex → exit 3. */
export function readJobState(paths: Paths, id: string): JobState | null {
  return load(jobFile(paths, id), id)?.state ?? null
}

/** Permissões atuais do arquivo (só os 9 bits); 644 se não der para ler. */
const modeOf = (file: string): number => {
  try {
    return statSync(file).mode & 0o777
  } catch {
    return 0o644
  }
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i])
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/**
 * Reescreve só `respawnFlags` (`transform` recebe o argv atual). O CHAMADOR garante que a sessão está PARADA: o
 * daemon regrava o `state.json` enquanto ela vive. Passos: copia o arquivo para `backup` (um arquivo; se for um
 * diretório existente, vira `<backup>/<id>.state.json`), RELÊ o `state.json` imediatamente antes de gravar (o que o
 * daemon mudou nesse meio-tempo sobrevive; o backup passa a guardar a versão relida), grava atômico PRESERVANDO o modo do arquivo (600 não vira
 * legível por todos: `respawnFlags` pode ter um `--settings` inline com env; 644 se não der para ler o modo) e confere
 * relendo. `false`: sem `state.json`, `transform` devolveu algo que não é lista de texto, ou a conferência falhou.
 */
export function writeJobFlags(
  paths: Paths,
  id: string,
  transform: (flags: string[]) => string[],
  backup: string,
  hooks: { afterBackup?: () => void } = {},
): boolean {
  const file = jobFile(paths, id)
  const first = load(file, id)
  if (first === null) return false
  const backupFile = existsSync(backup) && statSync(backup).isDirectory() ? join(backup, `${id}.state.json`) : backup
  mkdirSync(dirname(backupFile), { recursive: true, mode: 0o700 })
  writeAtomic(backupFile, first.text, 0o600)
  hooks.afterBackup?.() // costura de teste: o daemon regravando o arquivo aqui

  const cur = load(file, id)
  if (cur === null) return false
  if (cur.text !== first.text) writeAtomic(backupFile, cur.text, 0o600)
  const next: unknown = transform([...cur.state.respawnFlags])
  if (!isStringArray(next)) return false
  if (sameList(next, cur.state.respawnFlags)) return true
  const text = JSON.stringify({ ...cur.raw, respawnFlags: next }, null, 2) + (cur.text.endsWith('\n') ? '\n' : '')
  writeAtomic(file, text, modeOf(file))
  const after = load(file, id)
  return after !== null && sameList(after.state.respawnFlags, next)
}

// ------------------------------------------------------------------------------------------------ flags --settings

/** Valores de `--settings X` e `--settings=X`, na ordem. `--settings` sem valor (último argumento) é ignorado. */
export function settingsValues(flags: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!
    if (f === '--settings') {
      if (i + 1 < flags.length) out.push(flags[++i]!)
    } else if (f.startsWith('--settings=')) out.push(f.slice('--settings='.length))
  }
  return out
}

export type Ownership =
  | { kind: 'mux'; mux: string }
  | { kind: 'pin'; account: string }
  | { kind: 'legacy' }
  | { kind: 'foreign'; path: string }
  | { kind: 'none' }

/** `realpath` do diretório mais próximo que existe + o resto do caminho (os diretórios de estado podem não existir ainda). */
function realish(p: string): string {
  const rest: string[] = []
  let cur = p
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest)
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return p
      rest.unshift(basename(cur))
      cur = parent
    }
  }
}

/** `--settings` com JSON inline pode conter token: nunca entra no resultado. */
const INLINE = '<JSON inline>'

type OursOrForeign = Exclude<Ownership, { kind: 'none' }>

function classify(value: string, paths: Paths): OursOrForeign {
  const foreign: OursOrForeign = { kind: 'foreign', path: value.trimStart().startsWith('{') ? INLINE : value }
  const v = value === '~' ? paths.home : value.startsWith('~/') ? join(paths.home, value.slice(2)) : value
  if (!isAbsolute(v)) return foreign // relativo é contra o cwd da sessão, que não conhecemos: nunca adivinhamos
  const full = resolve(v)
  const dir = realish(dirname(full)) // o componente FINAL (o link) nunca é seguido: o dono é o caminho, não o alvo
  const base = basename(full)
  const at = (d: string): boolean => realish(d) === dir
  const name = base.endsWith('.json') ? base.slice(0, -'.json'.length) : null
  const safe = (): string | null => {
    if (name === null) return null
    try {
      return assertSafeName(name)
    } catch {
      return null
    }
  }
  if (at(join(paths.stateDir, 'mux'))) {
    const n = safe()
    return n === null ? foreign : { kind: 'mux', mux: n }
  }
  if (at(join(paths.stateDir, 'pins'))) {
    const n = safe()
    return n === null ? foreign : { kind: 'pin', account: n }
  }
  if (at(join(paths.claudeDir, 'contas')) || at(join(paths.claudeDir, 'contas-fixas'))) return { kind: 'legacy' }
  return foreign
}

/**
 * Dono da sessão pelo CAMINHO do `--settings` (nunca pelo alvo do link nem pelo cwd): `<estado>/mux`, `<estado>/pins`,
 * `~/.claude/contas` e `~/.claude/contas-fixas` (legado). Vários nossos: vale o último; nosso vale mais que de terceiros.
 */
export function ownershipOf(flags: string[], paths: Paths): Ownership {
  let ours: OursOrForeign | undefined
  let foreign: OursOrForeign | undefined
  for (const v of settingsValues(flags)) {
    const c = classify(v, paths)
    if (c.kind === 'foreign') foreign = c
    else ours = c
  }
  return ours ?? foreign ?? { kind: 'none' }
}

/**
 * Tira os `--settings` NOSSOS (mux, pin, legado; as duas formas), mantém todo o resto na ordem (inclusive `--settings`
 * de terceiros e `--allowed-tools` repetidos) e acrescenta `--settings newPath`. Um `--settings` sem valor no fim é
 * descartado (senão engoliria o `--settings` novo).
 */
export function replaceSettings(flags: string[], newPath: string, paths: Paths): string[] {
  const isOurs = (v: string): boolean => classify(v, paths).kind !== 'foreign'
  const out: string[] = []
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!
    if (f === '--settings') {
      if (i + 1 >= flags.length) continue
      const v = flags[++i]!
      if (!isOurs(v)) out.push(f, v)
    } else if (f.startsWith('--settings=')) {
      if (!isOurs(f.slice('--settings='.length))) out.push(f)
    } else out.push(f)
  }
  out.push('--settings', newPath)
  return out
}
