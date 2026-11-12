import { accessSync, closeSync, constants, existsSync, openSync, readSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Ctx } from './ctx.js'
import { EXIT, SbError } from './errors.js'
import { mkdirPrivate, writeAtomic } from './fsx.js'
import { resolvePaths, type Paths } from './paths.js'

export const LAUNCH_LABEL = 'com.gabriellst.switchboard.watch'

/** Marcas nas linhas do `~/.zshrc`: a do `claude-conta` (não mexemos) e a nossa. */
export const OLD_MARK = '# claude-conta'
const OUR_MARK = '# switchboard'

export const plistFile = (p: Paths): string => join(p.launchAgentsDir, `${LAUNCH_LABEL}.plist`)
export const wrapperFile = (p: Paths): string => join(p.stateDir, 'wrapper.zsh')
export const slashCommandFile = (p: Paths): string => join(p.claudeDir, 'commands', 'sb.md')

export interface InstallFile {
  file: string
  content: string
  mode: number
}

export interface InstallPlanOptions {
  /** executável que roda o CLI (`process.execPath`: node ou bun), caminho absoluto */
  runtimeBin: string
  /** o `cli.js` (ou `cli.ts`), caminho absoluto */
  cliPath: string
  /** diretório do `claude` no PATH: o `watch` sob o launchd não herda o PATH do terminal */
  claudeDir: string
  /** todas as pastas do PATH com um `claude` (binário antes de invólucro); padrão: só `claudeDir` */
  claudeDirs?: string[]
}

