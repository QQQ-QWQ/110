/**
 * 展示层格式化工具。
 *
 * 只做「呈现」，不做业务校验 —— 校验统一放在 utils/validate.ts，
 * 与后端 domain/invariants.ts 的约束一一对应。
 */

/** 日期时间：2026/10/05 13:27:35（本地时区，24 小时制） */
export function formatDateTime(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false });
}

/** 仅日期：2026/10/05 */
export function formatDate(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('zh-CN');
}

/** 取姓名首字，用于头像占位（空值回退为 '?'） */
export function initialsOf(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  return trimmed.length > 0 ? Array.from(trimmed)[0].toUpperCase() : '?';
}

/** 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 2 天前 / 具体日期 */
export function formatRelative(value: string | number | Date, now: number = Date.now()): string {
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  if (Number.isNaN(t)) return '—';

  const diff = now - t;
  if (diff < 0) return formatDateTime(d);

  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  if (diff < MIN) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  return formatDate(d);
}

/** 截断长文本（按 code points，避免 emoji 被截半） */
export function truncate(value: string, max: number): string {
  const chars = Array.from(value ?? '');
  return chars.length <= max ? value : `${chars.slice(0, max).join('')}…`;
}
