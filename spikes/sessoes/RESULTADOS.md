# Resumo e regras (G1)

Fecha os spikes 1-3 (03/11/2026, claude 2.1.317). Todas as regras abaixo são **provisórias**: n pequeno, nenhuma
sessão forçada a bater no limite (gastaria uso, anti-objetivo). A Task 15 implementa estas regras; as fixtures
em `test/fixtures/claude/` (README ali) cobrem cada caso.

- `limit-blocked` = `job.state == "blocked"` **e** `job.needs` começa com `rate limited` **e** `inFlight.tasks == 0` **e**
  `agents.status != "busy"`; `inFlight.queued` pode ser 1. Sessão com `tasks > 0` fica `busy` e **não** é limit-blocked,
  mesmo bloqueada por limite. Não olhar `kinds`/`drainableMonitors` aqui. Evidência: §1, tabela (838abd23 viva `idle`,
  `tasks 0`, `queued 1`; 3e10455e viva `busy`, `tasks 4`) e os três snapshots históricos parados (c802ba64, 64e82d8e,
  5b3f2ad1: `blocked`, `queued 1`, `tasks 0`, `needs` `rate limited — wait and retry · …`). Provisória: nenhuma sessão
  foi vista entrando no limite nem saindo dele.
- `hasScheduledWork(job, agent)` = `agent` tem `pid` **e** `job.inFlight != null` **e** (`inFlight.kinds ∋ "session_cron"`
  **ou** `inFlight.kinds ∋ "monitor"` **ou** `inFlight.wake != null`). Provisória (n = 1 por mecanismo). Evidência: §3,
  tabelas "entre ticks" e "depois de stop + respawn", e "Regra proposta". **Não é suficiente** para um one-shot de
  CronCreate pendente que ficou invisível depois do respawn (`kinds []`, `tasks 0`, e o cron disparou mesmo assim):
  risco **aceito e documentado**. Mitigações **PROPOSTAS / NÃO TESTADAS**: nunca agir enquanto `tempo == "active"` ou
  `agents.status == "busy"`; tratar sessão reaberta há pouco como "assumir trabalho agendado" (N não definido).
- `startedAt` = `agents.startedAt` de `claude agents --json --all`: o instante em que o host foi (re)aberto, ≈ 0,5-0,7 s
  depois da reivindicação do processo reserva (`claimed-spare`). Mudou em todo respawn testado. **Não** é o início do
  processo do SO (`ps` mostrou lstart bem anterior). Em sessão parada vale o `createdAt` do job, então só tem sentido
  para sessão **viva**. Task 15 (`restartStale`): comparar `startedAt < runtime.mux[mux].since` só para sessões vivas.
  Evidência: §2, "`startedAt` de `agents --json` acompanha o início do processo?".
- reabrir por comando: **não (v1)** — o design continua com "o usuário reabre". `claude respawn <id>` manteve
  `id`/`sessionId`/`respawnFlags` de uma sessão parada e ociosa (pid novo), mas imprime "respawned" mesmo quando a
  sessão cai logo depois (julgar por `agents`/`state.json`, nunca por stdout/exit). `claude --bg --resume <id>` com
  flags criou **cópia** nas 3 tentativas; a forma sem flags não foi testada. Ideia para a v2: `sb swap --reopen` via
  `respawn`. Evidência: §2, tabelas de respawn e de `--bg --resume`.
- **Pergunta aberta:** o item `queued` roda de novo com o token novo ao reabrir uma sessão presa por limite? Não é
  testável sem gastar uso de verdade (anti-objetivo); continua aberta. O observador (`vigia`) segue gravando
  `limite.jsonl` (não versionado) e pode trazer pistas sobre o retorno automático depois do reset.
- **Risco aceito:** o `watch` pode parar, na troca de conta, uma sessão com um one-shot de CronCreate pendente que ficou
  invisível depois de um respawn, e o agendamento pode se perder ou ficar na conta antiga. Neste n = 1 o cron
  sobreviveu a stop+respawn (segundo stop, com o cron invisível, não testado), então o custo parece menor que o de
  ScheduleWakeup e Monitor, que morrem no stop.

# Spike 1 — estado da sessão depois de um turno que falha por limite

Ferramentas: `spikes/sessoes/cl` (claude com ambiente limpo, F10) e `spikes/sessoes/observa.py`.
Nada aqui forçou um limite (gastaria uso); tudo é leitura de `~/.claude/jobs/<id>/state.json`,
`timeline.jsonl` e `claude agents --json --all`.

