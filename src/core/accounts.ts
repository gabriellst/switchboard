import { rmSync } from 'node:fs'
import { loadConfig, editConfig, type Config, type ConfigEdit, type MuxConfig } from './config.js'
import type { Ctx } from './ctx.js'
import { EXIT, SbError } from './errors.js'
import { withLock } from './fsx.js'
import { currentAccount } from './links.js'
import { assertSafeName, tokenFile } from './paths.js'
import { KEYCHAIN } from './schema.js'
import { hasToken } from './tokens.js'

/** Como a conta entra num mux. `pool`: `true` = fim da fila; número = posição 1-based. */
export interface AttachSpec {
  mux: string
  pool?: boolean | number
  preferred?: boolean
}

export type Change = 'accounts' | 'pool' | 'preferred'

const usage = (message: string, detail?: string): SbError => new SbError(message, EXIT.USAGE, detail)

export function requireMux(cfg: Config, mux: string): MuxConfig {
  const m = cfg.mux[mux]
  if (m) return m
  const known = Object.keys(cfg.mux)
  throw usage(`mux inexistente: "${mux}"`, `  ${known.length ? `muxes: ${known.join(', ')}` : 'nenhum mux definido; crie um com `sb mux add`'}`)
}

/** Recusas que não dependem da config (nomes, posição do pool, keychain no pool): exit 3. Também vale antes de um login. */
export function checkAttachSpec(account: string, spec: AttachSpec): void {
  assertSafeName(account)
  assertSafeName(spec.mux)
  const { pool } = spec
  if (typeof pool === 'number' && (!Number.isInteger(pool) || pool < 1)) throw usage(`posição inválida no pool: ${pool} (use um inteiro a partir de 1)`)
  if (account === KEYCHAIN && pool !== undefined && pool !== false) {
    throw usage('"keychain" não pode entrar no pool: ele nunca troca sozinho', '  anexe sem --pool / --at')
  }
}

/**
 * Anexa a conta ao mux: entra em `accounts`, opcionalmente no `pool` (fim ou posição) e/ou vira a preferida.
 * Idempotente. Mudar a preferida não troca a conta atual: vale no próximo ciclo do `watch` ou com `sb swap`.
 * Toda a edição é um único `editConfig` sob o lock (tudo-ou-nada; as invariantes da config valem).
 */
export async function attachAccount(ctx: Ctx, account: string, spec: AttachSpec): Promise<{ changed: Change[] }> {
  checkAttachSpec(account, spec)
  const { pool } = spec

  return withLock(ctx.paths, async () => {
    const cfg = await loadConfig(ctx.paths)
    const m = requireMux(cfg, spec.mux)
    // `keychain` não se registra nem guarda token; qualquer outra conta precisa de ambos
    if (account !== KEYCHAIN && (!(account in cfg.accounts) || !hasToken(ctx.paths, account))) {
      throw usage(`a conta "${account}" não está pronta (sem registro ou sem token): rode \`sb login ${account} --attach ${spec.mux}\``)
    }

    const at = (...rest: (string | number)[]): (string | number)[] => ['mux', spec.mux, ...rest]
    const edits: ConfigEdit[] = []
    const changed: Change[] = []

    if (!m.accounts.includes(account)) {
      edits.push({ path: at('accounts', -1), value: account })
      changed.push('accounts')
    }

    if (pool !== undefined && pool !== false) {
      const idx = m.pool.indexOf(account)
      if (pool === true) {
        // sem posição: entra no fim; quem já está no pool fica onde está
        if (idx < 0) {
          edits.push({ path: at('pool', -1), value: account })
          changed.push('pool')
        }
      } else {
        // posição pedida (inserir ou mover); além do fim = fim
        const rest = m.pool.filter((a) => a !== account)
        const k = Math.min(pool - 1, rest.length)
        const next = [...rest.slice(0, k), account, ...rest.slice(k)]
        if (next.join('\0') !== m.pool.join('\0')) {
          edits.push({ path: at('pool'), value: next })
          changed.push('pool')
        }
      }
    }

    if (spec.preferred && m.account !== account) {
      edits.push({ path: at('account'), value: account })
      changed.push('preferred')
    }

    if (edits.length > 0) await editConfig(ctx.paths, edits)
    return { changed }
  })
}

/** Tira a conta de `accounts` e do `pool` do mux. Recusa a preferida e a conta atual (exit 3). */
export async function detachAccount(ctx: Ctx, account: string, mux: string): Promise<{ changed: Change[] }> {
  assertSafeName(account)
  assertSafeName(mux)
  return withLock(ctx.paths, async () => {
    const cfg = await loadConfig(ctx.paths)
    const m = requireMux(cfg, mux)
    if (!m.accounts.includes(account)) throw usage(`"${account}" não está anexada ao mux "${mux}"`)
    if (m.account === account) {
      throw usage(`"${account}" é a preferida do mux "${mux}": defina outra com \`sb attach <outra> ${mux} --preferred\``)
    }
    if (currentAccount(ctx.paths, mux) === account) {
      throw usage(`"${account}" é a conta atual do mux "${mux}": faça \`sb swap ${mux}\` antes`)
    }
    // arrays inteiros, não remoção por índice: o `modify` do jsonc-parser corrompe o texto ao apagar o último
    // elemento de um array escrito numa linha só
    const edits: ConfigEdit[] = [{ path: ['mux', mux, 'accounts'], value: m.accounts.filter((a) => a !== account) }]
    const changed: Change[] = ['accounts']
    if (m.pool.includes(account)) {
      edits.push({ path: ['mux', mux, 'pool'], value: m.pool.filter((a) => a !== account) })
      changed.push('pool')
    }
    await editConfig(ctx.paths, edits)
    return { changed }
  })
}

/** Apaga o registro e o token da conta. Recusa sem `yes` e conta anexada a algum mux (exit 3). */
export async function removeAccount(ctx: Ctx, account: string, o: { yes: boolean }): Promise<void> {
  assertSafeName(account)
  if (account === KEYCHAIN) throw usage('"keychain" é reservado: não se registra nem se remove')
  if (!o.yes) {
    throw usage(`remover "${account}" apaga o token (só voltando a fazer \`sb login ${account}\`): confirme com \`sb accounts rm ${account} --yes\``)
  }
  await withLock(ctx.paths, async () => {
    const cfg = await loadConfig(ctx.paths)
    if (!(account in cfg.accounts)) throw usage(`a conta "${account}" não está registrada`)
    const attached = Object.entries(cfg.mux)
      .filter(([, m]) => m.accounts.includes(account))
      .map(([name]) => name)
    if (attached.length > 0) {
      throw usage(
        `a conta "${account}" está anexada a: ${attached.join(', ')}`,
        attached.map((mux) => `  desanexe com \`sb detach ${account} ${mux}\``).join('\n'),
      )
    }
    // config primeiro: se ela não validar, o token continua no lugar
    await editConfig(ctx.paths, [{ path: ['accounts', account], value: undefined }])
    rmSync(tokenFile(ctx.paths, account), { force: true })
  })
}
