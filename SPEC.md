# switchboard — Spec v0.1

> Contas do Claude Code por pasta, com troca automática ao bater o limite.
> Status: implementado (16 comandos, 920 testes) · 2026-11-10
> O design e as decisões estão em `docs/superpowers/specs/2026-11-03-switchboard-design.md`; os dados
> brutos das sondas de sessão, em `spikes/sessoes/RESULTADOS.md`. Este documento descreve o que o
> **código faz**: onde ele e o design divergem, vale o código (a lista está em "Desvios" no design).

## 1. Tese

O Claude Code usa uma conta por vez, a do keychain, e não troca de token com a sessão rodando (F4).
Quem tem várias assinaturas e dezenas de sessões em segundo plano precisa de três coisas que ele não
dá: uma conta **por projeto**, uma troca **automática** quando a conta acaba, e uma troca **sem
arrastar** as sessões que devem ficar onde estão.

O switchboard liga uma conta a cada mux, abre o `claude` com `--settings <estado>/mux/<mux>.json` (um
link para o token da conta atual), mede o uso por conta e, quando a conta de um mux acaba, aponta o
link para a próxima da fila e para as sessões livres para que reabram na conta nova. Tudo é arquivo
em disco e um laço (`sb watch`); não há servidor, proxy nem toque no keychain.

## 2. Modelo

| Conceito | O que é |
|---|---|
| **Conta** | Um token de assinatura com nome (`^[a-z0-9][a-z0-9_-]{0,31}$`). Só o registro: sem prioridade nem pool próprios (isso é do mux). Token em `tokens/<conta>.json`. |
| **keychain** | Conta reservada: o login do keychain. Settings = `{}`. Nunca registrada, medida, anexada ao pool nem escrita (o arquivo é sempre `{}`). |
| **Mux** | Nome + `root` + `account` (a **preferida**) + `accounts` (as que **pode usar**: limite duro) + `pool` (as de **hot-swap**, em ordem = prioridade). Uma aba do cmux roda `sb agents <mux>`. |
| **Conta atual** | Para onde `mux/<mux>.json` aponta agora. É a preferida, exceto durante uma troca. Estado de runtime, não config. |
| **Sessão do mux** | Sessão `background` cujo `--settings` é `<estado>/mux/<mux>.json`. A pertença é pelo **caminho do settings**, não pela pasta nem pelo alvo do link. |
| **Sessão fixa (pin)** | `--settings` em `<estado>/pins/<conta>.json`. Fica fora de todo swap. |
| **Sessão do legado** | `--settings` em `~/.claude/contas` ou `contas-fixas`. O `sb` não mexe; só a migração adota. |
| **Sessão estranha** | Qualquer outro `--settings`, ou nenhum. O `sb` só reporta (e o `doctor --fix` adota a que não tem). |
| **default** | Mux das pastas que não casam com nenhum `root`. Obrigatório quando há mux; nunca o mux do keychain na migração. |

Invariantes validadas pela config (exit 2): `account ∈ accounts`; `pool ⊆ accounts`; sem repetição em
`accounts` e `pool`; `keychain` fora do registro e fora do pool; toda conta de `accounts`/`pool`
(menos `keychain`) registrada; `root` único (comparado depois de expandir `~`); `default` aponta um mux
existente. `pool` vazio = o mux nunca troca sozinho.

**Pertença da sessão** (`ownershipOf`): olha cada `--settings X` e `--settings=X` dos `respawnFlags`;
`~/…` expande; caminho relativo é de terceiros (não se adivinha); classifica pelo **diretório do
caminho** (o componente final, o link, nunca é seguido): `<estado>/mux` → mux, `<estado>/pins` → pin,
`~/.claude/contas*` → legado, resto → terceiros. Vários `--settings`: o último dos nossos vence, e os
nossos valem mais que os de terceiros. `--settings` com JSON inline nunca entra em saída.

**O mux de uma pasta**: o `root` mais profundo que a contém (realpath nos dois lados), senão o
`default`; sem `default` e fora de todo root, exit 2.

## 3. Fatos medidos (Claude Code 2.1.317, 03/11/2026)

São restrições, não suposições. O texto completo está no design (§3) e nos spikes.

