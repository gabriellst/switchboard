import os, subprocess, sys, re, time, threading, shutil
SP = os.path.dirname(os.path.abspath(__file__))
env = {k: v for k, v in os.environ.items() if k not in ('CLAUDE_CODE_OAUTH_TOKEN','CLAUDECODE','CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_ENTRYPOINT','CLAUDE_JOB_DIR','CLAUDE_CODE_CHILD_SESSION')}
env['CLAUDE_CODE_API_KEY_HELPER_TTL_MS'] = '3000'
t0 = time.time()
def trocar():
    time.sleep(14); shutil.copy(os.path.join(SP,'tok-invalido.txt'), os.path.join(SP,'helper-atual.txt'))
    print('[%.0fs] troquei o helper para token INVALIDO' % (time.time()-t0), flush=True)
threading.Thread(target=trocar, daemon=True).start()
try:
    r = subprocess.run(cwd=SP, args=['claude','-p','Run this exact bash command and wait for it: ./espera.sh . After it prints espera-terminou, reply with exactly the word FIM and nothing else.','--settings',os.path.join(SP,'helper-settings.json'),'--model','haiku','--max-turns','5','--strict-mcp-config','--no-session-persistence','--allowedTools','Bash(./espera.sh)'], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=90)
    print('[%.0fs] exit=%s' % (time.time()-t0, r.returncode)); print(re.sub(r'sk-ant-[A-Za-z0-9_-]+','sk-ant-***',(r.stdout+r.stderr)[-500:]))
except subprocess.TimeoutExpired:
    print('[%.0fs] TIMEOUT 90s: travou depois da troca' % (time.time()-t0))
