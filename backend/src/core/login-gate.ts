import { Logger } from '@nestjs/common';
import { availableParallelism, cpus } from 'node:os';
import { Semaphore } from '../domain/semaphore';

/**
 * 登录并发闸门的配置与装配（报告 §5.1 E4）。
 * 调度逻辑本身在 `domain/semaphore.ts`（纯逻辑、可单测）；这里只负责
 * 「读配置 + 记日志」，把两者分开是为了让核心逻辑不依赖 `process.env`。
 */

export interface LoginGateConfig {
  /** 同时在途的密码校验数上限 */
  concurrency: number;
  /** 排队上限；超出即快速失败 */
  queueLimit: number;
  /** 排队等待上限（毫秒）；0 表示不设超时 */
  timeoutMs: number;
}

/**
 * 默认并发数 = 可用并行度。
 *
 * 用 `os.availableParallelism()` 而不是 `os.cpus().length`：在容器里后者返回的是
 * **宿主机**的核数，会无视 `--cpus` / cgroup 配额 —— 那正好会让我们把闸门开到
 * 超过实际算力的位置，与这个改动的目的相反。`availableParallelism()` 会考虑
 * 进程实际可用的并行度。（Node 18.14+ 提供；旧版本回退到 `cpus().length`。）
 */
export function defaultLoginConcurrency(): number {
  try {
    return Math.max(1, availableParallelism());
  } catch {
    return Math.max(1, cpus()?.length ?? 1);
  }
}

function readInt(raw: string | undefined, fallback: number, name: string, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < min) {
    // 配置写错就**启动失败**，而不是悄悄退回默认值 ——
    // 静默回退会让人以为「闸门开着」，实际却没有。
    throw new Error(`${name} 必须是不小于 ${min} 的整数（收到：${JSON.stringify(raw)}）`);
  }
  return n;
}

export function resolveLoginGateConfig(env: NodeJS.ProcessEnv = process.env): LoginGateConfig {
  return {
    concurrency: readInt(env.LOGIN_CONCURRENCY, defaultLoginConcurrency(), 'LOGIN_CONCURRENCY', 1),
    queueLimit: readInt(env.LOGIN_QUEUE_LIMIT, 50, 'LOGIN_QUEUE_LIMIT', 0),
    timeoutMs: readInt(env.LOGIN_ACQUIRE_TIMEOUT_MS, 5000, 'LOGIN_ACQUIRE_TIMEOUT_MS', 0),
  };
}

/**
 * 登录闸门。`AuthService` 只用它包住**密码校验**那一段 ——
 * 数据库查询是便宜的 I/O，且有连接池兜底，不必也塞进闸门。
 */
export class LoginGate {
  private readonly semaphore: Semaphore;
  private readonly timeoutMs: number;
  private readonly logger = new Logger('LoginGate');

  constructor(readonly config: LoginGateConfig = resolveLoginGateConfig()) {
    this.semaphore = new Semaphore(config.concurrency, config.queueLimit);
    this.timeoutMs = config.timeoutMs;
    this.logger.log(
      `登录并发闸门已启用：并发 ${config.concurrency}，队列上限 ${config.queueLimit}，排队超时 ${config.timeoutMs}ms`,
    );
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const before = this.semaphore.stats();
    if (before.inFlight >= before.capacity) {
      // 只在真的开始排队时记日志，避免正常流量下刷屏
      this.logger.warn(
        `登录闸门已满，请求进入队列（在途 ${before.inFlight}/${before.capacity}，排队 ${before.queued}）`,
      );
    }
    return this.semaphore.run(fn, this.timeoutMs);
  }

  stats(): ReturnType<Semaphore['stats']> {
    return this.semaphore.stats();
  }
}
