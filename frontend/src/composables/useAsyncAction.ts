import { ref, type Ref } from 'vue';
import { ApiError } from '../api';

/**
 * 异步动作的统一封装 —— 消灭「每个页面各写一套 busy / error」的重复。
 *
 * 保证三件事：
 *  1. 动作执行期间 `busy` 为 true（按钮禁用 + loading 文案）；
 *  2. 失败时**一定**有可读文案，绝不静默吞掉；
 *  3. 原始错误对象保留在 `lastError`，供调用方判断是否需要「刷新后重试」
 *     （见 `api.isRefreshable`）。
 */

export interface UseAsyncActionReturn {
  busy: Ref<boolean>;
  error: Ref<string>;
  lastError: Ref<unknown>;
  run: (fn: () => Promise<unknown>, fallback?: string) => Promise<boolean>;
  clearError: () => void;
}

export function useAsyncAction(): UseAsyncActionReturn {
  const busy = ref(false);
  const error = ref('');
  const lastError = ref<unknown>(null);

  async function run(
    fn: () => Promise<unknown>,
    fallback = '操作失败，请稍后重试',
  ): Promise<boolean> {
    busy.value = true;
    error.value = '';
    lastError.value = null;
    try {
      await fn();
      return true;
    } catch (e) {
      lastError.value = e;
      error.value = e instanceof ApiError ? e.message : fallback;
      return false;
    } finally {
      busy.value = false;
    }
  }

  return { busy, error, lastError, run, clearError: () => (error.value = '') };
}