## Como usar observa.py

Sempre com `python3 -I`. Só stdlib. Toda saída passa por um filtro que troca tokens OAuth por `<token>`;
o script nunca abre nada em `~/.claude/contas`.

```sh
python3 -I spikes/sessoes/observa.py snapshot [ids…] [--rate-limited]
python3 -I spikes/sessoes/observa.py vigia --every 60 --horas 24 --out spikes/sessoes/limite.jsonl [--detach]
python3 -I spikes/sessoes/observa.py regrava <id> <settings>
```

- `snapshot`: uma linha JSON por sessão (`id`, `at`, `agents`, `job`, `settings`, `timeline`).
  `--rate-limited` inclui toda sessão cujo `needs` começa com `rate limited`.
- `vigia`: a cada `--every` s grava snapshot das sessões presas por limite (e das já vistas), só
  quando muda (`state`, `status`, `hasPid`, `queued`, `needs`). Sai sozinho após `--horas`.
  `--detach` = duplo fork + `setsid`, stdio em `/dev/null`, pid em `spikes/sessoes/vigia.pid`
  (apagado ao sair). Ligado em 03/11 ~12:35 (-03), prazo 24 h. Saída: `spikes/sessoes/limite.jsonl`
  (não versionado).
- `regrava`: troca os valores de `--settings` em `respawnFlags` (escrita atômica). Recusa, sem
  escrever, se o `name` não começa com `sb-spike-` ou se a sessão não está parada
  (sem `pid` em `claude agents`). Verificado: recusa em `c802ba64` e `838abd23` (mtime/tamanho do
  `state.json` inalterados) e em id malformado.

## §1 Estado depois de um turno que falha por limite

Snapshots de 03/11/2026 ~12:32 (-03) das três sessões históricas (`snapshot c802ba64 64e82d8e 5b3f2ad1`).
Paradas no momento da leitura; `status`/`pid` com a sessão viva: não observados nessas três.

```json
{"id": "c802ba64", "at": "2026-11-03T15:32:28.225Z", "agents": {"state": "blocked", "status": null, "hasPid": false, "kind": "background", "startedAt": 1793387694886}, "job": {"state": "blocked", "tempo": "blocked", "inFlight": {"tasks": 0, "queued": 1, "kinds": [], "drainableMonitors": 0}, "needs": "rate limited — wait and retry · You've hit your 5-hour limit · resets 6:50pm (America/Fortaleza)", "detail": "You've hit your 5-hour limit · resets 6:50pm (America/Fortaleza)", "cliVersion": "2.1.314", "sessionId": "<uuid omitido>", "resumeSessionId": "<uuid omitido>"}, "settings": ["~/.claude/contas/ativa.json"], "timeline": "<omitida: notas de trabalho da sessão>"}
{"id": "64e82d8e", "at": "2026-11-03T15:32:28.226Z", "agents": {"state": "blocked", "status": null, "hasPid": false, "kind": "background", "startedAt": 1793154828125}, "job": {"state": "blocked", "tempo": "blocked", "inFlight": {"tasks": 0, "queued": 1, "kinds": [], "drainableMonitors": 0}, "needs": "rate limited — wait and retry · You've hit your 5-hour limit · resets 4:20pm (America/Fortaleza)", "detail": "You've hit your 5-hour limit · resets 4:20pm (America/Fortaleza)", "cliVersion": "2.1.314", "sessionId": "<uuid omitido>", "resumeSessionId": "<uuid omitido>"}, "settings": ["~/.claude/contas/ativa.json"], "timeline": "<omitida: notas de trabalho da sessão>"}
{"id": "5b3f2ad1", "at": "2026-11-03T15:32:28.227Z", "agents": {"state": "blocked", "status": null, "hasPid": false, "kind": "background", "startedAt": 1793161593223}, "job": {"state": "blocked", "tempo": "blocked", "inFlight": {"tasks": 0, "queued": 1, "kinds": [], "drainableMonitors": 0}, "needs": "rate limited — wait and retry · You've hit your 5-hour limit · resets 4:20pm (America/Fortaleza)", "detail": "You've hit your 5-hour limit · resets 4:20pm (America/Fortaleza)", "cliVersion": "2.1.312", "sessionId": "<uuid omitido>", "resumeSessionId": "<uuid omitido>"}, "settings": ["~/.claude/contas/ativa.json"], "timeline": "<omitida: notas de trabalho da sessão>"}
```

