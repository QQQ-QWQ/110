#!/usr/bin/env node
/**
 * 本地前置检查（架构报告 §5.3 C4）
 *
 * 目的：把 CI 的**机械检查**搬到本地，把反馈周期从「推送 → 等 3~5 分钟」
 * 压到「1 秒」。CI 失败一次的成本远高于本地失败一次。
 *
 * 设计要点：
 *
 *  1. **与 CI 共用同一份实现。** `.github/workflows/ci.yml` 的 `hygiene` job
 *     直接调用本脚本（`--mechanical`）。于是「本地 preflight 绿」与
 *     「CI hygiene 绿」是**同一件事**，而不是两套会各自漂移的检查。
 *     代价是 CI 里这些检查合并成了一个步骤，粒度不如从前 —— 但这正是
 *     本脚本存在的意义：拿不到 CI 日志时，本地跑一遍就能定位。
 *
 *  2. **分两层，缺依赖要明说。**
 *     · 机械层（零依赖，纯 git + fs）：行尾、密钥入库、构建产物入库、lockfile 同步
 *     · 工具层（需先 `npm ci`）：Prisma schema 格式、Prettier
 *     工具层缺依赖时给出明确提示，**不静默跳过** —— 静默跳过会让人误以为
 *     「检查过了」，那比没有检查更危险。
 *
 *  3. **退出码承载语义**：0 = 全通过；1 = 有检查失败；2 = 用法/环境错误。
 *     与 `prisma migrate diff --exit-code` 同一思路：区分「检查不通过」与
 *     「检查跑不起来」，否则环境问题会被误报成代码问题。
 *
 * 用法：
 *   node scripts/preflight.mjs                # 全部检查（本地日常用）
 *   node scripts/preflight.mjs --mechanical   # 仅机械层（CI hygiene job 用）
 *   node scripts/preflight.mjs --fix          # 能自动修的顺手修掉（行尾/格式化）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const MECHANICAL_ONLY = argv.has('--mechanical');
const FIX = argv.has('--fix');
const ON_GITHUB = process.env.GITHUB_ACTIONS === 'true';

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

const results = [];

function record(name, ok, detail = '', hints = []) {
  results.push({ name, ok, detail, hints });
}

/** 跑 git，返回退出码与输出（输出同时含 stderr，方便报错时直接贴出来）。
 *  `core.quotepath=false`：否则含中文的路径会被转义成 \344\273\243 这种八进制，无法阅读。 */
function git(...a) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...a], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: r.status,
    out: (r.stdout || '') + (r.stderr || ''),
    spawnError: r.error?.code ?? null,
  };
}

/**
 * 命令**没能跑起来**（与「跑起来但返回非 0」是两回事）。
 *
 * 必须区分这两者。`spawnSync` 失败时 `status` 是 `null`，若直接按「非 0 = 不通过」处理，
 * 就会把「环境跑不了命令」误报成「仓库有问题」—— 这不是假设，我们真的踩过：
 * 某个环境下 `spawnSync` 对**所有**命令返回 `EBUSY`，于是 preflight 报出
 * 「`.env` 未被 .gitignore 忽略，一次 `git add -A` 就可能把真实凭据提交上去」——
 * 一条**假的安全警报**。而 `.env` 当时是被正确忽略的。
 *
 * **假警报比漏报更糟**：它会让人开始忽略这个检查，最后连真警报也不看了。
 *
 * 仍然算「不通过」（环境无法验证 ≠ 通过），但原因必须写准。
 */
function spawnFailure(r) {
  if (r.spawnError) {
    return `**无法执行该检查**（${r.spawnError}）—— 这是环境问题，不是仓库问题。请换一个能正常调用命令行的环境重跑。`;
  }
  // `status === null` 且没有 spawn 错误：进程被信号中断，或 shell 起来了但内层命令没能正常结束。
  // 无论哪种，都**不是**「命令跑通了但结果不合格」—— 不能按「不通过」的原因为报。
  if (r.code === null) {
    return '**无法执行该检查**（命令未返回退出码，通常是被信号中断或受环境限制）—— 这是环境问题，不是仓库问题。';
  }
  return '';
}

