import {
  chmodSync,
  closeSync,
  fchmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { EXIT, SbError } from './errors.js'
import { lockFile, type Paths } from './paths.js'

let counter = 0
/** Nome de temporário que não colide entre processos (pid) nem entre chamadas no mesmo processo (contador). */
const tmpName = (base: string): string => `${base}.${process.pid}.${counter++}.tmp`

/**
 * Se `path` é symlink (dotfiles), devolve o alvo final — mesmo que ainda não exista —, para
 * gravar nele em vez de trocar o link por um arquivo comum.
 */
function resolveTarget(path: string): string {
  let current = path
  for (let hops = 0; hops < 40; hops++) {
    let isLink = false
    try {
      isLink = lstatSync(current).isSymbolicLink()
    } catch {
      return current // inexistente: arquivo novo
    }
    if (!isLink) return current
    current = resolve(dirname(current), readlinkSync(current))
  }
  throw new SbError(`symlink demais (ciclo?): ${path}`, EXIT.CHECK_FAILED)
}

/** Grava `text` num temporário ao lado, ajusta o modo e faz `rename`: leitor nunca vê arquivo pela metade. */
export function writeAtomic(path: string, text: string, mode: number): void {
  const target = resolveTarget(path)
  const tmp = tmpName(target)
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', mode)
    writeSync(fd, text)
    fchmodSync(fd, mode) // o `mode` do open passa pelo umask; o pedido é exato
    closeSync(fd)
    fd = undefined
    renameSync(tmp, target)
  } catch (e) {
    if (fd !== undefined) closeSync(fd)
    rmSync(tmp, { force: true })
    throw e
  }
}

