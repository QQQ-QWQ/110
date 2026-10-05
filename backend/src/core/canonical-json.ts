import { createHash } from 'node:crypto';

/**
 * 请求指纹（用于幂等键校验）
 *
 * 必须「同一内容 → 同一指纹」，因此采用稳定序列化（对象键排序）。
 * 否则 {a:1,b:2} 与 {b:2,a:1} 会被误判为不同内容，导致重复提交被错误拒绝。
 */

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalize);

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const v = source[key];
    if (v === undefined) continue;
    result[key] = normalize(v);
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 计算某次写请求的指纹 */
export function requestHashOf(
  command: string,
  requirementId: string | null,
  payload: unknown,
): string {
  return sha256Hex(canonicalJson({ command, requirementId: requirementId ?? null, payload }));
}
