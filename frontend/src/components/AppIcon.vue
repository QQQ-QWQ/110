<script setup lang="ts">
/**
 * AppIcon —— 内联 SVG 图标集。
 *
 * 为什么不用图标库（方案 §11 的取舍）：整个界面只需要 4 类图标
 * （关闭 / 返回 / 勾选 / 箭头），为此引入一个图标集要付出几十 KB 的运行时依赖。
 * 内联 SVG 既不增加依赖，也能随 `currentColor` 自动继承文字颜色。
 *
 * 为什么不用 emoji（方案 §1.2 的反模式之一）：emoji 的外观由**操作系统**决定 ——
 * 同一个 ✓ 在 Windows、macOS、Android 上长得都不一样，甚至同一行里粗细不一致。
 * 它是「设计系统失控」最典型的信号。
 *
 * 用法：<AppIcon name="check" /> —— 尺寸默认 1em，因此跟随所在文字的字号。
 */
export type IconName = 'close' | 'back' | 'check' | 'cross' | 'arrow' | 'wait' | 'more';

withDefaults(defineProps<{ name: IconName; size?: string }>(), { size: '1em' });

/**
 * 每个图标一组 path；统一 24×24 视框、描边式（不填充），保证粗细一致。
 *
 * 方案 §11 估计「只需要 4 类」，实际数下来是 6 个图形：除了关闭/返回/勾选/箭头，
 * 「下一步引导」还需要表达「等待他人」与「状态未知」两个非动作状态
 * —— 原先用 `·` 和 `…` 两个排版字符凑，同样存在跨字体不一致的问题，一并收进图标集。
 */
const PATHS: Record<IconName, string[]> = {
  close: ['M6 6l12 12', 'M18 6L6 18'],
  cross: ['M6 6l12 12', 'M18 6L6 18'],
  back: ['M19 12H5', 'M12 19l-7-7 7-7'],
  check: ['M20 6L9 17l-5-5'],
  arrow: ['M5 12h14', 'M12 5l7 7-7 7'],
  // 等待他人：时钟（不是「暂停」——语义是「轮到别人」，不是「被暂停」）
  wait: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
  // 状态未知：三点（比问号更中性，不暗示出错）
  more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
};

/** 关闭/未勾选需要更重的描边才在密集列表里看得清；其余保持统一细描边 */
const STROKE: Record<IconName, number> = {
  close: 1.7,
  cross: 2.3,
  back: 1.9,
  check: 2.4,
  arrow: 1.9,
  wait: 1.7,
  more: 2.4,
};
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    :stroke-width="STROKE[name]"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(d, i) in PATHS[name]" :key="i" :d="d" />
  </svg>
</template>

<style scoped>
.icon {
  display: inline-block;
  vertical-align: -0.125em; /* 与文字基线对齐，避免图标把行高顶开 */
  flex-shrink: 0;
}
</style>
