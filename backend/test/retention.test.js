/**
 * 数据保留策略测试 —— 对应代码审查标准 §3.C 第 6 类「数据生命周期」
 *
 * 核心断言：清理任务**只删该删的**。
 *  - 幂等记录：只删 COMPLETED 且已过 24h；**PROCESSING 一律不删**
 *    （删掉会让同一幂等键被重复占坑，幂等语义直接失效）
 *  - 会话：只删已过绝对过期时间的行
 *
 * 另外用「where 子句 vs 判定函数」的一致性矩阵，钉死两套表述不会各自漂移 ——
 * 这类不一致没有任何编译期提示，单测通过而线上删错是完全可能的。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  IDEMPOTENCY_RETENTION_MS,
  idempotencyPurgeCutoff,
  shouldPurgeIdempotencyRecord,
  shouldPurgeSession,
  idempotencyPurgeWhere,
  sessionPurgeWhere,
  staleProcessingWhere,
} = require('../dist/domain/retention.js');
const { purgeOnce } = require('../dist/core/maintenance.service.js');

const NOW = new Date('2026-10-05T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const ago = (ms) => new Date(NOW.getTime() - ms);
const ahead = (ms) => new Date(NOW.getTime() + ms);

// ────────────────────────── 保留时长 ──────────────────────────

test('幂等记录保留时长 = 24 小时', () => {
  assert.equal(IDEMPOTENCY_RETENTION_MS, 24 * HOUR);
  assert.equal(idempotencyPurgeCutoff(NOW).toISOString(), '2026-10-04T12:00:00.000Z');
});

// ──────────────────── 幂等记录：判定函数 ────────────────────

test('COMPLETED 且超过 24h → 清理', () => {
  assert.equal(
    shouldPurgeIdempotencyRecord({ status: 'COMPLETED', createdAt: ago(25 * HOUR) }, NOW),
    true,
  );
});

test('COMPLETED 但未超过 24h → 保留', () => {
  assert.equal(
    shouldPurgeIdempotencyRecord({ status: 'COMPLETED', createdAt: ago(23 * HOUR) }, NOW),
    false,
  );
});

test('COMPLETED 恰好落在截止时刻 → 保留（严格小于，不含边界）', () => {
  assert.equal(
    shouldPurgeIdempotencyRecord({ status: 'COMPLETED', createdAt: ago(24 * HOUR) }, NOW),
    false,
  );
});

test('★ PROCESSING 即使远超 24h 也必须保留（删除会破坏幂等）', () => {
  assert.equal(
    shouldPurgeIdempotencyRecord({ status: 'PROCESSING', createdAt: ago(100 * HOUR) }, NOW),
    false,
  );
});

test('未知状态一律保留（白名单而非黑名单）', () => {
  for (const status of ['PROCESSING', 'FAILED', 'FOO', '']) {
    assert.equal(shouldPurgeIdempotencyRecord({ status, createdAt: ago(999 * HOUR) }, NOW), false);
  }
});

// ────────────────────── 会话：判定函数 ──────────────────────

test('会话已过期 → 清理', () => {
  assert.equal(shouldPurgeSession({ expiresAt: ago(1) }, NOW), true);
});

test('会话恰好到期 → 清理（含边界）', () => {
  assert.equal(shouldPurgeSession({ expiresAt: NOW }, NOW), true);
});

test('会话未过期 → 保留', () => {
  assert.equal(shouldPurgeSession({ expiresAt: ahead(HOUR) }, NOW), false);
});

// ────────────── where 子句 vs 判定函数：一致性矩阵 ──────────────

/** 按本模块实际用到的 where 形状求值（status 等值 + Date 比较） */
function matchesIdempotencyWhere(where, row) {
  if (where.status !== row.status) return false;
  return row.createdAt.getTime() < where.createdAt.lt.getTime();
}
function matchesSessionWhere(where, row) {
  return row.expiresAt.getTime() <= where.expiresAt.lte.getTime();
}

test('★ where 子句与判定函数对所有边界样本给出一致结论（幂等记录）', () => {
  const where = idempotencyPurgeWhere(NOW);
  const samples = [];
  for (const status of ['COMPLETED', 'PROCESSING', 'FAILED']) {
    for (const delta of [-1, 0, 1, 23, 24, 25, 100].map((h) => h * HOUR)) {
      samples.push({ status, createdAt: ago(delta) });
    }
  }
  assert.equal(samples.length, 21);
  for (const row of samples) {
    assert.equal(
      matchesIdempotencyWhere(where, row),
      shouldPurgeIdempotencyRecord(row, NOW),
      `不一致：${row.status} / ${row.createdAt.toISOString()}`,
    );
  }
});

test('★ where 子句与判定函数对所有边界样本给出一致结论（会话）', () => {
  const where = sessionPurgeWhere(NOW);
  const samples = [
    { expiresAt: ago(HOUR) },
    { expiresAt: ago(1) },
    { expiresAt: NOW },
    { expiresAt: ahead(1) },
    { expiresAt: ahead(HOUR) },
  ];
  for (const row of samples) {
    assert.equal(
      matchesSessionWhere(where, row),
      shouldPurgeSession(row, NOW),
      `不一致：${row.expiresAt.toISOString()}`,
    );
  }
});

test('滞留 PROCESSING 的 where 只匹配 PROCESSING，且与截止时刻一致', () => {
  const where = staleProcessingWhere(NOW);
  assert.equal(where.status, 'PROCESSING');
  assert.equal(where.createdAt.lt.toISOString(), idempotencyPurgeCutoff(NOW).toISOString());
});

// ───────────── purgeOnce 是否真的用了这些过滤条件 ─────────────

/** 记录 deleteMany / count 收到的 where，用于验证「服务用的是被测策略」 */
function stubPrisma() {
  const seen = {};
  return {
    seen,
    idempotencyRecord: {
      deleteMany: async ({ where }) => {
        seen.idempotencyWhere = where;
        return { count: 3 };
      },
      count: async ({ where }) => {
        seen.staleWhere = where;
        return 1;
      },
    },
    session: {
      deleteMany: async ({ where }) => {
        seen.sessionWhere = where;
        return { count: 2 };
      },
    },
  };
}

test('purgeOnce 使用与策略一致的过滤条件，并原样回报删除条数', async () => {
  const prisma = stubPrisma();
  const result = await purgeOnce(prisma, NOW);

  assert.deepEqual(prisma.seen.idempotencyWhere, idempotencyPurgeWhere(NOW));
  assert.deepEqual(prisma.seen.sessionWhere, sessionPurgeWhere(NOW));
  assert.deepEqual(prisma.seen.staleWhere, staleProcessingWhere(NOW));

  assert.deepEqual(result, { idempotencyDeleted: 3, sessionsDeleted: 2, staleProcessing: 1 });
});

test('purgeOnce 可重复执行（幂等）：连跑两次结果一致，且不因第二次为 0 而报错', async () => {
  const prisma = stubPrisma();
  const first = await purgeOnce(prisma, NOW);
  prisma.idempotencyRecord.deleteMany = async () => ({ count: 0 });
  prisma.session.deleteMany = async () => ({ count: 0 });
  prisma.idempotencyRecord.count = async () => 0;
  const second = await purgeOnce(prisma, NOW);
  assert.equal(first.idempotencyDeleted, 3);
  assert.deepEqual(second, { idempotencyDeleted: 0, sessionsDeleted: 0, staleProcessing: 0 });
});
