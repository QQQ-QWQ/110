#!/usr/bin/env node
/**
 * 设计令牌与用色纪律检查（《UI 设计方案》§4.2 / §5.3 / §10.3）
 *
 * 为什么要有这个脚本：方案里写了很多「应该」——品牌色是唯一强调色、颜色只用语义令牌、
 * 禁用 700 字重、圆角只用三级……但**写在文档里的纪律不会被自动执行**。
 * 一个新人（或几个月后的自己）随手写一个 `#2563eb` 就能悄悄破坏它，
 * 而代码评审不一定看得出来。
 *
 * 这里把方案 §10.3 的一致性检查清单里**可自动化的部分**变成门禁：
 *
 *   ① `var(--x)` 引用了 tokens.css 里不存在的令牌（改名/手滑的典型后果）
 *   ② tokens.css 之外出现硬编码颜色（hex / rgb / rgba）
 *   ③ tokens.css 之外出现 `cubic-bezier`（缓动必须走令牌）
 *   ④ `font-weight: 700`（方案 §5.3 明确禁用 —— 它让界面整体发重）
 *   ⑤ 裸数值 `border-radius`（只允许 50% 与 0；其余必须走 --r-*）
 *   ⑥ `transition` 里的裸时长（必须走 --dur-*）
 *   ⑦ `linear-gradient` 超过 2 处（方案只允许品牌标记与骨架屏两处）
 *
 * ⑥ 的边界（刻意划清，避免误报）：
 *   · 只查 **transition**，不查 animation。方案的 --dur-1/2/3 描述的是
 *     「微反馈 / 组件状态 / 布局与浮层」，都是**过渡**；而骨架屏流光（1.4s）与
 *     加载旋转（0.7s）是**循环动画**，有自己的节奏，不属于这套词汇。
 *   · 跳过 `@media (prefers-reduced-motion)` 块 —— 那里写 `0.01ms !important`
 *     是**故意**把动画关掉的标准做法，不是「忘了用令牌」。
 *
 * 另有**只报告不阻断**的一项：定义了但没被引用的令牌 ——
 * 令牌层本就会先于组件引入新词汇（P1 加、P2~P4 用），因此它不该阻断合入。
 *
 * 用法：node scripts/verify-design-tokens.mjs
 * 退出码：0 = 通过；1 = 有违规；2 = 环境问题（找不到源目录）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'frontend', 'src');
const TOKENS = path.join(SRC, 'styles', 'tokens.css');

if (!fs.existsSync(TOKENS)) {
  console.error(`::error::找不到令牌文件：${TOKENS}`);
  process.exit(2);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(css|vue)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const tokensText = fs.readFileSync(TOKENS, 'utf8');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/** 允许的例外：方案明确点名保留的两处渐变 */
const GRADIENT_ALLOWED = 2;

const violations = [];

function report(file, line, message) {
  violations.push({ file: rel(file), line, message });
}

// ── 收集令牌定义与引用 ──
const defined = new Set();
for (const m of tokensText.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) defined.add(m[1]);

const referenced = new Map(); // token → [{file, line}]
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((text, i) => {
    for (const m of text.matchAll(/var\((--[a-z0-9-]+)/g)) {
      if (!referenced.has(m[1])) referenced.set(m[1], []);
      referenced.get(m[1]).push({ file: f, line: i + 1 });
    }
  });
}

// ── ① 未定义的令牌引用 ──
for (const [token, uses] of referenced) {
  if (!defined.has(token)) {
    for (const u of uses) {
      report(u.file, u.line, `引用了未定义的令牌 ${token}（tokens.css 里没有它）`);
    }
  }
}

