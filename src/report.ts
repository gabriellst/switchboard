import type { InstallResult } from './core/install.js'
import type { AccountInfo, MuxMembership, PanelData } from './core/panel.js'
import type { Measurement } from './core/usage.js'
import type { TickReport } from './core/watch.js'

export interface RenderOpts {
  nowMs: number
  /** fuso IANA; sem ele, o da máquina (os testes sempre passam um) */
  timeZone?: string
}

const CELLS = 10
const NOTE = '(média das contas do pool; só vale como "quanto do total" se os planos forem iguais)'

/** Percentual inteiro: a medição chega como float (0.265…), e só aqui vira número de tela. */
export const pct = (u: number): string => `${Math.round(u * 100)}%`

/** 10 células (`round(u*10)` de `█`, o resto `░`) e o percentual; só as células são limitadas, o número não. */
export function bar(u: number): string {
  const filled = Math.min(CELLS, Math.max(0, Math.round(u * CELLS)))
  return `${'█'.repeat(filled)}${'░'.repeat(CELLS - filled)} ${pct(u).padStart(3)}`
}

/** Mesmo dia (no fuso) → `HH:MM`; outro dia → `dd/mm`. `epochS` em segundos. */
export function formatReset(epochS: number, nowMs: number, timeZone?: string): string {
  if (!Number.isFinite(epochS)) return '—'
  const at = epochS * 1000
  const day = (ms: number): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
  if (day(at) === day(nowMs)) {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
  }
  const [, mm, dd] = day(at).split('-')
  return `${dd}/${mm}`
}

/** Texto de um erro de sonda (ou ausência de medição), no lugar das barras. */
function failureText(m: Measurement | undefined): string {
  if (!m) return 'ainda sem medição'
  if (m.ok) return ''
  switch (m.error) {
    case 'no-token':
      return 'sem token'
    case 'dead-token':
      return `token morto (${m.httpStatus ?? 401})`
    case 'rate-limited':
      return `limite atingido (${m.httpStatus ?? 429})`
    case 'network':
      return 'sem rede'
    case 'unexpected':
      return m.httpStatus === undefined ? 'resposta inesperada' : `resposta inesperada (HTTP ${m.httpStatus})`
  }
}

function roleText(m: MuxMembership): string {
  if (m.role === 'preferred') return `${m.mux} (preferida)`
  if (m.role === 'pool') return `${m.mux} (${m.position ?? '?'}º do pool)`
  return `${m.mux} (permitida)`
}

const muxesText = (ms: MuxMembership[]): string => ms.map(roleText).join(' · ')

/** Uma coluna de texto com no mínimo 2 espaços antes da próxima. */
const cell = (text: string, width: number): string => (text.length >= width ? `${text}  ` : text.padEnd(width))

function agoText(measuredAt: number | null, nowMs: number): string {
  if (measuredAt === null) return 'nunca medido'
  const s = Math.max(0, Math.round((nowMs - measuredAt) / 1000))
  if (s < 60) return s < 10 ? 'medido agora' : `medido há ${s} s`
  const min = Math.round(s / 60)
  if (min < 60) return `medido há ${min} min`
  const h = Math.round(min / 60)
  return h < 24 ? `medido há ${h} h` : `medido há ${Math.round(h / 24)} d`
}

