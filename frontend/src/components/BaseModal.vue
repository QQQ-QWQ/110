<script setup lang="ts">
import { computed, ref } from 'vue';
import { useBodyScrollLock } from '../composables/useBodyScrollLock';
import { useFocusTrap } from '../composables/useFocusTrap';

/**
 * BaseModal —— 统一弹窗基座。
 *
 * 封装了四处「每个弹窗都会写错一遍」的细节：
 *  - Teleport 到 body：避免被父级 overflow / transform 裁剪；
 *  - 焦点陷阱 + Esc 关闭 + 关闭后焦点归还（键盘与读屏可用）；
 *  - body 滚动锁（引用计数，支持弹窗叠加）；
 *  - role="dialog" / aria-modal，供读屏正确播报。
 *
 * 移动端样式由 responsive.css 接管，自动变为全屏抽屉，无需调用方感知。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    closable?: boolean;
    maxWidth?: number;
  }>(),
  { closable: true, maxWidth: 560 },
);

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const rootRef = ref<HTMLElement | null>(null);

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

function close(): void {
  if (props.closable) open.value = false;
}

useBodyScrollLock(open);
useFocusTrap(rootRef, open, close);
</script>

<template>
  <Teleport to="body">
    <!-- 动效 #1/#2/#3（方案 §8.3）：遮罩淡入淡出 + 面板 scale/translate。
         用 <Transition> 而不是纯 CSS 动画，是因为**关闭**动画必须在元素被移除**之前**
         播完 —— 只靠 CSS 做不到这一点（元素会立刻消失）。
         过渡类名加在遮罩上（它是过渡根），面板样式由 `.modal-enter-from .modal`
         这类后代选择器命中，见 components.css。 -->
    <Transition name="modal">
      <div v-if="modelValue" class="overlay" @click.self="close">
        <div
          ref="rootRef"
          class="modal"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          :style="{ maxWidth: `${maxWidth}px` }"
          tabindex="-1"
        >
          <div class="modal-head">
            <h3>{{ title }}</h3>
            <button v-if="closable" class="icon-btn" type="button" aria-label="关闭" @click="close">
              ×
            </button>
          </div>

          <div class="modal-body">
            <slot />
          </div>

          <div v-if="$slots.footer" class="modal-foot">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
