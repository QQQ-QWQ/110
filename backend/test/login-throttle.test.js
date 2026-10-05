/**
 * 登录失败限流测试 —— 报告 §5.2 S7
 *
 * 与并发闸门的分工：闸门管**容量**（在途 bcrypt 数，满了 → 503），
 * 限流管**配额**（某来源连续失败次数，超了 → 429）。两者回答不同的问题，
 * 返回码也必须不同 —— 429 告诉客户端「别再试了」，503 告诉它「稍后再试」。
 *
 * 这里要钉死的边界行为：
 *  · 达到阈值才封禁（不是差一次就封）；
 *  · 封禁**到期后计数从头开始**，否则一解禁就又被立刻封禁（永久锁死）；
 *  · 成功必须清零，否则「错几次后成功」会被累计，用户下次正常登录莫名 429；
 *  · **锁绑在 (账号, IP) 上** —— 否则攻击者能拿别人的账号当武器把其锁在门外；
 *  · 键数量有上限 —— 否则海量随机账号能把内存撑爆，等于用限流本身做了一次 DoS。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { LoginThrottle, throttleKeyOf } = require('../dist/domain/login-throttle.js');
const { AuthService } = require('../dist/modules/auth/auth.service.js');

const CFG = { maxFailures: 3, windowMs: 60_000, lockoutMs: 30_000 };
const T0 = 1_700_000_000_000; // 固定时刻，避免依赖真实时间
const IP = '203.0.113.7';

// ─────────────────────────────────────────────────────────────
// 键
// ─────────────────────────────────────────────────────────────

test('限流键 = 账号 + IP；大小写与首尾空白被归一化', () => {
  assert.equal(throttleKeyOf('alice', IP), `alice|${IP}`);
  // 归一化：否则 Alice / alice / " alice " 各开一份计数，变个大小写就把阈值放大三倍
  assert.equal(throttleKeyOf('Alice', IP), throttleKeyOf('alice', IP));
  assert.equal(throttleKeyOf('  alice  ', IP), throttleKeyOf('alice', IP));
  // IP 缺失时不应崩，也不应把所有请求混成一类
  assert.equal(throttleKeyOf('alice', undefined), 'alice|unknown');
});

// ─────────────────────────────────────────────────────────────
// 计数与封禁
// ─────────────────────────────────────────────────────────────

test('未达阈值不封禁', () => {
  const t = new LoginThrottle(CFG);
  const key = throttleKeyOf('alice', IP);

  t.recordFailure(key, T0);
  assert.equal(t.retryAfterSeconds(key, T0), 0);
  t.recordFailure(key, T0 + 1);
  assert.equal(t.retryAfterSeconds(key, T0 + 1), 0, '3 次阈值下，2 次失败不应封禁');
});

test('★ 达到阈值即封禁，并给出剩余秒数', () => {
  const t = new LoginThrottle(CFG);
  const key = throttleKeyOf('alice', IP);

  t.recordFailure(key, T0);
  t.recordFailure(key, T0 + 1);
  t.recordFailure(key, T0 + 2); // 第 3 次 → 封禁

  const retryAfter = t.retryAfterSeconds(key, T0 + 3);
  assert.ok(retryAfter > 0, '达到阈值后必须处于封禁中');
  assert.equal(retryAfter, 30, `封禁 30s，剩余应为 30，实际 ${retryAfter}`);

  // assertNotLocked 应抛 429，并把剩余秒数带上（供 Retry-After 使用）
  const err = (() => {
    try {
      t.assertNotLocked(key, T0 + 3);
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.equal(err?.status, 429);
  assert.equal(err?.code, 'TOO_MANY_REQUESTS');
  assert.equal(err?.retryAfterSeconds, 30);
});

test('★ 封禁到期后计数从头开始（否则一解禁就又被立刻封禁，等于永久锁死）', () => {
  const t = new LoginThrottle(CFG);
  const key = throttleKeyOf('alice', IP);

  for (let i = 0; i < CFG.maxFailures; i += 1) t.recordFailure(key, T0 + i);
  assert.ok(t.retryAfterSeconds(key, T0 + 5) > 0);

  // 封禁从「第 maxFailures 次失败」的时刻起算，因此截止 = T0 + (maxFailures-1) + lockoutMs
  const afterLockout = T0 + (CFG.maxFailures - 1) + CFG.lockoutMs + 1;
  assert.equal(t.retryAfterSeconds(key, afterLockout), 0, '封禁到期应放行');

  // 解禁后**一次**失败不应立刻又封禁（计数已清零）
  t.recordFailure(key, afterLockout);
  assert.equal(
    t.retryAfterSeconds(key, afterLockout + 1),
    0,
    '若解禁后残留计数，用户会被无限循环封禁 —— 这比不封禁更糟',
  );
});

test('★ 封禁期间再失败不会延长封禁（避免「越试越久」的意外）', () => {
  const t = new LoginThrottle(CFG);
  const key = throttleKeyOf('alice', IP);
  for (let i = 0; i < CFG.maxFailures; i += 1) t.recordFailure(key, T0 + i);

  const deadline = T0 + (CFG.maxFailures - 1) + CFG.lockoutMs;

  // 封禁期间又试了几次 —— 这些失败不得把截止时刻往后推
  t.recordFailure(key, T0 + 10);
  t.recordFailure(key, T0 + 20);

  assert.ok(t.retryAfterSeconds(key, deadline - 1) > 0, '截止前仍在封禁');
  assert.equal(
    t.retryAfterSeconds(key, deadline + 1),
    0,
    '截止后必须放行 —— 若失败会延长封禁，这里仍会 > 0，用户将永远等不到解禁',
  );
});

test('★ 成功必须清零，否则下次正常登录会被莫名 429', () => {
  const t = new LoginThrottle(CFG);
  const key = throttleKeyOf('alice', IP);

  t.recordFailure(key, T0);
  t.recordFailure(key, T0 + 1);
  t.recordSuccess(key);

  t.recordFailure(key, T0 + 2);
  assert.equal(t.retryAfterSeconds(key, T0 + 3), 0, '清零后重新累计，2 次失败不应封禁');
});

test('窗口之外的失败不计入（固定窗口会过期）', () => {
  const t = new LoginThrottle(CFG);
  const key = throttleKeyOf('alice', IP);

  t.recordFailure(key, T0);
  t.recordFailure(key, T0 + 1);
  // 第 3 次发生在窗口之外 → 前两次已被丢弃，不应封禁
  t.recordFailure(key, T0 + CFG.windowMs + 10);

  assert.equal(t.retryAfterSeconds(key, T0 + CFG.windowMs + 11), 0);
});

// ─────────────────────────────────────────────────────────────
// 键的隔离（安全相关）
// ─────────────────────────────────────────────────────────────

test('★ 同账号不同 IP 互不影响 —— 锁不能被用来把别人关在门外', () => {
  const t = new LoginThrottle(CFG);
  const attacker = throttleKeyOf('alice', '198.51.100.9');
  const victim = throttleKeyOf('alice', IP);

  for (let i = 0; i < CFG.maxFailures + 3; i += 1) t.recordFailure(attacker, T0 + i);

  assert.ok(t.retryAfterSeconds(attacker, T0 + 5) > 0, '攻击者自己被封');
  assert.equal(
    t.retryAfterSeconds(victim, T0 + 5),
    0,
    '受害者从自己的 IP 仍应能登录 —— 若这里被封，说明键退化成了「只按账号」',
  );
});

test('不同账号互不影响', () => {
  const t = new LoginThrottle(CFG);
  const a = throttleKeyOf('alice', IP);
  const b = throttleKeyOf('bob', IP);

  for (let i = 0; i < CFG.maxFailures; i += 1) t.recordFailure(a, T0 + i);

  assert.ok(t.retryAfterSeconds(a, T0 + 5) > 0);
  assert.equal(t.retryAfterSeconds(b, T0 + 5), 0);
});

test('★ 键数量有上限：超出后淘汰最久未使用的（防止海量随机账号撑爆内存）', () => {
  const t = new LoginThrottle(CFG, 3);

  for (let i = 0; i < 10; i += 1) t.recordFailure(throttleKeyOf(`user${i}`, IP), T0 + i);

  assert.equal(t.size, 3, '键数量必须被限制住，否则限流本身就成了内存 DoS');
  // 最近使用的三个应还在
  assert.ok(t.retryAfterSeconds(throttleKeyOf('user9', IP), T0 + 20) >= 0);
});

test('构造参数非法时直接抛错（配置错误应当启动即失败）', () => {
  assert.throws(
    () => new LoginThrottle({ maxFailures: 0, windowMs: 1, lockoutMs: 1 }),
    /maxFailures/,
  );
  assert.throws(() => new LoginThrottle({ maxFailures: 1, windowMs: 0, lockoutMs: 1 }), /windowMs/);
  assert.throws(
    () => new LoginThrottle({ maxFailures: 1, windowMs: 1, lockoutMs: 0 }),
    /lockoutMs/,
  );
});

// ─────────────────────────────────────────────────────────────
// 在 AuthService 中的位置：限流必须先于数据库查询
// ─────────────────────────────────────────────────────────────

function makeSessions() {
  return { create: async () => ({ sessionId: 'sess-1', expiresAt: new Date(T0 + 3_600_000) }) };
}
/** 用闸门桩替代真实的 bcrypt 校验：`ok` 决定密码是否正确 */
function makeGate(ok) {
  return { run: async () => ok };
}
function makePrisma(user) {
  const state = { calls: 0 };
  return {
    state,
    client: {
      user: {
        findUnique: async () => {
          state.calls += 1;
          return user;
        },
      },
    },
  };
}

