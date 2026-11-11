# switchboard (`sb`)

**Uma conta do Claude Code por pasta, com troca automática quando ela acaba.**

Você tem mais de uma assinatura do Claude e dezenas de sessões em segundo plano
(`claude agents`), uma aba do cmux por projeto. O Claude Code só conhece uma conta por vez: a do
keychain. Trocar de conta no meio do dia arrasta todas as sessões junto, inclusive a que precisava
ficar onde estava, e quando o limite estoura a sessão simplesmente para.

O `sb` liga uma conta a cada **mux** (uma pasta de projeto, uma aba), abre o `claude` já com o
settings dela, mede o uso de cada conta, e quando a conta de um mux está acabando, move o mux para a
próxima da fila dele. Quando a conta preferida reseta, o mux volta para ela.

```
conta (token)  ←  mux/<mux>.json  ←  claude --settings <mux>.json   (cada sessão do mux)
tokens/pessoal.json   link do mux      sessões abertas por `sb agents`, `sb run`
tokens/trabalho.json
```

Trocar a conta de um mux é trocar para onde o link aponta e parar as sessões **livres** para que
reabram na conta nova. Nunca no meio de um turno: o Claude Code não troca de token com a sessão
rodando, e interromper o trabalho para trocar de conta seria pior que o limite.

## Instalação

Ainda não está publicado (nem no npm, nem em Release): a instalação é local, a partir da pasta do
projeto. Para **compilar** precisa do bun (`bun run build`); o CLI compilado roda em Node ≥ 20 puro. Precisa do `claude` no `PATH`. Foi feito para macOS: o `sb watch` roda
como LaunchAgent, as notificações usam `osascript` e o login usa o `script` do sistema.

```bash
cd switchboard
bun install
bun run build                        # gera dist/cli.js
mkdir -p ~/.local/bin
ln -s "$PWD/dist/cli.js" ~/.local/bin/sb
sb --version                         # 0.1.0
```

Para desenvolver: `bun test` · `bun run check` (tipos) · `bun run build`.

## Começando

```bash
sb login pessoal                     # abre o navegador; guarda o token (600) e registra a conta
sb login trabalho --terminal         # ou cola um token sk-ant-oat01-… já gerado

sb mux add app --root ~/projetos/app --account pessoal \
    --accounts pessoal,trabalho --pool pessoal,trabalho
sb mux add api --root ~/projetos/api --account trabalho \
    --accounts trabalho,pessoal --pool trabalho,pessoal

sb agents app                        # em cada aba do cmux: `claude agents` com o settings do mux
sb                                   # o painel de uso
sb install                           # watch em segundo plano, wrapper do zsh e comando /sb
```

Se o `~/.zshrc` ainda tem a linha `# claude-conta`, o `sb install` não mexe nele e manda rodar
`sb migrate` (veja "Migrar do `claude-conta`").

- `sb login` roda o `claude setup-token` num pseudo-terminal com um diretório de config temporário
  (nunca toca o keychain), valida o token com uma sonda de 1 token e só então grava. Sem terminal
  (por exemplo, `!sb login` dentro do Claude) ele desanexa, imprime o link de autorização e avisa o
  fim por notificação; o andamento fica em `login.log`. O `setup-token` tem limite de 15 minutos.
  `--attach <mux> [--pool | --at N] [--preferred]` já anexa a conta ao mux depois do login.
- `sb mux add` cria o mux e aponta o link para a conta preferida. O primeiro mux vira o `default`
  (o que vale para pastas fora de todo `root`). O `root` é absoluto ou começa com `~`. Sem
  `--accounts` o mux só pode usar a preferida; sem `--pool` ele **nunca troca sozinho**.
- O mux de uma pasta é o `root` mais profundo que a contém; fora de todos, o `default`.
  `sb agents` sem nome deduz o mux pela pasta atual.
