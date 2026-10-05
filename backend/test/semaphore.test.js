/**
 * 并发闸门测试 —— 报告 §5.1 E4
 *
 * 这个闸门的目的是**收窄故障域**：bcryptjs 是纯 JS 实现，密码校验会烧 Node 的
 * 单线程事件循环，并发登录会把**所有**接口一起拖慢。闸门把这件事变成
 * 「登录排队或快速失败」，而不是「全站不可用」。
 *
 * 因此这里要钉死的不是「它能让登录变快」，而是**它的边界行为**：
 *  · 并发数绝不被突破；
 *  · 队列满了要**快速失败**（而不是无限排队把问题挪到内存）；
 *  · **超时的等待者必须出队** —— 这是最容易写错、也最致命的一条；
 *  · 释放时许可交给队首（FIFO），不让新来的抢走；
 *  · 抛异常时也要释放许可，否则一次异常就永久少一个并发位。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { Semaphore } = require('../dist/domain/semaphore.js');
const { resolveLoginGateConfig, defaultLoginConcurrency } = require('../dist/core/login-gate.js');

/** 让出一次事件循环，使已排队的微任务/定时器得以推进 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 可手动控制何时结束的 Promise（用于精确编排并发时序） */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ─────────────────────────────────────────────────────────────
// 基本语义
// ─────────────────────────────────────────────────────────────

test('permits=1：第二个任务必须等第一个释放', async () => {
  const sem = new Semaphore(1, 10);
  const gate = deferred();
  const order = [];

  const first = sem.run(async () => {
    order.push('a-start');
    await gate.promise;
    order.push('a-end');
  }, 5000);
  const second = sem.run(async () => {
    order.push('b-start');
    order.push('b-end');
  }, 5000);

  await tick();
  assert.deepEqual(order, ['a-start'], '第二个任务此时不应开始');
  assert.equal(sem.inFlight, 1);
  assert.equal(sem.queued, 1);

  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  assert.equal(sem.inFlight, 0);
  assert.equal(sem.queued, 0);
});

test('permits=2：同时在途数不超过 2', async () => {
  const sem = new Semaphore(2, 10);
  const gate = deferred();
  let peak = 0;

  const tasks = Array.from({ length: 5 }, () =>
    sem.run(async () => {
      peak = Math.max(peak, sem.inFlight);
      await gate.promise;
    }, 5000),
  );

  await tick();
  assert.equal(sem.inFlight, 2, '在途应恰好等于许可数');
  assert.equal(sem.queued, 3);
  assert.equal(peak, 2);

  gate.resolve();
  await Promise.all(tasks);
  assert.equal(sem.inFlight, 0);
});

test('★ 队列满 → 立即 503（快速失败，而不是排一个注定等很久的队）', async () => {
  const sem = new Semaphore(1, 1);
  const gate = deferred();

  const running = sem.run(() => gate.promise, 5000);
  await tick();

  const queued = sem.acquire(5000); // 占满唯一的队列位
  await tick();
  assert.equal(sem.queued, 1);

  // 第三个请求应立刻被拒，而不是进入队列
  const error = await sem.acquire(5000).then(
    () => null,
    (e) => e,
  );
  assert.equal(error?.status, 503);
  assert.equal(error?.code, 'SERVICE_BUSY');

  gate.resolve();
  await Promise.all([running, queued]);
  sem.release(); // acquire 必须与 release 配对，否则许可不会归还
  assert.equal(sem.inFlight, 0);
});

test('★ 排队超时的等待者必须出队（否则队列会「泄漏」到所有人都被 503）', async () => {
  const sem = new Semaphore(1, 1);
  const gate = deferred();

  const running = sem.run(() => gate.promise, 5000);
  await tick();

  // 这个等待者会在 ~20ms 后超时
  const error = await sem.acquire(20).then(
    () => null,
    (e) => e,
  );
  assert.equal(error?.status, 503);
  assert.equal(sem.queued, 0, '超时后必须从队列中摘除自己');

  // 队列空出来了 → 新请求应该能排进来，而不是被队列上限拒掉
  const next = sem.acquire(5000);
  await tick();
  assert.equal(sem.queued, 1, '超时者若没出队，这里会一直等于上限从而永远 503');

  gate.resolve();
  await Promise.all([running, next]);
  sem.release();
  assert.equal(sem.inFlight, 0);
});

