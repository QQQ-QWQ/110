import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, isRefreshable, newIdempotencyKey } from './api';

/** 构造一个 fetch 桩，返回指定状态码与响应体 */
function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────
// isRefreshable —— 代码审查 R-03 修正后的判定
// ─────────────────────────────────────────────────────────────

describe('isRefreshable：只在「页面数据已陈旧」时才要求刷新', () => {
  it('412 版本过期 → 需要刷新', () => {
    expect(isRefreshable(new ApiError(412, 'PRECONDITION_FAILED', '数据已被他人更新'))).toBe(true);
  });

  it('409 状态冲突 → 需要刷新（审查 R-03：此前实现漏判 409）', () => {
    expect(isRefreshable(new ApiError(409, 'STATE_CONFLICT', '当前状态不允许该操作'))).toBe(true);
    expect(isRefreshable(new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '同键不同内容'))).toBe(true);
  });

  it('428 缺少 If-Match → 不需要刷新（属客户端问题，刷新无用）', () => {
    expect(isRefreshable(new ApiError(428, 'PRECONDITION_REQUIRED', '缺少版本号'))).toBe(false);
  });

  it('401/403/404/422 → 刷新无用，不应触发重载', () => {
    for (const status of [401, 403, 404, 422]) {
      expect(isRefreshable(new ApiError(status, 'X', 'y'))).toBe(false);
    }
  });

  it('非 ApiError 输入一律返回 false，不抛异常', () => {
    expect(isRefreshable(new Error('boom'))).toBe(false);
    expect(isRefreshable(null)).toBe(false);
    expect(isRefreshable(undefined)).toBe(false);
    expect(isRefreshable('409')).toBe(false);
    expect(isRefreshable({ status: 409 })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 幂等键
// ─────────────────────────────────────────────────────────────

describe('newIdempotencyKey', () => {
  it('生成非空字符串', () => {
    const key = newIdempotencyKey();
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
  });

  it('批量生成不重复', () => {
    const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────
// 请求契约：失败绝不能被渲染成成功
// ─────────────────────────────────────────────────────────────

describe('错误映射：后端失败必须抛出，不能被当成成功', () => {
  it('后端统一错误结构 → 抛出带 code / message 的 ApiError', async () => {
    stubFetch(409, { error: { code: 'STATE_CONFLICT', message: '当前状态不允许该操作' } });

    await expect(api.start('req-1', 3)).rejects.toMatchObject({
      status: 409,
      code: 'STATE_CONFLICT',
      message: '当前状态不允许该操作',
    });
  });

  it('412 冲突 → 抛出 PRECONDITION_FAILED', async () => {
    stubFetch(412, {
      error: { code: 'PRECONDITION_FAILED', message: '数据已被他人更新，请刷新后重试' },
    });

    await expect(api.edit('req-1', { title: 'x' }, 1)).rejects.toMatchObject({
      status: 412,
      code: 'PRECONDITION_FAILED',
    });
  });

  it('网络异常 → NETWORK_ERROR（而非静默成功）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('failed to fetch');
      }),
    );

    await expect(api.me()).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('非 JSON 错误响应 → 回退为 HTTP_<status>，不崩溃', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    );

    await expect(api.detail('req-1')).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
  });

  it('成功响应正常返回数据', async () => {
    stubFetch(200, { id: 'req-1', state: 'IN_PROGRESS', rowVersion: 4 });

    await expect(api.start('req-1', 3)).resolves.toEqual({
      id: 'req-1',
      state: 'IN_PROGRESS',
      rowVersion: 4,
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 写请求必须携带乐观锁与幂等头
// ─────────────────────────────────────────────────────────────

describe('写请求契约', () => {
  it('start：携带 If-Match 与 Idempotency-Key，且同源带 Cookie', async () => {
    const spy = stubFetch(200, { id: 'req-1', state: 'IN_PROGRESS', rowVersion: 4 });

    await api.start('req-1', 7);

    const init = spy.mock.calls[0][1];
    const headers = init?.headers as Record<string, string>;
    expect(headers['If-Match']).toBe('7');
    expect(headers['Idempotency-Key']).toBeTruthy();
    expect(init?.credentials).toBe('include');
  });

  it('review：携带 If-Match 与 Idempotency-Key', async () => {
    const spy = stubFetch(200, {
      id: 'rv-1',
      action: 'COMPLETE',
      state: 'COMPLETED',
      rowVersion: 7,
    });

    await api.review('sub-1', { action: 'COMPLETE', checks: [] }, 6);

    const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['If-Match']).toBe('6');
    expect(headers['Idempotency-Key']).toBeTruthy();
  });

  it('listRequirements：筛选条件进入查询串', async () => {
    const spy = stubFetch(200, {
      items: [],
      pageInfo: { limit: 20, hasMore: false, nextCursor: null },
    });

    await api.listRequirements({ scope: 'proposed', state: 'PENDING', keyword: '导出' });

    const url = spy.mock.calls[0][0];
    expect(url).toContain('/api/requirements?');
    expect(url).toContain('scope=proposed');
    expect(url).toContain('state=PENDING');
    expect(url).toContain(encodeURIComponent('导出'));
  });

  it('listRequirements：limit 与 cursor 进入查询串（游标原样回传，不解析）', async () => {
    const spy = stubFetch(200, {
      items: [],
      pageInfo: { limit: 5, hasMore: false, nextCursor: null },
    });

    await api.listRequirements({ limit: 5, cursor: 'eyJ0IjoieCJ9' });

    const url = spy.mock.calls[0][0];
    expect(url).toContain('limit=5');
    expect(url).toContain(`cursor=${encodeURIComponent('eyJ0IjoieCJ9')}`);
  });

  it('listRequirements：不传 cursor 时查询串不含该参数（取第一页）', async () => {
    const spy = stubFetch(200, {
      items: [],
      pageInfo: { limit: 20, hasMore: false, nextCursor: null },
    });

    await api.listRequirements({});

    expect(spy.mock.calls[0][0]).not.toContain('cursor=');
  });
});
