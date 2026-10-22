import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'

// Identity of this orchestrator process: `<hostname>:<pid>:<bootNonce>` (docs/data-model.md §4.12). Lease owners
// (jobs, locks) and AMQP connection names use it, so a restarted process never mistakes an old lease for its own.

export const instanceId = `${hostname()}:${process.pid}:${randomBytes(2).toString('hex')}`
