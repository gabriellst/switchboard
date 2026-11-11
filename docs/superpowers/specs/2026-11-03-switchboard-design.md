# switchboard (`sb`) — design

> Status: **implementado** em 10/11/2026 (16 comandos; `README.md` e `SPEC.md` descrevem o que o código faz). Design aprovado em conversa em 03/11/2026; spikes de sessão feitos (F12–F14). Onde o código diverge deste texto, vale o código: ver §14 (Desvios).
> Revisão de 03/11 (tarde): **prioridade e hot-swap são por mux, não por conta** [usuário] (§4, §5).
> Substitui o `~/.local/bin/claude-conta` (Python, 900 linhas) quando estiver pronto.
> Marcação: **[usuário]** = decidido pelo usuário · **[minha escolha]** = decisão de quem escreveu o
> design, que o usuário viu e não contestou, mas pode mudar · **[builder]** = fica para quem implementa.

## 1. Intenção e porquê

O usuário roda dezenas de sessões do Claude Code em segundo plano (o daemon de `claude agents`),
organizadas em abas do **cmux**. Cada aba é uma *view* `claude agents --cwd <pasta>` de um projeto
(hoje: `bk-company`, `pessoal`, `berzerk/berzerk-club`). Ele tem várias contas Claude (assinaturas)
e quer distribuir o trabalho entre elas.

O `claude-conta` de hoje só sabe "uma conta ativa para tudo, menos o berzerk" (mais um `fixar`
por sessão acrescentado em 03/11). Isso gerou atrito real: rodar `/conta admin1` numa sessão
mudava a conta de **todas**, e a sessão que queria ficar na outra conta era arrastada.

O `switchboard` é uma CLI no molde do `plugboard` (`gabriellst/plugboard`) que:

1. **liga uma conta a cada mux** (cada aba/projeto) **[usuário]**;
2. **troca a conta de um mux quando ela estiver acabando** (hot-swap), à mão ou sozinho **[usuário]**;
3. **troca só uma sessão específica**, quando quiser **[usuário]**;
4. **mostra o uso de cada conta e de todas juntas**: quanto já foi, se resetou, quando reseta **[usuário]**;
5. **respeita uma ordem de prioridade por mux** para escolher o destino da troca **[usuário]**;
6. **cada mux tem o seu conjunto de contas permitidas e o seu conjunto de contas de hot-swap**
   (o `pool`, ordenado); uma conta pode estar no pool de um mux e só ser permitida em outro, ou
   nem aparecer **[usuário, 03/11 tarde]**.

Sucesso = o usuário abre o cmux, cada aba trabalha na sua conta, nunca mais pensa em limite:
quando uma conta acaba, o mux migra sozinho para a próxima e volta quando ela resetar.

## 2. Objetivos, não-objetivos, anti-objetivos

**Objetivos**
- Conta por mux, override por sessão, hot-swap manual e automático com prioridade e pool, retorno à
  conta preferida no reset, painel de uso por conta e total, migração completa do `claude-conta`.

**Não-objetivos (v1)**
- Trocar a conta de uma sessão **no meio de um turno** sem reiniciá-la — tecnicamente impossível
  (ver §3, fato F4).
- Retomar sozinho o turno que falhou por limite (enviar "continue" automaticamente). v1 notifica;
  o usuário abre a sessão e pede para continuar **[minha escolha]**.
- Trocar a conta de sessões interativas (`claude` em primeiro plano, `-p`): elas pegam a conta do
  mux ao iniciar e só mudam no próximo início.
- Medir a conta do keychain **[minha escolha]** (não chegar perto do keychain).
- Distribuição pública (npm). v1 instala local; tarball de Release como o plugboard fica para depois.
- Multiusuário/equipe.

**Anti-objetivos (falha mesmo que funcione)**
- **Mexer no login do keychain** (`/login`, `claude auth login`, gravar ou ler a credencial do
  keychain). É a conta do berzerk; o berzerk nunca pode ser arrastado.
- **Imprimir, logar ou gravar token fora do diretório de tokens.** Nem em `--json`, nem em erro.
- **Interromper um turno em andamento** para trocar de conta. Troca só com a sessão livre.
- **Deixar uma sessão rodar calada na conta errada.** O caso perigoso é o JSON de settings inválido,
  que o Claude ignora e cai no keychain (F6). O `sb` tem que impedir e detectar isso.
- **Gastar uso de verdade para medir uso.** A sonda tem que ser mínima.
- **Repassar `CLAUDE_CODE_OAUTH_TOKEN` herdado** para um `claude` que possa subir o daemon: o
  daemon herdaria o token e todas as sessões (inclusive berzerk) iriam junto.

## 3. Fatos verificados (spikes de 03/11/2026, Claude Code 2.1.317)

Estes fatos são restrições. Foram medidos, não supostos.

