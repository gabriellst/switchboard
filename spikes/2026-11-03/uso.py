import json, os, sys, urllib.request, urllib.error
C = os.path.expanduser('~/.claude/contas')
def token(nome):
    with open(os.path.join(C, nome + '.json')) as f:
        return (json.load(f).get('env') or {}).get('CLAUDE_CODE_OAUTH_TOKEN')
def req(url, tok, body=None, extra=None):
    h = {'Authorization': 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-cli/spike'}
    if extra: h.update(extra)
    data = None
    if body is not None:
        data = json.dumps(body).encode(); h['content-type'] = 'application/json'; h['anthropic-version'] = '2023-06-01'
    r = urllib.request.Request(url, data=data, headers=h, method='POST' if data else 'GET')
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, dict(resp.headers), resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode()
for nome in sys.argv[1:]:
    tok = token(nome)
    print('\n======== conta:', nome, '| token presente:', bool(tok))
    if not tok: continue
    st, hd, body = req('https://api.anthropic.com/api/oauth/usage', tok)
    print('[a] /api/oauth/usage ->', st); print('   ', body[:700])
    st, hd, body = req('https://api.anthropic.com/v1/messages', tok, body={
        'model': 'claude-haiku-4-5', 'max_tokens': 1,
        'system': "You are Claude Code, Anthropic's official CLI for Claude.",
        'messages': [{'role': 'user', 'content': 'ok'}]})
    print('[b] /v1/messages ->', st, '' if st == 200 else body[:300])
    for k, v in sorted(hd.items()):
        if 'ratelimit' in k.lower() or 'unified' in k.lower(): print('    ', k, '=', v)
