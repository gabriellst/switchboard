/** Args do `sb usage`, também declarados no `sb` raiz (sem importar o comando: ele carrega sob demanda). */
export const usageArgs = {
  json: { type: 'boolean', description: 'Saída em JSON (sem token)' },
  watch: { type: 'boolean', description: 'Redesenha a cada --every segundos' },
  every: { type: 'string', description: 'Segundos entre frames do --watch', default: '30' },
} as const
