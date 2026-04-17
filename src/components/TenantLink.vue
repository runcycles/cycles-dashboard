<script setup lang="ts">
defineProps<{ tenantId: string }>()

// Non-drillable sentinel values emitted by the server in place of a
// real tenant_id. Two conventions coexist:
//  - Underscore-wrapped (`__system__`, `__root__`) for platform-scoped
//    operations that don't belong to any tenant.
//  - Angle-bracket-wrapped (`<unauthenticated>`) for audit rows where
//    no tenant could be resolved at the time of the event — e.g. a
//    pre-auth request that 401s before the key → tenant lookup runs.
// Either form renders as italic text, not a router-link, so operators
// don't click through to a 404.
const isSystem = (id: string) =>
  id.startsWith('__') ||
  (id.startsWith('<') && id.endsWith('>'))
</script>

<template>
  <span v-if="isSystem(tenantId)" class="text-xs italic text-gray-700 dark:text-gray-300">{{ tenantId }}</span>
  <router-link v-else :to="{ name: 'tenant-detail', params: { id: tenantId } }" class="text-blue-600 hover:underline text-xs">{{ tenantId }}</router-link>
</template>