// ── ②③④⑤⑥⑦ 逐文件扫描 ──
let gradientCount = 0;
for (const f of files) {
  if (path.resolve(f) === path.resolve(TOKENS)) continue; // 令牌文件本身是唯一的例外
  const lines = fs.readFileSync(f, 'utf8').split('\n');

  // 跟踪是否位于 prefers-reduced-motion 块内（那里写死 0.01ms 是标准做法）
  let reducedMotionDepth = 0;

  lines.forEach((text, i) => {
    const line = i + 1;
    const inReducedMotion = reducedMotionDepth > 0;

    // 进入 / 离开降级块（用花括号计数，兼容块内还有嵌套规则）
    if (text.includes('prefers-reduced-motion')) reducedMotionDepth += 1;
    if (inReducedMotion) {
      reducedMotionDepth += (text.match(/\{/g) ?? []).length;
      reducedMotionDepth -= (text.match(/\}/g) ?? []).length;
      if (reducedMotionDepth < 0) reducedMotionDepth = 0;
      return; // 降级块内不检查任何纪律
    }

    // ② 硬编码颜色
    const color = text.match(/#[0-9a-fA-F]{3,8}\b/) ?? text.match(/\brgba?\s*\(/);
    if (color) {
      report(f, line, `硬编码颜色 ${color[0]} —— 请改用 tokens.css 里的语义令牌（方案 §4.2）`);
    }

    // ③ 缓动必须走令牌
    if (text.includes('cubic-bezier')) {
      report(
        f,
        line,
        '裸 cubic-bezier —— 请改用 --ease-in / --ease-standard / --ease-out（方案 §8.2）',
      );
    }

    // ④ 禁用 700 字重
    if (/font-weight\s*:\s*700/.test(text)) {
      report(f, line, 'font-weight: 700 —— 方案 §5.3 明确禁用（需要强调时改用颜色或字号）');
    }

    // ⑤ 裸数值圆角（50% 是圆形、0 是无圆角，都是语义明确的写法）
    const radius = text.match(/border-radius\s*:\s*([^;]+)/);
    if (radius) {
      const value = radius[1].trim();
      if (/^[\d.]+px/.test(value)) {
        report(
          f,
          line,
          `裸数值圆角 ${value} —— 请改用 --r-sm / --r-md / --r-lg / --r-pill（方案 §5.4）`,
        );
      }
    }

    // ⑥ 过渡里的裸时长（只查 transition —— 循环动画有自己的节奏，见文件头说明）
    if (/transition(-duration)?\s*:[^;]*\b[\d.]+m?s\b/.test(text)) {
      report(f, line, 'transition 里出现裸时长 —— 请改用 --dur-1 / --dur-2 / --dur-3（方案 §8.2）');
    }

    // ⑦ 渐变配额
    if (text.includes('linear-gradient')) gradientCount += 1;
  });
}

if (gradientCount > GRADIENT_ALLOWED) {
  violations.push({
    file: '（全仓库统计）',
    line: 0,
    message:
      `linear-gradient 出现 ${gradientCount} 处，超过允许的 ${GRADIENT_ALLOWED} 处` +
      '（方案 §4.2 只允许品牌标记与骨架屏保留渐变）',
  });
}

// ── 只报告不阻断：未被引用的令牌 ──
const unused = [...defined].filter((t) => !referenced.has(t)).sort();

// ── 输出 ──
console.log('设计令牌与用色纪律检查（《UI 设计方案》§4.2 / §5.3 / §10.3）');
console.log(
  `扫描：${files.length} 个文件 | 令牌：定义 ${defined.size} / 被引用 ${referenced.size}\n`,
);

if (violations.length > 0) {
  console.log(`❌ ${violations.length} 处违规：`);
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}  ${v.message}`);
  }
  console.log('\n这些纪律写在《UI 设计方案》里，此处把它变成可执行的检查 ——');
  console.log('否则「品牌色是唯一强调色」「颜色只用令牌」这类约定会在几次改动后悄悄失效。');
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log('::error::设计令牌或用色纪律存在违规');
  }
  process.exit(1);
}

console.log('✅ 全部通过：');
console.log('   · 无未定义的令牌引用');
console.log('   · 组件里零硬编码颜色（hex / rgb / rgba）');
console.log('   · 零裸 cubic-bezier（缓动全走令牌）');
console.log(`   · linear-gradient 恰好 ${gradientCount} 处（品牌标记 + 骨架屏）`);
console.log('   · 零 font-weight: 700');
console.log('   · 零裸数值圆角、零裸时长');

if (unused.length > 0) {
  console.log(`\nℹ️  未被引用的令牌 ${unused.length} 个（**不阻断**）：`);
  console.log(`   ${unused.join('  ')}`);
  console.log('   令牌层先于组件引入新词汇是正常的（P1 加、P2~P4 用）；');
  console.log('   但若某个令牌长期无人引用，应当删掉它 —— 否则色板会变成一张没人看的清单。');
}