| | Fato |
|---|---|
| F1 | `POST {base}/v1/messages` com `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`, `anthropic-version: 2023-06-01`, modelo `claude-haiku-4-5`, `max_tokens: 1` e o system `You are Claude Code, Anthropic's official CLI for Claude.` devolve o uso nos cabeçalhos `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}`, `-status`, `-reset`, `-representative-claim`, `-overage-status`. `base` = `SWITCHBOARD_API_BASE` ou `https://api.anthropic.com`. |
| F2 | `GET /api/oauth/usage` não serve: exige o escopo `user:profile`, que o token do `setup-token` não tem. |
| F3 | Contas salvas duas vezes existem: devolvem utilização e resets idênticos. |
| F4 | Não há troca de token a quente: nem editar o settings, nem `apiKeyHelper` mudam o token de um processo vivo. Trocar a conta de uma sessão = parar e reabrir (mesmo id, a conversa continua). |
| F5 | `apiKeyHelper` desliga os conectores do claude.ai; por isso o settings usa `env.CLAUDE_CODE_OAUTH_TOKEN`, nunca `apiKeyHelper`. |
| F6 | `--settings` com arquivo ausente ou link quebrado: o `claude` recusa (seguro). **JSON inválido: avisa, ignora e roda no keychain** (perigoso). `{}`: keychain (é assim que se representa). |
| F7 | `claude agents --settings X` repassa o settings às sessões que a view despacha (nascem com `--settings X` nos `respawnFlags`). |
| F8 | `claude agents --json --all` lista `{id, kind, status, state, pid, cwd, name, startedAt, sessionId}`; o estado persistente fica em `~/.claude/jobs/<id>/state.json` (`respawnFlags`, `inFlight`, `state`, `needs`). `claude stop <id>` para; a sessão volta com o mesmo id e os mesmos flags. O daemon reescreve o `state.json` com a sessão viva: só se edita `respawnFlags` com a sessão parada, relendo antes de gravar. |
| F9 | `claude setup-token` com `CLAUDE_CONFIG_DIR` temporário, num pseudo-terminal, imprime o link de autorização e um token de 1 ano, sem tocar o keychain. |
| F10 | Ao chamar o `claude` de dentro do `sb`, remover do ambiente: `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_JOB_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_PID`, `CLAUDE_CODE_AGENT`, `CLAUDE_CONFIG_DIR` (`cleanEnv`). |
| F11 | O `claude-conta` só reescreve `--settings` dentro de `~/.claude/contas/`. Só importa durante a migração. |
| F12 | Turno que falha por limite: `job.state == "blocked"`, `needs` começa com `rate limited — wait and retry`, e **`inFlight.queued == 1` sem trabalho nenhum** (então `queued == 0` não serve como critério de livre). Sessão viva presa: `status` `idle` com `tasks == 0`; `busy` com `tasks > 0`. Não observado: o item `queued` rodar de novo com outro token (pergunta aberta). |
| F13 | Trabalho agendado em `inFlight`: `/loop` e CronCreate = `kinds ["session_cron"]`; ScheduleWakeup = `session_cron` mais `wake`; Monitor = `kinds ["monitor"]`. `drainableMonitors`, `queued`, `selfWake`, `fan` não são marcadores. Depois de `stop` + `respawn`, o loop recorrente e o CronCreate one-shot sobrevivem (o one-shot fica invisível: `kinds []`); ScheduleWakeup e Monitor morrem. Sem `pid` o `state.json` pode mentir. n = 1 por mecanismo. |
| F14 | `claude respawn <id>` mantém id e flags, relê o `--settings`, mas imprime "respawned" mesmo quando a sessão cai logo depois. `claude --bg --resume` com flags sempre criou cópia. `agents.startedAt` = momento em que o host foi (re)aberto; só serve para sessão viva. Reabrir por comando fica fora da v1. |

## 4. Medição de uso

- **Sonda** = F1, uma chamada por **token distinto** (contas com o mesmo token fazem uma só e
  dividem a medição), timeout de 15 s. O corpo da resposta nunca é lido. O token só vai no cabeçalho
  da requisição; nenhum resultado, erro ou log o carrega.
- **Resultado**: `ok` (duas janelas `{utilization 0–1, resetsAt epoch s, status}`, mais `status` e
  `resetsAt` gerais) ou erro: `dead-token` (401/403), `rate-limited` (429 **sem** os cabeçalhos unified; com eles é uma medição normal), `network`, `unexpected`,
  e `no-token` (conta sem token; sem rede). Cabeçalhos incompletos mantêm o sinal HTTP. Uma janela **ausente por inteiro** não é erro: a API omite os `5h-*` (ou os `7d-*`) quando não há janela ativa (visto em 12/11/2026), e ela entra como 0 % sem reset (`resetsAt` 0; o painel mostra "sem janela ativa"). As duas ausentes → `unexpected`. O `usage.json` guarda em
  `rate-limited` o campo `streak`: quantas sondas seguidas dessa conta vieram assim (qualquer outra medição zera).
- **Cache**: `sb usage` reaproveita medições de até 60 s (`sb accounts` nunca mede: só lê o `usage.json`); o `watch` sonda quando a
  medição mais nova passa de `swap.probeEvery`, ou há conta nunca medida. `no-token` não fica preso
  no cache. Medição com idade negativa (relógio voltou) não vale como cache.
- **Medição atrasada custa caro** (a janela de 5 h pode encher em minutos): a sonda da conta em uso que falha (rede,
  resposta estranha) é repetida depois de 30 s, sem esperar o `probeEvery`; e quando uma sessão de mux acaba de ficar
  presa por limite o `watch` mede na hora, para a troca sair no mesmo ciclo.
- **Duplicatas**: duas contas com a mesma impressão (`5h-reset`, `7d-reset`, `5h-utilization`,
  `7d-utilization`) em `latest` **e** em `previous` formam um grupo (`usage.groups`); só vale depois
  de duas medições seguidas, e um erro transitório dissolve o grupo até duas medições `ok`. O
  representante é o primeiro na ordem do registro. Cópias contam uma vez no destino e no total.
- **Total do pool** = média, por janela, dos representantes das contas que estão no `pool` de algum
  mux e têm medição `ok`. Só diz "quanto do total já foi" se os planos forem iguais; o painel avisa.
- `keychain`: "não medido". Erros de sonda aparecem no painel e no `doctor` (`token.dead`).

## 5. Regras de troca

### 5.1 Disponibilidade (`availability`)

Pura (`nowMs` vem de fora). Resultado: `available`, `exhausted` ou `unknown`.

