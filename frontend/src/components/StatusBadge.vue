<script setup lang="ts">
import type { RequirementState } from '../types';

/** StatusBadge —— 需求四态徽标。颜色与圆点由 .badge.<STATE> 定义在 components.css。 */
defineProps<{ state: RequirementState; label: string }>();
</script>

<template>
  <span class="badge" :class="state">{{ label }}</span>
</template>
