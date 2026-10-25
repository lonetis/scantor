#!/usr/bin/env bash
# Makes the repository's connectors live at the base-image paths of the toolchain image, so edits
# reach IntelliSense, the language servers and `dev run` builds without an image rebuild
# (docs/development.md §2).
set -euo pipefail
repo="$(pwd)"

# The connector paths belong to uid 1000. When the devcontainer remapped the user to another host uid,
# the relink needs root (common-utils gives the user passwordless sudo).
as_owner() {
  if [ -w /node_modules/@scantor ] && [ -w /opt/scantor/connectors ] && [ -w /usr/local/lib/python3.14/site-packages ]; then
    "$@"
  else
    sudo "$@"
  fi
}

echo "==> Linking the connectors to the repository"
as_owner uv pip install --system --break-system-packages --no-deps --editable "$repo/connectors/python"
# The image ships real directories at these paths; ln -sfn would create the link inside them.
as_owner rm -rf /node_modules/@scantor/connector /opt/scantor/connectors/go
as_owner ln -sfn "$repo/connectors/js" /node_modules/@scantor/connector
as_owner ln -sfn "$repo/connectors/go" /opt/scantor/connectors/go

echo "==> Creating .env and the tool caches"
just init

echo "==> Installing node_modules for editors"
just deps
