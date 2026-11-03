# switchboard (`sb`) — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI `sb` que liga uma conta Claude a cada mux do cmux, troca a conta de um mux (à mão ou sozinha, por prioridade/pool), fixa sessões numa conta, mostra o uso por conta e total, e migra o `claude-conta`.

**Architecture:** TypeScript ESM no molde do plugboard. `src/core/` não conhece terminal: recebe um `Ctx` injetado (paths, env, relógio, fetch, runner de processos, notificação, log) e devolve dados. `src/commands/` são finos (citty + `guarded`), `src/report.ts` renderiza. O estado mora em `~/.local/state/switchboard/` (tokens 600, links `mux/`/`pins/`, `usage.json`, `runtime.json`); a troca de conta é repontar um link e parar sessões livres (F4/F8).

**Tech Stack:** bun 1.4 (dev/test), tsdown → `dist/` para Node ≥ 20, citty, zod 4 (gera `schema.json`), jsonc-parser. Sem dependência nativa.

**Spec:** `docs/superpowers/specs/2026-11-03-switchboard-design.md` (ler inteiro antes de qualquer task; F1–F11 são restrições medidas).

## Global Constraints

Anti-objetivos (§2, literais — falha mesmo que funcione):
- **Mexer no login do keychain** (`/login`, `claude auth login`, gravar ou ler a credencial do keychain). É a conta do berzerk; o berzerk nunca pode ser arrastado.
- **Imprimir, logar ou gravar token fora do diretório de tokens.** Nem em `--json`, nem em erro.
- **Interromper um turno em andamento** para trocar de conta. Troca só com a sessão livre.
- **Deixar uma sessão rodar calada na conta errada.** O caso perigoso é o JSON de settings inválido, que o Claude ignora e cai no keychain (F6). O `sb` tem que impedir e detectar isso.
- **Gastar uso de verdade para medir uso.** A sonda tem que ser mínima.
- **Repassar `CLAUDE_CODE_OAUTH_TOKEN` herdado** para um `claude` que possa subir o daemon.

Regras para quem executa (valem para spikes, testes e verificação manual):
- Nunca ler `~/.claude/contas/*.json` com `cat`/`Read`; nunca imprimir um `sk-ant-oat01-…`.
- Todo `claude` chamado daqui sai sem as variáveis F10 (`spikes/sessoes/cl` nos spikes, `cleanEnv()` no código).
- Sessões de teste: nome `sb-spike-…`, sempre com `--settings ~/.claude/contas/ativa.json` (sem isso rodam no keychain = berzerk), `claude stop` + `claude rm` ao terminar. Nunca parar sessão do usuário.
- Não alterar `~/.local/bin/claude-conta`, `~/.claude/contas/`, `~/.claude/contas-fixas/`, `~/.zshrc`. Nunca rodar `sb install`, `sb migrate` (sem `--simular`) nem `sb watch` com o HOME real: quem roda é o usuário, depois de aprovar.
- Sem push, sem repositório no GitHub.

Projeto:
- Node ≥ 20 (`engines`), `"type": "module"`, tsdown `target: 'node20'`, `outExtensions: () => ({ js: '.js' })`, launcher sh/js pós-build igual ao plugboard (`scripts/postbuild.ts`).
- Identificadores em inglês; mensagens ao usuário, `README.md` e `SPEC.md` em português.
- Exit codes (`src/core/errors.ts`): `0 OK` · `1 CHECK_FAILED` · `2 INVALID_CONFIG` · `3 USAGE` (argumento, conta, mux ou sessão inválidos ou recusados pelas regras) · `4 CLAUDE` (o `claude` falhou ou mudou de formato) · `5 LOCKED`.
- Nome de conta: `^[a-z0-9][a-z0-9_-]{0,31}$`; `keychain` é reservado (não se registra, não entra em pool, nunca é medido nem escrito além de `tokens/keychain.json` = `{}`).
- Modos: diretório de estado e subdiretórios 700; `tokens/*.json` 600.
- Isolamento de teste: todo teste roda com `HOME`, `SWITCHBOARD_CONFIG`, `SWITCHBOARD_STATE_DIR`, `SWITCHBOARD_JOBS_DIR` num tmpdir, `SWITCHBOARD_CLAUDE` = claude falso, `SWITCHBOARD_API_BASE` = servidor falso, `SWITCHBOARD_NO_NOTIFY=1`. Nenhum teste toca `~/.claude` real, o keychain ou a API.
- Sonda (F1), exata: `POST {base}/v1/messages`, headers `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`, `anthropic-version: 2023-06-01`, `content-type: application/json`; body `{"model":"claude-haiku-4-5","max_tokens":1,"system":"You are Claude Code, Anthropic's official CLI for Claude.","messages":[{"role":"user","content":"ok"}]}`. `base` = `SWITCHBOARD_API_BASE` ?? `https://api.anthropic.com`.

Decisões **[builder]** do design fixadas aqui:
- PTY do `setup-token`: `script -q /dev/null sh -c 'stty cols 2000 rows 50; exec "$0" setup-token' <claudeBin>` (provado em 03/11: dá PTY sem TTY na entrada, 2000 colunas, o token não quebra).
- Histerese: voltar à preferida só quando o reset da janela que a esgotou passou **ou** a utilização está ≤ limite − 0,10 nas duas janelas.
- Laço do `watch`: 30 s; sonda a cada `swap.probeEvery`.
- Lock: arquivo `<state>/lock` criado com `O_EXCL` contendo o pid; lock de pid morto é tomado. (Não `flock`: o Node não tem a API e não queremos dependência nativa.)
- Pin/adoção/migração de sessão ocupada: fila `pending` no `runtime.json`, aplicada pelo `watch` (um supervisor só).
- `sb swap` manual expira no `fiveHour.resetsAt` da preferida (ou agora + 5 h se ela não tem medição válida).
- Conta nunca medida ou com erro de sonda não é destino; preferida sem medição conta como disponível (não sai dela sem evidência).
- LaunchAgent: label `com.gabriellst.switchboard.watch`.
- Wrapper zsh falha fechado: se `sb which` falhar, não chama `claude` (imprime o erro e sai 1).
- `sb migrate` copia o `claude-conta` para o backup e só **move** `~/.claude/contas*` com `sb migrate --finish`, quando nenhuma sessão aponta mais para lá (senão a sessão parada não abriria).

## Review Focus

1. **Link de mux quebrado ou JSON inválido na hora de abrir** (`sb agents`, `sb run`, wrapper): espera-se recusa com mensagem e exit 1, nunca um `claude` no keychain. Testes na Task 16 e na Task 20.
2. **Token em qualquer saída** (`--json`, erro, `usage.json`, `runtime.json`, logs, login): espera-se zero ocorrências de `sk-ant-`. `test/hygiene.test.ts` (Task 5) recebe um caso por comando em cada task que cria comando.
3. **`/sb swap` ou `/sb pin` chamado de dentro de uma sessão do próprio mux**: a sessão que chamou (`CLAUDE_JOB_DIR`) nunca é parada na hora; vai para a fila. Testes nas Tasks 17 e 18.
4. **Classificação do `--settings` pelo caminho do link, não pelo alvo**: `mux/bk.json` resolve (realpath) para `tokens/gabriel.json`; tem que ser classificado como mux `bk`. Formas `--settings X`, `--settings=X` e `~/…`. Teste na Task 14.
5. **`watch` e comando manual ao mesmo tempo** (swap durante um tick; lock de pid morto): espera-se exclusão mútua e lock órfão tomado. Testes nas Tasks 7 e 19.

---

## Marco 0 — Spikes (antes de qualquer código)

Spikes não seguem TDD: cada um termina com fatos escritos e commitados. Sessões de teste conforme as Global Constraints.

### Task 1: Spike — estado da sessão depois de um turno que falha por limite

**Files:**
- Create: `spikes/sessoes/cl`, `spikes/sessoes/observa.py`, `spikes/sessoes/RESULTADOS.md`

**Interfaces:**
- Produces: `observa.py snapshot|vigia|regrava` (usado nas Tasks 2–4); fatos para `activityOf()` da Task 15.

Já observado em 03/11 (três sessões reais, paradas depois): `state: "blocked"`, `inFlight: {tasks: 0, queued: 1, kinds: [], drainableMonitors: 0}`, `needs: "rate limited — wait and retry · You've hit your 5-hour limit · resets 6:50pm (America/Fortaleza)"` (c802ba64, 64e82d8e, 5b3f2ad1). **Contradiz a regra provisória do §4**: com `queued: 1`, "livre = `queued == 0`" nunca trocaria a sessão que bateu no limite. Forçar um limite gastaria uso (anti-objetivo), então a confirmação com a sessão **viva** é por observação.

- [ ] **Step 1: Criar `spikes/sessoes/cl` (modo 755)**

```sh
#!/bin/sh
# claude com o ambiente limpo (F10): nada da sessão nem token vaza para o daemon.
exec env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION \
  -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_JOB_DIR \
  -u CLAUDE_CODE_OAUTH_TOKEN -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ATTENDED \
  -u CLAUDE_PID -u CLAUDE_CODE_AGENT -u CLAUDE_CONFIG_DIR claude "$@"
```

- [ ] **Step 2: Escrever `observa.py` (Python stdlib, rodar com `python3 -I`)**

Subcomandos:
- `snapshot [ids…] [--rate-limited]`: uma linha JSON por sessão com `id`, `at`, `agents` (`state`, `status`, `hasPid`, `kind`, `startedAt`), `job` (`state`, `tempo`, `inFlight`, `needs[:120]`, `detail[:80]`, `cliVersion`, `sessionId`, `resumeSessionId`), `settings` (valores de `--settings` dos `respawnFlags`, com o HOME trocado por `~`) e `timeline` (3 últimas linhas de `timeline.jsonl`: `at`, `state`, `detail[:80]`). Lê `claude agents --json --all` via `cl` e `~/.claude/jobs/<id>/state.json`. Aplica `re.sub(r'sk-ant-\S+', '<token>', …)` em toda saída.
- `vigia --every 60 --horas 24 --out spikes/sessoes/limite.jsonl [--detach]`: a cada ciclo grava um snapshot de toda sessão com `needs` começando por `rate limited`, e continua acompanhando as já vistas; só grava quando muda a tupla (`state`, `status`, `hasPid`, `queued`, `needs`). Sai sozinho no prazo. `--detach`: duplo fork + `os.setsid()`, stdio em `/dev/null`, grava o pid em `spikes/sessoes/vigia.pid` (sobrevive ao fim do shell que o chamou).
- `regrava <id> <settings>`: com a sessão **parada**, relê `state.json`, troca os valores de `--settings` por `<settings>` e grava (atômico). **Recusa** se o `name` da sessão não começa com `sb-spike-`.

- [ ] **Step 3: Registrar o histórico**

Run: `python3 -I spikes/sessoes/observa.py snapshot c802ba64 64e82d8e 5b3f2ad1`
Expected: as três com `job.state == "blocked"`, `inFlight.queued == 1`, `needs` com o prefixo `rate limited — wait and retry`. Copiar para `RESULTADOS.md` §1 com a nota "paradas no momento da leitura; `status`/`pid` com a sessão viva: não observados".

- [ ] **Step 4: Ligar o observador**

Run: `python3 -I spikes/sessoes/observa.py vigia --every 60 --horas 24 --out spikes/sessoes/limite.jsonl --detach`
Expected: `ps -p $(cat spikes/sessoes/vigia.pid)` vivo. Ele responde, ao longo do dia: com a sessão viva e presa por limite, qual o `status` (`idle`?) e o `queued`; ao passar o reset, o daemon tenta de novo sozinho (`state` volta a `working` sem mensagem nova)?; ao reabrir, o item `queued` roda de novo?

- [ ] **Step 5: Commit**

```bash
git add spikes/sessoes/cl spikes/sessoes/observa.py spikes/sessoes/RESULTADOS.md
git commit -m "spike: observador de sessões e estado histórico após limite"
```

### Task 2: Spike — reabrir uma sessão parada (`respawn`, `--bg --resume`)

**Files:**
- Modify: `spikes/sessoes/RESULTADOS.md` (§2)

**Interfaces:**
- Consumes: `cl`, `observa.py` (Task 1).
- Produces: se `respawn`/`--bg --resume` mantêm o id e os `respawnFlags`; se `agents --json` `startedAt` acompanha o início do processo (decide `startedAt()` na Task 15).

