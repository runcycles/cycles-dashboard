<script setup lang="ts">
defineProps<{ rows?: number }>()
</script>

<template>
  <div class="animate-pulse space-y-4">
    <div class="grid grid-cols-4 gap-4">
      <div v-for="i in 4" :key="i" class="bg-white rounded-lg shadow p-4">
        <div class="h-3 bg-gray-200 rounded w-16 mb-2" />
        <div class="h-7 bg-gray-200 rounded w-12 mb-1" />
        <div class="h-2 bg-gray-100 rounded w-20" />
      </div>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div v-for="i in 2" :key="i" class="bg-white rounded-lg shadow p-4">
        <div class="h-3 bg-gray-200 rounded w-32 mb-4" />
        <div v-for="j in (rows ?? 3)" :key="j" class="h-3 bg-gray-100 rounded mb-2" :style="{ width: (60 + Math.random() * 30) + '%' }" />
      </div>
    </div>
  </div>
</template>
