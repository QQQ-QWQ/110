#!/usr/bin/env node
/**
 * 依赖漏洞扫描（报告 §6.5 P3）
 *
 * 为什么不直接用 `npm audit --audit-level=high`：
 * 本仓库有**一个已知且无法非破坏修复**的 high（见 ALLOWLIST）。若直接用 npm audit
 * 当门禁，它会让 CI **永久变红** —— 而一条永远红的门禁等于没有门禁：
 * 大家会习惯性地忽略它，新出现的真漏洞也就一起被忽略了。
 *
 * 因此这里做的是「**阻断 high/critical，但允许显式、有日期的例外**」：
 *   · 任何 high / critical，只要不在白名单里 → 失败
 *   · 白名单里的条目必须写清**为什么可以接受**与**何时复核**
 *   · 白名单里的条目若**已经消失**（依赖被修好了）→ 也失败，提醒把它删掉
 *     （否则白名单会越长越多，最后变成一张「什么都放行」的清单）
 *
 * 用法：node scripts/check-audit.mjs
 * 退出码：0 = 通过；1 = 有未豁免的 high/critical，或白名单已过期；2 = 命令自身失败
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['backend', 'frontend'];

/**
 * 已知且**当前无法非破坏修复**的漏洞。
 *
 * 每条都必须写清三件事：是哪个包、为什么可以接受、什么时候复核。
 * 没有理由的条目不应该存在 —— 那只是在关掉警报。
 */
const ALLOWLIST = [
  {
    ghsa: 'GHSA-ggr8-5vv4-36mx',
    module: 'deepmerge-ts',
    severity: 'high',
    reason:
      'deepmerge-ts 经 prisma → @prisma/config 传入（@prisma/config 精确锁定 7.1.5）。' +
      '唯一修复是升级到 Prisma 8（大版本），代价与风险都远超收益。' +
      '实际可利用性极低：该漏洞需要合并**攻击者可控的递归对象图**，' +
      '而 Prisma 的配置来自仓库内的静态文件；且 prisma 只在构建/容器启动时作为 CLI 使用，' +
      '不在 HTTP 请求路径上。',
    reviewedAt: '2026-10-05',
    revisitWhen: 'Prisma 发布包含 deepmerge-ts>=8 的 6.x/7.x 版本时',
  },
];

const BLOCKING = new Set(['high', 'critical']);

