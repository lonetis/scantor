import { defineNitroPlugin } from 'nitropack/runtime'
import { closeAmqp } from '../utils/amqp'
import { BootAbortError, BootStoppedError, runBoot, stopComponents } from '../utils/boot'
import { ConfigError, useConfig } from '../utils/config'
import { useLogger } from '../utils/logger'
import { closeMongo } from '../utils/mongo'
import { scantorVersion } from '../utils/version'
import { closeWaitWatchers } from '../utils/wait-watchers'

// Last Nitro plugin: runs the registered boot steps in order and starts the components selected by
// SCANTOR_COMPONENTS (docs/architecture.md §4.1). Any failure before the components run exits with code 1; until
// then `/api/*` answers 503.
//
// Shutdown (SIGTERM, SIGINT): the components stop as soon as the signal arrives, while Nitro's graceful shutdown drains
// the open requests, so no reconciler loop acts on a view that this process no longer receives (node offline
// detection) and the long-polls answer at once instead of holding the drain. The infrastructure clients (and the wait
// change streams on the MongoDB client) close on Nitro `close`, after the drain.

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const

export default defineNitroPlugin((nitroApp) => {
  const log = useLogger('boot')
  log.info('orchestrator starting', { version: scantorVersion })
  runBoot({ config: useConfig, log }).then(
    () => log.info('orchestrator ready', { version: scantorVersion, components: useConfig().components }),
    (error: unknown) => {
      if (error instanceof BootStoppedError) {
        log.info(error.message)
        return
      }
      if (error instanceof ConfigError) {
        for (const issue of error.issues) log.error('invalid configuration', { variable: issue.variable, problem: issue.message })
      } else if (error instanceof BootAbortError) {
        log.error(error.message)
      } else {
        log.error('boot failed', { err: error })
      }
      process.exit(1)
    },
  )

  let stopping: Promise<void> | null = null
  const stop = (reason: string): Promise<void> => {
    if (!stopping) {
      log.info('orchestrator stopping', { reason })
      stopping = stopComponents(log)
    }
    return stopping
  }
  const onSignal = (signal: NodeJS.Signals) => {
    // Without Nitro's graceful shutdown for this signal (NITRO_SHUTDOWN_DISABLED, NITRO_SHUTDOWN_SIGNALS) nothing else
    // listens: keep the default action, which ends the process.
    if (process.listenerCount(signal) === 0) {
      process.kill(process.pid, signal)
      return
    }
    void stop(signal)
  }
  for (const signal of SHUTDOWN_SIGNALS) process.once(signal, onSignal)

  // Components stop before the infrastructure clients close.
  nitroApp.hooks.hook('close', async () => {
    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, onSignal)
    await stop('close')
    await closeAmqp()
    await closeWaitWatchers()
    await closeMongo()
    log.info('orchestrator stopped')
  })
})
