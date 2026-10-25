import { describe, expect, it } from 'vitest'
import { cliDockerAlias, cliImagePair } from '../../app/utils/cli-alias'

describe('cliImagePair', () => {
  it('splits a <prefix>scantor:<tag> reference', () => {
    expect(cliImagePair('ghcr.io/lonetis/scantor:1.4.0')).toEqual({ prefix: 'ghcr.io/lonetis/', tag: '1.4.0' })
    expect(cliImagePair('ghcr.io/lonetis/scantor:latest')).toEqual({ prefix: 'ghcr.io/lonetis/', tag: 'latest' })
    expect(cliImagePair('registry.example.com:5000/mirror/scantor:sha-abc1234')).toEqual({
      prefix: 'registry.example.com:5000/mirror/',
      tag: 'sha-abc1234',
    })
    // Local images (the dev stack): an empty prefix.
    expect(cliImagePair('scantor:dev')).toEqual({ prefix: '', tag: 'dev' })
  })

  it('rejects other shapes', () => {
    expect(cliImagePair('ghcr.io/lonetis/myscantor:1.4.0')).toBeNull()
    expect(cliImagePair('ghcr.io/lonetis/scantor')).toBeNull()
    expect(cliImagePair('ghcr.io/lonetis/scantor-editor:1.4.0')).toBeNull()
  })
})

describe('cliDockerAlias', () => {
  it('mirrors scantor.sh: user, socket group, HOME, the image pair and the CLI variables', () => {
    const alias = cliDockerAlias('ghcr.io/lonetis/scantor:latest')
    expect(alias).toBe(
      `alias scantor='docker run --rm -i --init -u "$(id -u):$(id -g)"` +
        ` --group-add "$([ "$(uname -s)" = Linux ] && stat -L -c %g /var/run/docker.sock || echo 0)" -e HOME=/tmp` +
        ` -v "$PWD:$PWD" -w "$PWD" -v /var/run/docker.sock:/var/run/docker.sock --add-host host.docker.internal:host-gateway` +
        ` -e SCANTOR_URL -e SCANTOR_TOKEN -e SCANTOR_CA_CERT -e SCANTOR_IMAGE_PREFIX=ghcr.io/lonetis/ -e SCANTOR_IMAGE_TAG=latest` +
        ` ghcr.io/lonetis/scantor:latest'`,
    )
    // One single-quoted word: the $(…) substitutions run when the alias is used, not when it is defined.
    expect(alias.match(/'/g)).toHaveLength(2)
  })

  it('passes an empty prefix for local images and no pair for an unexpected reference', () => {
    expect(cliDockerAlias('scantor:dev')).toContain(' -e SCANTOR_IMAGE_PREFIX= -e SCANTOR_IMAGE_TAG=dev scantor:dev\'')
    expect(cliDockerAlias('example.org/other:1')).not.toContain('SCANTOR_IMAGE_TAG')
  })
})