export function renderPanel(d: PanelData, opts: RenderOpts): string {
  const { nowMs, timeZone } = opts
  const lines: string[] = []
  const reset = (epochS: number): string => `reseta ${formatReset(epochS, nowMs, timeZone)}`
  const rule = '─'.repeat(58)

  const activeOverride = (m: PanelData['mux'][number]): { account: string; until: number } | undefined =>
    m.override && m.override.until > nowMs ? m.override : undefined
  const currentCell = (m: PanelData['mux'][number]): string => {
    const o = activeOverride(m)
    if (!o) return m.current ?? '—'
    const until = formatReset(o.until / 1000, nowMs, timeZone)
    return o.account === m.current ? `${m.current} (manual até ${until})` : `${m.current ?? '—'} (manual: ${o.account} até ${until})`
  }

  // larguras: o mínimo do design, ampliado se um nome ou uma barra de 100% não couber
  const rows = d.accounts.filter((a) => !a.sameAs || !d.accounts.some((r) => r.name === a.sameAs))
  const nameW = Math.max(10, ...d.accounts.map((a) => a.name.length + 2), ...d.mux.map((m) => m.name.length + 2))
  const cells5 = rows.map((a) => (a.measurement?.ok ? bar(a.measurement.fiveHour.utilization).length : 0))
  const cells7 = rows.map((a) => (a.measurement?.ok ? bar(a.measurement.sevenDay.utilization).length : 0))
  const w5 = Math.max(14, ...cells5)
  const w7 = Math.max(14, ...cells7)
  const spanW = w5 + 2 + w7 + 3

  if (rows.length === 0) {
    lines.push('nenhuma conta registrada — rode `sb login <conta>`')
  } else {
    lines.push(`${'conta'.padEnd(nameW)}${'5h'.padEnd(w5 + 2)}${'semanal'.padEnd(w7 + 3)}muxes`)
    for (const a of rows) {
      const m = a.measurement
      const muxes = a.name === 'keychain' ? a.muxes.map((x) => x.mux).join(' · ') : a.muxes.length > 0 ? muxesText(a.muxes) : 'sem mux'
      if (a.name === 'keychain') {
        lines.push(`${a.name.padEnd(nameW)}${cell('não medido', spanW)}${muxes}`)
      } else if (m?.ok) {
        lines.push(`${a.name.padEnd(nameW)}${bar(m.fiveHour.utilization).padEnd(w5 + 2)}${bar(m.sevenDay.utilization).padEnd(w7 + 3)}${muxes}`)
        lines.push(`${' '.repeat(nameW)}${reset(m.fiveHour.resetsAt).padEnd(w5 + 2)}${reset(m.sevenDay.resetsAt)}`)
      } else {
        lines.push(`${a.name.padEnd(nameW)}${cell(failureText(m), spanW)}${muxes}`)
      }
      for (const dup of d.accounts.filter((x) => x.sameAs === a.name)) {
        lines.push(`  └ ${dup.name} (mesma conta que ${a.name})${dup.muxes.length > 0 ? `  ${muxesText(dup.muxes)}` : ''}`)
      }
    }
  }

  lines.push(rule)
  if (d.mux.length > 0) {
    const curW = Math.max(10, ...d.mux.map((m) => currentCell(m).length + 2))
    const prefW = Math.max(11, ...d.mux.map((m) => m.preferred.length + 2))
    lines.push(`${'mux'.padEnd(nameW)}${'atual'.padEnd(curW)}${'preferida'.padEnd(prefW)}pool (ordem = prioridade)`)
    for (const m of d.mux) {
      const pool = m.pool.length > 0 ? m.pool.join(' → ') : 'sem hot-swap'
      lines.push(`${m.name.padEnd(nameW)}${currentCell(m).padEnd(curW)}${m.preferred.padEnd(prefW)}${pool}`)
    }
    lines.push(rule)
  }

  const total = `5h ${d.total.fiveHour === null ? '—' : pct(d.total.fiveHour)} · semanal ${d.total.sevenDay === null ? '—' : pct(d.total.sevenDay)}`
  const auto = `auto-swap ${d.auto ? 'ligado' : 'desligado'} (${pct(d.threshold.fiveHour)} / ${pct(d.threshold.sevenDay)})`
  lines.push(`${'total'.padEnd(nameW)}${total.padEnd(26)}${auto}`)
  lines.push(`${' '.repeat(nameW)}${NOTE}`)
  if (d.pins.length > 0) lines.push(`sessões fixas: ${d.pins.map((p) => `${p.jobId} → ${p.account}`).join(', ')}`)
  lines.push(agoText(d.measuredAt, nowMs))
  return `${lines.map((l) => l.trimEnd()).join('\n')}\n`
}

const TOKEN_TEXT: Record<AccountInfo['token'], string> = {
  ok: 'ok',
  missing: 'sem token',
  'invalid-json': 'JSON inválido',
  dead: 'morto',
}

/** Resumo de uma linha: `5h 10% (reseta 15:50) · semanal 20% (reseta 06/11)`, a falha da sonda ou a duplicata. */
function usageSummary(a: AccountInfo, opts: RenderOpts): string {
  if (a.sameAs) return `mesma conta que ${a.sameAs}`
  const m = a.measurement
  if (!m?.ok) return failureText(m)
  const r = (epochS: number): string => `reseta ${formatReset(epochS, opts.nowMs, opts.timeZone)}`
  return `5h ${pct(m.fiveHour.utilization)} (${r(m.fiveHour.resetsAt)}) · semanal ${pct(m.sevenDay.utilization)} (${r(m.sevenDay.resetsAt)})`
}

