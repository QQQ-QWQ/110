// @vitest-environment happy-dom
/**
 * DEM-09 的前端一半：**保存失败后，输入保留、提示可理解、仅成功后清空**
 *
 * ## 为什么这个文件要单独指定 DOM 环境
 *
 * 其余前端测试是**纯 SSR 渲染断言**（`vue/server-renderer` + `renderToString`），
 * 它们能验证「渲染出什么」，但**无法模拟交互序列** —— 而 DEM-09 要求的恰恰是一个序列：
 *
 *     打开弹窗 → 填入内容 → 提交 → 失败 → 输入还在吗？
 *
 * 这是 10 个 DEM 用例里**唯一**缺少自动化证据的一条（见《测试与验证记录》§17.2）。
 * 本文件补上它：用 happy-dom 挂载真实组件、驱动真实点击与输入、mock 掉网络层。
 *
 * ## 为什么要挂载整个 DetailView 而不是更小的单元
 *
 * 「失败不清空」这条性质**不在任何一个函数里**，而是分散在三处协作中：
 *   · `doSubmit()` 只在 `ok === true` 时关闭弹窗；
 *   · 失败走 `settleFailure()`，把文案写进 `submitFormError`，**不动表单**；
 *   · 表单重置只发生在 `openSubmit()`（即**下次打开时**）。
 * 任何「抽出一个小函数来测」的做法都会把这三处的协作关系丢掉 ——
 * 那样测的是我抽出来的东西，不是真正运行的那条路径。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';

/** vi.mock 会被提升到 import 之前，因此共享的 mock 必须用 vi.hoisted 定义 */
const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  submit: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    // 只替换网络层；ApiError / isRefreshable 等保持真实实现，
    // 否则「可刷新错误才重载」这类判断就测不到了
    api: { ...actual.api, detail: mocks.detail, submit: mocks.submit },
  };
});

import DetailView from './DetailView.vue';
import { ApiError } from '../api';
import type { RequirementDetail } from '../types';

/** 进行中 + 我是负责人 → `nextActions` 含 SUBMIT，页面才会出现「提交成果」 */
function processingFixture(): RequirementDetail {
  return {
    id: 'req-dem09',
    title: '端到端验证需求',
    description: '用于 DEM-09 的样例说明',
    state: 'IN_PROGRESS',
    stateLabel: '进行中',
    rowVersion: 3,
    proposer: { id: 'u1', name: '爱丽丝', account: 'alice' },
    assignee: { id: 'u2', name: '鲍勃', account: 'bob' },
    criteria: [{ id: 'c1', seq: 1, text: '条件一' }],
    currentSubmissionId: null,
    currentSubmission: null,
    submissions: [],
    submissionsTotal: 0,
    submissionsHasMore: false,
    events: [],
    eventsTotal: 0,
    eventsHasMore: false,
    eventsLimit: 20,
    myRole: 'ASSIGNEE',
    nextActions: ['SUBMIT'],
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
  };
}

/**
 * 等异步链路落定。
 *
 * 除了微任务，还要**让出一个真实宏任务**：弹窗用 `<Transition>` 包裹，
 * 关闭时元素要等过渡结束才从 DOM 移除，而 happy-dom 不会派发 `transitionend`
 * —— 只 await nextTick 会看到「已经关了但元素还在」的假象。
 */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await nextTick();
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

/** 按可见文字找按钮 —— 比依赖 class 更稳，也更接近用户实际点击的东西 */
function buttonByText(text: string, root: ParentNode = document.body): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(text),
  );
  if (!found) throw new Error(`找不到文字包含「${text}」的按钮`);
  return found as HTMLButtonElement;
}

/**
 * 弹窗根节点。
 *
 * **必须把「提交」按钮的查找限定在弹窗内** —— 弹窗外的「提交**成果**」按钮
 * 也包含「提交」二字，而它在 DOM 里排在前面。第一版没限定范围，
 * 于是 `buttonByText('提交')` 点到的是那个**打开弹窗**的按钮：
 * `openSubmit()` 会重置表单，测试于是看到「输入被清空了」这个**假象**。
 * 这类「选错了元素」是 DOM 测试最常见的假失败来源。
 */
function modal(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.modal');
  if (!el) throw new Error('弹窗未打开');
  return el;
}

