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
  runuser -u agora-mesh -- node "$task_release/frontend/scripts/sync-landing.mjs"
  echo "Revision $task_revision is already active; landing assets synced."
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

  if [ -n "${AGORA_PREBUILT_NEXT:-}" ]; then
    # CI already built this revision on a larger machine. `next build` peaks near
    # 2.9 GB here, which does not fit beside the running services on 4 GB.
    test -f "$AGORA_PREBUILT_NEXT"
    rm -rf "$task_release/frontend/.next"
    tar -C "$task_release/frontend" -xzf "$AGORA_PREBUILT_NEXT"
    chown -R agora-mesh:agora-mesh "$task_release/frontend/.next"
  else
    cd "$task_release"
    # If this is OOM-killed, stop agora-mesh@frontend and re-run, or build in CI
    # and pass AGORA_PREBUILT_NEXT.
    runuser -u agora-mesh -- env NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=1536 \
      npm run build --workspace @rebel/frontend
  fi
fi

test -f "$task_release/frontend/.next/BUILD_ID"
# Public files are separate from .next and must exist even with a CI build.
runuser -u agora-mesh -- node "$task_release/frontend/scripts/sync-landing.mjs"

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
