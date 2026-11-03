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
