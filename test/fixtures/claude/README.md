# Fixtures do adaptador do Claude Code

Saneadas a partir de leituras de 03/11/2026 (Claude Code 2.1.317): ids inventados, `cwd` e `name` genéricos,
nenhum token, nenhum caminho real, fuso e hora de reset neutros. A forma (chaves, tipos, quais campos faltam em
sessão parada) é a observada; os valores são fictícios. Fatos: `docs/superpowers/specs/2026-11-03-switchboard-design.md`
§3 (F12–F14); medições e regras: `spikes/sessoes/RESULTADOS.md`.

A coluna **Activity** é a esperada pela precedência de `activityOf` da Task 15, em
`docs/superpowers/plans/2026-11-03-switchboard.md` (seção da Task 15, "Precedência de `activityOf`"):
`!live → stopped`, depois `scheduled`, `limit-blocked`, `busy`, `free`. `kinds` só com `local_bash`/`local_agent`
é trabalho dentro do turno: `hasScheduledWork = não` e a sessão é `busy`. A regra limit-blocked só vale para
sessão **viva** (com `pid`); sem `pid` o estado do job é obsoleto e a sessão é `stopped`.

`agents.json` imita `claude agents --json --all`: `pid` e `status` só aparecem nas entradas de sessão viva.
Cada `jobs/<id>/state.json` imita `~/.claude/jobs/<id>/state.json`.

| Arquivo (`jobs/<id>/state.json`) | Caso | Fato que codifica | Consumidor | Activity |
|---|---|---|---|---|
| `a1b2c3d4` | live-busy: `working`/`busy`, `tasks 1`, `kinds ["local_agent"]` | F8, RESULTADOS §1 item 3 | Task 14 contrato; Task 15 `activityOf` | `busy` (`hasScheduledWork` = não: `kinds` não vazio, mas só `local_*`) |
| `b2c3d4e5` | live-idle: `done`/`idle`, `inFlight` vazio. Tem a mesma forma que o one-shot CronCreate invisível depois do respawn (`kinds []`) | F8; F13 (risco aceito) | Task 14 contrato; Task 15 `activityOf` | `free` |
| `c3d4e5f6` | stopped: sem `pid`, sem `inFlight`, com `lastTerminalAt` | F8, F14 (stop reescreve o `state.json`) | Task 14 contrato (`inFlight` ausente); Task 15 caso stopped | `stopped` |
| `d4e5f6a7` | limit-blocked **parada** (limite de 5 h), sem `pid`: `blocked`, `queued 1`, `needs` `rate limited…` | F12, RESULTADOS §1 | Task 14 contrato (parser); Task 15 caso stopped | `stopped` (sem `pid`; a regra limit-blocked só vale para sessão viva) |
| `e5f6a7b8` | limit-blocked viva e ociosa (limite semanal): `blocked`, `idle`, `tasks 0`, `queued 1` | F12 (tabela de §1) | Task 15 `activityOf` (a que decide a troca) | `limit-blocked` |
| `f6a7b8c9` | limit-blocked viva com `tasks 4` (`local_agent`, `local_bash`), `busy` | F12: `tasks > 0` continua `busy` | Task 15 `activityOf` | `busy` (`hasScheduledWork` = não: `kinds` não vazio, mas só `local_*`; não é limit-blocked) |
| `11aa22bb` | scheduled-loop: `kinds ["session_cron"]`, `selfWake true` | F13 | Task 15 `hasScheduledWork` = sim | `scheduled` |
| `22bb33cc` | scheduled-wakeup: `session_cron` + `inFlight.wake {at, reason, fires}` | F13 | Task 15 `hasScheduledWork` = sim | `scheduled` |
| `33cc44dd` | scheduled-monitor: `kinds ["monitor"]`, `fan[]`, `status busy` | F13 | Task 15 `hasScheduledWork` = sim | `scheduled` (vem antes de `busy`) |
| `44dd55ee` | scheduled-cron: one-shot ainda visível (`session_cron`, `selfWake true`, `job.state done`) | F13 | Task 15 `hasScheduledWork` = sim | `scheduled` |
| `55ee66ff` | foreign-settings: `--settings /tmp/outro.json`, viva e ociosa | §4 sessão estranha | Task 14 contrato (`respawnFlags`); classificação por caminho | `free` |
| `66ff7788` | no-settings: `respawnFlags` sem `--settings`, viva e ociosa | §9 `doctor` (rodaria no keychain) | Task 14 contrato | `free` |
| `77889900` | legacy-settings: `~/.claude/contas/ativa.json`, viva e ociosa | §4 sessão estranha, §10 migração | Task 14 contrato | `free` |
| `88990011` | pinned: `pins/admin1.json`, viva e ociosa | §4 sessão fixa | Task 14 contrato | `free` |
| `99001122` | viva, `job.state "running"` e `inFlight` sem `drainableMonitors` (`session_cron`) | F13 (forma logo depois do respawn) | Task 14 contrato (tolerância); Task 15 `hasScheduledWork` = sim | `scheduled` |
| `aa001122` | stale-state-without-pid: `state.json` com `session_cron`/`selfWake`, mas a entrada de `agents` sem `pid` | F13 (anomalia do stop) | Task 14 contrato; Task 15 `hasScheduledWork` = não (exige `pid`) | `stopped` |
| `agents.json` | 16 entradas (uma por caso acima), 13 com `pid`/`status` | F8, F14 (`startedAt` ≈ 0,7 s depois de `createdAt` nas vivas; igual a `createdAt` nas paradas) | Task 14 contrato; Task 15 `startedAt` | n/a |

Os `--settings` usados: `~/.local/state/switchboard/mux/bk.json` (mux), `~/.local/state/switchboard/pins/admin1.json`
(fixa), `~/.claude/contas/ativa.json` (legado), `/tmp/outro.json` (terceiros). `respawnFlags` com no máximo dois
`--allowed-tools`.
