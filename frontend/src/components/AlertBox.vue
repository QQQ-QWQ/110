<script setup lang="ts">
import { computed } from 'vue';

/**
 * AlertBox —— 内联提示条。
 *
 * 可访问性细节：只有 error / warn 用 `role="alert"`（会被读屏立即打断播报），
 * info / success 用 `role="status"`（礼貌播报），避免无谓打断。
 */
const props = withDefaults(defineProps<{ kind?: 'info' | 'error' | 'warn' | 'success' }>(), {
  kind: 'info',
});

const role = computed(() => (props.kind === 'error' || props.kind === 'warn' ? 'alert' : 'status'));
</script>

<template>
  <div class="alert" :class="`alert-${kind}`" :role="role">
    <slot />
  </div>
</template>
