import { describe, expect, it } from 'vitest';
import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';

import AlertBox from './AlertBox.vue';
import CriteriaList from './CriteriaList.vue';
import EmptyState from './EmptyState.vue';
import EventTimeline from './EventTimeline.vue';
import FormField from './FormField.vue';
import NextStepCard from './NextStepCard.vue';
import ReviewPanel from './ReviewPanel.vue';
import RoleTag from './RoleTag.vue';
import StatusBadge from './StatusBadge.vue';
import SubmissionCard from './SubmissionCard.vue';

import type { Criterion, DomainEvent, Submission } from '../types';

/**
 * 组件渲染测试 —— 用 Vue 内置的 `vue/server-renderer` 做服务端渲染断言。
 *
 * 为什么用 SSR 而不是 jsdom + @vue/test-utils：
 *  1. **零新增依赖** —— `vue/server-renderer` 随 vue 一起安装，
 *     不必引入 jsdom / test-utils，不污染 lockfile 与 CI 安装体积；
 *  2. 断言的是**真实渲染输出**（DOM 结构、class、aria 属性），
 *     而不是「组件能被挂载」这种弱结论；
 *  3. 在 Docker 不可用的环境下也能给出「界面确实渲染正确」的可验证证据。
 *
 * 覆盖边界：SSR 不执行 onMounted，因此这里验证的是**给定 props 的渲染结果**；
 * 数据加载、点击交互由 utils 单测与端到端脚本覆盖。
 */

/** 渲染组件并收集 Teleport 出去的内容（弹窗挂在 body 上） */
async function render(
  component: Component,
  props: Record<string, unknown> = {},
): Promise<{ html: string; teleported: string }> {
  const app = createSSRApp({ render: () => h(component, props) });
  const context: Record<string, unknown> = {};
  const html = await renderToString(app, context);
  const teleports = (context.teleports ?? {}) as Record<string, string>;
  return { html, teleported: Object.values(teleports).join('') };
}

const criteria: Criterion[] = [
  { id: 'c1', seq: 1, text: '支持按状态筛选' },
  { id: 'c2', seq: 2, text: '失败场景有明确错误提示' },
  { id: 'c3', seq: 3, text: '导出为 CSV' },
];

// ─────────────────────────────────────────────────────────────
// NextStepCard：下一步引导必须随「状态 × 角色 × 可用动作」变化
// ─────────────────────────────────────────────────────────────

describe('NextStepCard：按状态与角色给出不同的下一步', () => {
  it('负责人 + 待处理 → 引导「开始处理」并说明冻结后果', async () => {
    const { html } = await render(NextStepCard, {
      state: 'PENDING',
      myRole: 'ASSIGNEE',
      nextActions: ['START'],
    });
    expect(html).toContain('下一步：开始处理');
    expect(html).toContain('冻结');
  });

  it('提出者 + 待处理 → 引导「修改需求」', async () => {
    const { html } = await render(NextStepCard, {
      state: 'PENDING',
      myRole: 'PROPOSER',
      nextActions: ['EDIT'],
    });
    expect(html).toContain('下一步：修改需求');
  });

  it('提出者 + 待验收 → 引导「逐项验收」并强调退回原因必填', async () => {
    const { html } = await render(NextStepCard, {
      state: 'IN_REVIEW',
      myRole: 'PROPOSER',
      nextActions: ['REVIEW_RETURN', 'REVIEW_COMPLETE'],
    });
    expect(html).toContain('下一步：逐项验收');
    expect(html).toContain('退回原因');
  });

  it('无可用动作时明确「在等谁」，而不是含糊的「请继续操作」', async () => {
    const proposer = await render(NextStepCard, {
      state: 'IN_PROGRESS',
      myRole: 'PROPOSER',
      nextActions: [],
    });
    expect(proposer.html).toContain('等待负责人提交成果');
    expect(proposer.html).toContain('is-wait');

    const assignee = await render(NextStepCard, {
      state: 'IN_REVIEW',
      myRole: 'ASSIGNEE',
      nextActions: [],
    });
    expect(assignee.html).toContain('等待提出者验收');
  });

  it('无关账号 → 明确告知无关', async () => {
    const { html } = await render(NextStepCard, {
      state: 'IN_PROGRESS',
      myRole: 'IRRELEVANT',
      nextActions: [],
    });
    expect(html).toContain('你与这条需求无关');
  });

  it('已完成 → 终态语气，且不带任何可执行引导', async () => {
    const { html } = await render(NextStepCard, {
      state: 'COMPLETED',
      myRole: 'PROPOSER',
      nextActions: [],
    });
    expect(html).toContain('需求已完成');
    expect(html).toContain('is-done');
    expect(html).not.toContain('下一步');
  });
});

// ─────────────────────────────────────────────────────────────
// CriteriaList：只读 / 带检查结果两种形态
// ─────────────────────────────────────────────────────────────

