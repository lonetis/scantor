import { useStorage } from 'nitropack/runtime'
import type { GuideReader } from './guides'

// Reads docs/guide/ from the Nitro server assets (base name `guide`, nuxt.config.ts): copied into the image at
// build time, read from the mounted source in development.

/** `docs/guide/<file>`, or null when the file does not exist. */
export const readGuide: GuideReader = async (file) => {
  const value = await useStorage('assets:guide').getItem(file)
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return String(value)
}
