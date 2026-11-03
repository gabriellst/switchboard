import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachAccount, checkAttachSpec, requireMux, type AttachSpec } from './accounts.js'
import { claudeBin, cleanEnv } from './claude.js'
import { editConfig, ensureConfig, loadConfig, type Config } from './config.js'
import type { Ctx } from './ctx.js'
import { EXIT, SbError } from './errors.js'
import { acquirePidFile, peekPidFile, releasePidFile, withLock } from './fsx.js'
import { assertSafeName, loginLockFile, logFile, tokenFile } from './paths.js'
import { probeToken, type ProbeResult } from './probe.js'
import { KEYCHAIN } from './schema.js'
import { hasToken, saveToken } from './tokens.js'

// Regras deste arquivo (F9, anti-objetivos): o `setup-token` roda com CLAUDE_CONFIG_DIR TEMPORÁRIO e `cleanEnv`
// (nunca toca o keychain); o buffer bruto do PTY só existe numa variável local de `runSetupToken` e nunca vai a
// log, erro ou saída; token só é gravado em tokens/ (por `saveToken`); `login.log` só recebe marcos.

const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/g
const PASTED_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/
const URL_RE = /https:\/\/\S+\/oauth\/authorize\?\S+/

/** Login feito (token salvo, conta registrada) e só o attach falhou; o exit é o do attach (em geral 3; trava presa = 5). */
export class AttachAfterLoginError extends SbError {
  constructor(message: string, exit: SbError['exit'], detail: string) {
    super(message, exit, detail)
    this.name = 'AttachAfterLoginError'
  }
}

const usage = (message: string, detail?: string): SbError => new SbError(message, EXIT.USAGE, detail)

/** Porta de `limpar_ansi` (claude-conta): tira OSC e cores, movimento de cursor vira quebra de linha. */
export function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (títulos, links)
    .replace(/\x1b\[[0-9;?]*[ -/]*m/g, '') // cores: somem
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '\n') // cursor: vira quebra
    .replace(/\x1b./g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/**
 * Porta de `extrair_tokens_texto`: até 3 candidatos, o juntado primeiro. O token que encosta no fim da
 * linha pode ter quebrado na largura do terminal, então se junta com as linhas seguintes só de [A-Za-z0-9_-].
 */
export function extractTokens(raw: string): string[] {
  const lines = stripAnsi(raw)
    .split('\n')
    .map((l) => l.trim())
  const onlyToken = /^[A-Za-z0-9_-]+$/
  const found: string[] = []
  lines.forEach((line, i) => {
    for (const m of line.matchAll(TOKEN_RE)) {
      let token = m[0]
      if (m.index + m[0].length === line.length) {
        for (let j = i + 1; j < lines.length && onlyToken.test(lines[j]!); j++) token += lines[j]
      }
      found.push(token, m[0])
    }
  })
  return [...new Set(found)].slice(0, 3)
}

export interface Timing {
  /** espera até o 1º Enter quando nenhuma URL apareceu */
  enterAfterMs: number
  /** acréscimo de espera a cada Enter seguinte (até 3) */
  enterEveryMs: number
  /** depois de ver o token, quanto esperar para ele terminar de imprimir */
  graceMs: number
}
const DEFAULT_TIMING: Timing = { enterAfterMs: 8_000, enterEveryMs: 6_000, graceMs: 2_000 }

const PTY_SCRIPT = 'stty cols 2000 rows 50; exec "$0" setup-token'
// O `script` do macOS recusa uma entrada que seja socket (`tcgetattr: Operation not supported on socket`), e o
// stdio 'pipe' do Node é um socket. `< <(cat)` dá ao `script` um pipe de verdade e ainda deixa escrever o Enter.
// O `exec` põe o `script` no lugar do bash: a saída fecha quando ele acaba. No bash: $0 = PTY_SCRIPT, $1 = o claude;
// o `script` roda exatamente `script -q /dev/null sh -c '<PTY_SCRIPT>' <claude>`.
const PIPELINE = 'exec /usr/bin/script -q /dev/null sh -c "$0" "$1" < <(cat)'

/** Pids dos descendentes de `root` (uma varredura de `ps`; vazio se `ps` falhar). */
function descendantsOf(root: number): number[] {
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
  if (r.status !== 0) return []
  const kids = new Map<number, number[]>()
  for (const line of r.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!pid || !ppid) continue
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid])
  }
  const out: number[] = []
  const queue = [root]
  while (queue.length > 0) {
    for (const k of kids.get(queue.shift()!) ?? []) {
      out.push(k)
      queue.push(k)
    }
  }
  return out
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** SIGTERM, até ~500 ms de espera, SIGKILL nos que sobraram. */
async function killPids(pids: number[]): Promise<void> {
  const live = pids.filter(alive)
  for (const p of live) {
    try {
      process.kill(p, 'SIGTERM')
    } catch {
      // saiu entre a checagem e o sinal
    }
  }
  for (let i = 0; i < 10 && live.some(alive); i++) await sleep(50)
  for (const p of live.filter(alive)) {
    try {
      process.kill(p, 'SIGKILL')
    } catch {
      // idem
    }
  }
}

