import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppError } from './errors';

/**
 * 统一错误响应。
 *
 * 关键点：
 *  - 4xx 只回传语义化消息，**绝不回传堆栈 / SQL / 内部 ID**；
 *  - 5xx 一律回传通用文案，细节只进服务端日志；
 *  - 前端据此区分「成功 / 失败」，因此失败永远不会被渲染成成功。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

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
        `${request.method} ${request.originalUrl} 未处理异常`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    if (status >= 500) {
      this.logger.error(`${request.method} ${request.originalUrl} → ${status} ${code}`);
    }

    response.status(status).json({
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
    });
  }
}
