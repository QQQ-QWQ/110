import { Errors } from '../core/errors';

/**
 * 业务不变量 —— 领域规则的单一落点
 *
 * 所有文本长度一律按 **Unicode code points** 计数。
 * 注意：JavaScript 的 `String.prototype.length` 是 UTF-16 code units，
 * 对 emoji / 增补平面字符会算多，因此必须用 Array.from(...).length。
 */

export const LIMITS = {
  TITLE_MAX: 200,
  DESCRIPTION_MAX: 5000,
  CRITERIA_MIN: 1,
  CRITERIA_MAX: 50,
  CRITERION_TEXT_MAX: 500,
  ARTIFACTS_MIN: 1,
  ARTIFACTS_MAX: 20,
  URL_MAX: 2048,
  NOTE_MAX: 5000,
  REASON_MAX: 2000,
} as const;

/** 按 Unicode code points 计数 */
export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

export function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw Errors.validation(`${label}不能为空`);
  }
}

export function assertCodePointLength(value: string, max: number, label: string): void {
  if (countCodePoints(value) > max) {
    throw Errors.validation(`${label}超出长度上限（最多 ${max} 个字符）`);
  }
}

/**
 * 成果链接校验。
 *
 * 应用层使用真正的 URL parser（scheme ∈ {http, https} 且 host 非空）；
 * 数据库 CHECK 只作兜底，不能替代这里的校验。
 *
 * ⚠️ 两层必须**判定一致**（代码审查 R-07）：
 * 数据库约束为 `^https?://[^[:space:]]+$`，即不允许任何空白字符；
 * 而 `new URL('https://example.com/a b')` 是**成功**的（空格会被百分号编码，
 * 但本函数返回的是原始字符串）。若此处不拦，含空格的链接会一路走到数据库，
 * 触发 CHECK 冲突，最终以 500 暴露内部错误，而不是干净的 422。
 */
export function assertHttpUrl(raw: string): string {
  const url = (raw ?? '').trim();
  assertNonBlank(url, '成果链接');
  assertCodePointLength(url, LIMITS.URL_MAX, '成果链接');

  // 与数据库 CHECK 对齐：禁止任何空白字符（空格 / 制表符 / 换行等）
  if (/\s/.test(url)) {
    throw Errors.validation('成果链接不能包含空格等空白字符');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw Errors.validation('成果链接格式不合法，请填写完整 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Errors.validation('成果链接必须以 http:// 或 https:// 开头');
  }
  if (!parsed.hostname) {
    throw Errors.validation('成果链接缺少主机名');
  }
  return url;
}

/** 验收条件集合：1~50 条，单条非空且 ≤500 code points */
export function assertCriteria(raw: string[]): string[] {
  const list = (raw ?? []).map((t) => (t ?? '').trim()).filter((t) => t.length > 0);
  if (list.length < LIMITS.CRITERIA_MIN) {
    throw Errors.validation(`至少需要 ${LIMITS.CRITERIA_MIN} 条可核对的验收条件`);
  }
  if (list.length > LIMITS.CRITERIA_MAX) {
    throw Errors.validation(`验收条件最多 ${LIMITS.CRITERIA_MAX} 条`);
  }
  for (const text of list) {
    assertCodePointLength(text, LIMITS.CRITERION_TEXT_MAX, '单条验收条件');
  }
  return list;
}

/** 成果链接集合：1~20 条 */
export function assertArtifacts(raw: string[]): string[] {
  const list = (raw ?? []).filter((u) => (u ?? '').trim().length > 0);
  if (list.length < LIMITS.ARTIFACTS_MIN) {
    throw Errors.validation(`至少需要 ${LIMITS.ARTIFACTS_MIN} 个可查看的成果链接`);
  }
  if (list.length > LIMITS.ARTIFACTS_MAX) {
    throw Errors.validation(`成果链接最多 ${LIMITS.ARTIFACTS_MAX} 个`);
  }
  return list.map((u) => assertHttpUrl(u));
}

/** 退回必须填写具体修改原因 */
export function assertReturnReason(raw: string | undefined | null): string {
  const reason = (raw ?? '').trim();
  if (reason.length === 0) {
    throw Errors.validation('退回时必须填写具体修改原因');
  }
  assertCodePointLength(reason, LIMITS.REASON_MAX, '退回原因');
  return reason;
}

/** 通过：必须全部验收条件都勾选通过 */
export function assertAllChecksPassed(passed: boolean[]): void {
  if (passed.length === 0) {
    throw Errors.validation('请先逐项记录验收结果');
  }
  if (passed.some((p) => p !== true)) {
    throw Errors.validation('存在未通过的验收条件，不能确认完成');
  }
}

/** 负责人必须不同于提出者 */
export function assertAssigneeDiffers(proposerId: string, assigneeId: string): void {
  if (!assigneeId) {
    throw Errors.validation('请指定负责人');
  }
  if (proposerId === assigneeId) {
    throw Errors.validation('负责人不能与提出者相同');
  }
}

export function assertNote(note: string): string {
  const value = (note ?? '').trim();
  assertNonBlank(value, '完成说明');
  assertCodePointLength(value, LIMITS.NOTE_MAX, '完成说明');
  return value;
}
