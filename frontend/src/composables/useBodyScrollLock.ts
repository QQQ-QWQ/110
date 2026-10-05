import { onUnmounted, watch, type Ref } from 'vue';

/**
 * 弹窗滚动锁 —— 引用计数版。
 *
 * 为什么用计数而不是直接 toggle class：
 * 移动端可能出现「验收弹窗叠在详情页之上」这类多弹窗场景，
 * 若各自无条件 add/remove，先关闭的那个会把 body 的锁提前解除。
 */

let lockCount = 0;

/** 非浏览器环境（SSR / 单元测试）下无 body 可锁，直接跳过 */
function hasDom(): boolean {
  return typeof document !== 'undefined' && document.body !== undefined;
}

function lock(): void {
  if (!hasDom()) return;
  lockCount += 1;
  if (lockCount === 1) document.body.classList.add('is-locked');
}

function unlock(): void {
  if (!hasDom()) return;
  if (lockCount === 0) return;
  lockCount -= 1;
  if (lockCount === 0) document.body.classList.remove('is-locked');
}

/** 命令式用法（非组件环境） */
export const bodyScrollLock = { lock, unlock };

/**
 * 组合式用法：`active` 为 true 时锁滚动，变为 false 或组件卸载时解锁。
 *
 * @example
 * const open = ref(false);
 * useBodyScrollLock(open);
 */
export function useBodyScrollLock(active: Ref<boolean>): void {
  let held = false;

  watch(
    active,
    (value) => {
      if (value && !held) {
        held = true;
        lock();
      } else if (!value && held) {
        held = false;
        unlock();
      }
    },
    { immediate: true },
  );

  onUnmounted(() => {
    if (held) {
      held = false;
      unlock();
    }
  });
}
