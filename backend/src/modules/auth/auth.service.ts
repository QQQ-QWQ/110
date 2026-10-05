import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Errors } from '../../core/errors';
import { LoginGate } from '../../core/login-gate';
import { PrismaService } from '../../core/prisma.service';
import { SessionService } from '../../core/security/session.service';
import { LoginThrottle, throttleKeyOf } from '../../domain/login-throttle';

export interface LoginResult {
  sessionId: string;
  expiresAt: Date;
  user: { id: string; account: string; name: string };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly loginGate: LoginGate,
    private readonly throttle: LoginThrottle,
  ) {}

  async login(account: string, password: string, clientIp?: string): Promise<LoginResult> {
    const key = throttleKeyOf(account, clientIp);
    const now = Date.now();

    // ① 限流**先于**数据库查询与密码校验（报告 §5.2 S7）。
    //    放在最前有两个好处：这是最便宜的拒绝路径；而且「不存在的账号」也会被
    //    同样地限流，因此不会通过 429 与 401 的差异泄露账号是否存在。
    this.throttle.assertNotLocked(key, now);

    const user = await this.prisma.user.findUnique({ where: { account } });

    // 账号不存在与密码错误返回完全相同的提示，避免被用来枚举账号
    if (!user) {
      this.throttle.recordFailure(key, now);
      throw Errors.unauthorized('账号或密码错误');
    }

    // ② 只有**密码校验**进并发闸门（报告 §5.1 E4）：
    // bcryptjs 是纯 JS 实现（Dockerfile 为规避原生模块编译而刻意选择），
    // cost=10 时单次数十至上百毫秒且**在 Node 单线程上烧 CPU**。并发登录会
    // 争抢同一个事件循环，把**所有**接口一起拖慢。闸门把这件事收窄成
    // 「登录排队或快速失败」，而不是「全站不可用」。
    // 上面的数据库查询是便宜 I/O 且有连接池兜底，不塞进闸门 —— 多罩一层
    // 只会降低吞吐，并不额外保护任何东西。
    const ok = await this.loginGate.run(() => bcrypt.compare(password, user.passwordHash));
    if (!ok) {
      this.throttle.recordFailure(key, now);
      throw Errors.unauthorized('账号或密码错误');
    }

    // 成功即清空该键的失败记录：否则「错几次后成功」仍会被累计，
    // 用户下一次正常登录可能莫名其妙被 429。
    this.throttle.recordSuccess(key);

    const { sessionId, expiresAt } = await this.sessions.create(user.id);
    return {
      sessionId,
      expiresAt,
      user: { id: user.id, account: user.account, name: user.name },
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.destroy(sessionId);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, account: true, name: true },
    });
    if (!user) throw Errors.unauthorized();
    return user;
  }

  /** 预置成员列表：创建需求时用来指定负责人（不含密码等敏感字段） */
  async listMembers(excludeUserId?: string) {
    return this.prisma.user.findMany({
      where: excludeUserId ? { id: { not: excludeUserId } } : undefined,
      select: { id: true, name: true, account: true },
      orderBy: { name: 'asc' },
    });
  }
}