Conflito a resolver: a ajuda do 2.1.317 diz que `--bg --resume <id>` "continua sob o mesmo ID, ou faz uma cópia quando ela já está rodando"; o `trocar_viva` do `claude-conta` diz que "sempre cria um job novo (cópia) — visto no daemon.log".

- [ ] **Step 1: Criar a sessão de teste**

```bash
CL=$PWD/spikes/sessoes/cl; D=$(mktemp -d /tmp/sb-spike-XXXX)
(cd "$D" && $CL --bg --name sb-spike-reabrir --model haiku --settings ~/.claude/contas/ativa.json "Responda só: ok")
```
Expected: imprime o id curto. Esperar `state` sair de `working`; guardar `snapshot <id>` (id, `sessionId`, `startedAt`, `respawnFlags`).

- [ ] **Step 2: Parar e marcar os flags**

Run: `$CL stop <id>`; esperar `hasPid: false`; `ln -s ~/.claude/contas/ativa.json "$D/marca.json"`; `python3 -I spikes/sessoes/observa.py regrava <id> "$D/marca.json"`.
Expected: `snapshot <id>` mostra `settings: ["…/marca.json"]`.

- [ ] **Step 3: Testar `claude respawn <id>`**

Run: `$CL respawn <id>`; depois `snapshot <id>` e `ps -o command= -p <pid> | grep -o -- '--settings [^ ]*'`.
Registrar: mesmo id? ganhou pid? o processo tem `--settings …/marca.json`? `startedAt` mudou? `sessionId` igual? Algum job novo apareceu em `agents --json --all`?

- [ ] **Step 4: Testar `claude --bg --resume`**

Run: `$CL stop <id>`, esperar; `$CL --bg --resume <sessionId>`; repetir com o id curto se o primeiro criar cópia.
Registrar as mesmas perguntas do Step 3, mais: o job aberto usa os `respawnFlags` gravados ou só os flags da linha de comando?

- [ ] **Step 5: Limpar e commitar**

Run: `$CL stop` e `$CL rm` em cada id criado; `$CL agents --json --all | grep -c sb-spike` deve dar `0`.

```bash
git add spikes/sessoes/RESULTADOS.md
git commit -m "spike: reabrir sessão parada (respawn, --bg --resume)"
```

### Task 3: Spike — detectar trabalho agendado (`/loop`, ScheduleWakeup, Monitor, CronCreate)

**Files:**
- Modify: `spikes/sessoes/RESULTADOS.md` (§3)

**Interfaces:**
- Consumes: `cl`, `observa.py`; o mecanismo de reabrir da Task 2.
- Produces: a regra de `hasScheduledWork()` (Task 15).

Já observado: `inFlight.kinds` traz `local_bash` e `local_agent` em sessões `busy` (trabalho dentro do turno, não agendado); `drainableMonitors > 0` em 0 de 51 jobs. A pergunta é o que uma sessão mostra **entre ticks**.

- [ ] **Step 1: Abrir quatro sessões de teste, cada uma no próprio diretório temporário, com `--model haiku --settings ~/.claude/contas/ativa.json`**

| nome | prompt |
|---|---|
| `sb-spike-loop` | `/loop 2m responda só: tick` |
| `sb-spike-wakeup` | `/loop responda só: tick (acorde de novo em 2 minutos)` |
| `sb-spike-monitor` | `Use a ferramenta Monitor para acompanhar o comando "while true; do date; sleep 30; done" e termine o turno sem esperar.` |
| `sb-spike-cron` | `Use CronCreate para agendar, daqui a 5 minutos, uma única execução do prompt "responda só: oi". Termine o turno.` |

Antes: `touch "$D/marco"` para achar depois os arquivos que mudaram.

- [ ] **Step 2: Observar entre ticks e durante um tick**

Run, em cada sessão, com ela livre entre ticks e de novo durante um tick: `python3 -I spikes/sessoes/observa.py snapshot <ids…>`; `ls ~/.claude/jobs/<id>/`; `find ~/.claude -maxdepth 3 -newer "$D/marco" -type f -not -path '*/projects/*'`.
Registrar por sessão: `status`, `state`, `inFlight` (`tasks`, `queued`, `kinds`, `drainableMonitors`), chaves novas no `state.json`, onde o cron/wakeup fica gravado.

- [ ] **Step 3: O agendamento sobrevive a `stop` + reabrir?**

Run: `$CL stop` em `sb-spike-loop` e `sb-spike-cron`; reabrir pelo mecanismo da Task 2 (ou `claude attach` se nenhum reabrir); observar 3 minutos.
Registrar: os ticks voltam? o cron dispara?

- [ ] **Step 4: Limpar e commitar**

Run: `stop` + `rm` em todas; `agents --json --all | grep -c sb-spike` = `0`.

```bash
git add spikes/sessoes/RESULTADOS.md
git commit -m "spike: marcadores de trabalho agendado no state.json"
```

### Task 4: Fechar os spikes — fatos no design, fixtures, Gate G1

**Files:**
- Modify: `docs/superpowers/specs/2026-11-03-switchboard-design.md` (§3: F12–F14; §4: o parágrafo "Não medido" e a regra de sessões agendadas)
- Modify: `spikes/sessoes/RESULTADOS.md` (resumo e regras)
- Create: `test/fixtures/claude/agents.json`, `test/fixtures/claude/jobs/<id>/state.json` (um por caso)

**Interfaces:**
- Produces: as regras finais de `activityOf()`, `hasScheduledWork()` e `startedAt()` que a Task 15 implementa; as fixtures do teste de contrato da Task 14.

- [ ] **Step 1: Ler `spikes/sessoes/limite.jsonl` (o que o observador já pegou) e escrever as regras em `RESULTADOS.md`**

Formato obrigatório, uma linha por regra, com a evidência ao lado:
- `limit-blocked` = … (provisória, se não houve observação viva: `job.state == 'blocked'` e `needs` começa com `rate limited` e `tasks == 0` e `kinds` vazio e `drainableMonitors == 0` e `status != 'busy'`; `queued` pode ser 1).
- `hasScheduledWork` = … (se o spike não achou marcador: `kinds.length > 0 || drainableMonitors > 0`, a regra conservadora do §4).
- `startedAt` = `agents.startedAt` **ou** `ps -o etime=` (o que a Task 2 provou).
- reabrir por comando: sim/não, qual.

- [ ] **Step 2: Atualizar o design**

Acrescentar F12 (estado após limite), F13 (marcadores de agendamento), F14 (reabrir) em §3, marcados `[spike 03/11]`; trocar o parágrafo "Não medido" do §4 pela regra medida (ou pela provisória com a pergunta aberta "o item `queued` roda de novo com o token novo ao reabrir?").

- [ ] **Step 3: Gravar as fixtures saneadas**

A partir de snapshots reais: casos `live-busy`, `live-idle`, `stopped`, `limit-blocked`, `scheduled` (se observado), `foreign-settings`, `no-settings`. Sanear: `cwd`/`name` → `/Users/x/proj/<caso>`, `detail`/`needs` genéricos (manter o prefixo `rate limited — wait and retry`), `respawnFlags` com no máximo 2 `--allowed-tools` e os `--settings` reescritos para `~/.local/state/switchboard/mux/bk.json`, `…/pins/admin1.json`, `~/.claude/contas/ativa.json` ou `/tmp/outro.json` conforme o caso. `grep -c sk-ant test/fixtures -r` = 0.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs spikes/sessoes test/fixtures
git commit -m "docs: F12–F14 dos spikes de sessão; fixtures do adaptador"
```

- [ ] **Step 5: Gate G1 — decidido pelo controlador, não pelo usuário** (ledger, 03/11): as regras acima valem; a sessão de teste que bate no limite ficou de fora (nenhuma conta ≥ 85 % na janela de 5 h; forçar gastaria uso). O usuário vê o resumo no topo de `spikes/sessoes/RESULTADOS.md` e pode reverter.

---

## Marco 1 — Base (independe dos spikes)

### Task 5: Esqueleto, erros, paths, Ctx, claude falso, teste de higiene

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsdown.config.ts`, `.gitignore` (node_modules, dist, *.log, .DS_Store, `spikes/sessoes/limite.jsonl`, `spikes/sessoes/vigia.pid`), `scripts/postbuild.ts`, `src/cli.ts`, `src/commands/guard.ts`, `src/core/errors.ts`, `src/core/paths.ts`, `src/core/ctx.ts`, `src/core/claude.ts`, `test/helpers.ts`, `test/fake-claude.ts`, `test/paths.test.ts`, `test/claude-env.test.ts`, `test/hygiene.test.ts`

**Interfaces:**
- Produces:
  - `EXIT` (Global Constraints), `class SbError extends Error { exit: ExitCode; detail?: string }`, `guarded(fn)` (cópia do plugboard com `SbError`).
  - `interface Paths { home; configFile; stateDir; jobsDir; claudeDir; launchAgentsDir; zshrc }`, `resolvePaths(env): Paths` (`SWITCHBOARD_CONFIG` ?? `${XDG_CONFIG_HOME ?? ~/.config}/switchboard/config.jsonc`; `SWITCHBOARD_STATE_DIR` ?? `${XDG_STATE_HOME ?? ~/.local/state}/switchboard`; `SWITCHBOARD_JOBS_DIR` ?? `~/.claude/jobs`; `claudeDir` = `~/.claude`; `~` = `env.HOME`).
  - `tokenFile(p, account)`, `muxLink(p, mux)`, `pinLink(p, account)`, `usageFile(p)`, `runtimeFile(p)`, `lockFile(p)`, `logFile(p, 'watch'|'login')`, `backupDir(p, stamp)`.
  - `type FetchLike = (url: string, init: { method: 'POST'; headers: Record<string,string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; headers: { get(n: string): string | null } }>`
  - `type Runner = (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string,string>; timeoutMs?: number }) => { status: number | null; stdout: string; stderr: string }`
  - `interface Ctx { paths; env; now(): number /* ms */; fetch: FetchLike; run: Runner; notify(title, msg): void; log(file: 'watch'|'login', line: string): void }`, `defaultCtx(env = process.env): Ctx` (`notify` = `osascript`, no-op com `SWITCHBOARD_NO_NOTIFY`; `log` acrescenta `ISO linha` e troca `/sk-ant-[A-Za-z0-9_-]+/g` por `<token>`).
  - `SESSION_VARS` (lista F10, 12 nomes), `cleanEnv(env): Record<string,string>`, `claudeBin(env): string` (`SWITCHBOARD_CLAUDE` ?? `claude` do PATH).
  - `test/helpers.ts`: `FAKE_TOKEN = 'sk-ant-oat01-' + 'x'.repeat(40)`; `sandbox(): { dir; env; paths; ctx(over?: Partial<Ctx>): Ctx; runSb(args: string[], opts?: { env?; cwd?; input? }): { code; stdout; stderr }; calls(): FakeCall[] }`.
  - `test/fake-claude.ts` (executável bun, lê `FAKE_CLAUDE_DIR`): toda chamada acrescenta `{"argv":[…],"cwd":…,"hasOauthEnv":bool}` a `calls.jsonl`; `setup-token` imprime o conteúdo de `setup-token.txt` (se existir) e sai 0; o resto sai 0. (`agents`/`stop` entram na Task 14.)

- [ ] **Step 1: Testes que falham**

```ts
// test/paths.test.ts
test('padrões a partir do HOME', () => {
  const p = resolvePaths({ HOME: '/h' })
  expect(p.configFile).toBe('/h/.config/switchboard/config.jsonc')
  expect(p.stateDir).toBe('/h/.local/state/switchboard')
  expect(p.jobsDir).toBe('/h/.claude/jobs')
})
test('overrides SWITCHBOARD_* e XDG', () => {
  expect(resolvePaths({ HOME: '/h', XDG_STATE_HOME: '/s' }).stateDir).toBe('/s/switchboard')
  expect(resolvePaths({ HOME: '/h', SWITCHBOARD_STATE_DIR: '/x' }).stateDir).toBe('/x')
})
// test/claude-env.test.ts
test('cleanEnv tira as 12 variáveis F10 e mantém o resto', () => {
  const env = Object.fromEntries([...SESSION_VARS, 'PATH'].map((k) => [k, '1']))
  expect(Object.keys(cleanEnv(env))).toEqual(['PATH'])
  expect(SESSION_VARS).toContain('CLAUDE_CODE_OAUTH_TOKEN')
})
// test/hygiene.test.ts
const CASES: string[][] = [['--version']] // cada task que cria comando acrescenta casos
test.each(CASES)('sem token na saída: sb %p', (...args) => {
  const sb = populatedSandbox() // config + tokens FAKE_TOKEN + usage + jobs (cresce com as tasks)
  const r = sb.runSb(args)
  expect(r.stdout + r.stderr).not.toMatch(/sk-ant-/)
  for (const f of filesUnder(sb.paths.stateDir).filter((f) => !f.includes('/tokens/'))) expect(readFileSync(f, 'utf8')).not.toMatch(/sk-ant-/)
})
```

