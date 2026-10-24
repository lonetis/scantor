<script setup lang="ts">
// UInputNumber whose icon-only increment and decrement buttons show their names as tooltips (docs/ui.md §11 rule 1).
// Everything else (v-model, props, events, the form field context) passes through to UInputNumber unchanged.
defineOptions({ inheritAttrs: false })

const attrs = useAttrs()
const buttonColor = computed(() => attrs.color as 'primary' | 'neutral' | undefined)
const buttonSize = computed(() => attrs.size as 'xs' | 'sm' | 'md' | 'lg' | 'xl' | undefined)
</script>

<template>
  <UInputNumber v-bind="$attrs">
    <template #increment>
      <UTooltip text="Increment">
        <UButton icon="i-lucide-plus" :color="buttonColor" :size="buttonSize" variant="link" aria-label="Increment" />
      </UTooltip>
    </template>
    <template #decrement>
      <UTooltip text="Decrement">
        <UButton icon="i-lucide-minus" :color="buttonColor" :size="buttonSize" variant="link" aria-label="Decrement" />
      </UTooltip>
    </template>
  </UInputNumber>
</template>
