#!/bin/sh
# scantor CLI through Docker: runs the scantor image with the current directory, the Docker socket
# and the CLI's environment variables, as the invoking user. Install it as `scantor` on your PATH:
#
#   curl -fsSLo ~/.local/bin/scantor https://github.com/lonetis/scantor/releases/download/v<version>/scantor.sh
#   chmod +x ~/.local/bin/scantor
#
# Credentials come from SCANTOR_URL and SCANTOR_TOKEN (see the CLI section of .env.example). The
# image is <SCANTOR_IMAGE_PREFIX>scantor:<SCANTOR_IMAGE_TAG>; unset, the prefix is ghcr.io/lonetis/
# and the tag is the release this file belongs to. Only paths below the current directory are
# visible to the CLI. Inside the container the CLI reaches a localhost URL through
# host.docker.internal: the host gateway on Docker Desktop, and on a Linux Docker Engine the
# host's own loopback, because the container then shares the host network (Docker publishes a
# port bound to 127.0.0.1 only there, not on the gateway address).
set -eu

# Replaced with the release version by .github/workflows/release.yml.
default_tag="latest"

prefix="${SCANTOR_IMAGE_PREFIX-ghcr.io/lonetis/}"
tag="${SCANTOR_IMAGE_TAG:-$default_tag}"

# The host's Docker socket (rootless Docker: /run/user/<uid>/docker.sock).
socket="${SCANTOR_DOCKER_SOCKET:-/var/run/docker.sock}"

# The container runs as the invoking user with the group that owns the Docker socket: the host's
# group on Linux, root inside the VM of Docker Desktop and similar setups. Rootless Docker maps
# container root to the invoking user and cannot run other host uids, so there it runs as root.
user="$(id -u):$(id -g)"
socket_gid=0
info=""
if [ "$(uname -s)" = Linux ]; then
  info="$(docker info --format '{{.OperatingSystem}} {{json .SecurityOptions}}' 2>/dev/null || true)"
  case "$info" in
    *name=rootless*) user="0:0" ;;
    *) if [ -S "$socket" ]; then socket_gid="$(stat -L -c %g "$socket")"; fi ;;
  esac
fi

# How the container reaches the host's localhost. Docker Desktop (also on Linux) routes the host
# gateway to it; a Linux Docker Engine does not for ports bound to 127.0.0.1, such as the dev stack's.
network="--add-host host.docker.internal:host-gateway"
if [ "$(uname -s)" = Linux ]; then
  case "$info" in
    "Docker Desktop"*) ;;
    *) network="--network host --add-host host.docker.internal:127.0.0.1" ;;
  esac
fi

tty=""
if [ -t 0 ] && [ -t 1 ]; then
  tty="-t"
fi

# Variables the CLI reads (.env.example, section CLI); each is passed only when it is set. The image
# pair is always passed, so base images match the CLI image.
# shellcheck disable=SC2086 # $network and $tty are lists of flags
exec docker run --rm -i $tty --init \
  -u "$user" --group-add "$socket_gid" -e HOME=/tmp \
  -v "$PWD:$PWD" -w "$PWD" \
  -v "$socket:/var/run/docker.sock" \
  $network \
  -e SCANTOR_URL -e SCANTOR_TOKEN -e SCANTOR_CA_CERT -e SCANTOR_DEV_MODE \
  -e SCANTOR_IMAGE_PREFIX="$prefix" -e SCANTOR_IMAGE_TAG="$tag" \
  -e SCANTOR_TRANCO_URL -e SCANTOR_CRUX_URL -e SCANTOR_CRUX_CACHE_URL \
  -e SCANTOR_MAX_WORKERS_PER_SCAN -e SCANTOR_MAX_PROCESSES_PER_WORKER \
  -e SCANTOR_BUILD_TIMEOUT -e SCANTOR_MAX_IMAGE_BYTES -e SCANTOR_BUILD_CACHE_MAX_BYTES \
  -e SCANTOR_DESCRIBE_TIMEOUT -e SCANTOR_TASK_MAX_PACK_BYTES -e SCANTOR_TASK_MAX_FILES \
  -e SCANTOR_TASK_MAX_BYTES -e SCANTOR_PUBLIC_URL -e SCANTOR_REGISTRY_PUBLIC_HOST \
  "${prefix}scantor:${tag}" "$@"