- [ ] **Step 2: Rodar e ver falhar** — Run: `bun test` · Expected: FAIL (módulos inexistentes).

- [ ] **Step 3: Implementar** os arquivos acima; `package.json` como o do plugboard (nome `switchboard`, `bin: { "sb": "./dist/cli.js" }`, `version 0.1.0`, deps `jsonc-parser ^3.3.1`, `zod ^4.5.4`; dev `citty ^0.2.2`, `tsdown ^0.22.14`, `typescript ^5.9.3`, `@types/bun`); `src/cli.ts` com `meta.name 'sb'` e subcomandos carregados sob demanda (vazio por ora); `bun install`.

- [ ] **Step 4: Verificar** — Run: `bun test && bun run check` · Expected: PASS, sem erro de tipo.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: esqueleto do sb (erros, paths, Ctx, claude falso, higiene)"`

### Task 6: Config — schema zod, loader JSONC, invariantes, edição que preserva comentários

**Files:**
- Create: `src/core/schema.ts`, `src/core/config.ts`, `scripts/gen-schema.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: `SbError`, `EXIT`, `Paths` (Task 5).
- Produces:
  - `Config` (zod, `strictObject` em todo nível): `{ $schema?: string; switchboard: 1; accounts: Record<AccountName, {}>; swap: { auto = true; threshold: { fiveHour = 0.9; sevenDay = 0.95 }; returnOnReset = true; probeEvery = '5m' }; default?: string; mux: Record<MuxName, MuxConfig> }`, `MuxConfig = { root: string; account: AccountRef; accounts: AccountRef[] (min 1); pool: AccountRef[] = [] }`. `AccountRef` = nome válido ou `'keychain'`. Tipos `type Config = z.output<typeof Config>`, `type SwapConfig`, `type Threshold`.
  - `loadConfig(paths): Promise<Config>`, `parseConfig(text, file): Config`, `editConfig(paths, edits: Array<{ path: (string|number)[]; value: unknown }>): Promise<Config>` (jsonc-parser `modify`+`applyEdits`, valida o texto novo com `parseConfig` antes de gravar; inválido → não grava), `ensureConfig(paths): Promise<void>` (cria `{ "$schema": <file URL do schema.json do pacote>, "switchboard": 1, "accounts": {}, "mux": {} }`), `parseDuration('30s'|'5m'|'1h'): number /* ms */`.
  - Erros: `class InvalidConfigError extends SbError` (exit 2, `detail` com `caminho: mensagem` por linha).

Invariantes (superRefine; mensagem em português, caminho exato): `mux.<m>.account ∈ mux.<m>.accounts`; `mux.<m>.pool ⊆ mux.<m>.accounts`; `keychain ∉ pool`; toda conta ≠ `keychain` em `accounts`/`pool` existe em `accounts` (registro); `keychain` não pode ser chave do registro; sem repetição dentro de `accounts`/`pool`; `default` obrigatório se `mux` não vazio e ∈ `mux`; dois muxes não podem ter o mesmo `root` (comparar com `~` expandido e `path.resolve`). Chave duplicada no JSONC = erro (copiar `findDuplicateKeys` do plugboard).

- [ ] **Step 1: Testes que falham** (`test/config.test.ts`; `DESIGN_EXAMPLE` = o JSONC do §5 do design, com os comentários)

```ts
test('exemplo do §5 carrega com defaults', () => {
  const c = parseConfig(DESIGN_EXAMPLE, 'x')
  expect(c.swap).toEqual({ auto: true, threshold: { fiveHour: 0.9, sevenDay: 0.95 }, returnOnReset: true, probeEvery: '5m' })
  expect(c.mux.pessoal!.pool).toEqual(['admin1', 'gabriel'])
})
test.each([
  ['chave desconhecida', (c) => (c.mux.bk.swap = false), 'mux.bk'],
  ['account ∉ accounts', (c) => (c.mux.bk.account = 'cliente-x', c.mux.bk.accounts = ['gabriel']), 'mux.bk.account'],
  ['pool ⊄ accounts', (c) => (c.mux.pessoal.pool = ['admin1', 'cliente-x']), 'mux.pessoal.pool'],
  ['keychain no pool', (c) => (c.mux.berzerk.pool = ['keychain']), 'mux.berzerk.pool'],
  ['conta sem registro', (c) => delete c.accounts['cliente-x'], 'mux.bk.accounts'],
  ['keychain registrada', (c) => (c.accounts.keychain = {}), 'accounts.keychain'],
  ['default inexistente', (c) => (c.default = 'nada'), 'default'],
  ['root repetido', (c) => (c.mux.pessoal.root = c.mux.bk.root), 'mux.pessoal.root'],
])('%s → InvalidConfigError com o caminho', (_n, mutate, path) => {
  const obj = structuredClone(EXAMPLE_OBJ); mutate(obj)
  expect(() => parseConfig(JSON.stringify(obj), 'x')).toThrow(InvalidConfigError)
  try { parseConfig(JSON.stringify(obj), 'x') } catch (e) { expect((e as SbError).detail).toContain(path) }
})
test('chave duplicada é erro', () => expect(() => parseConfig('{"switchboard":1,"accounts":{},"mux":{},"mux":{}}', 'x')).toThrow(/chave duplicada: "mux"/))
test('arquivo ausente → exit 2 com dica de `sb login`', async () => { /* loadConfig num sandbox vazio */ })
test('editConfig preserva comentários e recusa edição que quebra invariante', async () => {
  // grava DESIGN_EXAMPLE; edita mux.bk.pool = ['gabriel']; o texto continua com "// hot-swap"
  // edita mux.bk.pool = ['nada'] → lança e o arquivo fica igual
})
test('parseDuration', () => {
  expect([parseDuration('30s'), parseDuration('5m'), parseDuration('1h')]).toEqual([30_000, 300_000, 3_600_000])
  expect(() => parseDuration('5x')).toThrow()
})
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/config.test.ts` · FAIL.
- [ ] **Step 3: Implementar**; `scripts/gen-schema.ts` como o do plugboard (`io: 'input'`, `target: 'draft-7'`, título `switchboard config`); script `build` = `tsdown && bun scripts/gen-schema.ts && bun scripts/postbuild.ts`.
- [ ] **Step 4: Verificar** — `bun test && bun scripts/gen-schema.ts` · PASS e `schema.json` gerado.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: config (schema zod, JSONC, invariantes por mux)"`

### Task 7: Estado em disco — escrita atômica, lock, tokens, links, runtime

**Files:**
- Create: `src/core/fsx.ts`, `src/core/tokens.ts`, `src/core/links.ts`, `src/core/runtime.ts`, `test/state.test.ts`
- Modify: `test/helpers.ts` (`sb.addToken(account, token = FAKE_TOKEN)`), `src/core/paths.ts` + `test/paths.test.ts` (guarda de nome, abaixo)

**Interfaces:**
- Consumes: `Paths`, `SbError` (Task 5).
- Do review da Task 6: `editConfig` (Task 6) grava com temp+rename inline, sem lock; aqui ele passa a usar `writeAtomic` (o temp não pode colidir entre chamadas no mesmo processo: nome com pid + contador/aleatório; se o arquivo da config for symlink, gravar no alvo, não trocar o link) e os chamadores (Tasks 12, 13, 17) envolvem `editConfig` em `withLock`. Teste: duas edições concorrentes não perdem atualização.
- Defesa em profundidade (ruling do controlador após a revisão da Task 5): `assertSafeName(name: string): string` em `src/core/paths.ts` — lança `SbError(…, EXIT.USAGE)` (mensagem em português) a menos que `/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)`; `tokenFile`, `muxLink` e `pinLink` passam a chamá-la (`keychain` já é um nome válido). Teste: `tokenFile(p, '../x')`, `'a/b'`, `''`, `'A'` e um nome de 33 caracteres lançam com exit 3; `'admin1'`, `'keychain'`, `'a_b-c'` passam.
- Produces:
  - `writeAtomic(path, text, mode)`, `symlinkAtomic(link, target)` (link temporário + `rename`), `withLock<T>(paths, fn: () => Promise<T>, opts?: { waitMs = 30_000 }): Promise<T>` (lança `SbError` exit 5).
  - `ensureState(paths)` (dirs 700: raiz, `tokens`, `mux`, `pins`, `log`, `backup`; `tokens/keychain.json` = `{}` modo 600), `saveToken(paths, account, token)` (`{"env":{"CLAUDE_CODE_OAUTH_TOKEN":…}}`, 600), `loadSecret(paths, account): string | null` (**só** a sonda, o login e a migração chamam), `hasToken(paths, account): boolean`.
  - `type TargetProblem = 'missing-link' | 'broken' | 'invalid-json' | 'no-oauth'`; `checkSettingsTarget(link): { ok: true; account: string } | { ok: false; problem: TargetProblem }` (keychain válido só se o alvo é exatamente `{}`); `pointMux(paths, mux, account)`, `ensurePin(paths, account): string`, `currentAccount(paths, mux): string | null` (basename do `readlink`, sem `.json`).
  - `interface Runtime { mux: Record<string, { since: number; lastSwap?: { at: number; from: string; to: string; reason: string } }>; overrides: Record<string, { account: string; until: number }>; pending: Array<{ jobId: string; settings: string; reason: 'pin'|'unpin'|'adopt'|'migrate'; requestedAt: number }>; notified: Record<string, number> }`; `readRuntime(paths): Runtime` (ausente → vazio), `writeRuntime(paths, r)`.

- [ ] **Step 1: Testes que falham**

```ts
test('ensureState cria dirs 700 e keychain.json {} 600', ...)       // statSync(...).mode & 0o777
test('saveToken grava 600 e loadSecret devolve o token', ...)
test('pointMux troca o link de forma atômica e currentAccount lê', () => {
  pointMux(p, 'bk', 'gabriel'); pointMux(p, 'bk', 'admin1')
  expect(currentAccount(p, 'bk')).toBe('admin1')
  expect(readdirSync(join(p.stateDir, 'mux'))).toEqual(['bk.json'])   // nenhum temporário sobrou
})
test.each([
  ['link ausente', 'missing-link'], ['alvo inexistente', 'broken'],
  ['JSON inválido', 'invalid-json'], ['sem CLAUDE_CODE_OAUTH_TOKEN', 'no-oauth'],
])('checkSettingsTarget: %s → %s', ...)
test('checkSettingsTarget ok para keychain {} e para token válido', ...)
test('withLock: segundo pedido espera e falha com exit 5 enquanto o dono vive', async () => {
  // lockFile com o pid de um `sleep 5` vivo; withLock(p, fn, { waitMs: 300 }) rejeita com SbError exit 5
})
test('withLock toma lock de pid morto', ...)                          // pid 999999 → fn roda
test('readRuntime sem arquivo devolve estrutura vazia', ...)
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/state.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: estado em disco (tokens 600, links atômicos, lock, runtime)"`

### Task 8: Sonda de uso pelos cabeçalhos (F1)

**Files:**
- Create: `src/core/probe.ts`, `test/probe.test.ts`
- Modify: `test/helpers.ts` (`fakeApi(handler): Promise<{ url: string; stop(): void; requests: Request[] }>` com `Bun.serve({ port: 0 })`)

**Interfaces:**
- Consumes: `FetchLike` (Task 5).
- Produces:
  - `interface Window { utilization: number; resetsAt: number /* epoch s */; status: string }`
  - `type ProbeResult = { ok: true; fiveHour: Window; sevenDay: Window; status: string; resetsAt: number; representativeClaim?: string; overageStatus?: string } | { ok: false; error: 'dead-token' | 'rate-limited' | 'network' | 'unexpected'; httpStatus?: number }`
  - `probeToken(token, opts: { fetch: FetchLike; baseUrl: string; timeoutMs = 15_000 }): Promise<ProbeResult>`

