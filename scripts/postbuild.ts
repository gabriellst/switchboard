import { chmod, readFile, writeFile } from 'node:fs/promises'

// Polyglot sh/js no bin: máquinas só-bun (sem node) conseguem executar o binário
// direto do PATH. O sh executa a linha 2 e faz exec no runtime que existir;
// pro JS a mesma linha é uma string + comentário de bloco. Precisa ser pós-build
// porque o rolldown normaliza a linha e remove o comentário se estiver no fonte.
const path = 'dist/cli.js'
const src = await readFile(path, 'utf8')
const launcher = `#!/bin/sh\n':' /*; exec "$(command -v node || command -v bun)" "$0" "$@"; */\n`
await writeFile(path, src.replace(/^#!.*\n/, launcher))
await chmod(path, 0o755)
console.log('postbuild: launcher sh/js aplicado ao bin')
