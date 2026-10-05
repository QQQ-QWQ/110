import { Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Response } from 'express';
import { AuthGuard, CurrentUser } from '../../core/security/auth.guard';
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_COOKIE,
  ResolvedSession,
} from '../../core/security/session.service';
import { AuthService } from './auth.service';

export class LoginDto {
  @IsString()
  @IsNotEmpty({ message: '请输入账号' })
  @MaxLength(100)
  account!: string;

  @IsString()
  @IsNotEmpty({ message: '请输入密码' })
  @MaxLength(200)
  password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto.account, dto.password);

    res.cookie(SESSION_COOKIE, result.sessionId, {
      httpOnly: true,
      sameSite: 'strict',
      // 内网 http 部署下不能强制 secure，否则浏览器不会回传 Cookie
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: SESSION_ABSOLUTE_TTL_MS,
      path: '/',
    });

    return { user: result.user };
  }

  /** 退出登录：服务端立即删除会话，旧 Cookie 立刻失效 */
  @Post('logout')
  @UseGuards(AuthGuard)
  async logout(
    @CurrentUser() user: ResolvedSession,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(user.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@CurrentUser() user: ResolvedSession) {
    return this.auth.me(user.userId);
  }

  /** 预置成员列表：创建需求时选择负责人 */
  @Get('members')
  @UseGuards(AuthGuard)
  async members(@CurrentUser() user: ResolvedSession) {
    return this.auth.listMembers(user.userId);
  }
}
