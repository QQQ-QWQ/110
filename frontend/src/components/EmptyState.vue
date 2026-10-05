<script setup lang="ts">
/**
 * EmptyState —— 空结果占位。
 *
 * 与「加载中」严格区分：空态要解释**为什么空**以及**下一步能做什么**，
 * 否则用户会误以为页面坏了（考核要求「空结果反馈」）。
 */
defineProps<{ title?: string; desc?: string }>();
</script>

<template>
  <div class="empty">
    <div v-if="title" class="empty-title">{{ title }}</div>
    <div v-if="desc" class="empty-desc">{{ desc }}</div>
    <div v-if="$slots.default" class="mt-2">
      <slot />
    </div>
  </div>
</template>
