import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { EXIT, SbError } from './errors.js'
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
  try {
    // arquivo comum no lugar do link (editor que salva trocando o arquivo): o mux deixaria de seguir os swaps
    if (!lstatSync(link).isSymbolicLink()) return { ok: false, problem: 'broken' }
  } catch {
    return { ok: false, problem: 'missing-link' }
  }
  let real: string
  let text: string
  try {
    real = realpathSync(link)
    if (!statSync(real).isFile()) return { ok: false, problem: 'broken' }
    text = readFileSync(real, 'utf8')
  } catch {
    return { ok: false, problem: 'broken' }
  }
  // o alvo REAL tem que estar em <estado>/tokens (o link fica em <estado>/mux ou <estado>/pins); fora disso, falha fechada
  try {
    if (dirname(real) !== realpathSync(join(dirname(dirname(link)), 'tokens'))) return { ok: false, problem: 'broken' }
  } catch {
    return { ok: false, problem: 'broken' }
  }
  const account = accountOf(real)
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

const PROBLEM: Record<TargetProblem, string> = {
  'missing-link': 'o link do mux não existe',
  broken: 'o link do mux está quebrado (não aponta para um token em tokens/)',
  'invalid-json': 'o token do mux tem JSON inválido (o claude ignoraria o settings e cairia no keychain)',
  'no-oauth': 'o token do mux não tem CLAUDE_CODE_OAUTH_TOKEN',
}

/**
 * Falha fechado (F6): `checkSettingsTarget` e, se o link não serve, `SbError` exit 1 com o problema e a dica do
 * doctor. Devolve a conta para a qual o link aponta. É o que `sb which` e a abertura do `claude` compartilham.
 */
export function assertSettingsTarget(link: string, mux: string): string {
  const check = checkSettingsTarget(link)
  if (!check.ok) throw new SbError(`mux "${mux}": ${PROBLEM[check.problem]} (${link})`, EXIT.CHECK_FAILED, '  rode `sb doctor --fix`')
  return check.account
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
