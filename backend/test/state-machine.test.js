/**
 * 状态机测试 —— 对应代码审查标准 §3.G 第 4 类「状态机」
 *
 * 覆盖：全部合法流转 + 全部非法流转被拒 + 终态不可逆。
 * 直接测试编译产物 dist/，因此无需任何额外测试依赖（Node 内置 node:test）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RequirementState,
  ALL_STATES,
  STATE_LABEL,
  NEXT_STATE,
  isState,
  isTerminal,
  stateAllows,
  nextActionsFor,
} = require('../dist/domain/states.js');

const ALL_COMMANDS = ['EDIT', 'START', 'SUBMIT', 'REVIEW_RETURN', 'REVIEW_COMPLETE'];

test('状态集合封闭：恰好 4 个状态', () => {
  assert.equal(ALL_STATES.length, 4);
  assert.deepEqual([...ALL_STATES].sort(), ['COMPLETED', 'IN_PROGRESS', 'IN_REVIEW', 'PENDING']);
});

test('每个状态都有非空中文文案', () => {
  for (const s of ALL_STATES) {
    assert.equal(typeof STATE_LABEL[s], 'string');
    assert.ok(STATE_LABEL[s].length > 0, `${s} 缺少文案`);
  }
});

test('合法流转链路：待处理 → 进行中 → 待验收 → 已完成', () => {
  assert.equal(NEXT_STATE.START, RequirementState.IN_PROGRESS);
  assert.equal(NEXT_STATE.SUBMIT, RequirementState.IN_REVIEW);
  assert.equal(NEXT_STATE.REVIEW_COMPLETE, RequirementState.COMPLETED);
});

test('退回回路：待验收 → 进行中', () => {
  assert.equal(NEXT_STATE.REVIEW_RETURN, RequirementState.IN_PROGRESS);
  assert.ok(stateAllows(RequirementState.IN_REVIEW, 'REVIEW_RETURN'));
});

test('状态守卫：每个动作只在其前置状态可用', () => {
  // 合法
  assert.ok(stateAllows('PENDING', 'EDIT'));
  assert.ok(stateAllows('PENDING', 'START'));
  assert.ok(stateAllows('IN_PROGRESS', 'SUBMIT'));
  assert.ok(stateAllows('IN_REVIEW', 'REVIEW_COMPLETE'));
  assert.ok(stateAllows('IN_REVIEW', 'REVIEW_RETURN'));

  // 非法 —— 关键是「开始后正文与验收条件冻结」
  assert.ok(!stateAllows('IN_PROGRESS', 'EDIT'), '开始处理后不应还能编辑');
  assert.ok(!stateAllows('IN_REVIEW', 'EDIT'));
  assert.ok(!stateAllows('COMPLETED', 'EDIT'));

  // 非法 —— 不能跳级
  assert.ok(!stateAllows('PENDING', 'SUBMIT'), '待处理不能直接提交');
  assert.ok(!stateAllows('PENDING', 'REVIEW_COMPLETE'));
  assert.ok(!stateAllows('IN_PROGRESS', 'START'));
  assert.ok(!stateAllows('IN_PROGRESS', 'REVIEW_COMPLETE'));
  assert.ok(!stateAllows('IN_REVIEW', 'SUBMIT'), '待验收不能再次提交');
  assert.ok(!stateAllows('IN_REVIEW', 'START'));
});

test('终态不可逆：已完成后任何推进或退回都被拒绝', () => {
  assert.ok(isTerminal(RequirementState.COMPLETED));
  assert.ok(!isTerminal(RequirementState.IN_REVIEW));

  for (const cmd of ALL_COMMANDS) {
    assert.ok(!stateAllows(RequirementState.COMPLETED, cmd), `已完成状态下 ${cmd} 不应被允许`);
  }
});

test('nextActionsFor：按「状态 + 角色」给出下一步，避免用户猜', () => {
  assert.deepEqual(nextActionsFor('PENDING', 'PROPOSER'), ['EDIT']);
  assert.deepEqual(nextActionsFor('PENDING', 'ASSIGNEE'), ['START']);
  assert.deepEqual(nextActionsFor('IN_PROGRESS', 'ASSIGNEE'), ['SUBMIT']);
  assert.deepEqual(nextActionsFor('IN_PROGRESS', 'PROPOSER'), []);
  assert.deepEqual(nextActionsFor('IN_REVIEW', 'PROPOSER'), ['REVIEW_RETURN', 'REVIEW_COMPLETE']);
  assert.deepEqual(nextActionsFor('IN_REVIEW', 'ASSIGNEE'), [], '负责人不能验收');
  assert.deepEqual(nextActionsFor('COMPLETED', 'PROPOSER'), [], '终态无下一步');
  assert.deepEqual(nextActionsFor('COMPLETED', 'ASSIGNEE'), []);
  assert.deepEqual(nextActionsFor('PENDING', 'IRRELEVANT'), []);
  assert.deepEqual(nextActionsFor('IN_REVIEW', 'IRRELEVANT'), []);
});

test('isState 大小写敏感，拒绝非法取值', () => {
  assert.ok(isState('PENDING'));
  assert.ok(isState('COMPLETED'));
  assert.ok(!isState('pending'), '小写不应被接受');
  assert.ok(!isState('DONE'));
  assert.ok(!isState(''));
  assert.ok(!isState('PENDING '), '带空格不应被接受');
});
