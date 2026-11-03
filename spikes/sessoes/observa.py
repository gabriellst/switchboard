#!/usr/bin/env python3
"""Observador de sessões do claude (spike do switchboard, Marco 0).

Uso (sempre com `python3 -I`):
  observa.py snapshot [ids...] [--rate-limited]
  observa.py vigia --every 60 --horas 24 --out ARQ.jsonl [--detach]
  observa.py regrava <id> <settings>

Somente LÊ ~/.claude/jobs/<id>/state.json, timeline.jsonl e `claude agents --json --all`
(via ./cl, ambiente limpo). Nunca abre nada em ~/.claude/contas. Toda saída passa por
redact(): tokens oauth viram `<token>`.
"""
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone

AQUI = os.path.dirname(os.path.abspath(__file__))
CL = os.path.join(AQUI, "cl")
PID_FILE = os.path.join(AQUI, "vigia.pid")
HOME = os.path.expanduser("~")
JOBS = os.path.join(HOME, ".claude", "jobs")
ID_RE = re.compile(r"^[0-9a-f]{8}$")
TOKEN_RE = re.compile(r"sk-ant-\S+")


def redact(s):
    return TOKEN_RE.sub("<token>", s)


def emit(obj, fh=None):
    """Serializa uma linha JSON, redigida, em fh (stdout por padrão)."""
    linha = redact(json.dumps(obj, ensure_ascii=False))
    (fh or sys.stdout).write(linha + "\n")
    (fh or sys.stdout).flush()


def agora():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def job_path(id_, nome):
    # id vem da linha de comando: só 8 hex, nunca um caminho
    if not ID_RE.match(id_):
        raise ValueError("id inválido: %r" % redact(id_))
    return os.path.join(JOBS, id_, nome)


def ler_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def agentes():
    """{id: entrada} de `claude agents --json --all`; {} se falhar."""
    try:
        r = subprocess.run([CL, "agents", "--json", "--all"], capture_output=True,
                           text=True, timeout=60, stdin=subprocess.DEVNULL)
        lista = json.loads(r.stdout)
        return {e["id"]: e for e in lista if isinstance(e, dict) and "id" in e}
    except Exception:
        return {}


def cauda_timeline(id_, n=3):
    try:
        path = job_path(id_, "timeline.jsonl")
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            tam = f.tell()
            f.seek(max(0, tam - 262144))
            bruto = f.read().decode("utf-8", "replace")
    except OSError:
        return []
    linhas = [l for l in bruto.splitlines() if l.strip()]
    out = []
    for l in linhas[-n:]:
        try:
            d = json.loads(l)
        except ValueError:
            continue
        out.append({"at": d.get("at"), "state": d.get("state"),
                    "detail": (d.get("detail") or "")[:80]})
    return out


def settings_de(flags):
    vals = []
    flags = flags or []
    for i, f in enumerate(flags):
        if f == "--settings" and i + 1 < len(flags):
            vals.append(flags[i + 1])
        elif isinstance(f, str) and f.startswith("--settings="):
            vals.append(f[len("--settings="):])
    return [v.replace(HOME, "~") if isinstance(v, str) else v for v in vals]


def snapshot_de(id_, ags):
    st = ler_json(job_path(id_, "state.json")) or {}
    a = ags.get(id_) or {}
    return {
        "id": id_,
        "at": agora(),
        "agents": {"state": a.get("state"), "status": a.get("status"),
                   "hasPid": "pid" in a, "kind": a.get("kind"),
                   "startedAt": a.get("startedAt")},
        "job": {"state": st.get("state"), "tempo": st.get("tempo"),
                "inFlight": st.get("inFlight"),
                "needs": (st.get("needs") or "")[:120] or None,
                "detail": (st.get("detail") or "")[:80] or None,
                "cliVersion": st.get("cliVersion"), "sessionId": st.get("sessionId"),
                "resumeSessionId": st.get("resumeSessionId")},
        "settings": settings_de(st.get("respawnFlags")),
        "timeline": cauda_timeline(id_),
    }


def ids_rate_limited():
    achados = []
    try:
        nomes = sorted(os.listdir(JOBS))
    except OSError:
        return achados
    for n in nomes:
        if not ID_RE.match(n):
            continue
        st = ler_json(os.path.join(JOBS, n, "state.json"))
        if st and (st.get("needs") or "").startswith("rate limited"):
            achados.append(n)
    return achados


