<script setup lang="ts">
import { useAuthStore } from './stores/auth'
import AppLayout from './components/AppLayout.vue'

const auth = useAuthStore()
</script>

<template>
  <AppLayout v-if="auth.isAuthenticated" />
  <router-view v-else />
</template>
