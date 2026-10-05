#!/usr/bin/env node
/**
 * 安装 git 钩子（报告 §5.3 C4 的收尾）
 *
 * 背景：`scripts/preflight.mjs` 已经把 CI 的机械检查搬到本地，但**需要开发者记得跑**。
 * README 与代码审查标准里一直挂着「尚未挂到 git 钩子上」这一条 —— 这里把它补上。
 *
 * 为什么用「安装脚本」而不是直接提交 `.git/hooks/`：
 * `.git/` 目录**不受版本控制**，钩子没法直接随仓库分发。业界两种做法：
 *   · 把钩子放在仓库内（如 `scripts/git-hooks/`），再让开发者执行一次安装（本脚本）
 *   · 用 husky 之类的工具自动安装 —— 但要引入依赖，与本项目「零额外依赖」的取向不符
 * 因此选前者：**一次 `npm run hooks:install`，之后长期生效**。
 *
 * 关于「钩子可以被 --no-verify 绕过」：这是 git 的设计（故意留给紧急通道），
 * 不是缺陷。因此钩子只是**第一道防线**，真正的门禁仍在 CI —— 两者不是替代关系。
 *
 * 用法：
 *   node scripts/install-git-hooks.mjs          # 安装
 *   node scripts/install-git-hooks.mjs --check  # 只检查是否已安装（不写入）
 *   node scripts/install-git-hooks.mjs --force  # 覆盖已存在的钩子
 *
 * 退出码：0 = 成功/已安装；1 = 检查模式发现未安装；2 = 环境问题（不是 git 仓库）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const CHECK_ONLY = argv.has('--check');
const FORCE = argv.has('--force');

/** 钩子内容：pre-push 跑一次完整的本地前置检查 */
const PRE_PUSH = `#!/bin/sh
# 由 scripts/install-git-hooks.mjs 生成 —— 不要直接改这个文件，
# 改 scripts/install-git-hooks.mjs 里的模板然后重新安装。
#
# 为什么是 pre-push 而不是 pre-commit：
#   · pre-commit 要快（每次提交都跑），而 preflight 会跑 Prettier 与 Prisma，
#     需要 node_modules 且要一两秒 —— 放在 pre-commit 会让人想关掉它；
#   · pre-push 的频率正好匹配「一次推送 = 一次 CI 运行」，在这里拦住最有价值。
#
# 想跳过（紧急情况）：git push --no-verify
# 注意：跳过只是省了本地这一次，CI 仍会照常检查。

echo "[pre-push] 运行本地前置检查（scripts/preflight.mjs）..."

if ! command -v node >/dev/null 2>&1; then
  echo "[pre-push] 跳过：找不到 node。请安装 Node 22+ 后重试。" >&2
  exit 0
fi

if node scripts/preflight.mjs; then
  echo "[pre-push] 通过。"
  exit 0
fi

echo "" >&2
echo "[pre-push] 前置检查未通过，已阻止推送。" >&2
echo "[pre-push] 按上面的提示修好即可；能自动修的可以试：" >&2
echo "[pre-push]   node scripts/preflight.mjs --fix" >&2
echo "[pre-push] 确实要跳过（紧急）：git push --no-verify" >&2
exit 1
`;

function gitDir() {
  const r = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const dir = r.stdout.trim();
  return path.isAbsolute(dir) ? dir : path.resolve(ROOT, dir);
}

const GIT_DIR = gitDir();
if (!GIT_DIR) {
  console.error('✗ 这里不是 git 仓库（或找不到 git），无法安装钩子。');
  process.exit(2);
}

const HOOK_PATH = path.join(GIT_DIR, 'hooks', 'pre-push');
const exists = fs.existsSync(HOOK_PATH);
const upToDate = exists && fs.readFileSync(HOOK_PATH, 'utf8') === PRE_PUSH;

if (CHECK_ONLY) {
  if (upToDate) {
    console.log('✅ pre-push 钩子已安装且为最新');
    process.exit(0);
  }
  console.log(exists ? '⚠️  pre-push 钩子存在但内容不是最新' : '⚠️  pre-push 钩子尚未安装');
  console.log('   运行：node scripts/install-git-hooks.mjs');
  process.exit(1);
}

if (upToDate && !FORCE) {
  console.log('✅ pre-push 钩子已是最新，无需改动');
  process.exit(0);
}

if (exists && !FORCE) {
  console.error('✗ 已存在 pre-push 钩子，且内容与模板不同 —— 不覆盖别人的东西。');
  console.error(`  路径：${HOOK_PATH}`);
  console.error('  确认可以覆盖后加 --force 重试。');
  process.exit(2);
}

fs.mkdirSync(path.dirname(HOOK_PATH), { recursive: true });
// 0o755：git 要求钩子可执行，否则会静默跳过（这条很容易漏）
fs.writeFileSync(HOOK_PATH, PRE_PUSH, { mode: 0o755 });
try {
  fs.chmodSync(HOOK_PATH, 0o755);
} catch {
  // Windows 上 chmod 是空操作，Git for Windows 会按扩展名/内容判断可执行性
}

console.log('✅ 已安装 pre-push 钩子');
console.log(`  路径：${HOOK_PATH}`);
console.log('  行为：推送前自动运行 node scripts/preflight.mjs（失败则阻止推送）');
console.log('  跳过：git push --no-verify（紧急通道，但 CI 仍会检查）');
