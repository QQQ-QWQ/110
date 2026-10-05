import { ref, type Ref } from 'vue';
import { api } from '../api';
import type { UserBrief } from '../types';

/**
 * 当前登录用户 —— 模块级缓存。
 *
 * 为什么需要它：顶栏要显示用户名、列表页要「排除自己」作为负责人候选，
 * 若各自调用 /auth/me，同一屏会重复请求。这里做一次性缓存，
 * 登录/登出时显式失效（见 App.vue）。
 */

const current = ref<UserBrief | null>(null);
let loaded = false;

export interface UseCurrentUserReturn {
  current: Ref<UserBrief | null>;
  /** 强制重新拉取（登录后、路由切换时） */
  refresh: () => Promise<UserBrief | null>;
  /** 已有缓存则直接返回，否则拉取一次 */
  ensure: () => Promise<UserBrief | null>;
  /** 清空缓存（登出时） */
  clear: () => void;
}

export function useCurrentUser(): UseCurrentUserReturn {
  async function refresh(): Promise<UserBrief | null> {
    try {
      current.value = await api.me();
    } catch {
      current.value = null;
    }
    loaded = true;
    return current.value;
  }

  async function ensure(): Promise<UserBrief | null> {
    if (loaded) return current.value;
    return refresh();
  }

  function clear(): void {
    current.value = null;
    loaded = false;
  }

  return { current, refresh, ensure, clear };
}
