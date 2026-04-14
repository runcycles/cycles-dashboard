<script setup lang="ts">
defineProps<{ tenantId: string }>()

const isSystem = (id: string) => id === '__system__' || id.startsWith('__')
</script>

<template>
  <span v-if="isSystem(tenantId)" class="text-gray-600 dark:text-gray-400 text-xs italic">{{ tenantId }}</span>
  <router-link v-else :to="{ name: 'tenant-detail', params: { id: tenantId } }" class="text-blue-600 hover:underline text-xs">{{ tenantId }}</router-link>
</template>
