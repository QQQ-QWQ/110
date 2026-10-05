import { Errors } from '../core/errors';

/**
 * 并发闸门（信号量）—— 报告 §5.1 E4，**纯逻辑，无 IO**。
 *
 * 为什么需要它（见报告 §3.4）：
 * 密码校验用的是 `bcryptjs`（**纯 JS 实现**）。这是 Dockerfile 里的刻意决策 ——
 * 避开原生模块编译，保证 `docker compose up --build` 一次成功。代价是它比原生
 * 实现慢约 3~5 倍，且**在 Node 单线程上烧 CPU**。cost=10 时单次校验数十至上百毫秒；
 * 并发登录会互相争抢同一个事件循环，**进而拖慢所有其它请求**（不只是登录）。
 *
 * 所以这里做的不是「让登录更快」，而是**把故障域收窄**：
 *   · 改动前：登录洪峰 → 事件循环被占满 → 全站变慢（不可预期）
 *   · 改动后：登录洪峰 → 登录请求排队或快速失败 → 其它接口不受影响（可预期）
 *
 * 三个设计取舍：
 *
 *  1. **闸门只罩住密码校验，不罩整个登录流程。** 数据库查询是 I/O 且很便宜，
 *     而且已经有连接池兜底（`connection_limit`）。把便宜的部分也塞进闸门只会
 *     降低吞吐，并不额外保护任何东西。
 *
 *  2. **排队但队列有上限。** 「超出则排队」不能是无限排队 —— 那只是把问题从
 *     CPU 挪到内存，洪峰下会 OOM。队列满了就直接拒绝（503），让调用方稍后重试。
 *     拒绝是**快速失败**，比「排很久最后超时」对调用方更友好。
 *
 *  3. **释放时把许可直接交给队首，而不是先还回池子。** 否则「刚到的请求」会与
 *     「已经等了很久的请求」抢同一个许可，等待时间变得不可预期。直接交接保证 FIFO，
 *     也让等待时间有上界。
 */
export class Semaphore {
  /** 当前空闲许可数 */
  private available: number;
  /** 等待队列（FIFO） */
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly permits: number,
    /** 队列上限；超出即快速失败，避免「无限排队」把问题挪到内存 */
    private readonly queueLimit: number,
  ) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore 的 permits 必须是不小于 1 的整数（收到：${permits}）`);
    }
    if (!Number.isInteger(queueLimit) || queueLimit < 0) {
      throw new Error(`Semaphore 的 queueLimit 必须是不小于 0 的整数（收到：${queueLimit}）`);
    }
    this.available = permits;
  }

  /** 正在处理中的数量（用于观测，不参与调度） */
  get inFlight(): number {
    return this.permits - this.available;
  }

  /** 正在排队的数量 */
  get queued(): number {
    return this.waiters.length;
  }

  get capacity(): number {
    return this.permits;
  }

  /**
   * 获取一个许可。
   * · 有空闲 → 立即拿到；
   * · 队列已满 → 立即抛 503（快速失败，而不是排一个注定等很久的队）；
   * · 否则入队等待，超过 `timeoutMs` 仍未拿到 → 抛 503，并**从队列中摘除自己**。
   */
  async acquire(timeoutMs: number): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    if (this.waiters.length >= this.queueLimit) {
      throw Errors.overloaded();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: undefined };

      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          // 关键：超时的 waiter 必须自己出队。否则它会永远占着队列位置，
          // 队列逐渐「泄漏」直到所有人都被 503 —— 这比没有闸门更糟。
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(Errors.overloaded('登录请求排队超时，请稍后重试'));
        }, timeoutMs);
        // 刻意**不** unref：unref 过的定时器不保持事件循环，一旦没有别的
        // 待处理项，进程就会退出，而等待者手里的 Promise 永远不 settle
        // （在测试里表现为整个测试文件被提前取消）。定时器在 release 与
        // 超时两条路径上都会被 clearTimeout，不存在泄漏；代价只是关停时
        // 最多多等 timeoutMs —— 而那恰好是「别把排队中的请求粗暴丢掉」。
      }

      this.waiters.push(waiter);
    });
  }

  /** 释放一个许可：优先交给队首（FIFO），没有等待者才还回池子。 */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
      return;
    }
    // 上限保护：多余的 release 不应把池子撑大
    this.available = Math.min(this.permits, this.available + 1);
  }

  /** 在闸门内执行一段逻辑；无论成功失败都会释放许可。 */
  async run<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** 观测快照，便于日志与断言 */
  stats(): { capacity: number; inFlight: number; queued: number; queueLimit: number } {
    return {
      capacity: this.permits,
      inFlight: this.inFlight,
      queued: this.queued,
      queueLimit: this.queueLimit,
    };
  }
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}
