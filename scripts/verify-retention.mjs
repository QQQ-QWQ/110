#!/usr/bin/env node
/**
 * 数据保留清理的**真实数据库**验证（报告 §5.2 S1）
 *
 * 单测用的是 stub，只能证明「过滤条件写对了」；本脚本进一步证明
 * 「真的从 PostgreSQL 里删掉了该删的、留下了不该删的」。
 *
 * 用法：
 *   cd backend && npm run build            # 需要 dist/
 *   node scripts/verify-retention.mjs
 *   DATABASE_URL=... node scripts/verify-retention.mjs
 *
 * 断言矩阵：
 *   ✅ 应删：过期会话、COMPLETED 且超 24h 的幂等记录
 *   ❌ 应留：未过期会话、24h 内的 COMPLETED 记录、**任何 PROCESSING 记录**
 *          （最后一条是幂等机制的关键：删掉会让同一幂等键被重复占坑）
 *
 * 全部通过时退出码 0，并清理自己插入的测试行（可重复执行）。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// 以 backend/ 为锚点解析，保证 @prisma/client 与 dist 都能找到
const backendRequire = createRequire(path.join(here, '..', 'backend', 'package.json'));
const { PrismaClient } = backendRequire('@prisma/client');
const { purgeOnce } = backendRequire('./dist/core/maintenance.service.js');

const HOUR = 60 * 60 * 1000;
const TAG = `retention-verify-${Date.now().toString(36)}`;

const rows = [];
let failures = 0;

function check(name, expected, actual) {
  const ok = expected === actual;
  if (!ok) failures += 1;
  rows.push({ name, expected, actual, ok });
}

const prisma = new PrismaClient();
const now = new Date();
const ago = (ms) => new Date(now.getTime() - ms);
const ahead = (ms) => new Date(now.getTime() + ms);

async function main() {
  const user = await prisma.user.findFirst({ orderBy: { account: 'asc' } });
  if (!user) {
    console.error('✗ 数据库中没有用户，请先执行 seed（node dist/seed.js）');
    process.exit(2);
  }

  console.log(`数据保留清理验证 → ${process.env.DATABASE_URL?.replace(/:[^:@/]*@/, ':***@')}`);
  console.log(`使用账号：${user.account}\n`);

  // ── 插入测试行 ──
  const expiredSession = await prisma.session.create({
    data: { userId: user.id, expiresAt: ago(1 * HOUR) },
  });
  const validSession = await prisma.session.create({
    data: { userId: user.id, expiresAt: ahead(1 * HOUR) },
  });

  const mkIdem = (suffix, status, createdAt) =>
    prisma.idempotencyRecord.create({
      data: {
        userId: user.id,
        operation: 'VERIFY',
        idempotencyKey: `${TAG}-${suffix}`,
        requestHash: `hash-${suffix}`,
        status,
        createdAt,
      },
    });

  const oldCompleted = await mkIdem('old-completed', 'COMPLETED', ago(25 * HOUR));
  const freshCompleted = await mkIdem('fresh-completed', 'COMPLETED', ago(1 * HOUR));
  // ★ 关键样本：超期但仍在 PROCESSING —— 必须存活
  const staleProcessing = await mkIdem('stale-processing', 'PROCESSING', ago(100 * HOUR));

  // ── 执行一次清理 ──
  const result = await purgeOnce(prisma, now);
  console.log(
    `清理结果：幂等记录 ${result.idempotencyDeleted} 条，过期会话 ${result.sessionsDeleted} 条，` +
      `滞留 PROCESSING ${result.staleProcessing} 条（仅告警）\n`,
  );

  // ── 断言 ──
  const exists = {
    expiredSession: (await prisma.session.findUnique({ where: { id: expiredSession.id } })) !== null,
    validSession: (await prisma.session.findUnique({ where: { id: validSession.id } })) !== null,
    oldCompleted:
      (await prisma.idempotencyRecord.findUnique({ where: { id: oldCompleted.id } })) !== null,
    freshCompleted:
      (await prisma.idempotencyRecord.findUnique({ where: { id: freshCompleted.id } })) !== null,
    staleProcessing:
      (await prisma.idempotencyRecord.findUnique({ where: { id: staleProcessing.id } })) !== null,
  };

  check('过期会话 → 已删除', false, exists.expiredSession);
  check('未过期会话 → 保留', true, exists.validSession);
  check('COMPLETED 超 24h → 已删除', false, exists.oldCompleted);
  check('COMPLETED 未超 24h → 保留', true, exists.freshCompleted);
  check('★ PROCESSING 超 100h → 必须保留', true, exists.staleProcessing);

  // ── 报告 ──
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
  console.log(`${pad('断言', 34)}${pad('期望', 8)}实际`);
  console.log(`${'-'.repeat(34)}${'-'.repeat(8)}${'-'.repeat(6)}`);
  for (const r of rows) {
    console.log(`${pad(r.name, 34)}${pad(r.expected, 8)}${r.actual} ${r.ok ? '✓' : '✗'}`);
  }

  // ── 清理自己插入的行（staleProcessing 也一并清掉，避免污染后续运行）──
  await prisma.idempotencyRecord.deleteMany({ where: { idempotencyKey: { startsWith: TAG } } });
  await prisma.session.deleteMany({
    where: { id: { in: [expiredSession.id, validSession.id] } },
  });
  console.log('\n（已清理本次插入的测试行）');

  if (failures === 0) {
    console.log(`\n全部 ${rows.length} 项通过 ✓`);
  } else {
    console.log(`\n存在 ${failures} 项失败，请检查上方 ✗ 行。`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((error) => {
    console.error(`\n✗ 脚本异常终止：${error.stack || error.message}\n`);
    process.exit(2);
  })
  .finally(() => prisma.$disconnect());