Regra: se a resposta traz `anthropic-ratelimit-unified-5h-utilization`, faz o parse **qualquer que seja o status HTTP** (uma conta esgotada responde 429 com os cabeçalhos e `status: rejected`). Sem os cabeçalhos: 401/403 → `dead-token`; 429 → `rate-limited`; outro → `unexpected`. Exceção/timeout → `network`. Descartar o corpo da resposta. Nenhum campo do resultado contém o token.

- [ ] **Step 1: Testes que falham**

```ts
const H = { 'anthropic-ratelimit-unified-5h-utilization': '0.24', 'anthropic-ratelimit-unified-5h-reset': '1762195800',
  'anthropic-ratelimit-unified-5h-status': 'allowed', 'anthropic-ratelimit-unified-7d-utilization': '0.38',
  'anthropic-ratelimit-unified-7d-reset': '1762444800', 'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-reset': '1762195800',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour' }
test('200: request exato do F1 e parse numérico', async () => {
  const r = await probeToken(FAKE_TOKEN, { fetch: recordingFetch(200, H), baseUrl: 'http://x' })
  expect(r).toEqual({ ok: true, fiveHour: { utilization: 0.24, resetsAt: 1762195800, status: 'allowed' },
    sevenDay: { utilization: 0.38, resetsAt: 1762444800, status: 'allowed' }, status: 'allowed', resetsAt: 1762195800, representativeClaim: 'five_hour' })
  expect(lastCall.url).toBe('http://x/v1/messages')
  expect(lastCall.init.headers).toMatchObject({ authorization: `Bearer ${FAKE_TOKEN}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' })
  expect(JSON.parse(lastCall.init.body)).toEqual({ model: 'claude-haiku-4-5', max_tokens: 1,
    system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: 'user', content: 'ok' }] })
})
test('429 com cabeçalhos → ok com status rejected', ...)   // 5h-status 'rejected', utilization '1.0'
test.each([[401, 'dead-token'], [403, 'dead-token'], [429, 'rate-limited'], [500, 'unexpected']])('%i sem cabeçalhos → %s', ...)
test('fetch lança → network, sem token no resultado', async () => {
  const r = await probeToken(FAKE_TOKEN, { fetch: async () => { throw new Error(`boom ${FAKE_TOKEN}`) }, baseUrl: 'http://x' })
  expect(r).toEqual({ ok: false, error: 'network' }); expect(JSON.stringify(r)).not.toMatch(/sk-ant-/)
})
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/probe.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: sonda de uso pelos cabeçalhos unified (F1)"`

### Task 9: Medição — um token distinto por chamada, cache, duplicatas, total do pool

**Files:**
- Create: `src/core/usage.ts`, `test/usage.test.ts`

**Interfaces:**
- Consumes: `probeToken`, `ProbeResult` (Task 8); `loadSecret`, `writeAtomic`, `usageFile` (Tasks 5, 7); `Config` (Task 6); `Ctx`.
- Produces:
  - `type Measurement = (ProbeResult | { ok: false; error: 'no-token' }) & { measuredAt: number /* ms */ }`
  - `interface UsageFile { latest: Record<string, Measurement>; previous: Record<string, Measurement>; groups: string[][] }`
  - `readUsage(paths): UsageFile`, `measureAll(ctx, cfg, opts: { maxAgeMs: number }): Promise<UsageFile>`, `groupOf(usage, account): string[]` (o grupo ou `[account]`), `poolTotal(cfg, usage): { fiveHour: number | null; sevenDay: number | null; accounts: string[] }`.

Regras: mede só contas do registro (`keychain` nunca); pula as com `latest.measuredAt` mais nova que `maxAgeMs`; contas com o **mesmo token** fazem uma chamada só e recebem a mesma medição; `previous ← latest` antes de gravar a nova. Duplicata (§6): mesma impressão `5h.resetsAt|7d.resetsAt|5h.utilization|7d.utilization` em `latest` **e** em `previous` (as duas `ok`) → mesmo grupo; grupo ordenado pela ordem do registro (o 1º é o representante). Total do pool: média, por janela, dos representantes das contas que aparecem no `pool` de algum mux e têm medição `ok`.

- [ ] **Step 1: Testes que falham**

```ts
test('mesmo token salvo em duas contas → uma chamada só', ...)          // fetch contado == 1, latest.admin1 == latest.outra
test('cache: medição com 30 s não sonda de novo com maxAgeMs 60 s', ...)
test('sem token → { ok:false, error:"no-token" } e nenhuma chamada', ...)
test('keychain nunca é medida', ...)
test('duplicata só depois de duas medições iguais seguidas', async () => {
  // tokens distintos, servidor responde os mesmos cabeçalhos para admin1 e outra
  const first = await measureAll(ctx, cfg, { maxAgeMs: 0 }); expect(first.groups).toEqual([])
  const second = await measureAll(ctx, cfg, { maxAgeMs: 0 }); expect(second.groups).toEqual([['admin1', 'outra']])
})
test('poolTotal: média dos representantes no pool de algum mux', () => {
  // gabriel 0.01/0.15, admin1 0.24/0.38, outra dup de admin1, cliente-x fora de todo pool 0.9/0.9
  expect(poolTotal(cfg, usage)).toEqual({ fiveHour: 0.125, sevenDay: 0.265, accounts: ['gabriel', 'admin1'] })
})
test('usage.json não contém token', ...)
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/usage.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: medição por token distinto, duplicatas e total do pool"`

### Task 10: Regras de troca — disponibilidade e conta desejada (puro)

**Files:**
- Create: `src/core/rules.ts`, `test/rules.test.ts`

**Interfaces:**
- Consumes: `Measurement`, `UsageFile`, `groupOf` (Task 9); `MuxConfig`, `SwapConfig`, `Threshold` (Task 6).
- Produces:
  - `type Availability = 'available' | 'exhausted' | 'unknown'`
  - `availability(m: Measurement | undefined, th: Threshold, nowMs: number, opts?: { returning?: boolean }): Availability`
  - `interface MuxEval { mux: string; current: string; desired: string; reason: 'no-pool' | 'override' | 'preferred' | 'sticky' | 'preferred-outside-pool' | 'pool' | 'none-available'; warn?: string }`
  - `desiredAccount(input: { name: string; mux: MuxConfig; current: string; usage: UsageFile; swap: SwapConfig; override?: { account: string; until: number }; nowMs: number }): MuxEval`
  - `HYSTERESIS = 0.10`

`availability`: sem medição → `unknown`; `no-token`/`dead-token` → `exhausted`; **`rate-limited` → `exhausted`** (ruling do controlador após a revisão da Task 8: um 429 da sonda, mesmo sem cabeçalhos legíveis, é o sinal de conta esgotada; não há reset conhecido, então vale até a próxima medição `ok` e a histerese do retorno não se aplica); outros erros (`network`, `unexpected`) → `unknown`. Com margem `m = returning ? HYSTERESIS : 0`: janela esgotada se `utilization ≥ limite − m` **ou** `status` não começa com `allowed`; esgotada **e** `nowMs/1000 < resetsAt` → `exhausted`; o `status` geral `rejected` com `resetsAt` futuro → `exhausted`; senão `available`.

`desiredAccount` (algoritmo revisto após a revisão da Task 10 — controlador; `stay(c)` = `c ∈ mux.accounts ∧ availability(c) ≠ 'exhausted'`, ou seja uma medição `unknown` é falha NOSSA e nunca, sozinha, faz o mux sair de um lugar válido):
```
1. pool vazio                                   → current            'no-pool'
2. override ativo (nowMs < until, ms):
     availability(override.account) == available            → override.account  'override'
     == unknown e current == override.account               → current           'override'
     senão (esgotada, ou unknown e current ≠ override)      → segue para 3 com o override anulado ("fila normal": a preferida volta a valer)
3. pref: R = current ≠ pref ∧ current ∈ accounts ∧ current ∉ groupOf(pref)   (é "reserva" → histerese de retorno; current ∉ accounts ou duplicata da pref não é reserva)
   pa = availability(pref, { returning: R })
   current == pref ou duplicata de pref que esteja em mux.accounts (duplicata fora de accounts não conta como "fica": vale a regra do passo 6 → pref): pa ≠ exhausted → current/pref 'preferred'
   current ≠ pref (reserva ou fora de accounts):
     pa == available → se !returnOnReset ∧ current ∈ pool ∧ stay(current) → current 'sticky' (unknown também fica), senão pref 'preferred'
     pa == unknown   → se stay(current) → current 'sticky' (não há evidência para sair); senão pref 'preferred'
     pa == exhausted → segue
4. pref ∉ pool ∧ current é a pref (ou duplicata da pref ∈ accounts) → current/pref 'preferred-outside-pool' (warn: "fica nela"); se current é OUTRA conta, pula para 5 (a preferida fora do pool não é destino de troca)
5. se current ∈ pool ∧ current ≠ pref ∧ current ∉ groupOf(pref) ∧ availability(current) ≠ 'exhausted' (available OU unknown, sem histerese)
                                                → current            'pool'  (fica: trocar custa parar sessões; a ordem do pool escolhe destino, não faz saltar entre reservas)
   senão a 1ª conta c do pool, na ordem, com c ∉ groupOf(pref), sem repetir grupo já visto, availability(c) == available → c 'pool'  (destino: só `available`, sem histerese)
5b. se availability(pref, { returning: false }) == available   → pref  'preferred'   (nunca ficar numa conta esgotada/morta com a preferida utilizável: a histerese segura uma reserva usável, não uma esgotada)
6. nenhuma                                      → current (ou pref, se current ∉ mux.accounts)  'none-available' (warn: texto correto para o caso — "permanece em X" só quando desired == current)
```
`override.until` é em MILISSEGUNDOS (compara com `nowMs`; o `sb swap` guarda `fiveHour.resetsAt * 1000`). Teste de ponto fixo: iterar `desiredAccount` realimentando `current` converge em ≤ 2 passos e nunca forma ciclo de 2 (varredura aleatória de milhares de cenários).

- [ ] **Step 1: Testes que falham** (`NOW` fixo; `mk(u5, u7, opts?)` cria `Measurement` ok com resets em `NOW/1000 + 3600`)

```ts
const bk = { root: '/r', account: 'gabriel', accounts: ['gabriel', 'admin1', 'cliente-x'], pool: ['gabriel', 'admin1'] }
test('preferida disponível → preferida', () => expect(eval_({ gabriel: mk(0.01, 0.15) }).desired).toBe('gabriel'))
test('preferida 5h ≥ 90% → 2ª do pool', () => expect(eval_({ gabriel: mk(0.92, 0.1), admin1: mk(0.2, 0.3) })).toMatchObject({ desired: 'admin1', reason: 'pool' }))
test('preferida 7d ≥ 95% → 2ª do pool', ...)
test('status rejected com utilização baixa → esgotada', ...)
test('reset passou sem medição nova → volta à preferida', () => {
  const ex = mk(0.99, 0.2, { reset5h: NOW / 1000 - 60 })
  expect(eval_({ gabriel: ex, admin1: mk(0.2, 0.3) }, { current: 'admin1' }).desired).toBe('gabriel')
})
test('histerese: em admin1, preferida a 85% não volta; a 75% volta', ...)
test('preferida fora do pool e esgotada → fica nela com aviso', ...)       // pool ['admin1'], reason 'preferred-outside-pool', warn definido
test('pool vazio → nunca troca', ...)                                       // reason 'no-pool', desired == current
test('duplicata da preferida é pulada', ...)                                // pool [gabriel, outra, admin1]; groups [[gabriel, outra]] → admin1
test('destino sem medição ou com token morto é pulado; preferida sem medição fica', ...)
test('nenhuma disponível → fica na atual com aviso', ...)
test('override ativo vence a preferida disponível; override esgotado → fila sem a preferida; vencido → preferida', ...)
test('returnOnReset false: em admin1 disponível, fica (sticky)', ...)
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/rules.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: regras de troca por mux (preferida, pool, override, histerese)"`

### Task 11: Painel e contas — `sb`, `sb usage`, `sb accounts`

