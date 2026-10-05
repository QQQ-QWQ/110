import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from './core/prisma.service';

/**
 * 健康探针（报告 §5.2 S6）。
 *
 * 为什么要把 liveness 与 readiness 分开 —— 两者回答的是**不同的问题**，
 * 而容器编排系统对它们的处置也完全不同：
 *
 *  · **liveness**：「这个进程还活着吗？」
 *    只表示进程能响应请求。**绝不查数据库** —— 否则数据库一抖，编排系统会认为
 *    进程坏了并**重启它**，而重启应用对「数据库不可用」毫无帮助，只会让恢复更慢
 *    （连接池重建、正在处理的请求被切断）。这正是把 liveness 做成「深度检查」
 *    最典型的自伤方式。
 *
 *  · **readiness**：「现在能把流量交给它吗？」
 *    需要真实探测依赖（这里是数据库）。依赖不可用时返回 **503**，编排系统把该实例
 *    从负载均衡里摘掉，但**不重启** —— 等依赖恢复后自动重新纳入。
 *
 * `/api/health` 保留为 **readiness 的别名**：它是既有 `docker-compose.yml`
 * healthcheck 与验收脚本使用的路径，改语义会造成不必要的破坏。三者都保留。
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** liveness：只证明「进程能响应」，刻意不碰任何外部依赖。 */
  @Get('live')
  live() {
    return {
      ok: true,
      probe: 'liveness',
      service: 'demand-acceptance-backend',
      time: new Date().toISOString(),
    };
  }

  /**
   * readiness：真实探测数据库。
   * 不可用时返回 503（而不是 500）—— 这是「暂时不可服务、稍后会恢复」的语义，
   * 与 500「处理请求时出错」有本质区别。
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const time = new Date().toISOString();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      res.status(503);
      return {
        ok: false,
        probe: 'readiness',
        service: 'demand-acceptance-backend',
        database: 'unreachable',
        time,
      };
    }
    return {
      ok: true,
      probe: 'readiness',
      service: 'demand-acceptance-backend',
      database: 'ok',
      time,
    };
  }

  /** 兼容别名：语义等同 readiness（既有 compose healthcheck 与脚本用这个路径）。 */
  @Get()
  async health(@Res({ passthrough: true }) res: Response) {
    return this.ready(res);
  }
}
