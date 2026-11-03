import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyEdits, modify, parse as parseJsonc, parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser'
import type { $ZodIssue } from 'zod/v4/core'
import { EXIT, SbError } from './errors.js'
import type { Paths } from './paths.js'
import { makeConfig, type Config } from './schema.js'

export type { Config, MuxConfig, SwapConfig, Threshold } from './schema.js'

/** Config inválida (exit 2). `detail` traz uma linha `caminho: mensagem` por problema. */
export class InvalidConfigError extends SbError {
  constructor(message: string, detail?: string) {
    super(message, EXIT.INVALID_CONFIG, detail)
    this.name = 'InvalidConfigError'
  }
}

const invalid = (file: string, lines: string[]): InvalidConfigError =>
  new InvalidConfigError(
    `config inválida (${file}): ${lines[0]}${lines.length > 1 ? ` (+${lines.length - 1})` : ''}`,
    lines.map((l) => `  ${l}`).join('\n'),
  )

/**
 * Chave repetida num objeto: o parser mantém a ÚLTIMA e descarta a anterior, sem erro.
 * É silencioso e caro, então vira config inválida (mesma regra do plugboard).
 */
function findDuplicateKeys(node: Node | undefined, path: string[] = [], out: string[] = []): string[] {
  if (!node) return out
  if (node.type === 'object') {
    const seen = new Set<string>()
    for (const prop of node.children ?? []) {
      const key = prop.children?.[0]?.value as string | undefined
      if (typeof key === 'string') {
        if (seen.has(key)) out.push([...path, key].join('.'))
        seen.add(key)
      }
      findDuplicateKeys(prop.children?.[1], key ? [...path, key] : path, out)
    }
  } else if (node.type === 'array') {
    for (const child of node.children ?? []) findDuplicateKeys(child, path, out)
  }
  return out
}

const TYPE_PT: Record<string, string> = {
  boolean: 'booleano (true ou false)',
  string: 'texto',
  number: 'número',
  array: 'lista',
  object: 'objeto',
  record: 'objeto',
}

/**
 * Mensagens do zod em português (as das invariantes já saem em português do superRefine).
 * Precisa de `reportInput: true` no parse: sem ele `issue.input` nunca vem, e não dá para
 * distinguir campo ausente (`input === undefined`) de campo presente com tipo errado.
 */
function ptMessage(i: $ZodIssue): string {
  switch (i.code) {
    case 'unrecognized_keys':
      return `chave desconhecida: ${i.keys.map((k) => `"${k}"`).join(', ')}`
    case 'invalid_type':
      return i.input === undefined ? 'campo obrigatório' : `tipo inválido: esperado ${TYPE_PT[i.expected] ?? i.expected}`
    case 'too_small':
      if (i.origin === 'array') return `precisa de pelo menos ${String(i.minimum)} item`
      if (i.origin === 'number') return `deve ser ${i.inclusive ? 'no mínimo' : 'maior que'} ${String(i.minimum)}`
      return i.message
    case 'too_big':
      return i.origin === 'number' ? `deve ser ${i.inclusive ? 'no máximo' : 'menor que'} ${String(i.maximum)}` : i.message
    case 'invalid_key':
      return 'nome inválido — use minúsculas, números, - e _ (até 32)'
    case 'invalid_value':
      if (i.input === undefined) return 'campo obrigatório'
      return `valor inválido (esperado ${i.values.map((v) => JSON.stringify(v)).join(' ou ')})`
    default:
      return i.message
  }
}

/** `home` (o HOME do ambiente) só serve para expandir `~` ao comparar roots. */
export function parseConfig(text: string, file: string, home?: string): Config {
  const errors: ParseError[] = []
  const raw: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    throw invalid(
      file,
      errors.map((e) => `(raiz): JSONC malformado — ${printParseErrorCode(e.error)} na posição ${e.offset}`),
    )
  }

  const dupes = findDuplicateKeys(parseTree(text, [], { allowTrailingComma: true }))
  if (dupes.length > 0) {
    throw invalid(
      file,
      dupes.map((d) => `chave duplicada: "${d}" — a última vence e a anterior seria descartada em silêncio`),
    )
  }

  const parsed = makeConfig(home).safeParse(raw, { reportInput: true })
  if (!parsed.success) {
    throw invalid(
      file,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${ptMessage(i)}`),
    )
  }
  return parsed.data
}

async function readConfigText(paths: Paths): Promise<string> {
  try {
    return await readFile(paths.configFile, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new InvalidConfigError(
        `config não encontrada: ${paths.configFile}`,
        '  rode `sb login <conta>` para criar a config e registrar a primeira conta',
      )
    }
    throw e
  }
}

export async function loadConfig(paths: Paths): Promise<Config> {
  return parseConfig(await readConfigText(paths), paths.configFile, paths.home)
}

export interface ConfigEdit {
  /** Caminho no JSON; o índice `-1` num array insere no fim. `value: undefined` remove. */
  path: (string | number)[]
  value: unknown
}

/**
 * Edita o texto com `jsonc-parser` (comentários e formatação ficam), valida o resultado inteiro
 * e só então grava (arquivo temporário + rename). Inválido → lança e o arquivo fica como estava.
 */
export async function editConfig(paths: Paths, edits: ConfigEdit[]): Promise<Config> {
  let text = await readConfigText(paths)
  for (const e of edits) {
    text = applyEdits(text, modify(text, e.path, e.value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }))
  }
  const config = parseConfig(text, paths.configFile, paths.home)
  const tmp = `${paths.configFile}.${process.pid}.tmp`
  try {
    await writeFile(tmp, text)
    await rename(tmp, paths.configFile)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
  return config
}

/** URL do `schema.json` do pacote: sobe do módulo (src/core, ou dist/) até a raiz (onde está o package.json). */
function packageSchemaUrl(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return pathToFileURL(join(dir, 'schema.json')).href
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Cria a config mínima se não existir (nunca sobrescreve). */
export async function ensureConfig(paths: Paths): Promise<void> {
  const schema = packageSchemaUrl()
  const initial = { ...(schema ? { $schema: schema } : {}), switchboard: 1, accounts: {}, mux: {} }
  await mkdir(dirname(paths.configFile), { recursive: true })
  try {
    await writeFile(paths.configFile, `${JSON.stringify(initial, null, 2)}\n`, { flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
}

const UNITS = { s: 1_000, m: 60_000, h: 3_600_000 } as const

/** `30s`, `5m`, `1h` → milissegundos. */
export function parseDuration(text: string): number {
  const m = /^([1-9]\d*)([smh])$/.exec(text)
  if (!m) throw new SbError(`duração inválida: "${text}" (use 30s, 5m ou 1h)`, EXIT.USAGE)
  return Number(m[1]) * UNITS[m[2] as keyof typeof UNITS]
}
