#!/usr/bin/env bash
# Makes the repository's connectors live at the base-image paths of the toolchain image, so edits
# reach IntelliSense, the language servers and `dev run` builds without an image rebuild
# (docs/development.md §2).
set -euo pipefail
repo="$(pwd)"

echo "==> Linking the connectors to the repository"
uv pip install --system --break-system-packages --no-deps --editable "$repo/connectors/python"
# The image ships real directories at these paths; ln -sfn would create the link inside them.
rm -rf /node_modules/@scantor/connector /opt/scantor/connectors/go
ln -sfn "$repo/connectors/js" /node_modules/@scantor/connector
ln -sfn "$repo/connectors/go" /opt/scantor/connectors/go

echo "==> Creating .env and the tool caches"
just init

echo "==> Installing node_modules for editors"
just deps
