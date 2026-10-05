/**
 * 权限测试 —— 对应代码审查标准 §3.G 第 1 类「权限」
 *
 * 核心断言：404 / 403 / 409 三种拒绝语义必须严格分离。
 *  - 无关账号          → 404（防枚举：不能让人试出「这条需求存在」）
 *  - 可见但角色不符    → 403
 *  - 可见、角色对但状态不符 → 409
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  roleOf,
  assertCanRead,
  assertCanPerform,
  assertRoleCanPerform,
  assertStateCanPerform,
  visibilityFilter,
} = require('../dist/domain/policy.js');
const { AppError, Errors } = require('../dist/core/errors.js');

/** A 提出、B 负责、C 无关 */
const req = { proposerId: 'A', assigneeId: 'B' };

const statusOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.status : `非 AppError: ${e.constructor.name}`;
  }
  return 'no-throw';
};

test('roleOf：角色从资源行现场推导，同一人在不同需求可为不同角色', () => {
  assert.equal(roleOf('A', req), 'PROPOSER');
  assert.equal(roleOf('B', req), 'ASSIGNEE');
  assert.equal(roleOf('C', req), 'IRRELEVANT');

  // 同一个人换一条需求就换角色
  const other = { proposerId: 'B', assigneeId: 'A' };
  assert.equal(roleOf('A', other), 'ASSIGNEE');
  assert.equal(roleOf('B', other), 'PROPOSER');
});

test('读权限：无关账号返回 404 而不是 403（防枚举）', () => {
  assert.equal(assertCanRead('A', req), 'PROPOSER');
  assert.equal(assertCanRead('B', req), 'ASSIGNEE');
  assert.equal(
    statusOf(() => assertCanRead('C', req)),
    404,
  );
});

test('写权限：无关账号一律 404', () => {
  for (const cmd of ['EDIT', 'START', 'SUBMIT', 'REVIEW_RETURN', 'REVIEW_COMPLETE']) {
    assert.equal(
      statusOf(() => assertCanPerform('C', req, 'IN_REVIEW', cmd)),
      404,
      cmd,
    );
  }
});

test('写权限：可见但角色不符返回 403', () => {
  // 负责人不能代替提出者验收
  assert.equal(
    statusOf(() => assertCanPerform('B', req, 'IN_REVIEW', 'REVIEW_COMPLETE')),
    403,
  );
  assert.equal(
    statusOf(() => assertCanPerform('B', req, 'IN_REVIEW', 'REVIEW_RETURN')),
    403,
  );
  // 提出者不能开始处理 / 提交成果
  assert.equal(
    statusOf(() => assertCanPerform('A', req, 'PENDING', 'START')),
    403,
  );
  assert.equal(
    statusOf(() => assertCanPerform('A', req, 'IN_PROGRESS', 'SUBMIT')),
    403,
  );
  // 负责人不能编辑需求
  assert.equal(
    statusOf(() => assertCanPerform('B', req, 'PENDING', 'EDIT')),
    403,
  );
});

test('写权限：角色对但状态不符返回 409', () => {
  // 负责人在非进行中状态提交
  assert.equal(
    statusOf(() => assertCanPerform('B', req, 'PENDING', 'SUBMIT')),
    409,
  );
  assert.equal(
    statusOf(() => assertCanPerform('B', req, 'IN_REVIEW', 'SUBMIT')),
    409,
  );
  // 负责人在非待处理状态开始
  assert.equal(
    statusOf(() => assertCanPerform('B', req, 'IN_PROGRESS', 'START')),
    409,
  );
  // 提出者在非待处理状态编辑（开始后冻结）
  assert.equal(
    statusOf(() => assertCanPerform('A', req, 'IN_PROGRESS', 'EDIT')),
    409,
  );
  // 提出者在非待验收状态验收
  assert.equal(
    statusOf(() => assertCanPerform('A', req, 'PENDING', 'REVIEW_COMPLETE')),
    409,
  );
  assert.equal(
    statusOf(() => assertCanPerform('A', req, 'IN_PROGRESS', 'REVIEW_RETURN')),
    409,
  );
});

test('终态：已完成后，本可执行该动作的角色也一律 409（终态不可逆）', () => {
  // 关键：必须用「该动作原本允许的角色」来验证终态，
  // 否则会先被角色检查拦成 403，测不到终态逻辑。
  // 判定优先级：404（不可见）→ 403（角色不符）→ 409（状态不符）
  const allowedRoleFor = {
    EDIT: 'A', // 提出者
    START: 'B', // 负责人
    SUBMIT: 'B',
    REVIEW_RETURN: 'A',
    REVIEW_COMPLETE: 'A',
  };

  for (const [cmd, actor] of Object.entries(allowedRoleFor)) {
    assert.equal(
      statusOf(() => assertCanPerform(actor, req, 'COMPLETED', cmd)),
      409,
      `${actor}/${cmd} 在已完成状态下应返回 409`,
    );
  }

  // 角色本身就不允许的组合，仍返回 403（角色检查优先于状态检查）
  assert.equal(
    statusOf(() => assertCanPerform('B', req, 'COMPLETED', 'EDIT')),
    403,
  );
  assert.equal(
    statusOf(() => assertCanPerform('A', req, 'COMPLETED', 'SUBMIT')),
    403,
  );

  // 终态拒绝必须给出可理解文案，而不是笼统的「不允许」
  assert.throws(
    () => assertCanPerform('B', req, 'COMPLETED', 'SUBMIT'),
    (e) => e.status === 409 && /已完成/.test(e.message),
  );
});

