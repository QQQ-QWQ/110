<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Criterion, ReviewPayload } from '../types';
import BaseButton from './BaseButton.vue';
import BaseModal from './BaseModal.vue';
import AlertBox from './AlertBox.vue';
import FormField from './FormField.vue';

/**
 * ReviewPanel —— 逐项验收面板（弹窗形态）。
 *
 * 把「验收」这条最容易出错的规则链封装在一处：
 *  1. 必须对**全部**验收条件逐项记录结果，不允许漏项（默认全部未通过）；
 *  2. 存在未通过项 → 「确认完成」按钮直接禁用（前端先拦一道，后端仍会校验）；
 *  3. 选择退回 → 原因必填，且校验失败时**保留已勾选结果与已输入原因**，
 *     不因一次失败清空用户输入（对应考核「失败保留输入」）。
 *
 * 组件只做本地校验与事件派发，服务端错误通过 `serverError` 回传展示。
 */
const props = defineProps<{
  modelValue: boolean;
  criteria: Criterion[];
  submissionNo: number;
  busy: boolean;
  serverError?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  submit: [payload: ReviewPayload];
}>();

const checks = ref<Record<string, boolean>>({});
const reason = ref('');
const localError = ref('');

/** 每次打开重置为「全部未通过」——防止复用上一次的勾选结果造成误验收 */
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      const fresh: Record<string, boolean> = {};
      for (const c of props.criteria) fresh[c.id] = false;
      checks.value = fresh;
      reason.value = '';
      localError.value = '';
    }
  },
  { immediate: true },
);

const total = computed(() => props.criteria.length);
const passedCount = computed(() => props.criteria.filter((c) => checks.value[c.id]).length);
const allPassed = computed(() => total.value > 0 && passedCount.value === total.value);
const progressPct = computed(() =>
  total.value === 0 ? 0 : Math.round((passedCount.value / total.value) * 100),
);

function toggle(id: string): void {
  checks.value = { ...checks.value, [id]: !checks.value[id] };
  localError.value = '';
}

function buildChecks(): ReviewPayload['checks'] {
  return props.criteria.map((c) => ({ criterionId: c.id, passed: checks.value[c.id] === true }));
}

function requestReturn(): void {
  if (reason.value.trim().length === 0) {
    localError.value = '退回时必须填写具体修改原因';
    return;
  }
  localError.value = '';
  emit('submit', { action: 'RETURN', reason: reason.value.trim(), checks: buildChecks() });
}

function requestComplete(): void {
  if (!allPassed.value) {
    localError.value = '存在未通过的验收条件，不能确认完成';
    return;
  }
  localError.value = '';
  emit('submit', { action: 'COMPLETE', checks: buildChecks() });
}
</script>

<template>
  <BaseModal
    :model-value="modelValue"
    :title="`逐项验收 · V${submissionNo}`"
    :closable="!busy"
    :max-width="620"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <AlertBox v-if="localError" kind="error">{{ localError }}</AlertBox>
    <AlertBox v-if="serverError" kind="error">{{ serverError }}</AlertBox>

    <div class="review-progress">
      <span class="nowrap">已通过 {{ passedCount }} / {{ total }}</span>
      <div
        class="review-bar"
        role="progressbar"
        :aria-valuenow="passedCount"
        :aria-valuemax="total"
      >
        <span :style="{ width: `${progressPct}%` }" />
      </div>
    </div>

    <p class="muted small mb-2">
      请对全部 {{ total }} 条验收条件逐项记录结果。全部通过后才能确认完成。
    </p>

    <div
      v-for="c in criteria"
      :key="c.id"
      class="review-item"
      :class="checks[c.id] ? 'pass' : 'fail'"
      @click="toggle(c.id)"
    >
      <input
        type="checkbox"
        :checked="!!checks[c.id]"
        :aria-label="`验收条件 ${c.seq}：${c.text}`"
        @click.stop
        @change="toggle(c.id)"
      />
      <span class="rtext">{{ c.seq }}. {{ c.text }}</span>
    </div>

    <FormField
      class="mt-2"
      label="退回原因"
      hint="选择「退回修改」时必填；请具体说明哪一条未通过、期望如何修改。"
      for-id="review-reason"
    >
      <textarea
        id="review-reason"
        v-model="reason"
        class="textarea"
        placeholder="例如：第 2 条「失败场景有明确错误提示」未实现，请补充错误提示文案。"
      />
    </FormField>

    <template #footer>
      <BaseButton :disabled="busy" @click="emit('update:modelValue', false)">取消</BaseButton>
      <BaseButton variant="danger" :loading="busy" @click="requestReturn">退回修改</BaseButton>
      <BaseButton variant="primary" :disabled="busy || !allPassed" @click="requestComplete">
        确认完成
      </BaseButton>
    </template>
  </BaseModal>
</template>
