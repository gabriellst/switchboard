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

A preencher na Task 2.

## §3 Trabalho agendado

A preencher na Task 3.