describe('CriteriaList', () => {
  it('渲染全部条件并带序号', async () => {
    const { html } = await render(CriteriaList, { criteria });
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).toContain('支持按状态筛选');
    expect(html).toContain('导出为 CSV');
    expect(html).toContain('>3<');
  });

  it('传入 checks 时渲染勾选 / 未勾选图标，未传入时不出现检查标记', async () => {
    const withChecks = await render(CriteriaList, {
      criteria,
      checks: { c1: true, c2: false, c3: true },
    });
    // 断言的是**语义**（aria-label）而不是某个字形 —— 图标从 emoji 换成内联 SVG 时
    // 这条测试不该跟着改。字形断言会把「实现细节」写进测试里。
    expect(withChecks.html).toContain('aria-label="通过"');
    expect(withChecks.html).toContain('aria-label="未通过"');
    // 结构上确认渲染的是 SVG 图标而非文字
    expect(withChecks.html).toContain('class="icon"');

    const readonly = await render(CriteriaList, { criteria });
    expect(readonly.html).not.toContain('class="icon"');
  });
});

// ─────────────────────────────────────────────────────────────
// SubmissionCard：历史追溯 —— Vn 独立、退回原因与逐项结果都在
// ─────────────────────────────────────────────────────────────

const submission: Submission = {
  id: 's1',
  submissionNo: 2,
  note: '已补充错误提示文案',
  submittedAt: '2026-10-05T06:00:00.000Z',
  submittedBy: { id: 'u2', name: '鲍勃', account: 'bob' },
  artifacts: [
    { seq: 1, url: 'https://github.com/org/repo/pull/12' },
    { seq: 2, url: 'https://example.com/demo' },
  ],
  reviews: [
    {
      action: 'RETURN',
      reason: '第 2 条未实现',
      reviewedAt: '2026-10-05T07:00:00.000Z',
      reviewer: { id: 'u1', name: '爱丽丝', account: 'alice' },
      checks: [
        { criterionId: 'c1', passed: true },
        { criterionId: 'c2', passed: false },
      ],
    },
  ],
};

describe('SubmissionCard：单次提交独立留痕', () => {
  it('渲染版本号、提交人、完成说明与全部成果链接', async () => {
    const { html } = await render(SubmissionCard, {
      submission,
      isCurrent: false,
      criterionText: { c1: '1. 支持按状态筛选', c2: '2. 失败场景有明确错误提示' },
    });
    expect(html).toContain('V2');
    expect(html).toContain('鲍勃');
    expect(html).toContain('已补充错误提示文案');
    expect(html).toContain('https://github.com/org/repo/pull/12');
    expect(html).toContain('https://example.com/demo');
  });

  it('展示退回原因与逐项验收结果（把 criterionId 还原成可读条件）', async () => {
    const { html } = await render(SubmissionCard, {
      submission,
      isCurrent: true,
      criterionText: { c1: '1. 支持按状态筛选', c2: '2. 失败场景有明确错误提示' },
    });
    expect(html).toContain('退回修改');
    expect(html).toContain('第 2 条未实现');
    expect(html).toContain('1. 支持按状态筛选');
    expect(html).toContain('class="pass check-mark"');
    expect(html).toContain('class="fail check-mark"');
    expect(html).toContain('当前提交');
  });

  it('isCurrent 为 false 时不显示「当前提交」标记', async () => {
    const { html } = await render(SubmissionCard, {
      submission,
      isCurrent: false,
      criterionText: {},
    });
    expect(html).not.toContain('当前提交');
  });

  it('未验收的提交给出明确说明，而不是留白', async () => {
    const { html } = await render(SubmissionCard, {
      submission: { ...submission, reviews: [] },
      isCurrent: true,
      criterionText: {},
    });
    expect(html).toContain('这一版还没有验收结论');
  });
});

// ─────────────────────────────────────────────────────────────
// EventTimeline
// ─────────────────────────────────────────────────────────────

describe('EventTimeline', () => {
  it('渲染事件序号、操作者与中文事件名', async () => {
    const events: DomainEvent[] = [
      {
        seq: 1,
        eventType: 'CREATED',
        actor: { id: 'u1', name: '爱丽丝', account: 'alice' },
        payload: null,
        createdAt: '2026-10-05T05:00:00.000Z',
      },
      {
        seq: 2,
        eventType: 'SUBMITTED',
        actor: { id: 'u2', name: '鲍勃', account: 'bob' },
        payload: null,
        createdAt: '2026-10-05T06:00:00.000Z',
      },
    ];
    const { html } = await render(EventTimeline, { events });
    expect(html).toContain('#1');
    expect(html).toContain('#2');
    expect(html).toContain('爱丽丝');
    expect(html).toContain('创建了需求');
    expect(html).toContain('提交了成果');
  });

  it('未知事件类型回退为原始类型名，不渲染成空', async () => {
    const { html } = await render(EventTimeline, {
      events: [
        {
          seq: 9,
          eventType: 'FUTURE_EVENT',
          actor: { id: 'u1', name: '爱丽丝', account: 'alice' },
          payload: null,
          createdAt: '2026-10-05T05:00:00.000Z',
        },
      ],
    });
    expect(html).toContain('FUTURE_EVENT');
  });
});

