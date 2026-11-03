import { writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { Config } from '../src/core/schema.js'

// io:"input" — é o schema que o AUTOR escreve, com os campos que têm default
// marcados como opcionais. O de output exigiria escrever à mão o que o default cobre.
// draft-7 porque é o que o JSON language service do VSCode cobre melhor.
const schema = z.toJSONSchema(Config, { target: 'draft-7', io: 'input' })

await writeFile('schema.json', `${JSON.stringify({ title: 'switchboard config', ...schema }, null, 2)}\n`)
console.log('schema.json gerado')