Os três com `job.state == "blocked"`, `inFlight.queued == 1`, `inFlight.tasks == 0` e `needs` com
prefixo `rate limited — wait and retry`; `agents.state == "blocked"`, sem `status` e sem `pid`.

Observação extra, na mesma leitura: duas sessões **vivas** também presas por limite (limite
semanal, reset 8/nov 20:00). Respondem parte da pergunta do passo 4 sem esperar o vigia:

```json
{"id": "3e10455e", "at": "2026-11-03T15:32:28.446Z", "agents": {"state": "blocked", "status": "busy", "hasPid": true, "kind": "background", "startedAt": 1793674549273}, "job": {"state": "blocked", "tempo": "blocked", "inFlight": {"tasks": 4, "queued": 1, "kinds": ["local_agent", "local_bash"], "drainableMonitors": 0}, "needs": "rate limited — wait and retry · You've hit your weekly limit · resets Nov 8 at 8pm (America/Fortaleza)", "detail": "You've hit your weekly limit · resets Nov 8 at 8pm (America/Fortaleza)", "cliVersion": "2.1.317", "sessionId": "<uuid omitido>", "resumeSessionId": "<uuid omitido>"}, "settings": [], "timeline": "<omitida: notas de trabalho da sessão>"}
{"id": "838abd23", "at": "2026-11-03T15:32:28.452Z", "agents": {"state": "blocked", "status": "idle", "hasPid": true, "kind": "background", "startedAt": 1793683914606}, "job": {"state": "blocked", "tempo": "blocked", "inFlight": {"tasks": 0, "queued": 1, "kinds": [], "drainableMonitors": 0}, "needs": "rate limited — wait and retry · You've hit your weekly limit · resets Nov 8 at 8pm (America/Fortaleza)", "detail": "You've hit your weekly limit · resets Nov 8 at 8pm (America/Fortaleza)", "cliVersion": "2.1.317", "sessionId": "<uuid omitido>", "resumeSessionId": "<uuid omitido>"}, "settings": [], "timeline": "<omitida: notas de trabalho da sessão>"}
```

| sessão | `agents.state` | `agents.status` | pid | `inFlight.tasks` | `inFlight.queued` |
|---|---|---|---|---|---|
| 838abd23 | blocked | idle | sim | 0 | 1 |
| 3e10455e | blocked | busy | sim | 4 (`local_agent`, `local_bash`) | 1 |

### Fatos para `activityOf()` (Task 15)

1. Presa por limite = `job.state == "blocked"` e `job.needs` começando com `rate limited`. O texto
   traz a janela (`5-hour` ou `weekly`) e a hora do reset.
2. `inFlight.queued` fica em 1 mesmo sem nenhum trabalho em andamento: a regra provisória do §4
   ("livre = `queued == 0`") nunca trocaria a sessão que bateu no limite. A regra tem de olhar o
   `needs`/`state`, não só `queued`.
3. Sessão viva e presa por limite com `tasks == 0`: `status` `idle` com pid. Com `tasks > 0`
   (agentes/bash em segundo plano ainda rodando): `status` `busy`. Só o par `busy` + `tasks > 0` foi observado.
4. Nas três sessões históricas, paradas com o limite pendente, o `state` do job ficou `blocked`
   (não `done`/`stopped`). Não há evidência de como distinguir, pelos campos, esse caso de uma sessão
   encerrada por outro motivo: só se viram sessões paradas enquanto presas por limite.
5. Ainda em aberto, a cargo do vigia (`limite.jsonl`): depois do reset, o daemon tenta de novo sozinho
   (`state` volta a `working` sem mensagem nova)? Ao reabrir, o item `queued` roda de novo?

## §2 Reabrir sessão parada

Experimento de 03/11/2026 ~12:37-12:41 (-03), claude 2.1.317, tudo via `cl`. Sessão de teste `sb-spike-reabrir`
(id `ff1b8a7b`, `sessionId` `<uuid omitido>`), haiku, cwd `/tmp/sb-spike-XXXX`,
criada com `--settings ~/.claude/contas/ativa.json`, prompt "Responda só: ok". Foi parada (`claude stop`) e o
`respawnFlags` regravado com `observa.py regrava` para `--settings /tmp/sb-spike-XXXX/marca.json`
(`marca.json` = symlink para `ativa.json`), um caminho que só existe no `respawnFlags`.

