import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { defineCommand } from 'citty'
import type { AttachSpec } from '../core/accounts.js'
import { cleanEnv } from '../core/claude.js'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { EXIT, SbError, type ExitCode } from '../core/errors.js'
import { AttachAfterLoginError, login, preflightLogin } from '../core/login.js'
import { logFile } from '../core/paths.js'
import { parsePool } from './args.js'
import { guarded } from './guard.js'

export interface LoginArgs {
  account: string
  /** colar o token em vez de abrir o navegador */
  terminal: boolean
  /** roda aqui mesmo, sem desanexar (é o que o processo desanexado executa) */
  foreground: boolean
  attach?: AttachSpec
}

export interface LoginIO {
  /** stdout é um terminal? */
  isTTY: boolean
  write(text: string): void
  err(text: string): void
}

const defaultIO = (): LoginIO => ({
  isTTY: process.stdout.isTTY === true,
  write: (t) => void process.stdout.write(t),
  err: (t) => void process.stderr.write(t),
})

const WAIT_URL_MS = 25_000
const isExit = (n: number | null): n is ExitCode => n !== null && (Object.values(EXIT) as number[]).includes(n)

/** Argv do `sb login` desanexado: as MESMAS opções de attach do pedido original. */
export function detachedArgv(a: LoginArgs): string[] {
  const argv = ['login', a.account, '--foreground']
  if (a.attach) {
    argv.push('--attach', a.attach.mux)
    if (typeof a.attach.pool === 'number') argv.push('--at', String(a.attach.pool))
    else if (a.attach.pool === true) argv.push('--pool')
    if (a.attach.preferred) argv.push('--preferred')
  }
  return argv
}

const sizeOf = (f: string): number => {
  try {
    return statSync(f).size
  } catch {
    return 0
  }
}
const tailFrom = (f: string, offset: number): string => {
  try {
    return readFileSync(f).subarray(offset).toString('utf8')
  } catch {
    return ''
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Sem TTY (ex.: `!` no Claude Code, fundo): o login roda desanexado (`sb login --foreground`, saída em `login.log`).
 * Espera até 25 s pela URL (ou pelo fim, se falhar cedo), a imprime e sai; o fim chega por notificação.
 */
async function startDetached(ctx: Ctx, a: LoginArgs, io: LoginIO): Promise<void> {
  const log = logFile(ctx.paths, 'login')
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 })
  const offset = sizeOf(log) // só o que for escrito daqui em diante conta (URLs de logins antigos não valem)
  const fd = openSync(log, 'a', 0o600)
  const state: { exit?: number | null; error?: Error } = {} // preenchido pelos eventos do filho
  try {
    const child = spawn(process.execPath, [process.argv[1] ?? '', ...detachedArgv(a)], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: cleanEnv(ctx.env),
    })
    child.once('exit', (code) => (state.exit = code))
    child.once('error', (e) => (state.error = e))
    child.unref()
  } finally {
    closeSync(fd)
  }

  const end = Date.now() + WAIT_URL_MS
  for (;;) {
    const tail = tailFrom(log, offset)
    const url = /^\S+ url (https:\/\/\S+)$/m.exec(tail)?.[1]
    const done = /^\S+ FIM (ok|falhou)(?:: (.*))?$/m.exec(tail)
    if (url) {
      io.write(`Autorize no navegador com a conta "${a.account}" (clique em Autorizar). Se ele não abriu, use este link:\n${url}\n`)
      io.write(`Quando terminar chega uma notificação; acompanhe em ${log}\n`)
      return
    }
    if (done?.[1] === 'ok') {
      io.write(`conta ${a.account} salva\n`)
      return
    }
    if (done || state.error || state.exit !== undefined) {
      // falhou: dá até 2 s para o processo sair e revelar o código de saída
      for (let i = 0; i < 40 && state.exit === undefined && !state.error; i++) await sleep(50)
      // o que o processo desanexado escreveu fora dos marcos (stderr: `✗ mensagem` + dicas)
      const extra = tail.split('\n').filter((l) => l.trim() !== '' && !/^\d{4}-\d\d-\d\dT\S+ /.test(l))
      const detail = extra.filter((l) => !l.startsWith('✗ ')).join('\n').trim()
      const code = state.exit ?? null
      throw new SbError(
        done?.[2] ?? state.error?.message ?? `o login desanexado terminou com erro; veja ${log}`,
        isExit(code) && code !== 0 ? code : EXIT.CHECK_FAILED,
        detail || undefined,
      )
    }
    if (Date.now() >= end) {
      io.write(`o claude ainda não mostrou o link de autorização; o login segue em segundo plano (acompanhe em ${log})\n`)
      return
    }
    await sleep(200)
  }
}