- Conta que já existe entra em outro mux com `sb attach <conta> <mux> [--pool | --at N] [--preferred]`
  e sai com `sb detach <conta> <mux>` (recusa a preferida e a conta atual do mux). `sb attach` de uma
  conta que ainda não existe faz o login antes. `sb accounts` lista todas as contas, anexadas ou não;
  `sb accounts rm <conta> --yes` apaga o registro e o token (recusa conta anexada).
- Um mux na conta do keychain (o `claude` como ele é hoje) não precisa de login:
  `sb mux add avulso --root ~/projetos/avulso --account keychain`. O `keychain` nunca é medido, nunca
  entra em pool e nunca troca.
- `sb run [mux] -- <args>` abre um `claude` interativo no mux: `sb run app -- --model opus`. Tudo
  depois do `--` é do `claude`.

### A config

`~/.config/switchboard/config.jsonc` (ou `$XDG_CONFIG_HOME`; sem segredo, pode ir para dotfiles).
O `sb` edita preservando os comentários; chave desconhecida é erro (exit 2). O que não tem comando
(`swap`) se edita à mão; o `$schema` aponta para o `schema.json` do pacote.

```jsonc
{
  "switchboard": 1,
  "accounts": { "pessoal": {}, "trabalho": {} },      // só o registro; os tokens ficam no estado
  "swap": {                                           // tudo opcional; estes são os padrões
    "auto": true,                                     // false: o watch só avisa, não troca
    "threshold": { "fiveHour": 0.9, "sevenDay": 0.95 },
    "returnOnReset": true,                            // false: fica na reserva até ela esgotar
    "probeEvery": "5m"                                // 30s, 5m, 1h
  },
  "default": "app",
  "mux": {
    "app": {
      "root": "~/projetos/app",
      "account": "pessoal",                           // a preferida
      "accounts": ["pessoal", "trabalho"],            // as que o mux pode usar (limite duro)
      "pool": ["pessoal", "trabalho"]                 // hot-swap; a ordem é a prioridade
    }
  }
}
```

O estado (tokens, links, medições, logs) fica em `~/.local/state/switchboard/` (ou
`$XDG_STATE_HOME`), em modo 700. Nada ali é versionado.

## O painel

`sb` (ou `sb usage`) mede o uso de cada conta e mostra tudo numa tela. A medição reaproveita
resultados de até 1 minuto; `--json` não traz token; `--watch [--every N]` redesenha a cada N
segundos (padrão 30).

```
conta     5h              semanal          muxes
pessoal   ██░░░░░░░░ 24%  ████░░░░░░ 38%   app (preferida) · api (2º do pool)
          reseta 11/11    reseta 13/11
trabalho  █████████░ 93%  █████░░░░░ 50%   api (preferida) · app (2º do pool)
          reseta 11/11    reseta 13/11
keychain  não medido                       avulso
──────────────────────────────────────────────────────────
mux       atual     preferida  pool (ordem = prioridade)
app       pessoal   pessoal    pessoal → trabalho
api       trabalho  trabalho   trabalho → pessoal
avulso    keychain  keychain   sem hot-swap
──────────────────────────────────────────────────────────
total     5h 59% · semanal 44%      auto-swap ligado (90% / 95%)
          (média das contas do pool; só vale como "quanto do total" se os planos forem iguais)
sessões fixas: a1b2c3d4 → trabalho
medido agora
```

- A sonda é uma mensagem de 1 token no Haiku, uma por token distinto; o uso vem dos cabeçalhos
  `anthropic-ratelimit-unified-*` da resposta. É o único gasto de uso do `sb`.
- Duas contas que devolvem o mesmo uso em duas medições seguidas são tratadas como a mesma conta
  (aparecem como `└ outra (mesma conta que pessoal)` e contam uma vez no total e no destino da troca).
- Um override manual aparece na coluna `atual` (`trabalho (manual até 11/11)`).
- Se outro `sb` está gravando o estado, o painel mostra a última medição e avisa; nunca falha por isso.