test('★ 封禁期间连数据库都不查（限流必须是最便宜的拒绝路径）', async () => {
  const throttle = new LoginThrottle(CFG);
  const key = throttleKeyOf('alice', IP);
  for (let i = 0; i < CFG.maxFailures; i += 1) throttle.recordFailure(key, Date.now());

  const prisma = makePrisma({ id: 'u1', account: 'alice', name: 'A', passwordHash: 'x' });
  const svc = new AuthService(prisma.client, makeSessions(), makeGate(true), throttle);

  const err = await svc.login('alice', 'correct-password', IP).then(
    () => null,
    (e) => e,
  );

  assert.equal(err?.status, 429, '封禁期间即使密码正确也必须拒绝');
  assert.equal(prisma.state.calls, 0, '封禁期间不应触碰数据库（放前面才有这个效果）');
});

test('账号不存在 → 401 且记一次失败（不泄露账号是否存在）', async () => {
  const throttle = new LoginThrottle(CFG);
  const prisma = makePrisma(null);
  const svc = new AuthService(prisma.client, makeSessions(), makeGate(true), throttle);

  const err = await svc.login('nobody', 'whatever', IP).then(
    () => null,
    (e) => e,
  );

  assert.equal(err?.status, 401);
  assert.equal(err?.message, '账号或密码错误', '与「密码错误」文案必须完全一致');
  // 失败已计入：连续 maxFailures 次后应封禁
  for (let i = 1; i < CFG.maxFailures; i += 1) {
    await svc.login('nobody', 'whatever', IP).catch(() => {});
  }
  assert.ok(throttle.retryAfterSeconds(throttleKeyOf('nobody', IP), Date.now()) > 0);
});

