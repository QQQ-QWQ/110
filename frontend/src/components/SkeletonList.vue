<script setup lang="ts">
/**
 * SkeletonList —— 列表加载骨架屏。
 *
 * 为什么不用「加载中…」一行字：骨架屏保留了最终布局的形状，
 * 数据到达时不会发生整页跳动（CLS），感知等待时间也更短。
 * 骨架本身对读屏隐藏，只播报一句「加载中」。
 */
withDefaults(defineProps<{ rows?: number }>(), { rows: 3 });
</script>

<template>
  <div class="card-body">
    <span class="sr-only" role="status">加载中</span>
    <div
      v-for="row in rows"
      :key="row"
      aria-hidden="true"
      :style="{ marginBottom: row === rows ? 0 : '20px' }"
    >
      <div class="skeleton skeleton-line" style="width: 38%; height: 15px" />
      <div class="skeleton skeleton-line" style="width: 72%" />
      <div class="skeleton skeleton-line" style="width: 54%; margin-bottom: 0" />
    </div>
  </div>
</template>