def cmd_snapshot(args):
    ids = [a for a in args if not a.startswith("--")]
    if "--rate-limited" in args:
        for i in ids_rate_limited():
            if i not in ids:
                ids.append(i)
    if not ids:
        print("uso: snapshot [ids...] [--rate-limited]", file=sys.stderr)
        return 2
    ags = agentes()
    for i in ids:
        try:
            emit(snapshot_de(i, ags))
        except ValueError as e:
            print(redact(str(e)), file=sys.stderr)
            return 2
    return 0


def tupla(snap):
    return (snap["agents"]["state"], snap["agents"]["status"], snap["agents"]["hasPid"],
            (snap["job"]["inFlight"] or {}).get("queued"), snap["job"]["needs"])


def opt(args, nome, padrao=None):
    if nome in args:
        i = args.index(nome)
        if i + 1 < len(args):
            return args[i + 1]
    return padrao


def daemoniza():
    """Duplo fork + setsid; stdio em /dev/null; grava o pid do neto em PID_FILE."""
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    dn = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(dn, fd)
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()) + "\n")


def cmd_vigia(args):
    every = int(opt(args, "--every", 60))
    horas = float(opt(args, "--horas", 24))
    out = opt(args, "--out")
    if not out:
        print("uso: vigia --every 60 --horas 24 --out ARQ.jsonl [--detach]", file=sys.stderr)
        return 2
    out = os.path.abspath(out)  # antes do fork
    if "--detach" in args:
        daemoniza()
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    fim = time.time() + horas * 3600
    vistos = {}  # id -> última tupla gravada
    try:
        while time.time() < fim:
            try:
                ags = agentes()
                alvo = set(vistos) | set(ids_rate_limited())
                for i in sorted(alvo):
                    snap = snapshot_de(i, ags)
                    t = tupla(snap)
                    if vistos.get(i) != t:
                        vistos[i] = t
                        with open(out, "a", encoding="utf-8") as fh:
                            emit(snap, fh)
            except Exception as e:  # o observador não pode morrer por um ciclo ruim
                try:
                    with open(out, "a", encoding="utf-8") as fh:
                        emit({"at": agora(), "erro": type(e).__name__}, fh)
                except Exception:
                    pass
            time.sleep(every)
    finally:
        if "--detach" in args:
            try:
                os.unlink(PID_FILE)
            except OSError:
                pass
    return 0


def cmd_regrava(args):
    if len(args) != 2:
        print("uso: regrava <id> <settings>", file=sys.stderr)
        return 2
    id_, novo = args
    try:
        path = job_path(id_, "state.json")
    except ValueError as e:
        print(redact(str(e)), file=sys.stderr)
        return 2
    st = ler_json(path)
    if not st:
        print("recusado: state.json ilegível", file=sys.stderr)
        return 2
    if not str(st.get("name") or "").startswith("sb-spike-"):
        print("recusado: o name da sessão não começa com sb-spike-", file=sys.stderr)
        return 2
    a = agentes().get(id_)
    if a is None or "pid" in a or a.get("status"):
        print("recusado: a sessão não está parada (ou não foi possível confirmar)",
              file=sys.stderr)
        return 2
    novo = os.path.expanduser(novo)
    flags = st.get("respawnFlags") or []
    mudou = 0
    for i, f in enumerate(flags):
        if f == "--settings" and i + 1 < len(flags):
            flags[i + 1] = novo
            mudou += 1
        elif isinstance(f, str) and f.startswith("--settings="):
            flags[i] = "--settings=" + novo
            mudou += 1
    if not mudou:
        print("recusado: respawnFlags sem --settings", file=sys.stderr)
        return 2
    st["respawnFlags"] = flags
    tmp = path + ".tmp.%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    emit({"id": id_, "settings": settings_de(flags), "trocados": mudou})
    return 0


def main(argv):
    if not argv or argv[0] not in ("snapshot", "vigia", "regrava"):
        print(__doc__, file=sys.stderr)
        return 2
    return {"snapshot": cmd_snapshot, "vigia": cmd_vigia, "regrava": cmd_regrava}[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
