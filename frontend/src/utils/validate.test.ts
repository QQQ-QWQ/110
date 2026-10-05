import { describe, expect, it } from 'vitest';
import {
  countCodePoints,
  fieldFromServerMessage,
  hasErrors,
  isHttpUrl,
  isBlank,
  splitLines,
  validateArtifacts,
  validateCreateForm,
  validateCriteria,
  validateNote,
  validateReturnReason,
  validateTitle,
} from './validate';

// ─────────────────────────────────────────────────────────────
// 计数口径：必须与后端 countCodePoints（code points）一致
// ─────────────────────────────────────────────────────────────

describe('countCodePoints：按 Unicode code points 计数', () => {
  it('ASCII 与中文按字符数计', () => {
    expect(countCodePoints('abc')).toBe(3);
    expect(countCodePoints('中文标题')).toBe(4);
  });

  it('emoji 只算 1 个（String.length 会算成 2，这正是要避免的偏差）', () => {
    expect('😀'.length).toBe(2);
    expect(countCodePoints('😀')).toBe(1);
    expect(countCodePoints('😀😀')).toBe(2);
  });

  it('空值安全', () => {
    expect(countCodePoints(null)).toBe(0);
    expect(countCodePoints(undefined)).toBe(0);
    expect(countCodePoints('')).toBe(0);
  });
});

describe('isBlank / splitLines', () => {
  it('纯空白视为空', () => {
    expect(isBlank('   ')).toBe(true);
    expect(isBlank('\n\t')).toBe(true);
    expect(isBlank(' a ')).toBe(false);
  });

  it('splitLines 去空行与首尾空白', () => {
    expect(splitLines('  第一条 \n\n 第二条\n   \n')).toEqual(['第一条', '第二条']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines(null)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// URL 校验：必须与后端 assertHttpUrl + DB CHECK 判定一致（审查 R-07）
// ─────────────────────────────────────────────────────────────

describe('isHttpUrl：与后端判定一致', () => {
  it('接受 http / https 且主机名非空', () => {
    expect(isHttpUrl('https://github.com/org/repo/pull/12')).toBe(true);
    expect(isHttpUrl('http://127.0.0.1:8080/x')).toBe(true);
    expect(isHttpUrl('  https://example.com  ')).toBe(true);
  });

  it('拒绝含空白字符的链接（否则会一路走到数据库 CHECK 才以 500 暴露）', () => {
    expect(isHttpUrl('https://example.com/a b')).toBe(false);
    expect(isHttpUrl('https://example.com/a\tb')).toBe(false);
  });

  it('拒绝非 http(s) 协议', () => {
    expect(isHttpUrl('ftp://example.com')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
  });

  it('拒绝缺少主机名或格式非法的输入', () => {
    expect(isHttpUrl('https://')).toBe(false);
    expect(isHttpUrl('example.com')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });

  it('超长链接被拒（上限 2048 code points）', () => {
    expect(isHttpUrl(`https://example.com/${'a'.repeat(2048)}`)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 字段级校验
// ─────────────────────────────────────────────────────────────

describe('validateTitle', () => {
  it('空标题被拒', () => {
    expect(validateTitle('   ')).toBe('请填写标题');
  });

  it('200 字符以内通过，超出被拒', () => {
    expect(validateTitle('a'.repeat(200))).toBeNull();
    expect(validateTitle('a'.repeat(201))).toContain('200');
  });

  it('按 code points 判定，emoji 不会提前触发上限', () => {
    expect(validateTitle('😀'.repeat(200))).toBeNull();
  });
});

describe('validateCriteria', () => {
  it('至少 1 条', () => {
    expect(validateCriteria([])).toContain('至少需要 1 条');
  });

  it('最多 50 条', () => {
    expect(validateCriteria(Array.from({ length: 50 }, (_, i) => `条件${i}`))).toBeNull();
    expect(validateCriteria(Array.from({ length: 51 }, (_, i) => `条件${i}`))).toContain('最多 50');
  });

  it('单条超 500 code points 时指出第几条', () => {
    const message = validateCriteria(['正常', 'x'.repeat(501)]);
    expect(message).toContain('第 2 条');
  });
});

describe('validateArtifacts', () => {
  it('至少 1 个', () => {
    expect(validateArtifacts([])).toContain('至少填写一个');
  });

  it('最多 20 个', () => {
    const urls = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `https://example.com/${i}`);
    expect(validateArtifacts(urls(20))).toBeNull();
    expect(validateArtifacts(urls(21))).toContain('最多 20');
  });

  it('指出第几个链接不合法', () => {
    const message = validateArtifacts(['https://ok.com', 'ftp://bad.com']);
    expect(message).toContain('第 2 个链接');
  });
});

describe('validateNote / validateReturnReason', () => {
  it('完成说明必填且限长', () => {
    expect(validateNote('  ')).toBe('请填写完成说明');
    expect(validateNote('已实现')).toBeNull();
    expect(validateNote('x'.repeat(5001))).toContain('5000');
  });

  it('退回原因必填（考核硬约束）且限长', () => {
    expect(validateReturnReason('')).toBe('退回时必须填写具体修改原因');
    expect(validateReturnReason('第 2 条未实现')).toBeNull();
    expect(validateReturnReason('x'.repeat(2001))).toContain('2000');
  });
});

// ─────────────────────────────────────────────────────────────
// 表单级校验
// ─────────────────────────────────────────────────────────────

describe('validateCreateForm / hasErrors', () => {
  it('全部合法时无错误', () => {
    const errors = validateCreateForm({
      title: '导出 CSV',
      description: '需要导出列表',
      assigneeId: 'u-2',
      criteriaText: '第一行\n第二行',
    });
    expect(hasErrors(errors)).toBe(false);
  });

  it('多个字段同时出错时逐项给出文案', () => {
    const errors = validateCreateForm({
      title: '',
      description: '',
      assigneeId: '',
      criteriaText: '',
    });
    expect(errors.title).toBe('请填写标题');
    expect(errors.description).toBe('请填写问题与内容说明');
    expect(errors.assigneeId).toBe('请指定负责人');
    expect(errors.criteriaText).toContain('至少需要 1 条');
    expect(hasErrors(errors)).toBe(true);
  });
});

describe('fieldFromServerMessage：把后端语义化文案归到字段', () => {
  it('按关键词映射', () => {
    expect(fieldFromServerMessage('标题不能为空')).toBe('title');
    expect(fieldFromServerMessage('请指定负责人')).toBe('assigneeId');
    expect(fieldFromServerMessage('负责人不能与提出者相同')).toBe('assigneeId');
    expect(fieldFromServerMessage('成果链接格式不合法')).toBe('artifactsText');
    expect(fieldFromServerMessage('退回时必须填写具体修改原因')).toBe('reason');
  });

  it('无法归类时返回 null，由调用方降级为表单级提示', () => {
    expect(fieldFromServerMessage('当前状态不允许该操作')).toBeNull();
  });
});
