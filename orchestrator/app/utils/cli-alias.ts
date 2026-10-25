// The "Docker alias" snippet of the CLI & MCP access page (docs/ui.md §5.18): a shell alias that runs the CLI image
// the way the docker shim scantor.sh does. It passes the image pair of `cliImage` (`<prefix>scantor:<tag>`,
// docs/api.md §4.1), so the containerised CLI builds on the base images of the deployment's version instead of
// tags its own version string names (docs/architecture.md §4.2), and it runs as the invoking user with the Docker
// socket's group (the host's on Linux, root inside the VM of Docker Desktop), so files it writes stay the user's.

/** The prefix and tag of a `<prefix>scantor:<tag>` reference; null when the reference has another shape. */
export function cliImagePair(cliImage: string): { prefix: string; tag: string } | null {
  const match = /^(.*?)scantor:([^:/]+)$/.exec(cliImage)
  if (!match || (match[1] !== '' && !match[1]!.endsWith('/'))) return null
  return { prefix: match[1]!, tag: match[2]! }
}

/** The alias line for `cliImage`. */
export function cliDockerAlias(cliImage: string): string {
  const pair = cliImagePair(cliImage)
  const imageEnv = pair ? ` -e SCANTOR_IMAGE_PREFIX=${pair.prefix} -e SCANTOR_IMAGE_TAG=${pair.tag}` : ''
  return (
    `alias scantor='docker run --rm -i --init -u "$(id -u):$(id -g)"` +
    ` --group-add "$([ "$(uname -s)" = Linux ] && stat -L -c %g /var/run/docker.sock || echo 0)" -e HOME=/tmp` +
    ` -v "$PWD:$PWD" -w "$PWD" -v /var/run/docker.sock:/var/run/docker.sock --add-host host.docker.internal:host-gateway` +
    ` -e SCANTOR_URL -e SCANTOR_TOKEN -e SCANTOR_CA_CERT${imageEnv} ${cliImage}'`
  )
}
