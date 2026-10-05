#!/usr/bin/env node
/**
 * 登录并发闸门饱和探测（报告 §5.1 E4）
 *
 * 目的：验证「闸门满时返回 503 而不是把服务拖垮」这条声明。
 *
 * 用法：node scripts/probe-login-saturation.mjs <baseUrl> [并发数] [账号列表]
 *   例：node scripts/probe-login-saturation.mjs http://localhost:8080/api 150 alice,bob,carol
 *
 * ⚠️ **两个实测踩出来的坑**（都会让压测得出错误结论）：
 *  1. **不传账号列表时压不满闸门** —— 随机账号在库里不存在，`findUnique` 返回 null
 *     时就直接 401 了，**根本走不到闸门**（闸门只包住 bcrypt 比对）。
 *     必须用**存在的账号**才能触发；而那又会撞上 S7 的失败限流，
 *     所以压测时要把 LOGIN_MAX_FAILURES 调高、LOGIN_CONCURRENCY/QUEUE_LIMIT 调小。
 *  2. **`fetch` 会复用连接池** —— 150 个"并发"请求实际只有个位数同时在途，
 *     闸门压不满（日志里只出现 2 次「闸门已满」）。改用 `http.request` + `agent: false`
 *     才得到真并发。
 *
 * 设计要点：密码一律错（错密码才会走到 bcrypt，而 bcrypt 正是被闸门保护的操作）；
 * 只统计状态码分布、不自行判定通过 —— 判据交给调用方，避免脚本自己「宣布胜利」。
 */
import http from 'node:http';

const base = process.argv[2] ?? 'http://localhost:8080/api';
const total = Number(process.argv[3] ?? 150);
/** 逗号分隔的真实账号；提供时轮流使用，否则用随机账号（压不满闸门，仅作对照） */
const accounts = (process.argv[4] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const codes = new Map();
let networkErrors = 0;
const retryAfters = [];

/** 发一个登录请求；agent:false = 不复用连接，保证真并发 */
function login(i) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      account: accounts.length > 0 ? accounts[i % accounts.length] : `sat-${Date.now()}-${i}`,
      password: 'definitely-wrong',
    });
    const url = new URL(`${base}/auth/login`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        agent: false, // ← 关键：不复用连接
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        codes.set(res.statusCode, (codes.get(res.statusCode) ?? 0) + 1);
        const ra = res.headers['retry-after'];
        if (ra) retryAfters.push(ra);
        res.resume(); // 必须消费掉，否则连接不会释放
        res.on('end', resolve);
      },
    );
    req.on('error', () => {
      networkErrors += 1;
      resolve();
    });
    req.write(body);
    req.end();
  });
}

const started = Date.now();
await Promise.all(Array.from({ length: total }, (_, i) => login(i)));

const elapsed = Date.now() - started;

console.log(`并发 ${total} 个登录请求 → ${base}`);
console.log(`总耗时 ${elapsed}ms\n`);
console.log('状态码分布：');
for (const [code, n] of [...codes].sort((a, b) => b[1] - a[1])) {
  const meaning = {
    401: '凭据错误（闸门放行，正常）',
    429: '被限流',
    503: '闸门已满',
    200: '意外成功',
  }[code];
  console.log(`  ${code} × ${n}${meaning ? `   ${meaning}` : ''}`);
}
if (networkErrors > 0) console.log(`  连接失败 × ${networkErrors}`);
if (retryAfters.length > 0) {
  console.log(
    `\n带 Retry-After 的响应 ${retryAfters.length} 个，取值：${[...new Set(retryAfters)].join(', ')}`,
  );
}

// 压测后确认服务仍然存活 —— 闸门的意义正是「宁可拒绝一部分请求，也不要全站拖垮」
const alive = await new Promise((resolve) => {
  const url = new URL(`${base}/health/live`);
  const req = http.request(
    { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', agent: false },
    (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    },
  );
  req.on('error', () => resolve('连不上'));
  req.end();
});
console.log(`\n压测后服务仍然存活：${alive}`);
