#!/usr/bin/env bun
// `ps` falso para os testes (SWITCHBOARD_PS): imprime `ps.txt` de FAKE_CLAUDE_DIR (linhas `pid command`), ou nada.
// Sem isso o `sb doctor` leria a tabela de processos REAL da máquina, e qualquer `claude agents` aberto mudaria o resultado.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.FAKE_CLAUDE_DIR
const file = dir ? join(dir, 'ps.txt') : ''
if (file && existsSync(file)) process.stdout.write(readFileSync(file, 'utf8'))
