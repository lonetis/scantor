import { randomUUID } from 'node:crypto'
import { BUILTIN_NODE_NAME } from '#shared/schemas/nodes'
import type { Keyring } from '../../utils/keys'
import { nodeTokenHash } from '../../utils/keys'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { invalidateNodeTokenCache } from '../../utils/node-tokens'

// Boot step 620 (docs/architecture.md §4.1 step 6, docs/nodes.md §3): the built-in node record (name `builtin`,
// `endpointProfile: internal`, pool `shared` on creation) is upserted at every boot, and its `tokenHash` is set to the
// SHA-256 of the token both sides derive from SCANTOR_SECRET, so a changed secret takes effect at the next boot.

export async function upsertBuiltinNode(keys: Keyring, log: Logger, now = new Date()): Promise<string> {
  const { nodes } = useCollections()
  const token = keys.builtinNodeToken()
  const result = await nodes.findOneAndUpdate(
    { builtIn: true },
    {
      $set: { tokenHash: nodeTokenHash(token), tokenPrefix: token.slice(0, 8), endpointProfile: 'internal', name: BUILTIN_NODE_NAME, updatedAt: now },
      $setOnInsert: {
        _id: randomUUID(),
        builtIn: true,
        state: 'pending',
        tokenRotatedAt: null,
        pool: 'shared',
        labels: {},
        maxWorkers: null,
        cordoned: false,
        instance: null,
        info: null,
        assignmentsRev: 0,
        lastSeenAt: null,
        createdBy: null,
        createdAt: now,
      },
    },
    { upsert: true, returnDocument: 'after' },
  )
  invalidateNodeTokenCache()
  if (!result) throw new Error('upserting the built-in node returned no document')
  if (result.state === 'revoked') {
    // Not reachable through the API (409 builtInNode); repair it so the derived token works again.
    await nodes.updateOne({ _id: result._id }, { $set: { state: 'pending', updatedAt: now } })
  }
  log.info('built-in node ensured', { nodeId: result._id })
  return result._id
}
