import { Global, Module } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';
import { PrismaService } from './prisma.service';
import { AuthGuard } from './security/auth.guard';
import { SessionService } from './security/session.service';

/**
 * 全局核心模块：数据库连接、会话、鉴权守卫、数据保留清理。
 * 各业务模块无需重复 import。
 */
@Global()
@Module({
  providers: [PrismaService, SessionService, AuthGuard, MaintenanceService],
  exports: [PrismaService, SessionService, AuthGuard, MaintenanceService],
})
export class CoreModule {}