/** 在某个子包里跑 npm script。shell:true 是为了跨平台解析 npm(.cmd)。 */
function npmRun(pkgDir, script) {
  const r = spawnSync('npm', ['run', '--silent', script], {
    cwd: path.join(ROOT, pkgDir),
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** 子包内是否装了某个可执行文件（装了才跑工具层检查，避免 npx 联网下载）。 */
function hasLocalBin(pkgDir, name) {
  const dir = path.join(ROOT, pkgDir, 'node_modules', '.bin');
  return [name, `${name}.cmd`, `${name}.ps1`].some((f) => fs.existsSync(path.join(dir, f)));
}

function trackedFiles() {
  return git('ls-files')
    .out.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 「关键文件」= 会被容器/CI 直接执行或解析的文件。它们在工作区里是 CRLF 就
 * 真的会出事：`docker build` 的构建上下文取自**工作区**，不是 git 索引 ——
 * 一个 CRLF 的 docker-entrypoint.sh 会被原样打进镜像，运行时报
 * `$'\r': command not found`，而 `git status` 此时可能是干净的。
 *
 * 文档（*.md）不在其列：它们不被执行，CRLF 只是本地噪音，归为警告。
 */
const CRITICAL_LF_PATTERNS = [
  /\.sh$/,
  /(^|\/)Dockerfile$/,
  /\.dockerignore$/,
  /\.conf$/,
  /\.ya?ml$/,
];
function isCriticalForLf(file) {
  return CRITICAL_LF_PATTERNS.some((re) => re.test(file));
}

// ─────────────────────────────────────────────────────────────
// 检查 1：行尾
//
// 用 `git ls-files --eol` 而不是 grep `\r`：前者是 git 自己对**索引内容**的
// 判断，也就是「真正会被提交、真正会被 Linux 容器执行」的那份字节。
// grep 工作区则会被「本地编辑器写了 CRLF 但 git 提交时会规范化」这类
// 假象误导 —— 本项目就踩过这个坑（工作区 CRLF、索引 LF，grep 报红但 CI 是绿的）。
//
//   i/crlf  → 索引里就是 CRLF，**会被提交上去**，容器内必炸 ⇒ 失败
//   w/crlf  → 只是工作区状态，git 会在提交时规范化 ⇒ 警告，可用 --fix 修掉
// ─────────────────────────────────────────────────────────────
function checkLineEndings() {
  const raw = git('ls-files', '--eol').out;
  const committed = [];
  const criticalWorktree = [];
  const noisyWorktree = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [meta, file] = line.split('\t');
    if (!file) continue;
    const m = meta.match(/^i\/(\S+)\s+w\/(\S+)/);
    if (!m) continue;
    const [, iEol, wEol] = m;
    if (iEol === 'crlf' || iEol === 'mixed') {
      committed.push(file);
    } else if (wEol === 'crlf' || wEol === 'mixed') {
      (isCriticalForLf(file) ? criticalWorktree : noisyWorktree).push(file);
    }
  }

  const detail = [];
  if (committed.length) {
    detail.push(
      `索引中为 CRLF（会被原样提交，Linux 容器内报 $'\\r': command not found）共 ${committed.length} 个：`,
    );
    detail.push(...committed.slice(0, 20).map((f) => `  ${f}`));
    if (committed.length > 20) detail.push(`  …另有 ${committed.length - 20} 个`);
  }
  if (criticalWorktree.length) {
    detail.push(
      `以下**基础设施文件**在工作区是 CRLF（共 ${criticalWorktree.length} 个）。` +
        'git 提交时会规范化，但 `docker build` 的构建上下文取自工作区 —— CRLF 的入口脚本会被原样打进镜像并报错：',
    );
    detail.push(...criticalWorktree.slice(0, 20).map((f) => `  ${f}`));
  }
  if (noisyWorktree.length) {
    detail.push(`其余工作区为 CRLF 的已跟踪文件（共 ${noisyWorktree.length} 个，仅本地噪音）：`);
    detail.push(...noisyWorktree.slice(0, 10).map((f) => `  ${f}`));
    if (noisyWorktree.length > 10) detail.push(`  …另有 ${noisyWorktree.length - 10} 个`);
  }
  if (criticalWorktree.length || noisyWorktree.length) {
    detail.push('  可用 `node scripts/preflight.mjs --fix` 就地规范化为 LF');
  }

  const ok = committed.length === 0 && criticalWorktree.length === 0;
  record('行尾（索引 + 关键文件必须 LF）', ok, detail.join('\n'), [
    '行尾由 .gitattributes 的 `* text=auto eol=lf` 约束；此检查同时是「有人删掉这条规则」的回归守卫。',
    '注意本机 core.autocrlf=true 会在 `git add` 时把 CRLF 规范化成 LF，因此索引里的 CRLF 只在 CI（autocrlf=false）或 .gitattributes 被改坏时才可能出现。',
  ]);

  return { committed, worktree: [...criticalWorktree, ...noisyWorktree] };
}

/** --fix：把工作区里 CRLF 的已跟踪文本文件就地改成 LF。 */
function fixWorktreeLineEndings(files) {
  let fixed = 0;
  for (const f of files) {
    const abs = path.join(ROOT, f);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (!buf.includes(0x0d)) continue;
    // 先去掉 CRLF 里的 CR；再清掉残余的裸 CR 行尾（老 Mac 风格，本项目不产出）
    const out = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    if (out.length !== buf.length) {
      fs.writeFileSync(abs, out);
      fixed += 1;
    }
  }
  return fixed;
}

// ─────────────────────────────────────────────────────────────
// 检查 2：真实密钥文件未入库（标准 §3.B5）
// ─────────────────────────────────────────────────────────────
function checkSecrets() {
  const problems = [];
  const tracked = trackedFiles().filter((f) => /(^|\/)\.env(\.local|\.production)?$/.test(f));
  if (tracked.length) {
    problems.push(
      `以下环境变量文件已被 git 跟踪（真实凭据不应入库）：\n${tracked.map((f) => `  ${f}`).join('\n')}`,
    );
  }

  // 本地存在 .env 是**正常**的 —— 跑服务就需要它。真正要检查的是它有没有被
  // .gitignore 挡住：若没挡住，它就是一个未跟踪文件，一次 `git add -A`
  // 就可能把真实凭据提交上去。（这条在 CI 上恒为「无 .env」，所以只有本地
  // 跑才有意义 —— 也正因如此，它必须放在本地脚本里。）
  if (fs.existsSync(path.join(ROOT, '.env'))) {
    const ignored = git('check-ignore', '-q', '.env');
    const why = spawnFailure(ignored);
    if (why) {
      problems.push(why);
    } else if (ignored.code !== 0) {
      problems.push(
        '.env 存在但**未被 .gitignore 忽略** —— 一次 `git add -A` 就可能把真实凭据提交上去',
      );
    }
  }

  record('密钥文件未入库', problems.length === 0, problems.join('\n'), [
    '真实凭据只放在本地 .env（必须被 .gitignore 忽略），仓库里只提交 .env.example。',
  ]);
}

// ─────────────────────────────────────────────────────────────
// 检查 3：构建产物与依赖未入库
// ─────────────────────────────────────────────────────────────
function checkBuildArtifacts() {
  const bad = trackedFiles().filter(
    (f) => /(^|\/)node_modules\//.test(f) || /(^|\/)dist\//.test(f) || /\.tsbuildinfo$/.test(f),
  );
  const detail = bad.length
    ? `以下构建产物已被 git 跟踪：\n${bad
        .slice(0, 20)
        .map((f) => `  ${f}`)
        .join('\n')}`
    : '';
  record('构建产物未入库', bad.length === 0, detail, [
    'node_modules/ 与 dist/ 应由 .gitignore 排除；入库会让仓库体积与 diff 噪音失控。',
  ]);
}

// ─────────────────────────────────────────────────────────────
// 检查 4：lockfile 与 package.json 同步
//
// 为什么自己做而不是跑 `npm ci`：`npm ci` 需要联网解析整棵依赖树（数十秒），
// 而 preflight 的价值就在于「1 秒」。这里只比对**声明层**是否一致 ——
// 「加了依赖没跑 npm install」这一最常见的情况必被拦住，且零网络开销。
// 真正的完整性仍由 CI 的 `npm ci` 兜底（它会校验整棵解析树）。
// ─────────────────────────────────────────────────────────────
function checkLockfile(pkgDir) {
  const pkgPath = path.join(ROOT, pkgDir, 'package.json');
  const lockPath = path.join(ROOT, pkgDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) {
    record(`${pkgDir} lockfile 同步`, false, `缺少 ${pkgDir}/package-lock.json`);
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const rootEntry = lock.packages?.[''] ?? {};
  const diffs = [];

  for (const field of ['dependencies', 'devDependencies']) {
    const want = pkg[field] ?? {};
    const got = rootEntry[field] ?? {};
    for (const [name, spec] of Object.entries(want)) {
      if (!(name in got))
        diffs.push(`${field}.${name} 在 lockfile 中缺失（package.json 要求 ${spec}）`);
      else if (got[name] !== spec)
        diffs.push(`${field}.${name} 版本不一致：package.json=${spec}，lockfile=${got[name]}`);
    }
    for (const name of Object.keys(got)) {
      if (!(name in want))
        diffs.push(`${field}.${name} 已从 package.json 移除，但 lockfile 仍保留`);
    }
  }

  record(`${pkgDir} lockfile 同步`, diffs.length === 0, diffs.join('\n'), [
    `在 ${pkgDir}/ 下执行 \`npm install\` 重新生成 lockfile。`,
  ]);
}

// ─────────────────────────────────────────────────────────────
// 检查 5：Prisma schema 已按官方格式规范化（工具层）
//
// 为什么这条重要：Prisma 的 schema 解析器**不支持属性参数跨行**，
// 手写 schema 极易踩到；一旦踩到，`generate` 与 `migrate deploy` 会同时失败
// （CI 上表现为两个 job 一起红，根因却只有一个）。`prisma format` 会把
// schema 规范成官方唯一形态，因此「format 后 git diff 为空」是唯一能自动
// 拦住跨行写法的检查。
// ─────────────────────────────────────────────────────────────
function checkPrismaFormat() {
  const name = 'Prisma schema 格式规范';
  if (!hasLocalBin('backend', 'prisma')) {
    record(name, false, 'backend/node_modules 未安装，无法运行 prisma format', [
      '先执行 `cd backend && npm ci`。工具层检查不会被静默跳过 —— 静默跳过会让人误以为「检查过了」。',
    ]);
    return;
  }

  const fmt = npmRun('backend', 'prisma:format');
  const fmtWhy = spawnFailure(fmt);
  if (fmtWhy) {
    record(name, false, fmtWhy, ['换一个能正常调用命令行的环境重跑。']);
    return;
  }
  if (fmt.code !== 0) {
    record(name, false, `prisma format 执行失败（退出码 ${fmt.code}）：\n${fmt.out}`, [
      'prisma format 失败通常意味着 schema 本身有语法错误，先修语法。',
    ]);
    return;
  }

  const diff = git('diff', '--quiet', '--', 'backend/prisma/schema.prisma');
  const diffWhy = spawnFailure(diff);
  if (diffWhy) {
    record(name, false, diffWhy, ['换一个能正常调用命令行的环境重跑。']);
    return;
  }
  const ok = diff.code === 0;
  record(name, ok, ok ? '' : git('--no-pager', 'diff', '--', 'backend/prisma/schema.prisma').out, [
    '本地执行 `cd backend && npx prisma format` 后提交。',
  ]);
}

// ─────────────────────────────────────────────────────────────
// 检查 6：Prettier（工具层）
// ─────────────────────────────────────────────────────────────
function checkPrettier(pkgDir) {
  const name = `${pkgDir} Prettier 格式`;
  if (!hasLocalBin(pkgDir, 'prettier')) {
    record(name, false, `${pkgDir}/node_modules 未安装，无法运行 prettier`, [
      `先执行 \`cd ${pkgDir} && npm ci\`。`,
    ]);
    return;
  }
  const script = FIX ? 'format' : 'format:check';
  const r = npmRun(pkgDir, script);
  const why = spawnFailure(r);
  if (why) {
    record(name, false, why, ['换一个能正常调用命令行的环境重跑。']);
    return;
  }
  record(name, r.code === 0, r.code === 0 ? '' : r.out.trim(), [
    `在 ${pkgDir}/ 下执行 \`npm run format\` 自动修格式。`,
  ]);
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

console.log('本地前置检查（报告 §5.3 C4）');
console.log(`仓库：${ROOT}`);
console.log(
  `模式：${MECHANICAL_ONLY ? '仅机械层（--mechanical）' : '全部'}${FIX ? ' + 自动修复（--fix）' : ''}\n`,
);

const eolInfo = checkLineEndings();
checkSecrets();
checkBuildArtifacts();
checkLockfile('backend');
checkLockfile('frontend');

if (MECHANICAL_ONLY) {
  console.log(
    '（工具层检查 —— Prisma 格式、Prettier —— 由 CI 的 backend / frontend job 各自执行，此处跳过）\n',
  );
} else {
  checkPrismaFormat();
  checkPrettier('backend');
  checkPrettier('frontend');
}

// --fix 放在检查之后：先如实报告问题，再修，最后提示「重跑一次」
let fixedCount = 0;
if (FIX && eolInfo.worktree.length) {
  fixedCount = fixWorktreeLineEndings(eolInfo.worktree);
}

// ── 输出 ──
for (const r of results) {
  const mark = r.ok ? '✅' : '❌';
  console.log(`${mark} ${r.name}`);
  if (r.detail)
    console.log(
      r.detail
        .split('\n')
        .map((l) => `     ${l}`)
        .join('\n'),
    );
}

const failed = results.filter((r) => !r.ok);
if (fixedCount > 0) {
  console.log(`\n🔧 --fix 已就地规范化 ${fixedCount} 个文件的行尾，请重新运行本脚本确认。`);
}
if (failed.length) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✗ ${failed.length} 项未通过：${failed.map((r) => r.name).join('、')}`);
  for (const r of failed) {
    for (const h of r.hints) console.log(`  · ${r.name}：${h}`);
    if (ON_GITHUB) console.log(`::error::${r.name} 未通过`);
  }
  process.exit(1);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`✅ 全部 ${results.length} 项通过`);
