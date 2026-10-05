import { ref, type Ref } from 'vue';

/**
 * 全局提示（Toast）—— 轻量单例 store。
 *
 * 为什么不用组件内局部提示：
 *  - 一次操作的结果（成功/失败）常发生在弹窗关闭之后，需要跨组件存活；
 *  - 移动端弹窗全屏时，局部提示会被遮挡。
 *
 * 约定：错误提示默认不自动消失（duration=0），强制用户看到失败；
 * 成功/普通提示 3.5s 自动消失。
 */

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

const DEFAULT_DURATION = 3500;

const items = ref<ToastItem[]>([]);
let seq = 0;

function push(kind: ToastKind, message: string, duration: number): number {
  const id = ++seq;
  items.value = [...items.value, { id, kind, message }];
  if (duration > 0) {
    window.setTimeout(() => dismissToast(id), duration);
  }
  return id;
}

export function dismissToast(id: number): void {
  items.value = items.value.filter((t) => t.id !== id);
}

export function clearToasts(): void {
  items.value = [];
}

export const toast = {
  info: (message: string, duration = DEFAULT_DURATION) => push('info', message, duration),
  success: (message: string, duration = DEFAULT_DURATION) => push('success', message, duration),
  /** 错误默认常驻，必须用户手动关闭或触发下一次操作 */
  error: (message: string, duration = 0) => push('error', message, duration),
};

export interface UseToastReturn {
  toasts: Ref<ToastItem[]>;
  info: (message: string, duration?: number) => number;
  success: (message: string, duration?: number) => number;
  error: (message: string, duration?: number) => number;
  dismiss: (id: number) => void;
}

export function useToast(): UseToastReturn {
  return {
    toasts: items,
    info: toast.info,
    success: toast.success,
    error: toast.error,
    dismiss: dismissToast,
  };
}