- sem medição → `unknown`; `no-token`, `dead-token` → `exhausted`; `rate-limited` → `unknown` na **1ª** sonda
  seguida (`streak` 1, ou ausente) e `exhausted` a partir da **2ª** (`streak ≥ 2`; o 429 não tem reset
  conhecido: vale até a próxima medição `ok`). Uma conta realmente esgotada responde com os cabeçalhos (caminho
  normal); um 429 sem eles é mais provavelmente espúrio, e tratá-lo como esgotado trocaria o mux de conta e de
  volta (duas rodadas de paradas). `network`, `unexpected` → `unknown` (falha nossa).
- medição `ok`: uma janela **bloqueia** se `utilization ≥ limite − margem` **ou** o `status` dela não
  começa com `allowed` (`allowed_warning` não esgota), e **só até o `resetsAt` dela**. Passado o reset,
  a conta volta a valer mesmo sem medição nova. O `status` geral `rejected` com `resetsAt` futuro
  também esgota. Limites: `swap.threshold.fiveHour` (0,9) e `sevenDay` (0,95).
- **Histerese**: só ao voltar à preferida vindo de uma reserva, a margem é 0,10 (`HYSTERESIS`); em
  todo o resto a margem é 0.

### 5.2 O algoritmo (`desiredAccount`)

Entrada: o mux (`account` = P, `accounts`, `pool` sem repetição), a conta atual C, a medição, `swap`,
o override (com `until` em ms) e o relógio. `stay(c)` = `c ∈ accounts` e `availability(c) ≠ exhausted`.
`unknown` nunca empurra: só `exhausted` (medido, 429, token morto) tira o mux de um lugar válido.

1. **Pool vazio** → C (`no-pool`). O mux nunca troca sozinho.
2. **Override** ativo (`nowMs < until`): a conta dele `available` → ela (`override`); `unknown` e C é
   ela → C (`override`); senão (esgotada, ou `unknown` com C diferente) o override é **anulado** e
   segue a regra normal, com a preferida valendo de novo.
3. **Preferida.** C "é a preferida" se `C == P` ou C é duplicata de P **e** está em `accounts`. C é
   "reserva" se não é a preferida e está em `accounts` (só reserva tem histerese no retorno). `pa` =
   disponibilidade de P (com margem se C é reserva).
   - C é a preferida e `pa ≠ exhausted` → C (`preferred`).
   - C não é a preferida e `pa == available` → se `returnOnReset: false` e `C ∈ pool` e `stay(C)`, C
     (`sticky`); senão P (`preferred`).
   - C não é a preferida e `pa == unknown` → `stay(C)` ? C (`sticky`) : P.
   - `pa == exhausted` → passos seguintes.
4. **Preferida esgotada e fora do pool**, e C é a preferida (ou duplicata em `accounts`) → C
   (`preferred-outside-pool`, com aviso). Se C é **outra** conta, pula para o 5: a preferida fora do
   pool não é destino de troca.
5. **Reserva atual serve**: `C ≠ P`, `C ∈ pool`, C fora do grupo de P e `availability(C) ≠
   exhausted` (`available` ou `unknown`, sem histerese) → C (`pool`). A ordem do pool escolhe destino;
   não faz o mux saltar entre reservas.
   Senão, a **primeira** conta de `pool`, na ordem, fora do grupo de P, sem repetir grupo, **`available`**
   (destino exige `available`) → ela (`pool`).
6. **Preferida sem histerese** `available` → P (`preferred`): nunca ficar numa conta esgotada com a
   preferida utilizável.
7. **Nenhuma disponível** → C (ou P, se C ∉ `accounts`), com aviso (`none-available`).

O retorno no reset sai de graça: quando a preferida volta a estar disponível, ela é a desejada.

### 5.3 Aplicar uma troca (`applySwap`, sob o lock)

1. Valida o destino (mux existe; `to ∈ accounts`; `to` tem token, ou é `keychain`). Link ausente → exit 1.
   `to` igual ao atual → `noop`, nada é tocado.
2. `pointMux`: o link `mux/<mux>.json` passa a apontar para `tokens/<to>.json` num único `rename`.
   Sessões novas já nascem na conta nova.
3. Grava `runtime.mux[mux] = { since, lastSwap: { at, from, to, reason } }` **antes** de qualquer parada.
4. `restartStale`: para as sessões antigas (abaixo).
5. Notifica (`osascript`) e registra no `watch.log`. Os `respawnFlags` não são reescritos: já apontam para o link.

**`restartStale`** só considera sessão **viva** (tem `pid`), do mux, com `startedAt < since`. Atividade
(`activityOf`), por precedência: sem `pid` → `stopped`; é a que chamou (`CLAUDE_JOB_DIR`) → `busy`;
viva sem `state.json` legível → `busy`; `state.json` legível sem `inFlight` → `busy` (falha fechada);
trabalho agendado → `scheduled`; presa por limite (`blocked` com `needs` começando por `rate limited`) → `limit-blocked`, mesmo com `status busy` ou `tasks > 0` (comandos e subagentes de fundo não seguram: o turno não anda até o reset, e eles são encerrados no reinício); `status busy`, `tasks > 0` ou
`queued > 0` → `busy`; senão `free`.

