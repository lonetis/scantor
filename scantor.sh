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
# host.docker.internal.
set -eu

# Replaced with the release version by .github/workflows/release.yml.
default_tag="latest"

prefix="${SCANTOR_IMAGE_PREFIX-ghcr.io/lonetis/}"
tag="${SCANTOR_IMAGE_TAG:-$default_tag}"

# The container user needs the group that owns the Docker socket: the host's group on Linux, root
# inside the VM of Docker Desktop and similar setups.
socket_gid=0
if [ "$(uname -s)" = Linux ] && [ -S /var/run/docker.sock ]; then
  socket_gid="$(stat -L -c %g /var/run/docker.sock)"
fi

tty=""
if [ -t 0 ] && [ -t 1 ]; then
  tty="-t"
fi

# Variables the CLI reads (.env.example, section CLI); each is passed only when it is set. The image
# pair is always passed, so base images match the CLI image.
exec docker run --rm -i $tty --init \
  -u "$(id -u):$(id -g)" --group-add "$socket_gid" -e HOME=/tmp \
  -v "$PWD:$PWD" -w "$PWD" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --add-host host.docker.internal:host-gateway \
  -e SCANTOR_URL -e SCANTOR_TOKEN -e SCANTOR_CA_CERT -e SCANTOR_DEV_MODE \
  -e SCANTOR_IMAGE_PREFIX="$prefix" -e SCANTOR_IMAGE_TAG="$tag" \
  -e SCANTOR_TRANCO_URL -e SCANTOR_CRUX_URL \
  -e SCANTOR_MAX_WORKERS_PER_SCAN -e SCANTOR_MAX_PROCESSES_PER_WORKER \
  -e SCANTOR_BUILD_TIMEOUT -e SCANTOR_MAX_IMAGE_BYTES -e SCANTOR_BUILD_CACHE_MAX_BYTES \
  -e SCANTOR_DESCRIBE_TIMEOUT -e SCANTOR_TASK_MAX_PACK_BYTES -e SCANTOR_TASK_MAX_FILES \
  -e SCANTOR_TASK_MAX_BYTES -e SCANTOR_PUBLIC_URL -e SCANTOR_REGISTRY_PUBLIC_HOST \
  "${prefix}scantor:${tag}" "$@"
