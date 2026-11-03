import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: 'esm',
  target: 'node20',
  // package.json tem "type": "module", então .js já é ESM.
  // Sem isso o tsdown emite .mjs e o `bin` aponta para um arquivo que não existe.
  outExtensions: () => ({ js: '.js' }),
  clean: true,
})
