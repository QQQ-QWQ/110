#!/usr/bin/env node
/**
 * 三档断点截图（《UI 设计方案》§10.2 的 P3 验收方式：三档各截一张图比对线框）
 *
 * 为什么不用 Playwright：本项目前端是「零额外依赖」的取向，而 Playwright 要装
 * 浏览器二进制（几百 MB）。Node 22 内置了 WebSocket，因此可以直接用
 * Chrome DevTools Protocol 驱动**系统已装的 Chrome** —— 零依赖、零下载。
 *
 * 用法：
 *   node scripts/capture-screens.mjs [baseUrl] [outDir]
 * 默认：http://localhost:8080  →  .workbuddy-ai/tmp/screens/
 *
 * 前置：本机有 Chrome，且目标站点在跑（docker compose up -d）。
 * 退出码：0 = 全部截图成功；1 = 有失败；2 = 环境问题（找不到 Chrome / 连不上站点）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] ?? 'http://localhost:8080').replace(/\/$/, '');
const OUT = path.resolve(ROOT, process.argv[3] ?? '.workbuddy-ai/tmp/screens');
/* 端口必须**每次不同** —— 曾经写死 9222，结果上一次没退干净的 Chrome 仍占着它，
   新实例起不来、CDP 连到了旧实例，于是脚本"看到"的是上一次的已登录会话，
   表现为「/login 被重定向到 /」这种完全误导的报错。 */
const PORT = 9200 + Math.floor(Math.random() * 700);

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('✗ 找不到 Chrome，无法截图。可改 CHROME_CANDIDATES 指定路径。');
  process.exit(2);
}

/** 三档宽度（方案 §9.1 的移动/平板/桌面）+ 每档高度 */
const VIEWPORTS = [
  { name: 'mobile-380', width: 380, height: 900 },
  { name: 'tablet-768', width: 768, height: 1000 },
  { name: 'desktop-1280', width: 1280, height: 1000 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 启动 Chrome ──
const userDataDir = path.join(os.tmpdir(), `wb-shots-${Date.now()}`);
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

/** 等 CDP 端口就绪 */
async function waitForCdp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return null;
}

/** 极简 CDP 客户端：发命令、等回包 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close: () => ws.close(),
  };
}

async function main() {
  const wsUrl = await waitForCdp();
  if (!wsUrl) throw new Error('Chrome 的 CDP 端口没起来');
  const cdp = connect(wsUrl);
  await cdp.ready;

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // ── 先确认站点可达 ──
  const probe = await fetch(BASE).catch(() => null);
  if (!probe || !probe.ok) {
    throw new Error(`站点不可达：${BASE}（先 docker compose up -d）`);
  }

  fs.mkdirSync(OUT, { recursive: true });

  const goto = async (url) => {
    await cdp.send('Page.navigate', { url });
    await sleep(1200); // 等 SPA 路由与首个请求完成
  };
  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return r.result?.value;
  };
  const shot = async (file) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
    return path.join(OUT, file);
  };
  /** 轮询等待某个选择器出现 —— 比固定 sleep 稳健：容器刚重启时首屏会慢几秒 */
  const waitFor = async (selector, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (found) return true;
      await sleep(300);
    }
    return false;
  };

  // ── 登录（截图需要真实会话）──
  await goto(`${BASE}/login`);
  if (!(await waitFor('#account'))) {
    const where = await evaluate('location.pathname + location.search');
    const hasForm = await evaluate("!!document.querySelector('form')");
    const inputs = await evaluate(
      "Array.from(document.querySelectorAll('input')).map(i => i.id || i.name || i.type).join(',')",
    );
    throw new Error(
      `登录表单未在 15s 内出现。当前路径=${where} 有 form=${hasForm} 输入框=[${inputs}]`,
    );
  }
  const loggedIn = await evaluate(`
    (async () => {
      const set = (el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const acc = document.querySelector('#account');
      const pwd = document.querySelector('#password');
      if (!acc || !pwd) return 'no-form';
      set(acc, 'alice');
      set(pwd, 'Passw0rd!');
      document.querySelector('form').requestSubmit();
      return 'submitted';
    })()
  `);
  if (loggedIn !== 'submitted') throw new Error(`登录表单未找到（${loggedIn}）`);
  await sleep(1800);
  const afterLogin = await evaluate('location.pathname');
  if (afterLogin === '/login') throw new Error('登录失败（仍在 /login）—— 检查 SEED_PASSWORD');

  // ── 取一条需求 id，用于详情页截图 ──
  const detailId = await evaluate(`
    (async () => {
      const res = await fetch('/api/requirements?limit=1', { credentials: 'include' });
      const data = await res.json();
      return data.items?.[0]?.id ?? null;
    })()
  `);

  const pages = [
    { name: 'list', url: `${BASE}/` },
    ...(detailId ? [{ name: 'detail', url: `${BASE}/requirements/${detailId}` }] : []),
  ];

  const results = [];
  for (const vp of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: 1,
      mobile: vp.width < 768,
    });
    for (const page of pages) {
      await goto(page.url);
      // 移动端详情页要能滚到底，才能看到底部固定操作条
      const overflow = await evaluate(
        'document.documentElement.scrollWidth - document.documentElement.clientWidth',
      );
      const file = `${page.name}-${vp.name}.png`;
      await shot(file);
      results.push({ file, width: vp.width, page: page.name, horizontalOverflow: overflow });
      console.log(
        `  ${file.padEnd(28)} 宽 ${String(vp.width).padEnd(5)} 横向溢出 ${
          overflow > 0 ? `⚠️ ${overflow}px` : '0 ✅'
        }`,
      );
    }
  }

  cdp.close();
  console.log(`\n截图目录：${OUT}`);
  const bad = results.filter((r) => r.horizontalOverflow > 0);
  if (bad.length > 0) {
    console.log(`\n⚠️ ${bad.length} 张截图存在横向滚动（方案 §10.3 要求三档均无横向滚动）：`);
    for (const b of bad) console.log(`   ${b.file} → 溢出 ${b.horizontalOverflow}px`);
    return 1;
  }
  console.log('✅ 三档均无横向滚动');
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`✗ ${err.message}`);
  code = 2;
} finally {
  chrome.kill('SIGKILL');
  // Chrome 有时不会立刻释放 user-data-dir，删不掉也无所谓（在系统临时目录里）
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
process.exit(code);
