import { resolve } from 'node:path'
import { z } from 'zod'

/** Reservado: a conta do keychain do Claude Code. Não se registra e não entra em pool. */
export const KEYCHAIN = 'keychain'

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const NAME_MSG = 'nome inválido: use a-z, 0-9, "_" e "-", começando por letra ou número (até 32 caracteres)'

export const AccountName = z.string().regex(NAME_RE, NAME_MSG)
/** Vira nome de arquivo (`mux/<nome>.json`), então segue a mesma regra das contas. */
export const MuxName = z.string().regex(NAME_RE, NAME_MSG)
/** Nome de conta válido ou `keychain`. */
export const AccountRef = AccountName

const Duration = z
  .string()
  .regex(/^[1-9]\d*[smh]$/, 'duração inválida: use um número seguido de s, m ou h (ex.: 30s, 5m, 1h)')

const Fraction = z.number().gt(0).max(1)

export const Threshold = z.strictObject({
  fiveHour: Fraction.default(0.9).meta({ description: 'Utilização (0–1] da janela de 5 h a partir da qual a conta troca' }),
  sevenDay: Fraction.default(0.95).meta({ description: 'Utilização (0–1] da janela de 7 dias a partir da qual a conta troca' }),
})

export const SwapConfig = z.strictObject({
  auto: z.boolean().default(true).meta({ description: 'O watch troca sozinho ao passar do limiar' }),
  threshold: Threshold.prefault({}),
  returnOnReset: z.boolean().default(true).meta({ description: 'Volta à conta preferida quando a janela dela reinicia' }),
  probeEvery: Duration.default('5m').meta({ description: 'Intervalo entre medições de uso: 30s, 5m, 1h' }),
})

export const MuxConfig = z.strictObject({
  root: z.string().min(1).meta({ description: 'Pasta raiz do mux (aceita ~)' }),
  account: AccountRef.meta({ description: 'Conta preferida; tem de estar em accounts' }),
  accounts: z.array(AccountRef).min(1).meta({ description: 'Contas que o mux pode usar' }),
  pool: z.array(AccountRef).default([]).meta({ description: 'Contas do hot-swap, em ordem de prioridade; subconjunto de accounts' }),
})

/** `~` → `home` e `path.resolve`: é a identidade de um root para detectar repetição. */
export function normalizeRoot(root: string, home: string): string {
  if (root === '~') return resolve(home)
  if (root.startsWith('~/')) return resolve(home, root.slice(2))
  return resolve(root)
}

/** Marcador de `~` quando ninguém passa o HOME (ex.: gerar o schema.json): só serve para comparar roots entre si. */
const NO_HOME = '/\u0000home'

/**
 * O schema da config. `home` só entra na checagem de root repetido (`~` expandido); o schema.json
 * é gerado sem ele. Zod é a fonte única: tipos, defaults, schema.json e invariantes saem daqui.
 */
export function makeConfig(home: string = NO_HOME) {
  return z
    .strictObject({
      $schema: z.string().optional(),
      switchboard: z.literal(1).meta({ description: 'Versão do formato' }),
      accounts: z.record(AccountName, z.strictObject({})).meta({ description: 'Registro de contas; os tokens ficam em tokens/, fora da config' }),
      swap: SwapConfig.prefault({}),
      default: z.string().optional().meta({ description: 'Mux para pastas que não casam com nenhum root; obrigatório se há mux' }),
      mux: z.record(MuxName, MuxConfig),
    })
    .superRefine((c, ctx) => {
      const issue = (path: (string | number)[], message: string): void => {
        ctx.addIssue({ code: 'custom', path, message })
      }
      const registered = new Set(Object.keys(c.accounts))

      if (registered.has(KEYCHAIN)) {
        issue(['accounts', KEYCHAIN], '"keychain" é reservado (é a conta do keychain do Claude Code): não se registra')
      }

      const roots = new Map<string, string>()
      for (const [name, m] of Object.entries(c.mux)) {
        const at = (...rest: (string | number)[]): (string | number)[] => ['mux', name, ...rest]

        const seenAccounts = new Set<string>()
        m.accounts.forEach((a, i) => {
          if (seenAccounts.has(a)) issue(at('accounts', i), `conta repetida em accounts: "${a}"`)
          seenAccounts.add(a)
          if (a !== KEYCHAIN && !registered.has(a)) {
            issue(at('accounts', i), `conta "${a}" não está registrada em accounts (rode \`sb login ${a}\`)`)
          }
        })

        if (!seenAccounts.has(m.account)) {
          issue(at('account'), `a conta preferida "${m.account}" precisa estar em mux.${name}.accounts`)
        }

        const seenPool = new Set<string>()
        m.pool.forEach((a, i) => {
          if (seenPool.has(a)) issue(at('pool', i), `conta repetida no pool: "${a}"`)
          seenPool.add(a)
          if (a === KEYCHAIN) {
            issue(at('pool', i), '"keychain" não pode entrar no pool: ele nunca troca sozinho')
            return
          }
          if (!seenAccounts.has(a)) issue(at('pool', i), `a conta "${a}" do pool precisa estar em mux.${name}.accounts`)
          if (!registered.has(a)) issue(at('pool', i), `conta "${a}" não está registrada em accounts (rode \`sb login ${a}\`)`)
        })

        const key = normalizeRoot(m.root, home)
        const first = roots.get(key)
        if (first !== undefined) issue(at('root'), `root repetido: "${m.root}" é o mesmo de mux.${first}.root`)
        else roots.set(key, name)
      }

      const muxNames = Object.keys(c.mux)
      if (c.default === undefined) {
        if (muxNames.length > 0) issue(['default'], 'obrigatório quando há mux: diga qual vale para pastas fora de todo root')
      } else if (!muxNames.includes(c.default)) {
        issue(['default'], `"${c.default}" não é um mux definido (${muxNames.length ? muxNames.join(', ') : 'nenhum definido'})`)
      }
    })
}

export const Config = makeConfig()

export type Config = z.output<typeof Config>
export type SwapConfig = z.output<typeof SwapConfig>
export type Threshold = z.output<typeof Threshold>
export type MuxConfig = z.output<typeof MuxConfig>