/** O login foi interrompido por sinal (Ctrl-C, kill, fechar o terminal); a limpeza já rodou. */
export class LoginInterruptedError extends SbError {
  constructor(signal: string) {
    super(`login interrompido (${signal}); nada foi salvo`, EXIT.CHECK_FAILED)
    this.name = 'LoginInterruptedError'
  }
}

/**
 * Roda `claude setup-token` num pseudo-terminal (via `script`: funciona sem TTY na entrada) com um
 * CLAUDE_CONFIG_DIR temporário, apagado no `finally` (nada encosta no keychain). Chama `onUrl` ao ver o link de
 * autorização (inteiro: só depois que algo o segue no buffer, ou no fim da saída) e devolve os candidatos a token.
 * Para 2 s depois de ver o token; manda Enter (até 3 vezes) se nenhuma URL aparecer. Claude que falha, some ou passa
 * de `limitMs` sem entregar token → exit 4. Em toda saída (sucesso, erro, limite, sinal) mata o claude e seus
 * descendentes (o `script` o põe noutra sessão: matar o grupo do bash não o alcança). O buffer bruto nunca sai daqui.
 */
export async function runSetupToken(
  ctx: Ctx,
  onUrl: (url: string) => void,
  limitMs = 900_000,
  timing: Partial<Timing> = {},
): Promise<string[]> {
  const t = { ...DEFAULT_TIMING, ...timing }
  const tmp = mkdtempSync(join(ctx.env.TMPDIR || tmpdir(), 'sb-login-')) // 0700
  let child: ChildProcess | undefined
  let buf = ''
  let interrupted: string | undefined
  let stopNow: (() => void) | undefined
  const killGroup = (signal: NodeJS.Signals): void => {
    if (!child?.pid) return
    try {
      process.kill(-child.pid, signal) // bash/script/cat (o `detached` os põe num grupo próprio)
    } catch {
      try {
        child.kill(signal)
      } catch {
        // já morreu
      }
    }
  }
  const running = (): boolean => child !== undefined && child.exitCode === null && child.signalCode === null

  // Ctrl-C / kill / terminal fechado: encerra a espera; quem chamou limpa (mesmo `finally`) e propaga o erro
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  const handlers = SIGNALS.map((sg) => {
    const h = (): void => {
      interrupted ??= sg
      stopNow?.()
    }
    process.on(sg, h)
    return [sg, h] as const
  })

  try {
    writeFileSync(join(tmp, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }), { mode: 0o600 })
    const env = { ...cleanEnv(ctx.env), CLAUDE_CONFIG_DIR: tmp, TERM: 'xterm-256color' }
    const proc = spawn('/bin/bash', ['-c', PIPELINE, PTY_SCRIPT, claudeBin(ctx.env)], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    child = proc
    // o `script` acabou (a saída fechou): solta o `cat` da substituição de processo
    proc.stdout.once('end', () => proc.stdin.end())
    proc.stdin.on('error', () => undefined) // EPIPE: o filho já saiu
    proc.stderr.resume()
    proc.stdout.setEncoding('utf8')
    const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      proc.once('error', (error) => resolve({ code: null, error }))
      proc.once('close', (code) => resolve({ code }))
    })

    const enter = (): void => void proc.stdin.write('\r')
    let timedOut = false
    let urlSent = false
    /** A URL só vale inteira: o `\S+` final vai até o fim do buffer, então exige algo depois dela (o claude imprime \r\n). */
    const scanUrl = (final: boolean): void => {
      if (urlSent) return
      const text = stripAnsi(buf)
      const m = URL_RE.exec(text)
      if (m && (final || m.index + m[0].length < text.length)) {
        urlSent = true
        onUrl(m[0])
      }
    }
    const start = Date.now()
    const stopped = new Promise<void>((resolve) => {
      let tokenAt = 0
      let enters = 0
      const done = (): void => {
        clearInterval(tick)
        resolve()
      }
      stopNow = done
      proc.stdout.on('data', (d: string) => {
        buf += d
        scanUrl(false)
        if (!tokenAt && new RegExp(TOKEN_RE.source).test(stripAnsi(buf))) tokenAt = Date.now()
      })
      const tick = setInterval(() => {
        const now = Date.now()
        if (tokenAt && now - tokenAt > t.graceMs) return done() // deu tempo de imprimir o token inteiro
        if (now - start >= limitMs) {
          timedOut = true
          return done()
        }
        // menu antes do link (tema, método de login): Enter = opção padrão
        if (!urlSent && enters < 3 && now - start > t.enterAfterMs + enters * t.enterEveryMs) {
          enter()
          enters++
        }
      }, 100)
      void exited.then(done)
    })
    await stopped // o `finally` abaixo encerra o processo e apaga o diretório
    scanUrl(true) // fim da saída (ou limite): a URL que sobrou no fim do buffer é a inteira
    if (interrupted) throw new LoginInterruptedError(interrupted)

    const tokens = extractTokens(buf)
    if (tokens.length > 0) return tokens
    // sem token: distingue claude quebrado/ausente/travado (exit 4) de "rodou e não imprimiu nada"
    const end = await Promise.race([exited, new Promise<undefined>((r) => setTimeout(() => r(undefined), 500))])
    if (end?.error) throw new SbError(`não consegui executar o claude (${end.error.message})`, EXIT.CLAUDE, '  confira se `script` e `claude` estão no PATH')
    if (timedOut) throw new SbError(`o claude setup-token passou de ${Math.round(limitMs / 1000)} s sem entregar o token`, EXIT.CLAUDE)
    if (end && end.code !== 0) throw new SbError(`o claude setup-token falhou (código ${end.code})`, EXIT.CLAUDE, '  confira se o `claude` está instalado e funciona')
    return []
  } finally {
    for (const [sg, h] of handlers) process.off(sg, h)
    if (child?.pid && running()) {
      const known = descendantsOf(child.pid) // enquanto o `script` vive dá para achar o claude (depois ele vira órfão)
      try {
        child.stdin?.write('\r')
      } catch {
        // sem entrada
      }
      await waitClose(child, 300) // chance de sair sozinho
      // o claude vive noutra sessão: o kill do grupo não o alcança, então os descendentes morrem um a um
      await killPids([...new Set([...known, ...(running() ? descendantsOf(child.pid) : [])])])
      if (running()) {
        killGroup('SIGTERM')
        await waitClose(child, 3_000)
      }
      if (running()) {
        killGroup('SIGKILL')
        await waitClose(child, 2_000)
      }
    }
    rmSync(tmp, { recursive: true, force: true })
  }
}

