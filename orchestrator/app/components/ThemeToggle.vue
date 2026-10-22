<script setup lang="ts">
// Three-way color mode switch (docs/ui.md §10); color-mode persists the choice under `scantor-color-mode`.
const colorMode = useColorMode()

const modes = [
  { value: 'system', icon: 'i-lucide-monitor', label: 'Use system theme' },
  { value: 'light', icon: 'i-lucide-sun', label: 'Use light theme' },
  { value: 'dark', icon: 'i-lucide-moon', label: 'Use dark theme' },
] as const
</script>

<template>
  <div role="group" aria-label="Theme" class="flex items-center rounded-md bg-elevated p-0.5" data-theme-toggle>
    <UTooltip v-for="mode in modes" :key="mode.value" :text="mode.label">
      <button
        type="button"
        :aria-label="mode.label"
        :aria-pressed="colorMode.preference === mode.value"
        class="rounded p-1 transition-colors focus-visible:outline-2 focus-visible:outline-primary"
        :class="colorMode.preference === mode.value
          ? 'bg-default text-highlighted shadow-sm'
          : 'text-dimmed hover:text-muted'"
        @click="colorMode.preference = mode.value"
      >
        <UIcon :name="mode.icon" class="size-3.5" />
      </button>
    </UTooltip>
  </div>
</template>
