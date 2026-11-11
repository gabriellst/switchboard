import { describe, expect, test } from 'bun:test'
import { validateArgv } from '../src/commands/argv.js'
import { detachedArgv, type LoginArgs } from '../src/commands/login.js'
import { EXIT, SbError } from '../src/core/errors.js'
import { planInstall, plistFile } from '../src/core/install.js'
import { main } from '../src/main.js'
import { sandbox } from './helpers.js'

const verdict = async (argv: string[]): Promise<string> => {
  try {
    await validateArgv(main, argv)
    return 'ok'
  } catch (e) {
    if (e instanceof SbError) return `${e.exit}:${e.message}`
    throw e
  }
}

describe('validateArgv (árvore real: raiz → mux/accounts → folha)', () => {
  test('recusa opção antes do subcomando, em qualquer nível, com exit 3 e o nome da opção', async () => {
    for (const [argv, flag] of [
      [['--bogus', 'which', '/tmp'], '--bogus'],
      [['mux', '--bogus', 'set', 'bk'], '--bogus'],
      [['accounts', '--bogus', 'rm', 'a'], '--bogus'],
      [['--simulate', 'migrate'], '--simulate'],
      [['--dry-run', 'install'], '--dry-run'],
      [['--json', 'migrate'], '--json'], // do pai, mas o filho nunca a veria
      [['--every', '5', 'usage'], '--every'],
      [['mux', '--json', 'add'], '--json'],
      [['-x', 'swap', 'bk'], '-x'],
      [['--bogus=1', 'watch'], '--bogus'],
    ] as Array<[string[], string]>) {
      const v = await verdict(argv)
      expect(v.startsWith(`${EXIT.USAGE}:`)).toBe(true)
      expect(v).toContain(flag)
    }
  })

  test('recusa a opção desconhecida depois do nome (folha), com o `--` como limite', async () => {
    expect((await verdict(['migrate', '--simulate'])).startsWith(`${EXIT.USAGE}:`)).toBe(true)
    expect((await verdict(['mux', 'set', 'bk', '--bogus'])).startsWith(`${EXIT.USAGE}:`)).toBe(true)
    expect(await verdict(['run', 'bk', '--', '--bogus', '-x'])).toBe('ok')
    expect((await verdict(['run', '--bogus', 'bk', '--', 'x'])).startsWith(`${EXIT.USAGE}:`)).toBe(true)
  })

  test('formas legítimas passam', async () => {
    for (const argv of [
      [], ['--json'], ['--watch', '--every', '30'], ['--every=30'], ['--every', '-5'], ['usage', '--json'], ['accounts'], ['accounts', '--json'], ['accounts', 'list', '--json'],
      ['accounts', 'rm', 'a', '--yes'], ['mux'], ['mux', '--json'], ['mux', 'list', '--json'], ['mux', 'add', 'x', '--root', '~/x', '--account', 'a'], ['mux', 'set', 'bk', '--pool=a,b', '--no-default'],
      ['--help'], ['-h'], ['--version'], ['-v'], ['mux', '--help'], ['--bogus', '--help'], ['swap', 'bk', '--clear', '--json'], ['which', '/tmp/a b'], ['run', 'bk', '--', '-p', 'x'],
      ['nao-existe'], // subcomando desconhecido: erro do citty (exit 1), não daqui
    ]) {
      expect([argv.join(' '), await verdict(argv)]).toEqual([argv.join(' '), 'ok'])
    }
    expect((await verdict(['swap', 'bk', '--version'])).startsWith(`${EXIT.USAGE}:`)).toBe(true) // --version só vale sozinho
  })
})

describe('as chamadas que o próprio sb monta continuam passando', () => {
  test('o filho desanexado do `sb login` (argv de detachedArgv, em todas as combinações)', async () => {
    const base: LoginArgs = { account: 'nova', terminal: false, foreground: false }
    const variants: LoginArgs[] = [
      base,
      { ...base, attach: { mux: 'bk' } },
      { ...base, attach: { mux: 'bk', pool: true } },
      { ...base, attach: { mux: 'bk', pool: 2 } },
      { ...base, attach: { mux: 'bk', pool: true, preferred: true } },
      { ...base, attach: { mux: 'bk', preferred: true } },
    ]
    for (const a of variants) {
      const argv = detachedArgv(a)
      expect(argv.slice(0, 3)).toEqual(['login', 'nova', '--foreground'])
      expect([argv.join(' '), await verdict(argv)]).toEqual([argv.join(' '), 'ok'])
    }
  })

  test('o ProgramArguments do LaunchAgent (o último item é o subcomando do plist gerado)', async () => {
    const sb = sandbox()
    const plan = planInstall(sb.paths, { runtimeBin: process.execPath, cliPath: '/x/cli.js', claudeDir: '/c' })
    const content = plan.find((f) => f.file === plistFile(sb.paths))!.content
    const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content)![1]!
    const items = [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!)
    expect(items.slice(2)).toEqual(['watch']) // [runtime, cli, ...argv do sb]
    expect(await verdict(items.slice(2))).toBe('ok')
  })

  test('o `which <pasta>` do wrapper (pasta com espaços e acentos)', async () => {
    const sb = sandbox()
    const wrapper = planInstall(sb.paths, { runtimeBin: process.execPath, cliPath: '/x/cli.js', claudeDir: '/c' }).find((f) => f.file.endsWith('wrapper.zsh'))!.content
    expect(wrapper).toMatch(/cli\.js which "\$\{cwd:-\$PWD\}"/) // a forma exata que o wrapper monta: `<runtime> <cli> which <pasta>`
    for (const dir of ['/Users/x/meu projeto', '/tmp/ação', '/']) expect(await verdict(['which', dir])).toBe('ok')
  })
})
