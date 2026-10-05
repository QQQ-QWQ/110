#!/usr/bin/env node
/**
 * 端到端验证脚本 —— DEM-01 ~ DEM-08 + DEM-11（列表游标分页）+ DEM-12（请求编号）
 *                    + DEM-13（详情/历史分页）+ DEM-14（登录并发闸门）
 *                    + DEM-15（健康探针）+ DEM-16（登录失败限流）
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
    // 请求编号（报告 §5.2 S5）：用于断言「响应头始终回传编号」与「透传规则」
    requestId: res.headers.get('x-request-id'),
    // 429 / 503 的重试建议（报告 §5.2 S7 与 §5.1 E4）
    retryAfter: res.headers.get('retry-after'),
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
  // 列表响应已改为「一页 + 分页信息」（{ items, pageInfo }），不再是裸数组。
  // 这里同时断言形状，让「响应结构被改回去」这类回归也能被发现。
  check(
    'DEM-01',
    '列表响应为分页结构 { items, pageInfo }',
    true,
    Array.isArray(carolList.json?.items),
  );
  const carolItems = Array.isArray(carolList.json?.items) ? carolList.json.items : [];
  const carolSees = carolItems.some((r) => r.id === rid);
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

  // ══════════════════ DEM-11 列表游标分页 ══════════════════
  // 此前列表无分页，返回当前用户可见的全部需求 —— 唯一会随数据量线性恶化的读路径。

  const page1 = await call('GET', '/requirements?limit=1', { cookie: alice });
  check('DEM-11', 'limit=1 → 200', 200, page1.status);
  check('DEM-11', 'items 恰好 1 条', 1, (page1.json?.items ?? []).length);
  check('DEM-11', 'pageInfo.limit 回显为 1', 1, page1.json?.pageInfo?.limit);

  const cursor1 = page1.json?.pageInfo?.nextCursor ?? null;
  const hasMore1 = page1.json?.pageInfo?.hasMore === true;
  check('DEM-11', '还有下一页时 hasMore=true 且给出 nextCursor', true, hasMore1 && !!cursor1);

  if (cursor1) {
    const page2 = await call('GET', `/requirements?limit=1&cursor=${encodeURIComponent(cursor1)}`, {
      cookie: alice,
    });
    check('DEM-11', '带游标取第二页 → 200', 200, page2.status);
    const id1 = page1.json?.items?.[0]?.id;
    const id2 = page2.json?.items?.[0]?.id;
    // ★ 分页的核心正确性：相邻两页不得出现同一行
    check('DEM-11', '★ 第二页与第一页无重复行', false, id1 !== undefined && id1 === id2);
  }

  // 非法游标属于「请求参数错误」，应为 422 而非 500
  const badCursor = await call('GET', '/requirements?cursor=%E4%B8%8D%E6%98%AF%E6%B8%B8%E6%A0%87', {
    cookie: alice,
  });
  check('DEM-11', '非法游标 → 422（不是 500）', 422, badCursor.status);

  const badLimit = await call('GET', '/requirements?limit=0', { cookie: alice });
  check('DEM-11', '非法 limit=0 → 422', 422, badLimit.status);

  const hugeLimit = await call('GET', '/requirements?limit=99999', { cookie: alice });
  check('DEM-11', 'limit 超上限 → 200（收敛而非报错）', 200, hugeLimit.status);
  check('DEM-11', 'limit 收敛到上限 100', 100, hugeLimit.json?.pageInfo?.limit);

  const noCursor = await call('GET', '/requirements', { cookie: alice });
  check(
    'DEM-11',
    '不传游标 → 取第一页且 hasMore 为布尔',
    true,
    typeof noCursor.json?.pageInfo?.hasMore === 'boolean',
  );

  // ══════════════════ DEM-12 请求编号贯穿（S5）══════════════════
  // 目的：用户报「刚才点了一下就报错了」时能给出一个编号，管理员据此在日志里
  // 精确定位到那一次请求。因此要验证：编号始终回传、合法入参被透传、
  // 非法入参被丢弃（防日志注入），且 4xx 不把编号塞进响应体。
  const ridDefault = await call('GET', '/requirements', { cookie: alice });
  check(
    'DEM-12',
    '响应头始终带 x-request-id',
    true,
    typeof ridDefault.requestId === 'string' && ridDefault.requestId.length > 0,
  );

  const mineRid = `e2e-${RUN}-rid`;
  const ridEcho = await call('GET', '/requirements', {
    cookie: alice,
    headers: { 'X-Request-Id': mineRid },
  });
  check('DEM-12', '合法入参被原样透传', mineRid, ridEcho.requestId);

  // 含空格的入参。这里**不用**换行符：fetch（undici）自己就会拒绝含换行的请求头，
  // 根本发不出去。但「客户端会拦」不能成为省掉服务端校验的理由 —— 上游网关或
  // curl 都可能把原始字节透传过来，所以服务端仍必须自己判。换行/控制字符那两条
  // 由单测覆盖（backend/test/request-id.test.js 中标 ★ 的用例）。
  const unsafeRid = 'bad id';
  const ridUnsafe = await call('GET', '/requirements', {
    cookie: alice,
    headers: { 'X-Request-Id': unsafeRid },
  });
  check(
    'DEM-12',
    '★ 含空格的入参被丢弃（防日志注入）',
    true,
    typeof ridUnsafe.requestId === 'string' &&
      ridUnsafe.requestId.length > 0 &&
      ridUnsafe.requestId !== unsafeRid,
  );

  const longRid = 'a'.repeat(500);
  const ridLong = await call('GET', '/requirements', {
    cookie: alice,
    headers: { 'X-Request-Id': longRid },
  });
  check(
    'DEM-12',
    '超长入参被丢弃并重新生成',
    true,
    ridLong.requestId !== longRid && (ridLong.requestId ?? '').length <= 128,
  );

  const rid404 = await call('GET', '/requirements/00000000-0000-4000-8000-0000000000ff', {
    cookie: alice,
  });
  check(
    'DEM-12',
    '4xx 响应体不带 requestId（仅响应头）',
    false,
    'requestId' in (rid404.json?.error ?? {}),
  );

  // ══════════════════ DEM-13 详情 / 历史分页（E2）══════════════════
  // 详情响应必须有上界：事件时间线每次状态变更都追加一条，是唯一会随
  // 「需求活得久」而无限增长的数组。完整时间线改由 /history 按 seq 游标续取。
  const det0 = await call('GET', `/requirements/${rid}`, { cookie: alice });
  check(
    'DEM-13',
    '详情返回上界标记与真实总数',
    true,
    typeof det0.json?.eventsTotal === 'number' &&
      typeof det0.json?.eventsHasMore === 'boolean' &&
      typeof det0.json?.eventsLimit === 'number' &&
      typeof det0.json?.submissionsTotal === 'number' &&
      typeof det0.json?.submissionsHasMore === 'boolean',
  );

  const detTotal = det0.json?.eventsTotal ?? 0;
  const detSeqs = (det0.json?.events ?? []).map((e) => e.seq);
  check(
    'DEM-13',
    '详情事件数不超过 eventsLimit',
    true,
    detSeqs.length <= (det0.json?.eventsLimit ?? 0),
  );
  check(
    'DEM-13',
    'eventsHasMore 与「总数 > 返回数」一致',
    detTotal > detSeqs.length,
    det0.json?.eventsHasMore,
  );
  check(
    'DEM-13',
    '事件按 seq 升序返回（时间线按发生顺序阅读）',
    true,
    detSeqs.every((s, i) => i === 0 || s > detSeqs[i - 1]),
  );

  const det1 = await call('GET', `/requirements/${rid}?eventsLimit=1`, { cookie: alice });
  check('DEM-13', 'eventsLimit=1 → 只返回 1 条', 1, (det1.json?.events ?? []).length);
  check('DEM-13', 'eventsLimit=1 → eventsHasMore 为 true', true, det1.json?.eventsHasMore);
  check('DEM-13', '★ 截断后仍给出真实总数（不是返回数）', detTotal, det1.json?.eventsTotal);

  // 详情窗口应是**最近** N 条，即全量时间线的尾部
  const histAll = await call('GET', `/requirements/${rid}/history?limit=200`, { cookie: alice });
  const allSeqs = (histAll.json?.events ?? []).map((e) => e.seq);
  check(
    'DEM-13',
    '★ 详情窗口是全量时间线的尾部',
    allSeqs[allSeqs.length - 1],
    detSeqs[detSeqs.length - 1],
  );

  // 历史端点：seq 游标分页
  const h1 = await call('GET', `/requirements/${rid}/history?limit=2`, { cookie: alice });
  const h1Seqs = (h1.json?.events ?? []).map((e) => e.seq);
  check('DEM-13', '历史 limit=2 → 200 且恰好 2 条', 2, h1Seqs.length);
  check(
    'DEM-13',
    '还有更多时 hasMore=true 且给出 nextCursor',
    true,
    h1.json?.pageInfo?.hasMore === true && typeof h1.json?.pageInfo?.nextCursor === 'string',
  );

  const h2 = await call(
    'GET',
    `/requirements/${rid}/history?limit=2&cursor=${encodeURIComponent(h1.json?.pageInfo?.nextCursor ?? '')}`,
    { cookie: alice },
  );
  const h2Seqs = (h2.json?.events ?? []).map((e) => e.seq);
  check('DEM-13', '带游标取第二页 → 200', 200, h2.status);
  check('DEM-13', '★ 第二页与第一页无重复 seq', 0, h2Seqs.filter((s) => h1Seqs.includes(s)).length);
  check(
    'DEM-13',
    '★ 第二页严格排在首页之后',
    true,
    h2Seqs.length > 0 && Math.min(...h2Seqs) > Math.max(...h1Seqs),
  );

  // 逐页取完：不重复、不遗漏、总数与详情报的 eventsTotal 一致
  const collected = [];
  let histCursor = null;
  let guard = 0;
  for (;;) {
    const q = histCursor ? `?limit=2&cursor=${encodeURIComponent(histCursor)}` : '?limit=2';
    const r = await call('GET', `/requirements/${rid}/history${q}`, { cookie: alice });
    collected.push(...(r.json?.events ?? []).map((e) => e.seq));
    guard += 1;
    if (!r.json?.pageInfo?.hasMore || guard > 50) break;
    histCursor = r.json.pageInfo.nextCursor;
  }
  check('DEM-13', '★ 逐页取完的事件数 = 详情报的 eventsTotal', detTotal, collected.length);
  check('DEM-13', '★ 逐页取完无重复 seq', collected.length, new Set(collected).size);

  const badHistCursor = await call('GET', `/requirements/${rid}/history?cursor=not-a-cursor`, {
    cookie: alice,
  });
  check('DEM-13', '历史非法游标 → 422（不是 500）', 422, badHistCursor.status);
  check(
    'DEM-13',
    '历史 limit=0 → 422',
    422,
    (await call('GET', `/requirements/${rid}/history?limit=0`, { cookie: alice })).status,
  );
  const hHuge = await call('GET', `/requirements/${rid}/history?limit=99999`, { cookie: alice });
  check('DEM-13', '历史 limit 超上限 → 收敛到 200（而非报错）', 200, hHuge.json?.pageInfo?.limit);

  // ══════════════════ DEM-14 登录并发闸门（E4）══════════════════
  // 闸门的目的不是让登录更快，而是**把故障域收窄**：bcryptjs 是纯 JS 实现，
  // 密码校验烧 Node 单线程事件循环，并发登录会把**所有**接口一起拖慢。
  //
  // 这里只断言「闸门不破坏正常使用」。饱和（队列满 → 503）与排队超时（→ 503）
  // 的语义由单测**确定性**覆盖（backend/test/semaphore.test.js），不在 e2e 里
  // 制造真正的饱和 —— 那既慢又不稳定，而且会把「环境慢」误报成「闸门坏了」。
  const burst = await Promise.all(
    Array.from({ length: 8 }, () =>
      call('POST', '/auth/login', { body: { account: 'alice', password: PASSWORD } }),
    ),
  );
  check(
    'DEM-14',
    '8 次并发登录全部 200（闸门不破坏正常使用）',
    8,
    burst.filter((r) => r.status === 200).length,
  );
  check(
    'DEM-14',
    '★ 每次登录得到独立会话（未串号）',
    8,
    new Set(burst.map((r) => r.cookie).filter(Boolean)).size,
  );
  const afterBurst = await call('POST', '/auth/login', {
    body: { account: 'alice', password: PASSWORD },
  });
  check('DEM-14', '突发之后仍能正常登录（许可未泄漏）', 200, afterBurst.status);

  // ══════════════════ DEM-15 健康探针拆分（S6）══════════════════
  // liveness 只证明「进程能响应」，readiness 真实探测依赖。
  // 两者混用是运维上的经典自伤：把数据库检查放进 liveness，数据库一抖
  // 编排系统就会**重启进程**，而重启对「数据库不可用」毫无帮助。
  // 这里能验证的是**三者的语义标签与状态码**；「数据库不可用时 readiness
  // 返回 503」需要停库，属人工验证项（见 DEM-09），单测已覆盖该分支。
  const live = await call('GET', '/health/live');
  check('DEM-15', 'liveness → 200', 200, live.status);
  check(
    'DEM-15',
    'liveness 标注 probe=liveness 且 ok=true',
    true,
    live.json?.probe === 'liveness' && live.json?.ok === true,
  );

  const ready = await call('GET', '/health/ready');
  check('DEM-15', 'readiness → 200（数据库可用时）', 200, ready.status);
  check(
    'DEM-15',
    'readiness 标注 probe=readiness 且 database=ok',
    true,
    ready.json?.probe === 'readiness' && ready.json?.database === 'ok',
  );

  const legacy = await call('GET', '/health');
  check(
    'DEM-15',
    '★ /health 仍是 readiness 的别名（兼容既有 healthcheck）',
    'readiness',
    legacy.json?.probe,
  );

  // ══════════════════ DEM-16 登录失败限流（S7）══════════════════
  // 与 E4 的闸门分工：闸门管**容量**（在途 bcrypt 数，满了 → 503），
  // 限流管**配额**（某来源连续失败次数，超了 → 429）。
  // 429 告诉客户端「别再试了」，503 告诉它「稍后再试」—— 两者不可混用。
  //
  // 用**每次运行唯一**的探测账号：否则会把真实账号（alice/bob/carol 后面还要正常登录）
  // 打到封禁，脚本就无法重复执行了。
  const probeAccount = `probe-${RUN}`;
  const probeCodes = [];
  for (let i = 0; i < 8; i += 1) {
    const r = await call('POST', '/auth/login', {
      body: { account: probeAccount, password: 'definitely-wrong' },
    });
    probeCodes.push(r.status);
  }

  const first429 = probeCodes.indexOf(429);
  check('DEM-16', '★ 连续错误密码最终会返回 429', true, first429 >= 0);
  check(
    'DEM-16',
    '429 之前一律是 401（不混入其它错误码）',
    true,
    probeCodes.slice(0, first429).every((c) => c === 401),
  );
  check(
    'DEM-16',
    '★ 一旦 429 就不再回到 401（封禁是持续的）',
    true,
    first429 >= 0 && probeCodes.slice(first429).every((c) => c === 429),
  );

  // 封禁期间换成「正确」的密码也照样 429 —— 证明限流先于凭据校验。
  // （探测账号并不存在，所以这里真正验证的是**拒绝发生在查库与比对之前**。）
  const lockedAttempt = await call('POST', '/auth/login', {
    body: { account: probeAccount, password: PASSWORD },
  });
  check('DEM-16', '★ 封禁期间换密码也 429（限流先于凭据校验）', 429, lockedAttempt.status);
  check(
    'DEM-16',
    '429 带 Retry-After（客户端才知道等多久）',
    true,
    Number(lockedAttempt.retryAfter) > 0,
  );

  // 真实账号不受影响：限流键是 (账号, IP) 的组合，探测账号的失败不该波及 alice
  const aliceStillOk = await call('POST', '/auth/login', {
    body: { account: 'alice', password: PASSWORD },
  });
  check('DEM-16', '★ 探测账号被封不影响其它账号（键含账号）', 200, aliceStillOk.status);

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