Pré-requisito achado no caminho: numa pasta nova `cl --bg` falha com `Workspace not trusted. Run claude in
<dir> once and accept the trust prompt`. O diálogo abre com **"No, exit" selecionado** (Enter sai). Foi aceito
uma vez, por pty (seta para baixo, Enter), que gravou `hasTrustDialogAccepted` para a pasta em `~/.claude.json`.

### Resposta curta

- `claude respawn <id>`: **mantém o mesmo id** (e `sessionId`), ganha pid novo e **relê os `respawnFlags` gravados**
  (provado só para o `--settings`, abaixo). Não cria job novo. O stdout/exit do `respawn` **não é confiável**: imprime
  "respawned" mesmo quando a sessão cai logo depois (caso do `--settings` inexistente); julgar por `agents`/`state.json`.
- `claude --bg --resume <id|sessionId> <flags>`: **sempre criou uma cópia** (id novo, `sessionId` novo) nos três
  testes feitos, todos com flags na linha de comando. A forma sem flags ("continua sob o mesmo ID", segundo a
  própria saída do claude) **não foi testada**: ver "Não testado".

### Respawn (`claude respawn ff1b8a7b`, sessão parada)

| pergunta | observado |
|---|---|
| mesmo id? | sim, `respawned ff1b8a7b` (o texto impresso não prova sucesso: ver a prova do crash abaixo) |
| pid novo? | sim: sem pid parada, `65289` depois |
| processo carrega o `--settings` marcado? | `ps` **não mostra** flags: o pid é um `claude bg-spare --bg-spare …claim.sock` (processo reserva já aberto, reivindicado no respawn; log do daemon `bg claimed-spare ff1b8a7b (fleet)`). Prova indireta, observada: com `marca.json` removido, o respawn terminou com `bg settled ff1b8a7b (crashed): exit 1 before init — Error: Settings file not found: /tmp/sb-spike-XXXX/marca.json`. Ou seja, o respawn passa o `--settings` do `respawnFlags` para o processo (provado só para `--settings`; os outros flags não foram verificados). |
| `respawnFlags` persistiu? | sim, idêntico antes e depois (`--name sb-spike-reabrir --settings …/marca.json --model haiku`), também depois do respawn que crashou |
| `sessionId` / `resumeSessionId` mudaram? | não (`<uuid omitido>` nos dois) |
| `startedAt` mudou? | sim: `1793720229946` (parada) para `1793720293619` (rodando, 15:38:13.619Z) |
| jobs novos em `agents --json --all`? | não (52 antes e depois; diff dos ids vazio) |
| estado depois | `state` `done`, `status` `idle`, pid presente: sessão sem turno pendente fica ociosa |

### `--bg --resume` (sessão parada)

Saída do claude, literal, nas duas primeiras tentativas (flags na linha de comando):
`note: background session ff1b8a7b keeps its own saved options, so the flags you passed started a copy as <id novo>.
Without flags, the same command continues ff1b8a7b itself.`

| tentativa | resultado |
|---|---|
| `--bg --resume <sessionId completo> --model haiku --settings ativa.json` | cópia `e8123835`, `sessionId` novo `e8123835-b2cb-…`; original intacto (`state` `done`, sem pid, `respawnFlags` e `startedAt` iguais) |
| `--bg --resume <sessionId completo> --name sb-spike-reabrir --settings marca.json --model haiku` (flags **idênticos** aos salvos) | ainda cópia (`81d42356`); mesma nota |
| `--bg --resume ff1b8a7b` (id curto) `--model haiku --settings ativa.json` | cópia (`d6a14741`), nota diferente: `started a copy of that conversation as d6a14741. To continue a session under its own id, pass its full session id (lowercase …) to --resume.` |

Sobre as cópias (todas observadas antes de apagá-las):

