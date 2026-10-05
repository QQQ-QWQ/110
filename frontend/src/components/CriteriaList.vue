<script setup lang="ts">
import AppIcon from './AppIcon.vue';
import type { Criterion } from '../types';

/**
 * CriteriaList —— 验收条件列表。
 *
 * 两个使用场景复用同一组件：
 *  - 详情页：只读展示（不传 checks）；
 *  - 提交记录 / 验收结果：带 `checks` 时额外渲染勾选 / 未勾选图标。
 *
 * `checks` 用 Record<criterionId, passed> 而非数组，避免调用方每次都做查找。
 */
defineProps<{
  criteria: Criterion[];
  checks?: Record<string, boolean> | null;
}>();
</script>

<template>
  <ul class="criteria-list">
    <li v-for="c in criteria" :key="c.id">
      <span class="seq">{{ c.seq }}</span>
      <span :style="checks ? { flex: 1 } : undefined">{{ c.text }}</span>
      <span
        v-if="checks && c.id in checks"
        class="check-mark"
        :class="checks[c.id] ? 'pass' : 'fail'"
        :aria-label="checks[c.id] ? '通过' : '未通过'"
      >
        <AppIcon :name="checks[c.id] ? 'check' : 'cross'" />
      </span>
    </li>
  </ul>
</template>
