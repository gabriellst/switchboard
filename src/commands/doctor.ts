import { defineCommand } from 'citty'
import { defaultCtx, type Ctx } from '../core/ctx.js'
import { diagnose, fix, type FixAction } from '../core/doctor.js'
import { EXIT, SbError, type ExitCode } from '../core/errors.js'
import { FIXABLE, hasErrors, type Finding } from '../core/findings.js'
import { withLock } from '../core/fsx.js'
import { renderFindings } from '../report.js'
import { guarded } from './guard.js'

export interface DoctorArgs {
  fix?: boolean
  json?: boolean
}

export interface DoctorRun {
  /** o que sobrou (com `--fix`, depois dos consertos) */
  findings: Finding[]
  /** só com `--fix`: cada conserto tentado */
  fixes: FixAction[]
  exit: ExitCode
  text: string
}

const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]+/g

/**
 * `sb doctor [--fix] [--json]`. Sem `--fix` só lê. Com `--fix` o conserto roda SOB O LOCK do estado e o relatório final é o
 * de depois dele. Exit: 2 config inválida · 1 sobrou erro · 0 só avisos (ou nada).
 */
export async function runDoctor(ctx: Ctx, args: DoctorArgs, opts: { waitMs?: number } = {}): Promise<DoctorRun> {
  let findings = await diagnose(ctx)
  let fixes: FixAction[] = []
  if (args.fix === true && findings.some((f) => FIXABLE.has(f.code))) {
    const before = findings
    fixes = await withLock(ctx.paths, () => fix(ctx, before), opts.waitMs === undefined ? {} : { waitMs: opts.waitMs })
    findings = await diagnose(ctx)
  }
  const exit = findings.some((f) => f.code === 'config.invalid') ? EXIT.INVALID_CONFIG : hasErrors(findings) ? EXIT.CHECK_FAILED : EXIT.OK
  // achados e consertos já saem sem token; a redação aqui é a última barreira da saída `--json`
  const text =
    args.json === true
      ? `${JSON.stringify({ findings, ...(args.fix === true && { fixes }) }, null, 2).replace(TOKEN_RE, '<token>')}\n`
      : renderFindings(findings, args.fix === true ? fixes : undefined)
  return { findings, fixes, exit, text }
}

export default defineCommand({
  meta: { name: 'doctor', description: 'Acha o que faria uma sessão rodar na conta errada (links, tokens, sessões e views sem settings) e, com --fix, conserta o seguro' },
  args: {
    fix: { type: 'boolean', description: 'Recria links, corrige permissões e adota sessões sem settings' },
    json: { type: 'boolean', description: 'Saída em JSON: { findings, fixes? } (sem token)' },
  },
  run: guarded(async ({ args }) => {
    if (args._.length > 0) throw new SbError(`argumento a mais: ${JSON.stringify(args._[0])} (uso: sb doctor [--fix] [--json])`, EXIT.USAGE)
    const r = await runDoctor(defaultCtx(), { fix: args.fix === true, json: args.json === true })
    process.stdout.write(r.text)
    if (r.exit !== EXIT.OK) process.exitCode = r.exit
  }),
})
