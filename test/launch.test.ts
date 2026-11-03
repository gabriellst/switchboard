import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/core/config.js'
import { EXIT, SbError } from '../src/core/errors.js'
import { pointMux } from '../src/core/links.js'
import { launchArgs, runClaude } from '../src/core/launch.js'
import { muxLink, tokenFile } from '../src/core/paths.js'
import { FAKE_TOKEN, populatedSandbox, type Sandbox } from './helpers.js'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

const rootBk = (sb: Sandbox): string => join(sb.env.HOME!, 'bk')

/** populatedSandbox + um mux `deep` (root dentro do de `bk`, conta admin1) para o teste do root mais profundo. */
function withDeep(): Sandbox {
  const sb = populatedSandbox()
  writeFileSync(
    sb.paths.configFile,
    JSON.stringify({
      switchboard: 1,
      accounts: { gabriel: {}, admin1: {} },
      default: 'bk',
      mux: {
        bk: { root: '~/bk', account: 'gabriel', accounts: ['gabriel', 'admin1'], pool: ['gabriel', 'admin1'] },
        deep: { root: '~/bk/sub', account: 'admin1', accounts: ['admin1'], pool: [] },
      },
    }),
  )
  pointMux(sb.paths, 'deep', 'admin1')
  return sb
}

const env = { CLAUDE_CODE_OAUTH_TOKEN: 'xyz' }

describe('sb agents', () => {
  test('`sb agents bk` abre a view com --cwd e --settings do mux, sem token herdado', () => {
    const sb = populatedSandbox()
    const r = sb.runSb(['agents', 'bk'], { env })
    expect(r.code).toBe(0)
    expect(sb.calls()).toHaveLength(1)
    expect(sb.calls().at(-1)).toMatchObject({
      argv: ['agents', '--cwd', rootBk(sb), '--settings', muxLink(sb.paths, 'bk')],
      hasOauthEnv: false,
      configDir: null,
    })
  })

  test('sem nome deduz pela pasta: root mais profundo; fora de todo root → default', () => {
    const sb = withDeep()
    mkdirSync(join(rootBk(sb), 'sub', 'x'), { recursive: true })
    const deep = sb.runSb(['agents'], { cwd: join(rootBk(sb), 'sub', 'x') })
    expect(deep.code).toBe(0)
    expect(sb.calls().at(-1)!.argv).toEqual(['agents', '--cwd', join(rootBk(sb), 'sub'), '--settings', muxLink(sb.paths, 'deep')])
    const shallow = sb.runSb(['agents'], { cwd: rootBk(sb) })
    expect(shallow.code).toBe(0)
    expect(sb.calls().at(-1)!.argv).toEqual(['agents', '--cwd', rootBk(sb), '--settings', muxLink(sb.paths, 'bk')])
    const outside = sb.runSb(['agents'], { cwd: sb.dir })
    expect(outside.code).toBe(0)
    expect(sb.calls().at(-1)!.argv).toEqual(['agents', '--cwd', rootBk(sb), '--settings', muxLink(sb.paths, 'bk')])
  })

  test('fora de todo root e sem default → exit 2, claude não é chamado', () => {
    const sb = populatedSandbox()
    // config válida sem `default` só existe sem mux: aqui o mux some da lista de roots tirando o default por edição direta
    writeFileSync(sb.paths.configFile, JSON.stringify({ switchboard: 1, accounts: { gabriel: {} }, mux: {} }))
    const r = sb.runSb(['agents'], { cwd: sb.dir })
    expect(r.code).toBe(EXIT.INVALID_CONFIG)
    expect(sb.calls()).toEqual([])
  })

  test('mux inexistente → exit 3; nome inseguro → exit 3; claude não é chamado', () => {
    const sb = populatedSandbox()
    for (const name of ['nope', '../x', 'A/b']) {
      const r = sb.runSb(['agents', name])
      expect(r.code).toBe(EXIT.USAGE)
      expect(r.stdout).toBe('')
    }
    expect(sb.calls()).toEqual([])
  })

  test('sem config → exit 2 com a dica; claude não é chamado', () => {
    const sb = populatedSandbox()
    rmSync(sb.paths.configFile)
    for (const args of [['agents'], ['agents', 'bk'], ['run', 'bk', '--', '-p', 'oi']]) {
      const r = sb.runSb(args)
      expect(r.code).toBe(EXIT.INVALID_CONFIG)
      expect(r.stderr).toContain('sb login')
    }
    expect(sb.calls()).toEqual([])
  })

  test('argumento a mais → exit 3', () => {
    const sb = populatedSandbox()
    expect(sb.runSb(['agents', 'bk', 'outro']).code).toBe(EXIT.USAGE)
    expect(sb.calls()).toEqual([])
  })
})

