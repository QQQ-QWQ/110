<script setup lang="ts">
import { ref, watch } from 'vue';
import type { RequirementState } from '../types';

/** StatusBadge —— 需求四态徽标。颜色与圆点由 .badge.<STATE> 定义在 components.css。 */
const props = defineProps<{ state: RequirementState; label: string }>();

/**
 * 动效 #8（方案 §8.3）：状态**真变化**时圆点 scale 1→1.4→1，只播一次。
 *
 * 为什么这里需要 JS —— CSS 无法感知「值变了」。有两条看似更简单的路，但都不对：
 *   · 纯 CSS 常驻动画 → 页面一加载十几个徽标同时跳，违反方案 §8.1「同一时刻最多一处动效」
 *   · `:key="state"` 强制重建元素 → 重建在**首次挂载**时也会发生，同样是满屏跳动
 * 所以用一个只在**变化**时置位的标记，配合 animationend 复位 ——
 * 这样下一次变化还能再播，而首次渲染不会播。
 *
 * 注意：动画加在 `::before`（圆点）上，但 `animationend` 会派发到**源元素**，
 * 因此监听器挂在 `.badge` 上即可。
 */
const pulsing = ref(false);

watch(
  () => props.state,
  () => {
    pulsing.value = true;
  },
);
</script>

<template>
  <span class="badge" :class="[state, { 'is-pulsing': pulsing }]" @animationend="pulsing = false">
    {{ label }}
  </span>
</template>
