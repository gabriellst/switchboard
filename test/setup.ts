import { afterAll } from 'bun:test'
import { removeSandboxes } from './helpers.js'

// preload do `bun test` (bunfig.toml): remove os diretórios `sb-test-*` que os sandboxes criaram
afterAll(removeSandboxes)
