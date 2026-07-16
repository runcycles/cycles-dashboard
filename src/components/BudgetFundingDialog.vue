<script setup lang="ts">
import { computed } from 'vue'
import type { BudgetLedger } from '../types'
import {
  BUDGET_FUNDING_HINTS,
  type BudgetFundingForm,
  type BudgetFundingOperation,
} from '../composables/useBudgetFunding'
import FormDialog from './FormDialog.vue'

const props = defineProps<{
  target: BudgetLedger
  form: BudgetFundingForm
  loading?: boolean
  error?: string
}>()

const emit = defineEmits<{
  'update:form': [value: BudgetFundingForm]
  submit: []
  cancel: []
}>()

function updateForm(patch: Partial<BudgetFundingForm>) {
  emit('update:form', { ...props.form, ...patch })
}

const operation = computed({
  get: () => props.form.operation,
  set: (value: BudgetFundingOperation) => updateForm({ operation: value }),
})
const amount = computed({
  get: () => props.form.amount,
  set: (value: number | string) => updateForm({ amount: value }),
})
const spent = computed({
  get: () => props.form.spent,
  set: (value: number | string) => updateForm({ spent: value }),
})
const reason = computed({
  get: () => props.form.reason,
  set: (value: string) => updateForm({ reason: value }),
})
</script>

<template>
  <FormDialog
    title="Fund Budget"
    submit-label="Execute"
    :loading="loading"
    :error="error"
    @submit="$emit('submit')"
    @cancel="$emit('cancel')"
  >
    <p class="muted-sm mb-1">Funding <span class="font-mono">{{ target.scope }}</span> ({{ target.unit }}).</p>
    <div class="info-panel text-xs grid grid-cols-3 gap-2 mb-1">
      <div><span class="muted block">Allocated</span><span class="font-semibold">{{ target.allocated.amount.toLocaleString() }}</span></div>
      <div><span class="muted block">Remaining</span><span class="font-semibold">{{ target.remaining.amount.toLocaleString() }}</span></div>
      <div><span class="muted block">Debt</span><span class="font-semibold" :class="(target.debt?.amount ?? 0) > 0 ? 'text-red-600' : ''">{{ (target.debt?.amount ?? 0).toLocaleString() }}</span></div>
    </div>
    <div>
      <label for="fund-op" class="form-label">Operation</label>
      <select id="fund-op" v-model="operation" required class="form-select w-full">
        <option value="CREDIT">Credit — add funds</option>
        <option value="DEBIT">Debit — remove funds</option>
        <option value="RESET">Reset — set exact amount</option>
        <option value="RESET_SPENT">Reset Spent — billing-period rollover</option>
        <option value="REPAY_DEBT">Repay Debt — reduce debt</option>
      </select>
      <p class="muted-sm mt-0.5">{{ BUDGET_FUNDING_HINTS[form.operation] }}</p>
    </div>
    <div>
      <label for="fund-amount" class="form-label">
        {{ form.operation === 'RESET_SPENT' ? `Allocated for new period (${target.unit})` : `Amount (${target.unit})` }}
      </label>
      <input id="fund-amount" v-model="amount" type="number" min="0" step="1" required class="form-input-mono" />
      <p v-if="form.operation === 'RESET_SPENT'" class="muted-sm mt-0.5">Pre-filled with current allocated. Change to start the new billing period at a different allocation.</p>
    </div>
    <div v-if="form.operation === 'RESET_SPENT'">
      <label for="fund-spent" class="form-label">Spent override ({{ target.unit }}, optional)</label>
      <input id="fund-spent" v-model="spent" type="number" min="0" step="1" class="form-input-mono" placeholder="Leave blank to reset to zero" />
      <p class="muted-sm mt-0.5">Blank = reset spent to 0. Provide a value to set an exact starting spent for the new billing period.</p>
    </div>
    <div>
      <label for="fund-reason" class="form-label">Reason (optional, for audit trail)</label>
      <input id="fund-reason" v-model="reason" maxlength="512" class="form-input" placeholder="Emergency top-up for production" />
    </div>
  </FormDialog>
</template>
