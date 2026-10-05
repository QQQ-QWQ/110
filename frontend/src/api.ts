import type { RequirementDetail, RequirementListPage, UserBrief } from './types';

/**
 * 统一 API 客户端。
 *
 * 三条硬约定（对应后端写命令管道）：
 *  1. 所有请求带 credentials:'include'，会话靠 httpOnly Cookie 传递，前端不接触 token；
 *  2. 状态变更类请求必须带 `If-Match: <rowVersion>`，服务端据此做乐观锁校验（不匹配返回 412）；
 *  3. 写请求必须带 `Idempotency-Key`，重复提交（含网络重试）不会产生第二次副作用。
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const BASE = '/api';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers, ...rest } = init;

  let res: Response;
  try {
    res = await fetch(BASE + path, {
      credentials: 'include',
      ...rest,
      headers: {
        'Content-Type': 'application/json',
        ...((headers as Record<string, string> | undefined) ?? {}),
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '网络异常，请检查服务是否已启动');
  }

  const raw = await res.text();
  let data: unknown = null;
  if (raw.length > 0) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)
      ?.error;
    throw new ApiError(
      res.status,
      err?.code ?? `HTTP_${res.status}`,
      err?.message ?? `请求失败（${res.status}）`,
      err?.details,
    );
  }

  return data as T;
}

/** 幂等键：优先用 crypto.randomUUID（localhost/https 为安全上下文），否则退化为时间戳+随机数 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface CreateRequirementBody {
  title: string;
  description: string;
  assigneeId: string;
  criteria: string[];
}

export interface EditRequirementBody {
  title?: string;
  description?: string;
  criteria?: string[];
}

export interface SubmitBody {
  artifacts: string[];
  note: string;
}

export interface ReviewBody {
  action: 'RETURN' | 'COMPLETE';
  reason?: string;
  checks: { criterionId: string; passed: boolean }[];
}

export const api = {
  // ── 会话 ──
  login: (account: string, password: string) =>
    request<{ user: UserBrief }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ account, password }),
    }),

  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  me: () => request<UserBrief>('/auth/me'),

  members: () => request<UserBrief[]>('/auth/members'),

  // ── 需求 ──
  /**
   * 列表（游标分页）。
   * 不传 `cursor` 即取第一页；用上一页返回的 `pageInfo.nextCursor` 取下一页。
   * 游标对前端不透明，只做原样回传。
   */
  listRequirements: (
    q: { state?: string; scope?: string; keyword?: string; limit?: number; cursor?: string } = {},
  ) => {
    const p = new URLSearchParams();
    if (q.state) p.set('state', q.state);
    if (q.scope) p.set('scope', q.scope);
    if (q.keyword) p.set('keyword', q.keyword);
    if (q.limit !== undefined) p.set('limit', String(q.limit));
    if (q.cursor) p.set('cursor', q.cursor);
    const qs = p.toString();
    return request<RequirementListPage>(`/requirements${qs ? `?${qs}` : ''}`);
  },

  detail: (id: string) => request<RequirementDetail>(`/requirements/${id}`),

  create: (body: CreateRequirementBody) =>
    request<{ id: string; state: string; rowVersion: number }>('/requirements', {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify(body),
    }),

  edit: (id: string, body: EditRequirementBody, rowVersion: number) =>
    request<{ id: string; state: string; rowVersion: number }>(`/requirements/${id}`, {
      method: 'PATCH',
      headers: { 'If-Match': String(rowVersion), 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify(body),
    }),

  start: (id: string, rowVersion: number) =>
    request<{ id: string; state: string; rowVersion: number }>(`/requirements/${id}/start`, {
      method: 'POST',
      headers: { 'If-Match': String(rowVersion), 'Idempotency-Key': newIdempotencyKey() },
    }),

  // ── 提交 ──
  submit: (requirementId: string, body: SubmitBody, rowVersion: number) =>
    request<{ id: string; submissionNo: number; state: string; rowVersion: number }>(
      `/requirements/${requirementId}/submissions`,
      {
        method: 'POST',
        headers: { 'If-Match': String(rowVersion), 'Idempotency-Key': newIdempotencyKey() },
        body: JSON.stringify(body),
      },
    ),

  // ── 验收 ──
  review: (submissionId: string, body: ReviewBody, rowVersion: number) =>
    request<{ id: string; action: string; state: string; rowVersion: number }>(
      `/submissions/${submissionId}/reviews`,
      {
        method: 'POST',
        headers: { 'If-Match': String(rowVersion), 'Idempotency-Key': newIdempotencyKey() },
        body: JSON.stringify(body),
      },
    ),
};

/**
 * 是否需要「刷新后重试」。
 *
 * 判据：当前页面**持有的数据是否已陈旧**。
 *  - 412 PRECONDITION_FAILED —— 版本号过期（他人已更新）
 *  - 409 STATE_CONFLICT      —— 状态已变化（如提交已被替换、需求已完成）
 * 两者重新加载即可拿到正确状态。
 *
 * 其余错误刷新无用：401 需重新登录、403/404 是权限或可见性问题、
 * 422 是本次输入本身不合法（刷新不会让它变合法）。
 *
 * 注：代码审查 R-03 发现此处注释原称含 409 而实现只判断 412，已按注释意图修正实现。
 */
export function isRefreshable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return err.status === 412 || err.status === 409;
}