// F6 no caminho quente: um settings que o claude ignoraria o faria rodar calado noutra conta
const BREAKS: Array<[string, (sb: Sandbox) => void, RegExp]> = [
  ['link ausente', (sb) => rmSync(muxLink(sb.paths, 'bk')), /não existe/],
  ['link quebrado', (sb) => rmSync(tokenFile(sb.paths, 'gabriel')), /quebrado/],
  ['arquivo comum no lugar do link', (sb) => {
    rmSync(muxLink(sb.paths, 'bk'))
    writeFileSync(muxLink(sb.paths, 'bk'), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } }))
  }, /quebrado/],
  ['JSON inválido', (sb) => writeFileSync(tokenFile(sb.paths, 'gabriel'), 'not json{'), /JSON inválido/],
  ['sem oauth', (sb) => writeFileSync(tokenFile(sb.paths, 'gabriel'), '{"env":{}}'), /CLAUDE_CODE_OAUTH_TOKEN/],
]

describe('F6: o claude só roda se o preflight passa', () => {
  for (const [name, breakIt, msg] of BREAKS) {
    for (const args of [['agents', 'bk'], ['agents'], ['run', 'bk', '--', '-p', 'oi'], ['run', 'bk']]) {
      test(`${name}: sb ${args.join(' ')} → exit 1 e o claude NÃO é chamado`, () => {
        const sb = populatedSandbox()
        breakIt(sb)
        const r = sb.runSb(args, { env })
        expect(r.code).toBe(EXIT.CHECK_FAILED)
        expect(r.stderr).toMatch(msg)
        expect(r.stderr).toContain('sb doctor --fix')
        expect(r.stderr).not.toMatch(/sk-ant-|xyz/)
        expect(sb.calls()).toEqual([])
      })
    }
  }

  test('o link trocado entre o preflight e o spawn é pego pela segunda leitura', async () => {
    const sb = populatedSandbox()
    const ctx = sb.ctx()
    const cfg = await loadConfig(sb.paths)
    const plan = launchArgs(cfg, sb.paths, { mux: 'bk', cwd: sb.dir, mode: 'run', args: ['-p', 'oi'] })
    const err = await runClaude(ctx, plan, {
      afterPreflight: () => writeFileSync(tokenFile(sb.paths, 'gabriel'), '{"env":{}}'),
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SbError)
    expect((err as SbError).exit).toBe(EXIT.CHECK_FAILED)
    expect((err as SbError).detail).toContain('sb doctor --fix')
    expect(sb.calls()).toEqual([])
  })

  test('sem a troca, runClaude abre o claude e devolve o código', async () => {
    const sb = populatedSandbox()
    const cfg = await loadConfig(sb.paths)
    const plan = launchArgs(cfg, sb.paths, { mux: 'bk', cwd: sb.dir, mode: 'run', args: [] })
    await expect(runClaude(sb.ctx(), plan)).resolves.toEqual({ code: 0 })
    expect(sb.calls()).toHaveLength(1)
  })

  test('claude ausente → exit 4', async () => {
    const sb = populatedSandbox()
    const r = sb.runSb(['run', 'bk'], { env: { SWITCHBOARD_CLAUDE: join(sb.dir, 'nao-existe') } })
    expect(r.code).toBe(EXIT.CLAUDE)
    expect(r.stderr).toContain('claude')
  })
})

describe('sb run', () => {
  test('`sb run bk -- -p oi` acrescenta --settings; o resto vai ao claude intacto', () => {
    const sb = populatedSandbox()
    const r = sb.runSb(['run', 'bk', '--', '-p', 'oi'], { env })
    expect(r.code).toBe(0)
    expect(sb.calls().at(-1)).toMatchObject({ argv: ['-p', 'oi', '--settings', muxLink(sb.paths, 'bk')], hasOauthEnv: false })
  })

  test('sem `--` roda o claude puro com o settings; sem nome deduz pela pasta', () => {
    const sb = withDeep()
    mkdirSync(join(rootBk(sb), 'sub'), { recursive: true })
    expect(sb.runSb(['run', 'bk']).code).toBe(0)
    expect(sb.calls().at(-1)!.argv).toEqual(['--settings', muxLink(sb.paths, 'bk')])
    expect(sb.runSb(['run', '--', '--version'], { cwd: join(rootBk(sb), 'sub') }).code).toBe(0)
    expect(sb.calls().at(-1)!.argv).toEqual(['--version', '--settings', muxLink(sb.paths, 'deep')])
  })

  test('tudo depois de `--` é do claude: --help, -h, --version, outro `--` e nomes de mux', () => {
    const sb = populatedSandbox()
    const rest = ['--help', '-h', '--version', '--', 'bk', '--json']
    expect(sb.runSb(['run', 'bk', '--', ...rest]).code).toBe(0)
    expect(sb.calls().at(-1)!.argv).toEqual([...rest, '--settings', muxLink(sb.paths, 'bk')])
  })

  test('`sb run --help` antes do `--` é a ajuda do sb (claude não é chamado)', () => {
    const sb = populatedSandbox()
    const r = sb.runSb(['run', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('sb run')
    expect(sb.calls()).toEqual([])
  })

  test('argumentos com espaços, aspas e metacaracteres de shell chegam intactos', () => {
    const sb = populatedSandbox()
    const args = ['-p', 'olá "mundo"  e \'aspas\'', '$HOME `ls` ; rm -rf x', '', '--flag=a b']
    expect(sb.runSb(['run', 'bk', '--', ...args]).code).toBe(0)
    expect(sb.calls().at(-1)!.argv).toEqual([...args, '--settings', muxLink(sb.paths, 'bk')])
  })

  test('--settings (ou --settings=) nos args → exit 3 e o claude não é chamado', () => {
    const sb = populatedSandbox()
    for (const bad of [['--settings', '/x.json'], ['--settings=/x.json'], ['-p', 'oi', '--settings']]) {
      const r = sb.runSb(['run', 'bk', '--', ...bad])
      expect(r.code).toBe(EXIT.USAGE)
      expect(r.stderr).toContain('--settings')
    }
    expect(sb.calls()).toEqual([])
  })

  test('mux inexistente → exit 3; flag do sb sem `--` → exit 3', () => {
    const sb = populatedSandbox()
    expect(sb.runSb(['run', 'nope', '--', '-p', 'oi']).code).toBe(EXIT.USAGE)
    expect(sb.runSb(['run', '../x', '--', '-p']).code).toBe(EXIT.USAGE)
    expect(sb.runSb(['run', 'bk', '-p', 'oi']).code).toBe(EXIT.USAGE)
    expect(sb.runSb(['run', '-p']).code).toBe(EXIT.USAGE)
    expect(sb.calls()).toEqual([])
  })

  test('o código de saída do claude é o do sb', () => {
    const sb = populatedSandbox()
    mkdirSync(sb.env.FAKE_CLAUDE_DIR!, { recursive: true })
    writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'exit-code'), '7')
    expect(sb.runSb(['run', 'bk', '--', '-p', 'oi']).code).toBe(7)
  })

  test('stdio herdado: a saída do claude chega ao stdout do sb', () => {
    const sb = populatedSandbox()
    // o fake imprime `agents.json` em `agents`
    mkdirSync(sb.env.FAKE_CLAUDE_DIR!, { recursive: true })
    writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'agents.json'), '[]\n')
    const r = sb.runSb(['agents', 'bk'])
    expect(r.stdout).toBe('[]\n')
  })
})