## Troca de conta

### Automática (`sb watch`)

O `watch` roda um ciclo a cada 30 s: mede (a cada `probeEvery`), avalia cada mux que tem pool,
troca o que precisa, reinicia as sessões antigas que ficaram livres e aplica a fila de pins.

Uma conta **esgota** quando a janela de 5 h passa de `threshold.fiveHour` ou a semanal passa de
`threshold.sevenDay`, ou a API devolve um status que não é `allowed`, ou 429, ou 401 (token morto) —
até o reset daquela janela. O que o mux faz, na ordem:

1. **Preferida disponível**: o mux fica nela, ou volta para ela. Voltar de uma reserva exige que o
   reset tenha passado ou que o uso esteja pelo menos 10 pontos abaixo do limite nas duas janelas
   (para não oscilar). Com `returnOnReset: false` o mux só deixa a reserva quando ela esgota.
2. **Preferida esgotada**: vai para a primeira conta do `pool`, na ordem, que esteja disponível (e
   que não seja cópia da preferida). Se já está numa reserva que serve, **fica** nela: a ordem do pool
   escolhe o destino, não faz o mux pular entre reservas.
3. **Preferida esgotada e fora do pool**: o mux não sai dela e o `sb` avisa.
4. **Nenhuma disponível**: fica onde está e avisa.

Uma falha da nossa sonda (rede, 5xx) **nunca**, sozinha, tira o mux de uma conta que ainda serve:
parar sessões por um erro nosso custaria duas paradas. Dois muxes podem ter a mesma conta em
posições diferentes da fila; cada mux anda na própria.

Depois de trocar o link, o `watch` para as sessões antigas do mux que estão **livres** (sem turno,
sem tarefa em segundo plano, ou paradas por limite de uso) e mantém o resto:

| Sessão | O que o `sb` faz |
|---|---|
| livre, ou presa por limite de uso | `claude stop`; ela reabre na conta nova quando você abre |
| num turno, com tarefa em andamento | espera o fim do turno; o `watch` tenta de novo |
| com `/loop`, ScheduleWakeup ou Monitor vivo | **nunca** é parada; se a conta antiga está esgotada, avisa por notificação |
| que chamou o `sb` (`/sb swap` de dentro dela) | nunca é parada; fica na espera |
| viva, sem `inFlight` no `state.json` (claude antigo) | tratada como ocupada; nunca é reiniciada pelo `sb` |

Mais regras do `watch`: no máximo 3 paradas por ciclo; uma parada que falha não é repetida na mesma
troca e avisa uma vez; o mux não troca sozinho duas vezes em menos de 5 minutos (a não ser que a
conta atual esteja esgotada); com `swap.auto: false` ele só avisa o que trocaria. Você reabre as
sessões paradas: o `sb` não reabre nem manda "continue".

### Manual (`sb swap`)

```bash
sb swap app trabalho        # coloca o mux app na conta trabalho (tem que estar em accounts do mux)
sb swap app                 # a próxima da fila, ignorando a preferida
sb swap app --clear         # desfaz o override: volta à conta que a regra escolhe
```

A troca manual vale **até o próximo reset da preferida** (`fiveHour.resetsAt` da última medição, ou
agora + 5 h se ela não foi medida). Até lá o `watch` respeita a escolha; se a conta manual esgotar, o
override é anulado e o mux segue a fila normal. Um mux sem pool só muda por `sb swap <mux> <conta>`
com a conta por extenso. A saída lista as sessões paradas, as que esperam o turno acabar e as
mantidas por trabalho agendado; exit 1 se alguma parada falhou.

## Fixar uma sessão

```bash
sb pin a1b2 trabalho        # a sessão a1b2c3d4 fica na conta trabalho, fora de todo swap
sb unpin a1b2               # volta para o mux da pasta dela
```