/** 跑一次 npm audit --json；即使有漏洞也会返回非零退出码，因此只看 stdout */
function auditJson(pkgDir) {
  const r = spawnSync('npm', ['audit', '--json'], {
    cwd: path.join(ROOT, pkgDir),
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = r.stdout ?? '';
  if (!raw.trim()) {
    console.error(
      `::error::${pkgDir}：npm audit 没有输出（退出码 ${r.status}）—— 命令本身可能失败`,
    );
    console.error(r.stderr ?? '');
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.error(`::error::${pkgDir}：npm audit 的输出不是合法 JSON`);
    console.error(raw.slice(0, 500));
    process.exit(2);
  }
}

/**
 * 收集一次 audit 里所有 high/critical 的**独立**漏洞（按 GHSA 去重）。
 *
 * npm audit 的 `via` 里既有对象（具体公告）也有字符串（「因为依赖了某个有漏洞的包」）。
 * 只按对象条目计数，否则同一条公告会沿着依赖链被重复报好几次
 * （deepmerge-ts 报一次、@prisma/config 报一次、prisma 再报一次）。
 *
 * 因此先取每个包的「自有公告」，再沿 `via` 字符串做**传递闭包**，
 * 把公告传播到下游包上（这些下游包只是受害者，不是独立漏洞）。
 * 每个公告同时记录「受影响的下游包」，输出时一并列出，信息不丢。
 */
function blockingFindings(report) {
  const vulns = report.vulnerabilities ?? {};
  const own = new Map(); // 包名 → 自有公告集合
  const advisories = new Map(); // ghsa → { ghsa, module, severity, affected:Set }

  for (const [name, v] of Object.entries(vulns)) {
    const set = new Set();
    for (const a of v.via ?? []) {
      if (typeof a !== 'object' || !a.url) continue;
      const ghsa = String(a.url).split('/').pop();
      set.add(ghsa);
      const entry = advisories.get(ghsa) ?? {
        ghsa,
        module: name,
        severity: v.severity,
        affected: new Set(),
      };
      entry.affected.add(name);
      advisories.set(ghsa, entry);
    }
    own.set(name, set);
  }

  // 传递闭包：`via` 里的字符串表示「因为依赖了它才受影响」
  for (let pass = 0; pass < Object.keys(vulns).length; pass += 1) {
    let changed = false;
    for (const [name, v] of Object.entries(vulns)) {
      const mine = own.get(name);
      for (const dep of v.via ?? []) {
        if (typeof dep !== 'string') continue;
        for (const ghsa of own.get(dep) ?? []) {
          if (!mine.has(ghsa)) {
            mine.add(ghsa);
            changed = true;
          }
          advisories.get(ghsa)?.affected.add(name);
        }
      }
    }
    if (!changed) break;
  }

  const out = new Map();
  for (const [ghsa, entry] of advisories) {
    if (BLOCKING.has(entry.severity)) out.set(ghsa, entry);
  }

  // 安全网：high/critical 的包若最终没有归到任何公告上，说明 npm 换了输出结构 ——
  // 不能静默漏掉，报成「未分类」让它显形。
  const covered = new Set([...out.values()].flatMap((e) => [...e.affected]));
  for (const [name, v] of Object.entries(vulns)) {
    if (BLOCKING.has(v.severity) && !covered.has(name)) {
      out.set(`${name}:unclassified`, {
        ghsa: null,
        module: name,
        severity: v.severity,
        affected: new Set([name]),
      });
    }
  }

  return out;
}

console.log('依赖漏洞扫描（报告 §6.5 P3）');
console.log(`阻断级别：${[...BLOCKING].join(' / ')}；白名单 ${ALLOWLIST.length} 条\n`);

const allowByGhsa = new Map(ALLOWLIST.map((a) => [a.ghsa, a]));
const seenAllowlisted = new Set();
const violations = [];

for (const pkg of PACKAGES) {
  const report = auditJson(pkg);
  const meta = report.metadata?.vulnerabilities ?? {};
  console.log(
    `${pkg}：total ${meta.total ?? 0}（critical ${meta.critical ?? 0} / high ${meta.high ?? 0} / ` +
      `moderate ${meta.moderate ?? 0} / low ${meta.low ?? 0}）`,
  );

  const findings = blockingFindings(report);
  if (findings.size === 0) {
    console.log(`  ✅ 无 high / critical`);
    continue;
  }
  for (const f of findings.values()) {
    const allowed = f.ghsa ? allowByGhsa.get(f.ghsa) : undefined;
    const affected = [...f.affected].join(' → ');
    if (allowed) {
      seenAllowlisted.add(f.ghsa);
      console.log(
        `  ⚠️  ${f.severity}  ${f.module}  ${f.ghsa} —— 已豁免（复核时间：${allowed.reviewedAt}）`,
      );
      console.log(`      受影响：${affected}`);
    } else {
      violations.push({ pkg, ...f, affected });
      console.log(`  ❌ ${f.severity}  ${f.module}  ${f.ghsa ?? '(无 GHSA)'} —— **未豁免**`);
      console.log(`      受影响：${affected}`);
    }
  }
}

// 白名单腐化检测：已修好的条目必须删掉，否则清单会越来越像「什么都放行」
const stale = ALLOWLIST.filter((a) => BLOCKING.has(a.severity) && !seenAllowlisted.has(a.ghsa));
if (stale.length > 0) {
  console.log('\n以下白名单条目已经不再出现（依赖可能已被修好）：');
  for (const a of stale) console.log(`  · ${a.ghsa}  ${a.module}`);
  console.log('请删除对应条目 —— 否则白名单会逐渐变成一张「什么都放行」的清单。');
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log('::error::依赖漏洞白名单已过期，请删除已修复的条目');
  }
  process.exit(1);
}

if (violations.length > 0) {
  console.log(`\n❌ ${violations.length} 项未豁免的 high / critical：`);
  for (const v of violations)
    console.log(`  · ${v.pkg}  ${v.severity}  ${v.module}  ${v.ghsa ?? ''}`);
  console.log('\n要么升级依赖修掉它，要么在 scripts/check-audit.mjs 的 ALLOWLIST 里');
  console.log('写清「为什么可以接受」与「何时复核」—— 不允许无理由放行。');
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log('::error::存在未豁免的高危依赖漏洞');
  }
  process.exit(1);
}

console.log(
  `\n✅ 无未豁免的 high / critical（豁免 ${seenAllowlisted.size} 项，均已记录理由与复核时间）`,
);
