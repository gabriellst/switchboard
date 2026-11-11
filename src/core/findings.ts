export type Severity = 'error' | 'warn'

/** Código estável de cada achado do `sb doctor`: é API do `--json` (a `message` é texto livre). */
export type FindingCode =
  // erros
  | 'config.invalid' // config ausente ou inválida (exit 2)
  | 'config.no-token' // conta registrada sem `tokens/<conta>.json`
  | 'link.broken' // link de mux/pin ausente, quebrado ou com alvo inválido (F6)
  | 'token.invalid-json' // JSON do token inválido: o claude ignoraria o settings e cairia no keychain (F6)
  | 'token.no-oauth' // token sem `env.CLAUDE_CODE_OAUTH_TOKEN`
  | 'token.dead' // a última medição foi 401/403
  | 'token.perms' // `tokens/*.json` fora de 600
  | 'session.no-settings' // sessão em segundo plano sob o root de um mux (conta ≠ keychain), sem `--settings`
  | 'view.no-settings' // `claude agents` aberto sem `--settings` de `<estado>/mux/`
  // avisos
  | 'state.perms' // diretório de estado fora de 700
  | 'pool.duplicates' // contas que são a mesma (mesmo uso) dentro de um pool
  | 'pool.preferred-outside' // preferida fora do pool (o mux nunca sai dela sozinho)
  | 'account.unattached' // conta registrada que nenhum mux usa
  | 'link.orphan' // link (ou token) que sobrou de uma conta/mux que saiu da config
  | 'session.legacy' // sessão do claude-conta (`~/.claude/contas*`)
  | 'session.foreign' // sessão com `--settings` de terceiros
  | 'view.legacy' // `claude agents` aberto com o settings do claude-conta
  | 'watch.stopped' // o watch não está rodando
  | 'claude.format' // o adaptador recusou o formato interno do claude

export interface Finding {
  severity: Severity
  code: FindingCode
  subject: string
  message: string
}

export const hasErrors = (findings: Finding[]): boolean => findings.some((f) => f.severity === 'error')

/** Achados que `sb doctor --fix` sabe consertar (o resto é decisão do usuário: token ruim, view aberta...). */
export const FIXABLE: ReadonlySet<FindingCode> = new Set<FindingCode>(['state.perms', 'token.perms', 'link.broken', 'session.no-settings'])

/** Trecho da mensagem de `session.no-settings` quando o pedido de adoção já está em `runtime.pending` (o `--fix` não tem mais o que fazer). */
export const ADOPT_QUEUED_NOTE = 'adoção já na fila'
