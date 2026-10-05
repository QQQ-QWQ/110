/**
 * 解析 If-Match 风格的版本号头。
 * 支持 `12`、`"12"`、`W/"12"`；无法解析时返回 undefined（表示不做版本校验）。
 */
export function parseVersionHeader(raw?: string): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/^W\//i, '').replace(/"/g, '').trim();
  if (cleaned.length === 0 || cleaned === '*') return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 读取幂等键请求头 */
export function idempotencyKeyOf(raw?: string): string | undefined {
  const key = (raw ?? '').trim();
  return key.length > 0 ? key : undefined;
}
