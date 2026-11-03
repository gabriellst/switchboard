import { lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { symlinkAtomic } from './fsx.js'
import { muxLink, pinLink, tokenFile, type Paths } from './paths.js'
import { KEYCHAIN } from './tokens.js'

/** Por que um link de settings não serve (F6): cada caso vira uma mensagem diferente para o usuário. */
export type TargetProblem = 'missing-link' | 'broken' | 'invalid-json' | 'no-oauth'

export type TargetCheck = { ok: true; account: string } | { ok: false; problem: TargetProblem }

const accountOf = (target: string): string => basename(target).replace(/\.json$/, '')

/**
 * Confere o que `claude --settings <link>` vai encontrar. Link ausente ou quebrado o `claude` recusa
 * (seguro); JSON inválido ele ignora e roda no keychain (perigoso); então tudo isso precisa ser
 * detectado aqui. `keychain` só é válido se o alvo é exatamente `{}`.
 */
export function checkSettingsTarget(link: string): TargetCheck {
  let isLink: boolean
  try {
    isLink = lstatSync(link).isSymbolicLink()
  } catch {
    return { ok: false, problem: 'missing-link' }
  }
  let text: string
  try {
    statSync(link)
    text = readFileSync(link, 'utf8')
  } catch {
    return { ok: false, problem: 'broken' }
  }
  const account = accountOf(isLink ? readlinkSync(link) : link)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, problem: 'invalid-json' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, problem: 'invalid-json' }
  const obj = parsed as Record<string, unknown>
  if (account === KEYCHAIN) {
    // qualquer coisa além de `{}` aqui (inclusive um token) faria a sessão rodar noutra conta
    return Object.keys(obj).length === 0 ? { ok: true, account } : { ok: false, problem: 'invalid-json' }
  }
  const token = (obj.env as { CLAUDE_CODE_OAUTH_TOKEN?: unknown } | null | undefined)?.CLAUDE_CODE_OAUTH_TOKEN
  if (typeof token !== 'string' || token === '') return { ok: false, problem: 'no-oauth' }
  return { ok: true, account }
}

/** `mux/<mux>.json` passa a apontar para `tokens/<conta>.json`, num único `rename`. */
export function pointMux(paths: Paths, mux: string, account: string): void {
  symlinkAtomic(muxLink(paths, mux), tokenFile(paths, account))
}

/** Garante `pins/<conta>.json` → `tokens/<conta>.json` e devolve o caminho do link. */
export function ensurePin(paths: Paths, account: string): string {
  const link = pinLink(paths, account)
  const target = tokenFile(paths, account)
  let current: string | null = null
  try {
    current = readlinkSync(link)
  } catch {
    // ausente (ou não é link): recria
  }
  if (current !== target) symlinkAtomic(link, target)
  return link
}

/** Conta para a qual o mux aponta agora (basename do `readlink`, sem `.json`); `null` sem link. */
export function currentAccount(paths: Paths, mux: string): string | null {
  try {
    return accountOf(readlinkSync(muxLink(paths, mux)))
  } catch {
    return null
  }
}
