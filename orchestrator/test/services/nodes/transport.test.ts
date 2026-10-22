import { describe, expect, it } from 'vitest'
import { isPlaintextAllowedAddress, plaintextPublicEndpoints } from '../../../server/services/nodes/transport'

// The boot warning of docs/nodes.md §11: plaintext public endpoints on public addresses, which remote nodes refuse
// (security.md TLS-1: loopback, RFC 1918, CGNAT and IPv6 ULA are the only plaintext exceptions).

describe('isPlaintextAllowedAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['100.64.0.1', true],
    ['100.128.0.1', false],
    ['::1', true],
    ['fd12::1', true],
    ['2001:db8::1', false],
    ['8.8.8.8', false],
    ['not-an-ip', false],
  ])('%s → %s', (address, allowed) => {
    expect(isPlaintextAllowedAddress(address)).toBe(allowed)
  })
})

describe('plaintextPublicEndpoints', () => {
  const resolve = async (host: string) => {
    if (host === 'scantor.example.com') return ['203.0.113.10']
    if (host === 'private.example.com') return ['10.0.0.5', '192.168.0.5']
    if (host === 'localhost') return ['127.0.0.1', '::1']
    throw new Error(`ENOTFOUND ${host}`)
  }

  it('ignores TLS endpoints and plaintext endpoints on private addresses', async () => {
    expect(await plaintextPublicEndpoints({ publicUrl: 'https://scantor.example.com', amqpPublicUrl: 'amqps://amqp.scantor.example.com:443', s3PublicUrl: 'http://private.example.com:9000' }, resolve)).toEqual([])
    expect(await plaintextPublicEndpoints({ publicUrl: 'http://localhost:3000', amqpPublicUrl: 'amqp://localhost:5672', s3PublicUrl: 'http://[::1]:9000' }, resolve)).toEqual([])
  })

  it('reports plaintext endpoints on public addresses and unresolvable hosts', async () => {
    expect(await plaintextPublicEndpoints({ publicUrl: 'http://scantor.example.com', amqpPublicUrl: 'amqp://203.0.113.11:5672', s3PublicUrl: 'http://nowhere.example:9000' }, resolve)).toEqual([
      { variable: 'SCANTOR_PUBLIC_URL', url: 'http://scantor.example.com', address: '203.0.113.10' },
      { variable: 'SCANTOR_AMQP_PUBLIC_URL', url: 'amqp://203.0.113.11:5672', address: '203.0.113.11' },
      { variable: 'SCANTOR_S3_PUBLIC_URL', url: 'http://nowhere.example:9000', address: null },
    ])
  })
})