O prefixo do id tem de 4 a 8 hexadecimais. A conta precisa estar em `accounts` do mux da sessão.
Sessão parada tem os flags reescritos na hora (com backup em `backup/`); sessão livre é parada e
reescrita; sessão ocupada, com trabalho agendado, ou a que chamou o comando, entra na fila
(`runtime.json`) e o `sb watch` aplica quando ela ficar livre (o `pin` avisa se o `watch` não está
rodando). Depois é só reabrir a sessão. Só mexe em sessões em segundo plano do `sb`.

## Rodar sempre: `sb watch` e `sb install`

`sb install` instala, de uma vez:

- o **LaunchAgent** `com.gabriellst.switchboard.watch` (`sb watch`, `KeepAlive`, sobe no login);
- o **wrapper do zsh** (`<estado>/wrapper.zsh`, ligado por uma linha no `~/.zshrc`): todo `claude`,
  dentro ou fora de uma sessão do Claude, ganha `--settings` do mux da pasta. Se o `sb which` falhar (link
  quebrado, token com JSON inválido), o wrapper recusa e **não** chama o `claude`: sem settings ele
  cairia no keychain, calado. Subcomandos de manutenção (`auth`, `stop`, `rm`, `mcp`,
  `setup-token`…) e `--settings` explícito passam direto. Não existe passagem direta para quem está
  dentro de uma sessão: um agente que roda `claude --bg …` ou `claude agents` lá dentro também passa
  pelo `sb which` da pasta. O wrapper nunca repassa um `CLAUDE_CODE_OAUTH_TOKEN` herdado, em nenhum
  ramo: se o daemon subisse com o token de uma conta, arrastaria para ela todas as sessões do keychain;
- o comando **`/sb`** em `~/.claude/commands/sb.md` (`/sb`, `/sb swap app`, `/sb pin a1b2 trabalho`,
  `/sb accounts`…), que chama o `sb` (ele precisa estar no `PATH`). Um `/sb swap` ou `/sb pin` feito
  de dentro de uma sessão do mux nunca para a sessão que chamou: ela fica na espera.

`sb install --simular` mostra o que faria. É idempotente. Se o `~/.zshrc` ainda tem a linha
`# claude-conta`, ele **não** mexe nele (dois wrappers brigariam) e manda rodar `sb migrate`: quem
vem do `claude-conta` migra primeiro. Ele grava o **caminho absoluto do
runtime** (node ou bun) no plist e no wrapper: se o node mudar de lugar, rode `sb install` de novo. O
plist também leva os caminhos de config, estado e jobs que o `sb install` está usando
(`SWITCHBOARD_CONFIG`, `SWITCHBOARD_STATE_DIR`, `SWITCHBOARD_JOBS_DIR`, já resolvidos com `XDG_*`):
mudou uma dessas variáveis no shell? rode `sb install` de novo.
Para rodar o `watch` à mão: `sb watch` (só um por máquina; `sb watch --once [--json]` faz um ciclo e
sai). O log é `<estado>/log/watch.log`.

## `sb doctor`

Procura tudo que faria uma sessão rodar na conta errada, calada, e a higiene em volta. Sem `--fix`
só lê; `--fix` recria links, corrige permissões e adota sessões sem `--settings` (as paradas na
hora, as vivas pela fila do `watch`). `--json` imprime `{ findings, fixes? }`.

- **Erros** (exit 1): link de mux ou pin quebrado; token com JSON inválido (o `claude` ignoraria o
  settings e cairia no keychain); token sem `CLAUDE_CODE_OAUTH_TOKEN`; token morto (401); permissão
  do token fora de 600; sessão sob o root de um mux sem `--settings` (menos num mux cuja conta atual
  é o `keychain`, onde rodar sem settings é o esperado); view `claude agents` aberta sem
  o settings do `sb`; conta registrada sem token; config inválida (exit 2).
