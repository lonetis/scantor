import { describe, expect, it } from 'vitest'
import { type EndpointHostsConfig, endpointHosts } from '../../../server/services/nodes/profile'

// Endpoint hosts (hello config.endpointHosts, docs/api.md §7.1, docs/architecture.md §8): the host names of every URL
// a node's workers get for its endpoint profile, which the node resolver resolves through the host nameservers.

const config: EndpointHostsConfig = {
  internalUrl: 'http://orchestrator:3000',
  publicUrl: 'https://scantor.example.com',
  amqpInternalUrl: 'amqp://rabbitmq:5672',
  amqpPublicUrl: 'amqps://user:secret@AMQP.scantor.example.com.:443',
  registryPort: 5000,
  registryPublicHost: 'registry.example.com',
  s3InternalUrl: 'http://rustfs:9000',
  s3PublicUrl: 'https://s3.scantor.example.com',
  trancoUrl: 'https://tranco-list.eu',
  cruxUrl: 'https://raw.githubusercontent.com/zakird/crux-top-lists/main',
  cruxCacheUrl: 'https://raw.githubusercontent.com/lonetis/crux-cache/main',
}

describe('endpointHosts', () => {
  it('lists the API, AMQP, S3 and data source hosts of the public profile, sorted and unique', () => {
    expect(endpointHosts('public', config)).toEqual([
      'amqp.scantor.example.com',
      'raw.githubusercontent.com',
      's3.scantor.example.com',
      'scantor.example.com',
      'tranco-list.eu',
    ])
  })

  it('lists the compose-internal names of the internal profile', () => {
    expect(endpointHosts('internal', config)).toEqual(['orchestrator', 'rabbitmq', 'raw.githubusercontent.com', 'rustfs', 'tranco-list.eu'])
  })

  it('leaves out IP literals and the registry, which only the daemon uses', () => {
    const literal = { ...config, publicUrl: 'https://203.0.113.7', s3PublicUrl: 'http://[2001:db8::7]:9000', trancoUrl: 'http://192.0.2.1:8089/lists' }
    expect(endpointHosts('public', literal)).toEqual(['amqp.scantor.example.com', 'raw.githubusercontent.com'])
    expect(endpointHosts('public', config)).not.toContain('registry.example.com')
  })
})
