/**
 * 健康探针测试 —— 报告 §5.2 S6
 *
 * 这里要钉死的是**两个探针的语义差异**，而不是「接口能返回 200」：
 *  · liveness 绝不能查数据库 —— 否则数据库一抖，编排系统会重启进程，
 *    而重启对「数据库不可用」毫无帮助，只会让恢复更慢；
 *  · readiness 必须真实探测依赖，不可用时返回 **503**（不是 500），
 *    且不能把内部错误细节暴露出去。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { HealthController } = require('../dist/health.controller.js');

/** 桩 response：只记录被设置的 statusCode */
function makeRes() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
  };
}

test('★ liveness：不碰数据库，永远返回存活', () => {
  let touched = false;
  const prisma = {
    $queryRaw: async () => {
      touched = true;
      return [];
    },
  };
  const controller = new HealthController(prisma);

  const body = controller.live();

  assert.equal(body.ok, true);
  assert.equal(body.probe, 'liveness');
  assert.equal(touched, false, 'liveness 查数据库 = 数据库抖动会触发无意义的重启');
});

test('readiness：数据库可用 → 200 且 database=ok', async () => {
  const prisma = { $queryRaw: async () => [{ ok: 1 }] };
  const controller = new HealthController(prisma);
  const res = makeRes();

  const body = await controller.ready(res);

  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.probe, 'readiness');
  assert.equal(body.database, 'ok');
});

test('★ readiness：数据库不可用 → 503（不是 500），且不抛异常、不泄露细节', async () => {
  const prisma = {
    $queryRaw: async () => {
      throw new Error('connection refused: 127.0.0.1:5432');
    },
  };
  const controller = new HealthController(prisma);
  const res = makeRes();

  const body = await controller.ready(res);

  assert.equal(res.statusCode, 503, '503 才是「暂时不可服务、稍后会恢复」的语义');
  assert.equal(body.ok, false);
  assert.equal(body.database, 'unreachable');
  assert.equal(
    JSON.stringify(body).includes('connection refused'),
    false,
    '探针响应不应泄露内部错误细节',
  );
});

test('/health 是 readiness 的别名（兼容既有 compose healthcheck 与验收脚本）', async () => {
  const prisma = { $queryRaw: async () => [] };
  const controller = new HealthController(prisma);

  const okRes = makeRes();
  const okBody = await controller.health(okRes);
  assert.equal(okBody.probe, 'readiness');
  assert.equal(okRes.statusCode, 200);

  const downPrisma = {
    $queryRaw: async () => {
      throw new Error('down');
    },
  };
  const downRes = makeRes();
  await new HealthController(downPrisma).health(downRes);
  assert.equal(downRes.statusCode, 503, '别名必须与 readiness 同语义，否则容器健康判定会不一致');
});
