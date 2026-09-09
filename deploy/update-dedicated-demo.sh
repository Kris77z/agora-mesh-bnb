#!/usr/bin/env bash
# Update an already-activated dedicated demo to a new revision.
#
# build-demo.sh and activate-dedicated-demo.sh are first-deployment helpers and
# refuse to touch an existing release or `current` link. This script is the
# update path: it builds the new revision beside the running one, re-points the
# release at the live state directories instead of its own seed copies, and only
# then moves the `current` symlink. A failed build leaves the running release
# untouched.
#
# It broadcasts no transactions, reads no secrets, and reuses the existing
# venv/solc-select toolchain. Run it on the dedicated server only.
#
# Usage: sudo bash update-dedicated-demo.sh <40-character-commit>
set -euo pipefail
task_base=/srv/agora-mesh
task_revision="${1:?Pass the committed release SHA}"
[[ "$task_revision" =~ ^[a-f0-9]{40}$ ]]
task_release=$task_base/releases/$task_revision

# Preconditions: a first deployment must already be active.
test -L "$task_base/current"
test -x "$task_base/venv/bin/slither"
test -d "$task_base/state/registry"
test -d "$task_base/state/memory"

task_previous=$(readlink -f "$task_base/current")
if [ "$task_previous" = "$task_release" ]; then
  echo "Revision $task_revision is already active."
  exit 0
fi

if [ ! -d "$task_release" ]; then
  git clone --quiet https://github.com/Kris77z/agora-mesh-bnb.git "$task_release"
  git -C "$task_release" checkout --quiet --detach "$task_revision"
  # Carry the build-time public config forward, including any origin fix applied
  # to the running release. Runtime secrets stay in config/*.env and are not copied.
  cp -a "$task_previous/frontend/.env.production" "$task_release/frontend/.env.production"
  chown -R agora-mesh:agora-mesh "$task_release"
  runuser -u agora-mesh -- env npm_config_cache="$task_base/state/npm-cache" \
    npm ci --prefix "$task_release" --no-audit --no-fund
  cd "$task_release"
  # Peak build memory was measured at 2.9 GB on this 4 GB host with nothing else
  # running. If the build is OOM-killed, stop agora-mesh@frontend and re-run.
  runuser -u agora-mesh -- env NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=1536 \
    npm run build --workspace @rebel/frontend
fi

test -f "$task_release/frontend/.next/BUILD_ID"

# The live registry and Hunter memory belong to state/, not to a release. Swap the
# new release's seed copies for links, exactly as the activate script does, so an
# update never rolls server state back to whatever was committed.
if [ ! -L "$task_release/registry" ]; then
  mv "$task_release/registry" "$task_release/registry-seed"
  ln -s "$task_base/state/registry" "$task_release/registry"
fi
if [ ! -L "$task_release/agents/hunter/memory" ]; then
  mv "$task_release/agents/hunter/memory" "$task_release/agents/hunter/memory-seed"
  ln -s "$task_base/state/memory" "$task_release/agents/hunter/memory"
fi
chown -R agora-mesh:agora-mesh "$task_release"

# Atomic swap: ln -sfn onto an existing symlink would nest inside it.
ln -sfn "$task_release" "$task_base/current.new"
mv -Tf "$task_base/current.new" "$task_base/current"

systemctl restart \
  agora-mesh@registry agora-mesh@auditor agora-mesh@sentinel \
  agora-mesh@verifier agora-mesh@investigator agora-mesh@hunter agora-mesh@frontend

echo "Activated $task_revision"
echo "Previous release kept at $task_previous"
echo "Roll back with: ln -sfn $task_previous $task_base/current.new && mv -Tf $task_base/current.new $task_base/current && systemctl restart 'agora-mesh@*'"