- `hasScheduledWork` = `pid` e `inFlight` e (`kinds` ∋ `session_cron` ou ∋ `monitor` ou `wake` ≠ null).
- `isLimitBlocked` = viva, `job.state == "blocked"`, `needs` começa com `rate limited`, `tasks == 0`,
  `inFlight` presente e `status ≠ busy` (`queued` pode ser 1).
- **Conta de origem esgotada de vez** (uma janela em ≥ 100 % ou `rejected`, reset no futuro, medição de até 15 min):
  quem ficou nela não trabalha mais, então `busy` e `scheduled` também reiniciam (comandos de fundo, monitores e
  agendamentos morrem). Nunca a sessão que chamou nem a de `state.json` ilegível. No limiar de troca (90 %/95 %) a
  conta ainda responde e nada disso vale.
- **`swap.autoResume`** (padrão `false`): a sessão parada por estar presa no limite, ou reiniciada à força, é retomada
  com `claude --bg --resume <sessionId> <pedido de continuar>` (mesmo id, opções salvas, já na conta nova). A que
  estava livre fica parada. Só é retomada a sessão cujo id de conversa é o do próprio job; a que continua a conversa de
  outro job (`resumeSessionId` diferente) fica parada com aviso, porque `--resume` acordaria o job original, sem o
  `--settings` do mux (no keychain).
- `free` e `limit-blocked` → `claude stop` (com a atividade reconferida com dados frescos logo antes;
  só vale se a entrada some de `agents` depois). `busy` → `waitingBusy`. `scheduled` → `keptScheduled`,
  nunca parada; se a conta de origem está esgotada, avisa **uma vez** por sessão.
- Pins, estranhas, legado, outros muxes e sessões reabertas depois da troca: intocados.
- Erro de uma sessão vai para `failed` e as demais seguem. O `claude stop` é bloqueante (até 45 s).
- Com `throttle` (só o `watch`): no máximo 3 paradas por ciclo (`STOPS_PER_TICK`, repartidas entre
  trocas, reinícios e a fila); o excedente vai para `deferred`; uma parada que falha grava
  `notified["stopfail:<id>:<since>"]` e não se repete na mesma troca.

### 5.4 Troca manual (`manualSwap`, `sb swap`)

- `--clear`: apaga o override e aplica a conta que a regra escolhe sem ele (pode ser a atual: `noop`).
- Com conta: valida tudo antes de gravar qualquer coisa. Sem conta: pool vazio → exit 3; senão, a que
  `desiredAccount` escolheria com a preferida e as cópias dela tratadas como esgotadas; nenhuma → exit 1.
- Grava `overrides[mux] = { account, until }` antes de aplicar, com `until` = `fiveHour.resetsAt × 1000`
  da preferida se a medição é `ok` e futura, senão agora + 5 h. Trocar para a preferida, ou num mux sem
  pool, apaga o override em vez de gravar. Conta explícita não exige estar disponível.

### 5.5 O ciclo do `watch` (30 s, sob o lock; espera 250 ms por ele)

0. `runtime.json` corrompido é movido para `runtime.json.corrupt-<ts>` (aviso) e recomeça vazio.
1. Mede, se passou `probeEvery`. 2. Apaga overrides vencidos; varre as sessões (primeira vez que uma
fica presa por limite → um snapshot no log; viva de mux sem `inFlight` → lista "mantidas"; poda de
`notified` com mais de 7 dias ou de sessão que sumiu).
3. Por mux: link ausente → aponta para a preferida (ou erro `semlink`); troca interrompida (o link
já aponta para uma conta diferente de `lastSwap.to`) → grava `since` novo para as antigas serem
reiniciadas; `desiredAccount`; aviso do mux (uma vez por texto). Se `desired ≠ current`: com
`swap.auto: false` só avisa uma vez (`sb swap <mux> <conta>`); com `auto`, respeita o **cooldown de 5
min** entre trocas automáticas do mesmo mux (não vale se a conta atual está esgotada) e aplica.
4. `restartStale` nos muxes que não trocaram agora. 5. `applyPending` (a fila de pins).
Erros de uma etapa avisam na primeira vez e só de novo depois que a etapa se recupera. O laço
escreve o batimento `watch.json` antes e depois de cada ciclo, recarrega a config a cada ciclo
(inválida: registra e não troca nada) e sai limpo em SIGTERM/SIGINT.

### 5.6 Pin, unpin e a fila (`runtime.pending`)

`sb pin <sessão> <conta>` e `sb unpin <sessão>` resolvem o prefixo (4 a 8 hex) entre as sessões
`background`; recusam (exit 3) sessão estranha ou do legado, conta fora de `accounts` do mux da
sessão, sessão que já está no destino, `unpin` de quem não está fixa. O destino (`pins/<conta>.json`
ou `mux/<mux>.json`) passa por `checkSettingsTarget` **antes** de qualquer gravação ou parada.
Sessão parada → reescreve `respawnFlags` na hora (`rewritten`); livre ou presa por limite, e não a que
chamou → para e reescreve (`stopped-and-rewritten`); ocupada, com trabalho agendado, a que chamou, ou
que ganhou `pid` no meio → `queued` (o `watch` aplica a cada ciclo; o último pedido vence). A
reescrita só acontece com a entrada sem `pid`, confirmada duas vezes, preserva o modo do arquivo e
faz backup em `backup/pin-<data>/<id>.state.json`. `claude stop` que falha → exit 1 e o pedido fica
na fila. Pedido `adopt` (do `doctor --fix`) e `migrate` seguem as mesmas regras, com o destino
recalculado a partir dos flags da sessão (a fila nunca é confiável sozinha).

