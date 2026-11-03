import { EXIT, SbError } from '../core/errors.js'

/** Args do `sb usage`, também declarados no `sb` raiz (sem importar o comando: ele carrega sob demanda). */
export const usageArgs = {
  json: { type: 'boolean', description: 'Saída em JSON (sem token)' },
  watch: { type: 'boolean', description: 'Redesenha a cada --every segundos' },
  every: { type: 'string', description: 'Segundos entre frames do --watch', default: '30' },
} as const

/** `--at N` (posição 1-based, implica `--pool`) ou `--pool` (fim da fila). */
export function parsePool(pool: boolean, at: string | undefined): boolean | number | undefined {
  if (at !== undefined) {
    if (!/^[1-9]\d*$/.test(at)) throw new SbError(`--at inválido: "${at}" (use um inteiro a partir de 1)`, EXIT.USAGE)
    return Number(at)
  }
  return pool ? true : undefined
}