/** Aspas simples para o shell (zsh/sh); caminho "limpo" fica como está, para a linha do zshrc ficar legível. */
export function shQuote(s: string): string {
  return /^[A-Za-z0-9_/.:@%+=,~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const WATCH_KEYS = ['SWITCHBOARD_CONFIG', 'SWITCHBOARD_STATE_DIR', 'SWITCHBOARD_JOBS_DIR'] as const
type WatchKey = (typeof WATCH_KEYS)[number]

/** Os três caminhos que o `watch` recebe, sempre ABSOLUTOS (um valor relativo vale contra a pasta de quem instala, agora). */
export function watchEnvOf(p: Paths): Record<WatchKey, string> {
  return { SWITCHBOARD_CONFIG: resolve(p.configFile), SWITCHBOARD_STATE_DIR: resolve(p.stateDir), SWITCHBOARD_JOBS_DIR: resolve(p.jobsDir) }
}

const xmlUnescape = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** `EnvironmentVariables` de um plist (só pares chave/string, do jeito que o `plistContent` os escreve). */
function plistEnv(content: string): Record<string, string> {
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(content)?.[1] ?? ''
  const out: Record<string, string> = {}
  for (const m of dict.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) out[xmlUnescape(m[1]!)] = xmlUnescape(m[2]!)
  return out
}

/**
 * O ambiente do `watch` sob o launchd: PATH, HOME e os caminhos RESOLVIDOS de quem instala (config, estado, jobs). Sem eles, um
 * `XDG_STATE_HOME`/`SWITCHBOARD_*` do shell faria o CLI e o wrapper usarem um estado e o `watch` outro. Nunca vão para cá os
 * seams de teste (`SWITCHBOARD_CLAUDE`, `_API_BASE`, `_PS`, `_NO_NOTIFY`) nem token.
 */
function plistContent(p: Paths, o: InstallPlanOptions): string {
  const watchEnv = watchEnvOf(p)
  const pathDirs = [...new Set([...(o.claudeDirs ?? [o.claudeDir]), dirname(o.runtimeBin), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])]
  const log = join(p.stateDir, 'log', 'watch.out')
  const str = (s: string): string => `<string>${xmlEscape(s)}</string>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(LAUNCH_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${str(o.runtimeBin)}
    ${str(o.cliPath)}
    ${str('watch')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  ${str(log)}
  <key>StandardErrorPath</key>
  ${str(log)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${str(pathDirs.join(delimiter))}
    <key>HOME</key>
    ${str(p.home)}
${WATCH_KEYS.map((k) => `    <key>${k}</key>\n    ${str(watchEnv[k])}`).join('\n')}
  </dict>
</dict>
</plist>
`
}

/** Subcomandos do `claude` que não abrem sessão: passam direto (sem `--settings`), só sem o token herdado. */
const PASSTHROUGH = 'auth|attach|logs|stop|kill|rm|respawn|mcp|plugin|plugins|doctor|update|upgrade|install|\\\n    setup-token|daemon|purge|import|gateway|ultrareview|auto-mode|help'

/**
 * A função `claude()` do zsh. Falha fechado: sem `--settings` o `claude` rodaria na conta do keychain (a de outro
 * projeto), então se o `sb which` falhar a função avisa e devolve 1 sem chamar o `claude`. Os caminhos do `sb` ficam
 * gravados aqui (não depende de `sb` no PATH).
 */
function wrapperContent(o: InstallPlanOptions): string {
  const rt = shQuote(o.runtimeBin)
  const cli = shQuote(o.cliPath)
  return `# switchboard — gerado por \`sb install\` (não editar à mão; rode \`sb install\` de novo).
# Acrescenta --settings <estado>/mux/<mux da pasta>.json a todo \`claude\`, dentro ou fora de uma sessão Claude.
# Desligar: remova do ~/.zshrc a linha que termina em "${OUR_MARK}".
# Um alias \`claude\` preexistente faria o zsh recusar \`claude() {\` (e o claude rodaria sem --settings): tira o alias
# e define a função na forma com a palavra \`function\`, que não expande alias.
unalias claude 2>/dev/null
function claude {
  local a cwd= prev= s i
  local -a args
  # 1) Subcomando de manutenção: sempre sem o token herdado (o daemon o repassaria a todas as sessões), mesmo dentro de uma sessão.
  case \${1-} in
    ${PASSTHROUGH})
      ( unset CLAUDE_CODE_OAUTH_TOKEN; command claude "$@" ); return ;;
  esac
  # 2) --settings explícito (antes de um \`--\`): passa direto, sem o token herdado.
  for a in "$@"; do
    [[ $a == -- ]] && break
    case $a in
      --settings|--settings=*) ( unset CLAUDE_CODE_OAUTH_TOKEN; command claude "$@" ); return ;;
      --cwd=*) cwd=\${a#--cwd=} ;;
    esac
    [[ $prev == --cwd ]] && cwd=$a
    prev=$a
  done
  # 3) O resto (dentro ou fora de uma sessão Claude: um agente que roda \`claude --bg\` ou \`claude agents\` numa sessão cairia no
  #    daemon com o token dela): o settings do mux da pasta. Sem ele o claude cairia no keychain, então qualquer falha recusa.
  if [[ ! -x ${rt} || ! -r ${cli} ]]; then
    print -ru2 -- "✗ sb: o sb mudou de lugar ou foi removido; o claude NÃO foi aberto. Rode: sb install"
    return 1
  fi
  cwd=\${cwd/#\\~/$HOME}
  if ! s=$(${rt} ${cli} which "\${cwd:-$PWD}") || [[ -z $s ]]; then
    print -ru2 -- "✗ sb: não consegui o settings do mux desta pasta; o claude NÃO foi aberto (rode: sb doctor)."
    return 1
  fi
  # --settings antes do primeiro \`--\`: depois dele seria argumento posicional e o claude rodaria no keychain.
  args=("$@")
  i=\${args[(ie)--]}
  args[i,0]=(--settings "$s")
  ( unset CLAUDE_CODE_OAUTH_TOKEN; command claude "\${args[@]}" )
}
`
}

const SLASH_COMMAND = `---
description: Contas do Claude Code por pasta (uso, troca, fixar sessão) — o painel do switchboard
argument-hint: "[usage | swap <mux> [conta] | pin <sessão> <conta> | unpin <sessão> | accounts | mux]"
allowed-tools: Bash(sb:*)
disable-model-invocation: true
---
!\`sb $ARGUMENTS 2>&1\`

Repita para o usuário, em poucas linhas e em português, o que o comando acima respondeu. Não rode mais nada.
`

/** Os três arquivos do `sb install`, sem tocar o disco. */
export function planInstall(paths: Paths, o: InstallPlanOptions): InstallFile[] {
  return [
    { file: plistFile(paths), content: plistContent(paths, o), mode: 0o644 },
    { file: wrapperFile(paths), content: wrapperContent(o), mode: 0o644 },
    { file: slashCommandFile(paths), content: SLASH_COMMAND, mode: 0o644 },
  ]
}

/**
 * O `process.execPath` é o caminho versionado (ex.: /opt/homebrew/Cellar/node/25.1/bin/node): um `brew upgrade` o apaga.
 * Prefere a entrada do PATH que resolve para o mesmo binário (ex.: /opt/homebrew/bin/node); sem ela, o próprio execPath.
 */
export function stableRuntime(env: Record<string, string | undefined>, execPath: string): string {
  let real: string
  try {
    real = realpathSync(execPath)
  } catch {
    return execPath
  }
  const name = basename(execPath)
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, name)
    try {
      if (realpathSync(candidate) === real) return candidate
    } catch {
      // não está aqui
    }
  }
  return execPath
}

