import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
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

  // 登录不创建可寻址资源，显式声明 200（@Post 默认是 201）
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
    // 客户端 IP 参与限流键（报告 §5.2 S7）。`@Ip()` 在反代后取到的是
    // X-Forwarded-For 的最后一跳 —— 本项目由 nginx 同源反代，因此拿到的是真实客户端 IP。
    @Ip() clientIp: string,
  ) {
    const result = await this.auth.login(dto.account, dto.password, clientIp);

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
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  async logout(@CurrentUser() user: ResolvedSession, @Res({ passthrough: true }) res: Response) {
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
