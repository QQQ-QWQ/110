<script setup lang="ts">
/**
 * FormField —— 表单项容器。
 *
 * 统一「标签 / 必填标记 / 字数计数 / 提示 / 错误」的排版与语义：
 *  - 错误优先于提示显示，避免两条信息互相打架；
 *  - 错误用 role="alert"，输入框失焦校验后读屏能立即播报；
 *  - 计数按 code points 展示，与后端判定口径一致。
 */
withDefaults(
  defineProps<{
    label: string;
    required?: boolean;
    hint?: string;
    error?: string;
    /** 形如 "12 / 200" 的计数文案 */
    counter?: string;
    counterOver?: boolean;
    /** 关联输入控件的 id */
    forId?: string;
  }>(),
  { required: false, counterOver: false },
);
</script>

<template>
  <div class="field">
    <div class="field-label">
      <label :for="forId">
        {{ label }}
        <span v-if="required" class="field-required" aria-hidden="true">*</span>
      </label>
      <span v-if="counter" class="field-counter" :class="{ 'is-over': counterOver }">
        {{ counter }}
      </span>
    </div>

    <slot />

    <div v-if="error" class="field-hint" style="color: var(--c-danger)" role="alert">
      {{ error }}
    </div>
    <div v-else-if="hint" class="field-hint">{{ hint }}</div>
  </div>
</template>