**Files:**
- Create: `src/report.ts`, `src/core/panel.ts`, `src/commands/usage.ts`, `src/commands/accounts.ts`, `test/panel.test.ts`, `test/cli-usage.test.ts`
- Modify: `src/cli.ts` (`run` sem subcomando = `usage`; subcomandos `usage`, `accounts`), `test/hygiene.test.ts` (casos `[]`, `['usage','--json']`, `['accounts','--json']`)

**Interfaces:**
- Consumes: `loadConfig` (6), `measureAll`, `poolTotal`, `groupOf` (9), `currentAccount`, `readRuntime`, `hasToken` (7).
- Produces:
  - `interface PanelData { accounts: Array<{ name: string; measurement?: Measurement; sameAs?: string; muxes: Array<{ mux: string; role: 'preferred' | 'pool' | 'allowed'; position?: number }> }>; mux: Array<{ name: string; current: string | null; preferred: string; pool: string[]; override?: { account: string; until: number } }>; total: ReturnType<typeof poolTotal>; auto: boolean; threshold: Threshold; pins: Array<{ jobId: string; account: string }>; measuredAt: number | null }` (`pins` fica `[]` até a Task 18).
  - `buildPanel(cfg, usage, runtime, paths): PanelData`; `renderPanel(d: PanelData, opts: { nowMs: number; timeZone?: string }): string`; `renderAccounts(…)`.
  - `formatReset(epochS, nowMs, timeZone?)`: mesmo dia → `HH:MM`, outro dia → `dd/mm`; `bar(u)` = 10 células, `round(u*10)` de `█`, resto `░`, e `NN%`.
  - Abaixo da linha `total`, a nota do §6: `(média das contas do pool; só vale como "quanto do total" se os planos forem iguais)`.
  - `sb usage [--json] [--watch] [--every 30]` (mede com `maxAgeMs: 60_000`); `sb accounts [--json]` = **central de contas** (decisão do usuário, 03/11 tarde): lista TODAS as contas registradas, anexadas ou não — estado do token (`ok` / `sem token` / `JSON inválido` / `morto` pela última medição), grupo de duplicata, resumo 5h/semanal com reset, e os muxes com papel e posição; conta sem mux aparece marcada `sem mux`. `--json`: `Array<{ name: string; token: 'ok'|'missing'|'invalid-json'|'dead'; measurement?: Measurement; sameAs?: string; attached: boolean; muxes: Array<{ mux: string; role: 'preferred'|'pool'|'allowed'; position?: number }> }>`. Teste: conta registrada sem mux → `attached: false` e linha `sem mux`.

- [ ] **Step 1: Testes que falham**

```ts
// test/panel.test.ts — dados do painel do §7 do design (03/11 11:30, America/Fortaleza)
test('render bate com o painel do design', () => {
  const out = renderPanel(DESIGN_PANEL_DATA, { nowMs: Date.parse('2026-11-03T14:30:00Z'), timeZone: 'America/Fortaleza' })
  expect(out).toContain('gabriel   ░░░░░░░░░░  1%  ██░░░░░░░░ 15%   bk (preferida) · pessoal (2º do pool)')
  expect(out).toContain('reseta 15:50'); expect(out).toContain('reseta 06/11')
  expect(out).toContain('└ outra (mesma conta que admin1)')
  expect(out).toContain('keychain  não medido'); expect(out).toContain('berzerk   keychain  keychain   sem hot-swap')
  expect(out).toContain('bk        gabriel   gabriel    gabriel → admin1')
  expect(out).toContain('total     5h 13% · semanal 27%'); expect(out).toContain('auto-swap ligado (90% / 95%)')
  expect(out).toContain('planos forem iguais')
})
test('override aparece com a expiração', ...)               // toContain('admin1 (manual até 15:50)')
test('erro de sonda aparece no lugar das barras', ...)     // 'token morto (401)', 'sem token'
// test/cli-usage.test.ts — subprocesso com sandbox + fakeApi
test('`sb` sem argumentos mostra o painel e sai 0', ...)
test('`sb usage --json` tem accounts/mux/total e nenhum token', ...)
test('sem config → exit 2 com dica', ...)
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/panel.test.ts test/cli-usage.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: painel de uso e lista de contas"`

### Task 12: `sb mux` (list/add/set/rm), `sb attach`/`sb detach`, `sb accounts rm` e `sb which`

**Files:**
- Create: `src/core/mux.ts`, `src/core/accounts.ts`, `src/commands/mux.ts`, `src/commands/attach.ts`, `src/commands/detach.ts`, `src/commands/which.ts`, `test/mux.test.ts`, `test/accounts.test.ts`
- Modify: `src/cli.ts`, `src/commands/accounts.ts` (subcomando `rm`; `sb accounts` sem subcomando segue sendo a listagem da Task 11), `test/hygiene.test.ts` (`['mux']`, `['which','--json']`, `['attach','admin1','bk','--pool']`, `['detach','admin1','bk']`, `['accounts','rm','admin1']` sem `--yes`)

**Interfaces:**
- Consumes: `editConfig`, `ensureConfig`, `loadConfig` (6); `pointMux`, `hasToken`, `ensureState` (7).
- Produces:
  - `resolveMuxForDir(cfg, dir): string` (root mais profundo que contém `dir`, comparando realpath com `~` expandido; senão `cfg.default`; sem default → `SbError` exit 2).
  - `addMux(ctx, name, o: { root; account; accounts?: string[] /* padrão [account] */; pool?: string[] /* padrão [] */ })`: grava a config (o 1º mux vira `default`) e aponta `mux/<name>.json` para a preferida; recusa conta sem token (exit 3, "rode `sb login <conta>`").
  - `setMux(ctx, name, partial)`: só edita a config e diz que a troca acontece no próximo ciclo do `watch` ou com `sb swap`.
  - `rmMux(ctx, name)`: recusa o `default`; tira da config e **mantém** o link (sessões existentes continuam abrindo; o `doctor` avisa link órfão).
  - `sb which [pasta] [--json]` → imprime o caminho do settings do mux da pasta (`--json`: `{ mux, settings, account }`). Usado pelo wrapper (Task 20).
  - **Contas e muxes são ligados por `attach`** (decisão do usuário, 03/11 tarde): a conta é cadastrada primeiro (`sb login`), sem mux nenhum; depois é anexada. Em `src/core/accounts.ts`:
    - `interface AttachSpec { mux: string; pool?: boolean | number /* true = fim da fila; número = posição 1-based */; preferred?: boolean }`
    - Nota de integração (review da Task 6): quando o mux é o 1º da config, o `default` precisa ir no MESMO lote de `editConfig` que cria o mux (as edições são tudo-ou-nada); `attachAccount`/`login --attach` passam as edições juntas.
    - `attachAccount(ctx, account: string, spec: AttachSpec): Promise<{ changed: string[] }>`: a conta tem de estar registrada e ter token (senão exit 3, "rode `sb login <conta> --attach <mux>`" — a Task 13 troca essa recusa por login + attach); mux inexistente → exit 3; acrescenta a `mux.accounts` se faltar; `pool` insere (ou move, se já está) em `mux.pool` no fim ou na posição pedida; `preferred` define `mux.account`; tudo por `editConfig` (invariantes valem: `keychain` no pool → exit 3); idempotente (`changed: []` se nada mudou). Mudar a preferida não troca a conta atual: vale no próximo ciclo do `watch` ou com `sb swap`.
    - `detachAccount(ctx, account, mux): Promise<{ changed: string[] }>`: tira de `mux.accounts` e de `mux.pool`; exit 3 se não estava anexada, se é a preferida do mux ("defina outra com `sb attach <outra> <mux> --preferred`") ou se é a conta atual do mux (`currentAccount`; "faça `sb swap` antes").
    - `removeAccount(ctx, account, o: { yes: boolean }): Promise<void>`: exit 3 sem `yes` ("apaga o token; só voltando a fazer `sb login`"); exit 3 se anexada a algum mux (lista os muxes); senão remove `accounts.<conta>` da config e apaga `tokens/<conta>.json`.
    - Comandos: `sb attach <conta> <mux> [--pool] [--at N] [--preferred] [--json]`, `sb detach <conta> <mux> [--json]`, `sb accounts rm <conta> --yes`.

- [ ] **Step 1: Testes que falham**

```ts
test('add cria config, define default e aponta o link', ...)          // currentAccount(p,'bk') == 'gabriel'; cfg.default == 'bk'
test('add com conta sem token → exit 3', ...)
test('add com pool fora de accounts → exit 2 e config intacta', ...)
test('set --pool muda a ordem e preserva comentários', ...)
test('rm do default é recusado; rm de outro mantém o link', ...)
test('resolveMuxForDir: root mais profundo vence; fora de todos → default', () => {
  // roots ~/p e ~/p/berzerk; dir ~/p/berzerk/club → 'berzerk'; dir /tmp → cfg.default
})
test('`sb which` dentro de bk imprime o caminho do link', ...)
// test/accounts.test.ts
test('attach --pool acrescenta a accounts e ao fim do pool; --at 1 põe na frente; repetir é idempotente (changed [])', ...)
test('attach --preferred muda mux.account e não troca o link atual', ...)
test('attach de conta sem token ou fora do registro → exit 3 com a dica do login; mux inexistente → exit 3', ...)
test('attach keychain --pool → exit 3 (config inválida não é gravada)', ...)
test('detach tira de accounts e pool; recusa preferida, conta atual e conta não anexada (exit 3)', ...)
test('accounts rm sem --yes → exit 3; anexada → exit 3 listando os muxes; ok remove registro e token', ...)
test('uma conta registrada sem mux é válida na config (accounts sem nenhum mux que a cite)', ...)
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/mux.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: sb mux e sb which"`

### Task 13: Login sem keychain (F9)

**Files:**
- Create: `src/core/login.ts`, `src/commands/login.ts`, `test/login.test.ts`
- Modify: `src/commands/attach.ts` (conta não cadastrada → login + attach)

**Interfaces:**
- Consumes: `cleanEnv`, `claudeBin` (5); `probeToken` (8); `saveToken`, `withLock` (7); `editConfig`, `ensureConfig` (6); `attachAccount`, `AttachSpec` (12).
- Produces:
  - `extractTokens(raw: string): string[]` (porta de `limpar_ansi` + `extrair_tokens_texto` do `claude-conta`, linhas 350–376: tira OSC/cores, cursor vira quebra, junta o token que encostou no fim da linha com as linhas seguintes só de `[A-Za-z0-9_-]`; devolve até 3 candidatos, o juntado primeiro).
  - `runSetupToken(ctx, onUrl: (url: string) => void, limitMs = 900_000): Promise<string[]>`: `CLAUDE_CONFIG_DIR` temporário com `.claude.json` `{"hasCompletedOnboarding":true,"theme":"dark"}`, comando PTY das Global Constraints, `env = cleanEnv + { CLAUDE_CONFIG_DIR, TERM: 'xterm-256color' }`; acha a URL com `/https:\/\/\S+\/oauth\/authorize\?\S+/`; para 2 s depois de ver o token; Enter (`\r`) até 3 vezes se nenhuma URL aparecer (8 s + 6 s por tentativa); apaga o diretório temporário no `finally`. **O buffer bruto nunca vai para log.**
  - `login(ctx, account, o: { terminal: boolean; readPasted?: () => Promise<string>; attach?: AttachSpec }): Promise<{ account: string; created: boolean; attached?: string[] }>`: valida o nome; candidatos do PTY (ou colado, que tem de casar `/^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/`); o 1º candidato com sonda `ok` é salvo (600); registra `accounts.<conta>` se novo; **se `o.attach`, depois de salvar e registrar chama `attachAccount`** (atalho login + attach do usuário; o mux é validado ANTES de abrir o navegador — mux inexistente → exit 3 sem login; se o attach falhar depois do login, o token e o registro ficam, exit 3 e a mensagem manda rodar `sb attach`); `login.log` só com marcos (`abrindo`, `url`, `validando`, `attach`, `FIM ok|falhou`).
  - `sb login <conta> [--terminal] [--attach <mux> [--pool] [--at N] [--preferred]]` e, equivalente, `sb attach <conta> <mux> …` quando a conta ainda não existe (faz o login com as mesmas regras e anexa): abre a URL com `open` se o `setup-token` não abrir; sem TTY no stdout, roda desanexado (`sb login <conta> --foreground` com `detached: true`, saída em `login.log`), espera até 25 s pela URL, imprime-a e sai; o fim chega por notificação.

- [ ] **Step 1: Testes que falham**

