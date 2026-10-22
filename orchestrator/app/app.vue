<script setup lang="ts">
import { en } from '@nuxt/ui/locale'
import logoUrl from '~/assets/img/scantor-symbol.svg'

// The sidebar drawer toggle is named "Open navigation" (docs/ui.md §3.1, §11).
const locale = extendLocale(en, {
  messages: {
    dashboardSidebarToggle: { open: 'Open navigation', close: 'Close navigation' },
    dashboardSidebarCollapse: { collapse: 'Collapse sidebar', expand: 'Expand sidebar' },
  },
})

useHead({
  title: 'scantor',
  htmlAttrs: { lang: 'en' },
  link: [{ rel: 'icon', type: 'image/svg+xml', href: logoUrl }],
})
</script>

<template>
  <UApp :toaster="{ position: 'bottom-right' }" :locale="locale">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
