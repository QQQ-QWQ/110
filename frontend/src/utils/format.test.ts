import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatRelative, initialsOf, truncate } from './format';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatDateTime / formatDate', () => {
  it('非法日期回退为占位符，不抛异常', () => {
    expect(formatDateTime('not-a-date')).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
  });

  it('正常日期输出非空且包含年份', () => {
    const iso = '2026-10-05T05:27:35.000Z';
    expect(formatDateTime(iso)).not.toBe('—');
    expect(formatDate(iso)).toContain('2026');
  });
});

describe('initialsOf', () => {
  it('取首字并大写', () => {
    expect(initialsOf('alice')).toBe('A');
    expect(initialsOf('鲍勃')).toBe('鲍');
  });

  it('空值回退为 ?', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
    expect(initialsOf(null)).toBe('?');
    expect(initialsOf(undefined)).toBe('?');
  });

  it('emoji 名字不会被截半（按 code points 取首字）', () => {
    expect(initialsOf('😀小明')).toBe('😀');
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-10-05T12:00:00Z').getTime();

  it('按区间给出中文相对时间', () => {
    expect(formatRelative(now - 30_000, now)).toBe('刚刚');
    expect(formatRelative(now - 5 * MIN, now)).toBe('5 分钟前');
    expect(formatRelative(now - 3 * HOUR, now)).toBe('3 小时前');
    expect(formatRelative(now - 2 * DAY, now)).toBe('2 天前');
  });

  it('超过 7 天回退为具体日期', () => {
    const result = formatRelative(now - 10 * DAY, now);
    expect(result).not.toContain('前');
    expect(result).toContain('2026');
  });

  it('未来时间直接展示日期时间，不出现负数', () => {
    expect(formatRelative(now + HOUR, now)).not.toContain('-');
  });
});

describe('truncate', () => {
  it('未超长时原样返回', () => {
    expect(truncate('短文本', 10)).toBe('短文本');
  });

  it('超长时截断并追加省略号', () => {
    expect(truncate('abcdef', 3)).toBe('abc…');
  });

  it('按 code points 截断，emoji 不会被截半', () => {
    expect(truncate('😀😀😀', 2)).toBe('😀😀…');
  });
});