function waitClose(child: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(resolve, ms)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Lê um token colado: no terminal sem eco; em pipe, a 1ª linha. Nunca ecoa o valor. */
export async function readPastedFromStdin(): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    let text = ''
    for await (const chunk of stdin) {
      text += (chunk as Buffer).toString('utf8')
      if (text.includes('\n')) break
    }
    return text.split('\n')[0] ?? ''
  }
  process.stderr.write('Cole o token (sk-ant-oat01-…, Enter vazio cancela): ')
  stdin.setRawMode(true)
  stdin.setEncoding('utf8')
  stdin.resume()
  let out = ''
  try {
    await new Promise<void>((resolve) => {
      const onData = (d: string): void => {
        for (const ch of d) {
          if (ch === '\r' || ch === '\n' || ch === '\x04') {
            stdin.off('data', onData)
            return resolve()
          }
          if (ch === '\x03') {
            out = ''
            stdin.off('data', onData)
            return resolve()
          }
          out = ch === '\x7f' || ch === '\b' ? out.slice(0, -1) : out + ch
        }
      }
      stdin.on('data', onData)
    })
  } finally {
    stdin.setRawMode(false)
    stdin.pause()
    process.stderr.write('\n')
  }
  return out.replace(/\x1b\[20[01]~/g, '') // colagem "bracketed"
}