## 6. Configuração

`~/.config/switchboard/config.jsonc` (ou `$XDG_CONFIG_HOME/switchboard/config.jsonc`;
`SWITCHBOARD_CONFIG` troca o caminho). JSONC, `strictObject` (chave desconhecida é erro, chave
duplicada é erro), schema zod como fonte única (gera `schema.json`). Edições do `sb` preservam
comentários e só gravam se o resultado inteiro valida.

| Chave | Tipo / padrão |
|---|---|
| `$schema` | texto, opcional |
| `switchboard` | `1` (obrigatório) |
| `accounts` | `{ "<conta>": {} }`, o registro |
| `swap.auto` | `true` |
| `swap.threshold.fiveHour` / `sevenDay` | `0.9` / `0.95` (em `(0, 1]`) |
| `swap.returnOnReset` | `true` |
| `swap.probeEvery` | `"5m"` (`30s`, `5m`, `1h`) |
| `default` | nome de um mux; obrigatório se há mux |
| `mux.<nome>.root` | pasta absoluta ou com `~` |
| `mux.<nome>.account` | a preferida |
| `mux.<nome>.accounts` | ao menos uma |
| `mux.<nome>.pool` | `[]` |

## 7. Estado em disco

`~/.local/state/switchboard/` (`$XDG_STATE_HOME`, ou `SWITCHBOARD_STATE_DIR`): diretório e
subdiretórios em 700, arquivos de segredo em 600. Nada ali é versionado. Escritas são atômicas
(temporário + `rename`).

| Caminho | Conteúdo |
|---|---|
| `tokens/<conta>.json` | `{"env":{"CLAUDE_CODE_OAUTH_TOKEN":"…"}}`, 600 — o **único** lugar onde um token vive |
| `tokens/keychain.json` | `{}` |
| `mux/<mux>.json` | link → `tokens/<conta atual>.json` |
| `pins/<conta>.json` | link → `tokens/<conta>.json` |
| `usage.json` | `{ latest, previous, groups }`: última e anterior medição por conta (sem token) e grupos de duplicatas |
| `runtime.json` | `mux.<mux> = { since, lastSwap? }` · `overrides.<mux> = { account, until }` (ms) · `pending[] = { jobId, settings, reason: pin\|unpin\|adopt\|migrate, requestedAt }` · `notified` (chaves `warn:`, `muxwarn:`, `swap:`, `err:`, `sched:`, `stopfail:`, `kept:`, `limit:`, `pin:`; podadas em 7 dias) |
| `lock` | exclusão mútua: criado com `O_EXCL`, contém o pid; lock de pid morto é tomado; espera 30 s (exit 5), `sb usage` 1,5 s, `watch` 250 ms, o login na hora de salvar o token 5 min (avisa "esperando o lock…" uma vez: o token acabou de sair do navegador) |
| `watch.pid` · `watch.json` | trava do laço (um por máquina) · batimento `{ pid, lastTick }`; "rodando" = pid vivo e ciclo há ≤ 90 s |
| `wrapper.zsh` | a função `claude()` do `sb install` |
| `log/watch.log` · `log/login.log` · `log/login.pid` · `log/watch.out` | log do watch (token redigido) · marcos do login · trava do `setup-token` · saída do LaunchAgent |
| `backup/pin-<data>/` · `backup/migrate-<data>/` · `backup/finish-<data>/` | cópia do `state.json` antes de um pin · cópia do legado antes da migração · o legado movido pelo `--finish` |

Fora do estado, o `sb install` grava `~/Library/LaunchAgents/com.gabriellst.switchboard.watch.plist`,
`~/.claude/commands/sb.md` e uma linha em `~/.zshrc` (terminada em `# switchboard`).

Variáveis de ambiente: `HOME` (tudo parte dele, não de `os.homedir()`), `XDG_CONFIG_HOME`,
`XDG_STATE_HOME`, `SWITCHBOARD_CONFIG`, `SWITCHBOARD_STATE_DIR`, `SWITCHBOARD_JOBS_DIR` (padrão
`~/.claude/jobs`), `SWITCHBOARD_CLAUDE` (binário do `claude`), `SWITCHBOARD_API_BASE`,
`SWITCHBOARD_NO_NOTIFY`, `SWITCHBOARD_PS`.

## 8. Integrações

- **Abrir o `claude`** (`sb agents`, `sb run`): checa o link (`checkSettingsTarget`), **checa de novo**
  logo antes do spawn, e roda o `claude` com stdio herdado e `cleanEnv` (F10). `agents` →
  `claude agents --cwd <root> --settings <link>`; `run` → `claude <args> --settings <link>` com o
  `--settings` **antes do primeiro `--` solto** (depois dele tudo é posicional e o `claude` rodaria
  no keychain); `--settings` do usuário antes do `--` é recusado (exit 3), assim como qualquer outra
  opção antes do `--` em `sb run` (`splitRunArgs`; a recusa de opção desconhecida de todo comando está na seção 9).
  Resíduo: uma flag com valor imediatamente antes do `--` solto (`--model -- texto`) engole o
  `--settings` inserido (erro de digitação do comando; vale também para o wrapper). SIGINT/SIGTERM/SIGHUP são
  repassados (com terminal, o Ctrl+C já chega ao filho); o `sb` sai com o código ou o sinal do `claude`.
  Link ausente, quebrado, JSON inválido ou sem `CLAUDE_CODE_OAUTH_TOKEN` → exit 1, o `claude` não abre.
