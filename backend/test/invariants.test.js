/**
 * 业务不变量测试 —— 对应代码审查标准 §3.G 第 3 类「不变量」
 *
 * 覆盖：长度按 Unicode code points 计数、URL 双层校验一致、
 *       退回必填原因、未全通过不得确认完成、负责人不得等于提出者。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LIMITS,
  countCodePoints,
  assertNonBlank,
  assertCodePointLength,
  assertHttpUrl,
  assertCriteria,
  assertArtifacts,
  assertReturnReason,
  assertAllChecksPassed,
  assertAssigneeDiffers,
  assertNote,
} = require('../dist/domain/invariants.js');

const statusOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.status;
  }
  return 'no-throw';
};

// ────────────────────────────── 长度计数 ──────────────────────────────

test('countCodePoints：按 Unicode code points 计数，而非 UTF-16 code units', () => {
  assert.equal(countCodePoints('abc'), 3);
  assert.equal(countCodePoints('中文'), 2);
  assert.equal(countCodePoints(''), 0);

  // 关键：emoji 在 String.length 下算 2，在 code points 下算 1
  assert.equal('🎉'.length, 2, '前提：emoji 的 UTF-16 长度确实是 2');
  assert.equal(countCodePoints('🎉'), 1, 'code points 应算 1');
  assert.equal(countCodePoints('🎉🎉'), 2);
});

test('长度上限按 code points 判定，emoji 不会被误判超限', () => {
  // 200 个 emoji：UTF-16 length 是 400，但 code points 是 200 → 应通过
  assert.equal(
    statusOf(() => assertCodePointLength('🎉'.repeat(200), 200, '标题')),
    'no-throw',
  );
  // 201 个 → 应拒绝
  assert.equal(
    statusOf(() => assertCodePointLength('🎉'.repeat(201), 200, '标题')),
    422,
  );
  // 边界：恰好等于上限
  assert.equal(
    statusOf(() => assertCodePointLength('a'.repeat(200), 200, '标题')),
    'no-throw',
  );
  assert.equal(
    statusOf(() => assertCodePointLength('a'.repeat(201), 200, '标题')),
    422,
  );
});

test('assertNonBlank：仅空白视为空', () => {
  assert.equal(
    statusOf(() => assertNonBlank('', '标题')),
    422,
  );
  assert.equal(
    statusOf(() => assertNonBlank('   ', '标题')),
    422,
  );
  assert.equal(
    statusOf(() => assertNonBlank('\t\n', '标题')),
    422,
  );
  assert.equal(
    statusOf(() => assertNonBlank('x', '标题')),
    'no-throw',
  );
});

// ────────────────────────────── 成果链接 ──────────────────────────────

test('assertHttpUrl：接受合法 http/https 链接', () => {
  assert.equal(assertHttpUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(assertHttpUrl('http://example.com'), 'http://example.com');
  assert.equal(
    assertHttpUrl('https://example.com/a/b?c=1&d=2#e'),
    'https://example.com/a/b?c=1&d=2#e',
  );
  // 中文路径允许（UTF-8 百分号编码由浏览器/服务端处理，本层只校验结构）
  assert.equal(
    statusOf(() => assertHttpUrl('https://example.com/正常路径')),
    'no-throw',
  );
});

test('assertHttpUrl：两端空白被 trim', () => {
  assert.equal(assertHttpUrl('  https://example.com  '), 'https://example.com');
});

test('assertHttpUrl：拒绝非 http(s) 协议', () => {
  assert.equal(
    statusOf(() => assertHttpUrl('ftp://example.com')),
    422,
  );
  assert.equal(
    statusOf(() => assertHttpUrl('file:///etc/passwd')),
    422,
  );
  assert.equal(
    statusOf(() => assertHttpUrl('javascript:alert(1)')),
    422,
  );
  assert.equal(
    statusOf(() => assertHttpUrl('data:text/html,<script>')),
    422,
  );
});

test('assertHttpUrl：拒绝无法解析或缺少主机名', () => {
  assert.equal(
    statusOf(() => assertHttpUrl('not a url')),
    422,
  );
  assert.equal(
    statusOf(() => assertHttpUrl('https://')),
    422,
  );
  assert.equal(
    statusOf(() => assertHttpUrl('')),
    422,
  );
  assert.equal(
    statusOf(() => assertHttpUrl('   ')),
    422,
  );
});

test('assertHttpUrl：拒绝含空白字符的链接 —— 与数据库 CHECK 判定一致（审查 R-07）', () => {
  // 修复前：new URL('https://example.com/a b') 会成功，导致含空格链接通过应用层，
  // 却在数据库被 CHECK '^https?://[^[:space:]]+$' 拒绝 → 500 而非 422。
  assert.equal(
    statusOf(() => assertHttpUrl('https://example.com/a b')),
    422,
  );
  assert.equal(
    statusOf(() => assertHttpUrl('https://example.com/a\tb')),
    422,
  );
  assert.equal(
    statusOf(() => assertHttpUrl('https://example.com/x?q=1 2')),
    422,
  );
  assert.equal(
    statusOf(() => assertHttpUrl('https://example.com/a\nb')),
    422,
  );

  // 反向确认：所有被接受的结果都不含空白，因此一定能通过数据库 CHECK
  const accepted = ['https://example.com/x', 'http://example.com', 'https://example.com/a/b?c=1'];
  for (const url of accepted) {
    assert.ok(!/\s/.test(assertHttpUrl(url)), `${url} 不应含空白`);
  }
});

test('assertHttpUrl：超长链接被拒', () => {
  const long = 'https://example.com/' + 'a'.repeat(LIMITS.URL_MAX);
  assert.equal(
    statusOf(() => assertHttpUrl(long)),
    422,
  );
});

// ────────────────────────────── 验收条件 ──────────────────────────────

test('assertCriteria：至少 1 条，空白条目被丢弃', () => {
  assert.equal(
    statusOf(() => assertCriteria([])),
    422,
  );
  assert.equal(
    statusOf(() => assertCriteria(['   '])),
    422,
  );
  assert.equal(
    statusOf(() => assertCriteria(['', '  ', '\t'])),
    422,
  );
  assert.deepEqual(assertCriteria(['a']), ['a']);
  assert.deepEqual(assertCriteria([' a ', '', ' b ']), ['a', 'b']);
});

test('assertCriteria：上限 50 条，边界精确', () => {
  assert.equal(assertCriteria(Array.from({ length: 50 }, (_, i) => `条件${i}`)).length, 50);
  assert.equal(
    statusOf(() => assertCriteria(Array.from({ length: 51 }, (_, i) => `条件${i}`))),
    422,
  );
});

test('assertCriteria：单条超 500 code points 被拒', () => {
  assert.equal(
    statusOf(() => assertCriteria(['a'.repeat(LIMITS.CRITERION_TEXT_MAX)])),
    'no-throw',
  );
  assert.equal(
    statusOf(() => assertCriteria(['a'.repeat(LIMITS.CRITERION_TEXT_MAX + 1)])),
    422,
  );
});

// ────────────────────────────── 成果链接集合 ──────────────────────────────

test('assertArtifacts：至少 1 个、最多 20 个', () => {
  assert.equal(
    statusOf(() => assertArtifacts([])),
    422,
  );
  assert.equal(
    statusOf(() => assertArtifacts(['  '])),
    422,
  );
  assert.deepEqual(assertArtifacts(['https://a.com']), ['https://a.com']);
  assert.equal(
    assertArtifacts(Array.from({ length: 20 }, (_, i) => `https://a.com/${i}`)).length,
    20,
  );
  assert.equal(
    statusOf(() => assertArtifacts(Array.from({ length: 21 }, (_, i) => `https://a.com/${i}`))),
    422,
  );
});

test('assertArtifacts：逐个校验链接合法性', () => {
  assert.equal(
    statusOf(() => assertArtifacts(['https://ok.com', 'ftp://bad.com'])),
    422,
  );
  assert.equal(
    statusOf(() => assertArtifacts(['javascript:alert(1)'])),
    422,
  );
});

// ────────────────────────────── 退回与完成 ──────────────────────────────

test('assertReturnReason：退回必须填写具体原因', () => {
  assert.equal(
    statusOf(() => assertReturnReason(undefined)),
    422,
  );
  assert.equal(
    statusOf(() => assertReturnReason(null)),
    422,
  );
  assert.equal(
    statusOf(() => assertReturnReason('')),
    422,
  );
  assert.equal(
    statusOf(() => assertReturnReason('   ')),
    422,
  );
  assert.equal(assertReturnReason('  条件二未满足，请修复  '), '条件二未满足，请修复');
  assert.equal(
    statusOf(() => assertReturnReason('a'.repeat(LIMITS.REASON_MAX + 1))),
    422,
  );
});

test('assertAllChecksPassed：存在未通过项时不得确认完成', () => {
  assert.equal(
    statusOf(() => assertAllChecksPassed([])),
    422,
    '空结果应被拒',
  );
  assert.equal(
    statusOf(() => assertAllChecksPassed([true, false])),
    422,
    '有未通过项应被拒',
  );
  assert.equal(
    statusOf(() => assertAllChecksPassed([false, true, true])),
    422,
  );
  assert.equal(
    statusOf(() => assertAllChecksPassed([true, true, false])),
    422,
  );
  assert.equal(
    statusOf(() => assertAllChecksPassed([true, true, true])),
    'no-throw',
    '全通过应放行',
  );
});

// ────────────────────────────── 其它 ──────────────────────────────

test('assertAssigneeDiffers：负责人不得等于提出者', () => {
  assert.equal(
    statusOf(() => assertAssigneeDiffers('A', 'A')),
    422,
  );
  assert.equal(
    statusOf(() => assertAssigneeDiffers('A', '')),
    422,
  );
  assert.equal(
    statusOf(() => assertAssigneeDiffers('A', undefined)),
    422,
  );
  assert.equal(
    statusOf(() => assertAssigneeDiffers('A', 'B')),
    'no-throw',
  );
});

test('assertNote：完成说明非空且有长度上限', () => {
  assert.equal(
    statusOf(() => assertNote('')),
    422,
  );
  assert.equal(
    statusOf(() => assertNote('   ')),
    422,
  );
  assert.equal(assertNote('  已实现  '), '已实现');
  assert.equal(
    statusOf(() => assertNote('a'.repeat(LIMITS.NOTE_MAX + 1))),
    422,
  );
});
