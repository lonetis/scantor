<script setup lang="ts">
import logoUrl from '~/assets/img/scantor-symbol.svg'
</script>

<template>
  <!-- Decorative: it always sits next to the text "scantor". -->
  <img :src="logoUrl" alt="" class="w-auto select-none" draggable="false" data-testid="scantor-logo">
</template>