/** Diretório do `claude`: `SWITCHBOARD_CLAUDE` (teste) ou o primeiro executável `claude` do PATH. */
/** O arquivo começa com `#!`? (script: pode ser um invólucro que procura o claude de verdade noutra pasta do PATH) */
function isScript(file: string): boolean {
  try {
    const fd = openSync(file, 'r')
    try {
      const b = Buffer.alloc(2)
      return readSync(fd, b, 0, 2, 0) === 2 && b[0] === 0x23 && b[1] === 0x21
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

/**
 * TODAS as pastas do PATH que têm um `claude` executável, sem repetir: binários primeiro, scripts depois (na ordem do PATH
 * dentro de cada grupo). O primeiro `claude` do PATH pode ser um invólucro (o cmux põe o dele na frente e ele procura o
 * claude de verdade nas OUTRAS pastas): gravar só a pasta dele no LaunchAgent deixa o `watch` sem achar o claude.
 */
export function findClaudeDirs(env: Record<string, string | undefined>): string[] {
  if (env.SWITCHBOARD_CLAUDE) return [dirname(env.SWITCHBOARD_CLAUDE)]
  const bins: string[] = []
  const scripts: string[] = []
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || bins.includes(dir) || scripts.includes(dir)) continue
    const f = join(dir, 'claude')
    try {
      if (!statSync(f).isFile()) continue
      accessSync(f, constants.X_OK)
    } catch {
      continue // não está aqui
    }
    ;(isScript(f) ? scripts : bins).push(dir)
  }
  const all = [...bins, ...scripts]
  if (all.length === 0) throw new SbError('não achei o `claude` no PATH', EXIT.CLAUDE, '  instale o Claude Code (ou ponha o diretório dele no PATH) e rode `sb install` de novo')
  return all
}

/** A pasta do `claude` que o `sb` deve usar: a primeira de `findClaudeDirs` (o binário de verdade, se houver). */
export function findClaudeDir(env: Record<string, string | undefined>): string {
  return findClaudeDirs(env)[0]!
}

export type FileStatus = 'written' | 'unchanged' | 'would-write'
export type ZshrcStatus = 'appended' | 'present' | 'would-append' | 'claude-conta' | 'different'
export type LaunchdStatus = 'loaded' | 'failed' | 'skipped'

export interface InstallResult {
  simular: boolean
  /** config, estado e jobs que o `watch` vai usar (os que o plist leva) */
  watch: { config: string; state: string; jobs: string }
  /** o plist que já existia apontava o `watch` para OUTRO config/estado/jobs: antes → depois (aviso; não é erro) */
  watchChanged: Array<{ key: string; from: string; to: string }>
  files: Array<{ file: string; status: FileStatus }>
  zshrc: { file: string; line: string; status: ZshrcStatus }
  launchd: { status: LaunchdStatus; domain: string; error?: string }
}

export interface RunInstallOptions {
  simular: boolean
  /** padrão: o uid do processo */
  uid?: number
  /** como esperar entre as tentativas do `bootstrap`; os testes injetam um que não espera */
  sleep?: (ms: number) => void
}

const BOOTSTRAP_TRIES = 3
const BOOTSTRAP_WAIT_MS = 1_000
const blockingSleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]+/g

