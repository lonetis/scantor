import { describe, expect, it, vi } from 'vitest'

// The production CSP has no 'unsafe-eval' (docs/ui.md §13, FEATURES UI-SEC-003): the app plugin switches zod to
// jitless before any schema exists, so zod never calls `new Function` and no page logs a CSP violation.

describe('app/plugins/zod', () => {
  it('makes zod jitless before the first schema is built, so it never probes eval', async () => {
    vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin)
    const constructed: unknown[][] = []
    const RealFunction = globalThis.Function
    vi.stubGlobal('Function', new Proxy(RealFunction, {
      construct(target, args) {
        constructed.push(args)
        return Reflect.construct(target, args)
      },
      apply(target, thisArg, args) {
        constructed.push(args)
        return Reflect.apply(target, thisArg, args)
      },
    }))
    try {
      await import('../../app/plugins/zod')
      const { z } = await import('zod')
      expect(z.config().jitless).toBe(true)
      const schema = z.object({ name: z.string(), nested: z.object({ count: z.number().int() }) })
      expect(schema.parse({ name: 'a', nested: { count: 1 } })).toEqual({ name: 'a', nested: { count: 1 } })
      expect(schema.safeParse({ name: 1 }).success).toBe(false)
      expect(constructed).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