- **`checkSettingsTarget`**: o link tem que ser symlink, o alvo real um arquivo em `<estado>/tokens`,
  JSON objeto; `keychain` só vale com `{}`; as demais exigem `env.CLAUDE_CODE_OAUTH_TOKEN` não vazio.
- **`sb which`**: só lê config e link (sem lock, rede ou sonda); imprime só o caminho; mesma checagem
  acima (exit 1 se o `claude` ignoraria o settings).
- **Wrapper zsh** (`claude()`), na ordem: (1) subcomando de manutenção (`auth`, `attach`, `logs`,
  `stop`, `kill`, `rm`, `respawn`, `mcp`, `plugin`, `plugins`, `doctor`, `update`, `upgrade`, `install`,
  `setup-token`, `daemon`, `purge`, `import`, `gateway`, `ultrareview`, `auto-mode`, `help`) → passa
  direto, sempre sem `CLAUDE_CODE_OAUTH_TOKEN`; (2) `--settings` explícito antes de um `--` → passa
  direto, sem o token herdado; (3) senão `--settings $(sb which <pasta>)` antes do primeiro `--`, e se o `which` falhar
  ou o runtime sumir, imprime o erro e devolve 1 **sem chamar o `claude`**. A linha do `~/.zshrc`
  tem um `else` que define um `claude()` recusando, caso o wrapper suma. Tira um `alias claude`.
- **LaunchAgent** `com.gabriellst.switchboard.watch`: `RunAtLoad`, `KeepAlive`, `ThrottleInterval 30`,
  `PATH` com o diretório do `claude`, `HOME` e os caminhos **resolvidos** de quem instalou
  (`SWITCHBOARD_CONFIG`, `SWITCHBOARD_STATE_DIR`, `SWITCHBOARD_JOBS_DIR`: com `XDG_*` ou `SWITCHBOARD_*` no shell, o
  `watch` usa o mesmo estado que o CLI; nunca os seams de teste nem token; sempre absolutos). O `sb install` mostra esses três caminhos (`watch` no
  `--json`) e, se o plist existente tinha outros (ou, sem a chave, o padrão do HOME dele), lista `antes → depois` em
  `watchChanged` e como aviso (exit 0); carregado com `launchctl bootstrap gui/<uid>` (`bootout` antes;
  3 tentativas). O runtime gravado é o caminho estável do node/bun (a entrada do `PATH` que resolve
  para o mesmo binário).
- **`/sb`**: `~/.claude/commands/sb.md`, `!sb $ARGUMENTS 2>&1`, `allowed-tools: Bash(sb:*)`,
  `disable-model-invocation: true`.
- **Login**: `script -q /dev/null sh -c 'stty cols 2000 rows 50; exec "$0" setup-token' <claude>` com
  `CLAUDE_CONFIG_DIR` temporário e `cleanEnv`; o buffer bruto do PTY nunca sai da função; extrai até 3
  candidatos, valida o primeiro com sonda `ok` e só então grava (sob o lock); limite de 15 min (exit
  4); uma trava (`log/login.pid`) impede dois `setup-token` (exit 5). Sem terminal desanexa (espera até
  25 s pelo link). `--terminal` lê o token colado da entrada.
- **cmux**: sem integração com a API; cada aba roda `sb agents <mux>`.

## 9. Comandos

Todos que produzem dados aceitam `--json`, que nunca traz token (e passa por uma redação de
`sk-ant-…` como última barreira). Nada pergunta nada.

| Comando | Faz |
|---|---|
| `sb` · `sb usage [--json] [--watch] [--every N]` | painel; mede com cache de 60 s sob o lock (1,5 s); `--every` em segundos inteiros ≥ 1 |
| `sb accounts [list] [--json]` · `sb accounts rm <conta> --yes` | lê config, tokens e a última medição (não mede); `rm` recusa conta anexada e `keychain` |
| `sb login <conta> [--terminal] [--foreground] [--attach <mux> [--pool \| --at N] [--preferred]]` | login; `--pool/--at/--preferred` exigem `--attach` (exit 3) |
| `sb attach <conta> <mux> [--pool \| --at N] [--preferred] [--json]` | anexa (idempotente; `--at` move); conta sem token faz o login antes (recusa `--json`) |
| `sb detach <conta> <mux> [--json]` | desanexa de `accounts` e `pool`; recusa a preferida e a atual |
| `sb mux [list] [--json]` · `sb mux add` · `sb mux set` · `sb mux rm` | `add --root --account [--accounts] [--pool]`; `set [--root] [--account] [--accounts] [--pool] [--default]` só edita a config (`--accounts` que tira a conta atual do mux é recusado, exit 3: `sb swap` antes, como no `detach`); `rm` mantém o link e recusa o default |
| `sb agents [mux] [--cwd <pasta>]` · `sb run [mux] -- <args>` | abrem o `claude` (seção 8); `--cwd` troca a pasta da view (padrão: a raiz do mux), e sem nome o mux é o dono dessa pasta; pasta de outro mux, inexistente ou que não é pasta → exit 3 |
| `sb which [pasta] [--json]` | `{ mux, settings, account }` ou só o caminho |
| `sb swap <mux> [conta] [--clear] [--json]` | seção 5.4; exit 1 se alguma parada falhou |
| `sb pin <sessão> <conta> [--json]` · `sb unpin <sessão> [--json]` | seção 5.6 |
| `sb watch [--once [--json]]` | o laço; `--once` faz um ciclo (não grava o batimento) |
| `sb install [--simular] [--json]` | grava plist, wrapper e `/sb`, liga a linha do zshrc, carrega o LaunchAgent; idempotente |
| `sb doctor [--fix] [--json]` | seção 11 |
| `sb migrate [--simular] [--finish] [--json]` | seção 12 `--manter-config`: não importa contas nem cria muxes (nem os de keychain do `excluir`); exige config com mux e `default`; só reaponta as sessões pelos muxes existentes, troca o terminal e instala. |