function readIfExists(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Uma linha só. Sem o wrapper (apagado, estado movido) um `[ -f ] && source` pularia em silêncio e nenhum `claude()`
 * existiria: todo `claude` rodaria no keychain. O `else` define um `claude` que recusa.
 */
export function zshrcLine(wrapper: string): string {
  const w = shQuote(wrapper)
  const refuse = 'print -ru2 -- "✗ sb: o wrapper do claude sumiu; o claude NÃO foi aberto. Rode: sb install"; return 1'
  return `if [ -f ${w} ]; then source ${w}; else unalias claude 2>/dev/null; function claude { ${refuse}; }; fi  ${OUR_MARK}`
}

function zshrcAction(text: string | undefined, line: string): 'append' | Exclude<ZshrcStatus, 'appended' | 'would-append'> {
  const lines = (text ?? '').split('\n')
  if (lines.some((l) => l.includes(OLD_MARK))) return 'claude-conta' // dois wrappers brigariam: a migração é do `sb migrate`
  if (lines.some((l) => l.trimEnd() === line)) return 'present'
  if (lines.some((l) => l.trimEnd().endsWith(OUR_MARK))) return 'different' // linha nossa de outro estado: o usuário decide
  return 'append'
}

/**
 * Os caminhos que o plist NOVO dá ao `watch` e o que mudou em relação ao plist que já está lá (lido ANTES de gravar). Chave
 * que o plist velho não tinha (instalado antes desta versão) valia o padrão do HOME dele (o launchd não tem `XDG_*`).
 */
function watchPlan(ctx: Ctx, plan: InstallFile[]): Pick<InstallResult, 'watch' | 'watchChanged'> {
  const plist = plistFile(ctx.paths)
  const fresh = { ...watchEnvOf(ctx.paths), ...plistEnv(plan.find((f) => f.file === plist)?.content ?? '') }
  const watch = { config: fresh.SWITCHBOARD_CONFIG, state: fresh.SWITCHBOARD_STATE_DIR, jobs: fresh.SWITCHBOARD_JOBS_DIR }
  const old = readIfExists(plist)
  const watchChanged: InstallResult['watchChanged'] = []
  if (old === undefined) return { watch, watchChanged }
  const before = plistEnv(old)
  let defaults: Record<WatchKey, string> | undefined
  if (before.HOME) {
    try {
      defaults = watchEnvOf(resolvePaths({ HOME: before.HOME }))
    } catch {
      // HOME inválido no plist velho: sem padrão para comparar
    }
  }
  for (const k of WATCH_KEYS) {
    const from = before[k] ?? defaults?.[k]
    if (from !== undefined && from !== fresh[k]) watchChanged.push({ key: k, from, to: fresh[k] })
  }
  return { watch, watchChanged }
}

/**
 * Grava os arquivos do plano, liga a linha no `~/.zshrc` (uma vez) e (re)carrega o LaunchAgent via `ctx.run`.
 * `simular`: só calcula o que faria. Erro do launchctl não lança: sai em `launchd.status = 'failed'` para o comando
 * mostrar o resto do resultado. Idempotente: arquivo igual não é regravado.
 */
export function runInstall(ctx: Ctx, plan: InstallFile[], o: RunInstallOptions): InstallResult {
  const { paths } = ctx
  const uid = o.uid ?? process.getuid?.()
  if (uid === undefined) throw new SbError('não consegui o uid do usuário (o launchd só existe no macOS)', EXIT.USAGE)
  const domain = `gui/${uid}`
  const wrapper = wrapperFile(paths)
  const line = zshrcLine(wrapper)

  if (!o.simular) {
    // o launchd não cria o diretório do StandardOutPath (sem ele o job nem sobe); o estado nasce 700 antes do wrapper
    mkdirPrivate(paths.stateDir)
    mkdirPrivate(join(paths.stateDir, 'log'))
  }
  const { watch, watchChanged } = watchPlan(ctx, plan)
  const files = plan.map(({ file, content, mode }) => {
    const same = readIfExists(file) === content && (statSync(file).mode & 0o777) === mode
    if (o.simular) return { file, status: (same ? 'unchanged' : 'would-write') as FileStatus }
    if (same) return { file, status: 'unchanged' as FileStatus }
    mkdirSync(dirname(file), { recursive: true })
    writeAtomic(file, content, mode)
    return { file, status: 'written' as FileStatus }
  })

  const current = readIfExists(paths.zshrc)
  const action = zshrcAction(current, line)
  let zStatus: ZshrcStatus
  if (action !== 'append') zStatus = action
  else if (o.simular) zStatus = 'would-append'
  else {
    const mode = existsSync(paths.zshrc) ? statSync(paths.zshrc).mode & 0o777 : 0o644
    const text = current ?? ''
    writeAtomic(paths.zshrc, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`, mode)
    zStatus = 'appended'
  }
  const zshrc = { file: paths.zshrc, line, status: zStatus }

  if (o.simular) return { simular: true, watch, watchChanged, files, zshrc, launchd: { status: 'skipped', domain } }

  const plist = plistFile(paths)
  ctx.run('launchctl', ['bootout', `${domain}/${LAUNCH_LABEL}`]) // não carregado → erro esperado, ignorado
  const sleep = o.sleep ?? blockingSleep
  let last = { status: 0 as number | null, stderr: '' }
  for (let i = 0; i < BOOTSTRAP_TRIES; i++) {
    // logo após o bootout o launchd pode ainda estar derrubando a instância velha (EIO): tenta de novo
    if (i > 0) sleep(BOOTSTRAP_WAIT_MS)
    const r = ctx.run('launchctl', ['bootstrap', domain, plist])
    last = { status: r.status, stderr: r.stderr }
    if (r.status === 0) return { simular: false, watch, watchChanged, files, zshrc, launchd: { status: 'loaded', domain } }
  }
  const why = last.stderr.replace(TOKEN_RE, '<token>').trim() || `exit ${last.status ?? 'sem status'}`
  return { simular: false, watch, watchChanged, files, zshrc, launchd: { status: 'failed', domain, error: why } }
}
