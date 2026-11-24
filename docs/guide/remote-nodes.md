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
- Outbound connections to the four public endpoints of the master (below), and to the registry of the
  node image: `ghcr.io`, unless the master's `SCANTOR_IMAGE_PREFIX` names a mirror. The `docker run`
  command of the master pulls the node daemon image `scantor:<version>` from there, for the first start
  and for every upgrade. The base image layers of task images also come from there when it is reachable;
  otherwise the master's registry sends them with the task image.
- For the node's DNS resolver (see [name resolution](#name-resolution)): outbound DNS, UDP and TCP port 53, to
  its upstream servers (`SCANTOR_NODE_DNS_UPSTREAMS`) or, in mode `iterative`, to any DNS server on the internet;
  no DNS server on the host bound to all addresses (`0.0.0.0:53`); and a host firewall that lets containers reach
  their network's gateway on port 53. Without these the node still works, and its workers use Docker's own DNS.
  For a master that only your internal DNS knows, the host also needs a usable nameserver in `/etc/resolv.conf`
  (a cloud's link-local one such as `169.254.169.254` works) or in Docker's `daemon.json` `dns` setting.
- For Docker-in-Docker with `sysbox`: [Sysbox](https://github.com/nestybox/sysbox) installed.

On the master, the public endpoints that nodes and their workers use:

| Endpoint | With Traefik (recommended) | Without Traefik (private networks only) |
|---|---|---|
| API (`SCANTOR_PUBLIC_URL`) | `https://<domain>` | `http://<private IP>:<port>` |
| registry (`SCANTOR_REGISTRY_PUBLIC_HOST`) | `registry.<domain>` | `<private IP>:<registry port>`, plus `insecure-registries` on every node host |
| message broker (`SCANTOR_AMQP_PUBLIC_URL`) | `amqps://amqp.<domain>:443` | `amqp://<private IP>:<amqp port>` |
| object storage (`SCANTOR_S3_PUBLIC_URL`) | `https://s3.<domain>` | `http://<private IP>:<s3 port>` |

With Traefik every endpoint is TLS on port 443, so a node reaches the master with nothing but outbound HTTPS.
Set these variables in the master's `.env` (see `.env.example`). Without Traefik the master must listen on the
private address (`SCANTOR_BIND_ADDRESS`).

A node never uses the tunnel URL of a master with a Cloudflare Tunnel (`SCANTOR_TUNNEL_URL`): the tunnel serves
only the web UI, the API for users and the MCP server, and answers 404 to the requests of nodes and workers. Its
`SCANTOR_URL` is always the public URL above, which the join command fills in.

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
         # rootless Docker: /run/user/<uid>/docker.sock:/var/run/docker.sock
         - /var/run/docker.sock:/var/run/docker.sock
       environment:
         - SCANTOR_URL=https://scantor.example.com
         - SCANTOR_NODE_TOKEN=snt_…
         # optional:
         # - SCANTOR_NODE_MAX_WORKERS=8
         # - SCANTOR_NODE_DIND=sysbox
         # - SCANTOR_CA_CERT=-----BEGIN CERTIFICATE-----...
         # rootless Docker without br_netfilter (workers can then reach each other):
         # - SCANTOR_ALLOW_UNISOLATED_NETWORKS=true
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
created (workers `scantor-w-…`, its DNS resolver `scantor-dns-…` with the probe `scantor-dnsprobe-…`, and the
firewall helper `scantor-netpol-…`) and the network `scantor-workers`, which it creates with traffic between
containers disabled. Optional daemon settings (`SCANTOR_NODE_MAX_WORKERS`, `SCANTOR_NODE_DIND`,
`SCANTOR_NODE_EGRESS_DENY`, the worker container limits such as `SCANTOR_NODE_PIDS_LIMIT`, the DNS resolver's
`SCANTOR_NODE_DNS_*`, `SCANTOR_NODE_OVERRIDES`, logging) are environment variables of the daemon container;
`.env.example` lists them all with their defaults (section "Node resolver" for the DNS settings). Admins can
change some of them on a running daemon ([daemon overrides](#daemon-overrides)). Never give a remote node
`SCANTOR_SECRET`.

**Rootless Docker.** Mount the user's socket instead of `/var/run/docker.sock`
(`-v /run/user/<uid>/docker.sock:/var/run/docker.sock`). Rootless Docker cannot disable traffic between
containers unless root loads the `br_netfilter` kernel module; without it the daemon creates no
`scantor-workers` network and runs no worker. `SCANTOR_ALLOW_UNISOLATED_NETWORKS=true` lets it create the
network without that isolation: workers of different scans and users on the node can then reach each other,
and Admin → Nodes shows "Network not isolated" for the node. Current versions of rootless Docker also start
RootlessKit with `--detach-netns`, which keeps the node's DNS resolver from seeing the worker network: the node
then shows the resolver as failed (`bindUnavailable`) and its workers use Docker's DNS. Set
`DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=false` in the environment of the user's `docker.service` and restart it
to use the resolver.

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
| limit workers on a node | the admin worker limit `scantor nodes update <node> --max-workers 8` (persistent), or `SCANTOR_NODE_MAX_WORKERS` on the daemon (0 = number of CPUs); the smaller one wins. An admin can also replace the daemon's value until the daemon restarts, also above `SCANTOR_NODE_MAX_WORKERS` ([daemon overrides](#daemon-overrides)) |
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

## Name resolution

Every node runs one DNS resolver for its workers, the **node resolver**: a container `scantor-dns-…` that the
daemon starts from its own image on the host network, bound only to port 53 of the worker network's gateway and
answering only that network's containers. Workers keep Docker's DNS for container names and send every other name
to it, so all processes of a node share one cache instead of each asking the network on its own.
`SCANTOR_NODE_DNS_MODE` selects how it resolves:

| Mode | Lookups go to | Needs |
|---|---|---|
| `recursive` | the upstream servers of `SCANTOR_NODE_DNS_UPSTREAMS` (`ip`, `ip:port`, `[v6]:port`, or `host` for the host's own nameservers) | outbound DNS to them |
| `iterative` | the root servers (`SCANTOR_NODE_DNS_ROOT_SERVERS`; empty means the IANA root servers), then the authoritative servers of each name | outbound DNS to any server |
| `disabled` | no resolver: workers use Docker's DNS, the host's nameservers | – |

The servers in `SCANTOR_NODE_DNS_UPSTREAMS` and `SCANTOR_NODE_DNS_ROOT_SERVERS` may be private or local, such as the
site's resolver at `10.0.0.53`, systemd-resolved's `127.0.0.53` or the cloud's `169.254.169.253`: the resolver trusts
the servers of its environment. It never queries such addresses otherwise, so a hostile zone cannot point it at
your network.

The master's hostnames, the template data sources, `localhost`, `internal`, `home.arpa`, the private reverse zones
and the domains in `SCANTOR_NODE_DNS_LOCAL_DOMAINS` always go to the host's own nameservers, so a master or a mirror
that only your internal DNS knows stays reachable in every mode. That needs a nameserver the resolver can use in the
host's `/etc/resolv.conf` (IPv4 link-local ones such as GCE's `169.254.169.254` work, IPv6 link-local ones do not)
or in Docker's `daemon.json` `dns` setting; without one these names go to the upstream or root servers, and the
resolver's log warns "no usable host nameservers". `SCANTOR_NODE_DNS_CACHE_SIZE`, `SCANTOR_NODE_DNS_MAX_LOOKUPS`,
`SCANTOR_NODE_DNS_UPSTREAM_QPS` and `SCANTOR_NODE_DNS_AUTHORITATIVE_QPS` size it; the cache size counts the memory
the answers take, not their bytes on the wire, and the resolver container may use twice the cache size plus
768 MiB. An invalid mode, server list or domain list stops the daemon at start.

New workers use the resolver only while it is ready: running, answering, its upstream or root servers answering,
and reachable from the worker network. Otherwise they use Docker's DNS, so a firewalled node never loses name
resolution, and every worker keeps the choice made when it was created. `scantor nodes get <node>` and the node
page show the resolver's state:

| State | Meaning | What to do |
|---|---|---|
| `ready` | new workers use it | – |
| `starting` | it was just created or adopted | wait a few seconds |
| `degraded` | no upstream or root server answers | allow outbound DNS, or set `SCANTOR_NODE_DNS_UPSTREAMS=host` |
| `unreachable` | containers cannot reach the gateway's port 53 | allow it in the host firewall ([troubleshooting](#troubleshooting)) |
| `failed` | it cannot run; the error says why | [troubleshooting](#troubleshooting) |
| `disabled` | mode `disabled` | – |

Like the workers, the resolver keeps running when the daemon stops or restarts, so an upgrade never interrupts
name resolution; the new daemon adopts it and replaces it with one of its own image. How tasks see name resolution
is described in [errors and retries](errors-and-retries.md#name-resolution-in-workers).

## Daemon overrides

Admins can change selected settings of a running daemon without touching the node host: in the web UI (**Admin →
Nodes →** the node **→ Daemon configuration → Edit overrides**), with the CLI, or through MCP
(`update_node_daemon_overrides`, admin level). The node page and `scantor nodes daemon-config <node>` show every
setting of the daemon with its value and where it comes from (`env`, `default` or `override`); secrets are never
shown.

```sh
scantor nodes daemon-config scan-eu-1
scantor nodes daemon-overrides set scan-eu-1 --max-workers 16 --dns-mode iterative
scantor nodes daemon-overrides set scan-eu-1 --unset dns.mode
scantor nodes daemon-overrides reset scan-eu-1
```

- Overridable are the daemon's worker limit (`maxWorkers`), the worker container settings (`pidsLimit`,
  `shmSizeBytes`, `nofile`, `workerLogMaxSizeBytes`, `workerLogMaxFiles`), `imageRetentionMs`, `pullTimeoutMs`, the
  daemon's `logLevel` and every DNS setting (`dns.mode`, `dns.upstreams`, `dns.rootServers`, `dns.localDomains`,
  `dns.cacheSizeBytes`, `dns.maxLookups`, `dns.upstreamQps`, `dns.authoritativeQps`), within the same bounds as the
  variables. The URL, the token, Docker-in-Docker, the egress deny list, TLS and network isolation never are.
- An override lasts until the daemon restarts: a restarted daemon starts again from its environment, and the node's
  events show `node.daemonOverridesCleared`. The admin worker limit of `scantor nodes update --max-workers` is
  separate and persistent.
- The worker limit applies to placement at once, worker settings to workers created afterwards, and a DNS change
  replaces the resolver (its cache starts empty) without interrupting lookups.
- DNS servers set as overrides must be public. A private or special-purpose address (loopback, RFC 1918,
  link-local, CGNAT and other reserved ranges) is refused with "private and special-purpose servers can only be
  configured in the node environment (SCANTOR_NODE_DNS_*)": set such a server in `SCANTOR_NODE_DNS_UPSTREAMS` or
  `SCANTOR_NODE_DNS_ROOT_SERVERS` on the node instead. The daemon also refuses an address inside its
  `SCANTOR_NODE_EGRESS_DENY`.
- The daemon reports which overrides it applied; until then the node page says "pending". Overrides it refused (a
  key its version does not know, a key you do not allow, an invalid value) are listed with the reason.
- Overrides need the node's daemon configuration. When the node page says the node "has not reported a valid daemon
  configuration", the daemon is older than daemon overrides, still connecting, or sent a report the master refused
  (the orchestrator's log says why); "Reset overrides" still works.
- **Node operators decide what admins may change**: `SCANTOR_NODE_OVERRIDES` on the daemon is `all`, `none`, or a
  list of keys such as `maxWorkers,dns.mode`. With the `maxWorkers` override an admin can raise the node's worker
  count above `SCANTOR_NODE_MAX_WORKERS`; leave it out to prevent that.

## Operating a node

| Task | Procedure |
|---|---|
| upgrade the daemon | pull the new image and recreate the daemon container; running workers continue and are adopted by the new daemon, which also replaces the DNS resolver with one of the new image; daemon overrides end with the old daemon |
| reboot the host | optionally cordon the node first; after the reboot the daemon restarts the workers that are still needed and the DNS resolver |
| decommission | cordon the node and wait until no workers remain (`scantor nodes workers <node>`), or delete the node at once (its workers are replaced elsewhere); then stop the daemon. The DNS resolver outlives the daemon like the workers: remove it with `docker rm -f $(docker ps -aq --filter label=scantor.kind=resolver)` once the daemon is gone |

When the master is unreachable, the daemon keeps its workers running and retries; workers continue as
long as they reach the message broker. When the master has not heard from a node for the offline
window (`SCANTOR_NODE_OFFLINE_AFTER`, an instance setting), the node becomes `offline`, its workers are
replaced on other nodes, and their unfinished analyses are processed again. The daemon removes the
replaced workers when it reconnects.

`scantor nodes events <node>` shows the node's history (online, offline, token changes, conflicts, changes of
daemon overrides, the DNS resolver failing and recovering).

`docker ps` on the node host shows the health of every container: the daemon is `healthy` while it reports
to the master, a worker (`scantor-w-<id>`) is `healthy` while the master answers its state polls, and the DNS
resolver (`scantor-dns-<id>-<hash>`) is `healthy` while it answers and its upstream or root servers do. The health
of workers is informational; restarts follow the daemon's own rules. The resolver is the exception: the daemon uses
its health to decide whether new workers use it and restarts it when it stays unhealthy.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| the node stays `pending` | the daemon never reached the master: check `docker logs scantor-node` for refused plaintext connections, TLS errors, `401` (wrong token) or `404` (`SCANTOR_URL` is the master's tunnel URL instead of its public URL) |
| the daemon exits at start | an invalid setting (unknown `SCANTOR_NODE_DIND` or `SCANTOR_NODE_DNS_MODE`, malformed CIDRs, DNS servers or domains, an unknown key in `SCANTOR_NODE_OVERRIDES`, a token together with `SCANTOR_NODE_BUILTIN=true`), a refused plaintext URL or a Docker Engine older than 25; the log names it |
| the node goes `offline` although the daemon runs | the log shows `401` (token rotated or revoked: restart with the new token) |
| workers show `unhealthy` in `docker ps` | they have not reached the master's API for over three poll intervals: check the master's reachability from the host (`docker inspect --format '{{json .State.Health}}' scantor-w-<id>` shows the last checks) |
| the daemon log shows `nodeInstanceConflict` or says it is standing by | a second daemon runs with the same token, on this host or another: stop one of them |
| the daemon log says the worker network is not usable | a network named `scantor-workers` exists that scantor did not create as an isolated network (the log names what differs): remove it with `docker network rm scantor-workers` and the daemon creates it again |
| scans show `imagePullFailed` | the node host's Docker cannot reach or trust the registry or the master's API URL: check DNS and firewall from the host, the CA in `/etc/docker/certs.d/` and the host trust store, or `insecure-registries` |
| scans show `workersPending` | read the reason: `selectorMismatch` (pool or labels), `archMismatch` (no node with the image's architecture), `insufficientCapacity`, `dindUnavailable`, `diskLow` |
| workers cannot reach the broker on port 443 | the broker is routed by TLS server name: the URL must use the hostname `amqp.<domain>`, never an IP address |
| large uploads from workers fail | a proxy or CDN in front of `s3.<domain>` re-chunks requests (disable proxying for that host), or uploads take longer than Traefik's read timeout (`SCANTOR_TRAEFIK_READ_TIMEOUT` on the master) |
| the node page warns about the clock | the node's clock is off by more than 2 s: enable NTP on the host |
| "egress deny not applied" | see [egress deny](#egress-deny) |
| the DNS resolver is `failed` with `bindInUse` | a DNS server on the host listens on `0.0.0.0:53` (dnsmasq, unbound, Pi-hole, …): bind it to its own interfaces (dnsmasq `bind-interfaces`, unbound `interface:`). The other way round, such a server that starts after the resolver cannot bind all addresses either |
| the DNS resolver is `failed` with `bindUnavailable` | rootless Docker with RootlessKit `--detach-netns`: see **Rootless Docker** under [join a node](#join-a-node), or set `SCANTOR_NODE_DNS_MODE=disabled` |
| the DNS resolver is `unreachable` | the host firewall drops traffic from the worker network to its gateway: allow it by address, `ufw allow from <subnet> to <gateway> port 53 proto udp` and the same with `proto tcp` (the daemon log names subnet and gateway; `docker network inspect scantor-workers` shows them too) |
| the DNS resolver is `degraded` | outbound DNS to the upstream servers (or, iterative, to the internet) is blocked: allow UDP and TCP port 53, or set `SCANTOR_NODE_DNS_UPSTREAMS=host` to use the site's own resolver |
| the DNS resolver is `failed` with `foreignResolver` | a resolver of an earlier node on this Docker host still holds the gateway: stop the daemon, remove the resolvers (`docker rm -f $(docker ps -aq --filter label=scantor.kind=resolver)`) and start the daemon again |
| lookups in workers time out at high rates, and the kernel log says `nf_conntrack: table full` | raise `net.netfilter.nf_conntrack_max` on the host (every forwarded lookup is a tracked connection for about 30 s) |
| a daemon override stays "pending" or is listed as refused | the daemon has not polled since (offline), runs an older version, or does not allow the key (`SCANTOR_NODE_OVERRIDES`); the reason is shown next to the key |
| the DNS resolver is `failed` with `createFailed` and a detail starting "resolver config:" | the resolver's configuration from `SCANTOR_NODE_DNS_*`, `SCANTOR_NODE_EGRESS_DENY` and the DNS daemon overrides is invalid (the daemon log names the problem): fix the variable or reset the overrides |
| workers cannot resolve the master's hostname, and the resolver's log (`docker logs scantor-dns-…`) says "no usable host nameservers" | the host's `/etc/resolv.conf` has no nameserver the resolver can use: set a `dns` server in Docker's `daemon.json` (or use a public hostname for the master) |
| the node's daemon configuration warns that the report is truncated | the node has more CA certificates or deny-list entries than the report shows; the daemon applies all of them |