/** Sobe `sb` com stdio descartado, espera o claude falso registrar a chamada e devolve o que precisa para sinalizar. */
async function startSleepy(sb: Sandbox, args: string[]) {
  mkdirSync(sb.env.FAKE_CLAUDE_DIR!, { recursive: true })
  writeFileSync(join(sb.env.FAKE_CLAUDE_DIR!, 'sleep'), '30000')
  const child = spawn(process.execPath, [CLI, ...args], { env: sb.env, cwd: sb.dir, stdio: 'ignore' })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  )
  const deadline = Date.now() + 8000
  while (sb.calls().length === 0) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error('o claude falso não subiu')
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  return { child, exited, fakePid: sb.calls()[0]!.pid! }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function dies(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5000
  while (alive(pid)) {
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 25))
  }
  return true
}

describe('sinais', () => {
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    test(`${sig} no sb chega ao claude: ele morre, o sb sai pelo mesmo sinal e nada fica órfão`, async () => {
      const sb = populatedSandbox()
      const { child, exited, fakePid } = await startSleepy(sb, ['run', 'bk', '--', '-p', 'oi'])
      try {
        expect(alive(fakePid)).toBe(true)
        child.kill(sig)
        const res = await exited
        expect(res.signal ?? `código ${res.code}`).toBe(sig)
        expect(await dies(fakePid)).toBe(true)
      } finally {
        child.kill('SIGKILL')
        if (alive(fakePid)) process.kill(fakePid, 'SIGKILL')
      }
    })
  }

  test('o mesmo vale para `sb agents`', async () => {
    const sb = populatedSandbox()
    // `agents` no fake não dorme: usa um mux cujo claude é um script que dorme
    const script = join(sb.dir, 'sleepy-claude.sh')
    writeFileSync(script, '#!/bin/sh\necho "$$" > "$FAKE_CLAUDE_DIR/pid"\nexec sleep 30\n', { mode: 0o755 })
    mkdirSync(sb.env.FAKE_CLAUDE_DIR!, { recursive: true })
    const child = spawn(process.execPath, [CLI, 'agents', 'bk'], { env: { ...sb.env, SWITCHBOARD_CLAUDE: script }, cwd: sb.dir, stdio: 'ignore' })
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on('exit', (_c, s) => resolve(s)))
    const pidFile = join(sb.env.FAKE_CLAUDE_DIR!, 'pid')
    const deadline = Date.now() + 8000
    let pid = 0
    while (pid === 0) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL')
        throw new Error('claude de teste não subiu')
      }
      try {
        pid = Number((await Bun.file(pidFile).text()).trim()) || 0
      } catch {
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    try {
      child.kill('SIGTERM')
      expect(await exited).toBe('SIGTERM')
      expect(await dies(pid)).toBe(true)
    } finally {
      child.kill('SIGKILL')
      if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  })
})

