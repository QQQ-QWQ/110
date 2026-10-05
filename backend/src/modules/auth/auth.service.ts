import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Errors } from '../../core/errors';
import { PrismaService } from '../../core/prisma.service';
import { SessionService } from '../../core/security/session.service';

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
  ) {}

  async login(account: string, password: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { account } });

    // 账号不存在与密码错误返回完全相同的提示，避免被用来枚举账号
    if (!user) {
      throw Errors.unauthorized('账号或密码错误');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      throw Errors.unauthorized('账号或密码错误');
    }

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