- **Avisos**: `watch` parado; preferida fora do pool; contas duplicadas no mesmo pool; conta
  sem mux; sessões do `claude-conta` ou de terceiros; links órfãos; estado fora de 700.

Os códigos estáveis de cada achado estão no [SPEC](SPEC.md).

## Migrar do `claude-conta`

A migração copia tudo para um backup e só **move** `~/.claude/contas*` no fim (`--finish`), quando
nada mais aponta para lá. Antes, deixe abertas as abas do cmux com `claude agents --cwd <pasta>`: o
`sb migrate` descobre os muxes olhando essas views (sem nenhuma view e sem `default` ele recusa).
Roda nesta ordem:

```bash
# 1. instalar o sb (uma vez)
cd switchboard && bun run build && ln -s "$PWD/dist/cli.js" ~/.local/bin/sb

# 2. ver o plano; não grava nada nem para nenhum processo
sb migrate --simular

# 3. aplicar (já roda o `sb install`); depois abra um terminal novo
sb migrate

# 4. em cada aba do cmux: feche a view antiga e abra a nova (o passo 3 imprime as linhas exatas)
sb agents <mux>

# 5. conferir
sb doctor
sb

# 6. mais tarde, quando nenhuma sessão ou view apontar mais para o claude-conta
sb migrate --finish --simular
sb migrate --finish
```

O que o passo 3 faz: copia `~/.claude/contas`, `contas-fixas`, `commands/conta.md` e o `~/.zshrc` para
`<estado>/backup/migrate-<data>/`; importa os tokens; cria um mux por raiz de `contas/excluir` (na
conta do keychain, sem pool) e um por view aberta (com todas as contas importadas, a ativa na frente
do pool); reescreve as sessões **paradas** (`contas/ativa.json` vira o mux da pasta,
`contas-fixas/<c>.json` vira `pins/<c>.json`) e põe as vivas na fila do `watch` (veja o aviso abaixo); para o vigia do
`claude-conta`; troca a linha `# claude-conta` do `~/.zshrc` pela do `sb`; troca `/conta` por `/sb`;
roda o `sb install`. O `sb migrate` em si não para nenhuma sessão, nunca toca o keychain, e rodar de novo
termina o serviço sem duplicar nada.

**O `watch` vai PARAR cada sessão viva do `claude-conta`.** Para trocar o `--settings` dela, o `watch`
roda `claude stop` em cada sessão viva da fila assim que ela fica livre (até 3 por ciclo de 30 s),
inclusive uma que você esteja lendo entre dois turnos. Ela volta, já nas contas novas, quando você a
reabre. Uma sessão no meio de um turno ou com trabalho agendado nunca é interrompida: espera. O
`--simular` e a saída do `sb migrate` mostram quantas sessões vivas isso atinge. O script `~/.local/bin/claude-conta` não é tocado.

O `--simular` só aponta duplicatas pelo token idêntico; o passo 3 também as acha pela medição de uso.
O `--finish` **recusa** (exit 1, com a lista) enquanto houver: a linha `# claude-conta` no
`~/.zshrc`; nenhuma conta importada ou nenhuma config do `sb`; sessão com `--settings` do
`claude-conta`; sessão com `state.json` ilegível; pedido de migração ainda na fila; view do `claude
agents` com o settings antigo; ou `ps` indisponível. Nada é apagado: o `--finish` move para
`<estado>/backup/finish-<data>/`.

## Comandos

