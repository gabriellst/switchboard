import { defineCommand } from 'citty'
import { usageArgs } from './commands/args.js'

export const main = defineCommand({
  meta: { name: 'sb', version: '0.1.3', description: 'Contas do Claude Code por pasta, com troca automática ao bater o limite' },
  // `sb` sem subcomando = `sb usage`; os args do usage ficam aqui também para o citty saber que
  // `--every 30` leva valor (senão tomaria o "30" por nome de subcomando).
  args: usageArgs,
  default: 'usage',
  // Subcomandos carregados sob demanda
  subCommands: {
    usage: () => import('./commands/usage.js').then((m) => m.default),
    accounts: () => import('./commands/accounts.js').then((m) => m.default),
    mux: () => import('./commands/mux.js').then((m) => m.default),
    login: () => import('./commands/login.js').then((m) => m.default),
    attach: () => import('./commands/attach.js').then((m) => m.default),
    detach: () => import('./commands/detach.js').then((m) => m.default),
    which: () => import('./commands/which.js').then((m) => m.default),
    agents: () => import('./commands/agents.js').then((m) => m.default),
    run: () => import('./commands/run.js').then((m) => m.default),
    swap: () => import('./commands/swap.js').then((m) => m.default),
    pin: () => import('./commands/pin.js').then((m) => m.default),
    unpin: () => import('./commands/unpin.js').then((m) => m.default),
    watch: () => import('./commands/watch.js').then((m) => m.default),
    install: () => import('./commands/install.js').then((m) => m.default),
    doctor: () => import('./commands/doctor.js').then((m) => m.default),
    migrate: () => import('./commands/migrate.js').then((m) => m.default),
  },
})
