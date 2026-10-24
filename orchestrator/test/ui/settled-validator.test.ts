import { createRenderer, defineComponent, h, ref, useModel, type Ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { settledValidator } from '../../app/composables/useSchemaForm'

// SchemaForm's UForm validates on "change" and "blur" in the tick of the edit (docs/ui.md §6.1, FEATURES UI-FORM-013).
// A required number field commits its text on blur, so a validation that read the model at once saw the old value and
// showed "is required" until the next validation. settledValidator waits until the parent has passed the edit back.

// Vue without a DOM: components render into plain objects.
const { createApp } = createRenderer<object, object>({
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  setText: () => {},
  setElementText: () => {},
  insert: () => {},
  remove: () => {},
  parentNode: () => null,
  nextSibling: () => null,
  patchProp: () => {},
})

type Value = { value?: number }
const requiredValue = (value: Value): string[] => (value.value === undefined ? ['value is required'] : [])

/** A parent with `v-model` on a form that edits its model and validates it, as the UForm does on change and blur. */
function mountForm() {
  let form!: { model: Ref<Value>, validateNow: () => string[], validateSettled: () => Promise<string[]> }
  const Form = defineComponent({
    props: { modelValue: { type: Object, required: true } },
    emits: ['update:modelValue'],
    setup(props) {
      const model = useModel(props, 'modelValue') as unknown as Ref<Value>
      form = { model, validateNow: () => requiredValue(model.value), validateSettled: settledValidator(() => requiredValue(model.value)) }
      return () => null
    },
  })
  const state = ref<Value>({})
  createApp(defineComponent(() => () => h(Form, { 'modelValue': state.value, 'onUpdate:modelValue': (next: Value) => (state.value = next) }))).mount({})
  return { form, state }
}

describe('settledValidator', () => {
  it('validates the edited value, also in the tick of the edit', async () => {
    const { form, state } = mountForm()
    form.model.value = { value: 7 }
    // The parent holds the edit, the form's model still the old value until the parent renders.
    expect(state.value).toEqual({ value: 7 })
    expect(form.validateNow()).toEqual(['value is required'])
    expect(await form.validateSettled()).toEqual([])
  })

  it('still reports what is missing', async () => {
    const { form } = mountForm()
    expect(await form.validateSettled()).toEqual(['value is required'])
    form.model.value = { value: 1 }
    await form.validateSettled()
    form.model.value = {}
    expect(await form.validateSettled()).toEqual(['value is required'])
  })
})
