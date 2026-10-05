#!/usr/bin/env node
/**
 * entrypoint 故障分流验证（报告 §5.2 S4）
 *
 * 为什么需要它：`docker-entrypoint.sh` 里的「连接类错误重试 / 迁移类错误立即失败」
 * 这条分流逻辑，只有**在容器里真的启动一次**才会被触发 —— 而本环境没有 Docker 引擎。
 * 于是这段逻辑成了唯一无法验证的部分。
 *
 * 办法：不去起容器，而是**用一个假的 `npx` 驱动真实的 entrypoint 脚本**。
 * 把桩程序放在 PATH 最前面，就能精确控制 `prisma migrate deploy` 的行为，
 * 从而覆盖四种情形：
 *
 *   A. 连接类错误（库还没起来）  → 重试到上限后放弃，退出码 1
 *   B. 迁移类错误（SQL 写错）    → **立即**失败，不重试，退出码 1
 *   C. 一次成功                  → 继续 seed 并启动服务，退出码 0
 *   D. 先失败后成功（库慢启动）  → 重试一次即通过，退出码 0
 *
 * 这验证的是**脚本自身的控制流**，不是「容器能不能起来」——
 * 后者仍然需要一台有 Docker 引擎的机器（如实标注，不假装覆盖到了）。
 *
 * 用法：node scripts/verify-entrypoint.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 环境不具备（找不到 POSIX sh）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRYPOINT = path.join(ROOT, 'backend', 'docker-entrypoint.sh');

const rows = [];
let failures = 0;

function check(name, expected, actual) {
  const ok = expected === actual;
  if (!ok) failures += 1;
  rows.push({ name, expected, actual, ok });
}

// ── 先确认环境具备条件（不具备时**明确失败**，不静默跳过） ──
const shProbe = spawnSync('sh', ['-c', 'exit 0'], { encoding: 'utf8' });
if (shProbe.error || shProbe.status !== 0) {
  console.error('✗ 找不到可用的 POSIX sh —— 本脚本需要一个 POSIX shell 来执行 entrypoint。');
  console.error('  Linux/macOS 自带；Windows 请在 Git Bash 里运行。');
  process.exit(2);
}

// ── 搭验证台：临时目录 + 桩 npx / 桩 node ──
const PROBE = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-probe-'));
const BIN = path.join(PROBE, 'bin');
fs.mkdirSync(BIN, { recursive: true });

const COUNTER = path.join(PROBE, 'counter');

/** 桩 npx：按 mode 决定 migrate deploy 的行为 */
function writeStubNpx(mode) {
  const body = {
    ok: `echo "All migrations have been successfully applied."; exit 0`,
    conn: `echo "Error: P1001: Can't reach database server at \\\`db:5432\\\`" >&2; exit 1`,
    sql: `echo "Error: P3018" >&2; echo "A migration failed to apply." >&2; echo 'syntax error at or near "ALTERTABLE"' >&2; exit 1`,
    // 先失败后成功：用计数器决定
    slow: `n=$(cat "${COUNTER}" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${COUNTER}"
if [ "$n" -ge 2 ]; then echo "All migrations have been successfully applied."; exit 0; fi
echo "Error: P1001: Can't reach database server at \\\`db:5432\\\`" >&2; exit 1`,
  }[mode];
  fs.writeFileSync(path.join(BIN, 'npx'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** 桩 node：seed 与 main 都直接成功（本脚本只关心 entrypoint 的控制流） */
fs.writeFileSync(path.join(BIN, 'node'), `#!/bin/sh\necho "[probe] node $*"\nexit 0\n`, {
  mode: 0o755,
});

/** 跑一次 entrypoint，返回 { status, out } */
function runEntrypoint(mode, maxTries = 3) {
  if (mode === 'slow') fs.rmSync(COUNTER, { force: true });
  writeStubNpx(mode);
  const r = spawnSync('sh', [ENTRYPOINT], {
    cwd: path.join(ROOT, 'backend'),
    encoding: 'utf8',
    env: {
      ...process.env,
      // 桩程序放最前，确保 entrypoint 调到的 npx / node 都是桩
      PATH: `${BIN}${path.delimiter}${process.env.PATH ?? ''}`,
      DB_WAIT_MAX_TRIES: String(maxTries),
      DB_WAIT_INTERVAL: '0',
    },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

console.log('entrypoint 故障分流验证（报告 §5.2 S4）');
console.log(`脚本：${path.relative(ROOT, ENTRYPOINT)}`);
console.log(`验证台：${PROBE}\n`);

// ── A. 连接类错误 → 重试到上限后放弃 ──
{
  const { status, out } = runEntrypoint('conn', 3);
  check('A 连接类错误 → 退出码 1', 1, status);
  check('A 完整错误被打印（不再被 if 吞掉）', true, out.includes("Can't reach database server"));
  check('A 重试到上限', true, out.includes('第 3/3 次'));
  check('A 给出排查提示', true, out.includes('docker compose ps'));
  check('A 未进入 seed', false, out.includes('node dist/seed.js'));
}

// ── B. 迁移类错误 → 立即失败，不重试 ──
{
  const { status, out } = runEntrypoint('sql', 3);
  check('B 迁移类错误 → 退出码 1', 1, status);
  check('B 完整错误被打印', true, out.includes('syntax error'));
  check('★ B 判定为「迁移本身有问题」', true, out.includes('迁移本身有问题'));
  check('★ B **不重试**（只出现第 1 次）', false, out.includes('第 2/3 次'));
  check('B 未进入 seed', false, out.includes('node dist/seed.js'));
}

// ── C. 一次成功 → 继续 seed 并启动 ──
{
  const { status, out } = runEntrypoint('ok', 3);
  check('C 成功 → 退出码 0', 0, status);
  check('C 执行了 seed', true, out.includes('node dist/seed.js'));
  check('C 启动了服务', true, out.includes('node dist/main.js'));
}

// ── D. 先失败后成功（库慢启动）→ 重试一次即通过 ──
{
  const { status, out } = runEntrypoint('slow', 5);
  check('D 先失败后成功 → 退出码 0', 0, status);
  check('D 确实重试过', true, out.includes('第 1/5 次'));
  check('D 第 2 次即完成', true, out.includes('迁移完成（第 2 次尝试）'));
  check('D 启动了服务', true, out.includes('node dist/main.js'));
}

// ── 输出 ──
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
console.log(`${pad('情形', 42)}${pad('期望', 8)}实际`);
console.log('-'.repeat(42 + 8 + 8));
for (const r of rows) {
  console.log(`${pad(r.name, 42)}${pad(r.expected, 8)}${r.actual} ${r.ok ? '✓' : '✗'}`);
}

fs.rmSync(PROBE, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n✗ ${failures} 项断言失败`);
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log('::error::entrypoint 故障分流验证失败');
  }
  process.exit(1);
}
console.log(`\n✅ 全部 ${rows.length} 项通过`);
console.log('注：这里验证的是**脚本自身的控制流**，不是「容器能不能起来」——');
console.log('    后者仍需一台有 Docker 引擎的机器。');
