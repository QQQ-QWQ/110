/**
 * 核心工具测试 —— 幂等指纹与请求头解析
 *
 * 幂等指纹是「同一请求只生效一次」的地基：若同一内容算不出同一指纹，
 * 重复提交会被误判为「同键不同内容」而拒绝；若不同内容算出同一指纹，
 * 则会串数据。因此这里必须覆盖稳定性与区分度两侧。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalJson, sha256Hex, requestHashOf } = require('../dist/core/canonical-json.js');
const { parseVersionHeader, idempotencyKeyOf } = require('../dist/core/http.js');

// ────────────────────────────── canonical JSON ──────────────────────────────

test('canonicalJson：对象键排序，键顺序不影响结果', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), '{"a":1,"b":2}');
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
});

test('canonicalJson：嵌套对象同样排序', () => {
  const x = canonicalJson({ outer: { z: 1, a: { m: 1, b: 2 } }, list: [1, 2] });
  const y = canonicalJson({ list: [1, 2], outer: { a: { b: 2, m: 1 }, z: 1 } });
  assert.equal(x, y);
});

test('canonicalJson：数组保持原有顺序（顺序是语义的一部分）', () => {
  assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
  assert.equal(canonicalJson([1, 2, 3]), '[1,2,3]');
});

test('canonicalJson：undefined 被丢弃，null 被保留', () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalJson({ a: 1, b: null }), '{"a":1,"b":null}');
});

test('sha256Hex：与标准测试向量一致', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

// ────────────────────────────── 请求指纹 ──────────────────────────────

test('requestHashOf：同一内容（键顺序不同）得到同一指纹', () => {
  const h1 = requestHashOf('SUBMIT', 'req-1', { note: '说明', artifacts: ['https://a.com'] });
  const h2 = requestHashOf('SUBMIT', 'req-1', { artifacts: ['https://a.com'], note: '说明' });
  assert.equal(h1, h2, '键顺序不同不应产生不同指纹，否则重复提交会被误拒');
});

test('requestHashOf：内容不同则指纹不同', () => {
  const base = requestHashOf('SUBMIT', 'req-1', { note: 'A' });
  assert.notEqual(base, requestHashOf('SUBMIT', 'req-1', { note: 'B' }), '载荷不同');
  assert.notEqual(base, requestHashOf('EDIT', 'req-1', { note: 'A' }), '命令不同');
  assert.notEqual(base, requestHashOf('SUBMIT', 'req-2', { note: 'A' }), '需求不同');
  assert.notEqual(base, requestHashOf('SUBMIT', null, { note: 'A' }), 'null 与具体 id 不同');
  assert.notEqual(
    base,
    requestHashOf('SUBMIT', 'req-1', { note: 'A', extra: 1 }),
    '多一个字段即不同',
  );
});

test('requestHashOf：数组顺序敏感，能区分不同顺序的成果链接', () => {
  const a = requestHashOf('SUBMIT', 'r', { artifacts: ['https://a.com', 'https://b.com'] });
  const b = requestHashOf('SUBMIT', 'r', { artifacts: ['https://b.com', 'https://a.com'] });
  assert.notEqual(a, b);
});

test('requestHashOf：输出为 64 位十六进制', () => {
  const h = requestHashOf('CREATE', null, { title: 'x' });
  assert.match(h, /^[a-f0-9]{64}$/);
});

// ────────────────────────────── If-Match 解析 ──────────────────────────────

test('parseVersionHeader：接受裸数字、带引号、弱校验前缀', () => {
  assert.equal(parseVersionHeader('12'), 12);
  assert.equal(parseVersionHeader('"12"'), 12);
  assert.equal(parseVersionHeader('W/"12"'), 12);
  assert.equal(parseVersionHeader('w/12'), 12);
  assert.equal(parseVersionHeader(' 12 '), 12);
});

test('parseVersionHeader：无法解析时返回 undefined（表示不做版本校验）', () => {
  assert.equal(parseVersionHeader(undefined), undefined);
  assert.equal(parseVersionHeader(''), undefined);
  assert.equal(parseVersionHeader('*'), undefined);
  assert.equal(parseVersionHeader('abc'), undefined);
  assert.equal(parseVersionHeader('0'), undefined, '版本号从 1 起，0 视为无效');
  assert.equal(parseVersionHeader('-1'), undefined);
});

// ────────────────────────────── 幂等键解析 ──────────────────────────────

test('idempotencyKeyOf：去除空白，空值视为未提供', () => {
  assert.equal(idempotencyKeyOf(' abc '), 'abc');
  assert.equal(idempotencyKeyOf('key-123'), 'key-123');
  assert.equal(idempotencyKeyOf(''), undefined);
  assert.equal(idempotencyKeyOf('   '), undefined);
  assert.equal(idempotencyKeyOf(undefined), undefined);
});