/**
 * `sb login` (e o login que o `sb attach` faz de conta nova). Valida tudo que dá antes de abrir o navegador;
 * sem TTY desanexa. Em `--foreground` sem TTY (o desanexado), avisa o fim por notificação e não imprime em stdout (é o log).
 */
export async function runLogin(ctx: Ctx, a: LoginArgs, io: LoginIO = defaultIO()): Promise<void> {
  if (!a.terminal && !a.foreground && !io.isTTY) {
    await preflightLogin(ctx, a.account, a.attach, { lock: true })
    return startDetached(ctx, a, io)
  }
  const detachedChild = a.foreground && !io.isTTY
  const say = (t: string): void => {
    if (!detachedChild) io.write(t)
  }
  try {
    const r = await login(ctx, a.account, {
      terminal: a.terminal,
      ...(a.attach && { attach: a.attach }),
      onWaitLock: () => say('esperando o lock… (outro sb está rodando; o token já foi validado e será salvo assim que o lock soltar)\n'),
      onUrl: (url) => say(`Autorize no navegador com a conta "${a.account}" (clique em Autorizar). Se ele não abriu, use este link:\n${url}\n\nEsperando o login…\n`),
    })
    say(`conta ${r.account} salva (token em tokens/${r.account}.json, 600${r.created ? '; conta registrada' : ''})\n`)
    if (r.usageUnreadable) {
      const u = r.usageUnreadable
      say(`⚠ a API aceitou o token, mas não consegui ler o uso desta conta (HTTP ${u.httpStatus}; cabeçalhos de uso: ${u.unified.length > 0 ? u.unified.join(', ') : 'nenhum'})\n  ela fica fora da troca automática até uma medição funcionar; confira com \`sb usage\`\n`)
    }
    if (r.attached && a.attach) {
      say(r.attached.length > 0 ? `anexada ao mux ${a.attach.mux} (${r.attached.join(', ')})\n` : `já estava assim no mux ${a.attach.mux}\n`)
    }
    if (detachedChild) {
      ctx.notify(`Switchboard: conta "${r.account}" pronta`, a.attach ? `token salvo e conta anexada ao mux ${a.attach.mux}` : 'token salvo e conta registrada')
    }
  } catch (e) {
    if (detachedChild) {
      // login feito e só o attach falhou: token e registro ficaram, então o conselho é `sb attach` (não colar token de novo)
      if (e instanceof AttachAfterLoginError) ctx.notify(`Switchboard: conta "${a.account}" salva, sem anexar`, `${e.message} ${e.detail?.trim() ?? ''}`)
      else ctx.notify('Switchboard: login não concluído', `Rode no terminal: sb login ${a.account} --terminal`)
    }
    throw e
  }
}

/** `--attach <mux> [--pool|--at N] [--preferred]` → spec; as três últimas sem `--attach` são recusadas (exit 3). */
export function attachSpecFrom(args: { attach?: string; pool?: boolean; at?: string; preferred?: boolean }): AttachSpec | undefined {
  const pool = parsePool(args.pool === true, args.at)
  if (args.attach === undefined) {
    if (pool !== undefined || args.preferred === true) throw new SbError('--pool, --at e --preferred só valem junto com --attach <mux>', EXIT.USAGE)
    return undefined
  }
  return { mux: args.attach, ...(pool !== undefined && { pool }), ...(args.preferred === true && { preferred: true }) }
}

export default defineCommand({
  meta: { name: 'login', description: 'Login por setup-token num PTY (sem tocar o keychain); registra a conta e guarda o token (600)' },
  args: {
    account: { type: 'positional', required: true, description: 'Nome da conta (minúsculas, números, - e _)' },
    terminal: { type: 'boolean', description: 'Cola o token (sk-ant-oat01-…) em vez de abrir o navegador' },
    foreground: { type: 'boolean', description: 'Não desanexa (é o que o processo em segundo plano roda)' },
    attach: { type: 'string', description: 'Depois do login, anexa a conta a este mux' },
    pool: { type: 'boolean', description: 'Com --attach: põe a conta no pool (fim da fila)' },
    at: { type: 'string', description: 'Com --attach: posição (1-based) no pool; implica --pool' },
    preferred: { type: 'boolean', description: 'Com --attach: faz a conta a preferida do mux' },
  },
  run: guarded(async ({ args }) => {
    const attach = attachSpecFrom(args)
    await runLogin(defaultCtx(), { account: args.account, terminal: args.terminal === true, foreground: args.foreground === true, ...(attach && { attach }) })
  }),
})
