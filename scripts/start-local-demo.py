"""Run the local demo in the foreground. Ctrl-C stops only children started here."""
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
children = []
logs = []

def listening(port):
    with socket.socket() as sock:
        sock.settimeout(0.3)
        return sock.connect_ex(('127.0.0.1', port)) == 0

def start(name, port, command, extra=None):
    if listening(port):
        print(f'REUSE {name} :{port} — existing process retained; readiness must verify it', flush=True)
        return
    env = dict(os.environ, RPC_URL='http://127.0.0.1:8767',
               ALTANA_RPC_URL_OVERRIDE='http://127.0.0.1:8767',
               ALTANA_RELAY_URL_OVERRIDE='http://localhost:3000/api/altana/relay',
               WRITER_REGISTER_ONCHAIN='false', INIT_CWD=str(ROOT))
    env.update(extra or {})
    log_path = ROOT / '.local-demo' / f'{name}.log'
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.chmod(log_path, 0o600)
    log = os.fdopen(fd, 'ab'); logs.append(log)
    child = subprocess.Popen(command, cwd=ROOT, env=env, stdout=log, stderr=log, start_new_session=True)
    children.append((name, child))
    deadline = time.monotonic() + 40
    while not listening(port):
        if child.poll() is not None or time.monotonic() >= deadline:
            raise RuntimeError(f'{name} failed to listen; inspect {log_path} locally')
        time.sleep(0.25)
    print(f'START {name} :{port}', flush=True)

def stop(*_):
    raise KeyboardInterrupt

def main():
    os.chdir(ROOT)
    (ROOT / '.local-demo').mkdir(mode=0o700, exist_ok=True)
    if not (ROOT / 'frontend/.next/BUILD_ID').exists():
        raise RuntimeError('Build frontend first: npm run build --workspace @rebel/frontend')
    start('rpc', 8767, ['python3', 'scripts/local-altana-relay-proxy.py', '--target', 'bnb-rpc', '--port', '8767', '--direct'])
    start('model', 8768, ['python3', 'scripts/local-moonshot-proxy.py'])
    start('registry', 3003, ['npm', 'run', 'start', '--workspace', '@rebel/registry'])
    for profile, port in [('auditor', 3001), ('verifier', 3004), ('investigator', 3005)]:
        start(profile, port, ['npm', 'run', 'start', '--workspace', '@rebel/writer'],
              {'SERVICE_PROFILE': profile, f'{profile.upper()}_LLM_BASE_URL': 'http://127.0.0.1:8768/v1'})
    # Read only the two existing Sentinel items; secrets never enter argv or logs.
    sentinel = {}
    for variable, service in [('SENTINEL_PRIVATE_KEY', 'agora-mesh-sentinel-private-key'), ('SENTINEL_X402_FACILITATOR_PRIVATE_KEY', 'agora-mesh-sentinel-facilitator-key')]:
        value = os.environ.get(variable)
        if not value and sys.platform == 'darwin':
            result = subprocess.run(['security', 'find-generic-password', '-s', service, '-w'], capture_output=True, text=True)
            if result.returncode == 0: value = result.stdout.strip()
        if value: sentinel[variable] = value
    if len(sentinel) == 2:
        start('sentinel', 3006, ['npm', 'run', 'start', '--workspace', '@rebel/writer'],
              {**sentinel, 'SERVICE_PROFILE': 'sentinel', 'SENTINEL_LLM_BASE_URL': 'http://127.0.0.1:8768/v1'})
    elif listening(3006):
        print('REUSE sentinel :3006 — verify identity in readiness', flush=True)
    else:
        print('GAP Sentinel: independent wallet/facilitator not supplied in process environment', flush=True)
    start('hunter', 3002, ['npm', 'run', 'start', '--workspace', '@rebel/hunter'])
    start('frontend', 3000, ['npm', 'run', 'start', '--workspace', '@rebel/frontend'])
    result = subprocess.run(['node', '--import', 'tsx', 'scripts/check-demo-readiness.ts'], cwd=ROOT)
    print(f'Readiness exit {result.returncode}; see evidence/DEMO_READINESS_LATEST.json. Keep this terminal open.', flush=True)
    while True:
        for name, child in children:
            if child.poll() is not None:
                raise RuntimeError(f'{name} stopped unexpectedly; inspect its .local-demo log')
        time.sleep(1)

signal.signal(signal.SIGTERM, stop)
try:
    main()
except KeyboardInterrupt:
    print('Stopping processes started by this launcher; reused processes remain.')
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exitcode = 1
finally:
    for _, child in children:
        try: os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError: pass
    for _, child in children:
        try: child.wait(timeout=8)
        except subprocess.TimeoutExpired:
            try: os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError: pass
    for log in logs: log.close()
sys.exit(getattr(sys, 'exitcode', 0))
