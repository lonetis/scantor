# Adding remote nodes

A node is a Docker host that runs scan workers. Every scantor installation has a built-in node on the
master; remote nodes add capacity, other architectures, other networks or Docker-in-Docker support. A
remote node runs one container, the node daemon (`scantor node`), which connects **outbound only** to
the master over HTTPS: it opens no ports, so it works behind NAT and firewalls that allow outgoing
connections. Adding, changing and removing nodes needs an admin account.

A node sees everything about the scans placed on it, including their configs, secrets and credentials.
Add only machines you trust like the master.

## Requirements

On the node host:

- Docker Engine 25 or newer (29 is tested).
- Outbound connections to the four public endpoints of the master (below), and optionally to `ghcr.io`
  for base image layers.
- For Docker-in-Docker with `sysbox`: [Sysbox](https://github.com/nestybox/sysbox) installed.

On the master, the public endpoints that nodes and their workers use:

| Endpoint | With Traefik (recommended) | Without Traefik (private networks only) |
|---|---|---|
| API (`SCANTOR_PUBLIC_URL`) | `https://<domain>` | `http://<private IP>:<port>` |
| registry (`SCANTOR_REGISTRY_PUBLIC_HOST`) | `registry.<domain>` | `<private IP>:<registry port>`, plus `insecure-registries` on every node host |
| message broker (`SCANTOR_AMQP_PUBLIC_URL`) | `amqps://amqp.<domain>:443` | `amqp://<private IP>:<amqp port>` |
| object storage (`SCANTOR_S3_PUBLIC_URL`) | `https://s3.<domain>` | `http://<private IP>:<s3 port>` |

With Traefik every endpoint is TLS on port 443, so a node needs nothing but outbound HTTPS. Set these
variables in the master's `.env` (see `.env.example`). Without Traefik the master must listen on the
private address (`SCANTOR_BIND_ADDRESS`).

## Join a node

1. **Create the node** in the web UI (**Admin → Nodes → Add node**) or with the CLI:

   ```sh
   scantor nodes create scan-eu-1 --pool remote --label region=eu --max-workers 8
   ```

   You get the node token (`snt_…`, **shown only once**), a `docker run` command and a Docker Compose
   file, both filled in with the master's URL, the token and the node image for your version.

2. **Start the daemon on the node host**, either with the command:

   ```sh
   docker run -d --name scantor-node --restart unless-stopped \
     -v /var/run/docker.sock:/var/run/docker.sock \
     -e SCANTOR_URL=https://scantor.example.com \
     -e SCANTOR_NODE_TOKEN=snt_… \
     ghcr.io/lonetis/scantor:<version> node
   ```

   or with the compose file, saved as `compose.yml` in an empty directory and started with
   `docker compose up -d`:

   ```yaml
   name: scantor-node

   services:
     node:
       image: ghcr.io/lonetis/scantor:<version>
       command: ["node"]
       restart: unless-stopped
       healthcheck:
         test: ["CMD", "/usr/local/bin/scantor", "node", "healthcheck"]
         interval: 30s
         timeout: 5s
         retries: 3
         start_period: 60s
       container_name: scantor-node
       stop_grace_period: 30s
       volumes:
         - /var/run/docker.sock:/var/run/docker.sock
       environment:
         - SCANTOR_URL=https://scantor.example.com
         - SCANTOR_NODE_TOKEN=snt_…
         # optional:
         # - SCANTOR_NODE_MAX_WORKERS=8
         # - SCANTOR_NODE_DIND=sysbox
         # - SCANTOR_CA_CERT=-----BEGIN CERTIFICATE-----...
   ```

   Use the exact snippet the master printed: it has the right image and URL. `scantor nodes join
   <node>` (or "Show join command" in the UI) prints both again later, with the token replaced by
   `${SCANTOR_NODE_TOKEN}`.

3. **Check it.** The node changes from `pending` to `online` once the daemon has said hello:

   ```sh
   scantor nodes get scan-eu-1     # state, architecture, CPUs, memory, disk, DinD mode, version
   docker logs scantor-node        # on the node host
   ```

The daemon needs the Docker socket and runs as root in its container. It manages only the containers it
created (named `scantor-w-…`) and the network `scantor-workers`, which it creates with traffic between
containers disabled. Optional daemon settings (`SCANTOR_NODE_MAX_WORKERS`, `SCANTOR_NODE_DIND`,
`SCANTOR_NODE_EGRESS_DENY`, the worker container limits such as `SCANTOR_NODE_PIDS_LIMIT`, logging) are
environment variables of the daemon container; `.env.example` lists them all with their defaults. Never
give a remote node `SCANTOR_SECRET`.

## Tokens

| Action | CLI | Effect |
|---|---|---|
| show the join snippets | `scantor nodes join <node>` | the token is shown only at creation and rotation; the snippets use `${SCANTOR_NODE_TOKEN}` |
| rotate | `scantor nodes token rotate <node>` | prints a new token and the join snippets; the running daemon is rejected until you restart it with the new token |
| revoke | `scantor nodes token revoke <node>` | the node becomes `revoked`, its workers are replaced elsewhere and it can no longer pull images; rotate to bring it back |
| delete | `scantor nodes delete <node>` | as revoke, then the record is removed |

A daemon whose token stops working keeps its workers for a short while, retries every minute and then
removes its worker containers. Only one daemon per token is accepted. A second daemon with the same token
on another host is refused (`nodeInstanceConflict` in its log). On the same host the daemon started last
takes over, and the other one logs that it is standing by because another daemon instance holds the
node's lease; it touches no containers and takes over only when the active daemon stops reporting. The
built-in node's token is derived from the master's secret and cannot be rotated, revoked or deleted.

## Pools, labels and capacity

Every node has a **pool** (default `shared`) and **labels**. Scans run only on nodes whose pool equals
the scan's `nodeSelector.pool` (default `shared`) and whose labels include all of `nodeSelector.labels`.

| Goal | How |
|---|---|
| add general capacity | keep the pool `shared`: every scan can use the node |
| reserve nodes for specific scans | `--pool remote`, then start scans with `--settings '{"nodeSelector": {"pool": "remote"}}'` |
| select by property | `--label region=eu`, then `--settings '{"nodeSelector": {"pool": "remote", "labels": {"region": "eu"}}}'` |
| limit workers on a node | `--max-workers 8` (admin), or `SCANTOR_NODE_MAX_WORKERS` on the daemon (0 = number of CPUs); the smaller one wins |
| stop new workers before maintenance | `scantor nodes update <node> --cordoned` (`--cordoned=false` lifts it) |

Workers are placed only on online nodes with the right architecture (an image built on an `amd64`
master runs only on `amd64` nodes), enough free CPUs, memory and disk, and Docker-in-Docker support for
privileged tasks. When no node fits, the scan shows the condition `workersPending` with the reason.
`scantor nodes workers <node>` lists what runs on a node.

## TLS and certificates

The daemon and the workers always verify TLS certificates; there is no switch to skip verification.

- **Public certificates** (Traefik with ACME, for example Let's Encrypt): nothing to do on the nodes.
- **Private CA** (a private ACME server or your own certificate): give the daemon the CA certificate in
  `SCANTOR_CA_CERT` (PEM; it is added to the system roots and passed to every worker), for example
  `-e SCANTOR_CA_CERT="$(cat ca.pem)"`, or in the compose file:

  ```yaml
      environment:
        - SCANTOR_URL=https://scantor.example.com
        - SCANTOR_NODE_TOKEN=snt_…
        - |
          SCANTOR_CA_CERT=-----BEGIN CERTIFICATE-----
          MIIB…
          -----END CERTIFICATE-----
  ```

  Image pulls are made by the node host's Docker daemon, which does not read `SCANTOR_CA_CERT`. Install
  the CA on the host as `/etc/docker/certs.d/<registry host>/ca.crt` and in the host's trust store (the
  registry login goes to the master's API URL), then restart Docker.
- Traefik's built-in self-signed certificate changes on every restart and cannot be trusted; it is for
  local tests only.

## Private networks without TLS

Plaintext (`http://`, `amqp://`) is accepted only when the master's address is loopback, private
(RFC 1918: `10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`, used by WireGuard and Tailscale) or
IPv6 ULA (`fc00::/7`). The check uses the address actually connected to, so a public DNS name that
resolves to a private address works. Everything else needs TLS, unless you set
`SCANTOR_ALLOW_INSECURE_TRANSPORT=true` on the daemon, which sends tokens and scan data unencrypted.

Docker pulls from a plaintext registry only when the node host allows it. Add the registry to
`/etc/docker/daemon.json` on every node host and restart Docker:

```json
{ "insecure-registries": ["10.0.0.5:5000"] }
```

## Egress deny

Workers must not reach cloud metadata services. The daemon installs firewall rules (in Docker's
`DOCKER-USER` chain) that reject traffic from containers to the ranges in `SCANTOR_NODE_EGRESS_DENY`
(by default link-local `169.254.0.0/16`, the AWS IPv6 metadata address and the Alibaba metadata
address) and re-applies them every 10 minutes.

- On internet-only nodes you can add private ranges (`10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`), but
  only when the master is reached through a public address: otherwise workers cannot reach it either.
- The rules cannot be applied with Docker's experimental nftables firewall backend, with rootless Docker,
  or for IPv6 ranges when IPv6 is disabled in Docker. The node page then warns "egress deny not applied"
  and the daemon logs why.
- On cloud VMs, also limit the metadata service to the host (for example AWS IMDSv2 with a hop limit
  of 1).
- `SCANTOR_NODE_EGRESS_DENY=none` switches the rules off. An empty value keeps the default ranges, so a
  missing line in `.env` never disables them.

## Docker-in-Docker

Tasks with `defaults.privileged: true` in their [manifest](manifest.md) run Docker inside their
workers. They need the owner's `canRunPrivileged` permission and a node with Docker-in-Docker enabled:

| `SCANTOR_NODE_DIND` | Workers | Requirements | Trust |
|---|---|---|---|
| `disabled` (default) | never privileged | – | – |
| `sysbox` (preferred) | system containers with the `sysbox-runc` runtime | Sysbox installed on the host | Docker-in-Docker without root on the host |
| `privileged` | `--privileged` containers | – | **root on the node host**: dedicated nodes only |

If Sysbox is missing, the node reports Docker-in-Docker as disabled and logs an error. Privileged scans
wait with `workersPending` (reason `dindUnavailable`) until a matching node is online. Keep the
built-in node `disabled`: enabling it makes every user with `canRunPrivileged` root on the master.

## Operating a node

| Task | Procedure |
|---|---|
| upgrade the daemon | pull the new image and recreate the daemon container; running workers continue and are adopted by the new daemon |
| reboot the host | optionally cordon the node first; after the reboot the daemon restarts the workers that are still needed |
| decommission | cordon the node and wait until no workers remain (`scantor nodes workers <node>`), or delete the node at once (its workers are replaced elsewhere); then stop the daemon |

When the master is unreachable, the daemon keeps its workers running and retries; workers continue as
long as they reach the message broker. When the master has not heard from a node for 60 seconds
(instance setting), the node becomes `offline`, its workers are replaced on other nodes, and their
unfinished analyses are processed again. The daemon removes the replaced workers when it reconnects.

`scantor nodes events <node>` shows the node's history (online, offline, token changes, conflicts).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| the node stays `pending` | the daemon never reached the master: check `docker logs scantor-node` for refused plaintext connections, TLS errors or `401` (wrong token) |
| the daemon exits at start | an invalid setting (unknown `SCANTOR_NODE_DIND`, malformed CIDRs, a token together with `SCANTOR_NODE_BUILTIN=true`) or a refused plaintext URL; the log names it |
| the node goes `offline` although the daemon runs | the log shows `401` (token rotated or revoked: restart with the new token) |
| the daemon log shows `nodeInstanceConflict` or says it is standing by | a second daemon runs with the same token, on this host or another: stop one of them |
| the daemon log says the worker network is not usable | a network named `scantor-workers` exists that scantor did not create as an isolated network (the log names what differs): remove it with `docker network rm scantor-workers` and the daemon creates it again |
| scans show `imagePullFailed` | the node host's Docker cannot reach or trust the registry or the master's API URL: check DNS and firewall from the host, the CA in `/etc/docker/certs.d/` and the host trust store, or `insecure-registries` |
| scans show `workersPending` | read the reason: `selectorMismatch` (pool or labels), `archMismatch` (no node with the image's architecture), `insufficientCapacity`, `dindUnavailable`, `diskLow` |
| workers cannot reach the broker on port 443 | the broker is routed by TLS server name: the URL must use the hostname `amqp.<domain>`, never an IP address |
| large uploads from workers fail | a proxy or CDN in front of `s3.<domain>` re-chunks requests (disable proxying for that host), or uploads take longer than Traefik's read timeout (`SCANTOR_TRAEFIK_READ_TIMEOUT` on the master) |
| the node page warns about the clock | the node's clock is off by more than 2 s: enable NTP on the host |
| "egress deny not applied" | see [egress deny](#egress-deny) |
