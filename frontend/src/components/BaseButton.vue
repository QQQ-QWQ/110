<script setup lang="ts">
/**
 * BaseButton —— 统一按钮。
 *
 * 收敛三件事，避免各页面重复写：
 *  1. 变体（default / primary / danger / ghost）与尺寸（sm / md / lg）；
 *  2. loading 态：自动禁用并显示与背景对比度足够的 spinner；
 *  3. 可访问性：loading 时置 aria-busy，禁用时原生 disabled。
 */
withDefaults(
  defineProps<{
    variant?: 'default' | 'primary' | 'danger' | 'ghost';
    size?: 'sm' | 'md' | 'lg';
    block?: boolean;
    loading?: boolean;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
  }>(),
  {
    variant: 'default',
    size: 'md',
    block: false,
    loading: false,
    disabled: false,
    type: 'button',
  },
);
</script>

<template>
  <button
    class="btn"
    :class="[
      variant !== 'default' ? `btn-${variant}` : '',
      size !== 'md' ? `btn-${size}` : '',
      { 'btn-block': block },
    ]"
    :type="type"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <span
      v-if="loading"
      class="spinner"
      :class="{ 'spinner-dark': variant !== 'primary' && variant !== 'danger' }"
      aria-hidden="true"
    />
    <slot />
  </button>
</template>