| pergunta | observado |
|---|---|
| mesmo id? | não: id novo e `sessionId` novo |
| pid novo? | sim (66276, 66937, 67751); na 1a cópia o `ps` mostrou `bg-spare` sem flags (nas outras duas o `ps` não foi consultado) |
| usa os `respawnFlags` gravados ou só os da linha de comando? | só os da linha de comando: o `respawnFlags` da cópia é exatamente o que foi passado (`--settings ativa.json --model haiku` na 1a e na 3a; `--name … --settings marca.json --model haiku` na 2a). Quanto ao nome: a 1a (sem `--name`) e a 2a (com `--name`) ficaram com `name` `sb-spike-reabrir`; a 3a (id curto, sem `--name`) ficou com o próprio id como nome |
| `startedAt` | o da cópia é o da reivindicação do processo dela (1a: 15:38:54.280Z, criada 15:38:53.504Z); o do original não mudou |
| jobs novos em `agents --json --all`? | sim, 1 por tentativa (52 para 53). A cópia nasce em `idle — send a prompt to start` (`job.state` `working`, `needs` "send a prompt to start", `inFlight` nulo, sem timeline) |
| histórico da conversa na cópia | não verificado |

Conflito **parcialmente** resolvido: o `claude-conta` ("sempre cria um job novo (cópia)") está certo **quando se passa qualquer flag**
(incluindo flags idênticos aos salvos) ou o id curto; a ajuda do 2.1.317 ("continua sob o mesmo ID") descreve a
forma **sem flags e com o `sessionId` completo**; esse lado repousa só no texto de ajuda do claude, não foi exercitado aqui.

### `startedAt` de `agents --json` acompanha o início do processo?

Não. Observado:

- sessão rodando: `startedAt` ≈ instante em que o daemon reivindicou o processo reserva (`claimed-spare`), 0,5-0,7 s depois
  dele, não o início do processo do SO. Sessão original: `ps` `lstart` 12:32:06, `startedAt` 15:37:10.717Z (12:37:10), log
  `claimed-spare` 15:37:10.046Z (+0,67 s). Respawn: `startedAt` 15:38:13.619Z, log `claimed-spare` 15:38:13.078Z (+0,54 s).
- sessão parada: na parada testada, `startedAt` voltou a ser o `createdAt` do job (`1793720229946` = `2026-11-03T15:37:09.946Z`).
- no respawn testado, o `startedAt` mudou (`1793720229946` para `1793720293619`).

Para a Task 15 (saber se uma sessão é anterior a uma troca de conta): `startedAt` de sessão **rodando** serve como
"quando este host foi (re)aberto" e mudou no respawn testado; não serve para sessão parada (mostra a criação). Não foi
observado se `startedAt` muda ao longo de turnos ou em `claude attach`.

### Não testado

- `--bg --resume <sessionId completo>` **sem flags** (a forma que a ajuda diz continuar sob o mesmo id): o harness
  do agente negou o comando por ele não passar `--settings`, e a regra do experimento é nunca abrir sessão sem
  `--settings` (sem ele a sessão rodaria na keychain da conta pessoal). Também não se sabe, portanto, se essa forma
  usaria os `respawnFlags` salvos.
- `respawn` de sessão que está rodando, com turno em andamento ou com item `queued` (limite): nenhum caso feito.
- A conta que de fato responderia (o `--settings` efetivo no processo): `ps`/ambiente do processo não expõem; só a
  prova indireta do crash acima. Nenhum turno foi feito depois do respawn.
- `claude attach` e `--bg --resume` de sessão **rodando**: não feitos.

Limpeza: as três cópias e `ff1b8a7b` foram paradas e removidas (`claude stop` + `claude rm`);
`agents --json --all | grep -c sb-spike` = 0.

## §3 Trabalho agendado

Experimento de 03/11/2026 12:45-13:00 (-03), claude 2.1.317, tudo via `cl`, haiku, `--settings ~/.claude/contas/ativa.json`,
uma sessão por mecanismo, cada uma em `mktemp -d /tmp/sb-spike-XXXX` próprio (diálogo de confiança aceito por pty, como no §2).
**n = 1 por mecanismo** (uma sessão, um ciclo de stop+respawn): tudo abaixo é "na sessão testada". Horários em -03 (o
`state.json`/transcrição usam UTC, +3 h).