- **F1 — Uso legível pelos cabeçalhos.** `POST https://api.anthropic.com/v1/messages` com o token
  OAuth da conta (`Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`,
  `anthropic-version: 2023-06-01`), `model: claude-haiku-4-5`, `max_tokens: 1`, system
  `"You are Claude Code, Anthropic's official CLI for Claude."`, devolve 200 com:
  `anthropic-ratelimit-unified-5h-utilization` (0–1), `-5h-reset` (epoch s), `-5h-status`
  (`allowed`…), `-7d-utilization`, `-7d-reset`, `-7d-status`, `-status`, `-reset`,
  `-representative-claim` (`five_hour`), `-overage-status`, `-overage-disabled-reason`,
  `-fallback-percentage`. (Não testei se o system prompt é obrigatório — o builder pode verificar.)
- **F2 — O endpoint de uso do `/usage` não serve.** `GET /api/oauth/usage` responde 403
  `oauth_scope_insufficient` (exige `user:profile`); o token do `claude setup-token` só tem
  `user:inference`. Uma conta tomou 429 no mesmo endpoint.
- **F3 — Contas duplicadas existem.** `admin1` e `outra` (salvas no `claude-conta`) devolveram
  utilização e resets idênticos: são a mesma conta logada duas vezes.
- **F4 — Não há troca de token a quente.** (a) Trocar o conteúdo do arquivo de `--settings`
  (`env.CLAUDE_CODE_OAUTH_TOKEN`) com o processo rodando: o processo continua com o token antigo.
  (b) `apiKeyHelper` com `CLAUDE_CODE_API_KEY_HELPER_TTL_MS=3000`: trocar o token que o helper
  devolve no meio da execução também não muda nada (testado em `-p`). Conclusão: trocar a conta de
  uma sessão = **parar a sessão e reabri-la** com o mesmo id (a conversa continua).
