import { Module } from '@nestjs/common';
import { LoginGate, resolveLoginThrottleConfig } from '../../core/login-gate';
import { LoginThrottle } from '../../domain/login-throttle';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController],
  // 登录防护（并发闸门 + 失败限流）只在登录路径用到，因此就近提供在 AuthModule 内，
  // 不提升到全局 —— 全局 provider 会让人误以为它们是通用能力。
  providers: [
    AuthService,
    LoginGate,
    { provide: LoginThrottle, useFactory: () => new LoginThrottle(resolveLoginThrottleConfig()) },
  ],
  exports: [AuthService],
})
export class AuthModule {}
