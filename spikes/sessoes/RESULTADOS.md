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
   (agentes/bash em segundo plano ainda rodando): `status` `busy`; "busy" não implica trabalho útil.
4. O `state` do job fica `blocked` (não `done`/`stopped`) quando a sessão para: o limite é
   distinguível de uma sessão encerrada.
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
  (a prova está abaixo). Não cria job novo.
- `claude --bg --resume <id|sessionId> <flags>`: **sempre criou uma cópia** (id novo, `sessionId` novo) nos três
  testes feitos, todos com flags na linha de comando. A forma sem flags ("continua sob o mesmo ID", segundo a
  própria saída do claude) **não foi testada**: ver "Não testado".

### Respawn (`claude respawn ff1b8a7b`, sessão parada)

| pergunta | observado |
|---|---|
| mesmo id? | sim, `respawned ff1b8a7b` |
| pid novo? | sim: sem pid parada, `65289` depois |
| processo carrega o `--settings` marcado? | `ps` **não mostra** flags: o pid é um `claude bg-spare --bg-spare …claim.sock` (processo reserva já aberto, reivindicado no respawn; log do daemon `bg claimed-spare ff1b8a7b (fleet)`). Prova indireta, observada: com `marca.json` removido, o respawn terminou com `bg settled ff1b8a7b (crashed): exit 1 before init — Error: Settings file not found: /tmp/sb-spike-XXXX/marca.json`. Ou seja, o respawn passa o `--settings` do `respawnFlags` para o processo. |
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
| mesmo id? | não: id novo e `sessionId` novo; `resumeSessionId` igual ao próprio `sessionId` da cópia (não aponta para o original) |
| pid novo? | sim (66276, 66937, 67751); na 1a cópia o `ps` mostrou `bg-spare` sem flags (nas outras duas o `ps` não foi consultado) |
| usa os `respawnFlags` gravados ou só os da linha de comando? | só os da linha de comando: o `respawnFlags` da cópia é exatamente o que foi passado (`--settings ativa.json --model haiku` na 1a e na 3a; `--name … --settings marca.json --model haiku` na 2a). Quanto ao nome: a 1a (sem `--name`) e a 2a (com `--name`) ficaram com `name` `sb-spike-reabrir`; a 3a (id curto, sem `--name`) ficou com o próprio id como nome |
| `startedAt` | o da cópia é o da reivindicação do processo dela (1a: 15:38:54.280Z, criada 15:38:53.504Z); o do original não mudou |
| jobs novos em `agents --json --all`? | sim, 1 por tentativa (52 para 53). A cópia nasce em `idle — send a prompt to start` (`job.state` `working`, `needs` "send a prompt to start", `inFlight` nulo, sem timeline) |
| histórico da conversa na cópia | não verificado; durante o experimento só existia o `.jsonl` do original em `~/.claude/projects/` (a cópia, sem prompt, não gravou transcrição) |

Conflito resolvido: o `claude-conta` ("sempre cria um job novo (cópia)") está certo **quando se passa qualquer flag**
(incluindo flags idênticos aos salvos) ou o id curto; a ajuda do 2.1.317 ("continua sob o mesmo ID") descreve a
forma **sem flags e com o `sessionId` completo**, que não foi exercitada aqui.

### `startedAt` de `agents --json` acompanha o início do processo?

Não. Observado:

- sessão rodando: `startedAt` = instante em que o daemon reivindicou o processo reserva (`claimed-spare`), não o início do
  processo do SO. Sessão original: `ps` `lstart` 12:32:06, `startedAt` 15:37:10.717Z (12:37:10), log `claimed-spare` 15:37:10.046Z.
  Respawn: processo aberto 12:37:10, `startedAt` 15:38:13.619Z, log 15:38:13.078Z.
- sessão parada: `startedAt` volta a ser o `createdAt` do job (`1793720229946` = `2026-11-03T15:37:09.946Z`).
- cada respawn bem-sucedido troca o `startedAt`.

Para a Task 15 (saber se uma sessão é anterior a uma troca de conta): `startedAt` de sessão **rodando** serve como
"quando este host foi (re)aberto" e muda no respawn; não serve para sessão parada (mostra a criação). Não foi
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

A preencher na Task 3.
