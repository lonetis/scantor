<script setup lang="ts">
// Centered card layout of the public pages: login, setup and OAuth consent (docs/ui.md §4).
</script>

<template>
  <div class="flex min-h-svh items-center justify-center bg-muted p-4">
    <main class="w-full max-w-md">
      <div class="mb-6 flex flex-col items-center text-center">
        <AppLogo class="mb-3 h-14" />
        <p class="text-2xl font-bold text-highlighted">scantor</p>
      </div>
      <slot />
    </main>
  </div>
</template>