| nome | id | prompt | o que o modelo fez |
|---|---|---|---|
| `sb-spike-loop` | `6a471e1e` | `/loop 2m responda só: tick` | criou o cron `91abbe20` (recorrente, 2 min) |
| `sb-spike-wakeup` | `63531985` | `/loop responda só: tick (acorde de novo em 2 minutos)` | modo dinâmico: ScheduleWakeup encadeado (toolUseId em `.pending-wakeup`); as batidas reais saíram a cada ~3 min (12:48:04, 12:51:06), não 2 |
| `sb-spike-monitor` | `ecbef04b` | Monitor em `while true; do date; sleep 30; done` | monitor `bm9r66c92` |
| `sb-spike-cron` | `4911b558` | CronCreate daqui a 5 min | one-shot `553e211c`, disparou às 12:50:00 |
| `sb-spike-cron` (2a) | `d3da7efb` | CronCreate daqui a **7** min | one-shot `fbcb9825` para 12:58; criada só para o teste de stop+respawn (a 1a já tinha disparado quando chegou a hora de parar) |

Todos os textos de `detail`/timeline abaixo (ex.: "possible duplicate cycle", "3 cycles in parallel", "next run 12:47" depois de
12:54) são **escritos pelo modelo haiku** e erram; nenhum fato foi tirado deles. A saída do CronCreate "só existe nesta
sessão e não roda se ela encerrar antes" também é afirmação do modelo, e foi **contrariada** pelo teste de respawn (abaixo).

### Entre ticks e durante um tick (campos do `state.json` / `agents --json --all`)

Colunas: `ag` = `agents.state`/`agents.status`; `job` = `state.json` `state`/`tempo`; `inFlight` = `tasks`, `queued`, `kinds`.

| mecanismo | entre ticks: `ag`, `job` | entre ticks: `inFlight` + chaves extras | durante um tick |
|---|---|---|---|
| `/loop 2m` (cron recorrente) | `working`/`idle`; `working`/`idle` | `tasks 1`, `queued 0`, `kinds ["session_cron"]`, `drainableMonitors 0`; chave nova `selfWake: true` | `busy`/`active` por ~3-6 s (12:50:37-41, 12:56:35-41); `inFlight` **igual** (continua `session_cron`) |
| ScheduleWakeup (`/loop` sem intervalo) | `working`/`idle`; `working`/`idle` | `tasks 1`, `kinds ["session_cron"]` **e** `inFlight.wake = {at (ms epoch), reason, fires}`; arquivo `~/.claude/jobs/<id>/.pending-wakeup` `{toolUseId, scheduledFor, chainStartedAt}`. `selfWake`: ausente na 1a leitura (12:45:31), `true` nas leituras de 12:51:00 e pré-stop | `busy`/`active`; `fires` sobe 0→1→2. Em 12:51:00 (meio do tick) `kinds []`, `tasks 0`, sem `wake`, sem `.pending-wakeup`: sem marcador por ~7 s até o modelo reagendar (12:51:07). Em 12:48:05 o `wake` já estava com o `at` novo |
| Monitor | `working`/`busy` (ou `done`/`busy`); `job.state` alterna `working`/`done`, `tempo` `idle`/`active` | `tasks 1`, `kinds ["monitor"]`, `drainableMonitors 0`; chave nova `fan: [{id, kind:"monitor", label, startedAt}]`; sem `selfWake`. `~/.claude/sessions/<pid>.json` mostra `status: "shell"` | cada linha de saída do monitor (a cada 30 s) acorda o modelo: `tempo active` por ~6 s (12:47:21, :47:52, :48:23, :49:22, :49:54…), com `ag.status` `busy` o tempo todo, inclusive entre eles |
| CronCreate one-shot | `working`/`idle` (às vezes `done`/`idle`); `job.state` `done`/`idle` | `tasks 1`, `kinds ["session_cron"]`, `selfWake: true`; sem `wake`/`fan` | no disparo (12:50:00) `busy`/`active` e `tasks 0`, `kinds []` já de início (consumido); depois `done`/`idle`, sem `selfWake`. Fica indistinguível de uma sessão ociosa comum |

Fatos transversais, todos observados:

