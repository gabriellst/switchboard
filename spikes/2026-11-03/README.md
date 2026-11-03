# Spike de 03/11/2026 — fatos F1–F6 do design

- `uso.py <conta>...` — sonda de uso pelos cabeçalhos `anthropic-ratelimit-unified-*` (F1) e o
  endpoint `/api/oauth/usage` (F2, 403 por escopo). Lê o token de `~/.claude/contas/<conta>.json`
  e nunca o imprime.
- `roda.py` / `roda2.py` + `espera.sh` — `apiKeyHelper` com token OAuth (F5) e rotação no meio da
  execução com TTL curto (F4: não rotaciona). Os arquivos de token que eles usavam foram apagados;
  para rodar de novo, recrie-os a partir de uma conta de teste.
