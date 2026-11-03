import { readFileSync } from 'node:fs'
import { EXIT, SbError } from './errors.js'
import { writeAtomic } from './fsx.js'
import { runtimeFile, type Paths } from './paths.js'

/** Estado que muda sozinho (swap, overrides manuais, pendências de job); a config não guarda nada disso. */
export interface Runtime {
  mux: Record<string, { since: number; lastSwap?: { at: number; from: string; to: string; reason: string } }>
  overrides: Record<string, { account: string; until: number }>
  pending: Array<{ jobId: string; settings: string; reason: 'pin' | 'unpin' | 'adopt' | 'migrate'; requestedAt: number }>
  notified: Record<string, number>
}

const empty = (): Runtime => ({ mux: {}, overrides: {}, pending: [], notified: {} })

const isRecord = (v: unknown): v is Record<string, never> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Ausente → vazio; campos faltando → padrão; JSON corrompido → erro (zerar em silêncio perderia overrides e pendências). */
export function readRuntime(paths: Paths): Runtime {
  const file = runtimeFile(paths)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty()
    throw e
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new SbError(`runtime.json corrompido: ${file}`, EXIT.CHECK_FAILED, '  apague o arquivo para recomeçar (perde overrides e pendências)')
  }
  const r = empty()
  if (!isRecord(raw)) return r
  if (isRecord(raw.mux)) r.mux = raw.mux
  if (isRecord(raw.overrides)) r.overrides = raw.overrides
  if (Array.isArray(raw.pending)) r.pending = raw.pending as Runtime['pending']
  if (isRecord(raw.notified)) r.notified = raw.notified
  return r
}

/** Quem faz ler-modificar-gravar embrulha tudo em `withLock`. */
export function writeRuntime(paths: Paths, r: Runtime): void {
  writeAtomic(runtimeFile(paths), `${JSON.stringify(r, null, 2)}\n`, 0o600)
}
