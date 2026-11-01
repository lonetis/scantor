#!/usr/bin/env bash
# Entrypoint of the test runner (docs/testing.md §7.4). It boots a fresh scantor stack inside this
# container's own dockerd, runs `playwright test` with the arguments of `docker compose run`, and tears
# the stack down on every exit path (normal end, failure, Ctrl+C, docker stop). With
# SCANTOR_TEST_KEEP_ALIVE=true it keeps the stack running after Playwright until it is stopped, so
# `just test-exec` can re-run specs against it.
set -euo pipefail

readonly opt_dir=/opt/scantor-test
readonly src_dir=/src
readonly tests_dir=/work/tests
readonly stack_dir=/run/scantor-test
readonly ca_dir=$stack_dir/ca
readonly dynamic_dir=$stack_dir/traefik/dynamic
readonly env_file=$stack_dir/.env
readonly ready_file=$stack_dir/ready
readonly profile_file=/etc/profile.d/scantor-test.sh
readonly dockerd_log=/var/log/dockerd.log
# The runner's docker0 address (daemon.json "bip"): every *.<domain> name resolves to it.
readonly docker0_address=172.17.0.1
readonly project=scantor

log() { printf '\033[1;36m[test-runner]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[test-runner]\033[0m %s\n' "$*" >&2; }

# stack.env value of a key (the non-secret test settings).
stack_setting() { sed -n "s/^$1=//p" "$opt_dir/stack.env" | tail -n 1; }

domain="$(stack_setting SCANTOR_DOMAIN)"
public_url="$(stack_setting SCANTOR_PUBLIC_URL)"
readonly domain public_url

stack_compose() {
  docker compose -p "$project" --project-directory "$stack_dir" \
    -f "$src_dir/docker-compose.prod.yml" -f "$opt_dir/stack.tests.yml" "$@"
}

# retry <attempts> <command...>: cold pulls through nested Docker hit TLS handshake timeouts now and then.
retry() {
  local attempts="$1" attempt
  shift
  for attempt in $(seq 1 "$attempts"); do
    if "$@"; then return 0; fi
    if [ "$attempt" -lt "$attempts" ]; then
      log "attempt $attempt/$attempts failed: $*; retrying in 5 s"
      sleep 5
    fi
  done
  err "failed after $attempts attempts: $*"
  return 1
}

docker_ready() { docker info >/dev/null 2>&1; }

# ── Phase 9: cleanup (installed as the EXIT trap in phase 0) ──────────────────────────────────────────

# Removes the stack and everything scantor or the tests created in the inner dockerd: the compose project
# (containers, networks, volumes), containers by label (workers, helpers, editors, builds, test runs,
# test-created orchestrators), app-created networks and volumes, task and draft images, and images the
# tests built. Platform images and the build cache stay (the cache volume's purpose). Never prunes
# networks or volumes globally (that breaks BuildKit). Returns 1 when anything could not be removed.
remove_stack() {
  local failed=0 ids
  if [ -f "$env_file" ]; then
    stack_compose down --volumes --remove-orphans --timeout 20 || failed=1
  fi
  ids="$( {
    docker ps -aq --filter label=scantor.managed=true
    docker ps -aq --filter label=scantor.test=true
    docker ps -aq --filter "label=com.docker.compose.project=$project"
  } | sort -u)" || failed=1
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086 # one id per word
    docker rm -f -v $ids >/dev/null || failed=1
  fi
  ids="$( {
    docker network ls -q --filter label=scantor.kind=network
    docker network ls -q --filter "label=com.docker.compose.project=$project"
  } | sort -u)" || failed=1
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    docker network rm $ids >/dev/null || failed=1
  fi
  ids="$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" || failed=1
  # shellcheck disable=SC2086
  docker volume rm -f $ids scantor-workspaces scantor-editor-home >/dev/null || failed=1
  ids="$( {
    docker images --format '{{.Repository}}\t{{.Tag}}' | awk -F'\t' '$1 ~ /(^|\/)tasks\// && $2 != "<none>" { print $1 ":" $2 }'
    docker images -q --filter label=scantor.test=true
  } | sort -u)" || failed=1
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    docker image rm -f $ids >/dev/null || failed=1
  fi
  return "$failed"
}

