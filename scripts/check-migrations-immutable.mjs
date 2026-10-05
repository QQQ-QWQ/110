#!/usr/bin/env node
/**
 * 已应用迁移不可修改（报告 §5.3 C3）
 *
 * 为什么需要这条检查：
 * 迁移一旦被应用过，它就已经写进了某些数据库的 `_prisma_migrations` 表里。
 * 之后再改这个文件的内容，会造成**「迁移历史」与「实际库结构」永久分叉**：
 *   · 已经跑过旧版迁移的库不会重跑，于是它的结构与文件里写的**不一致**；
 *   · 新库跑的是改后的版本，于是两个库结构不同 —— 而双方都认为自己是对的。
 * 这类分叉在本地开发时完全看不出来（本地库可以随时重建），到了线上才发现，
 * 而那时只能手工写 SQL 对账。
 *
 * 正确做法：**新增一个迁移目录**，把「修正」写成一次新的迁移。
 *
 * 判定规则（刻意选最简的一条，把误报压到零）：
 *   · `M`（修改）/ `D`（删除）→ **违规**。这正是「改了已应用迁移」的两种情况。
 *   · `A`（新增）→ 放行。新增正是迁移的正常工作方式。
 *   · 用 `--no-renames` 把重命名拆成 A + D，于是重命名会被 D 拦住，无需单独处理 R。
 *
 * 用法：
 *   node scripts/check-migrations-immutable.mjs <基准提交>
 *   MIGRATION_BASE_REF=<基准提交> node scripts/check-migrations-immutable.mjs
 *
 * 退出码：0 = 通过（或明确跳过）；1 = 检测到违规；2 = 命令自身失败。
 * 「跳过」与「通过」是两件事，因此跳过时会**显式打印**原因，不会静默放行。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = 'backend/prisma/migrations';
const HEAD = 'HEAD';

function git(...args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function skip(reason) {
  console.log('⏭  跳过「已应用迁移不可修改」检查');
  console.log(`   原因：${reason}`);
  console.log('   注意：**跳过不等于通过** —— 在 PR 上这条检查会真正执行。');
  process.exit(0);
}

/**
 * 在 CI 里，「拿不到基准提交」是**配置问题**，不是「无需检查」。
 *
 * 这一点很关键：本环境读不到 job 日志，所以「步骤绿了」必须等价于「真的检查过了」。
 * 如果浅克隆导致脚本跳过、步骤照样绿，那这条门禁就是**摆设**，
 * 而且从外部完全看不出来。因此 CI 下跳过直接失败，并在报错里给出修法。
 */
function skipInCi(reason, hint) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error('::error::无法确定基准提交，这条门禁等于没接（而不是「无需检查」）');
    console.error(`::error::原因：${reason}`);
    console.error(`::error::修法：${hint}`);
    process.exit(2);
  }
  skip(reason);
}

const base = (process.argv[2] ?? process.env.MIGRATION_BASE_REF ?? '').trim();

if (!base) {
  skipInCi(
    '未提供基准提交（命令行参数与 MIGRATION_BASE_REF 都为空）',
    'CI 步骤需注入 MIGRATION_BASE_REF（PR 用 base.sha，push 用 event.before）',
  );
}
if (/^0+$/.test(base)) {
  // 唯一**合法**的跳过：分支首次推送时 event.before 是全零 SHA，确实没有可比对的提交
  skip('基准提交是全零 SHA —— 分支首次推送，没有可比对的前一个提交');
}
if (git('cat-file', '-e', `${base}^{commit}`).code !== 0) {
  skipInCi(
    `基准提交 ${base.slice(0, 12)} 在本地不可达（浅克隆？）`,
    '该 job 的 actions/checkout 需要加 `with: fetch-depth: 0`，否则历史里没有基准提交',
  );
}

const diff = git('diff', '--name-status', '--no-renames', base, HEAD, '--', MIGRATIONS_DIR);
if (diff.code !== 0) {
  console.error(`::error::git diff 执行失败（退出码 ${diff.code}）：${diff.err}`);
  process.exit(2);
}

const entries = diff.out
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status: status[0], file: rest.join('\t') };
  });

const added = entries.filter((e) => e.status === 'A');
const violations = entries.filter((e) => e.status !== 'A');

console.log(`已应用迁移不可修改 → 基准 ${base.slice(0, 12)}..${HEAD}`);
console.log(`迁移目录：${MIGRATIONS_DIR}`);
console.log(`变更：新增 ${added.length} 个文件，修改/删除 ${violations.length} 个\n`);

if (added.length) {
  console.log('新增（允许 —— 这正是迁移的工作方式）：');
  for (const e of added) console.log(`  A  ${e.file}`);
  console.log('');
}

if (violations.length === 0) {
  console.log('✅ 未发现对已应用迁移的修改或删除');
  process.exit(0);
}

console.log('❌ 以下已提交的迁移文件被修改或删除：');
for (const e of violations) console.log(`  ${e.status}  ${e.file}`);
console.log('');
console.log('为什么这是问题：迁移一旦被应用过，就已经写进了某些库的 _prisma_migrations 表。');
console.log('改它会让「迁移历史」与「实际库结构」永久分叉 —— 跑过旧版的库不会重跑，');
console.log('于是两个库结构不同，而双方都认为自己是对的。本地重建库看不出这个问题。');
console.log('');
console.log('应该怎么做：**新增一个迁移目录**（`npx prisma migrate dev --name <说明>`），');
console.log('把「修正」写成一次新的迁移，而不是回头改历史。');
if (process.env.GITHUB_ACTIONS === 'true') {
  console.log('::error::检测到已应用迁移被修改或删除，请改为新增迁移');
}
process.exit(1);
