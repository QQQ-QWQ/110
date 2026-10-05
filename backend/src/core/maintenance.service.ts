import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  IDEMPOTENCY_RETENTION_MS,
  idempotencyPurgeWhere,
  sessionPurgeWhere,
  staleProcessingWhere,
} from '../domain/retention';
import { PrismaService } from './prisma.service';

/** 一次清理的结果，便于日志与验证脚本断言 */
export interface PurgeResult {
  idempotencyDeleted: number;
  sessionsDeleted: number;
  /** 滞留的 PROCESSING 幂等记录数（**只告警，不删除**） */
  staleProcessing: number;
}

/**
 * 执行**一次**清理。
 *
 * 抽成独立导出函数（而不是只放在定时器回调里）的原因：
 *  · 定时器只决定「何时调用」，与「清理什么」无关，两者应当解耦；
 *  · 验证脚本可以直接 import 本函数对真实数据库做验证，
 *    不必等待定时器触发 —— 否则测试会依赖启动时序而变得不稳定。
 *
 * 幂等性：`deleteMany` 天然可重复执行，因此**多副本同时运行是安全的**
 * （只是做了重复功）。这也是不引入分布式锁的原因 —— 架构约束禁止 Redis，
 * 而为一个幂等操作引入锁只会增加故障点。
 */
export async function purgeOnce(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<PurgeResult> {
  const idempotency = await prisma.idempotencyRecord.deleteMany({
    where: idempotencyPurgeWhere(now),
  });

  const sessions = await prisma.session.deleteMany({
    where: sessionPurgeWhere(now),
  });

  // PROCESSING 滞留 = 有请求在占坑后异常中断（进程被杀、事务超时）。
  // **绝不删除**：删掉会让同一幂等键被重新占坑，幂等语义直接失效。
  const staleProcessing = await prisma.idempotencyRecord.count({
    where: staleProcessingWhere(now),
  });

  return {
    idempotencyDeleted: idempotency.count,
    sessionsDeleted: sessions.count,
    staleProcessing,
  };
}

/**
 * 数据保留清理（定时任务）。
 *
 * 背景：`idempotency_record` 与 `session` 两张表此前**没有任何清理逻辑**，
 * 属无界增长。会话过期行只会在「被访问到时」由 `SessionService.resolve` 顺手删除，
 * 因此登录后不再访问的会话会永久滞留。
 *
 * 环境变量：
 *   MAINTENANCE_ENABLED=false      关闭清理（默认启用）
 *   MAINTENANCE_INTERVAL_MS        间隔，默认 3600000（1 小时）
 *   MAINTENANCE_STARTUP_DELAY_MS   启动后首次执行的延迟，默认 5000
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceService.name);
  private intervalTimer?: ReturnType<typeof setInterval>;
  private startupTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if (process.env.MAINTENANCE_ENABLED === 'false') {
      this.logger.warn('数据保留清理已通过 MAINTENANCE_ENABLED=false 关闭');
      return;
    }

    const intervalMs = Number(process.env.MAINTENANCE_INTERVAL_MS ?? 60 * 60 * 1000);
    const startupDelayMs = Number(process.env.MAINTENANCE_STARTUP_DELAY_MS ?? 5000);

    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      this.logger.error(
        `MAINTENANCE_INTERVAL_MS 取值非法（${process.env.MAINTENANCE_INTERVAL_MS}），清理未启用`,
      );
      return;
    }

    // 启动时先跑一次：部署即完成一轮清理，不必等第一个间隔到期。
    // 延迟一小段是为了避开 entrypoint 中紧随其后的 migrate / seed。
    this.startupTimer = setTimeout(() => void this.run('启动'), startupDelayMs);
    // unref：清理任务不应阻止进程退出，否则优雅停机要干等一个完整间隔
    this.startupTimer.unref?.();

    this.intervalTimer = setInterval(() => void this.run('定时'), intervalMs);
    this.intervalTimer.unref?.();

    this.logger.log(`数据保留清理已启用：每 ${Math.round(intervalMs / 1000)}s 一次`);
  }

  onModuleDestroy(): void {
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
  }

  /** 手动触发一次（供运维与验证使用）。**错误会抛出**，便于调用方感知失败。 */
  async runNow(now?: Date): Promise<PurgeResult> {
    return purgeOnce(this.prisma, now);
  }

  /** 定时器路径：失败只记日志，绝不让清理任务把服务带崩 */
  private async run(trigger: string): Promise<PurgeResult> {
    try {
      const result = await purgeOnce(this.prisma);
      if (result.idempotencyDeleted || result.sessionsDeleted) {
        this.logger.log(
          `[${trigger}] 清理完成：幂等记录 ${result.idempotencyDeleted} 条，过期会话 ${result.sessionsDeleted} 条`,
        );
      }
      if (result.staleProcessing > 0) {
        this.logger.warn(
          `[${trigger}] 存在 ${result.staleProcessing} 条滞留的 PROCESSING 幂等记录` +
            `（超过 ${IDEMPOTENCY_RETENTION_MS / 3600000} 小时未完成）。` +
            `这通常意味着有请求异常中断；**未删除**，因为删除会让同一幂等键被重复占坑。`,
        );
      }
      return result;
    } catch (error) {
      this.logger.error(`[${trigger}] 数据保留清理失败：${(error as Error).message}`);
      return { idempotencyDeleted: 0, sessionsDeleted: 0, staleProcessing: 0 };
    }
  }
}
