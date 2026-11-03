import os, subprocess, sys, re
SP = os.path.dirname(os.path.abspath(__file__))
env = {k: v for k, v in os.environ.items() if k not in ('CLAUDE_CODE_OAUTH_TOKEN','CLAUDECODE','CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_ENTRYPOINT','CLAUDE_JOB_DIR','CLAUDE_CODE_CHILD_SESSION')}
env.update(dict(a.split('=',1) for a in sys.argv[2:]))
try:
    r = subprocess.run(['claude','-p','Responda apenas: ok','--settings',os.path.join(SP,sys.argv[1]),'--model','haiku','--max-turns','1','--strict-mcp-config','--no-session-persistence'], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
    out = (r.stdout + r.stderr)[-600:]
    print('exit=%s' % r.returncode); print(re.sub(r'sk-ant-[A-Za-z0-9_-]+','sk-ant-***',out))
except subprocess.TimeoutExpired:
    print('TIMEOUT 60s (travou)')