```ts
test('extractTokens: ANSI, OSC e token quebrado na largura', () => {
  const raw = '\x1b]0;t\x07\x1b[32mToken:\x1b[0m\r\nsk-ant-oat01-' + 'a'.repeat(30) + '\r\n' + 'b'.repeat(20) + '\r\n\x1b[2K'
  expect(extractTokens(raw)[0]).toBe('sk-ant-oat01-' + 'a'.repeat(30) + 'b'.repeat(20))
})
test('login com claude falso: URL, token validado, salvo 600, conta registrada', async () => {
  // setup-token.txt = URL + FAKE_TOKEN; fakeApi responde 200 com cabeçalhos
  // tokens/gabriel.json modo 600; cfg.accounts.gabriel existe; calls() mostra CLAUDE_CONFIG_DIR temporário e hasOauthEnv false
})
test('sonda 401 → exit 1, nada salvo, config intacta', ...)
test('--terminal com token colado inválido → recusa sem gravar', ...)
test('nome inválido ou "keychain" → exit 3', ...)
test('login --attach bk --pool: conta registrada, token 600 e mux.bk.accounts/pool com a conta no fim', ...)
test('login --attach com mux inexistente → exit 3 ANTES de qualquer chamada ao claude falso', ...)
test('sonda 401 com --attach → nada registrado nem anexado', ...)
test('attach falha depois do login (ex.: --pool de keychain não, pool inválido) → token e registro ficam, exit 3, mensagem cita `sb attach`', ...)
test('`sb attach nova bk` com conta inexistente faz login e anexa; com conta existente só anexa (claude falso não chamado)', ...)
test('login.log e stdout sem token', ...)
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/login.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS. Acrescentar `['login','x','--terminal']` com entrada vazia aos casos de higiene.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: sb login por setup-token num PTY (sem keychain)"`
- [ ] **Step 6: Checkpoint manual do usuário** (não rodar sozinho): pedir que ele rode `bun src/cli.ts login teste` com `SWITCHBOARD_STATE_DIR=/tmp/sb-teste SWITCHBOARD_CONFIG=/tmp/sb-teste/config.jsonc` e autorize no navegador; esperado: "conta teste salva", arquivo 600 em `/tmp/sb-teste/tokens/`. Depois ele apaga `/tmp/sb-teste`.

---

## Marco 2 — Sessões e troca (depois do Gate G1)

### Task 14: Adaptador do `claude` — agents, state.json, stop, reescrita de flags

**Files:**
- Modify: `src/core/claude.ts`, `test/fake-claude.ts` (`agents --json --all` imprime `agents.json`; `stop <id>` tira `pid`/`status` e põe `state: 'stopped'`, falha se existir `stop-fail`), `test/helpers.ts` (`sb.addJob({ agent, state })` grava `agents.json` e `jobs/<id>/state.json`)
- Create: `src/core/jobs.ts`, `test/claude-adapter.test.ts`

**Interfaces:**
- Consumes: `Ctx`, `cleanEnv`, `claudeBin` (5); `writeAtomic`, `backupDir` (5, 7); fixtures (Task 4).
- Produces:
  - `interface AgentEntry { id; cwd; kind; startedAt: number; sessionId; name; state; pid?: number; status?: string }` (zod `looseObject`; `pid`/`status` opcionais).
  - `interface JobState { respawnFlags: string[]; inFlight?: { tasks: number; queued: number; kinds: string[]; drainableMonitors: number }; state?: string; needs?: string; detail?: string; cwd?: string }` (`looseObject`).
  - `listAgents(ctx): AgentEntry[]` (`claude agents --json --all`, cwd = HOME, `cleanEnv`; formato inesperado → `SbError` exit 4), `stopSession(ctx, id, timeoutMs = 45_000): boolean` (`claude stop` e espera sumir o `pid` em `listAgents`).
  - `readJobState(paths, id): JobState | null`, `writeJobFlags(paths, id, transform: (flags: string[]) => string[], backup: string): boolean` (copia `state.json` para `backup`, **relê imediatamente antes** de gravar, grava atômico 644, confere relendo).
  - `settingsValues(flags): string[]` (formas `--settings X` e `--settings=X`).
  - `type Ownership = { kind: 'mux'; mux: string } | { kind: 'pin'; account: string } | { kind: 'legacy' } | { kind: 'foreign'; path: string } | { kind: 'none' }`; `ownershipOf(flags, paths): Ownership` — normaliza cada valor (`~` → HOME, `path.resolve`) e compara `realpath(dirname(v))` com `realpath` de `<state>/mux`, `<state>/pins`, `~/.claude/contas`, `~/.claude/contas-fixas`; **não** segue o link final. Se há mais de um nosso, vale o último.
  - `replaceSettings(flags, newPath, paths): string[]` — remove os `--settings` nossos (mux, pin, legacy), mantém todo o resto na ordem (inclusive `--settings` de terceiros) e acrescenta `--settings newPath`.

- [ ] **Step 1: Testes que falham**

```ts
test('contrato: fixtures reais parseiam (pid/status opcionais)', ...)       // listAgents com agents.json da Task 4
test('formato inesperado → exit 4', ...)                                     // agents.json = '{"x":1}'
test('ownership pelo caminho do link, não pelo alvo', () => {
  pointMux(p, 'bk', 'gabriel')   // mux/bk.json → tokens/gabriel.json
  expect(ownershipOf(['--settings', muxLink(p, 'bk')], p)).toEqual({ kind: 'mux', mux: 'bk' })
  expect(ownershipOf([`--settings=${pinLink(p, 'admin1')}`], p)).toEqual({ kind: 'pin', account: 'admin1' })
  expect(ownershipOf(['--settings', '~/.claude/contas/ativa.json'], p)).toEqual({ kind: 'legacy' })
  expect(ownershipOf(['--settings', '/tmp/outro.json'], p)).toEqual({ kind: 'foreign', path: '/tmp/outro.json' })
  expect(ownershipOf(['--model', 'opus'], p)).toEqual({ kind: 'none' })
})
test('replaceSettings preserva ordem, --allowed-tools repetido e settings de terceiros', ...)
test('stopSession chama `claude stop <id>` sem token no ambiente e espera o pid sumir', ...)
test('stop que falha → false', ...)
test('writeJobFlags relê antes de gravar e faz backup', ...)                // altera state.json entre leitura e escrita: o campo novo sobrevive
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/claude-adapter.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: adaptador do claude (agents, state.json, stop, flags)"`

### Task 15: Sessões — pertença e atividade (regras do Gate G1)

**Files:**
- Create: `src/core/sessions.ts`, `test/sessions.test.ts`

**Interfaces:**
- Consumes: `listAgents`, `readJobState`, `ownershipOf` (14); `Ctx`; as regras de `RESULTADOS.md` (Task 4).
- Produces:
  - `interface Session { agent: AgentEntry; job: JobState | null; owner: Ownership; live: boolean /* tem pid */ }`
  - `loadSessions(ctx): Session[]` (só `kind == 'background'`).
  - `type Activity = 'stopped' | 'scheduled' | 'limit-blocked' | 'busy' | 'free'`; `hasScheduledWork(job: JobState | null, agent: AgentEntry): boolean`, `isLimitBlocked(s: Session): boolean`, `activityOf(s: Session, callerJobId?: string): Activity`.
  - `callerJobId(env): string | undefined` (basename de `CLAUDE_JOB_DIR`).
  - `startedAt(s: Session): number` = `s.agent.startedAt` (ms; o instante em que o host foi (re)aberto — F14 do design; só vale para sessão viva; **não** é o início do processo, não chamar `ps`).

Regras medidas no G1 (design §3 F12–F14 e `spikes/sessoes/RESULTADOS.md`; provisórias, n pequeno), **substituem** a regra conservadora antiga ("qualquer `kinds`/`drainableMonitors` = agendado") — `kinds` só com `local_bash`/`local_agent` é trabalho DENTRO do turno e a sessão é `busy`, não `scheduled`:
```
hasScheduledWork = agent.pid ≠ null ∧ job.inFlight ≠ null ∧ (kinds ∋ 'session_cron' ∨ kinds ∋ 'monitor' ∨ inFlight.wake ≠ null)
isLimitBlocked   = live ∧ job.state == 'blocked' ∧ job.needs ^'rate limited' ∧ inFlight.tasks == 0 ∧ agent.status ≠ 'busy'   (queued pode ser 1)
```
Precedência de `activityOf`:
```
!live (sem pid)                                         → 'stopped'  (vale mesmo com job blocked/limite; estado do job é obsoleto sem pid)
s.agent.id == callerJobId                               → 'busy'     (nunca parar quem chamou)
live ∧ job == null (state.json ausente, ilegível ou com formato inesperado) → 'busy'  (ruling do controlador após a revisão da Task 15: NUNCA parar o que não conseguimos ler — um schema que mude numa atualização do Claude esconderia cron/monitor; o aviso vai para o log)
hasScheduledWork                                        → 'scheduled'
isLimitBlocked                                          → 'limit-blocked'
status == 'busy' || tasks > 0 || queued > 0             → 'busy'
senão                                                   → 'free'
```
Parser tolerante (F12–F14): `job.state` ∈ {running, stopped, done, working, blocked, …}; `inFlight`, `drainableMonitors`, `selfWake`, `wake`, `fan` podem faltar; `inFlight`/`selfWake`/`fan` obsoletos em sessão sem pid. Risco aceito e documentado (design §4): um cron one-shot pendente que ficou invisível depois de respawn (`kinds []`) não é detectado.

- [ ] **Step 1: Testes que falham** (um por fixture da Task 4, mais os casos sintéticos)

```ts
test.each(/* linhas da tabela de test/fixtures/claude/README.md: fixture → Activity esperada */)('fixture %s → %s', ...)
// esperados, por regra: stopped e stale-sem-pid → 'stopped' (inclusive a limit-blocked parada); live-idle → 'free';
// live-busy (kinds local_*) → 'busy' e hasScheduledWork false; limit-blocked viva ociosa → 'limit-blocked';
// limit-blocked viva com tasks 4 → 'busy'; scheduled-loop/-wakeup/-monitor/-cron → 'scheduled'; job.state 'running' sem drainableMonitors → não quebra o parser
test('limit-blocked com queued 1 não é busy', ...)
test('sessão que chamou é busy mesmo livre', ...)
test('kinds só com local_bash/local_agent → busy, NÃO scheduled (muda a regra conservadora antiga)', ...)
test('pertença: mux, pin, legacy, foreign, none', ...)
test('startedAt(s) devolve agent.startedAt em ms', ...)
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/sessions.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: sessões (pertença pelo settings, atividade, sessão que chamou)"`

### Task 16: `sb agents` e `sb run` (com checagem F6 antes de abrir)

**Files:**
- Create: `src/commands/agents.ts`, `src/commands/run.ts`, `src/core/launch.ts`, `test/launch.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `resolveMuxForDir` (12); `checkSettingsTarget`, `muxLink` (7); `cleanEnv`, `claudeBin` (5).
- Produces:
  - `launchArgs(cfg, paths, o: { mux?: string; cwd: string; mode: 'agents' } | { mux?: string; cwd: string; mode: 'run'; args: string[] }): { mux: string; argv: string[] }` — `agents`: `['agents', '--cwd', <root expandido>, '--settings', muxLink]`; `run`: `[...args, '--settings', muxLink]`; recusa `args` que já tragam `--settings` (exit 3).
  - `preflight(paths, mux)`: `checkSettingsTarget(muxLink)` não ok → `SbError` exit 1 com o problema e "rode `sb doctor --fix`".
  - Os comandos fazem `spawnSync(claudeBin, argv, { stdio: 'inherit', env: cleanEnv(process.env) })` e saem com o mesmo código.

- [ ] **Step 1: Testes que falham** (subprocesso, claude falso; `CLAUDE_CODE_OAUTH_TOKEN=xyz` no ambiente do `sb`)

```ts
test('`sb agents bk` abre a view com --cwd e --settings do mux, sem token herdado', () => {
  const r = sb.runSb(['agents', 'bk'], { env: { CLAUDE_CODE_OAUTH_TOKEN: 'xyz' } })
  expect(r.code).toBe(0)
  expect(sb.calls().at(-1)).toMatchObject({ argv: ['agents', '--cwd', ROOT_BK, '--settings', muxLink(sb.paths, 'bk')], hasOauthEnv: false })
})
test('`sb agents` sem nome deduz pela pasta (root mais profundo; fora → default)', ...)
test.each(['broken', 'invalid-json', 'no-oauth'])('link %s → exit 1 e o claude não é chamado', ...)
test('`sb run bk -- -p oi` acrescenta --settings; com --settings próprio → exit 3', ...)
test('mux inexistente → exit 3', ...)
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/launch.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: sb agents e sb run com checagem F6"`

