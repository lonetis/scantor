#!/usr/bin/env bash
# Frees disk space on a GitHub-hosted Ubuntu runner (docs/testing.md §12): the images, their tarballs, the test
# runner's cache volume and the task images of the suite need about 40 GB. Drops the preinstalled toolchains and
# images and keeps Docker's data on the larger /mnt disk when there is one. Run before docker/setup-buildx-action,
# whose builder keeps its state under Docker's data root.
set -euo pipefail

sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /usr/local/.ghcup \
  /opt/hostedtoolcache/CodeQL /usr/local/share/boost /usr/share/swift
sudo docker image prune --all --force >/dev/null
if mountpoint -q /mnt && [ "$(df --output=avail -k /mnt | tail -n 1)" -gt "$(df --output=avail -k / | tail -n 1)" ]; then
  sudo systemctl stop docker.socket docker
  sudo mkdir -p /mnt/docker
  config=/etc/docker/daemon.json
  if [ -s "$config" ]; then current="$(sudo cat "$config")"; else current='{}'; fi
  jq '. + {"data-root": "/mnt/docker"}' <<< "$current" | sudo tee "$config" >/dev/null
  sudo systemctl start docker
fi
df -h / /mnt
docker info --format 'Docker data: {{.DockerRootDir}}'