| Comando | Faz |
|---|---|
| `sb` · `sb usage [--json] [--watch] [--every N]` | painel de uso |
| `sb accounts [--json]` · `sb accounts rm <conta> --yes` | contas registradas, token, uso e muxes · remove |
| `sb login <conta> [--terminal] [--attach <mux> [--pool \| --at N] [--preferred]]` | login por `setup-token` (ou token colado) |
| `sb attach <conta> <mux> [--pool \| --at N] [--preferred] [--json]` · `sb detach <conta> <mux> [--json]` | liga/desliga uma conta de um mux |
| `sb mux [list] [--json]` · `sb mux add <nome> --root <pasta> --account <conta> [--accounts a,b] [--pool a,b]` | muxes |
| `sb mux set <nome> [--root] [--account] [--accounts] [--pool] [--default]` · `sb mux rm <nome>` | só a config; a conta atual não troca |
| `sb agents [mux]` · `sb run [mux] -- <args do claude>` | abre o `claude agents` / o `claude` com o settings do mux |
| `sb which [pasta] [--json]` | caminho do settings do mux da pasta (é o que o wrapper usa) |
| `sb swap <mux> [conta] [--clear] [--json]` | troca manual (vale até o reset da preferida) |
| `sb pin <sessão> <conta> [--json]` · `sb unpin <sessão> [--json]` | fixa / solta uma sessão |
| `sb watch [--once [--json]]` | o supervisor |
| `sb install [--simular] [--json]` | LaunchAgent, wrapper do zsh, `/sb` |
| `sb doctor [--fix] [--json]` | diagnóstico |
| `sb migrate [--simular] [--finish] [--json]` | migração do `claude-conta` |

Exit codes: `0` ok · `1` verificação falhou · `2` config inválida · `3` uso (argumento, conta, mux ou
sessão inválidos ou recusados pelas regras) · `4` o `claude` falhou ou mudou de formato · `5` outro
`sb` está rodando. `sb agents` e `sb run` saem com o código do próprio `claude`. Nada é interativo
por padrão; `--json` nunca traz token.

## O que o `sb` não é

**Não troca de conta no meio de um turno.** O Claude Code lê o token no início da sessão; trocar a
conta é parar a sessão e reabri-la (o mesmo id, a conversa continua). O `sb` só para sessões livres
e quem reabre é você. Não envia "continue" sozinho depois de uma queda por limite.

**Não troca a conta de sessões interativas.** O `claude` em primeiro plano (e o `-p`) pega a conta do
mux ao abrir e só muda na próxima abertura.

**Não toca o keychain.** Nada de `/login` nem de ler ou gravar a credencial dele: o mux do keychain
é a conta que já existia, sem medição, sem pool e sem troca. O `keychain` é um nome reservado.

**Não guarda token fora de `tokens/`.** Nem em `--json`, nem em log, nem em mensagem de erro.

**Não gasta uso à toa.** Só a sonda de 1 token, a cada `probeEvery` por conta.

Limites conhecidos:

- Um `/loop` recorrente sobrevive à parada e reabertura; um lembrete único (CronCreate) agendado
  numa sessão **reaberta** pode passar despercebido, e a sessão ser parada numa troca.
- O formato de `claude agents --json`, do `state.json` das sessões e dos cabeçalhos de uso é
  interno do Claude Code e pode mudar. Quando muda, o `sb` recusa (exit 4, ou `claude.format` no
  `doctor`) em vez de adivinhar.
- O `sb run` e o wrapper colocam `--settings` **antes do primeiro `--` solto**; uma flag com valor
  logo antes do `--` (`--model -- texto`) engole o `--settings`. É erro de digitação do comando.
- Opção desconhecida é recusada em todo comando e subcomando (exit 3, com o nome da opção, antes de
  qualquer efeito): `sb migrate --simulate`, `sb install --dry-run` ou `sb swap bk --cleer` não fazem
  nada. Valem `--opção`, `--opção=valor`, `--no-<opção booleana>` e `--help`/`-h`. Em `sb run`, o que vem
  depois do `--` é do `claude` e não é conferido; antes dele só o nome do mux, e `--settings`/
  `--settings=` também é recusado. Só um subcomando desconhecido dá exit 1.
- É de um usuário só e não está publicado. Usar várias assinaturas e alternar por limite é decisão
  sua; confira os termos do plano.

## Licença

MIT
