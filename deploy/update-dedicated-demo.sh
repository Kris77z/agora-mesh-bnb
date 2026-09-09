#!/usr/bin/env bash
# Backend-only release. Vercel is the sole website deployment.
set -euo pipefail
task_base=/srv/agora-mesh
task_revision="${1:?Pass a full commit SHA}"
[[ "$task_revision" =~ ^[a-f0-9]{40}$ ]]
task_release=$task_base/releases/$task_revision
test -L "$task_base/current"
test -x "$task_base/venv/bin/slither"
test -d "$task_base/state/registry"
test -d "$task_base/state/memory"
task_previous=$(readlink -f "$task_base/current")
if [ ! -d "$task_release" ]; then
  git clone --quiet https://github.com/Kris77z/agora-mesh-bnb.git "$task_release"
  git -C "$task_release" checkout --quiet --detach "$task_revision"
fi
if [ ! -f "$task_release/.backend-ready" ]; then
  chown -R agora-mesh:agora-mesh "$task_release"
  runuser -u agora-mesh -- env npm_config_cache="$task_base/state/npm-cache" npm ci --prefix "$task_release" \
    --workspace @rebel/shared --workspace @rebel/hunter --workspace @rebel/writer --workspace @rebel/registry --no-audit --no-fund
  touch "$task_release/.backend-ready"
fi
for task_pair in registry:registry agents/hunter/memory:memory; do
  task_path=${task_pair%:*}
  task_state=${task_pair#*:}
  if [ ! -L "$task_release/$task_path" ]; then
    mv "$task_release/$task_path" "$task_release/$task_path-seed"
    ln -s "$task_base/state/$task_state" "$task_release/$task_path"
  fi
done
chown -R agora-mesh:agora-mesh "$task_release"
install -m 0644 "$task_release/deploy/agora-altana-bridge.service" /etc/systemd/system/agora-altana-bridge.service
systemctl daemon-reload
ln -sfn "$task_release" "$task_base/current.new"
mv -Tf "$task_base/current.new" "$task_base/current"
rollback() {
  ln -sfn "$task_previous" "$task_base/current.new"
  mv -Tf "$task_base/current.new" "$task_base/current"
  systemctl restart agora-mesh@registry agora-mesh@auditor agora-mesh@sentinel agora-mesh@verifier agora-mesh@investigator agora-mesh@hunter
  echo 'Backend activation failed; previous code restored.' >&2
}
trap rollback ERR
systemctl restart agora-mesh@registry agora-mesh@auditor agora-mesh@sentinel agora-mesh@verifier agora-mesh@investigator agora-mesh@hunter
systemctl enable agora-altana-bridge
systemctl restart agora-altana-bridge
curl --fail --retry 15 --retry-delay 2 --retry-all-errors -sS http://127.0.0.1:3007/health
# Keep the existing API routes, tokens and specialist hosts; replace only the website fallback.
python3 - <<'PY'
import json,os,pathlib,subprocess
p=pathlib.Path('/etc/caddy/Caddyfile')
s=p.read_text()
old='    handle {\n        reverse_proxy 127.0.0.1:3000\n    }'
new='''    handle /api/altana/* {
        reverse_proxy 127.0.0.1:3007
    }
    handle /api/* {
        respond "Not found" 404
    }
    handle {
        redir https://agora-mesh-bnb.vercel.app{uri} 308
    }'''
if old in s:
 s=s.replace(old,new,1)
elif 'redir https://agora-mesh-bnb.vercel.app{uri} 308' not in s:
 raise RuntimeError('Unexpected website routing; no config changed')
if '127.0.0.1:3000' in s: raise RuntimeError('A route still needs the old frontend')
for line in pathlib.Path('/srv/agora-mesh/config/caddy.env').read_text().splitlines():
 if line.strip() and not line.startswith('#'):
  k,v=line.split('=',1);os.environ[k]=json.loads(v)
candidate=p.with_name('Caddyfile.backend-only')
candidate.write_text(s);candidate.chmod(0o640)
subprocess.run(['caddy','validate','--config',str(candidate),'--adapter','caddyfile'],check=True)
backup=p.with_name('Caddyfile.before-backend-only')
if not backup.exists(): backup.write_text(p.read_text());backup.chmod(0o600)
p.write_text(s)
subprocess.run(['systemctl','reload','caddy'],check=True)
PY
systemctl disable --now agora-mesh@frontend
trap - ERR
echo "Activated backend $task_revision; website is https://agora-mesh-bnb.vercel.app"
systemctl is-active agora-mesh@registry agora-mesh@auditor agora-mesh@sentinel agora-mesh@verifier agora-mesh@investigator agora-mesh@hunter agora-altana-bridge