Opção desconhecida é recusada em todo comando e subcomando (exit 3, mensagem com o nome da opção, antes de
qualquer efeito): o citty as ignora em silêncio, então `guarded` (`src/commands/guard.ts`) compara os `rawArgs`
com os `args` declarados (nome, camelCase/kebab-case, aliases, `--no-<booleana>`, `--opção=valor`, `--help`/`-h`)
até o primeiro `--`. `--version` só vale sozinho (`sb --version`). Em `sb run` o que vem depois do `--` é do `claude`.
O argv inteiro é conferido uma vez, antes de o citty despachar (`validateArgv`, `src/commands/argv.ts`, chamado em
`src/cli.ts`), descendo raiz → `mux`/`accounts` → folha: com um subcomando adiante, qualquer opção antes do nome é
recusada (a desconhecida, e também a que o pai declara, porque o citty só entrega à folha o que vem depois do nome);
sem subcomando adiante valem as opções declaradas no nível (`sb --json` = painel, `sb mux --json` = list). `--help`/`-h`
em qualquer lugar e `--version`/`-v` sozinhos ficam com o citty. Só um subcomando desconhecido falha com exit 1.

## 10. Exit codes

`0` ok · `1` verificação falhou · `2` config inválida · `3` uso · `4` `claude` · `5` lock.

| Código | Quando |
|---|---|
| `1` | `doctor` com erro; `which`/`agents`/`run` com link ou token inválido; `swap` sem alternativa ou com parada que falhou; `claude stop` que falhou ao fixar; login cujo token não autenticou, que não capturou token (o `setup-token` saiu com 0 sem entregá-lo) ou que foi interrompido por sinal; `install` com `launchctl` falho ou linha do zshrc diferente; `migrate` com `sb install` problemático; `migrate --finish` recusado; `runtime.json` corrompido num comando manual; erro inesperado; subcomando desconhecido |
| `2` | config ausente ou inválida; `doctor` com `config.invalid`; pasta fora de todo root sem `default` |
| `3` | nome inválido, mux/conta/sessão inexistente ou recusada pelas regras (`accounts`, destino igual, prefixo ambíguo), opções incompatíveis, opção desconhecida, argumento a mais, `--json` do `watch` sem `--once`, conta sem token, `migrate` sem o que migrar |
| `4` | `claude` ausente ou que não executa, `claude agents --json` que falha ou tem formato inesperado, `state.json` de formato novo, `claude setup-token` que sai com código ≠ 0 ou passa de 15 min |
| `5` | outro `sb` segura o lock; segundo `sb watch`; login em andamento; `watch --once` com o lock ocupado |

`sb agents` e `sb run` saem com o código do `claude` (ou `128+n` / o mesmo sinal). `sb usage` nunca
sai com 5: lock ocupado vira "última medição" com aviso.

## 11. `doctor`

`diagnose` só lê (sem `ensureState`, sonda ou lock) e nunca inclui conteúdo de token nem a linha de
comando de um processo. Erros antes de avisos. Exit: 2 com `config.invalid`; 1 com qualquer erro; 0
só com avisos. `--fix` conserta o que é seguro, **sob o lock**, e o relatório final é o de depois.

| Código | Sev. | Assunto | Quando | `--fix` |
|---|---|---|---|---|
| `config.invalid` | erro | `config` | config ausente ou inválida | — |
| `config.no-token` | erro | conta | conta registrada sem `tokens/<conta>.json` | — |
| `link.broken` | erro | `mux/<n>` ou `pins/<n>` | link ausente, quebrado ou com alvo inválido de mux conhecido ou usado por sessão | recria para a atual/preferida (ou a conta do pin) com token utilizável |
| `token.invalid-json` | erro | conta | JSON de token inválido (F6); `keychain.json` ≠ `{}` | — |
| `token.no-oauth` | erro | conta | sem `env.CLAUDE_CODE_OAUTH_TOKEN` | — |
| `token.dead` | erro | conta | a última medição foi 401/403 | — |
| `token.perms` | erro | conta | `tokens/<c>.json` fora de 600 | `chmod 600` |
| `session.no-settings` | erro | id | sessão sob o root de um mux (conta ≠ keychain) sem `--settings` | parada: reescreve; viva: entra na fila (`adopt`) |
| `view.no-settings` | erro | `pid <n>` | `claude agents` aberto sem `--settings` de mux/pin do `sb` (ou com de terceiros) | — |
| `state.perms` | aviso | `estado` ou subdir | diretório fora de 700 | `chmod 700` |
| `pool.duplicates` | aviso | mux | contas de mesmo uso no mesmo pool | — |
| `pool.preferred-outside` | aviso | mux | pool não vazio sem a preferida | — |
| `account.unattached` | aviso | conta | registrada e sem mux | — |
| `link.orphan` | aviso | link ou `tokens/<c>` | sobra de mux/conta que saiu da config | — |
| `session.legacy` | aviso | id | `--settings` em `~/.claude/contas*` | — |
| `session.foreign` | aviso | id | `--settings` de terceiros | — |
| `view.legacy` | aviso | `pid <n>` | view com o settings do `claude-conta` | — |
| `watch.stopped` | aviso | `watch` | sem batimento, pid morto ou ciclo há mais de 90 s | — |
| `claude.format` | aviso | id ou `claude` | o adaptador recusou o formato interno | — |