test('密码错误 → 401；累计到阈值后变 429', async () => {
  const throttle = new LoginThrottle(CFG);
  const user = { id: 'u1', account: 'alice', name: 'A', passwordHash: 'x' };
  const prisma = makePrisma(user);
  const svc = new AuthService(prisma.client, makeSessions(), makeGate(false), throttle);

  const codes = [];
  for (let i = 0; i < CFG.maxFailures + 1; i += 1) {
    const err = await svc.login('alice', 'wrong', IP).then(
      () => null,
      (e) => e,
    );
    codes.push(err?.status);
  }

  assert.deepEqual(codes, [401, 401, 401, 429], '前 maxFailures 次是 401，之后转为 429');
});

test('登录成功 → 清零失败计数，并返回会话', async () => {
  const throttle = new LoginThrottle(CFG);
  const user = { id: 'u1', account: 'alice', name: 'A', passwordHash: 'x' };
  const prisma = makePrisma(user);
  const svc = new AuthService(prisma.client, makeSessions(), makeGate(true), throttle);

  // 先错两次（未达阈值）
  await svc.login('alice', 'wrong', IP).catch(() => {});
  await svc.login('alice', 'wrong', IP).catch(() => {});

  const result = await svc.login('alice', 'right', IP);
  assert.equal(result.sessionId, 'sess-1');
  assert.equal(
    throttle.retryAfterSeconds(throttleKeyOf('alice', IP), Date.now()),
    0,
    '成功后计数必须清零',
  );
});
