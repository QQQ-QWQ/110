/**
 * 数据保留策略 —— **纯函数，零依赖，无 IO**。
 *
 * 为什么把策略从定时任务里抽出来：
 * 清理任务的**风险不在于「能不能删」，而在于「删得对不对」**。
 *   · 误删 `PROCESSING` 的幂等记录 → 同一幂等键会被重复占坑，幂等保证直接失效；
 *   · 误删未过期的会话 → 把在线用户踢下线。
 * 这类判定必须是可被单测钉死的纯逻辑，而不是埋在 setInterval 的回调里。
 *
 * 因此本文件只做判定与 where 子句构造，不碰数据库、不读环境变量、不依赖 Prisma 类型
 * （与 `domain/` 下其余文件保持一致：零依赖纯函数）。
 */

/**
 * 幂等记录的保留时长。
 * 幂等键的语义有效期等于**客户端重试窗口**（通常 ≤ 24 小时）；
 * 超过该窗口的记录既无用途，又持续占用存储、拖慢唯一索引的维护成本。
 */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyRecordLike {
  status: string;
  createdAt: Date;
}

export interface SessionLike {
  expiresAt: Date;
}

/** 幂等记录的清理截止时刻：早于它的记录才可能被清理 */
export function idempotencyPurgeCutoff(now: Date): Date {
  return new Date(now.getTime() - IDEMPOTENCY_RETENTION_MS);
}

/**
 * 是否应清理这条幂等记录。
 *
 * **只清理 `COMPLETED`**：`PROCESSING` 是「请求正在进行中」的占坑标记，
 * 删掉它会让同一个幂等键被重新占坑，从而允许同一请求被重复执行业务写入 ——
 * 这正是幂等机制要防的事。滞留的 `PROCESSING` 说明有请求异常中断，
 * 应当**告警**而不是静默删除。
 */
export function shouldPurgeIdempotencyRecord(record: IdempotencyRecordLike, now: Date): boolean {
  if (record.status !== 'COMPLETED') return false;
  return record.createdAt.getTime() < idempotencyPurgeCutoff(now).getTime();
}

/**
 * 是否应清理这条会话。
 * 只按**绝对过期时间**判断：空闲过期（idle）由 `SessionService.resolve` 在访问时处理，
 * 这里若也按 lastSeenAt 判，会把「刚被访问过但绝对时间已到」的会话误留。
 */
export function shouldPurgeSession(session: SessionLike, now: Date): boolean {
  return session.expiresAt.getTime() <= now.getTime();
}

/**
 * 幂等记录的 Prisma where 子句。
 * **必须与 `shouldPurgeIdempotencyRecord` 语义一致** ——
 * 两者一旦不一致，单测通过而线上删错，且这种不一致不会有任何编译期提示。
 * 边界刻意都用严格小于：`createdAt < cutoff`。
 */
export function idempotencyPurgeWhere(now: Date): {
  status: 'COMPLETED';
  createdAt: { lt: Date };
} {
  return { status: 'COMPLETED', createdAt: { lt: idempotencyPurgeCutoff(now) } };
}

/**
 * 会话的 Prisma where 子句。
 * 与 `shouldPurgeSession` 对齐：`expiresAt <= now`（含边界，故用 `lte`）。
 */
export function sessionPurgeWhere(now: Date): { expiresAt: { lte: Date } } {
  return { expiresAt: { lte: now } };
}

/**
 * 「滞留的 PROCESSING 幂等记录」的 where 子句。
 *
 * 注意语义：这些记录**只用于告警，绝不删除**。
 * 它们意味着有请求在占坑后异常中断（进程被杀、事务超时），
 * 删除它们会让同一幂等键被重新占坑，从而允许同一请求被重复执行业务写入。
 */
export function staleProcessingWhere(now: Date): {
  status: 'PROCESSING';
  createdAt: { lt: Date };
} {
  return { status: 'PROCESSING', createdAt: { lt: idempotencyPurgeCutoff(now) } };
}
