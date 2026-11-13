import { statSync } from 'node:fs'
import { z } from 'zod'
import type { Ctx } from './ctx.js'
import { EXIT, SbError } from './errors.js'

/** F10 — variáveis de sessão que vazam para um `claude` filho (lista do `VARS_SESSAO` do claude-conta). */
export const SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_JOB_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
  'CLAUDE_CODE_AGENT',
  'CLAUDE_CONFIG_DIR',
] as const

/** Cópia do ambiente sem as variáveis F10 (e sem valores `undefined`). Não altera `env`. */
export function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const drop = new Set<string>(SESSION_VARS)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !drop.has(k)) out[k] = v
  return out
}

/** `SWITCHBOARD_CLAUDE` (binário de teste) ou o `claude` do PATH. */
export function claudeBin(env: Record<string, string | undefined>): string {
  return env.SWITCHBOARD_CLAUDE || 'claude'
}

// ---------------------------------------------------------------------------------------------------------------
// Adaptador do `claude agents` / `claude stop` (Task 14). O formato de `claude agents --json --all` é INTERNO e
// não documentado: pode mudar numa atualização. Tudo que o resto do `sb` sabe dele passa por aqui, e um formato
// inesperado vira `SbError` exit 4 com mensagem clara — nunca um crash obscuro nem um palpite.
// ---------------------------------------------------------------------------------------------------------------

const AgentSchema = z.looseObject({
  id: z.string(),
  cwd: z.string(),
  kind: z.string(),
  startedAt: z.number(),
  sessionId: z.string(),
  name: z.string(),
  state: z.string(),
  // só nas entradas de sessão VIVA (6 de 51 entradas reais tinham): opcionais
  pid: z.number().optional(),
  status: z.string().optional(),
})

/** Uma entrada de `claude agents --json --all`. `pid`/`status` só existem em sessão viva; chaves extras são toleradas. */
export type AgentEntry = z.infer<typeof AgentSchema>

const AgentListSchema = z.array(AgentSchema)

const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]+/g

/** Trecho curto e seguro de uma saída externa: sem token, sem controle, no máximo `max` caracteres. */
function excerpt(s: string, max = 80): string {
  const flat = s.replace(TOKEN_RE, '<token>').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const DOCTOR = 'o formato interno do claude pode ter mudado numa atualização; rode `sb doctor`'

/** Primeira divergência do zod em português (só o caminho e o tipo esperado: nunca o valor recebido). */
function describeIssue(issue: z.core.$ZodIssue): string {
  const [idx, field] = issue.path
  const where = typeof idx === 'number' ? `entrada ${idx + 1}` : 'saída'
  if (field === undefined) {
    return issue.path.length === 0 ? 'não é uma lista de sessões' : `${where} não é um objeto`
  }
  return `${where}: campo \`${String(field)}\` ausente ou com tipo inesperado`
}

/** `claude agents --json --all` (cwd = HOME, ambiente limpo). Formato inesperado → `SbError` exit 4. */
export function listAgents(ctx: Ctx): AgentEntry[] {
  const r = ctx.run(claudeBin(ctx.env), ['agents', '--json', '--all'], { cwd: ctx.paths.home, env: cleanEnv(ctx.env), timeoutMs: 30_000 })
  if (r.status !== 0) {
    const why = excerpt(r.stderr)
    throw new SbError(`\`claude agents --json --all\` falhou (código ${r.status ?? 'nenhum'}${why ? `: ${why}` : ''}); confira o \`claude\` ou rode \`sb doctor\``, EXIT.CLAUDE)
  }
  let data: unknown
  try {
    data = JSON.parse(r.stdout)
  } catch {
    throw new SbError(`\`claude agents --json --all\` não devolveu JSON (começa com: ${JSON.stringify(excerpt(r.stdout, 40))}); ${DOCTOR}`, EXIT.CLAUDE)
  }
  const parsed = AgentListSchema.safeParse(data)
  if (!parsed.success) {
    throw new SbError(`formato inesperado em \`claude agents --json --all\` (${describeIssue(parsed.error.issues[0]!)}); ${DOCTOR}`, EXIT.CLAUDE)
  }
  return parsed.data
}

/** Id curto de sessão do daemon: 8 hex minúsculos. Validado antes de qualquer processo ou caminho. */
export const SESSION_ID_RE = /^[0-9a-f]{8}$/

export function assertSessionId(id: string): string {
  if (!SESSION_ID_RE.test(id)) throw new SbError(`id de sessão inválido: ${JSON.stringify(excerpt(id, 40))} — esperado 8 caracteres hexadecimais (ex.: a1b2c3d4)`, EXIT.USAGE)
  return id
}

export interface StopOptions {
  /** intervalo entre consultas ao `agents` (padrão 250 ms) */
  pollMs?: number
  /** como esperar `ms`; o padrão bloqueia sem girar (`Atomics.wait`). Os testes injetam um relógio. */
  sleep?: (ms: number) => void
}

const blockingSleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * `claude stop <id>` e espera o `pid` da entrada sumir de `listAgents`. `false` se o `claude stop` sai com erro
 * ou se o `pid` continua lá no prazo. Só o `id` pedido é parado (argv em array, sem shell, ambiente limpo: nunca o
 * `CLAUDE_CODE_OAUTH_TOKEN` herdado). Entrada que sumiu da lista conta como parada.
 */
export function stopSession(ctx: Ctx, id: string, timeoutMs = 45_000, opts: StopOptions = {}): boolean {
  assertSessionId(id)
  const pollMs = Math.max(1, opts.pollMs ?? 250)
  const sleep = opts.sleep ?? blockingSleep
  const started = ctx.now()
  const r = ctx.run(claudeBin(ctx.env), ['stop', id], { cwd: ctx.paths.home, env: cleanEnv(ctx.env), timeoutMs })
  if (r.status !== 0) return false
  const deadline = started + timeoutMs
  // o limite de consultas protege de um relógio parado: o prazo vale, mas nunca gira para sempre
  const maxPolls = Math.ceil(timeoutMs / pollMs) + 2
  for (let i = 0; ; i++) {
    const entry = listAgents(ctx).find((a) => a.id === id)
    if (entry === undefined || entry.pid === undefined) return true
    if (i >= maxPolls || ctx.now() >= deadline) return false
    sleep(pollMs)
  }
}

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Retoma em segundo plano uma sessão PARADA, com uma instrução: `claude --bg --resume <sessionId> <prompt>` (medido em
 * 13/11/2026 no 2.1.3xx: "woke session <id> with its saved options", mesmo id, as opções salvas — inclusive o
 * `--settings` do mux — e a instrução é executada). Roda na pasta da sessão (ou no HOME, se ela sumiu), com o ambiente
 * limpo: nunca o `CLAUDE_CODE_OAUTH_TOKEN` herdado. `false` se o id não é um UUID ou se o `claude` falhou; não lança.
 */
export function resumeSession(ctx: Ctx, sessionId: string, cwd: string, prompt: string): boolean {
  if (!SESSION_UUID.test(sessionId)) return false
  let dir = ctx.paths.home
  try {
    if (statSync(cwd).isDirectory()) dir = cwd
  } catch {
    // pasta da sessão sumiu: o HOME serve (o claude acha a sessão pelo id)
  }
  const r = ctx.run(claudeBin(ctx.env), ['--bg', '--resume', sessionId, prompt], { cwd: dir, env: cleanEnv(ctx.env), timeoutMs: 60_000 })
  return r.status === 0
}