export interface LoginOpts {
  /** true: o token vem colado (`readPasted`), sem abrir o claude */
  terminal: boolean
  readPasted?: () => Promise<string>
  attach?: AttachSpec
  /** limite do `setup-token` em ms (padrão 900 s; os testes encurtam) */
  limitMs?: number
  /** link de autorização (não é segredo): o comando o mostra ao usuário */
  onUrl?: (url: string) => void
}

export interface LoginResult {
  account: string
  created: boolean
  attached?: string[]
}

/** `sb attach <conta> <mux> [--pool|--at N] [--preferred]` equivalente ao spec, para mensagens. */
export function attachCommandLine(account: string, spec: AttachSpec): string {
  const parts = ['sb attach', account, spec.mux]
  if (typeof spec.pool === 'number') parts.push('--at', String(spec.pool))
  else if (spec.pool === true) parts.push('--pool')
  if (spec.preferred) parts.push('--preferred')
  return parts.join(' ')
}

/**
 * Tudo que dá para recusar ANTES de abrir o navegador: nome, `keychain`, spec do attach, config válida e,
 * com `--attach`, o mux existente (config ausente conta como mux inexistente: exit 3, não exit 2).
 */
export async function preflightLogin(ctx: Ctx, account: string, attach?: AttachSpec, o: { lock?: boolean } = {}): Promise<void> {
  assertSafeName(account)
  if (account === KEYCHAIN) throw usage('"keychain" é reservado: usa o login do keychain do claude e não se registra', '  escolha outro nome')
  if (attach) {
    checkAttachSpec(account, attach)
    const cfg = existsSync(ctx.paths.configFile) ? await loadConfig(ctx.paths) : ({ mux: {} } as Config)
    requireMux(cfg, attach.mux)
  } else if (existsSync(ctx.paths.configFile)) {
    await loadConfig(ctx.paths) // config inválida: exit 2 antes de gastar um login
  }
  // `lock`: o pai desanexado recusa antes de spawnar (sem tomar a trava: quem a toma é o filho, em `login`)
  if (o.lock) {
    const busy = peekPidFile(loginLockFile(ctx.paths))
    if (busy) throw loginBusy(ctx, busy.pid)
  }
}

/** Outro login (PTY) em andamento: exit 5. */
function loginBusy(ctx: Ctx, pid: number | undefined): SbError {
  const who = pid === undefined ? `trava ilegível: ${loginLockFile(ctx.paths)}` : `pid ${pid}`
  return new SbError(`já tem um login em andamento (${who}); veja ${logFile(ctx.paths, 'login')}`, EXIT.LOCKED)
}

/** A conta precisa de login (não registrada ou sem token)? `keychain` nunca. */
export async function needsLogin(ctx: Ctx, account: string): Promise<boolean> {
  if (account === KEYCHAIN) return false
  const cfg = existsSync(ctx.paths.configFile) ? await loadConfig(ctx.paths) : undefined
  return !cfg || !(account in cfg.accounts) || !hasToken(ctx.paths, account)
}

async function candidatesFor(ctx: Ctx, o: LoginOpts): Promise<string[]> {
  if (o.terminal) {
    const pasted = (await (o.readPasted ?? readPastedFromStdin)()).trim()
    if (!pasted) throw usage('cancelado; nada mudou')
    // a mensagem nunca repete o que foi colado
    if (!PASTED_RE.test(pasted)) throw usage('isso não parece um token sk-ant-oat01-…; nada foi gravado')
    return [pasted]
  }
  ctx.log('login', 'abrindo')
  return runSetupToken(
    ctx,
    (url) => {
      ctx.log('login', `url ${url}`)
      o.onUrl?.(url)
    },
    o.limitMs,
  )
}

