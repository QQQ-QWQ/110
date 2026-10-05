import { Module } from '@nestjs/common';
import { LoginGate } from '../../core/login-gate';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController],
  // LoginGate 只在登录路径用到，因此就近提供在 AuthModule 内，
  // 不提升到全局 —— 全局 provider 会让人误以为它是通用能力。
  providers: [AuthService, LoginGate],
  exports: [AuthService],
})
export class AuthModule {}