/** 模拟用户输入：直接改 value 不会触发 v-model，必须派发 input 事件 */
function typeInto(el: HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const ARTIFACT = 'https://github.com/org/repo/pull/12';
const NOTE = '已实现导出功能，验证步骤见链接。';

describe('DEM-09（前端）：保存失败保留输入可重试', () => {
  let app: App | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.detail.mockReset().mockResolvedValue(processingFixture());
    mocks.submit.mockReset();
    app = null;
  });

  async function mountAndOpenSubmitForm(): Promise<void> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    app = createApp(DetailView, { id: 'req-dem09' });
    app.mount(host);
    await flush();

    buttonByText('提交成果', host).click();
    await flush();

    const artifacts = document.querySelector('#submit-artifacts') as HTMLTextAreaElement;
    const note = document.querySelector('#submit-note') as HTMLTextAreaElement;
    expect(artifacts, '提交弹窗应已打开').toBeTruthy();
    typeInto(artifacts, ARTIFACT);
    typeInto(note, NOTE);
    await flush(2);
  }

  it('提交失败：弹窗不关闭、输入一字不动、给出可读文案', async () => {
    mocks.submit.mockRejectedValueOnce(
      new ApiError(500, 'INTERNAL_ERROR', '服务器内部错误，请稍后重试'),
    );

    await mountAndOpenSubmitForm();
    buttonByText('提交', modal()).click();
    await flush();

    // ① 弹窗没有关闭
    expect(document.querySelector('#submit-artifacts'), '失败后弹窗必须留在原地').toBeTruthy();
    // ② 输入**一字不动** —— 这正是 DEM-09 要求的「保留可重试」
    expect((document.querySelector('#submit-artifacts') as HTMLTextAreaElement).value).toBe(ARTIFACT);
    expect((document.querySelector('#submit-note') as HTMLTextAreaElement).value).toBe(NOTE);
    // ③ 失败原因可读，且出现在弹窗里（而不是只在转瞬即逝的 toast 里）
    expect(document.querySelector('.modal')?.textContent).toContain('服务器内部错误');
  });

  it('失败后可以直接原地重试，且重试成功后弹窗才关闭', async () => {
    mocks.submit
      .mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', '服务器内部错误，请稍后重试'))
      .mockResolvedValueOnce({ id: 'sub-1' });

    await mountAndOpenSubmitForm();
    buttonByText('提交', modal()).click();
    await flush();
    expect(document.querySelector('#submit-artifacts')).toBeTruthy(); // 仍开着

    // 原地再点一次 —— 输入还在，不需要重新填
    buttonByText('提交', modal()).click();
    await flush();

    expect(mocks.submit).toHaveBeenCalledTimes(2);
    // 第二次提交的载荷与第一次完全一致 —— 证明「重试」用的还是用户原来那份输入
    expect(mocks.submit.mock.calls[0]?.[1]).toEqual(mocks.submit.mock.calls[1]?.[1]);
    // 关闭是**过渡结束后**才从 DOM 移除的，用条件等待而不是固定 sleep
    await vi.waitFor(() =>
      expect(document.querySelector('#submit-artifacts'), '成功后弹窗应关闭').toBeNull(),
    );
  });

  it('只有成功才清空：关闭后重新打开，表单是空的（而不是残留上次内容）', async () => {
    mocks.submit.mockResolvedValueOnce({ id: 'sub-1' });

    await mountAndOpenSubmitForm();
    buttonByText('提交', modal()).click();
    await vi.waitFor(() => expect(document.querySelector('#submit-artifacts')).toBeNull());

    buttonByText('提交成果').click();
    await flush();
    expect((document.querySelector('#submit-artifacts') as HTMLTextAreaElement).value).toBe('');
    expect((document.querySelector('#submit-note') as HTMLTextAreaElement).value).toBe('');
  });

  it('失败属于「可刷新」类（412）时，会重新拉取详情拿到最新版本号', async () => {
    mocks.submit.mockRejectedValueOnce(new ApiError(412, 'PRECONDITION_FAILED', '版本已过期'));
    const detailCallsBefore = mocks.detail.mock.calls.length;

    await mountAndOpenSubmitForm();
    buttonByText('提交', modal()).click();
    await flush();

    // 412 说明本地 rowVersion 已陈旧 —— 必须自动刷新，否则用户重试还是失败
    expect(mocks.detail.mock.calls.length).toBeGreaterThan(detailCallsBefore);
    // 而输入仍然保留（刷新只更新 rowVersion，不动表单）
    expect((document.querySelector('#submit-artifacts') as HTMLTextAreaElement).value).toBe(ARTIFACT);
  });

  it('校验不通过时**不发请求**，错误就地提示', async () => {
    await mountAndOpenSubmitForm();
    // 把成果链接改成非法值
    typeInto(document.querySelector('#submit-artifacts') as HTMLTextAreaElement, 'ftp://bad');
    await flush(2);

    buttonByText('提交', modal()).click();
    await flush();

    expect(mocks.submit, '前端校验拦住时不应打后端').not.toHaveBeenCalled();
    expect(document.querySelector('#submit-artifacts')).toBeTruthy();
  });
});
