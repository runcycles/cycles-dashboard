<script setup lang="ts">
import type { BudgetLedger, Event } from '../types'
import EventTimeline from './EventTimeline.vue'
import StatusBadge from './StatusBadge.vue'
import UtilizationBar from './UtilizationBar.vue'

defineProps<{
  budget: BudgetLedger
  events: Event[]
  canManage: boolean
  eventsHasMore: boolean
  eventsLoadingMore: boolean
  eventsCursor: string
}>()

defineEmits<{
  fund: []
  edit: []
  freeze: []
  unfreeze: []
  loadMoreEvents: []
}>()
</script>

<template>
  <div class="bg-white rounded-lg shadow p-6 mb-4">
    <div class="flex items-center gap-3 mb-4 flex-wrap">
      <h2 class="text-lg font-medium text-gray-900 font-mono">{{ budget.scope }}</h2>
      <StatusBadge :status="budget.status" />
      <span class="bg-gray-100 text-gray-600 px-2 py-0.5 rounded text-xs font-medium">{{ budget.unit }}</span>
      <span
        class="bg-gray-50 text-gray-500 border border-gray-200 px-2 py-0.5 rounded text-xs font-medium"
        :title="budget.commit_overage_policy ? 'Commit overage policy (budget-level override)' : 'Commit overage policy (inherited from tenant)'"
      >
        Overage: <span class="font-mono">{{ budget.commit_overage_policy || 'Inherit' }}</span>
      </span>
      <span v-if="budget.is_over_limit" class="bg-red-100 text-red-700 px-2 py-0.5 rounded text-xs font-medium">OVER LIMIT</span>
      <span class="flex-1" />
      <button v-if="canManage && budget.status === 'ACTIVE'" @click="$emit('fund')" class="btn-pill-primary">Fund Budget</button>
      <button v-if="canManage" @click="$emit('edit')" class="btn-pill-secondary">Edit</button>
      <button v-if="canManage && budget.status === 'ACTIVE'" @click="$emit('freeze')" class="btn-pill-danger">Freeze</button>
      <button v-if="canManage && budget.status === 'FROZEN'" @click="$emit('unfreeze')" class="btn-pill-success">Unfreeze</button>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
      <div class="info-panel"><span class="form-label">Allocated</span><span class="font-semibold">{{ budget.allocated.amount.toLocaleString() }}</span></div>
      <div class="info-panel"><span class="form-label">Remaining</span><span class="font-semibold">{{ budget.remaining.amount.toLocaleString() }}</span></div>
      <div class="info-panel"><span class="form-label">Reserved</span><span class="font-semibold">{{ budget.reserved?.amount.toLocaleString() || '0' }}</span></div>
      <div class="info-panel"><span class="form-label">Spent</span><span class="font-semibold">{{ budget.spent?.amount.toLocaleString() || '0' }}</span></div>
      <div class="info-panel"><span class="form-label">Debt</span><span class="font-semibold" :class="budget.debt && budget.debt.amount > 0 ? 'text-red-600' : ''">{{ budget.debt?.amount.toLocaleString() || '0' }}</span></div>
      <div class="info-panel"><span class="form-label">Overdraft Limit</span><span class="font-semibold">{{ budget.overdraft_limit?.amount.toLocaleString() || '0' }}</span></div>
    </div>
    <div class="mt-4">
      <UtilizationBar :remaining="budget.remaining.amount" :allocated="budget.allocated.amount" />
    </div>
    <div v-if="budget.debt && budget.debt.amount > 0 && budget.overdraft_limit" class="mt-2">
      <UtilizationBar :remaining="budget.overdraft_limit.amount - budget.debt.amount" :allocated="budget.overdraft_limit.amount" label="Debt utilization" />
    </div>
  </div>

  <div class="card p-4 flex-1 min-h-0 flex flex-col">
    <h3 class="text-sm font-medium text-gray-700 mb-3">Event Timeline</h3>
    <EventTimeline :events="events" />
    <div v-if="eventsHasMore || eventsLoadingMore" class="mt-3 flex items-center justify-end">
      <button
        @click="$emit('loadMoreEvents')"
        :disabled="eventsLoadingMore || !eventsCursor"
        class="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50 cursor-pointer"
      >
        {{ eventsLoadingMore ? 'Loading…' : 'Load more' }}
      </button>
    </div>
  </div>
</template>
