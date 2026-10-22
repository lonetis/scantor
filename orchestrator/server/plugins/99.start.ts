import { defineNitroPlugin } from 'nitropack/runtime'
import { closeAmqp } from '../utils/amqp'
import { BootAbortError, runBoot, stopComponents } from '../utils/boot'
import { ConfigError, useConfig } from '../utils/config'
import { useLogger } from '../utils/logger'
import { closeMongo } from '../utils/mongo'
import { scantorVersion } from '../utils/version'

// Last Nitro plugin: runs the registered boot steps in order and starts the components selected by
// SCANTOR_COMPONENTS (docs/architecture.md §4.1). Any failure before the components run exits with code 1; until
// then `/api/*` answers 503. Components stop on Nitro `close` (SIGTERM).

export default defineNitroPlugin((nitroApp) => {
  const log = useLogger('boot')
  log.info('orchestrator starting', { version: scantorVersion })
  runBoot({ config: useConfig, log }).then(
    () => log.info('orchestrator ready', { version: scantorVersion, components: useConfig().components }),
    (error: unknown) => {
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
  // Components stop before the infrastructure clients close.
  nitroApp.hooks.hook('close', async () => {
    log.info('orchestrator stopping')
    await stopComponents(log)
    await closeAmqp()
    await closeMongo()
    log.info('orchestrator stopped')
  })
})