/** Troca o destino de `link` de uma vez: cria o link com outro nome e faz `rename` por cima. */
export function symlinkAtomic(link: string, target: string): void {
  const tmp = tmpName(link)
  try {
    symlinkSync(target, tmp)
    renameSync(tmp, link)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

export function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

// ---------------------------------------------------------------------------------------------
// Lock: `<state>/lock` criado com O_EXCL contendo o pid. Lock de pid morto é tomado. (Não flock.)

/** Conteúdo sem pid legível e mais velho que isto: lixo (o dono grava o pid logo após criar). */
const GARBAGE_AFTER_MS = 5_000
const POLL_MS = 50

type LockState = { kind: 'live'; pid: number } | { kind: 'forming' } | { kind: 'stale' } | { kind: 'gone' } | { kind: 'unknown' }

/** O processo existe (sinal 0). `EPERM` conta: existe, só não é nosso. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // existe, só não é nosso
  }
}

function inspect(file: string): LockState {
  let text: string
  let ageMs: number
  try {
    text = readFileSync(file, 'utf8')
    ageMs = Date.now() - statSync(file).mtimeMs
  } catch (e) {
    // só ENOENT é "sumiu"; qualquer outro erro (EACCES, EISDIR...) é lock que não dá para julgar: conta como preso.
    // Symlink quebrado também dá ENOENT na leitura, mas o caminho existe (o `wx` do create recusa): é "unknown", não "gone".
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'unknown' }
    try {
      lstatSync(file)
      return { kind: 'unknown' }
    } catch {
      return { kind: 'gone' }
    }
  }
  const pid = /^\d+$/.test(text.trim()) ? Number(text.trim()) : 0
  if (pid > 0) return isAlive(pid) ? { kind: 'live', pid } : { kind: 'stale' }
  return ageMs > GARBAGE_AFTER_MS ? { kind: 'stale' } : { kind: 'forming' }
}

/** Cria o lock; `false` se já existe. O arquivo nasce vazio e ganha o pid logo em seguida. */
function tryCreate(file: string): boolean {
  let fd: number
  try {
    fd = openSync(file, 'wx', 0o600)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
  try {
    writeSync(fd, String(process.pid))
  } finally {
    closeSync(fd)
  }
  return true
}

/**
 * Retira um lock que parecia morto. Move-o para um nome único (só um tomador vence o `rename`) e
 * confere o que foi movido: se na verdade era um lock vivo de alguém que acabou de tomá-lo,
 * devolve-o (`link` não sobrescreve).
 */
function breakStale(file: string): void {
  const grave = tmpName(`${file}.stale`)
  try {
    renameSync(file, grave)
  } catch {
    return // outro tomador chegou primeiro
  }
  if (inspect(grave).kind === 'stale') {
    rmSync(grave, { force: true })
    return
  }
  try {
    linkSync(grave, file)
  } catch {
    // alguém já criou outro lock: o dono devolvido perdeu; janela mínima, ver relatório
  }
  rmSync(grave, { force: true })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Exclusão mútua entre processos `sb` (e entre chamadas no mesmo processo: o dono vivo é este pid).
 * Espera até `waitMs`; passado o prazo lança exit 5. Quem chama faz o ler-modificar-gravar dentro de `fn`
 * (`editConfig`, `writeRuntime`...).
 */
export async function withLock<T>(paths: Paths, fn: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  const waitMs = opts.waitMs ?? 30_000
  const file = lockFile(paths)
  mkdirPrivate(dirname(file))
  const deadline = Date.now() + waitMs
  for (;;) {
    if (tryCreate(file)) break
    const state = inspect(file)
    // prazo checado em TODA volta, seja qual for o estado: nenhum caminho pode girar sem fim
    if (Date.now() >= deadline) {
      const who = state.kind === 'live' ? ` (pid ${state.pid})` : ''
      const waited = waitMs < 1_000 ? `${waitMs}ms` : `${Math.round(waitMs / 1000)}s`
      throw new SbError(
        `outro sb está rodando${who}; tentei por ${waited}`,
        EXIT.LOCKED,
        `  tente de novo daqui a pouco; se não há outro sb rodando, apague ${file}`,
      )
    }
    if (state.kind === 'stale') breakStale(file)
    await sleep(state.kind === 'stale' || state.kind === 'gone' ? 1 : POLL_MS)
  }
  try {
    return await fn()
  } finally {
    // só apaga se ainda for nosso (alguém pode ter tomado o lock à força)
    if (readFileSyncSafe(file) === String(process.pid)) rmSync(file, { force: true })
  }
}

function readFileSyncSafe(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Arquivo de pid (ex.: login em andamento): mesma mecânica do lock (O_EXCL + pid, dono morto é tomado),
// mas sem espera longa: quem chega e encontra dono vivo recebe a recusa na hora.

export type PidFileBusy = { pid?: number }

/** Dono atual do arquivo de pid, sem tomá-lo: `undefined` = livre (ausente ou de pid morto); `{}` = ocupado e ilegível (falha fechado). */
export function peekPidFile(file: string): PidFileBusy | undefined {
  const s = inspect(file)
  if (s.kind === 'live') return { pid: s.pid }
  if (s.kind === 'gone' || s.kind === 'stale') return undefined
  return {} // unknown (EACCES, diretório...) ou forming: não dá para julgar, conta como ocupado
}

/**
 * Toma o arquivo de pid para este processo. `{ ok: true }` ou `{ ok: false, pid? }` (dono vivo, ou ilegível: fail-closed).
 * Espera no máximo `waitMs` (curta) só para um dono ainda se formando ou uma troca de lock velho; nunca gira sem fim.
 */
export async function acquirePidFile(file: string, waitMs = 1_000): Promise<{ ok: true } | ({ ok: false } & PidFileBusy)> {
  mkdirPrivate(dirname(file))
  const deadline = Date.now() + waitMs
  for (;;) {
    if (tryCreate(file)) return { ok: true }
    const state = inspect(file)
    if (state.kind === 'live') return { ok: false, pid: state.pid }
    if (state.kind === 'unknown' || Date.now() >= deadline) return { ok: false }
    if (state.kind === 'stale') breakStale(file)
    await sleep(state.kind === 'stale' || state.kind === 'gone' ? 1 : POLL_MS)
  }
}

/** Larga o arquivo de pid, só se ainda for nosso. */
export function releasePidFile(file: string): void {
  if (readFileSyncSafe(file) === String(process.pid)) rmSync(file, { force: true })
}
