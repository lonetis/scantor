<script setup lang="ts">
import wordmarkDark from '#brand/logos/scantor-logo-dark.svg'
import wordmarkLight from '#brand/logos/scantor-logo-light.svg'
import mark from '#brand/marks/scantor-mark-gradient.svg'

// The brand from brand/ (docs/ui.md §1): the wordmark, which names the app ("scantor"), in the variant for the
// resolved color mode, or the standalone S where the wordmark does not fit. The S is decorative, so whatever
// contains it carries the name. The wordmark already begins with the S: never show both side by side.
withDefaults(defineProps<{ variant?: 'wordmark' | 'mark' }>(), { variant: 'wordmark' })

const colorMode = useColorMode()
const wordmark = computed(() => (colorMode.value === 'dark' ? wordmarkDark : wordmarkLight))
</script>

<template>
  <img
    v-if="variant === 'mark'"
    :src="mark"
    alt=""
    class="w-auto select-none"
    draggable="false"
    data-testid="scantor-logo"
    data-variant="mark"
  >
  <img
    v-else
    :src="wordmark"
    alt="scantor"
    class="w-auto select-none"
    draggable="false"
    data-testid="scantor-logo"
    data-variant="wordmark"
  >
</template>