chown_reports() {
  if [ -n "${SCANTOR_TEST_HOST_UID:-}" ] && [ -n "${SCANTOR_TEST_HOST_GID:-}" ]; then
    local path
    for path in "$tests_dir/playwright-report" "$tests_dir/test-results" "$tests_dir/.auth"; do
      if [ -e "$path" ]; then
        chown -R "$SCANTOR_TEST_HOST_UID:$SCANTOR_TEST_HOST_GID" "$path" || err "could not chown $path"
      fi
    done
  fi
}

playwright_pid=""
playwright_status=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  rm -f "$ready_file"
  if [ -n "$playwright_pid" ] && kill -0 "$playwright_pid" 2>/dev/null; then
    log "Stopping Playwright"
    kill -TERM "$playwright_pid" 2>/dev/null
    wait "$playwright_pid" 2>/dev/null
  fi
  if docker_ready; then
    log "Tearing down the test stack"
    remove_stack || err "the teardown left objects behind (see the messages above)"
  fi
  if [ -n "${dockerd_pid:-}" ] && kill -0 "$dockerd_pid" 2>/dev/null; then
    # A clean shutdown keeps the image store on the cache volume consistent.
    log "Stopping the inner dockerd"
    kill -TERM "$dockerd_pid"
    for _ in $(seq 1 60); do kill -0 "$dockerd_pid" 2>/dev/null || break; sleep 0.5; done
  fi
  chown_reports
  if [ -n "$playwright_status" ]; then status="$playwright_status"; fi
  log "Exit code $status"
  exit "$status"
}

# ── Phase 0: trap ───────────────────────────────────────────────────────────────────────────────────

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ── Phase 1: cgroup v2 nesting ──────────────────────────────────────────────────────────────────────
# Same as the official dind image: move every process of the root cgroup into a child, then enable all
# controllers for children, so inner containers can get CPU and memory limits.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  log "Phase 1: cgroup v2 nesting"
  mkdir -p /sys/fs/cgroup/init
  nested=false
  for _ in $(seq 1 10); do
    xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
    if sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers \
      > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null; then
      nested=true
      break
    fi
    sleep 0.2
  done
  if [ "$nested" != true ]; then
    err "warning: could not enable the cgroup controllers; container limits may fail"
  fi
fi

# ── Phase 1a: no IPv6 on new interfaces ─────────────────────────────────────────────────────────────
# The inner dockerd adds a bridge per network and a veth per container to this network namespace. With IPv6
# on, each gets a link-local address, and Chromium reports every address change as net::ERR_NETWORK_CHANGED,
# which aborts the browser's requests in flight. The stack is IPv4 only; lo and eth0 keep their settings, and
# inner containers have network namespaces of their own.
if [ -d /proc/sys/net/ipv6 ]; then
  log "Phase 1a: IPv6 off for the interfaces created from now on"
  if ! echo 1 > /proc/sys/net/ipv6/conf/default/disable_ipv6; then
    err "warning: could not disable IPv6 for new interfaces; browser requests may fail with net::ERR_NETWORK_CHANGED"
  fi
fi

# ── Phase 2: DNS ────────────────────────────────────────────────────────────────────────────────────
# dnsmasq answers *.<domain> with the docker0 address for this container (127.0.0.1) and for every inner
# container (172.17.0.1, the inner dockerd's DNS); everything else goes to the resolver Docker gave
# this container. Node does not apply RFC 6761 to *.localhost, so the wildcard is needed for it too.
log "Phase 2: DNS (*.$domain -> $docker0_address)"
if ! grep -q '^nameserver 127.0.0.1$' /etc/resolv.conf; then
  grep '^nameserver ' /etc/resolv.conf > /etc/resolv.conf.upstream
fi
cat > /etc/dnsmasq-scantor.conf <<EOF
listen-address=127.0.0.1,$docker0_address
bind-dynamic
address=/$domain/$docker0_address
# resolv-file and no-resolv are mutually exclusive; no-resolv would silently win.
resolv-file=/etc/resolv.conf.upstream
no-poll
# No IPv6 path out of nested Docker: AAAA answers make clients wait for timeouts.
filter-AAAA
cache-size=1000
EOF
dnsmasq --conf-file=/etc/dnsmasq-scantor.conf --pid-file=/run/dnsmasq.pid
echo "nameserver 127.0.0.1" > /etc/resolv.conf
if [ "$(getent hosts "$domain" | awk '{print $1}')" != "$docker0_address" ]; then
  err "dnsmasq does not resolve $domain to $docker0_address"
  exit 1
