import { configureLogger } from '../server/utils/logger'

// Unit tests assert on behaviour, not on log lines: keep the output quiet unless a test captures it itself.
configureLogger({ level: 'error', write: () => {} })
