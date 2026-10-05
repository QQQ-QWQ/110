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

/**
 * 事件时间线（`seq` 游标）的默认/上限条数。
 * 比列表页更宽松：时间线是「按需展开」的阅读场景，一次多看一些才不至于
 * 频繁翻页；但仍必须有上界。
 */
export const DEFAULT_SEQ_PAGE_SIZE = 50;
export const MAX_SEQ_PAGE_SIZE = 200;

/**
 * 详情页里 submissions 的固定上界。
 *
 * 与 events 不同，submissions 的数量等于「重提次数」，由人的行为决定，
 * 实际上界很低。但仍给它一个上界 —— 不设上界的数组迟早会变成事故；
 * 同时用 `submissionsHasMore` 把它**显式暴露**出来，而不是悄悄截断。
 */
export const DETAIL_SUBMISSION_LIMIT = 20;

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
 *
 * `fallback` / `max` 可覆盖默认值：事件时间线的默认页比需求列表大（见
 * `DEFAULT_SEQ_PAGE_SIZE`），但两者共用同一套校验语义。
 */
export function normalizeLimit(
  raw: unknown,
  fallback: number = DEFAULT_PAGE_SIZE,
  max: number = MAX_PAGE_SIZE,
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw Errors.validation(`limit 必须是不小于 1 的整数（收到：${String(raw)}）`);
  }
  return Math.min(n, max);
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

// ─────────────────────────────────────────────────────────────
// `seq` 游标：用于需求的事件时间线（`requirement_event.seq`）
//
// 事件表上有一个天然的好游标：`seq` 在**单个需求内**单调递增（由命令管道分配）。
// 它比 `(createdAt, id)` 更合适，因为：
//  · 单调整数天然有序，不存在「同一毫秒」的稳定性问题；
//  · 只有一个字段，比较条件简单（`seq > cursor` 或 `seq < cursor`）。
// 仍然做 base64url 编码，理由与列表游标一致：对客户端不透明，
// 将来换排序字段不必破坏既有客户端。
// ─────────────────────────────────────────────────────────────

/** 编码 `seq` 游标。 */
export function encodeSeqCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ s: seq }), 'utf8').toString('base64url');
}

/** 解码 `seq` 游标。畸形输入同样归为 422（与 `decodeCursor` 一致）。 */
export function decodeSeqCursor(raw: string): number {
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
  const { s } = parsed as { s?: unknown };
  if (typeof s !== 'number' || !Number.isInteger(s) || s < 0) return invalid();

  return s;
}

/** 由「本页最后一行的 seq」推出下一页游标。 */
export function buildSeqPageInfo(
  limit: number,
  hasMore: boolean,
  lastSeq: number | undefined,
): PageInfo {
  return {
    limit,
    hasMore,
    nextCursor: hasMore && lastSeq !== undefined ? encodeSeqCursor(lastSeq) : null,
  };
}