### Task 17: Troca — `applySwap`, reinício de sessões antigas, `sb swap`

**Files:**
- Create: `src/core/swap.ts`, `src/commands/swap.ts`, `test/swap.test.ts`
- Modify: `src/cli.ts`, `src/report.ts` (`renderSwap`), `test/hygiene.test.ts` (`['swap','bk','admin1','--json']`)

**Interfaces:**
- Nota do review da Task 15: quem faz polling (Tasks 17/19) usa `loadSessionsWithWarnings` (devolve `{ sessions, warnings }`) e DEDUPLICA os avisos (por id+motivo), senão `loadSessions` repete a linha em `watch.log` a cada ciclo.
- Notas do review da Task 14: `writeJobFlags` NÃO tem guarda de sessão viva (o chamador garante) — antes de reescrever flags, o chamador confirma com `listAgents` que a entrada NÃO tem `pid` (logo após `stopSession`; `stopSession` devolve `false` quando `claude stop` falha, inclusive em sessão já parada: checar o `pid` ANTES de chamá-la); `stopSession` bloqueia o laço de eventos (`Atomics.wait`, igual ao `ctx.run` síncrono): tratar a parada como passo bloqueante e não concorrer com handlers de SIGTERM que precisem disparar rápido; o backup usa `backupDir(stamp)` (não sobrescreve backups anteriores).
- Consumes: `desiredAccount`, `availability` (10); `readUsage` (9); `pointMux`, `currentAccount`, `readRuntime`, `writeRuntime`, `withLock` (7); `loadSessions`, `activityOf`, `startedAt`, `callerJobId` (15); `stopSession` (14).
- Produces:
  - `interface SwapOutcome { mux: string; from: string; to: string; stopped: string[]; waitingBusy: string[]; keptScheduled: string[]; failed: Array<{ id: string; error: string }> }`
  - `applySwap(ctx, cfg, p: { mux: string; to: string; reason: string }): SwapOutcome` — exige o lock já tomado pelo chamador; `pointMux`; `runtime.mux[mux] = { since: now, lastSwap }`; depois `restartStale`; notifica e registra em `watch.log`.
  - `restartStale(ctx, cfg, mux): Omit<SwapOutcome, 'from' | 'to'>` — para cada sessão `live` com `owner = mux` e `startedAt < runtime.mux[mux].since`: `free`/`limit-blocked` → `stopSession`; `busy` → `waitingBusy`; `scheduled` → `keptScheduled` e, se a conta de origem está `exhausted`, notifica uma vez (`runtime.notified['sched:<id>:<from>']`). Pins, estranhas e outros muxes: intocadas.
  - `manualSwap(ctx, cfg, mux, account?: string, o?: { clear?: boolean }): SwapOutcome | { noop: true }` — conta ∉ `accounts` do mux → exit 3; sem conta: a desejada com a preferida tratada como esgotada (nenhuma → exit 1); pool vazio exige a conta por extenso (exit 3 sem ela); grava `overrides[mux] = { account, until }` (`until` = `fiveHour.resetsAt*1000` da preferida se `ok` e futuro, senão `now + 5 h`); trocar para a própria preferida apaga o override; `--clear` apaga o override e aplica a desejada pela regra.
  - `sb swap <mux> [conta] [--clear] [--json]`.

- [ ] **Step 1: Testes que falham** (sandbox com config do §5, sessões do claude falso com `startedAt` antes/depois do swap)

```ts
test('swap reponta o link e para só as livres e limit-blocked anteriores ao swap', () => {
  // jobs: a(bk, free, antiga) b(bk, limit-blocked, antiga) c(bk, busy, antiga) d(bk, scheduled, antiga)
  //       e(bk, free, nova) f(pin admin1, free) g(pessoal, free)
  const o = await withLock(p, async () => applySwap(ctx, cfg, { mux: 'bk', to: 'admin1', reason: 'teste' }))
  expect(currentAccount(p, 'bk')).toBe('admin1')
  expect(o).toMatchObject({ stopped: ['a', 'b'], waitingBusy: ['c'], keptScheduled: ['d'] })
  expect(sb.calls().filter((c) => c.argv[0] === 'stop').map((c) => c.argv[1])).toEqual(['a', 'b'])
})
test('sessão que chamou (CLAUDE_JOB_DIR) não é parada', ...)                 // vai para waitingBusy
test('agendada numa conta esgotada → uma notificação só', ...)
test('`sb swap bk pessoal-only` fora de accounts → exit 3', ...)
test('`sb swap bk admin1` grava override até o reset da preferida', ...)     // runtime.overrides.bk.until == reset5h*1000
test('`sb swap berzerk` sem conta → exit 3; `sb swap berzerk keychain` é aceito', ...)
test('`sb swap bk --clear` apaga o override e volta à preferida disponível', ...)
test('swap para a conta atual → noop', ...)
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/swap.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: troca por mux (link, sessões livres, override manual)"`

### Task 18: `sb pin` / `sb unpin` e a fila `pending`

**Files:**
- Create: `src/core/pin.ts`, `src/commands/pin.ts`, `src/commands/unpin.ts`, `test/pin.test.ts`
- Modify: `src/cli.ts`, `src/core/panel.ts` (`pins` a partir das sessões com `owner.kind == 'pin'`; linha `sessões fixas: 95b0deff → admin1`), `test/hygiene.test.ts`

**Interfaces:**
- Notas do review da Task 14: `writeJobFlags` NÃO tem guarda de sessão viva (o chamador garante) — antes de reescrever flags, o chamador confirma com `listAgents` que a entrada NÃO tem `pid` (logo após `stopSession`; `stopSession` devolve `false` quando `claude stop` falha, inclusive em sessão já parada: checar o `pid` ANTES de chamá-la); `stopSession` bloqueia o laço de eventos (`Atomics.wait`, igual ao `ctx.run` síncrono): tratar a parada como passo bloqueante e não concorrer com handlers de SIGTERM que precisem disparar rápido; o backup usa `backupDir(stamp)` (não sobrescreve backups anteriores).
- Consumes: `ensurePin`, `muxLink`, `readRuntime`, `writeRuntime`, `withLock` (7); `loadSessions`, `activityOf`, `callerJobId` (15); `stopSession`, `writeJobFlags`, `replaceSettings` (14); `resolveMuxForDir` (12).
- Produces:
  - `findSession(sessions, prefix): Session` (nenhuma/ambígua → exit 3 listando os ids).
  - `muxOfSession(cfg, s): string` (`owner.mux` se for de mux; senão pelo `cwd`).
  - `type PinOutcome = { jobId: string; settings: string; result: 'rewritten' | 'stopped-and-rewritten' | 'queued' }`
  - `pinSession(ctx, cfg, prefix, account: string | null): PinOutcome` — `null` = soltar (volta para `muxLink(muxOfSession)`); conta ∉ `accounts` do mux da sessão → exit 3; só `kind == 'background'`; `stopped` → reescreve já; `free`/`limit-blocked` e não é a que chamou → para e reescreve; senão entra em `runtime.pending` (`reason: 'pin'|'unpin'`) e avisa se o `watch` não está rodando.
  - `applyPending(ctx, cfg): Array<PinOutcome | { jobId: string; result: 'gone' }>` — usado pelo `watch` (Task 19): mesma lógica para cada item; sessão sumida sai da fila com registro no log.

- [ ] **Step 1: Testes que falham**

```ts
test('parada → flags reescritos já, resto preservado, backup feito', ...)    // --settings <state>/pins/admin1.json no fim
test('viva e livre → stop + reescrita', ...)
test('ocupada → fila pending; applyPending reescreve quando ficar livre', ...)
test('a que chamou → fila', ...)
test('conta fora de accounts do mux → exit 3', ...)
test('prefixo ambíguo ou inexistente → exit 3; interativa → exit 3', ...)
test('unpin volta para o link do mux da pasta', ...)
test('painel mostra a linha de sessões fixas', ...)
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/pin.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: sb pin/unpin com fila aplicada pelo watch"`

### Task 19: `sb watch` — o laço

**Files:**
- Create: `src/core/watch.ts`, `src/commands/watch.ts`, `test/watch.test.ts`
- Modify: `src/cli.ts`, `test/hygiene.test.ts` (`['watch','--once','--json']`)

**Interfaces:**
- Nota do review da Task 15: quem faz polling (Tasks 17/19) usa `loadSessionsWithWarnings` (devolve `{ sessions, warnings }`) e DEDUPLICA os avisos (por id+motivo), senão `loadSessions` repete a linha em `watch.log` a cada ciclo.
- Consumes: `measureAll`, `readUsage` (9); `desiredAccount` (10); `applySwap`, `restartStale` (17); `applyPending` (18); `loadSessions`, `isLimitBlocked` (15); `withLock`, runtime (7); `parseDuration` (6).
- Produces:
  - `interface TickReport { skipped?: 'locked'; measured: boolean; evaluations: MuxEval[]; swaps: SwapOutcome[]; restarts: Record<string, ReturnType<typeof restartStale>>; pending: ReturnType<typeof applyPending>; notices: string[] }`
  - `tick(ctx, cfg): Promise<TickReport>` — tenta o lock com `waitMs: 0` (ocupado → `{ skipped: 'locked' }`); mede se a medição mais nova tem mais que `probeEvery`; apaga overrides vencidos; para cada mux: link ausente → `pointMux` para a preferida e registra; `desiredAccount` com `current = currentAccount(...)`; se `desired ≠ current`: **cooldown** (ideia do claude-swap, `cswap auto`: 5 min entre trocas) — o mux não troca sozinho duas vezes em menos de 5 min (`runtime.mux[mux].lastSwap.at`), salvo se a conta atual está `exhausted`; `auto` → `applySwap` (motivo legível, ex. `gabriel em 92% de 5h`), senão notifica uma vez por `(mux, desired)`; `warn` notifica uma vez; `restartStale` em todo mux; `applyPending`; grava em `watch.log` um snapshot (campos do `observa.py`, sem token) da 1ª vez que cada sessão viva fica `limit-blocked` (responde a pergunta aberta do F12).
  - Notas do review da Task 7 (watch é o único processo longo): o `watch` (a) trata exit 5 de `withLock` persistente — lock cujo dono é um pid vivo que não é o `watch` — notificando uma vez e seguindo no próximo ciclo; (b) se `readRuntime` falhar por JSON corrompido (queda de energia sem fsync), move o arquivo para `runtime.json.corrupt-<ts>`, notifica e começa vazio — nunca trava em loop.
  - `watchLoop(ctx, intervalMs = 30_000)`: `tick` a cada 30 s, grava `<state>/watch.json` `{ pid, lastTick }`, sai limpo em SIGTERM/SIGINT; recarrega a config a cada tick (config inválida → registra e espera, não troca nada).
  - `sb watch [--once] [--json]`.

- [ ] **Step 1: Testes que falham** (fakeApi controla as utilizações; `ctx.now` controlado)

```ts
test('preferida a 92% → troca para a 2ª do pool, para as livres, notifica', ...)
test('auto false → não troca; notifica uma vez em dois ticks', ...)
test('reset da preferida passou → volta para ela', ...)
test('medição recente (< probeEvery) → nenhuma chamada à API', ...)
test('override vencido é apagado', ...)
test('pending aplicado quando a sessão fica livre', ...)
test('limit-blocked viva → um snapshot no watch.log, sem token', ...)
test('lock ocupado por pid vivo → skipped', ...)
test('config inválida → nenhum swap, erro no log', ...)
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/watch.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: sb watch (mede, avalia, troca, aplica a fila)"`

---

## Marco 3 — Integração e migração

### Task 20: `sb install` — LaunchAgent, wrapper zsh, `/sb`

**Files:**
- Create: `src/core/install.ts`, `src/commands/install.ts`, `test/install.test.ts`

