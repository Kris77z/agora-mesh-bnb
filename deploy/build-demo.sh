#!/usr/bin/env bash
# Run after bootstrap-demo.sh on the dedicated server. No secrets are needed.
set -euo pipefail
task_revision="${1:?Pass the committed release SHA}"
[[ "$task_revision" =~ ^[a-f0-9]{40}$ ]]
task_release=/srv/agora-mesh/releases/$task_revision
test ! -e "$task_release"
git clone --quiet https://github.com/Kris77z/agora-mesh-bnb.git "$task_release"
git -C "$task_release" checkout --quiet --detach "$task_revision"
cat > "$task_release/frontend/.env.production" <<'ENV'
NEXT_PUBLIC_CHAIN_PRESET=bnb-testnet
NEXT_PUBLIC_CHAIN_ID=97
NEXT_PUBLIC_RPC_URL=https://bsc-testnet-dataseed.bnbchain.org
NEXT_PUBLIC_HUNTER_URL=/api/hunter
NEXT_PUBLIC_WRITER_URL=/api/auditor
NEXT_PUBLIC_REGISTRY_URL=/api/registry
NEXT_PUBLIC_DEMO_MODE=false
HUNTER_INTERNAL_URL=http://127.0.0.1:3002
REGISTRY_INTERNAL_URL=http://127.0.0.1:3003
WRITER_INTERNAL_URL=http://127.0.0.1:3001
ENV
chown -R agora-mesh:agora-mesh "$task_release"
runuser -u agora-mesh -- env npm_config_cache=/srv/agora-mesh/state/npm-cache npm ci --prefix "$task_release" --no-audit --no-fund
cd "$task_release"
runuser -u agora-mesh -- env NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=1536 npm run build --workspace @rebel/frontend
python3 -m venv /srv/agora-mesh/venv
/srv/agora-mesh/venv/bin/pip install -r requirements-slither.txt
install -d -o agora-mesh -g agora-mesh /srv/agora-mesh/.solc-select
runuser -u agora-mesh -- /srv/agora-mesh/venv/bin/solc-select install 0.8.28
runuser -u agora-mesh -- /srv/agora-mesh/venv/bin/solc-select use 0.8.28
chown -R agora-mesh:agora-mesh /srv/agora-mesh/.solc-select
ln -s /srv/agora-mesh/.solc-select /srv/agora-mesh/venv/.solc-select
echo 'Agora Mesh release built; not activated.'