- **F5 — `apiKeyHelper` aceita token OAuth, mas desliga os conectores do claude.ai** ("claude.ai
  connectors are disabled because … another auth source is set"). Por isso o `sb` usa
  `env.CLAUDE_CODE_OAUTH_TOKEN` no settings, nunca `apiKeyHelper` **[minha escolha]**.
- **F6 — Settings ausente vs inválido.** `--settings <arquivo inexistente>` ou link quebrado:
  `Error: Settings file not found`, exit 1, não inicia (seguro). **JSON inválido: só avisa, ignora o
  arquivo e roda no keychain** (perigoso). `{}`: roda no keychain (é como se representa "keychain").
- **F7 — A view repassa `--settings`.** `claude agents --settings <x>`: "Settings file or JSON string
  to apply to the agent view and dispatched sessions". Sessões despachadas por ela nascem com
  `--settings <x>` nos `respawnFlags`.
- **F8 — Estado das sessões.** `claude agents --json --all` lista `{id, kind ('background'|…),
  status ('busy'|…), state ('working'|'blocked'|…), pid, cwd, name}`. O estado persistente fica em
  `~/.claude/jobs/<id>/state.json` com `respawnFlags` (array de argv), `inFlight {tasks, queued}`,
  `cwd`, `providerEnv` (vazio hoje). `claude stop <id>` para; a sessão volta **com o mesmo id e os
  `respawnFlags` gravados** quando o usuário a abre. O daemon reescreve `state.json` enquanto a
  sessão vive — só editar `respawnFlags` com a sessão parada (relendo antes de gravar).
- **F9 — Login sem keychain.** `claude setup-token` rodado com `CLAUDE_CONFIG_DIR` temporário,
  num pseudo-terminal, imprime um link de autorização e depois um token `sk-ant-oat01-…` de 1 ano,
  sem tocar o keychain. O `claude-conta` faz isso hoje (`setup_token_pty`, linhas ~397–460).
- **F10 — Variáveis que vazam.** Ao chamar `claude` de dentro de uma sessão, remover do ambiente:
  `CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_MESSAGING_SOCKET,
  CLAUDE_CODE_MESSAGING_TOKEN, CLAUDE_JOB_DIR, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_SESSION_ATTENDED, CLAUDE_PID, CLAUDE_CODE_AGENT, CLAUDE_CONFIG_DIR` (lista do
  `claude-conta`, `VARS_SESSAO`).
- **F11 — `claude-conta` reescreve `--settings` só dentro de `~/.claude/contas/`** (`separar_settings`
  compara o diretório do caminho). Relevante só durante a migração, enquanto os dois coexistirem.
- **F12 — Estado depois de um turno que falha por limite. [spike 03/11]** `job.state == "blocked"` e
  `tempo "blocked"`, `needs` começando com `rate limited — wait and retry` (o texto traz a janela, `5-hour` ou
  `weekly`, e o reset), e **`inFlight.queued == 1` mesmo sem trabalho nenhum**: a regra "livre = `queued == 0`" nunca
  pararia essa sessão. Sessão viva presa por limite (n = 1 por caso) com `tasks == 0`: `status` `idle` com pid; com `tasks > 0`
  (agentes/bash em segundo plano): `status` `busy`. Sessões históricas, paradas com o limite pendente: `blocked`,
  sem `status` e sem `pid`. Não observado: a sessão entrar no limite, sair dele no reset, e o item `queued` rodar de
  novo com outro token. Dados: `spikes/sessoes/RESULTADOS.md` §1.
- **F13 — Marcadores de trabalho agendado. [spike 03/11]** Observados com n = 1 por mecanismo, na sessão testada, em
  `state.json` `inFlight`: `/loop` com intervalo e CronCreate one-shot = `kinds ["session_cron"]` e `selfWake true`;
  ScheduleWakeup (`/loop` dinâmico) = `session_cron` mais `inFlight.wake {at, reason, fires}` (e `selfWake`
  depois da 1ª leitura); Monitor = `kinds ["monitor"]` mais `fan[]`. `drainableMonitors` ficou 0 o tempo todo e
  `queued` ficou 0: não são marcadores. `status` `idle` entre ticks não prova ausência de agendamento (e `busy` no
  Monitor não prova turno em andamento). `agents.state` e `job.state` divergem no mesmo instante: decidir por
  `job.state`/`inFlight`. Depois de `stop` + `respawn`: o loop recorrente e o CronCreate one-shot **sobreviveram**
  (o one-shot ficou invisível: `kinds []`, `tasks 0` até disparar), ScheduleWakeup e Monitor **morreram**; tick perdido
  na parada não é reposto. Sem `pid`, o `state.json` pode mentir (anomalia: `stop` de sessão `done` não o reescreveu
  e `inFlight`/`selfWake` ficaram obsoletos). Logo depois do respawn o `job.state` pode ser `running` e `inFlight`
  vir sem `drainableMonitors`: o parser tolera chave ausente. **Risco aceito:** a regra do §4 não vê um one-shot de
  CronCreate pendente depois de um respawn. Dados: `RESULTADOS.md` §3.
- **F14 — Reabrir sessão parada e `startedAt`. [spike 03/11]** `claude respawn <id>` de sessão parada e ociosa mantém
  `id`, `sessionId` e `respawnFlags`, ganha pid novo, não cria job; relê o `--settings` dos `respawnFlags` (provado só
  para ele, por um respawn que crashou com o arquivo ausente). Mas imprime "respawned" até quando a sessão cai logo
  depois: o sucesso se julga por `agents --json`/`state.json`, não pelo stdout. `claude --bg --resume <id>` com flags
  (até idênticos aos salvos) ou com id curto **sempre criou uma cópia** (id e `sessionId` novos) nos 3 testes; a forma
  sem flags não foi testada (a ajuda do claude diz que ela continua sob o mesmo id). `agents.startedAt` = momento em
  que o host foi (re)aberto, ≈ 0,5–0,7 s depois da reivindicação do processo reserva; mudou no respawn testado; **não**
  é o início do processo do SO; em sessão parada é o `createdAt` do job, então só serve para sessão viva. Dados:
  `RESULTADOS.md` §2.

## 4. Modelo

| Conceito | O que é |
|---|---|
| **Conta** | Um token de assinatura com nome. Só o registro: **sem prioridade e sem pool próprios** (isso é de cada mux). |
| **keychain** | Conta especial e reservada: o login do keychain. Settings = `{}`. Nunca medida, nunca no pool, nunca escrita. |
| **Mux** | Nome + `root` (pasta) + `account` (a conta **preferida**) + `accounts` (as contas que o mux **pode usar**) + `pool` (as contas de **hot-swap**, **em ordem = prioridade**). Corresponde a uma aba do cmux rodando `sb agents <mux>`. Invariantes **[minha escolha]**: `account ∈ accounts`; `pool ⊆ accounts`; `pool` vazio = o mux nunca troca sozinho (substitui o antigo `swap: false`). |
| **Conta atual do mux** | A conta que o mux está usando agora. Igual à preferida, exceto durante um swap. Estado de runtime, não config. |
| **Sessão do mux** | Sessão em segundo plano cujo `--settings` aponta para o arquivo do mux. **A pertença é pelo caminho do settings, não pela pasta** **[minha escolha]**. A pasta (`root`, a mais profunda vence) só escolhe o mux quando a sessão nasce fora de uma view (wrapper) ou na adoção/migração. |
| **Sessão fixa (pin)** | Sessão cujo `--settings` aponta para `pins/<conta>.json`. Fica fora de todo swap. |
| **Sessão estranha** | Qualquer outra (`--settings` de terceiros, ou legado do `claude-conta`). O `sb` não mexe, só reporta (e a migração adota). |

### Regras de troca **[usuário]**, formalizadas **[minha escolha]**

Uma conta está **disponível** quando a última medição diz `5h-utilization < threshold.fiveHour`,
`7d-utilization < threshold.sevenDay` e status `allowed` — ou quando o reset da janela que a
esgotou já passou (mesmo sem medição nova).

A cada avaliação, para cada mux com `pool` não vazio:

```
desejada(mux) =
  preferida                         se preferida disponível
  senão, se preferida ∉ mux.pool    → preferida   (fica parado nela e avisa)   [usuário]
  senão, se a atual já é uma reserva válida (do pool, disponível, distinta da preferida)   → fica  [minha escolha, 03/11: trocar custa parar sessões]
  senão, a 1ª conta disponível de mux.pool (na ordem do pool), distinta da preferida e sem duplicatas
  senão (nenhuma disponível)        → fica na atual e avisa
```

A ordem do `pool` é **do mux**: a mesma conta pode ser a 1ª na fila de um mux e a 2ª na de outro,
e pode estar no pool de vários muxes ao mesmo tempo (cada mux anda na própria fila) **[minha escolha]**.

- **Medição `unknown` (falha da nossa sonda: rede, 5xx) nunca, sozinha, faz o mux sair de uma conta que ainda é um lugar válido** [minha escolha, 03/11]: parar sessões por causa de um erro nosso custaria duas paradas por mux. `rate-limited` (429), token morto e esgotamento medido, sim, contam como esgotada.
- **Nunca ficar numa conta esgotada ou morta com a preferida utilizável**: a histerese do retorno segura uma reserva ainda boa, não uma esgotada [minha escolha, 03/11].
- **Override manual esgotado** volta à regra normal ("segue a fila normal": a preferida volta a valer) [minha escolha, 03/11].
- Isso dá o **retorno no reset** de graça: quando a preferida volta a estar disponível, ela é a
  desejada outra vez **[usuário: "o ideal é pegar sempre ao resetar"]**.
- Um mux numa conta reserva (fora do preferido) que também esgota vai para a próxima da fila.
- **Contas duplicadas** contam como uma só (para destino e para o total do pool).
- Histerese para não oscilar: **[builder]** (ex.: só voltar quando o reset passou ou a utilização caiu
  X pontos abaixo do limite).
- Mux com `pool` vazio nunca troca sozinho (o berzerk). Só `sb swap <mux> <conta>` manual, com a
  conta escrita por extenso, muda um mux desses **[usuário: recomendado aceito]**.
- **`accounts` é o limite duro:** `sb swap <mux> <conta>` e `sb pin <sessão> <conta>` recusam uma
  conta que não esteja em `accounts` do mux da sessão **[minha escolha]**.
- **`sb swap` manual vale até o próximo reset da conta preferida** **[usuário]**: o `runtime.json`
  guarda `{ mux, account, until: <epoch do próximo reset da preferida> }`; até lá o `watch` trata a
  preferida como indisponível *para esse mux* (escolhe a conta manual se ela estiver disponível; se
  ela esgotar, segue a fila normal). Passado o reset, o override expira e vale a regra de sempre.
  `sb swap <mux> --clear` desfaz antes. O painel mostra o override e quando expira.
- **Sessões com trabalho agendado não são paradas pela troca** **[usuário: "sim, usamos" loops,
  despertares agendados e monitores]**. Nessas, o `watch` não chama `claude stop`; elas ficam na
  conta antiga e passam para a nova na próxima vez que pararem por conta própria (ou quando o
  usuário as reabrir). Se a conta antiga estiver **esgotada**, o `watch` notifica em vez de parar
  ("sessão X tem trabalho agendado e ficou na conta esgotada Y") **[minha escolha]**. Detectar
  "trabalho agendado" foi medido no spike de 03/11 (F13). Regra **[spike 03/11, provisória: n = 1 por mecanismo]**:

  ```
  hasScheduledWork(job, agent) =
    agent tem pid
    && job.inFlight != null
    && ( inFlight.kinds ∋ "session_cron"     // /loop, ScheduleWakeup, CronCreate vivos
         || inFlight.kinds ∋ "monitor"       // Monitor vivo
         || inFlight.wake != null )          // ScheduleWakeup pendente
  ```

  O `pid` vem da entrada de `claude agents --json --all`, não do `state.json` (sem `pid` o `state.json` pode estar
  obsoleto). `selfWake` é só uma dica. Não usar `status`, `queued`, `drainableMonitors`, `tasks > 0`, `fan` nem o
  `detail`. Parsers toleram `inFlight`, `selfWake`, `wake`, `fan` e `drainableMonitors` ausentes.
  **Risco aceito [spike 03/11]:** a regra não enxerga um one-shot de CronCreate pendente depois de um respawn (o
  `state.json` mostra `kinds []`, `tasks 0`, e o cron dispara mesmo assim). Então, em linguagem simples: se uma
  sessão foi reaberta e tinha um lembrete único agendado, o `watch` pode achar que ela está livre, parar na troca de
  conta, e o lembrete se perde ou sai na conta antiga. Aceito para a v1. Mitigações **propostas, não testadas**: nunca
  agir enquanto `tempo == "active"` ou `status == "busy"` (também cobre a janela de ~7 s no meio do tick do
  ScheduleWakeup, quando os marcadores somem); tratar sessão reaberta há pouco como "assumir trabalho agendado".

### Aplicar uma troca

1. Repontar o link `mux/<mux>.json` para o token da conta nova (troca atômica: link temporário +
   rename). Sessões **novas** do mux já nascem na conta nova (o settings é lido no início).
2. Para cada sessão viva do mux iniciada antes da troca (`startedAt` anterior à troca; vale só para sessão viva, F14): se **livre**
   (`status != 'busy'` e `inFlight.tasks == 0` e (`inFlight.queued == 0` ou a sessão está **presa por limite**, abaixo)
   e sem trabalho agendado), `claude stop <id>` e esperar parar. Ocupadas
   esperam o fim do turno (o `watch` tenta de novo). **Nunca** interromper um turno.
3. Não é preciso reescrever `respawnFlags`: eles já apontam para `mux/<mux>.json`, que agora
   aponta para a conta nova.
4. Notificar (macOS, `osascript`) e registrar no log.

Turno que falha porque a conta bateu no limite: a sessão fica livre, cai no passo 2, e ao ser
reaberta já está na conta nova; o usuário pede "continue".
**Presa por limite [spike 03/11, F12, provisória]:** a sessão conta como **presa por limite** quando
`job.state == "blocked"` e `job.needs` começa com `rate limited` e `inFlight.tasks == 0` e `status != "busy"`;
`inFlight.queued` pode ser 1 (fica em 1 sem trabalho nenhum, então `queued == 0` não serve como critério). Presa por
limite conta como livre. Sessão com `tasks > 0` continua `busy`, mesmo bloqueada por limite, e espera.
**Pergunta aberta:** o item `queued` roda de novo com o token novo quando a sessão é reaberta? Não dá para testar
sem gastar uso de verdade (anti-objetivo); o primeiro uso real do `watch` responde. **Reabrir por comando fica fora
da v1** (F14): o usuário reabre; `claude respawn` mantém o id mas imprime "respawned" mesmo quando a sessão cai logo depois, e `--bg --resume` com flags cria
cópia. Ideia para a v2: `sb swap --reopen` via `respawn`, julgando o sucesso por `agents`/`state.json`.

## 5. Configuração e estado

**[minha escolha]**, no molde do plugboard (JSONC com `$schema`, schema zod como fonte única,
`strictObject`: chave desconhecida é erro).

`~/.config/switchboard/config.jsonc` (sem segredo; pode ir para dotfiles):

```jsonc
{
  "$schema": "…/schema.json",
  "switchboard": 1,
  "accounts": {                         // só o registro; os tokens ficam em tokens/
    "gabriel": {}, "admin1": {}, "cliente-x": {}
  },
  "swap": {
    "auto": true,
    "threshold": { "fiveHour": 0.9, "sevenDay": 0.95 },
    "returnOnReset": true,
    "probeEvery": "5m"
  },
  "default": "bk",                      // mux para pastas que não casam com nenhum root [minha escolha]
  "mux": {
    "bk": {
      "root": "~/Desktop/Projetos/bk-company",
      "account": "gabriel",                          // preferida
      "accounts": ["gabriel", "admin1", "cliente-x"], // pode usar
      "pool": ["gabriel", "admin1"]                  // hot-swap; a ordem é a prioridade
    },
    "pessoal": {
      "root": "~/Desktop/Projetos/pessoal",
      "account": "admin1",
      "accounts": ["admin1", "gabriel"],
      "pool": ["admin1", "gabriel"]                  // ordem própria, diferente da do bk
    },
    "berzerk": {
      "root": "~/Desktop/Projetos/berzerk",
      "account": "keychain",
      "accounts": ["keychain"],
      "pool": []                                     // nunca troca sozinho
    }
  }
}
```

`~/.local/state/switchboard/` (dir 700; nada aqui é versionado):

| Caminho | Conteúdo |
|---|---|
| `tokens/<conta>.json` | `{"env":{"CLAUDE_CODE_OAUTH_TOKEN":"sk-ant-oat01-…"}}`, modo 600 |
| `tokens/keychain.json` | `{}` |
| `mux/<mux>.json` | link → `tokens/<conta atual>.json` |
| `pins/<conta>.json` | link → `tokens/<conta>.json` |
| `usage.json` | última medição por conta (sem token): utilizações, resets, status, `measuredAt`, grupo de duplicata |
| `runtime.json` | conta atual de cada mux, último swap (quando, de→para, motivo) |
| `watch.json` | batimento do `sb watch`: `{ pid, lastTick }` (apagado ao sair limpo); `sb pin`/`sb unpin` avisam se o watch não está rodando |
| `log/` | `watch.log`, `login.log` |

## 6. Medição de uso

- Sonda = F1, uma chamada por **token distinto**, a cada `probeEvery` no `watch` e sob demanda em
  `sb usage` (com cache: não sondar de novo se a medição tem menos de ~60 s) **[minha escolha]**.
- **Duplicatas:** duas contas com os mesmos `5h-reset`, `7d-reset`, `5h-utilization` e
  `7d-utilization` em duas medições seguidas formam um grupo; o painel mostra uma e lista as
  outras como "mesma conta que …" **[minha escolha]**. O builder pode permitir `"sameAs"` explícito.
- **Total do pool** = média das utilizações das contas distintas que estão no `pool` de algum mux, por janela. Só significa
  "quanto do total já foi" se os planos forem iguais; o painel diz isso **[minha escolha]**.
- keychain: "não medido".
- Erros de sonda (401 = token morto, 429, rede) aparecem no painel e no `doctor`; conta com token
  morto fica indisponível.

## 7. Comandos

Todos com `--json` quando produzem dados; nada interativo por padrão; exit codes como o plugboard
(`0` ok · `1` verificação falhou · `2` config inválida · …) **[minha escolha]**.

| Comando | Faz |
|---|---|
| `sb` · `sb usage [--json] [--watch]` | Painel (abaixo). `--watch` redesenha a cada N s |
| `sb login <conta> [--terminal] [--attach <mux> [--pool] [--at N] [--preferred]]` | F9; abre o navegador, valida com uma sonda, grava o token (600) e registra a conta (sem prioridade nem pool: isso é do mux). `--terminal`: colar o token |
| `sb accounts [--json]` · `sb accounts rm <conta> --yes` | **Central de contas** [usuário, 03/11 tarde 2]: todas as contas registradas (anexadas ou não): estado do token, duplicatas, uso, e em quais muxes aparecem (preferida / pool / permitida); `rm` apaga o registro e o token (recusa conta anexada) |
| `sb attach <conta> <mux> [--pool] [--at N] [--preferred]` · `sb detach <conta> <mux>` | **[usuário, 03/11 tarde 2]** A conta nasce sem mux (`sb login`); `attach` a põe em `accounts` do mux (e, com `--pool`, na fila; `--preferred` a faz preferida). Atalho: `attach` de conta que não existe faz o login antes (igual a `login --attach`). `detach` recusa a preferida e a conta atual do mux |
| `sb mux [add <nome> --root <pasta> --account <conta> [--accounts a,b] [--pool a,b] \| set <nome> … \| rm <nome>]` | Gerencia muxes; `--pool` define a fila (a ordem é a prioridade) |
| `sb agents [mux]` | `exec claude agents --cwd <root> --settings <state>/mux/<mux>.json`. Sem nome: deduz pela pasta atual |
| `sb run [mux] -- <args>` | `claude <args> --settings …/mux/<mux>.json` (interativo) |
| `sb swap <mux> [conta]` | Troca manual; sem conta = a desejada pela regra (§4) ignorando a preferida |
| `sb pin <sessão> <conta>` · `sb unpin <sessão>` | Fixa/solta (reescreve `respawnFlags` com a sessão parada; se ocupada, espera o fim do turno em segundo plano, como o `claude-conta fixar`) |
| `sb watch` | Laço: mede, avalia, aplica swaps (se `auto`) ou notifica (se não), aplica pins pendentes |
| `sb install` | LaunchAgent do `watch` (KeepAlive, sobrevive a reboot), wrapper zsh, comando `/sb` |
| `sb doctor [--fix]` | Ver §9 |
| `sb migrate [--simular]` | Ver §10 |

Painel (números reais de 03/11 11:30):

```
$ sb
conta     5h              semanal          muxes
gabriel   ░░░░░░░░░░  1%  ██░░░░░░░░ 15%   bk (preferida) · pessoal (2º do pool)
          reseta 15:50    reseta 06/11
admin1    ██░░░░░░░░ 24%  ████░░░░░░ 38%   pessoal (preferida) · bk (2º do pool)
  └ outra (mesma conta que admin1)
keychain  não medido                       berzerk
──────────────────────────────────────────────────────────
mux       atual     preferida  pool (ordem = prioridade)
bk        gabriel   gabriel    gabriel → admin1
pessoal   admin1    admin1     admin1 → gabriel
berzerk   keychain  keychain   sem hot-swap
──────────────────────────────────────────────────────────
total     5h 13% · semanal 27%      auto-swap ligado (90% / 95%)
sessões fixas: 95b0deff → admin1
medido há 2 min
```

## 8. Integrações

- **Wrapper zsh** (`claude()` como o `wrapper.zsh` do `claude-conta`): com `--settings` explícito → passa direto
  (dentro ou fora de uma sessão Claude: não há passagem direta por `CLAUDECODE`, ver §14); subcomandos de manutenção
  (`auth`, `stop`, `rm`, `mcp`, `update`, `setup-token`, `daemon`…) → passa direto sem token;
  senão acrescenta `--settings <state>/mux/<mux da pasta ou default>.json`. Sempre sem
  `CLAUDE_CODE_OAUTH_TOKEN` no ambiente (anti-objetivo).
- **cmux:** cada aba roda `sb agents <mux>`. Sem integração com a API do cmux na v1.
- **Comando `/sb`** dentro do Claude: arquivo em `~/.claude/commands/sb.md` no formato do
  `conta.md` atual (`!sb $ARGUMENTS`, `disable-model-invocation: true`).
- **Notificações:** `osascript` (como hoje); desligáveis por env para testes.
- **LaunchAgent:** `~/Library/LaunchAgents/<id>.switchboard.watch.plist`.

## 9. `doctor`

Erros: link de mux/pin quebrado (F6: a sessão não vai abrir); JSON de token inválido (F6: cairia no
keychain calada); token sem `CLAUDE_CODE_OAUTH_TOKEN`; token morto (401); permissão de
`tokens/*.json` diferente de 600; sessão em segundo plano sob o root de um mux **sem `--settings`**
(rodaria no keychain); view `claude agents` aberta sem `--settings` do `sb`.
Erros de configuração por mux: `account ∉ accounts`; `pool ⊄ accounts`; conta de `accounts`/`pool`
sem token registrado.
Avisos: contas duplicadas dentro do mesmo `pool` (contam como uma); mux com `pool` não vazio cuja
preferida está fora do `pool` (ele nunca sai dela sozinho: o `sb` avisa, como você decidiu, mas é
fácil ser engano); sessões estranhas (legado `~/.claude/contas/`); `watch` parado.
`--fix`: recria links, corrige permissões, adota sessões sem settings (pelo root).

## 10. Migração do `claude-conta` (`sb migrate`) **[usuário: "depois vamos trocar todo nosso lance por ela"]**

Com `--simular` primeiro, mostrando tudo o que faria:
1. Importar `~/.claude/contas/<nome>.json` (exceto `ativa.json`; `padrao.json` = keychain) para
   `tokens/`; cada mux importado recebe `accounts` = todas as importadas e `pool` = a conta ativa primeiro, depois ordem alfabética (o mux do keychain: `pool` vazio)
   **[minha escolha]**; sinalizar duplicatas (F3).
2. Criar muxes: um por raiz de `~/.claude/contas/excluir` (conta keychain, `pool: []`) e um por
   view `claude agents --cwd` aberta (conta = a ativa atual).
3. Reescrever `respawnFlags` das sessões em segundo plano **paradas**: `~/.claude/contas/ativa.json`
   → `mux/<mux pela pasta>.json`; `~/.claude/contas-fixas/<c>.json` → `pins/<c>.json`. Vivas: na
   próxima vez que estiverem livres (via `watch`), com o mesmo cuidado de F8.
4. Parar o vigia do `claude-conta`; trocar a linha do wrapper no `~/.zshrc`; trocar `/conta` por `/sb`.
5. Não apagar nada do `claude-conta`: mover para um backup e dizer onde está.
6. Imprimir os comandos para reabrir cada aba do cmux com `sb agents <mux>`.

## 11. Stack (molde do plugboard) **[minha escolha, seguindo o pedido]**

TypeScript ESM; `bun` para desenvolver e testar (`bun test`); `tsdown` gera `dist/` para Node ≥ 20;
CLI em `citty` (subcomandos carregados sob demanda); `zod` como fonte única do schema (gera
`schema.json`); `jsonc-parser`. `core/` não conhece terminal (retorna dados, não imprime, não sai do
processo); `commands/` finos; `report.ts` renderiza; erros com `EXIT`. Identificadores em inglês,
mensagens ao usuário em português. `README.md` e `SPEC.md` em português.
Testes com um `claude` falso (variável `SWITCHBOARD_CLAUDE` apontando para um binário de teste) e
HTTP falso para a sonda; nenhum teste toca `~/.claude` real nem a API.
Pseudo-terminal para o `setup-token`: **[builder]** (`node-pty`, `script -q /dev/null` do macOS, ou
`Bun.spawn` com pty se disponível).

## 12. Riscos

- O formato de `state.json`, `claude agents --json` e dos cabeçalhos é interno do Claude Code e pode
  mudar numa atualização. Isolar cada um num adaptador em `core/` com teste de contrato; o `doctor`
  avisa quando o formato não for o esperado.
- Termos de uso: usar várias assinaturas e alternar entre elas por limite é decisão do usuário; vale
  conferir os termos do plano.
- A sonda consome um pouquinho do uso de cada conta (1 token de saída a cada 5 min por conta).

## 13. Deixado para o builder

Histerese do retorno; intervalo do laço do `watch` (o `claude-conta` usa 30 s); formato exato do
`--json`; layout do painel em telas estreitas; nomes internos dos módulos; detalhes de
concorrência entre `watch` e comandos manuais (lock de arquivo); `sb swap --reopen` via `claude respawn` (v2, F14); como o `pin` em segundo plano é
supervisionado (processo desanexado vs fila do `watch`).

## 14. Desvios (o que a implementação fez diferente do design)

Registrados durante a execução; o `SPEC.md` descreve o comportamento final.

**Comandos que o design não previa**
- `sb which [pasta]`: o wrapper do zsh o chama; falha com exit 1 se o `claude` ignoraria o settings (falha fechada, F6).
- `sb watch --once [--json]` (um ciclo e sai), `sb install --simular`, `sb migrate --finish [--simular]`.
- `sb accounts`, `sb attach`, `sb detach`, `sb login --attach` (já em §7, de 03/11 tarde).

**Troca de conta**
- O algoritmo de §4 foi revisto na execução (reserva atual que ainda serve é mantida; `unknown` nunca empurra sozinho; override esgotado vira regra normal) e é o do `desiredAccount`; o `SPEC.md` §5.2 o descreve passo a passo.
- Histerese do retorno: margem fixa de 0,10 abaixo do limite nas duas janelas (ou reset passado); não é configurável.
- Cooldown de 5 minutos entre duas trocas automáticas do mesmo mux (salvo conta atual esgotada); no máximo 3 `claude stop` por ciclo do `watch`, com recuo quando uma parada falha. Não estavam no design.
- `swap.auto: false` faz o `watch` só avisar, uma vez por destino.
- O `watch` conclui uma troca interrompida (link já na conta nova, `since` não gravado) e move um `runtime.json` corrompido para o lado em vez de travar.
- Sessão viva cujo `state.json` não tem `inFlight` (claude antigo) conta como ocupada e nunca é reiniciada pelo `sb`; sessão com trabalho agendado nunca é parada.
- A troca manual vale até o `fiveHour.resetsAt` da preferida (ou agora + 5 h sem medição); mux sem pool não guarda override.

**Pin e fila**
- Pin/unpin de sessão ocupada não usa um processo desanexado: o pedido vai para `runtime.pending` e o `watch` aplica; o comando avisa se o `watch` não está rodando.
- Pedidos `adopt` (do `doctor --fix`) e `migrate` usam a mesma fila, e o destino é sempre recalculado a partir dos flags da sessão.

**Integrações**
- `sb run` e o wrapper põem `--settings` antes do primeiro `--` solto; uma flag com valor logo antes do `--` engole o `--settings`.
- Ordem do wrapper: subcomando de manutenção primeiro (sempre sem o token herdado), depois `--settings` explícito, depois o resto via `sb which`. **Não há ramo "dentro de uma sessão" (`CLAUDECODE`)**: a Bash tool do Claude Code carrega as funções do shell do usuário, então um agente que rodasse `claude --bg` ou `claude agents` numa sessão subiria o daemon com o token dela e arrastaria os muxes do keychain; dentro ou fora de uma sessão o `claude` sai sem o token herdado e com o `--settings` do mux da pasta; a linha do `~/.zshrc` tem um `else` que define um `claude()` recusando se o wrapper sumir.
- `sb install` grava o caminho absoluto do runtime (o do `PATH` que resolve para o mesmo binário): se o node mudar de lugar, rode de novo.
- O CLI ignora flags desconhecidas (citty); só subcomando desconhecido falha (exit 1).
- O lock do `watch` espera 250 ms (um lock de pid morto só é tomado depois do prazo); `sb usage` espera 1,5 s e cai na última medição.

**`doctor`**
- Códigos além dos de §9: `state.perms`, `account.unattached`, `link.orphan`, `session.legacy`, `session.foreign`, `view.legacy`, `claude.format`, `config.invalid`, `config.no-token`.
- Uma view com `--settings` em `pins/` é aceita.

**Migração**
- `sb migrate` **copia** o legado para `backup/migrate-<data>/` e só `--finish` o **move** (para `backup/finish-<data>/`), e só quando nada mais aponta para lá.
- Exige ao menos uma view `claude agents --cwd` aberta ou um `default` na config (o `default` nunca é o mux do keychain); recusa com exit 3 senão.
- Já roda o `sb install`. O `--simular` só acusa duplicatas pelo token idêntico; ao aplicar, também pela medição de uso.
- Não toca `~/.local/bin/claude-conta`.

**Ainda em aberto**
- F12: o item `queued` de uma sessão presa por limite roda de novo com o token novo? Só o primeiro uso real do `watch` responde.
- Reabrir sessão por comando (`sb swap --reopen` via `claude respawn`) segue fora da v1 (F14).

