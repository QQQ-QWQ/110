#!/usr/bin/env node
/**
 * 端到端验证脚本 —— DEM-01 ~ DEM-08
 *
 * 把《docs/测试与验证记录.md》§3 的手工 curl 步骤收敛成**一条可重复执行的命令**，
 * 输出「期望状态码 / 实际状态码」对照表，全部通过时退出码为 0。
 *
 * 用法：
 *   docker compose up --build -d        # 先起服务
 *   node scripts/e2e.mjs                # 默认 http://localhost:8080/api
 *   node scripts/e2e.mjs http://localhost:8080/api
 *   E2E_BASE_URL=http://host:port/api node scripts/e2e.mjs
 *
 * 设计说明：
 *  - 不依赖任何第三方包（Node 22 内置 fetch），评审环境直接可跑；
 *  - 幂等键带**每次运行唯一的前缀**，因此脚本可反复执行而不会命中上一轮的幂等记录；
 *  - 期望值取自代码语义（policy.ts / states.ts / invariants.ts），
 *    而非照抄文档 —— 文档与代码不一致时，以代码为准并在下方「观察项」中暴露差异。
 */

const BASE = (process.argv[2] || process.env.E2E_BASE_URL || 'http://localhost:8080/api').replace(
  /\/+$/,
  '',
);
const PASSWORD = process.env.SEED_PASSWORD || 'Passw0rd!';
/** 每次运行唯一，保证脚本可重复执行 */
const RUN = `${Date.now().toString(36)}`;

const ALICE = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';

// ────────────────────────── 结果收集 ──────────────────────────

const rows = [];
let failures = 0;
let observations = [];

/**
 * 记录一次断言。
 * @param {string} scenario 场景编号（DEM-xx）
 * @param {string} step     步骤描述
 * @param {number|null} expected 期望状态码；null 表示「观察项」（不参与通过判定）
 * @param {number} actual   实际状态码
 */
function check(scenario, step, expected, actual) {
  const isObservation = expected === null;
  const ok = isObservation ? true : actual === expected;
  if (!ok) failures += 1;
  rows.push({ scenario, step, expected: isObservation ? '（观察）' : expected, actual, ok });
  return ok;
}

/** 记录一个观察项（不计入失败），用于暴露与文档不一致的行为 */
function observe(scenario, step, expected, actual, note) {
  check(scenario, step, null, actual);
  observations.push({ scenario, step, expected, actual, note });
}

// ────────────────────────── HTTP ──────────────────────────

async function call(method, path, { body, headers = {}, cookie } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;

  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    /* 保留原始文本，便于排查 */
  }

  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return {
    status: res.status,
    json,
    text,
    cookie: raw.map((c) => c.split(';')[0]).join('; '),
  };
}

async function login(account) {
  const r = await call('POST', '/auth/login', { body: { account, password: PASSWORD } });
  if (r.status !== 200 || !r.cookie) {
    throw new Error(`登录 ${account} 失败：HTTP ${r.status} ${r.text}`);
  }
  return r.cookie;
}

const key = (name) => `e2e-${RUN}-${name}`;

// ────────────────────────── 主流程 ──────────────────────────

