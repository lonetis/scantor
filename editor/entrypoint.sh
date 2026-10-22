#!/bin/sh
# Entrypoint of the scantor-editor image (docs/editor.md §2.4). It replaces the
# official image's fixuid entrypoint, which needs setuid and therefore fails with
# no-new-privileges and a read-only rootfs. The container always runs as 1000:1000.
set -eu
umask 022

data="$HOME/.local/share/code-server"
mkdir -p "$data/Machine" "$data/User"
# Rewritten on every start, so users cannot weaken the machine settings permanently.
cp /opt/scantor/editor/machine-settings.json "$data/Machine/settings.json"
[ -f "$HOME/.bashrc" ] || cp /etc/skel/.bashrc "$HOME/.bashrc"
[ -f "$HOME/.profile" ] || cp /etc/skel/.profile "$HOME/.profile"
# The Go connector's dependencies from the image into the persistent module cache, so gopls and
# builds of scaffolded tasks resolve them without network. Files already there are kept.
if ! { mkdir -p "$GOMODCACHE" && cp -R --update=none /opt/scantor/gomodcache/. "$GOMODCACHE/"; }; then
  echo "scantor-editor: could not seed $GOMODCACHE; Go modules are downloaded on first use" >&2
fi

exec /usr/bin/code-server "$@"