test('★ 释放时许可交给队首（FIFO），而不是让新来的抢走', async () => {
  const sem = new Semaphore(1, 10);
  const gate = deferred();
  const order = [];

  const running = sem.run(() => gate.promise, 5000);
  await tick();

  const second = sem.acquire(5000).then(() => order.push('second'));
  const third = sem.acquire(5000).then(() => order.push('third'));
  await tick();
  assert.equal(sem.queued, 2);

  gate.resolve();
  await running;
  await tick();
  assert.deepEqual(order, ['second'], '只应轮到队首，第三人仍在等');
  assert.equal(sem.queued, 1);

  sem.release();
  await Promise.all([second, third]);
  assert.deepEqual(order, ['second', 'third'], '等待顺序必须是 FIFO');
  sem.release();
  assert.equal(sem.inFlight, 0);
});

test('run() 在抛错时也会释放许可（否则一次异常就永久少一个并发位）', async () => {
  const sem = new Semaphore(1, 1);

  await assert.rejects(
    () =>
      sem.run(async () => {
        throw new Error('boom');
      }, 1000),
    /boom/,
  );

  assert.equal(sem.inFlight, 0, '异常路径也必须归还许可');
  assert.equal(await sem.run(async () => 'ok', 1000), 'ok', '之后仍应能正常使用');
});

test('多余的 release 不会把池子撑大（并发数不能被悄悄突破）', () => {
  const sem = new Semaphore(2, 1);
  sem.release();
  sem.release();
  sem.release();

  assert.equal(sem.inFlight, 0);
  assert.equal(sem.stats().capacity, 2);
});

test('构造参数非法时直接抛错（配置错误应当启动即失败）', () => {
  assert.throws(() => new Semaphore(0, 1), /permits/);
  assert.throws(() => new Semaphore(1.5, 1), /permits/);
  assert.throws(() => new Semaphore(1, -1), /queueLimit/);
  assert.throws(() => new Semaphore(1, 0.5), /queueLimit/);
});

test('timeoutMs=0 表示不设超时（等待者一直排队直到拿到许可）', async () => {
  const sem = new Semaphore(1, 1);
  const gate = deferred();

  const running = sem.run(() => gate.promise, 0);
  await tick();
  const waiting = sem.acquire(0);
  await tick();
  assert.equal(sem.queued, 1);

  gate.resolve();
  await Promise.all([running, waiting]);
  sem.release(); // acquire 必须与 release 配对
  assert.equal(sem.inFlight, 0);
});

// ─────────────────────────────────────────────────────────────
// 配置解析
// ─────────────────────────────────────────────────────────────

test('闸门配置：默认值来自可用并行度，可用环境变量覆盖', () => {
  const dflt = resolveLoginGateConfig({});
  assert.ok(dflt.concurrency >= 1);
  assert.equal(dflt.concurrency, defaultLoginConcurrency());
  assert.equal(dflt.queueLimit, 50);
  assert.equal(dflt.timeoutMs, 5000);

  const custom = resolveLoginGateConfig({
    LOGIN_CONCURRENCY: '2',
    LOGIN_QUEUE_LIMIT: '3',
    LOGIN_ACQUIRE_TIMEOUT_MS: '10',
  });
  assert.deepEqual(custom, { concurrency: 2, queueLimit: 3, timeoutMs: 10 });
});

test('★ 闸门配置非法时抛错，而不是悄悄退回默认值', () => {
  // 静默回退会让人以为「闸门开着」，实际却没有 —— 那比启动失败更危险
  assert.throws(() => resolveLoginGateConfig({ LOGIN_CONCURRENCY: '0' }), /LOGIN_CONCURRENCY/);
  assert.throws(() => resolveLoginGateConfig({ LOGIN_CONCURRENCY: 'abc' }), /LOGIN_CONCURRENCY/);
  assert.throws(() => resolveLoginGateConfig({ LOGIN_CONCURRENCY: '1.5' }), /LOGIN_CONCURRENCY/);
  assert.throws(() => resolveLoginGateConfig({ LOGIN_QUEUE_LIMIT: '-1' }), /LOGIN_QUEUE_LIMIT/);
  assert.throws(
    () => resolveLoginGateConfig({ LOGIN_ACQUIRE_TIMEOUT_MS: 'x' }),
    /LOGIN_ACQUIRE_TIMEOUT_MS/,
  );
});
