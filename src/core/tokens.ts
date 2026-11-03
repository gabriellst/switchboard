import { chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT, SbError } from './errors.js'
import { mkdirPrivate, writeAtomic } from './fsx.js'
import { tokenFile, type Paths } from './paths.js'

/** Nome reservado: usa o keychain do `claude`; nunca é medido nem guarda token. */
export const KEYCHAIN = 'keychain'

const SUBDIRS = ['tokens', 'mux', 'pins', 'log', 'backup'] as const

/** Raiz e subdiretórios em 700 (corrige modo de quem já existe); `tokens/keychain.json` é sempre `{}` em 600. */
export function ensureState(paths: Paths): void {
  mkdirPrivate(paths.stateDir)
  for (const d of SUBDIRS) mkdirPrivate(join(paths.stateDir, d))
  const keychain = tokenFile(paths, KEYCHAIN)
  let current: string | null = null
  try {
    current = readFileSync(keychain, 'utf8')
  } catch {
    // ausente: criado abaixo
  }
  // `{}` é como se representa "keychain" (F6): qualquer outra coisa ali faria a sessão rodar em outra conta
  if (current === null || !isEmptyObject(current)) writeAtomic(keychain, '{}', 0o600)
  else chmodSync(keychain, 0o600)
}

function isEmptyObject(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0
  } catch {
    return false
  }
}

export function saveToken(paths: Paths, account: string, token: string): void {
  const file = tokenFile(paths, account) // valida o nome
  if (account === KEYCHAIN) throw new SbError('"keychain" é um nome reservado: não guarda token', EXIT.USAGE)
  if (!token) throw new SbError('token vazio', EXIT.USAGE)
  ensureState(paths)
  writeAtomic(file, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: token } }), 0o600)
}

function readToken(paths: Paths, account: string): string | null {
  if (account === KEYCHAIN) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(tokenFile(paths, account), 'utf8'))
  } catch {
    return null
  }
  const env = (raw as { env?: unknown } | null)?.env
  const token = (env as { CLAUDE_CODE_OAUTH_TOKEN?: unknown } | null | undefined)?.CLAUDE_CODE_OAUTH_TOKEN
  return typeof token === 'string' && token !== '' ? token : null
}

/**
 * A ÚNICA função que devolve um token. Só a sonda, o login e a migração a chamam; nada mais lê
 * segredo, e nenhum erro, log ou `--json` pode conter o valor.
 */
export function loadSecret(paths: Paths, account: string): string | null {
  return readToken(paths, account)
}

/** A conta tem token utilizável? (Não expõe o valor.) */
export function hasToken(paths: Paths, account: string): boolean {
  return readToken(paths, account) !== null
}

export type TokenStatus = 'ok' | 'missing' | 'invalid-json'

/**
 * Estado do arquivo de token, sem expor o valor: `missing` (sem arquivo, ou sem token dentro),
 * `invalid-json` (arquivo ilegível ou de outra forma) ou `ok`. `keychain` nunca guarda token → `missing`.
 */
export function tokenStatus(paths: Paths, account: string): TokenStatus {
  if (account === KEYCHAIN) return 'missing'
  let text: string
  try {
    text = readFileSync(tokenFile(paths, account), 'utf8')
  } catch {
    return 'missing'
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return 'invalid-json'
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'invalid-json'
  return readToken(paths, account) === null ? 'missing' : 'ok'
}