/** `sb accounts`: uma linha por conta registrada, anexada a mux ou não. */
export function renderAccounts(accounts: AccountInfo[], opts: RenderOpts): string {
  if (accounts.length === 0) return 'nenhuma conta registrada — rode `sb login <conta>`\n'
  const nameW = Math.max(10, ...accounts.map((a) => a.name.length + 2))
  const tokenW = Math.max(...Object.values(TOKEN_TEXT).map((t) => t.length)) + 2
  const summaries = accounts.map((a) => usageSummary(a, opts))
  const sumW = Math.max(...summaries.map((s) => s.length)) + 2
  const lines = [`${'conta'.padEnd(nameW)}${'token'.padEnd(tokenW)}${'uso'.padEnd(sumW)}muxes`]
  accounts.forEach((a, i) => {
    const muxes = a.attached ? muxesText(a.muxes) : 'sem mux'
    lines.push(`${a.name.padEnd(nameW)}${TOKEN_TEXT[a.token].padEnd(tokenW)}${summaries[i]!.padEnd(sumW)}${muxes}`)
  })
  return `${lines.map((l) => l.trimEnd()).join('\n')}\n`
}

export interface MuxRow {
  name: string
  root: string
  default: boolean
  current: string | null
  preferred: string
  accounts: string[]
  pool: string[]
}

/** `sb mux`: um mux por linha; `*` marca o default. */
export function renderMuxList(rows: MuxRow[]): string {
  if (rows.length === 0) return 'nenhum mux definido (crie um com `sb mux add <nome> --root <pasta> --account <conta>`)\n'
  const head = ['mux', 'root', 'atual', 'preferida', 'pool (ordem = prioridade)', 'só permitidas']
  const body = rows.map((r) => [
    r.default ? `${r.name} *` : r.name,
    r.root,
    r.current ?? '—',
    r.preferred,
    r.pool.length ? r.pool.join(' → ') : 'sem hot-swap',
    r.accounts.filter((a) => !r.pool.includes(a)).join(', ') || '—',
  ])
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)))
  const line = (cols: string[]): string => cols.map((c, i) => (i === cols.length - 1 ? c : cell(c, widths[i]!))).join('  ')
  return `${[line(head), ...body.map(line)].join('\n')}\n\n* = default (pastas fora de todo root)\n`
}

export interface SwapReport {
  mux: string
  noop: boolean
  from: string
  to: string
  stopped: string[]
  waitingBusy: string[]
  keptScheduled: string[]
  failed: Array<{ id: string; error: string }>
  /** a sessão que chamou (`CLAUDE_JOB_DIR`) está entre as que esperam (nunca é parada pelo comando) */
  callerWaiting: boolean
  /** override manual ativo depois da troca (`until` em ms); `resetKnown`: o prazo é o reset medido da preferida, não a estimativa agora + 5 h */
  override: { account: string; until: number; resetKnown: boolean } | null
}

/** `sb swap`: o que mudou e o que ficou esperando. */
export function renderSwap(r: SwapReport, opts: RenderOpts): string {
  const lines: string[] = []
  if (r.noop) lines.push(`mux ${r.mux} já está em ${r.to}: nada a trocar`)
  else lines.push(`mux ${r.mux}: ${r.from} → ${r.to}`)
  if (r.override) {
    const until = formatReset(r.override.until / 1000, opts.nowMs, opts.timeZone)
    const why = r.override.resetKnown ? 'reset da preferida' : '~5 h: a preferida não tem reset conhecido'
    lines.push(`manual até ${until} (${why}); \`sb swap ${r.mux} --clear\` desfaz`)
  }
  if (!r.noop) {
    if (r.stopped.length > 0) lines.push(`paradas (reabra para usar ${r.to}): ${r.stopped.join(', ')}`)
    if (r.waitingBusy.length > 0) lines.push(`aguardando o fim do turno: ${r.waitingBusy.join(', ')}`)
    if (r.callerWaiting) lines.push('a sessão que chamou este comando NÃO será parada por ele: o watch a reinicia quando o turno dela terminar')
    if (r.keptScheduled.length > 0) lines.push(`mantidas, com trabalho agendado: ${r.keptScheduled.join(', ')}`)
    for (const f of r.failed) lines.push(`não consegui parar ${f.id}: ${f.error}`)
    if (r.stopped.length + r.waitingBusy.length + r.keptScheduled.length + r.failed.length === 0) lines.push('nenhuma sessão antiga para reiniciar')
  }
  return `${lines.join('\n')}\n`
}