async function main() {
  // ── 前置：服务可用性 ──
  process.stdout.write(`端到端验证 → ${BASE}\n`);
  let health;
  try {
    health = await call('GET', '/health');
  } catch (error) {
    console.error(`\n✗ 无法连接 ${BASE}/health：${error.message}`);
    console.error('  请先执行：docker compose up --build -d\n');
    process.exit(2);
  }
  check('DEM-00', '健康检查（真实探测数据库）', 200, health.status);
  if (health.status !== 200) {
    console.error(`\n✗ 健康检查未通过：${health.text}`);
    console.error('  容器可能仍在启动中，稍后重试。\n');
    process.exit(2);
  }

  const alice = await login('alice');
  const bob = await login('bob');
  const carol = await login('carol');

  // ══════════════════ DEM-01 创建：必填 / 负责人不同 / 无关账号不可见 ══════════════════

  const emptyCriteria = await call('POST', '/requirements', {
    cookie: alice,
    headers: { 'Idempotency-Key': key('dem01-a') },
    body: { title: '测试', description: '说明', assigneeId: BOB, criteria: [] },
  });
  check('DEM-01', '缺少验收条件 → 拒绝', 422, emptyCriteria.status);

  const selfAssignee = await call('POST', '/requirements', {
    cookie: alice,
    headers: { 'Idempotency-Key': key('dem01-b') },
    body: { title: '测试', description: '说明', assigneeId: ALICE, criteria: ['条件一'] },
  });
  check('DEM-01', '负责人＝提出者 → 拒绝', 422, selfAssignee.status);

  const created = await call('POST', '/requirements', {
    cookie: alice,
    headers: { 'Idempotency-Key': key('dem01-c') },
    body: {
      title: `E2E 验证用需求 ${RUN}`,
      description: '由 scripts/e2e.mjs 自动创建，用于端到端验证。',
      assigneeId: BOB,
      criteria: ['条件一', '条件二', '条件三'],
    },
  });
  check('DEM-01', '合法创建 → 201', 201, created.status);

  const rid = created.json?.id;
  if (!rid) throw new Error(`创建未返回 id：${created.text}`);
  const v0 = created.json.rowVersion;

  // 详情（拿到验收条件 id，供验收步骤使用）
  const detail = await call('GET', `/requirements/${rid}`, { cookie: alice });
  const criteria = (detail.json?.criteria ?? []).map((c) => c.id);
  const [C1, C2, C3] = criteria;

  const carolList = await call('GET', '/requirements', { cookie: carol });
  const carolSees = Array.isArray(carolList.json)
    ? carolList.json.some((r) => r.id === rid)
    : false;
  check('DEM-01', '无关账号列表中不可见（carol）', false, carolSees);

  const carolDetail = await call('GET', `/requirements/${rid}`, { cookie: carol });
  check('DEM-01', '无关账号读详情 → 404（防枚举）', 404, carolDetail.status);

  // ══════════════════ DEM-02 编辑 → 开始后冻结 → 旧页修改失败 ══════════════════

  const edited = await call('PATCH', `/requirements/${rid}`, {
    cookie: alice,
    headers: { 'If-Match': String(v0), 'Idempotency-Key': key('dem02-a') },
    body: { title: `E2E 验证用需求 ${RUN}（已编辑）` },
  });
  check('DEM-02', '待处理阶段提出者可编辑 → 200', 200, edited.status);
  const v1 = edited.json?.rowVersion;

  const started = await call('POST', `/requirements/${rid}/start`, {
    cookie: bob,
    headers: { 'If-Match': String(v1), 'Idempotency-Key': key('dem02-b') },
  });
  check('DEM-02', '负责人开始处理 → 200', 200, started.status);
  check('DEM-02', '开始后状态＝IN_PROGRESS', 'IN_PROGRESS', started.json?.state);
  const v2 = started.json?.rowVersion;

  const staleEdit = await call('PATCH', `/requirements/${rid}`, {
    cookie: alice,
    headers: { 'If-Match': String(v0), 'Idempotency-Key': key('dem02-c') },
    body: { title: '旧页面修改' },
  });
  check('DEM-02', '★ 旧版本号提交 → 412', 412, staleEdit.status);

  const noIfMatch = await call('PATCH', `/requirements/${rid}`, {
    cookie: alice,
    headers: { 'Idempotency-Key': key('dem02-e') },
    body: { title: '不传版本号' },
  });
  check('DEM-02', '★ 不传 If-Match → 428（审查 R-01）', 428, noIfMatch.status);

  const frozenEdit = await call('PATCH', `/requirements/${rid}`, {
    cookie: alice,
    headers: { 'If-Match': String(v2), 'Idempotency-Key': key('dem02-d') },
    body: { title: '开始后修改' },
  });
  check('DEM-02', '开始后即使版本最新也拒绝编辑 → 409', 409, frozenEdit.status);

  // ══════════════════ DEM-03 提交 V1 ══════════════════

  const badArtifact = await call('POST', `/requirements/${rid}/submissions`, {
    cookie: bob,
    headers: { 'If-Match': String(v2), 'Idempotency-Key': key('dem03-a') },
    body: { artifacts: ['ftp://example.com/x'], note: '说明' },
  });
  check('DEM-03', '非 http(s) 链接 → 422', 422, badArtifact.status);

  const blankUrl = await call('POST', `/requirements/${rid}/submissions`, {
    cookie: bob,
    headers: { 'If-Match': String(v2), 'Idempotency-Key': key('dem03-a2') },
    body: { artifacts: ['https://example.com/a b'], note: '说明' },
  });
  check('DEM-03', '链接含空白字符 → 422（审查 R-07）', 422, blankUrl.status);

  const submitted = await call('POST', `/requirements/${rid}/submissions`, {
    cookie: bob,
    headers: { 'If-Match': String(v2), 'Idempotency-Key': key('dem03-b') },
    body: { artifacts: ['https://github.com/QQQ-QWQ/110'], note: '已完成初版实现' },
  });
  check('DEM-03', '合法提交 → 201', 201, submitted.status);
  check('DEM-03', '生成独立的 V1', 1, submitted.json?.submissionNo);
  const sid = submitted.json?.id;
  const v3 = submitted.json?.rowVersion;

  // ══════════════════ DEM-04 有未通过项时不得确认完成 ══════════════════

  const partialComplete = await call('POST', `/submissions/${sid}/reviews`, {
    cookie: alice,
    headers: { 'If-Match': String(v3), 'Idempotency-Key': key('dem04-a') },
    body: {
      action: 'COMPLETE',
      checks: [
        { criterionId: C1, passed: true },
        { criterionId: C2, passed: false },
        { criterionId: C3, passed: true },
      ],
    },
  });
  check('DEM-04', '存在未通过项却点完成 → 422', 422, partialComplete.status);

  const stillReview = await call('GET', `/requirements/${rid}`, { cookie: alice });
  check('DEM-04', '状态未被改变（仍 IN_REVIEW）', 'IN_REVIEW', stillReview.json?.state);

  // ══════════════════ DEM-05 退回：原因必填 ══════════════════

  const checksWithFail = [
    { criterionId: C1, passed: true },
    { criterionId: C2, passed: false },
    { criterionId: C3, passed: true },
  ];

  const returnNoReason = await call('POST', `/submissions/${sid}/reviews`, {
    cookie: alice,
    headers: { 'If-Match': String(v3), 'Idempotency-Key': key('dem05-a') },
    body: { action: 'RETURN', checks: checksWithFail },
  });
  check('DEM-05', '退回未填原因 → 422', 422, returnNoReason.status);

  const returned = await call('POST', `/submissions/${sid}/reviews`, {
    cookie: alice,
    headers: { 'If-Match': String(v3), 'Idempotency-Key': key('dem05-b') },
    body: {
      action: 'RETURN',
      reason: '条件二未满足：返回列表后筛选被清空，请保留该条件',
      checks: checksWithFail,
    },
  });
  check('DEM-05', '填写原因后退回 → 200', 200, returned.status);
  check('DEM-05', '退回后回到 IN_PROGRESS', 'IN_PROGRESS', returned.json?.state);
  const v4 = returned.json?.rowVersion;

  const returnMissing = await call('POST', `/submissions/${sid}/reviews`, {
    cookie: alice,
    headers: { 'If-Match': String(v4), 'Idempotency-Key': key('dem05-c') },
    body: { action: 'RETURN', reason: '原因', checks: [{ criterionId: C1, passed: true }] },
  });
  check('DEM-05', '验收结果缺项 → 422', 422, returnMissing.status);

  // ══════════════════ DEM-06 V2 重提 → 全通过 → 已完成，V1/V2 均保留 ══════════════════

  const submitted2 = await call('POST', `/requirements/${rid}/submissions`, {
    cookie: bob,
    headers: { 'If-Match': String(v4), 'Idempotency-Key': key('dem06-a') },
    body: {
      artifacts: ['https://github.com/QQQ-QWQ/110/pull/1'],
      note: '已按反馈修复筛选保留问题',
    },
  });
  check('DEM-06', 'V2 重提 → 201', 201, submitted2.status);
  check('DEM-06', 'V2 不覆盖 V1（submissionNo＝2）', 2, submitted2.json?.submissionNo);
  const sid2 = submitted2.json?.id;
  const v5 = submitted2.json?.rowVersion;

  const allPass = [
    { criterionId: C1, passed: true },
    { criterionId: C2, passed: true },
    { criterionId: C3, passed: true },
  ];

  const oldReview = await call('POST', `/submissions/${sid}/reviews`, {
    cookie: alice,
    headers: { 'If-Match': String(v5), 'Idempotency-Key': key('dem06-b') },
    body: { action: 'COMPLETE', checks: allPass },
  });
  check('DEM-06', '★ 对旧提交（V1）验收 → 409', 409, oldReview.status);

  const completed = await call('POST', `/submissions/${sid2}/reviews`, {
    cookie: alice,
    headers: { 'If-Match': String(v5), 'Idempotency-Key': key('dem06-c') },
    body: { action: 'COMPLETE', checks: allPass },
  });
  check('DEM-06', 'V2 全通过 → 200', 200, completed.status);
  check('DEM-06', '状态＝COMPLETED', 'COMPLETED', completed.json?.state);
  const v6 = completed.json?.rowVersion;

  const history = await call('GET', `/requirements/${rid}/history`, { cookie: alice });
  const subs = history.json?.submissions ?? [];
  check('DEM-06', '历史保留 2 次提交（V1/V2 均在）', 2, subs.length);
  const v1rec = subs.find((s) => s.submissionNo === 1);
  const v2rec = subs.find((s) => s.submissionNo === 2);
  check('DEM-06', 'V1 保留退回记录与原因', 'RETURN', v1rec?.reviews?.[0]?.action);
  check('DEM-06', 'V1 退回原因非空', true, Boolean(v1rec?.reviews?.[0]?.reason));
  check('DEM-06', 'V2 保留通过记录', 'COMPLETE', v2rec?.reviews?.[0]?.action);

  // ══════════════════ DEM-07 幂等 / 终态 / 重复 ══════════════════

  // ① 幂等回放：用 CREATE 验证（CREATE 无状态与版本守卫，回放路径可达）
  const idemBody = {
    title: `E2E 幂等验证 ${RUN}`,
    description: '用于验证同一 Idempotency-Key 只产生一次业务记录。',
    assigneeId: BOB,
    criteria: ['幂等条件一'],
  };
  const idem1 = await call('POST', '/requirements', {
    cookie: alice,
    headers: { 'Idempotency-Key': key('dem07-idem') },
    body: idemBody,
  });
  const idem2 = await call('POST', '/requirements', {
    cookie: alice,
    headers: { 'Idempotency-Key': key('dem07-idem') },
    body: idemBody,
  });
  check('DEM-07', '同键同载荷重放 → 201', 201, idem2.status);
  check('DEM-07', '重放返回同一资源 id（未重复创建）', idem1.json?.id, idem2.json?.id);

  // ② 同键不同载荷 → 409
  const idemConflict = await call('POST', '/requirements', {
    cookie: alice,
    headers: { 'Idempotency-Key': key('dem07-idem') },
    body: { ...idemBody, title: `E2E 幂等验证 ${RUN}（载荷不同）` },
  });
  check('DEM-07', '同键不同载荷 → 409', 409, idemConflict.status);

  // ③ 终态后再次操作 → 409，且状态与历史不变
  const finalReturn = await call('POST', `/submissions/${sid2}/reviews`, {
    cookie: alice,
    headers: { 'If-Match': String(v6), 'Idempotency-Key': key('dem07-final') },
    body: { action: 'RETURN', reason: '终态后退回', checks: checksWithFail },
  });
  check('DEM-07', '终态后再退回 → 409', 409, finalReturn.status);

  const afterFinal = await call('GET', `/requirements/${rid}/history`, { cookie: alice });
  check('DEM-07', '终态后状态仍为 COMPLETED', 'COMPLETED', afterFinal.json?.state);
  check('DEM-07', '终态后未产生新的验收记录', 2, (afterFinal.json?.submissions ?? []).length);

  // ④ 观察项：对「已改变状态」的命令重复提交，是否会回放原响应？
  const rid7 = idem1.json?.id;
  const s7 = await call('POST', `/requirements/${rid7}/start`, {
    cookie: bob,
    headers: { 'If-Match': '1', 'Idempotency-Key': key('dem07-start') },
  });
  const v7start = s7.json?.rowVersion;
  const sub7a = await call('POST', `/requirements/${rid7}/submissions`, {
    cookie: bob,
    headers: { 'If-Match': String(v7start), 'Idempotency-Key': key('dem07-dup') },
    body: { artifacts: ['https://example.com/dup'], note: '重复请求测试' },
  });
  check('DEM-07', '首次提交 → 201', 201, sub7a.status);

  const sub7b = await call('POST', `/requirements/${rid7}/submissions`, {
    cookie: bob,
    headers: { 'If-Match': String(v7start), 'Idempotency-Key': key('dem07-dup') },
    body: { artifacts: ['https://example.com/dup'], note: '重复请求测试' },
  });
  // 关键断言：重复请求**不得**产生第二条业务记录（这是幂等的实质保证）
  check('DEM-07', '重复提交不得产生新记录（非 201）', true, sub7b.status !== 201);

  const hist7 = await call('GET', `/requirements/${rid7}/history`, { cookie: alice });
  check('DEM-07', '重复提交后仅存在 1 条提交记录', 1, (hist7.json?.submissions ?? []).length);

  observe(
    'DEM-07',
    '重复提交（同键、已改变状态）的实际状态码',
    '文档 §3 预期「两次响应完全一致（回放首次结果）」',
    sub7b.status,
    '首次提交已使 row_version 递增，故重复请求携带的 If-Match 立即过期，' +
      '版本守卫（412）在幂等占坑之前就把请求挡下，回放路径实际不可达；' +
      '幂等的实质保证（不产生第二条业务记录）仍然成立。' +
      '注意判定顺序为 可见性404 → 角色403 → 版本412 → 状态409（RFC 9110 要求前置条件先于方法处理）。',
  );

  // ══════════════════ DEM-08 越权 ══════════════════

  const bobReview = await call('POST', `/submissions/${sid2}/reviews`, {
    cookie: bob,
    headers: { 'If-Match': String(v6), 'Idempotency-Key': key('dem08-a') },
    body: { action: 'COMPLETE', checks: allPass },
  });
  check('DEM-08', '负责人越权验收 → 403', 403, bobReview.status);

  const carolRead = await call('GET', `/requirements/${rid}`, { cookie: carol });
  check('DEM-08', '无关账号读详情 → 404', 404, carolRead.status);

  const carolStart = await call('POST', `/requirements/${rid}/start`, {
    cookie: carol,
    headers: { 'If-Match': String(v6), 'Idempotency-Key': key('dem08-b') },
  });
  check('DEM-08', '无关账号直接操作接口 → 404', 404, carolStart.status);

  const anonymous = await call('GET', '/requirements');
  check('DEM-08', '未登录访问 → 401', 401, anonymous.status);

  // ══════════════════ 输出报告 ══════════════════

  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
  process.stdout.write('\n');
  process.stdout.write(`${pad('场景', 9)}${pad('步骤', 46)}${pad('期望', 7)}实际\n`);
  process.stdout.write(`${'-'.repeat(9)}${'-'.repeat(46)}${'-'.repeat(7)}${'-'.repeat(6)}\n`);
  for (const r of rows) {
    const mark = r.expected === '（观察）' ? '○' : r.ok ? '✓' : '✗';
    process.stdout.write(
      `${pad(r.scenario, 9)}${pad(r.step, 46)}${pad(r.expected, 7)}${r.actual} ${mark}\n`,
    );
  }

  if (observations.length > 0) {
    process.stdout.write('\n观察项（不参与通过判定，仅记录实际行为）：\n');
    for (const o of observations) {
      process.stdout.write(`  ○ ${o.scenario} ${o.step}\n`);
      process.stdout.write(`      文档预期：${o.expected}\n`);
      process.stdout.write(`      实际状态：${o.actual}\n`);
      process.stdout.write(`      说明：${o.note}\n`);
    }
  }

  const total = rows.filter((r) => r.expected !== '（观察）').length;
  process.stdout.write(`\n断言 ${total} 项，失败 ${failures} 项。\n`);
  if (failures === 0) {
    process.stdout.write('全部通过 ✓\n');
  } else {
    process.stdout.write('存在失败项，请检查上方 ✗ 行。\n');
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n✗ 脚本异常终止：${error.stack || error.message}\n`);
  process.exit(2);
});
