import { CanActivate, ExecutionContext, Injectable, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';
import { Errors } from '../errors';
import { ResolvedSession, SESSION_COOKIE, SessionService } from './session.service';

export interface AuthedRequest extends Request {
  currentUser?: ResolvedSession;
}

/**
 * 鉴权守卫：所有需要登录的接口都挂它。
 * 操作者身份**一律取自会话**，绝不接受请求体传入的 actor_id —— 这是防越权的第一道闸门。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const sid = req.cookies?.[SESSION_COOKIE];
    if (typeof sid !== 'string' || sid.length === 0) {
      throw Errors.unauthorized();
    }
    const session = await this.sessions.resolve(sid);
    if (!session) {
      throw Errors.unauthorized();
    }
    req.currentUser = session;
    return true;
  }
}

/** 从会话中取出当前用户（已由 AuthGuard 填充） */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ResolvedSession => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.currentUser) throw Errors.unauthorized();
    return req.currentUser;
  },
);
