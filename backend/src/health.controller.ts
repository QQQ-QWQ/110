import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './core/prisma.service';

/**
 * 健康探针：供 docker-compose healthcheck 与验收使用。
 * 会真实探测数据库连通性，而不是只返回常量。
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return {
      ok: true,
      service: 'demand-acceptance-backend',
      time: new Date().toISOString(),
    };
  }
}