- `drainableMonitors` ficou **0** o tempo todo, inclusive com um Monitor vivo. Não é marcador. O marcador do Monitor é `kinds ∋ "monitor"`.
- `queued` ficou **0** em todos os casos. `status` `idle` entre ticks (loop, wakeup, cron): "idle" não prova que a sessão está livre de agendamento. No Monitor o `status` é `busy` entre ticks: "busy" não prova turno em andamento.
- `agents.state` e `job.state` divergiram no mesmo instante (ex.: 12:46:04 monitor `ag done`/`job done`, cron `ag working`/`job done`; 12:50:00 cron `ag working/busy`/`job done/active`): para decidir, usar `job.state`/`inFlight`, não `agents.state`.
- Nenhum arquivo agendado novo apareceu em `~/.claude` (`find` até profundidade 4) fora de `projects/` e dos diretórios `jobs/<id>/` (`state.json`, `timeline.jsonl`; mais `.pending-wakeup` só no wakeup), `sessions/<pid>.json` e `daemon/roster.json`.
  Em `<cwd>/.claude/` só um `scheduled_tasks.lock` `{sessionId, pid, procStart, acquiredAt}` (nos diretórios loop e cron; no monitor não havia `.claude`; no wakeup a pasta ficou sem arquivos); no do cron o lock era da **1a** sessão (`4911b558`), e mesmo assim a 2a (`d3da7efb`, mesmo cwd) disparou. Nenhum `scheduled_tasks.json` apareceu.
- Os ids dos crons (`91abbe20`, `553e211c`, `fbcb9825`) aparecem na transcrição `~/.claude/projects/<cwd>/<sessionId>.jsonl` (15, 5 e 5 ocorrências). Que a restauração depois do respawn venha da transcrição é **inferência**: o mecanismo de restauração não foi observado.
- Os ticks do loop e o disparo do cron aparecem na transcrição como `system`/`scheduled_task_fire` seguido do prompt de usuário (`responda só: tick`, `responda só: oi`).

### Depois de `stop` + `respawn` (parados 12:52:07, respawn 12:53:04, observados até 12:59:58)

`respawn` imprimiu "respawned" nos quatro e todos ganharam pid; o julgamento abaixo é por `agents`/`state.json`/transcrição.

| mecanismo | em `stop` | depois do respawn |
|---|---|---|
| `/loop 2m` | `state` `stopped`; `inFlight`, `selfWake` somem; `lastTerminalAt` aparece | **volta**: `kinds ["session_cron"]` em até 4 s; mesmo cron `91abbe20`; ticks reais (`scheduled_task_fire`) às 12:54:35, 12:56:34, 12:58:34. O tick de 12:52:37 (parada) **não foi reposto** |
| ScheduleWakeup | idem; `.pending-wakeup` apagado | **perdido**: `kinds []`, sem `wake`, sem `.pending-wakeup`; o disparo agendado para 12:54:00 não ocorreu e nada ocorreu até 13:00 (parada final). Cadeia encerrada |
| Monitor | idem, mas **`fan` continua** no `state.json` | **perdido**: transcrição recebeu `<task-notification> … status stopped` às 12:53:07; `kinds []` depois; `fan` ainda listava o monitor (obsoleto). Nenhum tick novo |
| CronCreate one-shot (`d3da7efb`) | **anomalia**: `state.json` **não foi reescrito** (`state` `done`, `inFlight.kinds ["session_cron"]`, `selfWake true`), `agents`: `state working`, `status` nulo, sem pid, por ≥ 25 s (12:52:14 e 12:52:25). Nos outros três o `stop` reescreveu | **disparou às 12:58:00** (`scheduled_task_fire` + `oi`), apesar de ter parado e reaberto antes. **Mas** entre 12:53:08 e 12:58:02 o `state.json` mostrou `kinds []`, `tasks 0`, `job.state done`: o agendamento estava vivo e **invisível** |

Detalhes do respawn: `job.state` passou a `running` (valor novo, não visto antes) em loop, wakeup e monitor (o loop voltou a `working` no primeiro tick; wakeup e monitor ficaram em `running`); `inFlight` ganhou forma sem a chave
`drainableMonitors` (`{tasks, queued, kinds}`), que voltou no loop depois do primeiro tick. O parser tem de tolerar chave ausente.

### Regra proposta para `hasScheduledWork` (PROVISÓRIA)

Proposta, baseada em n = 1 por mecanismo; não é fato estabelecido:

```
hasScheduledWork(job, agent) =
  agent.hasPid                                  // sem pid o state.json pode mentir (anomalia do stop acima)
  && job.inFlight != null
  && ( job.inFlight.kinds ∋ "session_cron"      // /loop, ScheduleWakeup e CronCreate vivos
       || job.inFlight.kinds ∋ "monitor"        // Monitor vivo
       || job.inFlight.wake != null )           // ScheduleWakeup pendente
```

