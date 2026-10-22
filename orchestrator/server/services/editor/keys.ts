import type { Collection } from 'mongodb'
import type { AuthApiKeyDoc } from '../../types/documents'
import { createUserApiKey, deleteUserApiKeysOf } from '../../utils/users'

/*
 * The per-user `editor` API key (docs/editor.md §7, docs/auth.md §8.3): better-auth configuration `editor`, prefix
 * `sk_scantor_editor_`, name `editor`, lifetime SCANTOR_EDITOR_API_KEY_TTL (the configuration's default; editor
 * keys are created without `expiresIn`). A new key is minted at every start and every key of the user is deleted at
 * every stop, so at most one exists per user.
 */

export const EDITOR_KEY_NAME = 'editor'

export interface MintedEditorKey {
  id: string
  key: string
  expiresAt: Date
}

/** What the editor manager and reaper need from the key store (a seam for unit tests). */
export interface EditorKeyStore {
  mint(userId: string): Promise<MintedEditorKey>
  deleteAll(userId: string): Promise<void>
  /** ids of every user that holds at least one `editor` key */
  owners(): Promise<string[]>
}

export function betterAuthEditorKeys(apiKeys: Collection<AuthApiKeyDoc>, ttlMs: number): EditorKeyStore {
  return {
    async mint(userId) {
      const created = await createUserApiKey(userId, { name: EDITOR_KEY_NAME, configId: 'editor' })
      return { id: created.apiKey.id, key: created.key, expiresAt: created.apiKey.expiresAt ?? new Date(Date.now() + ttlMs) }
    },
    deleteAll: (userId) => deleteUserApiKeysOf(userId, 'editor'),
    async owners() {
      const ids = await apiKeys.distinct('referenceId', { configId: 'editor' })
      return ids.map(String)
    },
  }
}