A view cujo `--settings` está em `pins/` é aceita (não roda no keychain).

## 12. Migração do `claude-conta` (`sb migrate`)

`planMigration` não escreve nada (nem estado, nem lock, nem log, nem medição) e `--simular` só o imprime.
Recusas, antes de qualquer escrita: sem `~/.claude/contas` (exit 3); sem view `claude agents --cwd
<pasta existente>` aberta e sem `default` na config (exit 3; o `default` nunca é o mux do keychain);
config inválida (exit 2); `claude agents` ilegível (exit 4); `claude` fora do PATH, que o `sb install` do passo 9
exige (exit 4; a conferência vem antes do lock e de qualquer escrita, para o zshrc não ficar trocado sem wrapper).

`applyMigration`, sob o lock, na ordem: (0) recusas; (1) backup em `backup/migrate-<data>/` (cópia de
`contas`, `contas-fixas`, `commands/conta.md`, `~/.zshrc`; diretórios 700, arquivos 600); (2) tokens
para `tokens/` (nunca sobrescreve um existente); (3) só as edições que faltam na config do usuário
(contas, muxes, `default`); (4) links dos muxes novos; (5) sessões: paradas reescritas, vivas na fila
`migrate` (o `watch` PARA cada uma, com `claude stop`, quando ela ficar livre; ela volta nas contas novas
quando o usuário a reabre; turno em andamento ou trabalho agendado nunca é interrompido; o `--simular` e a
saída do aplicar dizem quantas são); (6) `kill` do vigia do `claude-conta`, se o pid ainda é de um `_vigiar`; (7) a linha
`# claude-conta` do `~/.zshrc` vira a do `sb`; (8) `conta.md` sai (a cópia está no backup); (9) `sb
install`; (10) medição para achar duplicatas. Cada passo é aditivo ou idempotente.

Muxes: um por raiz de `contas/excluir` (conta `keychain`, `pool: []`) e um por view aberta fora delas;
cada um com `accounts` = todas as contas importadas e `pool` = a conta ativa primeiro e as demais em
ordem alfabética (se a ativa era o keychain: `pool` vazio e `accounts` inclui o `keychain`). O destino
de cada sessão sai dos flags dela: `contas/ativa.json` → `mux/<mux da pasta>.json`;
`contas-fixas/<c>.json` → `pins/<c>.json`, com `c ∈ accounts` do mux.

`--finish [--simular]` move `~/.claude/contas` e `contas-fixas` para `backup/finish-<data>/` (nada é
apagado). Recusa (exit 1, com a lista) enquanto: o `~/.zshrc` tem `# claude-conta`; não há config ou
nenhuma conta foi importada; há sessão com `--settings` do legado; há sessão com `state.json` que
existe e não se lê; há pedido `migrate` na fila; há view com o settings antigo; o `ps` falhou.

## 13. Stack e testes

TypeScript ESM; `bun` para desenvolver e testar; `tsdown` gera `dist/` para Node ≥ 20 (launcher
sh/js pós-build); `citty` (subcomandos sob demanda), `zod` (schema único), `jsonc-parser`. `core/`
não conhece terminal; `commands/` são finos; `src/report.ts` renderiza. Identificadores em inglês,
mensagens em português. Os testes rodam com `HOME`, `SWITCHBOARD_CONFIG`, `SWITCHBOARD_STATE_DIR`
e `SWITCHBOARD_JOBS_DIR` num diretório temporário, `SWITCHBOARD_CLAUDE` apontando para um `claude`
falso, `SWITCHBOARD_API_BASE` para um servidor falso e `SWITCHBOARD_NO_NOTIFY=1`: nenhum teste
toca `~/.claude`, o keychain ou a API. O token falso é montado por concatenação.

## 14. Riscos aceitos

- O formato de `claude agents --json`, do `state.json` e dos cabeçalhos é interno e pode mudar; cada
  um passa por um adaptador que recusa com exit 4 em vez de adivinhar.
- Um CronCreate one-shot pendente numa sessão reaberta é invisível (`kinds []`): a sessão pode ser
  parada numa troca e o lembrete se perder (F13).
- Uma falha de sonda (`unknown`) mantém o mux numa conta que pode ter acabado de esgotar, por até um ciclo.
- Um 429 espúrio da sonda tira a conta da rotação por até uma medição (`probeEvery`).
- O item `queued` de uma sessão presa por limite roda de novo com o token novo? Não testado (F12):
  o primeiro uso real do `watch` responde.
- A sonda gasta 1 token de saída por conta a cada `probeEvery`.
- Usar várias assinaturas e alternar por limite é decisão do usuário; vale conferir os termos do plano.