- Dica secundária (não decide sozinha): `selfWake == true`. Não usar: `status`, `queued`, `drainableMonitors`, `tasks > 0` (também vale para `local_bash`/`local_agent`, trabalho dentro do turno), `fan` (obsoleto depois do stop), nem `detail`/timeline (texto do modelo).
- O que um `stop` faz com cada um (na sessão testada): mata ScheduleWakeup e Monitor; loop recorrente e CronCreate one-shot sobreviveram ao `respawn` (o one-shot ficou invisível); ticks perdidos durante a parada não são repostos.
- Limitações conhecidas da regra (a regra **NÃO é suficiente** para os casos 1 e 2):
  1. **One-shot CronCreate pendente depois de `respawn`: a regra dá falso negativo.** Observado: `kinds []`, `tasks 0`, sem `wake`/`fan`, `job.state done`, de 12:53:08 a 12:58:02, e o cron disparou às 12:58:00. Antes do respawn (12:51-12:52) ele aparecia com `kinds ["session_cron"]`; a invisibilidade só foi observada depois do respawn. Nenhum campo de `state.json`/`agents` marca esse cron: **nenhuma mitigação foi encontrada nos campos observados**. Mitigações, todas **PROPOSTAS / NÃO TESTADAS**: (a) ler a transcrição `~/.claude/projects/<cwd>/<sessionId>.jsonl` e achar um uso de CronCreate sem `scheduled_task_fire` correspondente (o formato do uso da ferramenta não foi inspecionado; só se viu `system`/`scheduled_task_fire` e o id do cron no arquivo); (b) tratar sessão reaberta nos últimos N minutos como "desconhecido, assumir trabalho agendado" (conservador; N não definido). Observação, não garantia: neste n=1 o cron sobreviveu a stop+respawn e disparou, então o custo desse falso negativo parece menor que o do ScheduleWakeup e do Monitor, que morrem no stop (um segundo stop, com o cron invisível, não foi testado).
  2. **Janela de ~7 s no ScheduleWakeup, no meio do tick** (`kinds []`, `tasks 0`, sem `wake`, **sem `.pending-wakeup`**, observada em 12:51:00): olhar o `.pending-wakeup` **não** resolve (o arquivo também some nessa janela); a releitura com 2 amostras também **não foi testada** e não se recomenda como mitigação. Mitigação proposta (**PROPOSTA / NÃO TESTADA**): nunca agir enquanto `tempo == "active"` ou `agents.status == "busy"` (a troca não deve interromper um turno de qualquer forma); na janela observada o `tempo` era `active`.
  3. Falso positivo sem a condição de pid, pelo `state.json` obsoleto de sessão `done` parada (já coberto pelo `hasPid` da regra).
- Assinatura: `hasScheduledWork(job, agent)`: o pid vem da entrada de `agents --json --all` (`agent.hasPid`), não do `state.json`; o plano diz `hasScheduledWork(state)` e precisa ser ajustado.
- Parsers das Tasks 14/15 devem tolerar: `job.state` ∈ {`running`, `stopped`, `done`, `working`, `blocked`}; `inFlight`/`selfWake`/`fan` obsoletos em sessão sem pid; ausência de `selfWake`, `inFlight.wake`, `fan`, `drainableMonitors` e do próprio `inFlight` (some no `stop`).

### Não testado / não observado

- CronCreate com `durable: true` e onde ele grava; mais de um cron na mesma sessão; cron recorrente criado por CronCreate (só `/loop` foi recorrente).
- Trabalho agendado em sessão presa por limite (§1) e o que o reset faz com ele.
- `claude attach` e `respawn` de sessão que não está parada; respawn depois de o horário do cron já ter passado (o one-shot foi respawnado antes da hora).
- ScheduleWakeup: o único caso feito foi `stop` 12:52, respawn 12:53, `scheduledFor` 12:54 (respawn **antes** da hora; a cadeia se perdeu). Respawn **depois** da hora: não feito.
- ScheduleWakeup chamado fora de `/loop`: só o modo dinâmico do `/loop` foi exercitado.

Limpeza: as 5 sessões (`6a471e1e`, `63531985`, `ecbef04b`, `4911b558`, `d3da7efb`) paradas e removidas (`stop` + `rm`); `agents --json --all | grep -c sb-spike` = 0 e nenhum dos 5 ids na lista; os 4 diretórios de teste passaram por `cl purge -y` e foram removidos de `/tmp`; nenhuma chave `sb-spike` em `projects` de `~/.claude.json`.
