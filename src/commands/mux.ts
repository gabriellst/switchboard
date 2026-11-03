import { defineCommand } from 'citty'
import { loadConfig } from '../core/config.js'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { currentAccount } from '../core/links.js'
import { addMux, rmMux, setMux } from '../core/mux.js'
import { renderMuxList, type MuxRow } from '../report.js'
import { guarded } from './guard.js'

const csv = (text: string | undefined): string[] | undefined =>
  text === undefined
    ? undefined
    : text
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

export async function muxRows(ctx: Ctx): Promise<MuxRow[]> {
  const cfg = await loadConfig(ctx.paths)
  return Object.entries(cfg.mux).map(([name, m]) => ({
    name,
    root: m.root,
    default: cfg.default === name,
    current: currentAccount(ctx.paths, name),
    preferred: m.account,
    accounts: m.accounts,
    pool: m.pool,
  }))
}

const jsonArg = { json: { type: 'boolean', description: 'Saída em JSON' } } as const

const list = defineCommand({
  meta: { name: 'list', description: 'Lista os muxes' },
  args: jsonArg,
  run: guarded(async ({ args }) => {
    const rows = await muxRows(defaultCtx())
    process.stdout.write(args.json === true ? `${JSON.stringify(rows, null, 2)}\n` : renderMuxList(rows))
  }),
})

const add = defineCommand({
  meta: { name: 'add', description: 'Cria um mux e aponta o link para a conta preferida (o 1º vira o default)' },
  args: {
    name: { type: 'positional', required: true, description: 'Nome do mux' },
    root: { type: 'string', required: true, description: 'Pasta raiz (aceita ~)' },
    account: { type: 'string', required: true, description: 'Conta preferida (precisa de token)' },
    accounts: { type: 'string', description: 'Contas permitidas, separadas por vírgula (padrão: só a preferida)' },
    pool: { type: 'string', description: 'Fila do hot-swap, separada por vírgula; a ordem é a prioridade (padrão: vazio)' },
  },
  run: guarded(async ({ args }) => {
    const accounts = csv(args.accounts)
    const pool = csv(args.pool)
    const { madeDefault } = await addMux(defaultCtx(), args.name, {
      root: args.root,
      account: args.account,
      ...(accounts && { accounts }),
      ...(pool && { pool }),
    })
    process.stdout.write(`mux ${args.name} criado, apontando para ${args.account}${madeDefault ? ' (é o default)' : ''}\n`)
  }),
})

const set = defineCommand({
  meta: { name: 'set', description: 'Muda root, preferida, accounts ou pool de um mux (só a config; a conta atual não troca)' },
  args: {
    name: { type: 'positional', required: true, description: 'Mux' },
    root: { type: 'string', description: 'Nova pasta raiz' },
    account: { type: 'string', description: 'Nova preferida' },
    accounts: { type: 'string', description: 'Contas permitidas (lista separada por vírgula)' },
    pool: { type: 'string', description: 'Fila do hot-swap (lista separada por vírgula; ordem = prioridade; vazio = sem hot-swap)' },
    default: { type: 'boolean', description: 'Torna este mux o default' },
  },
  run: guarded(async ({ args }) => {
    const accounts = csv(args.accounts)
    const pool = csv(args.pool)
    const { changed } = await setMux(defaultCtx(), args.name, {
      ...(args.root !== undefined && { root: args.root }),
      ...(args.account !== undefined && { account: args.account }),
      ...(accounts && { accounts }),
      ...(pool && { pool }),
      ...(args.default === true && { default: true }),
    })
    if (changed.length === 0) {
      process.stdout.write(`mux ${args.name}: nada a mudar\n`)
      return
    }
    process.stdout.write(`mux ${args.name} atualizado (${changed.join(', ')})\n`)
    process.stdout.write('a conta atual não mudou: a troca vale no próximo ciclo do watch ou com `sb swap`\n')
  }),
})

const rm = defineCommand({
  meta: { name: 'rm', description: 'Tira o mux da config (o link fica; sessões abertas continuam abrindo)' },
  args: { name: { type: 'positional', required: true, description: 'Mux' } },
  run: guarded(async ({ args }) => {
    await rmMux(defaultCtx(), args.name)
    process.stdout.write(`mux ${args.name} removido da config (o link mux/${args.name}.json foi mantido)\n`)
  }),
})

export default defineCommand({
  meta: { name: 'mux', description: 'Gerencia muxes: list (padrão), add, set, rm' },
  args: jsonArg, // declarado aqui também: o citty precisa saber que `--json` é booleano para achar o subcomando
  subCommands: { list, add, set, rm },
  default: 'list',
})
