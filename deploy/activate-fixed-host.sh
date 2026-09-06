#!/usr/bin/env bash
set -euo pipefail

# Disabled after this entry point targeted the chaochenbass production server.
# The user reserves 112.74.165.78 / chaochenbass-prod exclusively for chaochenbass.
# Before replacing this entry point, provision a separate Agora Mesh host and
# replace the server-specific Caddy configuration and health-check URLs below.
echo "Deployment disabled: the former target is reserved exclusively for chaochenbass. Configure a separate Agora Mesh host and domain." >&2
exit 2

# Activates a source release on the already-provisioned Agora Mesh host.
# It deliberately does not upload .env files, Session material, or broadcast
# any blockchain transaction (including ERC-8004 registration).

task_host="${AGORA_DEPLOY_HOST:?AGORA_DEPLOY_HOST must name a dedicated Agora Mesh server}"
task_release="${1:-20260903-stability-v3}"
task_authority_id="agora-termix-stability-20260902"
task_remote_root="/srv/agora-mesh"
task_remote_release="$task_remote_root/releases/$task_release"
task_remote_stage="/tmp/agora-mesh-$task_release"
task_repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! "$task_release" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "Release name contains unsupported characters" >&2
  exit 2
fi

echo "Preflight: $task_host"
ssh -o BatchMode=yes -o ConnectTimeout=20 -o ConnectionAttempts=1 "$task_host" \
  "test -f '$task_remote_root/config/common.env' && test -f '$task_remote_root/config/frontend.env' && command -v npm >/dev/null && command -v rsync >/dev/null && echo ready"

echo "Sync source to isolated staging directory"
ssh "$task_host" "rm -rf '$task_remote_stage' && mkdir -p '$task_remote_stage/source' '$task_remote_stage/state'"
rsync -a --delete \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude 'frontend/.env.local' \
  --exclude 'node_modules/' \
  --exclude 'frontend/.next/' \
  --exclude '.venv-slither/' \
  --exclude 'registry/altana-sessions.json' \
  --exclude '*.log' \
  "$task_repository_root/" "$task_host:$task_remote_stage/source/"

task_state_files=(
  authority-evidence.json
  dynamic-services.json
  feedback-store.json
  missions.json
  service-feedback-store.json
  services.json
  x402-auditor-receipts.json
  x402-investigator-receipts.json
  x402-verifier-receipts.json
)
for task_state_file in "${task_state_files[@]}"; do
  if [[ -f "$task_repository_root/registry/$task_state_file" ]]; then
    rsync -a "$task_repository_root/registry/$task_state_file" \
      "$task_host:$task_remote_stage/state/$task_state_file"
  fi
done

echo "Install immutable release and public evidence state"
ssh "$task_host" "sudo mkdir -p '$task_remote_release' '$task_remote_root/state/npm-cache' && sudo rsync -a --delete '$task_remote_stage/source/' '$task_remote_release/' && sudo chown -R agora-mesh:agora-mesh '$task_remote_release' '$task_remote_root/state/npm-cache'"

ssh "$task_host" "for file in '$task_remote_stage/state/'*.json; do test -e \"\$file\" || continue; name=\$(basename \"\$file\"); case \"\$name\" in authority-evidence.json|missions.json|x402-*-receipts.json) mode=0600 ;; *) mode=0644 ;; esac; sudo install -o agora-mesh -g agora-mesh -m \"\$mode\" \"\$file\" '$task_remote_root/state/'\"\$name\"; done"

echo "Install dependencies and build the production frontend"
ssh "$task_host" "cd '$task_remote_release' && sudo -u agora-mesh env npm_config_cache='$task_remote_root/state/npm-cache' npm ci --prefer-offline --no-audit --no-fund"
ssh "$task_host" "sudo bash -c 'set -a; . $task_remote_root/config/common.env; . $task_remote_root/config/frontend.env; set +a; cd $task_remote_release; exec sudo -u agora-mesh -E /usr/bin/npm run build --workspace @rebel/frontend'"

echo "Pin the public evidence view to the revoked stability Authority"
ssh "$task_host" "if sudo grep -q '^ALTANA_AUTHORITY_ID=' '$task_remote_root/config/common.env'; then sudo sed -i 's/^ALTANA_AUTHORITY_ID=.*/ALTANA_AUTHORITY_ID=$task_authority_id/' '$task_remote_root/config/common.env'; else printf '%s\n' 'ALTANA_AUTHORITY_ID=$task_authority_id' | sudo tee -a '$task_remote_root/config/common.env' >/dev/null; fi"

echo "Activate systemd units and Caddy only after configuration validation"
ssh "$task_host" "set -e; sudo ln -sfn '$task_remote_release' '$task_remote_root/current'; sudo install -o root -g root -m 0644 '$task_remote_release/deploy/agora-mesh@.service' /etc/systemd/system/agora-mesh@.service; sudo install -o root -g root -m 0644 '$task_remote_release/deploy/agora-mesh.Caddyfile' /etc/caddy/agora-mesh.Caddyfile; if ! sudo grep -qxF 'import /etc/caddy/agora-mesh.Caddyfile' /etc/caddy/Caddyfile; then printf '%s\n' 'import /etc/caddy/agora-mesh.Caddyfile' | sudo tee -a /etc/caddy/Caddyfile >/dev/null; fi; sudo caddy validate --config /etc/caddy/Caddyfile"
ssh "$task_host" "sudo systemctl daemon-reload && sudo systemctl enable --now agora-mesh@registry agora-mesh@auditor agora-mesh@verifier agora-mesh@investigator agora-mesh@hunter agora-mesh@frontend && sudo systemctl reload caddy"

echo "Verify local service matrix and fixed HTTPS"
ssh "$task_host" "for endpoint in 'http://127.0.0.1:3100/advantage' 'http://127.0.0.1:3102/health' 'http://127.0.0.1:3103/services' 'http://127.0.0.1:3101/health' 'http://127.0.0.1:3104/health' 'http://127.0.0.1:3105/health'; do curl --fail --silent --show-error --max-time 15 --output /dev/null \"\$endpoint\"; done; sudo bash -c 'set -a; . $task_remote_root/config/common.env; . $task_remote_root/config/hunter.env; set +a; curl --fail --silent --show-error --max-time 15 --header \"X-Agora-Token: \$HUNTER_API_AUTH_TOKEN\" --output /dev/null http://127.0.0.1:3102/authority'"
curl --fail --silent --show-error --max-time 30 --output /dev/null \
  "https://agora-mesh.112-74-165-78.nip.io/advantage"
curl --fail --silent --show-error --max-time 30 --output /dev/null \
  "https://agora-mesh.112-74-165-78.nip.io/authority"

ssh "$task_host" "rm -rf '$task_remote_stage'"
echo "Activated $task_release at https://agora-mesh.112-74-165-78.nip.io"
