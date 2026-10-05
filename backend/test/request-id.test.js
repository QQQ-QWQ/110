/**
 * 请求编号测试 —— 报告 §5.2 S5
 *
 * 分两层：
 *  A. 纯逻辑：`isSafeRequestId` / `resolveRequestId` —— 决定「沿用入参还是新生成」。
 *     这里最容易被忽略的是**校验**：编号会被写进日志行与响应头，不做限制就等于
 *     开放了日志注入（换行伪造日志条目）与超长串撑爆日志两个口子。
 *  B. 异常过滤器：编号必须真的出现在 5xx 的响应体与日志里，而 4xx 不该带它 ——
 *     否则「用户能报出编号」这个目的根本没达成。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUEST_ID_MAX_LENGTH,
  isSafeRequestId,
  resolveRequestId,
} = require('../dist/core/request-id.js');
const { AllExceptionsFilter } = require('../dist/core/exception.filter.js');
const { Errors, AppError } = require('../dist/core/errors.js');

// ─────────────────────────────────────────────────────────────
// A. 纯逻辑
// ─────────────────────────────────────────────────────────────

test('isSafeRequestId：接受常见的标识符形态', () => {
  for (const ok of [
    'abc',
    'A1',
    '3f8a2c10-9b7e-4d1f-8c33-1a2b3c4d5e6f', // UUID
    '01H8XGJWBWBAQ4PLZ3ZKQ2F3XK', // ULID
    'svc.a:1234-5678_x',
    'a'.repeat(REQUEST_ID_MAX_LENGTH),
  ]) {
    assert.equal(isSafeRequestId(ok), true, `应接受：${ok}`);
  }
});

test('isSafeRequestId：拒绝空值与非字符串', () => {
  for (const bad of [undefined, null, '', 0, 123, {}, [], true]) {
    assert.equal(isSafeRequestId(bad), false, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('★ isSafeRequestId：拒绝换行与控制字符（日志注入）', () => {
  // 若放行，攻击者可以构造 `X-Request-Id: ok\n2026-01-01 ERROR 伪造的日志行`
  // 往日志里插入伪造条目 —— 排查时会被彻底带偏。
  for (const bad of [
    'ok\nfake',
    'ok\r\nfake',
    'ok\rfake',
    'ok\tfake',
    'ok fake', // 空格也会破坏「一行一条日志」的可解析性
    'ok\u0000fake',
    'ok\u001bfake',
  ]) {
    assert.equal(isSafeRequestId(bad), false, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('isSafeRequestId：拒绝超长与非 ASCII', () => {
  assert.equal(isSafeRequestId('a'.repeat(REQUEST_ID_MAX_LENGTH + 1)), false);
  assert.equal(isSafeRequestId('请求编号'), false);
  assert.equal(isSafeRequestId('ok\u00a0x'), false); // 不间断空格
});

test('resolveRequestId：合法入参被原样沿用（透传，便于跨层串联）', () => {
  const gen = () => {
    throw new Error('不应走到生成分支');
  };
  assert.equal(resolveRequestId('trace-abc:1', gen), 'trace-abc:1');
});

test('★ resolveRequestId：非法入参一律丢弃并重新生成', () => {
  let calls = 0;
  const gen = () => {
    calls += 1;
    return `generated-${calls}`;
  };

  assert.equal(resolveRequestId(undefined, gen), 'generated-1');
  assert.equal(resolveRequestId('', gen), 'generated-2');
  assert.equal(resolveRequestId('ok\nfake', gen), 'generated-3');
  assert.equal(resolveRequestId('a'.repeat(500), gen), 'generated-4');
  assert.equal(calls, 4);
});

test('resolveRequestId：同名重复请求头取第一个（与网关行为一致）', () => {
  const gen = () => 'generated';
  assert.equal(resolveRequestId(['first', 'second'], gen), 'first');
  // 数组首个元素非法时，同样要重新生成，而不是回退到第二个
  assert.equal(resolveRequestId(['bad\nid', 'good'], gen), 'generated');
});

test('resolveRequestId：默认生成器产出的是安全值', () => {
  // 不用固定 generator，验证真实实现产出的 id 自身能通过校验（自洽性）
  const id = resolveRequestId(undefined);
  assert.equal(isSafeRequestId(id), true, `默认生成的 id 必须安全，实际：${id}`);
  assert.notEqual(resolveRequestId(undefined), id, '两次生成不应相同');
});

// ─────────────────────────────────────────────────────────────
// B. 异常过滤器：编号要真的被回传
// ─────────────────────────────────────────────────────────────

function makeHost({ locals = {}, method = 'GET', url = '/api/x' } = {}) {
  const res = {
    statusCode: 0,
    body: undefined,
    locals,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  const req = { method, originalUrl: url };
  return {
    res,
    host: { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) },
  };
}

test('★ 异常过滤器：5xx 响应体带上 requestId（用户才能报出编号）', () => {
  const filter = new AllExceptionsFilter();
  const { host, res } = makeHost({ locals: { requestId: 'rid-123' } });

  filter.catch(new Error('数据库连接断了'), host);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.code, 'INTERNAL_ERROR');
  assert.equal(res.body.error.requestId, 'rid-123');
  // 对外不能泄露内部细节
  assert.equal(/数据库连接断了/.test(JSON.stringify(res.body)), false);
});

test('★ 异常过滤器：4xx 不带 requestId（不无谓扩大响应契约）', () => {
  const filter = new AllExceptionsFilter();
  for (const [err, expectedStatus] of [
    [Errors.notFound(), 404],
    [Errors.forbidden(), 403],
    [Errors.stale(), 412],
    [Errors.stateConflict(), 409],
    [Errors.validation('标题不能为空'), 422],
  ]) {
    const { host, res } = makeHost({ locals: { requestId: 'rid-123' } });
    filter.catch(err, host);
    assert.equal(res.statusCode, expectedStatus);
    assert.equal('requestId' in res.body.error, false, `${expectedStatus} 不应带 requestId`);
  }
});

test('异常过滤器：缺少 requestId 时不产出该字段，也不报错', () => {
  const filter = new AllExceptionsFilter();
  const { host, res } = makeHost({ locals: {} });

  filter.catch(new Error('boom'), host);

  assert.equal(res.statusCode, 500);
  assert.equal('requestId' in res.body.error, false);
});

test('异常过滤器：AppError 的 details 仍按原样回传（未被本次改动影响）', () => {
  const filter = new AllExceptionsFilter();
  const { host, res } = makeHost({ locals: { requestId: 'rid-1' } });

  filter.catch(new AppError('VALIDATION_FAILED', '字段不合法', 422, { field: 'title' }), host);

  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body.error.details, { field: 'title' });
  assert.equal(res.body.error.requestId, undefined);
});
