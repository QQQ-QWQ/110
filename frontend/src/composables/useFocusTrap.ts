import { nextTick, onUnmounted, watch, type Ref } from 'vue';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * 弹窗焦点管理 —— 焦点陷阱 + Esc 关闭 + 关闭后焦点归还。
 *
 * 解决三个键盘/读屏用户的实际问题：
 *  1. 打开弹窗后 Tab 键会跑到弹窗背后的页面上（焦点陷阱拦截）；
 *  2. 只能用鼠标点「×」才能关闭（Esc 关闭）；
 *  3. 关闭后焦点丢失、回到 body 顶部（归还给触发元素）。
 *
 * @param container 弹窗根元素
 * @param active    是否打开
 * @param onEscape  Esc 按下时的回调
 */
export function useFocusTrap(
  container: Ref<HTMLElement | null>,
  active: Ref<boolean>,
  onEscape?: () => void,
): void {
  let previouslyFocused: HTMLElement | null = null;

  function focusable(): HTMLElement[] {
    const el = container.value;
    if (!el) return [];
    return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onEscape?.();
      return;
    }
    if (event.key !== 'Tab') return;

    const nodes = focusable();
    if (nodes.length === 0) {
      event.preventDefault();
      return;
    }

    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const current = document.activeElement as HTMLElement | null;
    const inside = current !== null && container.value?.contains(current) === true;

    if (event.shiftKey) {
      if (!inside || current === first) {
        event.preventDefault();
        last.focus();
      }
    } else if (!inside || current === last) {
      event.preventDefault();
      first.focus();
    }
  }

  watch(
    active,
    async (isOpen) => {
      // 非浏览器环境（SSR / 单元测试）没有 document，跳过全部 DOM 操作
      if (typeof document === 'undefined') return;

      if (isOpen) {
        previouslyFocused = document.activeElement as HTMLElement | null;
        document.addEventListener('keydown', handleKeydown, true);
        await nextTick();
        const nodes = focusable();
        // 优先聚焦第一个可交互元素，否则聚焦容器本身
        (nodes[0] ?? container.value)?.focus();
      } else {
        document.removeEventListener('keydown', handleKeydown, true);
        previouslyFocused?.focus?.();
        previouslyFocused = null;
      }
    },
    { immediate: true },
  );

  onUnmounted(() => {
    document.removeEventListener('keydown', handleKeydown, true);
  });
}