fi
if ! getent hosts registry-1.docker.io >/dev/null; then
  err "dnsmasq cannot resolve public names through $(tr '\n' ' ' < /etc/resolv.conf.upstream)"
  exit 1
fi

# ── Phase 3: test CA and certificates ───────────────────────────────────────────────────────────────
# Before dockerd starts: Go loads the system roots once per process, and the inner dockerd must trust
# the CA for the registry token realm (SCANTOR_PUBLIC_URL) of every push and pull.
log "Phase 3: throwaway test CA and the wildcard certificate for $domain"
rm -rf "$ca_dir" "$dynamic_dir"
mkdir -p "$ca_dir" "$dynamic_dir"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
  -subj "/CN=scantor test CA $(date -u +%Y%m%dT%H%M%SZ)" \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
  -keyout "$ca_dir/ca.key" -out "$ca_dir/ca.crt" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$domain" \
  -keyout "$dynamic_dir/wildcard.key" -out "$ca_dir/wildcard.csr" 2>/dev/null
openssl x509 -req -in "$ca_dir/wildcard.csr" -CA "$ca_dir/ca.crt" -CAkey "$ca_dir/ca.key" \
  -CAcreateserial -days 30 -out "$dynamic_dir/wildcard.crt" -extfile <(printf '%s\n' \
    "subjectAltName=DNS:$domain,DNS:*.$domain" \
    'basicConstraints=critical,CA:FALSE' \
    'keyUsage=critical,digitalSignature' \
    'extendedKeyUsage=serverAuth') 2>/dev/null
cp "$opt_dir/traefik/tls.yml" "$dynamic_dir/tls.yml"
chmod 0644 "$ca_dir/ca.crt" "$dynamic_dir/wildcard.crt" "$dynamic_dir/tls.yml"
# System store (curl, git, the inner dockerd, the scantor CLI), NSS (Chromium), Node (Playwright requests).
cp "$ca_dir/ca.crt" /usr/local/share/ca-certificates/scantor-test-ca.crt
update-ca-certificates >/dev/null
mkdir -p "$HOME/.pki/nssdb"
if [ ! -f "$HOME/.pki/nssdb/cert9.db" ]; then
  certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password
fi
certutil -d "sql:$HOME/.pki/nssdb" -D -n scantor-test-ca >/dev/null 2>&1 || true
certutil -d "sql:$HOME/.pki/nssdb" -A -t C,, -n scantor-test-ca -i "$ca_dir/ca.crt"
export NODE_EXTRA_CA_CERTS="$ca_dir/ca.crt"

# ── Phase 4: dockerd ────────────────────────────────────────────────────────────────────────────────
log "Phase 4: inner dockerd"
find /run /var/run -iname 'docker*.pid' -delete 2>/dev/null || true
rm -f /var/run/docker.sock
dockerd > "$dockerd_log" 2>&1 &
dockerd_pid=$!
for _ in $(seq 1 60); do
  if docker_ready; then break; fi
  if ! kill -0 "$dockerd_pid" 2>/dev/null; then break; fi
  sleep 0.5
done
if ! docker_ready; then
  err "dockerd did not start within 30 s; last lines of its log:"
  tail -n 50 "$dockerd_log" >&2 || true
  exit 1
fi

# ── Phase 5: stale state ────────────────────────────────────────────────────────────────────────────
# The cache volume keeps the inner dockerd's containers too: an aborted run (SIGKILL) would otherwise
# restart its stack with `restart: unless-stopped`.
log "Phase 5: removing leftovers of earlier runs"
remove_stack || err "some leftovers could not be removed"

# ── Phase 6: images ─────────────────────────────────────────────────────────────────────────────────
# Every image tag of the bake group `test` (the platform images and the fixtures server, tag dev).
test_images() {
  (cd "$src_dir" && IMAGE_PREFIX= IMAGE_TAG=dev docker buildx bake --print test 2>/dev/null) \
    | jq -r '.target[].tags[]' | sort -u
}

