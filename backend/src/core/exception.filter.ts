import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { AppError } from './errors';
import { requestIdOf } from './request-id';

/**
 * 统一错误响应。
 *
 * 关键点：
 *  - 4xx 只回传语义化消息，**绝不回传堆栈 / SQL / 内部 ID**；
 *  - 5xx 一律回传通用文案，细节只进服务端日志；
 *  - 前端据此区分「成功 / 失败」，因此失败永远不会被渲染成成功；
 *  - 每条日志都带上请求编号（`rid`），5xx 的响应体里也回传它 ——
 *    用户报障时把编号给出来，就能在日志里精确定位那一次请求（报告 §5.2 S5）。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const rid = requestIdOf(response);
    const where = `${request.method} ${request.originalUrl} rid=${rid ?? '-'}`;

    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = '服务器内部错误，请稍后重试';
    let details: unknown;

    if (exception instanceof AppError) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      const raw = exception.getResponse();
      const rawStatus = exception.getStatus();

      if (rawStatus === 400) {
        // class-validator 的 DTO 校验失败 → 统一为业务校验失败 422
        status = 422;
        code = 'VALIDATION_FAILED';
        const rawMessage = (raw as { message?: string | string[] })?.message;
        message = Array.isArray(rawMessage)
          ? rawMessage.join('；')
          : (rawMessage ?? '请求参数不合法');
      } else {
        status = rawStatus;
        code = `HTTP_${rawStatus}`;
        const rawMessage = (raw as { message?: string | string[] })?.message;
        message = Array.isArray(rawMessage)
          ? rawMessage.join('；')
          : (rawMessage ?? exception.message);
      }
    } else {
      // 未预期异常：记录到服务端，对外只给通用文案
      this.logger.error(
        `${where} 未处理异常`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    if (status >= 500) {
      this.logger.error(`${where} → ${status} ${code}`);
    }

    // 503 表示「稍后重试能成功」（例如登录闸门已满），按 HTTP 语义给出重试建议。
    // 其它 5xx 是故障，重试不一定有用，因此不给。
    if (status === 503) {
      response.setHeader('Retry-After', '1');
    }

    response.status(status).json({
      error: {
        code,
        message,
        ...(details ? { details } : {}),
        // 仅 5xx 回传编号：4xx 是调用方自己的问题，回传它没有意义，
        // 只会无谓地扩大响应契约。5xx 回传，用户才能把编号报给管理员。
        ...(status >= 500 && rid ? { requestId: rid } : {}),
      },
    });
  }
}
