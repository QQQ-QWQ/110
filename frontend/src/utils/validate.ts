/**
 * 前端输入校验 —— 与后端 `backend/src/domain/invariants.ts` 的约束一一对应。
 *
 * 设计取舍：
 *  - 前端校验只为「即时反馈」，**不是**安全边界；权威判定始终在后端。
 *  - 长度一律按 **Unicode code points** 计数（`Array.from`），
 *    与后端一致；直接用 `.length` 会把 emoji 算成 2 个，导致前后端判定不一致。
 *  - 每个校验函数返回「错误文案 | null」，便于表单做字段级内联提示。
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

/** 按 Unicode code points 计数（与后端 countCodePoints 一致） */
export function countCodePoints(value: string | null | undefined): number {
  return Array.from(value ?? '').length;
}

export function isBlank(value: string | null | undefined): boolean {
  return (value ?? '').trim().length === 0;
}

/** 多行文本 → 去空行、去首尾空白的数组 */
export function splitLines(text: string | null | undefined): string[] {
  return (text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 成果链接合法性：与后端 assertHttpUrl + 数据库 CHECK 保持**判定一致**。
 * 关键点：必须显式拒绝空白字符 —— `new URL('https://a.com/x y')` 是成功的，
 * 若前端放行，会一路走到数据库 CHECK 才失败，用户看到的是 500 而非可理解的提示。
 */
export function isHttpUrl(raw: string | null | undefined): boolean {
  const value = (raw ?? '').trim();
  if (value.length === 0) return false;
  if (countCodePoints(value) > LIMITS.URL_MAX) return false;
  if (/\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

// ───────────────────────── 字段级校验 ─────────────────────────

export function validateTitle(value: string): string | null {
  if (isBlank(value)) return '请填写标题';
  if (countCodePoints(value.trim()) > LIMITS.TITLE_MAX) {
    return `标题最多 ${LIMITS.TITLE_MAX} 个字符`;
  }
  return null;
}

export function validateDescription(value: string): string | null {
  if (isBlank(value)) return '请填写问题与内容说明';
  if (countCodePoints(value.trim()) > LIMITS.DESCRIPTION_MAX) {
    return `说明最多 ${LIMITS.DESCRIPTION_MAX} 个字符`;
  }
  return null;
}

export function validateAssignee(assigneeId: string): string | null {
  if (isBlank(assigneeId)) return '请指定负责人';
  return null;
}

export function validateCriteria(lines: string[]): string | null {
  if (lines.length < LIMITS.CRITERIA_MIN) {
    return `至少需要 ${LIMITS.CRITERIA_MIN} 条可核对的验收条件（每行一条）`;
  }
  if (lines.length > LIMITS.CRITERIA_MAX) {
    return `验收条件最多 ${LIMITS.CRITERIA_MAX} 条，当前 ${lines.length} 条`;
  }
  const tooLong = lines.findIndex((t) => countCodePoints(t) > LIMITS.CRITERION_TEXT_MAX);
  if (tooLong >= 0) {
    return `第 ${tooLong + 1} 条验收条件超出 ${LIMITS.CRITERION_TEXT_MAX} 个字符`;
  }
  return null;
}

export function validateArtifacts(lines: string[]): string | null {
  if (lines.length < LIMITS.ARTIFACTS_MIN) {
    return '至少填写一个可查看的成果链接（每行一个）';
  }
  if (lines.length > LIMITS.ARTIFACTS_MAX) {
    return `成果链接最多 ${LIMITS.ARTIFACTS_MAX} 个，当前 ${lines.length} 个`;
  }
  const bad = lines.findIndex((u) => !isHttpUrl(u));
  if (bad >= 0) {
    return `第 ${bad + 1} 个链接不合法，须为 http:// 或 https:// 开头的完整 URL`;
  }
  return null;
}

export function validateNote(value: string): string | null {
  if (isBlank(value)) return '请填写完成说明';
  if (countCodePoints(value.trim()) > LIMITS.NOTE_MAX) {
    return `完成说明最多 ${LIMITS.NOTE_MAX} 个字符`;
  }
  return null;
}

export function validateReturnReason(value: string): string | null {
  if (isBlank(value)) return '退回时必须填写具体修改原因';
  if (countCodePoints(value.trim()) > LIMITS.REASON_MAX) {
    return `退回原因最多 ${LIMITS.REASON_MAX} 个字符`;
  }
  return null;
}

// ───────────────────────── 表单级校验 ─────────────────────────

export interface FieldErrors {
  [field: string]: string | undefined;
}

export interface CreateFormValues {
  title: string;
  description: string;
  assigneeId: string;
  criteriaText: string;
}

export function validateCreateForm(values: CreateFormValues): FieldErrors {
  const errors: FieldErrors = {};
  const title = validateTitle(values.title);
  if (title) errors.title = title;
  const description = validateDescription(values.description);
  if (description) errors.description = description;
  const assignee = validateAssignee(values.assigneeId);
  if (assignee) errors.assigneeId = assignee;
  const criteria = validateCriteria(splitLines(values.criteriaText));
  if (criteria) errors.criteriaText = criteria;
  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.values(errors).some((v) => v !== undefined);
}

/** 把后端返回的语义化 message 归到最可能的字段上，便于内联展示 */
export function fieldFromServerMessage(message: string): string | null {
  if (message.includes('标题')) return 'title';
  if (message.includes('说明')) return 'description';
  if (message.includes('负责人')) return 'assigneeId';
  if (message.includes('验收条件')) return 'criteriaText';
  if (message.includes('链接')) return 'artifactsText';
  if (message.includes('完成说明')) return 'note';
  if (message.includes('退回原因') || message.includes('原因')) return 'reason';
  return null;
}
