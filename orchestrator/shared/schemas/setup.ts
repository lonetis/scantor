import { z } from 'zod'
import { emailAddress } from './common'
import { password, personName } from './users'

// Request schemas of the `setup` tag (docs/api.md §4.2).

export const createSetupAdminBody = z.strictObject({
  email: emailAddress(),
  name: personName(),
  password: password(),
})

export const createSetupPasskeyTokenBody = z.strictObject({
  email: emailAddress(),
  name: personName(),
})
