<script setup lang="ts">
import { en } from '@nuxt/ui/locale'

// The favicons are in the shell's head (nuxt.config.ts app.head). The sidebar drawer toggle is named "Open
// navigation" (docs/ui.md §3.1, §11).
const locale = extendLocale(en, {
  messages: {
    dashboardSidebarToggle: { open: 'Open navigation', close: 'Close navigation' },
    dashboardSidebarCollapse: { collapse: 'Collapse sidebar', expand: 'Expand sidebar' },
  },
})

useHead({
  title: 'scantor',
  htmlAttrs: { lang: 'en' },
})
</script>

<template>
  <UApp :toaster="{ position: 'bottom-right' }" :locale="locale">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