/** O que ficou para trás num troca/reinício: o que espera, o que não foi parado e o que o teto ou o recuo adiou. */
function heldBack(x: { waitingBusy: string[]; keptScheduled: string[]; failed: Array<{ id: string; error: string }>; deferred?: string[] }): string[] {
  const out: string[] = []
  if (x.waitingBusy.length > 0) out.push(`  aguardando o fim do turno: ${x.waitingBusy.join(', ')}`)
  if (x.keptScheduled.length > 0) out.push(`  mantidas, com trabalho agendado: ${x.keptScheduled.join(', ')}`)
  for (const f of x.failed) out.push(`  não consegui parar ${f.id}: ${f.error}`)
  if (x.deferred !== undefined && x.deferred.length > 0) out.push(`  adiadas para o próximo ciclo (teto de paradas ou falha anterior): ${x.deferred.join(', ')}`)
  return out
}

/** `sb watch --once`: o que o ciclo mediu, avaliou e fez. */
export function renderTick(r: TickReport): string {
  if (r.skipped === 'locked') return 'outro sb está com o lock do estado: nada foi feito neste ciclo\n'
  const lines = [r.measured ? 'uso medido agora' : 'uso: medição recente reaproveitada (nenhuma chamada à API)']
  for (const e of r.evaluations) lines.push(e.desired === e.current ? `mux ${e.mux}: fica em ${e.current}` : `mux ${e.mux}: ${e.current} → ${e.desired} (conta desejada)`)
  for (const s of r.swaps) {
    lines.push(`troca no mux ${s.mux}: ${s.from} → ${s.to}`)
    if (s.stopped.length > 0) lines.push(`  paradas (reabra para usar ${s.to}): ${s.stopped.join(', ')}`)
    lines.push(...heldBack(s))
  }
  for (const [mux, x] of Object.entries(r.restarts)) {
    if (r.swaps.some((s) => s.mux === mux)) continue
    const held = heldBack(x)
    if (x.stopped.length > 0) lines.push(`mux ${mux}: sessões antigas paradas: ${x.stopped.join(', ')}`)
    if (held.length > 0) lines.push(`mux ${mux}: sessões antigas`, ...held)
  }
  for (const p of r.pending) lines.push(p.result === 'queued' ? `fila: sessão ${p.jobId} ainda espera` : `fila: sessão ${p.jobId} ${p.result === 'gone' ? 'descartada' : p.result}`)
  if (r.kept.length > 0) lines.push(`mantidas (state.json sem inFlight; nunca reiniciadas): ${r.kept.join(', ')}`)
  for (const n of r.notices) lines.push(`• ${n}`)
  return `${lines.join('\n')}\n`
}

/** `sb install`: o que foi (ou seria) feito, com `~` no lugar da home. */
export function renderInstall(r: InstallResult, home: string): string {
  const short = (p: string): string => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p)
  const verb: Record<InstallResult['files'][number]['status'], string> = { written: 'gravado', unchanged: 'já estava igual', 'would-write': 'seria gravado' }
  const lines = r.simular ? ['Simulação: nada foi gravado e o launchctl não foi chamado.'] : []
  for (const f of r.files) lines.push(`${short(f.file)}  (${verb[f.status]})`)
  const z = r.zshrc
  const file = short(z.file)
  if (z.status === 'claude-conta') lines.push(`${file}: tem a linha do claude-conta; não mexi. Rode \`sb migrate\` para trocar pelo switchboard.`)
  else if (z.status === 'different') lines.push(`${file}: já existe outra linha "# switchboard" (outro diretório de estado?); não mexi. Troque por: ${z.line}`)
  else if (z.status === 'present') lines.push(`${file}: a linha do wrapper já está lá`)
  else lines.push(`${file}: ${z.status === 'appended' ? 'linha do wrapper acrescentada (abra um terminal novo para valer)' : 'a linha do wrapper seria acrescentada'}`)
  if (r.launchd.status === 'loaded') lines.push(`launchd: watch carregado em ${r.launchd.domain}`)
  else if (r.launchd.status === 'failed') lines.push(`launchd: não consegui carregar o watch em ${r.launchd.domain}: ${r.launchd.error ?? 'erro desconhecido'}`)
  else lines.push('launchd: o watch seria (re)carregado')
  return `${lines.join('\n')}\n`
}