/** O 1º candidato com sonda `ok` (401/403, rede e respostas estranhas não passam: nada é salvo). */
async function firstValid(ctx: Ctx, candidates: string[]): Promise<string> {
  const baseUrl = ctx.env.SWITCHBOARD_API_BASE ?? 'https://api.anthropic.com'
  let last: ProbeResult | undefined
  for (const token of candidates) {
    ctx.log('login', 'validando')
    const r = await probeToken(token, { fetch: ctx.fetch, baseUrl })
    if (r.ok) return token
    last = r
  }
  if (last && !last.ok && last.error === 'dead-token') throw new SbError('o token não autenticou (a API o recusou): nada foi salvo', EXIT.CHECK_FAILED, '  tente de novo; se persistir, `sb login <conta> --terminal`')
  if (last && !last.ok && last.error === 'network') throw new SbError('não consegui validar o token (sem resposta da API): nada foi salvo', EXIT.CHECK_FAILED, '  confira a rede e tente de novo')
  throw new SbError('a API respondeu algo inesperado ao validar o token: nada foi salvo', EXIT.CHECK_FAILED)
}

/** Salva o token (600) e registra a conta se nova; tudo sob o lock, só depois da sonda aprovar. */
async function saveAndRegister(ctx: Ctx, account: string, token: string): Promise<boolean> {
  return withLock(ctx.paths, async () => {
    const hasConfig = existsSync(ctx.paths.configFile)
    const cfg = hasConfig ? await loadConfig(ctx.paths) : undefined
    const created = !cfg || !(account in cfg.accounts)
    const hadToken = hasToken(ctx.paths, account)
    saveToken(ctx.paths, account, token)
    if (created) {
      try {
        if (!hasConfig) await ensureConfig(ctx.paths)
        await editConfig(ctx.paths, [{ path: ['accounts', account], value: {} }])
      } catch (e) {
        // tudo-ou-nada: sem registro, o token novo e a config recém-criada não ficam para trás
        if (!hadToken) rmSync(tokenFile(ctx.paths, account), { force: true })
        if (!hasConfig) rmSync(ctx.paths.configFile, { force: true })
        throw e
      }
    }
    return created
  })
}

/**
 * Login por `setup-token` (ou token colado), validado por uma sonda antes de salvar. Com `attach`, depois de salvar
 * e registrar anexa a conta ao mux; se só o attach falhar, token e registro ficam e a mensagem manda rodar `sb attach`.
 * O log (`login.log`) recebe só marcos: abrindo, url, validando, attach, FIM ok|falhou.
 */
export async function login(ctx: Ctx, account: string, o: LoginOpts): Promise<LoginResult> {
  let held = false
  let logFailure = true
  try {
    await preflightLogin(ctx, account, o.attach)
    // um `setup-token` por vez (o log e o link seriam trocados): a trava vale do PTY até o FIM; colar o token não precisa
    if (!o.terminal) {
      const got = await acquirePidFile(loginLockFile(ctx.paths))
      if (!got.ok) {
        logFailure = false // o log é do login que está rodando: um FIM falhou nosso o enganaria
        throw loginBusy(ctx, got.pid)
      }
      held = true
    }
    const candidates = await candidatesFor(ctx, o)
    if (candidates.length === 0) {
      throw new SbError('não consegui capturar o token do claude', EXIT.CHECK_FAILED, `  rode \`sb login ${account} --terminal\` e cole o token`)
    }
    const token = await firstValid(ctx, candidates)
    const created = await saveAndRegister(ctx, account, token)
    const result: LoginResult = { account, created }
    if (o.attach) {
      ctx.log('login', 'attach')
      try {
        result.attached = (await attachAccount(ctx, account, o.attach)).changed
      } catch (e) {
        if (!(e instanceof SbError)) throw e
        // o exit é o do attach (3 no caso comum; trava presa = 5; config inválida = 2): passa direto
        throw new AttachAfterLoginError(
          `login feito (token salvo e conta registrada), mas o attach falhou: ${e.message}`,
          e.exit,
          `  quando resolver, rode \`${attachCommandLine(account, o.attach)}\``,
        )
      }
    }
    ctx.log('login', 'FIM ok')
    return result
  } catch (e) {
    if (logFailure) ctx.log('login', `FIM falhou: ${e instanceof SbError ? e.message : 'erro inesperado'}`)
    throw e
  } finally {
    if (held) releasePidFile(loginLockFile(ctx.paths))
  }
}
