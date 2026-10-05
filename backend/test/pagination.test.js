/**
 * 游标分页测试 —— 对应代码审查标准 §3.C 第 5 类「边界与分页」
 *
 * 分页最容易出的错不是「少一页」，而是**翻页时重复或漏行**：
 *  · 只按 createdAt 排序 → 同一毫秒创建的多行顺序不稳定；
 *  · 决胜键方向写反（`id < cursor.id` 写成 `>`）→ 第二页起直接错位。
 * 这两种错误在数据量小时完全看不出来，因此必须用「模拟翻页」把它钉死。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_SEQ_PAGE_SIZE,
  MAX_SEQ_PAGE_SIZE,
  normalizeLimit,
  encodeCursor,
  decodeCursor,
  buildPageInfo,
  encodeSeqCursor,
  decodeSeqCursor,
  buildSeqPageInfo,
} = require('../dist/domain/pagination.js');
const { AppError } = require('../dist/core/errors.js');

const statusOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.status : `非 AppError: ${e.constructor.name}`;
  }
  return '未抛出';
};

// ────────────────────────── limit 归一化 ──────────────────────────

test('未传 limit → 使用默认每页条数', () => {
  for (const raw of [undefined, null, '']) {
    assert.equal(normalizeLimit(raw), DEFAULT_PAGE_SIZE);
  }
});

test('合法 limit 原样接受（字符串与数字皆可）', () => {
  assert.equal(normalizeLimit('5'), 5);
  assert.equal(normalizeLimit(5), 5);
  assert.equal(normalizeLimit(' 7 '), 7);
  assert.equal(normalizeLimit(MAX_PAGE_SIZE), MAX_PAGE_SIZE);
});

test('超过上限 → 收敛到上限（而不是报错，避免打断调用方）', () => {
  assert.equal(normalizeLimit('100000'), MAX_PAGE_SIZE);
  assert.equal(normalizeLimit(MAX_PAGE_SIZE + 1), MAX_PAGE_SIZE);
});

test('非法 limit → 422（0 / 负数 / 小数 / 非数字）', () => {
  for (const raw of ['0', '-1', '1.5', 'abc', 'NaN', 'Infinity']) {
    assert.equal(
      statusOf(() => normalizeLimit(raw)),
      422,
      `未拒绝：${raw}`,
    );
  }
});

// ────────────────────────── 游标编解码 ──────────────────────────

test('游标编解码可往返，且对客户端不透明（不是明文 JSON）', () => {
  const createdAt = new Date('2026-10-05T12:00:00.000Z');
  const id = '00000000-0000-4000-8000-000000000001';
  const raw = encodeCursor(createdAt, id);

  assert.equal(typeof raw, 'string');
  assert.ok(!raw.includes('2026'), '游标不应暴露明文时间');
  assert.ok(!raw.includes(id), '游标不应暴露明文 id');

  const decoded = decodeCursor(raw);
  assert.equal(decoded.createdAt.toISOString(), createdAt.toISOString());
  assert.equal(decoded.id, id);
});

test('畸形游标一律 422（而非 500）—— 游标属于请求参数', () => {
  const bad = [
    '',
    'not-base64',
    Buffer.from('not json').toString('base64url'),
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({ t: '2026-10-05T12:00:00.000Z' })).toString('base64url'),
    Buffer.from(JSON.stringify({ i: 'x' })).toString('base64url'),
    Buffer.from(JSON.stringify({ t: '不是日期', i: 'x' })).toString('base64url'),
    Buffer.from(JSON.stringify({ t: '2026-10-05T12:00:00.000Z', i: '不是-uuid' })).toString(
      'base64url',
    ),
    Buffer.from(JSON.stringify({ t: 123, i: 'x' })).toString('base64url'),
  ];
  for (const raw of bad) {
    assert.equal(
      statusOf(() => decodeCursor(raw)),
      422,
      `未拒绝：${raw}`,
    );
  }
});

// ────────────────────────── pageInfo ──────────────────────────

test('还有下一页 → nextCursor 指向本页最后一行', () => {
  const last = {
    createdAt: new Date('2026-10-05T12:00:00.000Z'),
    id: 'a0000000-0000-4000-8000-000000000009',
  };
  const info = buildPageInfo(20, true, last);
  assert.equal(info.limit, 20);
  assert.equal(info.hasMore, true);
  assert.deepEqual(decodeCursor(info.nextCursor), { createdAt: last.createdAt, id: last.id });
});

test('没有下一页 → nextCursor 为 null（客户端无需自己判断边界）', () => {
  assert.equal(buildPageInfo(20, false, undefined).nextCursor, null);
  assert.equal(
    buildPageInfo(20, false, { createdAt: new Date(), id: 'a0000000-0000-4000-8000-000000000001' })
      .nextCursor,
    null,
  );
});

// ───────────────── 模拟翻页：不重复、不遗漏 ─────────────────

/**
 * 复刻 service 中的键集条件与排序，用于离线验证分页语义。
 * 条件必须与 requirements.service.ts 中 `if (cursor)` 分支逐字对应：
 *   OR: [ { createdAt: { lt } }, { createdAt: equal, id: { lt } } ]
 * 排序：orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
 */
