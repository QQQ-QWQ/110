/**
 * 登录失败限流 —— **纯逻辑，无 IO，时钟由调用方注入**（报告 §5.2 S7）。
 *
 * 与 `semaphore.ts` 的分工：信号量管的是「同时在途的密码校验数」（**容量**），
 * 这里管的是「某个来源连续失败了多少次」（**配额**）。两者回答不同的问题：
 *   · 闸门：服务端 CPU 被打满 → 503（容量信号，稍后重试能成功）
 *   · 限流：某个来源在猜密码 → 429（配额信号，别再试了）
 * 因此返回码也不同，这一点是刻意的。
 *
 * 三处设计取舍：
 *
 *  1. **键 = 账号 + IP 的组合**。只用账号做键，攻击者随便失败几次就能把某个
 *     真实用户**锁在门外**（拿别人的账号当武器）；只用 IP 做键，同一条出口 NAT
 *     背后的所有人会互相牵连，而分布式攻击又能绕开。组合键把攻击者的成本提到
 *     「必须同时命中同一个账号**且**来自同一个 IP」。
 *     代价要如实说：**分布式攻击（多 IP 打同一账号）能绕开这个键**。
 *     更强的做法是再叠一层「按 IP 计数、阈值更高」的规则，本项目规模下先不做。
 *
 *  2. **窗口 + 封禁都是固定时长，不做滑动窗口**。滑动窗口更精确，但要保存每次
 *     失败的时刻并做二分，内存与复杂度都上一个台阶。对本场景（防在线猜密码）
 *     固定窗口足够 —— 攻击者最关心的是「能不能持续快速试」，而不是精确的速率。
 *
 *  3. **键数量有上限，超了淘汰最久未用的**。内存实现必须有界，否则攻击者用海量
 *     随机账号就能把内存撑爆 —— 那等于用限流本身做了一次 DoS。
 */
import { Errors } from '../core/errors';

export interface ThrottleConfig {
  /** 窗口内允许的失败次数；达到即封禁 */
  maxFailures: number;
  /** 失败计数窗口（毫秒） */
  windowMs: number;
  /** 封禁时长（毫秒） */
  lockoutMs: number;
}

interface Entry {
  /** 窗口内的失败时刻（毫秒） */
  failures: number[];
  /** 封禁截止时刻（毫秒）；0 表示未封禁 */
  lockedUntil: number;
}

export const DEFAULT_THROTTLE: ThrottleConfig = {
  maxFailures: 5,
  windowMs: 10 * 60 * 1000,
  lockoutMs: 5 * 60 * 1000,
};

/** 键数量上限：超出后淘汰最久未使用的键（防止用海量随机账号撑爆内存） */
export const DEFAULT_MAX_KEYS = 10_000;

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly config: ThrottleConfig = DEFAULT_THROTTLE,
    private readonly maxKeys: number = DEFAULT_MAX_KEYS,
  ) {
    if (!Number.isInteger(config.maxFailures) || config.maxFailures < 1) {
      throw new Error(`maxFailures 必须是不小于 1 的整数（收到：${config.maxFailures}）`);
    }
    if (!Number.isInteger(config.windowMs) || config.windowMs < 1) {
      throw new Error(`windowMs 必须是不小于 1 的整数（收到：${config.windowMs}）`);
    }
    if (!Number.isInteger(config.lockoutMs) || config.lockoutMs < 1) {
      throw new Error(`lockoutMs 必须是不小于 1 的整数（收到：${config.lockoutMs}）`);
    }
  }

  /**
   * 该键是否处于封禁中。返回剩余秒数（供 `Retry-After` 使用）；0 表示放行。
   * **纯查询，不改变状态** —— 调用方可以放心地在检查前调用它。
   */
  retryAfterSeconds(key: string, now: number): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;

    if (entry.lockedUntil > now) {
      return Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000));
    }

    // 封禁已过且窗口内没有残留失败 → 惰性回收，避免专门跑一次遍历
    if (entry.failures.length === 0) this.entries.delete(key);
    return 0;
  }

  /** 封禁中则抛 429（带剩余秒数），否则返回。用于在鉴权前快速拒绝。 */
  assertNotLocked(key: string, now: number): void {
    const retryAfter = this.retryAfterSeconds(key, now);
    if (retryAfter > 0) {
      throw Errors.tooManyRequests(`登录失败次数过多，请 ${retryAfter} 秒后再试`, retryAfter);
    }
  }

  /** 记一次失败；达到阈值即封禁。 */
  recordFailure(key: string, now: number): void {
    const cutoff = now - this.config.windowMs;
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };

    entry.failures = entry.failures.filter((t) => t > cutoff);
    entry.failures.push(now);

    if (entry.failures.length >= this.config.maxFailures) {
      entry.lockedUntil = now + this.config.lockoutMs;
      // 封禁期间不再累积计数：解禁后从头开始，否则一解禁就又被立刻封禁
      entry.failures = [];
    }

    // 重新插入以维护「最近使用在最后」的顺序（Map 保持插入序）
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evictIfNeeded();
  }

  /** 登录成功 → 清空该键的失败记录（避免「错几次后成功」仍被累计） */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** 当前跟踪的键数量（观测与测试用） */
  get size(): number {
    return this.entries.size;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

/**
 * 限流键：账号 + 客户端 IP。
 *
 * 账号统一转小写并去掉首尾空白 —— 否则 `Alice` / `alice ` / `ALICE` 会各自开一份
 * 计数，攻击者只要变个大小写就能把「5 次」变成无限次。代价是用户连续把大小写
 * 打错 5 次也会被计入（等 5 分钟即可），这个代价换「计数不能被稀释」是值得的。
 *
 * 注意：**锁是绑在 (账号, IP) 上的，因此无法被用来把别人锁在门外** ——
 * 攻击者在自己 IP 上把某个账号打到封禁，不影响该账号从其它 IP 正常登录。
 * 这正是选择组合键、而不是「只按账号计数」的原因。
 */
export function throttleKeyOf(account: string, ip: string | undefined): string {
  return `${String(account ?? '')
    .trim()
    .toLowerCase()}|${ip ?? 'unknown'}`;
}
