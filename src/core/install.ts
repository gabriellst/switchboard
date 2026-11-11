import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { Ctx } from './ctx.js'
import { EXIT, SbError } from './errors.js'
import { mkdirPrivate, writeAtomic } from './fsx.js'
import type { Paths } from './paths.js'

export const LAUNCH_LABEL = 'com.gabriellst.switchboard.watch'

/** Marcas nas linhas do `~/.zshrc`: a do `claude-conta` (não mexemos) e a nossa. */
const OLD_MARK = '# claude-conta'
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
}

/** Aspas simples para o shell (zsh/sh); caminho "limpo" fica como está, para a linha do zshrc ficar legível. */
export function shQuote(s: string): string {
  return /^[A-Za-z0-9_/.:@%+=,~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

function plistContent(p: Paths, o: InstallPlanOptions): string {
  const pathDirs = [...new Set([o.claudeDir, dirname(o.runtimeBin), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])]
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
  const sb = `${shQuote(o.runtimeBin)} ${shQuote(o.cliPath)}`
  return `# switchboard — gerado por \`sb install\` (não editar à mão; rode \`sb install\` de novo).
# Acrescenta --settings <estado>/mux/<mux da pasta>.json a todo \`claude\` aberto fora de uma sessão.
# Desligar: remova do ~/.zshrc a linha que termina em "${OUR_MARK}".
claude() {
  # Dentro de uma sessão Claude: o filho herda a conta da própria sessão.
  if [[ -n \${CLAUDECODE-} ]]; then command claude "$@"; return; fi
  # Nunca repassar um token herdado: se este comando subir o daemon, ele iria junto para todas as sessões.
  case \${1-} in
    ${PASSTHROUGH})
      ( unset CLAUDE_CODE_OAUTH_TOKEN; command claude "$@" ); return ;;
  esac
  local a cwd= prev= s
  for a in "$@"; do
    case $a in
      --settings|--settings=*) ( unset CLAUDE_CODE_OAUTH_TOKEN; command claude "$@" ); return ;;
      --cwd=*) cwd=\${a#--cwd=} ;;
    esac
    [[ $prev == --cwd ]] && cwd=$a
    prev=$a
  done
  cwd=\${cwd/#\\~/$HOME}
  # Sem --settings o claude cairia no keychain: se o \`sb which\` falhar, não abre.
  if ! s=$(${sb} which "\${cwd:-$PWD}") || [[ -z $s ]]; then
    print -ru2 -- "✗ sb: não consegui o settings do mux desta pasta; o claude NÃO foi aberto (rode: sb doctor)."
    return 1
  fi
  ( unset CLAUDE_CODE_OAUTH_TOKEN; command claude "$@" --settings "$s" )
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

/** Diretório do `claude`: `SWITCHBOARD_CLAUDE` (teste) ou o primeiro executável `claude` do PATH. */
export function findClaudeDir(env: Record<string, string | undefined>): string {
  if (env.SWITCHBOARD_CLAUDE) return dirname(env.SWITCHBOARD_CLAUDE)
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const f = join(dir, 'claude')
    try {
      if (!statSync(f).isFile()) continue
      accessSync(f, constants.X_OK)
      return dir
    } catch {
      // não está aqui
    }
  }
  throw new SbError('não achei o `claude` no PATH', EXIT.CLAUDE, '  instale o Claude Code (ou ponha o diretório dele no PATH) e rode `sb install` de novo')
}

export type FileStatus = 'written' | 'unchanged' | 'would-write'
export type ZshrcStatus = 'appended' | 'present' | 'would-append' | 'claude-conta' | 'different'
export type LaunchdStatus = 'loaded' | 'failed' | 'skipped'

export interface InstallResult {
  simular: boolean
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

function zshrcAction(text: string | undefined, line: string): 'append' | Exclude<ZshrcStatus, 'appended' | 'would-append'> {
  const lines = (text ?? '').split('\n')
  if (lines.some((l) => l.includes(OLD_MARK))) return 'claude-conta' // dois wrappers brigariam: a migração é do `sb migrate`
  if (lines.some((l) => l.trimEnd() === line)) return 'present'
  if (lines.some((l) => l.trimEnd().endsWith(OUR_MARK))) return 'different' // linha nossa de outro estado: o usuário decide
  return 'append'
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
  const line = `[ -f ${shQuote(wrapper)} ] && source ${shQuote(wrapper)}  ${OUR_MARK}`

  if (!o.simular) {
    // o launchd não cria o diretório do StandardOutPath (sem ele o job nem sobe); o estado nasce 700 antes do wrapper
    mkdirPrivate(paths.stateDir)
    mkdirPrivate(join(paths.stateDir, 'log'))
  }
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

  if (o.simular) return { simular: true, files, zshrc, launchd: { status: 'skipped', domain } }

  const plist = plistFile(paths)
  ctx.run('launchctl', ['bootout', `${domain}/${LAUNCH_LABEL}`]) // não carregado → erro esperado, ignorado
  const sleep = o.sleep ?? blockingSleep
  let last = { status: 0 as number | null, stderr: '' }
  for (let i = 0; i < BOOTSTRAP_TRIES; i++) {
    // logo após o bootout o launchd pode ainda estar derrubando a instância velha (EIO): tenta de novo
    if (i > 0) sleep(BOOTSTRAP_WAIT_MS)
    const r = ctx.run('launchctl', ['bootstrap', domain, plist])
    last = { status: r.status, stderr: r.stderr }
    if (r.status === 0) return { simular: false, files, zshrc, launchd: { status: 'loaded', domain } }
  }
  const why = last.stderr.replace(TOKEN_RE, '<token>').trim() || `exit ${last.status ?? 'sem status'}`
  return { simular: false, files, zshrc, launchd: { status: 'failed', domain, error: why } }
}