function keysetSelect(rows, cursor) {
  return rows.filter(
    (r) =>
      r.createdAt.getTime() < cursor.createdAt.getTime() ||
      (r.createdAt.getTime() === cursor.createdAt.getTime() && r.id < cursor.id),
  );
}

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const d = b.createdAt.getTime() - a.createdAt.getTime();
    if (d !== 0) return d;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; // id desc
  });
}

/** 刻意制造大量 createdAt 相同（同一毫秒）的行，逼出决胜键问题 */
function makeRows() {
  const base = new Date('2026-10-05T12:00:00.000Z').getTime();
  const rows = [];
  for (let i = 0; i < 25; i += 1) {
    // 每 5 行共用同一个毫秒 —— 顺序完全依赖 id 决胜键
    const createdAt = new Date(base - Math.floor(i / 5) * 1000);
    const id = `a0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    rows.push({ key: `row-${i}`, createdAt, id });
  }
  return rows;
}

function pageThrough(allRows, limit) {
  const ordered = sortRows(allRows);
  const seen = [];
  let remaining = ordered;
  let cursor = null;
  let pages = 0;

  for (;;) {
    const candidates = cursor ? keysetSelect(remaining, cursor) : remaining;
    const pageRows = candidates.slice(0, limit);
    const hasMore = candidates.length > limit;
    const lastRow = pageRows[pageRows.length - 1];
    const info = buildPageInfo(limit, hasMore, lastRow);

    seen.push(...pageRows.map((r) => r.key));
    pages += 1;
    if (pages > 100) throw new Error('翻页未终止（nextCursor 逻辑有误）');
    if (!info.hasMore) break;

    cursor = decodeCursor(info.nextCursor);
    remaining = candidates;
  }

  return { seen, pages, ordered };
}

test('★ 模拟翻页：25 行（大量同毫秒）逐页取完，不重复、不遗漏、顺序正确', () => {
  const all = makeRows();
  const { seen, pages, ordered } = pageThrough(all, 3);

  assert.equal(seen.length, all.length, '总行数不符 —— 存在重复或遗漏');
  assert.equal(new Set(seen).size, all.length, '出现重复行');
  assert.deepEqual(
    seen,
    ordered.map((r) => r.key),
    '顺序与全量排序不一致',
  );
  assert.equal(pages, 9, '页数应为 ceil(25/3) = 9');
});

test('★ 每页恰好取满时不应多出空页（25 行 / limit=5 → 5 页且无空尾页）', () => {
  const all = makeRows();
  const { seen, pages } = pageThrough(all, 5);
  assert.equal(seen.length, 25);
  assert.equal(pages, 5);
});

test('★ 决胜键方向若写反，模拟翻页会立刻暴露（反向验证测试本身有效）', () => {
  const all = makeRows();
  const ordered = sortRows(all);
  // 故意写反：id > cursor.id
  const wrong = ordered.filter(
    (r) =>
      r.createdAt.getTime() < ordered[2].createdAt.getTime() ||
      (r.createdAt.getTime() === ordered[2].createdAt.getTime() && r.id > ordered[2].id),
  );
  const correct = keysetSelect(ordered, ordered[2]);
  assert.notDeepEqual(
    wrong.map((r) => r.key),
    correct.map((r) => r.key),
    '若方向写反却得到相同结果，说明样本没有覆盖同毫秒分支，测试无效',
  );
});

test('空结果集：首页即为末页，nextCursor 为 null', () => {
  const info = buildPageInfo(20, false, undefined);
  assert.deepEqual(info, { limit: 20, hasMore: false, nextCursor: null });
});

// ─────────────────────────────────────────────────────────────
// 事件时间线的 `seq` 游标（报告 §5.1 E2）
//
// `seq` 在单个需求内单调递增，因此是比 `(createdAt, id)` 更合适的游标：
// 单调整数天然有序，不存在「同一毫秒」的稳定性问题。
// 但仍然做 base64url 编码（对客户端不透明），理由与列表游标一致。
// ─────────────────────────────────────────────────────────────

test('seq 游标可往返，且对客户端不透明（不是明文 JSON）', () => {
  for (const seq of [0, 1, 7, 12345, Number.MAX_SAFE_INTEGER]) {
    const encoded = encodeSeqCursor(seq);
    assert.equal(decodeSeqCursor(encoded), seq);
    assert.equal(encoded.includes('{'), false, '不应是明文 JSON');
    assert.equal(/^\d+$/.test(encoded), false, '不应是明文数字');
  }
});

test('seq 游标：畸形输入一律 422（而非 500）—— 游标属于请求参数', () => {
  const malformed = [
    'not-base64!!',
    Buffer.from('not json', 'utf8').toString('base64url'),
    Buffer.from('null', 'utf8').toString('base64url'),
    Buffer.from('[]', 'utf8').toString('base64url'),
    Buffer.from('"7"', 'utf8').toString('base64url'),
    Buffer.from('{}', 'utf8').toString('base64url'),
    Buffer.from('{"s":"7"}', 'utf8').toString('base64url'), // 字符串而非数字
    Buffer.from('{"s":-1}', 'utf8').toString('base64url'), // 负数
    Buffer.from('{"s":1.5}', 'utf8').toString('base64url'), // 小数
    Buffer.from('{"s":null}', 'utf8').toString('base64url'),
    Buffer.from('{"x":7}', 'utf8').toString('base64url'), // 字段名不对
  ];
  for (const raw of malformed) {
    assert.equal(
      statusOf(() => decodeSeqCursor(raw)),
      422,
      `应 422：${raw}`,
    );
  }
});

test('★ seq 游标与列表游标不通用（两种游标不能混用）', () => {
  // 两类游标编码的是不同结构。混用必须报 422，而不是静默把 createdAt
  // 当成 seq 用 —— 那会让分页悄悄错位。
  const listCursor = encodeCursor(
    new Date('2026-01-01T00:00:00.000Z'),
    'a'.repeat(8) + '-0000-4000-8000-000000000000',
  );
  assert.equal(
    statusOf(() => decodeSeqCursor(listCursor)),
    422,
  );

  const seqCursor = encodeSeqCursor(7);
  assert.equal(
    statusOf(() => decodeCursor(seqCursor)),
    422,
  );
});

test('buildSeqPageInfo：有下一页时游标指向本页最后一条的 seq', () => {
  assert.deepEqual(buildSeqPageInfo(50, true, 137), {
    limit: 50,
    hasMore: true,
    nextCursor: encodeSeqCursor(137),
  });
});

test('buildSeqPageInfo：没有下一页时 nextCursor 为 null（客户端无需自己判断边界）', () => {
  assert.deepEqual(buildSeqPageInfo(50, false, 137), {
    limit: 50,
    hasMore: false,
    nextCursor: null,
  });
  // 空页且 hasMore=false 时 lastSeq 为 undefined，同样不应炸
  assert.deepEqual(buildSeqPageInfo(50, false, undefined), {
    limit: 50,
    hasMore: false,
    nextCursor: null,
  });
});

test('★ 模拟时间线翻页：seq 升序逐页取完，不重复、不遗漏、顺序正确', () => {
  const all = Array.from({ length: 23 }, (_, i) => i + 1); // seq 1..23
  const limit = 5;

  const seen = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const page =
      cursor === null ? all.slice(0, limit) : all.filter((s) => s > cursor).slice(0, limit);
    const hasMore = all.filter((s) => (cursor === null ? true : s > cursor)).length > limit;
    seen.push(...page);
    pages += 1;
    if (!hasMore) break;
    cursor = page[page.length - 1];
    assert.ok(pages < 20, '不应无限翻页');
  }

  assert.deepEqual(seen, all, '逐页取完应与全量一致（不重复、不遗漏、顺序正确）');
  assert.equal(pages, 5, '23 条 / 每页 5 条 → 5 页（末页 3 条）');
});

test('normalizeLimit 可覆盖默认值与上限（时间线页比需求列表大）', () => {
  // 默认：需求列表 20 / 上限 100
  assert.equal(normalizeLimit(undefined), DEFAULT_PAGE_SIZE);
  assert.equal(normalizeLimit(99999), MAX_PAGE_SIZE);
  // 覆盖：时间线 50 / 上限 200
  assert.equal(normalizeLimit(undefined, DEFAULT_SEQ_PAGE_SIZE, MAX_SEQ_PAGE_SIZE), 50);
  assert.equal(normalizeLimit(99999, DEFAULT_SEQ_PAGE_SIZE, MAX_SEQ_PAGE_SIZE), 200);
  // 校验语义与列表完全一致：非法值仍然 422，而不是被 fallback 悄悄兜住
  assert.equal(
    statusOf(() => normalizeLimit('0', DEFAULT_SEQ_PAGE_SIZE, MAX_SEQ_PAGE_SIZE)),
    422,
  );
  assert.equal(
    statusOf(() => normalizeLimit('abc', DEFAULT_SEQ_PAGE_SIZE, MAX_SEQ_PAGE_SIZE)),
    422,
  );
});
