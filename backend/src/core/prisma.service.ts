import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma 客户端封装。
 * 事务统一走 `$transaction`，写命令管道内的所有步骤共享同一事务。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('数据库连接已建立');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
