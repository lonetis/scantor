import type { ComputedRef, InjectionKey } from 'vue'
import type { PathSegment } from '~/utils/json-pointer'
import type { JsonSchema } from '~/utils/schema-subset'

// Shared state of one SchemaForm for its nested field components.

export interface SchemaFormContext {
  /** The document root (for local `$ref` resolution). */
  root: ComputedRef<JsonSchema>
  /** Instance pointers of upload fields from describe (`/list`, `/items/*`). */
  uploadPaths: ComputedRef<readonly string[]>
  disabled: ComputedRef<boolean>
  /** Rendered field paths, so server issues can land on the nearest rendered field. */
  register: (path: string) => void
  unregister: (path: string) => void
}

const SCHEMA_FORM_CONTEXT: InjectionKey<SchemaFormContext> = Symbol('schema-form')

export function provideSchemaFormContext(context: SchemaFormContext): void {
  provide(SCHEMA_FORM_CONTEXT, context)
}

export function useSchemaFormContext(): SchemaFormContext {
  const context = inject(SCHEMA_FORM_CONTEXT, null)
  if (!context) throw new Error('schema form fields must be rendered inside <SchemaForm>')
  return context
}

/** Registers a field path for the lifetime of the calling component. */
export function useRegisteredPath(path: () => readonly PathSegment[]): ComputedRef<string> {
  const context = useSchemaFormContext()
  const name = computed(() => segmentsToDotPath(path()))
  watch(name, (next, previous) => {
    if (previous !== undefined) context.unregister(previous)
    context.register(next)
  }, { immediate: true })
  onBeforeUnmount(() => context.unregister(name.value))
  return name
}

/** The describe-style pointer of a field path: array indexes become `*`. */
export function wildcardPointer(path: readonly PathSegment[]): string {
  return formatPointer(path.map((segment) => (typeof segment === 'number' ? '*' : segment)))
}