**Interfaces:**
- Consumes: `Paths`, `Ctx` (5); `writeAtomic` (7).
- Produces:
  - `planInstall(paths, o: { runtimeBin: string; cliPath: string; claudeDir: string /* dirname do claude no PATH */ }): Array<{ file: string; content: string; mode: number }>` com:
    - `~/Library/LaunchAgents/com.gabriellst.switchboard.watch.plist`: `Label`, `ProgramArguments [runtimeBin, cliPath, 'watch']`, `RunAtLoad` e `KeepAlive` `true`, `StandardOutPath`/`StandardErrorPath` em `<state>/log/watch.out`, `EnvironmentVariables` só com `PATH` (inclui `claudeDir`) e `HOME`.
    - `<state>/wrapper.zsh`: função `claude()` — com `CLAUDECODE` → `command claude "$@"`; primeiro argumento em `auth|attach|logs|stop|kill|rm|respawn|mcp|plugin|plugins|doctor|update|upgrade|install|setup-token|daemon|purge|import|gateway|ultrareview|auto-mode|help` ou qualquer `--settings`/`--settings=` → `( unset CLAUDE_CODE_OAUTH_TOKEN; command claude "$@" )`; senão `s=$("<runtimeBin>" "<cliPath>" which "${cwd:-$PWD}")` (caminhos absolutos gravados na geração, para não depender de `sb` no PATH; respeita `--cwd X`/`--cwd=X`), **se falhar imprime o erro e `return 1`**, senão `( unset CLAUDE_CODE_OAUTH_TOKEN; command claude "$@" --settings "$s" )`.
    - `~/.claude/commands/sb.md`: frontmatter `description`, `argument-hint`, `allowed-tools: Bash(sb:*)`, `disable-model-invocation: true`; corpo `` !`sb $ARGUMENTS 2>&1` `` e a instrução de repetir em poucas linhas em português.
  - `runInstall(ctx, plan, o: { simular: boolean })`: grava; `launchctl bootout` (ignora erro) + `launchctl bootstrap gui/<uid> <plist>` via `ctx.run`; no `~/.zshrc`: se existe linha com `# claude-conta`, **não mexe** e diz "rode `sb migrate`"; senão acrescenta uma vez `[ -f <state>/wrapper.zsh ] && source <state>/wrapper.zsh  # switchboard`.
  - `sb install [--simular] [--json]`.

- [ ] **Step 1: Testes que falham** (HOME do sandbox; `ctx.run` falso registra `launchctl`)

```ts
test('plist: label, ProgramArguments, KeepAlive, sem token', ...)
test('zshrc com claude-conta não é alterado; sem ele, linha acrescentada uma vez (idempotente)', ...)
test('launchctl bootstrap registrado com gui/<uid>', ...)
test('--simular não grava nada', ...)
// comportamento do wrapper: zsh -c 'source wrapper.zsh; cd <dir>; claude …' com PATH = [fake claude, shim sb → bun src/cli.ts]
test('wrapper: fora de sessão acrescenta --settings do mux da pasta e tira o token herdado', ...)
test('wrapper: --settings explícito, subcomando de manutenção e CLAUDECODE passam direto', ...)
test('wrapper: `sb which` falhando → exit 1 e o claude não é chamado', ...)
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/install.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: sb install (LaunchAgent, wrapper fail-closed, /sb)"`

### Task 21: `sb doctor [--fix]`

**Files:**
- Create: `src/core/findings.ts`, `src/core/doctor.ts`, `src/commands/doctor.ts`, `test/doctor.test.ts`
- Modify: `src/report.ts` (`renderFindings` no molde do plugboard), `test/hygiene.test.ts`

**Interfaces:**
- Consumes: quase tudo: `loadConfig` (6); `checkSettingsTarget`, `hasToken` (7); `readUsage` (9); `loadSessions`, `ownershipOf` (14, 15); `resolveMuxForDir` (12); `readRuntime` (7).
- Produces:
  - `interface Finding { severity: 'error' | 'warn'; code: FindingCode; subject: string; message: string }` (`code` é API do `--json`).
  - Códigos de erro: `config.invalid`, `config.no-token` (conta em `accounts`/`pool` sem `tokens/<c>.json`), `link.broken` (mux/pin quebrado ou alvo inválido — F6), `token.invalid-json`, `token.no-oauth`, `token.dead` (última medição 401/403), `token.perms` (≠ 600), `session.no-settings` (sessão em segundo plano sob o root de um mux cuja conta não é `keychain`, sem `--settings`), `view.no-settings` (processo `claude agents` sem `--settings` de `<state>/mux/`, lido de `ps -axo pid=,command=` via `ctx.run`).
  - Códigos de aviso: `state.perms` (dir ≠ 700), `pool.duplicates`, `pool.preferred-outside`, `account.unattached` (conta registrada sem nenhum mux), `link.orphan` (link de mux que saiu da config), `session.legacy`, `session.foreign`, `view.legacy`, `watch.stopped` (`watch.json` ausente, pid morto ou `lastTick` > 90 s), `claude.format` (adaptador recusou o formato).
  - `diagnose(ctx): Promise<Finding[]>`; `fix(ctx, findings)`: recria links (mux → `currentAccount` ou a preferida; pin → `tokens/<c>.json`), `chmod 600/700`, adota `session.no-settings` (parada → `writeJobFlags` com `replaceSettings(…, muxLink)`; viva → `runtime.pending` com `reason: 'adopt'`).
  - `sb doctor [--fix] [--json]`; exit 1 se sobrar erro, 2 se a config é inválida.

- [ ] **Step 1: Testes que falham** — um teste por código acima, montando o caso no sandbox e conferindo `code` e `severity`; mais:

```ts
test('tudo em ordem → exit 0 e "tudo em ordem"', ...)
test('--fix recria link quebrado, corrige 644 → 600 e adota sessão parada sem settings', ...)
test('saída --json sem token mesmo com token.invalid-json', ...)
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/doctor.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: sb doctor (F6, tokens, sessões sem settings, views)"`

### Task 22: `sb migrate [--simular] [--finish]`

**Files:**
- Create: `src/core/migrate.ts`, `src/commands/migrate.ts`, `test/migrate.test.ts`

**Interfaces:**
- Consumes: `saveToken`, `editConfig`, `ensureConfig`, `pointMux`, `ensurePin`, `writeJobFlags`, `replaceSettings`, `loadSessions`, `measureAll`, `planInstall`/`runInstall`, `ctx.run` (`ps`, `kill`).
- Produces:
  - `readLegacyToken(paths, name): string | null` (lê `~/.claude/contas/<name>.json` só no código; nunca entra em plano, saída ou log).
  - `interface MigrationPlan { tokens: Array<{ from: string; account: string }>; likelyDuplicates: string[][]; config: Config; rewrites: Array<{ jobId: string; from: string; to: string; when: 'now' | 'when-free' }>; stopVigia: number | null; zshrc: { remove: string; add: string } | null; command: { remove: string; add: string }; backup: string; reopen: string[] }`
  - `planMigration(ctx): Promise<MigrationPlan>` — tokens de `~/.claude/contas/*.json` exceto `ativa.json` e `padrao.json` (`padrao` = keychain); muxes: um por raiz de `~/.claude/contas/excluir` (`account: 'keychain'`, `accounts: ['keychain']`, `pool: []`, nome = basename) e um por view `claude agents --cwd X` aberta (`ps`; nome = basename de X; `account` = a ativa (`readlink ativa.json`), `accounts` = todas as importadas, `pool` = a ativa primeiro e depois ordem alfabética); `default` = o 1º desses muxes de view em ordem alfabética; `likelyDuplicates` = mesmo token ou mesma impressão numa medição (`measureAll`); `rewrites`: sessões com `--settings` em `~/.claude/contas/ativa.json` → `muxLink(mux pela pasta)`, em `~/.claude/contas-fixas/<c>.json` → `pinLink(c)`; paradas `now`, vivas `when-free`; `stopVigia` = pid de `~/.claude/contas/vigia.pid` se vivo e o comando contém `_vigiar`.
  - `applyMigration(ctx, plan)`: sob lock; copia `~/.claude/contas`, `~/.claude/contas-fixas` e `~/.claude/commands/conta.md` para `plan.backup`; grava tokens/config/links; reescreve as paradas; vivas → `runtime.pending` (`reason: 'migrate'`); `kill` no vigia; troca a linha `# claude-conta` do `~/.zshrc` pela do `sb` (backup do `.zshrc` antes); move `conta.md` para o backup e grava `sb.md`; **só depois** chama `runInstall` (com a linha `# switchboard` já presente ele não acrescenta outra; antes da troca ele se recusaria a mexer no `.zshrc`); imprime `plan.reopen` (`sb agents <mux>` por aba).
  - `finishMigration(ctx)`: recusa (exit 1, lista os ids) enquanto alguma sessão tiver `owner.kind == 'legacy'`; senão move `~/.claude/contas` e `~/.claude/contas-fixas` para o backup.
  - `sb migrate [--simular] [--finish] [--json]` (`--simular` imprime o plano e não grava nada).

- [ ] **Step 1: Testes que falham** (sandbox com o legado falso: `contas/{gabriel,admin1,outra,padrao}.json`, `ativa.json → gabriel.json`, `excluir` com `~/p/berzerk`, `contas-fixas/admin1.json`, jobs parados e vivos, `ps` falso com uma view `claude agents --cwd ~/p/bk` e o vigia, `.zshrc` com a linha do `claude-conta`)

```ts
test('--simular não altera nenhum arquivo (hash de tudo antes = depois)', ...)
test('plano: muxes bk e berzerk como no §10; pool da ativa primeiro', () => {
  expect(plan.config.mux.bk).toEqual({ root: '~/p/bk', account: 'gabriel', accounts: ['admin1', 'gabriel', 'outra'], pool: ['gabriel', 'admin1', 'outra'] })
  expect(plan.config.mux.berzerk).toEqual({ root: '~/p/berzerk', account: 'keychain', accounts: ['keychain'], pool: [] })
})
test('aplicar: tokens 600, paradas reescritas, viva na fila, pin → pins/admin1.json', ...)
test('aplicar: vigia morto, zshrc trocado com backup, conta.md no backup e sb.md gravado', ...)
test('nada do claude-conta é apagado: contas/ continua no lugar e há cópia no backup', ...)
test('--finish recusa com sessão legacy; depois de reescritas, move para o backup', ...)
test('saída e backup de log sem token', ...)
```

- [ ] **Step 2: Rodar e ver falhar** — `bun test test/migrate.test.ts` · FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — `bun test` · PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: sb migrate (simular, aplicar, finish) a partir do claude-conta"`

### Task 23: README, SPEC, build e verificação final

**Files:**
- Create: `README.md`, `SPEC.md`
- Modify: `docs/superpowers/specs/2026-11-03-switchboard-design.md` (Status: implementado; desvios, se houver)

**Interfaces:**
- Consumes: tudo.

- [ ] **Step 1: Escrever `README.md`** (instalação local, começando: `sb login`, `sb mux add`, `sb agents`, painel, troca, pin, watch/install, migração) **e `SPEC.md`** (modelo, regras de troca com o algoritmo da Task 10, F1–F14, estado em disco, comandos, exit codes, códigos do `doctor`), em português, no tom do plugboard.
- [ ] **Step 2: Verificar tudo** — Run: `bun test && bun run check && bun run build && node dist/cli.js --version && node dist/cli.js --help` · Expected: testes PASS, sem erro de tipo, `0.1.0`, ajuda com todos os comandos.
- [ ] **Step 3: Varredura de higiene** — Run: `grep -rnE "sk-ant-oat01-[A-Za-z0-9_-]{20,}" src scripts docs spikes test README.md SPEC.md` · Expected: nenhuma linha (os testes montam o token falso por concatenação).
- [ ] **Step 4: Parar o observador da Task 1** se ainda vivo (`kill $(cat spikes/sessoes/vigia.pid)`) e, depois da varredura de `sk-ant` e de dado sensível, commitar o `limite.jsonl` final com `git add -f spikes/sessoes/limite.jsonl` (ele está no `.gitignore` desde a Task 5).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "docs: README e SPEC do switchboard"`
- [ ] **Step 6: Entregar ao usuário os comandos que só ele roda**, nesta ordem: `ln -s "$PWD/dist/cli.js" ~/.local/bin/sb`; `sb migrate --simular`; `sb migrate`; reabrir cada aba do cmux com `sb agents <mux>`; `sb doctor`; mais tarde `sb migrate --finish`.
