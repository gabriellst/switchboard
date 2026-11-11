import { describe, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { assertKnownFlags } from '../src/commands/guard.js'
import { EXIT, SbError } from '../src/core/errors.js'
import { populatedSandbox, type Sandbox } from './helpers.js'

/** Retrato do disco sob `root` (tipo, modo, alvo/conteúdo): se algo for gravado, apagado ou trocado, muda. */
function snapshot(root: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = join(d, e.name)
      if (f.endsWith('/home/Library')) continue // o próprio bun (que roda o CLI e o claude falso) cria o cache no HOME do sandbox: ruído do teste, não do sb
      const st = lstatSync(f)
      if (st.isSymbolicLink()) out.push(`L ${f} -> ${readlinkSync(f)}`)
      else if (st.isDirectory()) {
        out.push(`D ${f} ${(st.mode & 0o777).toString(8)}`)
        walk(f)
      } else out.push(`F ${f} ${(st.mode & 0o777).toString(8)} ${readFileSync(f, 'utf8')}`)
    }
  }
  walk(root)
  return out
}

/** `launchctl` e `kill` falsos à frente do PATH: registram a chamada em vez de tocar o launchd/processos de verdade. */
function shim(sb: Sandbox): { env: Record<string, string>; log: string } {
  const dir = join(sb.dir, 'shim')
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'calls.log')
  for (const name of ['launchctl', 'kill']) {
    const f = join(dir, name)
    writeFileSync(f, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`)
    chmodSync(f, 0o755)
  }
  return { env: { PATH: `${dir}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}` }, log }
}

/** O legado mínimo para um `sb migrate` de verdade ter o que aplicar (sem processos: nenhum `kill`). */
function addLegacy(sb: Sandbox): void {
  const home = sb.paths.home
  const contas = join(home, '.claude', 'contas')
  mkdirSync(contas, { recursive: true })
  writeFileSync(join(contas, 'velha.json'), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-' + 'oat01-' + 'q'.repeat(40) } }), { mode: 0o600 })
  symlinkSync('velha.json', join(contas, 'ativa.json'))
  writeFileSync(join(home, '.zshrc'), 'export A=1\n[ -f ~/.claude/contas/wrapper.zsh ] && source ~/.claude/contas/wrapper.zsh  # claude-conta\n')
  mkdirSync(join(home, 'p', 'bk'), { recursive: true })
  mkdirSync(sb.env.FAKE_CLAUDE_DIR!, { recursive: true })
  writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'ps.txt'), `  111 /usr/bin/claude agents --cwd ${join(home, 'p', 'bk')}\n`)
}

const CASES: Array<{ name: string; argv: string[]; flag: string }> = [
  { name: 'sb', argv: ['--bogus'], flag: '--bogus' },
  { name: 'usage', argv: ['usage', '--json', '--bogus'], flag: '--bogus' },
  { name: 'accounts', argv: ['accounts', '--bogus'], flag: '--bogus' },
  { name: 'accounts list', argv: ['accounts', 'list', '--bogus'], flag: '--bogus' },
  { name: 'accounts rm', argv: ['accounts', 'rm', 'admin1', '--yes', '--bogus'], flag: '--bogus' },
  { name: 'mux', argv: ['mux', '--bogus'], flag: '--bogus' },
  { name: 'mux list', argv: ['mux', 'list', '--bogus'], flag: '--bogus' },
  { name: 'mux add', argv: ['mux', 'add', 'novo', '--root', '~/novo', '--account', 'gabriel', '--bogus'], flag: '--bogus' },
  { name: 'mux set', argv: ['mux', 'set', 'bk', '--pool', 'gabriel', '--bogus'], flag: '--bogus' },
  { name: 'mux rm', argv: ['mux', 'rm', 'bk', '--bogus'], flag: '--bogus' },
  { name: 'login', argv: ['login', 'nova', '--terminal', '--bogus'], flag: '--bogus' },
  { name: 'attach', argv: ['attach', 'admin1', 'bk', '--preferred', '--bogus'], flag: '--bogus' },
  { name: 'detach', argv: ['detach', 'admin1', 'bk', '--bogus'], flag: '--bogus' },
  { name: 'which', argv: ['which', '--bogus'], flag: '--bogus' },
  { name: 'agents', argv: ['agents', 'bk', '--bogus'], flag: '--bogus' },
  { name: 'run', argv: ['run', 'bk', '--bogus', '--', '-p', 'x'], flag: '--bogus' },
  { name: 'swap (typo)', argv: ['swap', 'bk', '--cleer'], flag: '--cleer' },
  { name: 'swap', argv: ['swap', 'bk', 'admin1', '--bogus'], flag: '--bogus' },
  { name: 'pin', argv: ['pin', 'job1', 'admin1', '--bogus'], flag: '--bogus' },
  { name: 'unpin', argv: ['unpin', 'job1', '--bogus'], flag: '--bogus' },
  { name: 'watch', argv: ['watch', '--once', '--bogus'], flag: '--bogus' },
  { name: 'install --dry-run', argv: ['install', '--dry-run'], flag: '--dry-run' },
  { name: 'doctor', argv: ['doctor', '--fix', '--bogus'], flag: '--bogus' },
  { name: 'migrate --simulate', argv: ['migrate', '--simulate'], flag: '--simulate' },
  { name: 'migrate --dry-run', argv: ['migrate', '--dry-run'], flag: '--dry-run' },
  { name: 'migrate (typo de --simular)', argv: ['migrate', '--simulat'], flag: '--simulat' },
  { name: 'migrate --finish', argv: ['migrate', '--finish', '--bogus=1'], flag: '--bogus' },
  { name: 'opção curta', argv: ['swap', 'bk', '-x'], flag: '-x' },
]

describe('opção desconhecida: exit 3, nome da opção na mensagem e nenhum efeito', () => {
  for (const c of CASES) {
    test(c.name, () => {
      const sb = populatedSandbox()
      addLegacy(sb)
      const sh = shim(sb)
      const before = snapshot(sb.dir)
      const r = sb.runSb(c.argv, { env: sh.env })
      expect(r.code).toBe(EXIT.USAGE)
      expect(r.stderr).toContain(c.flag)
      expect(r.stderr).toMatch(/desconhecida/)
      expect(r.stdout).toBe('')
      expect(snapshot(sb.dir)).toEqual(before) // nada gravado (config, estado, zshrc, plist, tokens), nenhum launchctl/kill/claude falso
      expect(sb.calls()).toEqual([])
      expect(r.stdout + r.stderr).not.toMatch(/sk-ant-/)
    })
  }
})

describe('formas documentadas continuam valendo', () => {
  test('--flag, --flag=valor, --flag valor, --no-<booleana> e --json=false', () => {
    const sb = populatedSandbox()
    expect(sb.runSb(['usage', '--json']).code).toBe(0)
    expect(sb.runSb(['mux', 'list', '--json=true']).code).toBe(0)
    expect(sb.runSb(['mux', '--json']).code).toBe(0)
    expect(sb.runSb(['accounts', '--no-json']).code).toBe(0)
    expect(sb.runSb(['which', '--json', join(sb.paths.home, 'bk')]).code).toBe(0)
    expect(sb.runSb(['mux', 'set', 'bk', '--pool=gabriel,admin1']).code).toBe(0)
    expect(sb.runSb(['mux', 'set', 'bk', '--pool', 'gabriel,admin1', '--no-default']).code).toBe(0)
    expect(sb.runSb(['swap', 'bk', '--clear', '--json']).code).toBe(0)
  })

  test('--help/-h e --version continuam funcionando (e --help depois de uma opção desconhecida mostra a ajuda)', () => {
    const sb = populatedSandbox()
    for (const argv of [['--help'], ['-h'], ['swap', '--help'], ['mux', 'add', '-h'], ['migrate', '--help'], ['migrate', '--simulate', '--help']]) {
      const r = sb.runSb(argv)
      expect(r.code).toBe(0)
      expect(r.stdout + r.stderr).toContain('USAGE')
    }
    expect(sb.runSb(['--version']).stdout.trim()).toBe('0.1.0')
    expect(sb.runSb(['swap', 'bk', '--version']).code).toBe(EXIT.USAGE) // --version só vale sozinho
  })

  test('sb run: depois do `--` tudo é do claude (inclusive o que parece opção do sb)', () => {
    const sb = populatedSandbox()
    const r = sb.runSb(['run', 'bk', '--', '--bogus', '--json', '-x', '-p', 'oi'])
    expect(r.code).toBe(0)
    const argv = sb.calls()[0]!.argv
    expect(argv).toEqual(expect.arrayContaining(['--bogus', '--json', '-x', '-p', 'oi']))
  })
})

describe('assertKnownFlags', () => {
  const def = {
    name: { type: 'positional' },
    'dry-run': { type: 'boolean', alias: 'n' },
    outDir: { type: 'string', alias: ['o'] },
    verbose: { type: 'boolean', alias: 'v' },
  }
  const ok = (...a: string[]): void => assertKnownFlags(def, a)
  const bad = (...a: string[]): string => {
    try {
      assertKnownFlags(def, a)
    } catch (e) {
      if (e instanceof SbError) return `${e.exit}:${e.message}`
      throw e
    }
    return 'ok'
  }

  test('aceita nome, camelCase/kebab, alias, agrupados, =valor, --no-<booleana>, positional, `-` e tudo depois de `--`', () => {
    ok('x', '--dry-run', '--dryRun', '-n', '--out-dir', 'a', '--outDir=b', '-o', 'c', '-nv', '--no-verbose', '--no-dry-run', '-', '--help', '-h', '--', '--qualquer', '-z')
  })

  test('recusa o resto, com exit 3 e o nome da opção (sem o valor)', () => {
    expect(bad('--bogus')).toBe(`${EXIT.USAGE}:opção desconhecida: --bogus`)
    expect(bad('--bogus=segredo')).toBe(`${EXIT.USAGE}:opção desconhecida: --bogus`)
    expect(bad('-z')).toContain('-z')
    expect(bad('-nz')).toContain('-nz')
    expect(bad('--no-out-dir')).toContain('--no-out-dir') // negar uma opção que leva valor não existe
    expect(bad('--no-bogus')).toContain('--no-bogus')
    expect(bad('--version')).toContain('--version')
    expect(bad('--', '--x', '--bogus')).toBe('ok')
    expect(bad('--bogus', '--')).toContain('--bogus') // antes do `--` vale
  })
})

test('valor negativo de uma opção com valor (`--every -5`) não é tomado por opção desconhecida', () => {
  const def = { every: { type: 'string' }, json: { type: 'boolean' } }
  expect(() => assertKnownFlags(def, ['--every', '-5'])).not.toThrow()
  expect(() => assertKnownFlags(def, ['--every', '-1.5', '--json'])).not.toThrow()
  expect(() => assertKnownFlags(def, ['--json', '-5'])).toThrow(SbError) // booleana não leva valor: -5 é opção desconhecida
})
