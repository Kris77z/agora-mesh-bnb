#!/usr/bin/env bash
# Run as root on the dedicated Agora Mesh Ubuntu server only.
set -euo pipefail
test "$(id -u)" = 0
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl git xz-utils caddy python3-venv

task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT
cd "$task_tmp"
curl --fail --silent --show-error https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o SHASUMS256.txt
task_archive=$(awk '$2 ~ /^node-v22\..*-linux-x64.tar.xz$/ {print $2}' SHASUMS256.txt)
test -n "$task_archive"
curl --fail --silent --show-error "https://nodejs.org/dist/latest-v22.x/$task_archive" -o "$task_archive"
grep "  $task_archive\$" SHASUMS256.txt | sha256sum --check -
tar -xJf "$task_archive" -C /usr/local --strip-components=1
node --version
npm --version

id agora-mesh >/dev/null 2>&1 || useradd --system --home-dir /srv/agora-mesh --shell /usr/sbin/nologin agora-mesh
install -d -o root -g agora-mesh -m 0750 /srv/agora-mesh/config
install -d -o agora-mesh -g agora-mesh -m 0750 /srv/agora-mesh/releases /srv/agora-mesh/state
# Install first; build and activation happen separately, after configuration.
echo 'Agora Mesh host bootstrap complete.'
