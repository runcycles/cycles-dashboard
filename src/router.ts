import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from './stores/auth'

const routes = [
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  { path: '/', name: 'overview', component: () => import('./views/OverviewView.vue') },
  { path: '/budgets', name: 'budgets', component: () => import('./views/BudgetsView.vue') },
  { path: '/events', name: 'events', component: () => import('./views/EventsView.vue') },
  { path: '/api-keys', name: 'api-keys', component: () => import('./views/ApiKeysView.vue') },
  { path: '/webhooks', name: 'webhooks', component: () => import('./views/WebhooksView.vue') },
  { path: '/webhooks/:id', name: 'webhook-detail', component: () => import('./views/WebhookDetailView.vue') },
  { path: '/audit', name: 'audit', component: () => import('./views/AuditView.vue') },
  { path: '/tenants', name: 'tenants', component: () => import('./views/TenantsView.vue') },
  { path: '/tenants/:id', name: 'tenant-detail', component: () => import('./views/TenantDetailView.vue') },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (!to.meta.public && !auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
})

export default router
