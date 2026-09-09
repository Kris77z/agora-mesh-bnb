#!/usr/bin/env bash
# Dedicated Tencent demo host only. No transactions are broadcast by this script.
set -euo pipefail
task_base=/srv/agora-mesh
task_revision="${1:?Pass the built release SHA}"
[[ "$task_revision" =~ ^[a-f0-9]{40}$ ]]
task_release=$task_base/releases/$task_revision
test -f "$task_release/frontend/.next/BUILD_ID"
test -x "$task_base/venv/bin/slither"
test -f "$task_base/config/caddy.env"
test ! -e "$task_base/current"
cp -a "$task_release/registry" "$task_base/state/registry"
cp -a "$task_release/agents/hunter/memory" "$task_base/state/memory"
printf '{"services":[]}\n' > "$task_base/state/registry/dynamic-services.json"
python3 - <<'PYSEED'
from pathlib import Path
import json
p=Path('/srv/agora-mesh/state/registry/services.json')
data=json.loads(p.read_text())
active={'auditor-v1','sentinel-audit-v1','verifier-v1','risk-verifier-v1','investigator-v1'}
data['services']=[s for s in data['services'] if s['id'] in active]
p.write_text(json.dumps(data))
PYSEED
mv "$task_release/registry" "$task_release/registry-seed"
ln -s "$task_base/state/registry" "$task_release/registry"
mv "$task_release/agents/hunter/memory" "$task_release/agents/hunter/memory-seed"
ln -s "$task_base/state/memory" "$task_release/agents/hunter/memory"
chown -R agora-mesh:agora-mesh "$task_base/state"
ln -s "$task_release" "$task_base/current"
cat > /etc/systemd/system/agora-mesh@.service <<'UNIT'
[Unit]
Description=Agora Mesh %i demo
After=network-online.target
Wants=network-online.target
[Service]
User=agora-mesh
Group=agora-mesh
WorkingDirectory=/srv/agora-mesh/current
Environment=NODE_ENV=production
Environment=INIT_CWD=/srv/agora-mesh/current
Environment=PATH=/srv/agora-mesh/venv/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/srv/agora-mesh/config/common.env
EnvironmentFile=/srv/agora-mesh/config/%i.env
ExecStart=/usr/local/bin/npm run ${AGORA_SCRIPT} --workspace ${AGORA_WORKSPACE}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/agora-mesh/state /srv/agora-mesh/current/frontend/.next/cache
[Install]
WantedBy=multi-user.target
UNIT
install -d /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/agora-env.conf <<'UNIT'
[Service]
EnvironmentFile=/srv/agora-mesh/config/caddy.env
UNIT
# Copy the reviewed dedicated-demo.Caddyfile to this path before running.
test -f /root/agora-demo.Caddyfile
python3 - <<'PY'
import os,json,subprocess
for line in open('/srv/agora-mesh/config/caddy.env'):
 k,v=line.strip().split('=',1); os.environ[k]=json.loads(v)
domain=os.environ['AGORA_DOMAIN']
with open('/etc/hosts','a') as hosts:
 hosts.write('\n# Agora Mesh same-host service routing\n127.0.0.1 '+domain+' '+ ' '.join(p+'.'+domain for p in ['auditor','verifier','investigator','sentinel'])+'\n')
subprocess.run(['caddy','validate','--config','/root/agora-demo.Caddyfile','--adapter','caddyfile'],check=True)
PY
cp -a /etc/caddy/Caddyfile /root/caddy-before-agora.conf
install -o root -g caddy -m 0640 /root/agora-demo.Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now agora-mesh@registry agora-mesh@auditor agora-mesh@sentinel agora-mesh@verifier agora-mesh@investigator agora-mesh@hunter agora-mesh@frontend
systemctl restart caddy
echo 'Processes started; verify health and HTTPS before reporting the demo live.'
