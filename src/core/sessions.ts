import { basename } from 'node:path'
import { listAgents, type AgentEntry } from './claude.js'
import type { Ctx } from './ctx.js'
import { SbError } from './errors.js'
import { type JobState, type Ownership, ownershipOf, readJobState } from './jobs.js'

// ---------------------------------------------------------------------------------------------------------------
// Sessões do daemon: pertença (pelo `--settings`) e atividade. Lógica PURA sobre o adaptador (Task 14): nenhum I/O
// além de `listAgents`/`readJobState`, nenhum relógio. As regras de atividade são as MEDIDAS no Gate G1 (design §3
// F12–F14 e `spikes/sessoes/RESULTADOS.md`, "Resumo e regras"): provisórias, n pequeno.
// ---------------------------------------------------------------------------------------------------------------

export interface Session {
  agent: AgentEntry
  /** `null` se o `state.json` não existe ou não pôde ser lido. Numa sessão VIVA isso conta como `busy` (nunca parar o que não dá para ler). */
  job: JobState | null
  owner: Ownership
  /** tem `pid` (host aberto). Sem `pid`, o que o `state.json` diz sobre `inFlight`/limite é obsoleto. */
  live: boolean
}

export type Activity = 'stopped' | 'scheduled' | 'limit-blocked' | 'busy' | 'free'

/**
 * Sessões `background` de `claude agents --json --all`. Um `state.json` ausente dá `job: null`; um malformado (JSON
 * inválido ou forma inesperada) TAMBÉM dá `job: null` e vira um aviso (só id e motivo do adaptador: nunca o conteúdo
 * do arquivo, que pode ter token em `respawnFlags`); uma sessão ruim não derruba as outras. `unreadable` são os ids dessas sessões (state.json que EXISTE e não se lê; ausente não conta), para quem decide algo sem ler o texto dos avisos. A lista de agents
 * malformada é outra coisa: `listAgents` lança `SbError` exit 4 e isso sobe.
 */
export function loadSessionsWithWarnings(ctx: Ctx): { sessions: Session[]; warnings: string[]; unreadable: string[] } {
  const sessions: Session[] = []
  const warnings: string[] = []
  const unreadable: string[] = []
  for (const agent of listAgents(ctx)) {
    if (agent.kind !== 'background') continue
    let job: JobState | null = null
    try {
      job = readJobState(ctx.paths, agent.id)
    } catch (e) {
      if (!(e instanceof SbError)) throw e
      warnings.push(`sessão ${agent.id}: ${e.message}; sem state.json legível (viva conta como ocupada)`)
      unreadable.push(agent.id)
    }
    sessions.push({ agent, job, owner: ownershipOf(job?.respawnFlags ?? [], ctx.paths), live: agent.pid != null })
  }
  return { sessions, warnings, unreadable }
}

/** Como `loadSessionsWithWarnings`, descartando a lista; cada aviso vai (sem conteúdo) para o log do `watch`, sem nunca lançar por causa do log. */
export function loadSessions(ctx: Ctx): Session[] {
  const { sessions, warnings } = loadSessionsWithWarnings(ctx)
  for (const w of warnings) {
    try {
      ctx.log('watch', w)
    } catch {
      // o log é só informativo
    }
  }
  return sessions
}

/**
 * Há trabalho AGENDADO (que o stop destruiria): a sessão está viva, tem `inFlight` e ele traz `session_cron`,
 * `monitor` ou `wake`. `kinds` só com `local_bash`/`local_agent` é trabalho DENTRO do turno: não é agendado (a
 * sessão fica `busy`). `drainableMonitors` e `selfWake` não entram.
 *
 * RISCO ACEITO (design §4, RESULTADOS §3): um CronCreate one-shot pendente que ficou invisível depois de um respawn
 * (`kinds []`) NÃO é detectado aqui. As mitigações PROPOSTAS e NÃO TESTADAS (nunca agir com `tempo == 'active'` /
 * `status == 'busy'`; tratar sessão reaberta há pouco como "assumir agendado") NÃO estão implementadas: as Tasks
 * 17/19 decidem.
 */
export function hasScheduledWork(job: JobState | null, agent: AgentEntry): boolean {
  if (agent.pid == null || job?.inFlight == null) return false
  const f = job.inFlight
  return f.kinds?.includes('session_cron') === true || f.kinds?.includes('monitor') === true || f.wake != null
}

/**
 * Parada por limite de uso: viva, `blocked` com `needs` começando por `rate limited`, nenhuma tarefa em curso e o
 * host não `busy`. `queued` pode ser 1 (o item que espera o reset). Sem `pid` nunca: o estado do job é obsoleto.
 */
export function isLimitBlocked(s: Session): boolean {
  const f = s.job?.inFlight
  return s.live && s.job?.state === 'blocked' && (s.job.needs?.startsWith('rate limited') ?? false) && f != null && f.tasks === 0 && s.agent.status !== 'busy'
}

/**
 * Precedência: sem pid → `stopped` (o estado do job é obsoleto); a sessão que chamou → `busy` (nunca parar quem
 * chamou); VIVA sem job legível (`job == null`: state.json ausente, malformado ou de formato novo) → `busy` (pode ter
 * cron/monitor/wake que não conseguimos ver: nunca parar o que não dá para ler); VIVA com job legível mas SEM `inFlight`
 * → `busy` (mesma razão: falha fechada); trabalho agendado → `scheduled`;
 * limite → `limit-blocked`; `status busy`/`tasks`/`queued` → `busy`; senão `free`.
 */
export function activityOf(s: Session, callerJobId?: string): Activity {
  if (!s.live) return 'stopped'
  if (callerJobId !== undefined && s.agent.id === callerJobId) return 'busy'
  if (s.job === null) return 'busy'
  // state.json legível mas sem a chave `inFlight` (2 de 51 jobs reais): não dá para confirmar que não há turno nem agendamento
  if (s.job.inFlight == null) return 'busy'
  if (hasScheduledWork(s.job, s.agent)) return 'scheduled'
  if (isLimitBlocked(s)) return 'limit-blocked'
  const f = s.job?.inFlight
  if (s.agent.status === 'busy' || (f?.tasks ?? 0) > 0 || (f?.queued ?? 0) > 0) return 'busy'
  return 'free'
}

/**
 * Id da sessão que está rodando ESTE `sb` (basename de `CLAUDE_JOB_DIR`). O `sb` só tira as variáveis de sessão para o
 * `claude` que ele lança, não para si mesmo: aqui vale o ambiente que o processo recebeu. `undefined` sem a variável.
 */
export function callerJobId(env: Record<string, string | undefined>): string | undefined {
  const dir = env.CLAUDE_JOB_DIR
  if (dir === undefined || dir === '') return undefined
  const id = basename(dir)
  return id === '' ? undefined : id
}

/** Instante (ms) em que o host foi (re)aberto: `agent.startedAt`. Só vale para sessão viva; NÃO é o início do processo do SO. */
export function startedAt(s: Session): number {
  return s.agent.startedAt
}
