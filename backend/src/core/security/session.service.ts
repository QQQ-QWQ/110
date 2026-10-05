import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/** 会话 Cookie 名 */
export const SESSION_COOKIE = 'sid';
/** 绝对过期：自登录起 8 小时，不可续期 */
export const SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
/** 空闲过期：30 分钟无操作即失效 */
export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
/** 活跃度写回节流，避免每个请求都写库 */
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  account: string;
  name: string;
}

/**
 * 会话服务。
 *
 * 选择「服务端会话表」而非无状态 JWT 的原因：
 * 需求要求「退出登录」后旧凭据立即失效——JWT 做不到即时失效（除非引入黑名单，
 * 那等于又回到有状态）。会话存 PostgreSQL 也是因为架构约束禁止引入 Redis。
 */
@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string): Promise<{ sessionId: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_TTL_MS);
    const session = await this.prisma.session.create({
      data: { userId, expiresAt },
    });
    return { sessionId: session.id, expiresAt };
  }

  /** 校验会话；过期则顺手删除并返回 null */
  async resolve(sessionId: string): Promise<ResolvedSession | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });
    if (!session) return null;

    const now = Date.now();
    const expired =
      session.expiresAt.getTime() <= now ||
      now - session.lastSeenAt.getTime() > SESSION_IDLE_TTL_MS;

    if (expired) {
      await this.destroy(sessionId);
      return null;
    }

    if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.session.update({
        where: { id: sessionId },
        data: { lastSeenAt: new Date(now) },
      });
    }

    return {
      sessionId: session.id,
      userId: session.user.id,
      account: session.user.account,
      name: session.user.name,
    };
  }

  /** 退出登录：服务端立即删除，旧 Cookie 立刻失效 */
  async destroy(sessionId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  async destroyAllForUser(userId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { userId } });
  }
}
