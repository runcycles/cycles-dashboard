import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from './stores/auth'

// meta.title is the page-specific slug that afterEach(setDocumentTitle)
// composes into `<title> – Cycles Admin Dashboard`. Keep these short;
// they're what operators see in their tab strip when they've stacked a
// dozen dashboard tabs during an incident.
const routes = [
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true, title: 'Login' } },
  { path: '/', name: 'overview', component: () => import('./views/OverviewView.vue'), meta: { title: 'Overview' } },
  { path: '/budgets', name: 'budgets', component: () => import('./views/BudgetsView.vue'), meta: { title: 'Budgets' } },
  { path: '/events', name: 'events', component: () => import('./views/EventsView.vue'), meta: { title: 'Events' } },
  { path: '/api-keys', name: 'api-keys', component: () => import('./views/ApiKeysView.vue'), meta: { title: 'API Keys' } },
  { path: '/webhooks', name: 'webhooks', component: () => import('./views/WebhooksView.vue'), meta: { title: 'Webhooks' } },
  { path: '/webhooks/:id', name: 'webhook-detail', component: () => import('./views/WebhookDetailView.vue'), meta: { title: 'Webhook' } },
  { path: '/audit', name: 'audit', component: () => import('./views/AuditView.vue'), meta: { title: 'Audit' } },
  { path: '/tenants', name: 'tenants', component: () => import('./views/TenantsView.vue'), meta: { title: 'Tenants' } },
  { path: '/tenants/:id', name: 'tenant-detail', component: () => import('./views/TenantDetailView.vue'), meta: { title: 'Tenant' } },
  { path: '/reservations', name: 'reservations', component: () => import('./views/ReservationsView.vue'), meta: { title: 'Reservations' } },
  // Catch-all 404. Public so unauthenticated users aren't redirected to
  // /login for a mistyped URL — matches the GitHub/Linear/Gmail pattern
  // where a bad link shows "not found" regardless of session state.
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('./views/NotFoundView.vue'), meta: { public: true, title: 'Not found' } },
]

const APP_TITLE = 'Cycles Admin Dashboard'

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// P1-H2: per-route document.title. Pre-fix every tab read "Cycles Admin
// Dashboard" regardless of which page — useless for operators with many
// tabs stacked during an incident. afterEach (not beforeEach) so the
// title flips only on a committed navigation, not on a rejected one.
router.afterEach((to) => {
  const slug = (to.meta?.title as string | undefined) ?? ''
  document.title = slug ? `${slug} – ${APP_TITLE}` : APP_TITLE
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (to.meta.public) return
  if (auth.isAuthenticated) return
  // Try restoring session from sessionStorage
  if (auth.apiKey) {
    const ok = await auth.restore()
    if (ok) return
  }
  return { name: 'login', query: { redirect: to.fullPath } }
})

export default router
