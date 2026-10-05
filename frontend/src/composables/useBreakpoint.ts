import { computed, onUnmounted, readonly, ref, type ComputedRef, type Ref } from 'vue';

/**
 * 响应式断点（JS 侧）。
 *
 * CSS 负责绝大多数布局适配；只有在「需要改变 DOM 结构或默认状态」时才用本组合式函数，
 * 例如移动端默认折叠筛选面板。断点阈值与 `styles/responsive.css` 保持一致。
 */

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

const QUERIES: ReadonlyArray<{ key: Breakpoint; query: string }> = [
  { key: 'mobile', query: '(max-width: 639px)' },
  { key: 'tablet', query: '(min-width: 640px) and (max-width: 1023px)' },
  { key: 'desktop', query: '(min-width: 1024px)' },
];

export interface UseBreakpointReturn {
  breakpoint: Readonly<Ref<Breakpoint>>;
  isMobile: ComputedRef<boolean>;
  isTablet: ComputedRef<boolean>;
  isDesktop: ComputedRef<boolean>;
}

export function useBreakpoint(): UseBreakpointReturn {
  const breakpoint = ref<Breakpoint>('desktop');
  const cleanups: Array<() => void> = [];

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    for (const { key, query } of QUERIES) {
      const mql = window.matchMedia(query);
      const apply = (matches: boolean): void => {
        if (matches) breakpoint.value = key;
      };
      apply(mql.matches);
      const handler = (event: MediaQueryListEvent): void => apply(event.matches);
      mql.addEventListener('change', handler);
      cleanups.push(() => mql.removeEventListener('change', handler));
    }
  }

  onUnmounted(() => cleanups.forEach((fn) => fn()));

  return {
    breakpoint: readonly(breakpoint) as Readonly<Ref<Breakpoint>>,
    isMobile: computed(() => breakpoint.value === 'mobile'),
    isTablet: computed(() => breakpoint.value === 'tablet'),
    isDesktop: computed(() => breakpoint.value === 'desktop'),
  };
}
