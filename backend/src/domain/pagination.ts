import { Errors } from '../core/errors';

/**
 * 游标分页 —— **纯函数，无 IO**。
 *
 * 为什么用「键集分页（keyset）」而不是 `OFFSET`：
 *  · `OFFSET n` 要求数据库先扫过前 n 行再丢弃，代价随页数线性增长；
 *  · 更重要的是**正确性**：翻页期间若有新数据插入，`OFFSET` 会导致某些行被
 *    重复显示或整页漏掉。键集分页以「上一页最后一行」为锚点，不存在这个问题。
 *
 * 游标是 `(createdAt, id)` 复合键：
 *  · 只按 `createdAt` 排会因同一毫秒内创建多行而产生**不稳定排序**，
 *    翻页时可能重复或遗漏 —— 必须补一个唯一列做决胜键（tie-breaker）；
 *  · `id` 是 uuid，唯一，正好充当这个决胜键。
 *
 * 游标对客户端**不透明**（base64url 编码的 JSON），因此将来改排序字段
 * 不必破坏既有客户端 —— 它们只是把游标原样回传。
 */

/** 默认每页条数 */
export const DEFAULT_PAGE_SIZE = 20;
/** 每页上限：防止 `?limit=100000` 变成一次全表导出 */
export const MAX_PAGE_SIZE = 100;

export interface PageCursor {
  createdAt: Date;
  id: string;
}

export interface PageInfo {
  limit: number;
  hasMore: boolean;
  /** 下一页游标；没有下一页时为 null */
  nextCursor: string | null;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 归一化 `limit`。
 * 超过上限时**收敛到上限而不是报错**：报错会把「客户端想多取一点」变成
 * 一次失败请求，而收敛既能保护数据库、又不打断调用方。
 */
export function normalizeLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PAGE_SIZE;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw Errors.validation(`limit 必须是不小于 1 的整数（收到：${String(raw)}）`);
  }
  return Math.min(n, MAX_PAGE_SIZE);
}

/** 编码游标：base64url(JSON)。不透明，客户端不应解析。 */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), i: id }), 'utf8').toString(
    'base64url',
  );
}

/**
 * 解码游标。
 * 任何畸形输入都归为**校验错误**（`Errors.validation` → 422），而不是 500 ——
 * 游标来自客户端，属于「请求参数」而非「服务端故障」。
 * 用 422 而非 400 是为了与项目既有约定一致（见 core/errors.ts：
 * VALIDATION_FAILED → 422，`状态筛选值不合法` 等走同一条路径）。
 */
export function decodeCursor(raw: string): PageCursor {
  const invalid = (): never => {
    throw Errors.validation('cursor 不是合法的分页游标');
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return invalid();
  }

  if (typeof parsed !== 'object' || parsed === null) return invalid();
  const { t, i } = parsed as { t?: unknown; i?: unknown };
  if (typeof t !== 'string' || typeof i !== 'string') return invalid();

  const createdAt = new Date(t);
  if (Number.isNaN(createdAt.getTime())) return invalid();
  if (!UUID_RE.test(i)) return invalid();

  return { createdAt, id: i };
}

/**
 * 由「本页最后一行」推出下一页游标。
 * 没有下一页时返回 null —— 让客户端无需自己判断边界。
 */
export function buildPageInfo(
  limit: number,
  hasMore: boolean,
  lastRow: { createdAt: Date; id: string } | undefined,
): PageInfo {
  return {
    limit,
    hasMore,
    nextCursor: hasMore && lastRow ? encodeCursor(lastRow.createdAt, lastRow.id) : null,
  };
}