test('合法调用：返回调用者在该需求上的角色', () => {
  assert.equal(assertCanPerform('B', req, 'PENDING', 'START'), 'ASSIGNEE');
  assert.equal(assertCanPerform('B', req, 'IN_PROGRESS', 'SUBMIT'), 'ASSIGNEE');
  assert.equal(assertCanPerform('A', req, 'PENDING', 'EDIT'), 'PROPOSER');
  assert.equal(assertCanPerform('A', req, 'IN_REVIEW', 'REVIEW_COMPLETE'), 'PROPOSER');
  assert.equal(assertCanPerform('A', req, 'IN_REVIEW', 'REVIEW_RETURN'), 'PROPOSER');
});

test('未登记命令被拒绝，而不是抛 TypeError 变成 500（审查 R-04）', () => {
  // 修复前：ACTION_ROLES['CREATE'] 为 undefined，调用 .includes 抛 TypeError → 500
  assert.equal(
    statusOf(() => assertCanPerform('A', req, 'PENDING', 'CREATE')),
    403,
  );
  assert.equal(
    statusOf(() => assertCanPerform('A', req, 'PENDING', 'NOT_A_COMMAND')),
    403,
  );
  assert.equal(
    statusOf(() => assertCanPerform('A', req, 'PENDING', '')),
    403,
  );
  assert.equal(
    statusOf(() => assertCanPerform('A', req, 'PENDING', undefined)),
    403,
  );
});

test('列表可见性过滤：在 SQL 层用 OR 包裹，仅返回本人相关需求', () => {
  const filter = visibilityFilter('A');
  assert.deepEqual(filter, { OR: [{ proposerId: 'A' }, { assigneeId: 'A' }] });
});

// ─────────────────────────────────────────────────────────────
// 角色 / 状态两段拆分：让版本校验（412）能插在两者之间
// ─────────────────────────────────────────────────────────────

test('角色段：不可见 404、角色不符 403 —— 与合并版行为一致', () => {
  assert.equal(
    statusOf(() => assertRoleCanPerform('C', req, 'EDIT')),
    404,
  );
  assert.equal(
    statusOf(() => assertRoleCanPerform('B', req, 'EDIT')),
    403,
  );
  assert.equal(
    statusOf(() => assertRoleCanPerform('A', req, 'EDIT')),
    'no-throw',
  );
  assert.equal(
    statusOf(() => assertRoleCanPerform('A', req, 'CREATE')),
    403,
  );
});

test('状态段：角色对但状态不符 → 409；终态给出更明确的文案', () => {
  assert.equal(
    statusOf(() => assertStateCanPerform('IN_PROGRESS', 'EDIT')),
    409,
  );
  assert.equal(
    statusOf(() => assertStateCanPerform('PENDING', 'SUBMIT')),
    409,
  );
  assert.equal(
    statusOf(() => assertStateCanPerform('PENDING', 'EDIT')),
    'no-throw',
  );

  // 终态：文案应点明「已完成」，而不是笼统的「状态不允许」
  try {
    assertStateCanPerform('COMPLETED', 'REVIEW_RETURN');
    assert.fail('终态应被拒绝');
  } catch (e) {
    assert.equal(e.status, 409);
    assert.match(e.message, /已完成/);
  }
});

test('★ 判定顺序：可见性 → 角色 → 版本 → 状态（412 不再被 409 抢先）', () => {
  // 复现 DEM-02 的真实场景：alice（提出者）手里是旧页面（version 1），
  // 而需求已被 bob 开始处理（IN_PROGRESS，version 3）。
  const state = 'IN_PROGRESS';
  const command = 'EDIT';
  const clientVersion = 1;
  const serverVersion = 3;

  // 旧写法（角色+状态合并）会先命中状态守卫 → 409，把「版本过期」误报成「状态不允许」
  assert.equal(
    statusOf(() => assertCanPerform('A', req, state, command)),
    409,
  );

  // 新顺序：角色通过 → 版本不符 → 412（正确的语义）
  assert.equal(
    statusOf(() => {
      assertRoleCanPerform('A', req, command);
      if (serverVersion !== clientVersion) throw Errors.stale();
      assertStateCanPerform(state, command);
    }),
    412,
  );

  // 而不可见账号即使版本也过期，仍必须先回 404 —— 否则可用 412/409 的差异枚举资源存在性
  assert.equal(
    statusOf(() => {
      assertRoleCanPerform('C', req, command);
      if (serverVersion !== clientVersion) throw Errors.stale();
      assertStateCanPerform(state, command);
    }),
    404,
  );
});