// ─────────────────────────────────────────────────────────────
// 基础展示组件：徽标 / 角色 / 提示 / 空态 / 表单
// ─────────────────────────────────────────────────────────────

describe('StatusBadge / RoleTag', () => {
  it('徽标带上状态类名，颜色由 CSS 决定', async () => {
    const { html } = await render(StatusBadge, { state: 'IN_REVIEW', label: '待验收' });
    expect(html).toContain('badge IN_REVIEW');
    expect(html).toContain('待验收');
  });

  it('角色标签仅对提出者/负责人渲染', async () => {
    const proposer = await render(RoleTag, { role: 'PROPOSER' });
    expect(proposer.html).toContain('提出者');
    expect(proposer.html).toContain('role-PROPOSER');

    // 无关角色不渲染任何标签元素（SSR 会留下 <!----> 占位注释，故断言元素而非字符串为空）
    const irrelevant = await render(RoleTag, { role: 'IRRELEVANT' });
    expect(irrelevant.html).not.toContain('<span');
  });
});

describe('AlertBox：语义与 role 必须匹配', () => {
  it('错误用 role=alert（立即播报）', async () => {
    const { html } = await render(AlertBox, { kind: 'error' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('alert-error');
  });

  it('普通信息用 role=status（礼貌播报，不打断）', async () => {
    const { html } = await render(AlertBox, { kind: 'info' });
    expect(html).toContain('role="status"');
  });
});

describe('EmptyState', () => {
  it('标题与说明都渲染', async () => {
    const { html } = await render(EmptyState, {
      title: '没有符合条件的需求',
      desc: '试试放宽筛选条件',
    });
    expect(html).toContain('没有符合条件的需求');
    expect(html).toContain('试试放宽筛选条件');
  });
});

describe('FormField', () => {
  it('渲染标签、必填标记、计数与提示', async () => {
    const { html } = await render(FormField, {
      label: '标题',
      required: true,
      hint: '一句话说明需求',
      counter: '3 / 200',
      forId: 'title',
    });
    expect(html).toContain('for="title"');
    expect(html).toContain('标题');
    expect(html).toContain('field-required');
    expect(html).toContain('3 / 200');
    expect(html).toContain('一句话说明需求');
  });

  it('有错误时错误优先于提示，并带 role=alert', async () => {
    const { html } = await render(FormField, {
      label: '标题',
      hint: '一句话说明需求',
      error: '请填写标题',
    });
    expect(html).toContain('请填写标题');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('一句话说明需求');
  });
});

// ─────────────────────────────────────────────────────────────
// ReviewPanel：验收链路的初始状态（弹窗内容经 Teleport 输出）
// ─────────────────────────────────────────────────────────────

describe('ReviewPanel：打开时的初始状态', () => {
  it('全部条件默认未通过，进度为 0，且「确认完成」被禁用', async () => {
    const { teleported } = await render(ReviewPanel, {
      modelValue: true,
      criteria,
      submissionNo: 1,
      busy: false,
    });

    expect(teleported).toContain('逐项验收 · V1');
    expect(teleported).toContain('已通过 0 / 3');
    expect(teleported).toContain('支持按状态筛选');
    expect(teleported).toContain('导出为 CSV');
    expect(teleported).toContain('确认完成');
    expect(teleported).toContain('退回修改');

    // 只有「确认完成」一个按钮带 disabled（存在未通过项时不得提交）
    expect(teleported.match(/<button[^>]*\bdisabled\b/g) ?? []).toHaveLength(1);
  });

  it('未打开时不渲染任何弹窗内容', async () => {
    const { teleported } = await render(ReviewPanel, {
      modelValue: false,
      criteria,
      submissionNo: 1,
      busy: false,
    });
    // 只剩 Teleport 的锚点注释，无任何弹窗内容
    expect(teleported).not.toContain('逐项验收');
    expect(teleported).not.toContain('确认完成');
  });

  it('校验失败时给出可读提示位（服务端错误由 serverError 传入）', async () => {
    const { teleported } = await render(ReviewPanel, {
      modelValue: true,
      criteria,
      submissionNo: 3,
      busy: false,
      serverError: '存在未通过的验收条件，不能确认完成',
    });
    expect(teleported).toContain('存在未通过的验收条件，不能确认完成');
    expect(teleported).toContain('逐项验收 · V3');
  });
});