if [ -n "${SCANTOR_TEST_IMAGES_DIR:-}" ]; then
  log "Phase 6: loading the images from $SCANTOR_TEST_IMAGES_DIR"
  shopt -s nullglob
  tarballs=("$SCANTOR_TEST_IMAGES_DIR"/*.tar)
  shopt -u nullglob
  if [ "${#tarballs[@]}" -eq 0 ]; then
    err "no *.tar in $SCANTOR_TEST_IMAGES_DIR (just test-images-save writes them)"
    exit 1
  fi
  for tarball in "${tarballs[@]}"; do docker load -q -i "$tarball"; done
elif [ "${SCANTOR_TEST_SKIP_BUILD:-false}" = true ]; then
  log "Phase 6: SCANTOR_TEST_SKIP_BUILD=true, using the images present in the cache volume"
else
  log "Phase 6: building the test images (docker buildx bake test, tag dev)"
  git config --global --add safe.directory "$src_dir"
  commit="$(git -C "$src_dir" rev-parse --short HEAD 2>/dev/null || true)"
  (
    cd "$src_dir"
    export IMAGE_PREFIX= IMAGE_TAG=dev VERSION=dev COMMIT="$commit"
    retry 4 docker buildx bake --load test
  )
fi
missing=()
while IFS= read -r image; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then missing+=("$image"); fi
done < <(test_images)
if [ "${#missing[@]}" -gt 0 ]; then
  err "missing images: ${missing[*]}"
  exit 1
fi

# ── Phase 7: secrets and the stack's .env ───────────────────────────────────────────────────────────
# .env.example with the stack.env values, fresh random secrets (the `just init` merge, docs/deployment.md
# §8.3), a random admin password and the test CA. Never the developer's /src/.env.
log "Phase 7: writing $env_file"
write_env() {
  local line key value ca_pem
  declare -A overrides=()
  while IFS= read -r line; do
    if [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then overrides[${BASH_REMATCH[1]}]=${BASH_REMATCH[2]}; fi
  done < "$opt_dir/stack.env"
  ca_pem="$(awk '{ printf "%s\\n", $0 }' "$ca_dir/ca.crt")"
  admin_password="$(openssl rand -hex 24)"
  umask 077
  while IFS= read -r line; do
    if [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
      if [ -n "${overrides[$key]+set}" ]; then
        value=${overrides[$key]}
        unset "overrides[$key]"
      elif [[ $value == *-insecure-dev ]]; then
        value="$(openssl rand -hex 24)"
      fi
      case "$key" in
        SCANTOR_ADMIN_PASSWORD) value=$admin_password ;;
        SCANTOR_CA_CERT) value="\"$ca_pem\"" ;;
      esac
      printf '%s=%s\n' "$key" "$value"
    else
      printf '%s\n' "$line"
    fi
  done < "$src_dir/.env.example" > "$env_file.tmp"
  if [ "${#overrides[@]}" -gt 0 ]; then
    err "stack.env sets variables that .env.example does not document: ${!overrides[*]}"
    return 1
  fi
  mv "$env_file.tmp" "$env_file"
}
write_env
# The env file's value of a key (unquoted values only).
env_value() { sed -n "s/^$1=//p" "$env_file" | tail -n 1; }

# ── Phase 8: the stack ──────────────────────────────────────────────────────────────────────────────
log "Phase 8: starting the stack (docker-compose.prod.yml + stack.tests.yml, project $project)"
while IFS= read -r image; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    log "pulling $image"
    retry 4 docker pull -q "$image" >/dev/null
  fi
done < <(stack_compose config --images | sort -u)
stack_compose up -d --pull never

# Phase 8a: wait for the orchestrator and every component, through Traefik and the test CA.
log "Phase 8a: waiting for $public_url/api/health"
health_ok() {
  local body
  body="$(curl -fsS --max-time 5 "$public_url/api/health" 2>/dev/null)" || return 1
  jq -e '.status == "ok" and ([.components[]] | all(. == "ok"))' <<< "$body" >/dev/null
}
started=$SECONDS
deadline=$((SECONDS + 300))
until health_ok; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    err "the stack is not healthy after 300 s; last health answer:"
    curl -sS --max-time 5 "$public_url/api/health" >&2 || true
    echo >&2
    stack_compose ps -a >&2 || true
    stack_compose logs --no-color --tail 200 >&2 || true
    exit 1
  fi
  sleep 2
done
log "the stack is healthy after $((SECONDS - started)) s"

# Phase 8b: the simulated remote node (pool "remote").
log "Phase 8b: joining the remote node"
SCANTOR_ADMIN_EMAIL="$(env_value SCANTOR_ADMIN_EMAIL)"
export SCANTOR_PUBLIC_URL="$public_url" SCANTOR_ADMIN_EMAIL SCANTOR_ADMIN_PASSWORD="$admin_password"
if ! node "$opt_dir/join-remote-node.mjs"; then
  err "the remote node did not join; its daemon's log:"
  docker exec scantor-remote-node docker logs --tail 100 scantor-node >&2 || true
  exit 1
fi

# Phase 8c: Playwright.
# The stack's logs after a failed Playwright run, uploaded with the report (docs/testing.md §7.4): phase 9 tears the
# stack down, and failures such as a broker that keeps closing the reconciler's connection show only in these logs.
save_stack_logs() {
  local dir="$tests_dir/test-results/stack-logs" service
  mkdir -p "$dir"
  stack_compose ps -a > "$dir/ps.txt" 2>&1 || err "could not list the stack's containers"
  for service in $(stack_compose ps -a --services 2>/dev/null); do
    stack_compose logs --no-color --timestamps "$service" 2>&1 | gzip > "$dir/$service.log.gz" || err "could not save the log of $service"
  done
  docker exec scantor-remote-node docker logs --timestamps scantor-node 2>&1 | gzip > "$dir/remote-node.log.gz" ||
    err "could not save the remote node daemon's log"
  gzip -c "$dockerd_log" > "$dir/dockerd.log.gz" || err "could not save the inner dockerd's log"
  log "Saved the stack's logs to test-results/stack-logs"
}

log "Phase 8c: Playwright"
cd "$tests_dir"
if ! cmp -s package-lock.json node_modules/.scantor-package-lock.json; then
  log "installing the test dependencies (npm ci into the node_modules volume)"
  npm ci --no-audit --no-fund
  cp package-lock.json node_modules/.scantor-package-lock.json
fi
rm -rf "$tests_dir/.auth"
# The environment of every Playwright run, also for `just test-exec` (a login shell sources it).
{
  printf 'export %s=%q\n' \
    SCANTOR_PUBLIC_URL "$public_url" \
    SCANTOR_EDITOR_URL "$(env_value SCANTOR_EDITOR_URL)" \
    SCANTOR_ADMIN_EMAIL "$SCANTOR_ADMIN_EMAIL" \
    SCANTOR_ADMIN_PASSWORD "$admin_password" \
    SCANTOR_SECRET "$(env_value SCANTOR_SECRET)" \
    SCANTOR_AUTH_RATE_LIMIT_SCALE "$(env_value SCANTOR_AUTH_RATE_LIMIT_SCALE)" \
    NODE_EXTRA_CA_CERTS "$NODE_EXTRA_CA_CERTS" \
    SCANTOR_TEST_WORKERS "${SCANTOR_TEST_WORKERS:-}" \
    SCANTOR_TEST_HOST_UID "${SCANTOR_TEST_HOST_UID:-}" \
    SCANTOR_TEST_HOST_GID "${SCANTOR_TEST_HOST_GID:-}" \
    CI "${CI:-}"
} > "$profile_file"
chmod 0600 "$profile_file"
# shellcheck source=/dev/null
. "$profile_file"
# In the background so that a TERM or INT reaches the trap at once (bash runs traps only between
# foreground commands).
scantor-test-playwright "$@" &
playwright_pid=$!
set +e
wait "$playwright_pid"
playwright_status=$?
set -e
playwright_pid=""
log "Playwright exited with $playwright_status"
if [ "$playwright_status" -ne 0 ]; then save_stack_logs; fi

# Phase 8d: keep alive.
if [ "${SCANTOR_TEST_KEEP_ALIVE:-false}" = true ]; then
  touch "$ready_file"
  log "Keeping the test stack alive (SCANTOR_TEST_KEEP_ALIVE=true)."
  log "  re-run specs:  just test-exec <playwright args>"
  log "  a shell:       docker exec -it scantor-test-runner bash -l"
  log "  tear down:     just test-down (or Ctrl+C here)"
  tail -f /dev/null &
  wait $!
fi

exit "$playwright_status"
