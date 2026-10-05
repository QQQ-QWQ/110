import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

/**
 * 请求编号（X-Request-Id）—— 报告 §5.2 S5
 *
 * 解决的问题：用户报「刚才点了一下就报错了」，服务端日志里却只能靠时间去猜
 * 是哪一条请求。有了贯穿的请求编号，一条日志就能定位到那一次请求。
 *
 * 采用**轻量版**：中间件 + 异常过滤器 + 访问日志。刻意**不**引入
 * AsyncLocalStorage / nestjs-cls 做全链路上下文 —— 那会改动所有 service 的
 * 签名（或在每个入口包一层），代价远大于收益；本项目没有跨多层异步的日志
 * 关联需求（异常过滤器已经能拿到 request/response）。
 *
 * 三条设计取舍：
 *  1. **透传但校验**。客户端（或上游网关）传来的 id 会被沿用，这样跨服务/跨层
 *     能串起来；但**只接受安全形态**（见 isSafeRequestId）—— 因为它会被写进
 *     日志行与响应头，不加限制就等于开放了日志注入（换行符伪造日志条目）
 *     与超长串撑爆日志两个口子。
 *  2. **响应头始终回传**，不只是 5xx。前端/运维在任何一次请求上都能拿到编号，
 *     排查时不必先复现错误。
 *  3. **5xx 的响应体里也带上编号**。4xx 不带：那是调用方自己的问题，回传编号
 *     没有意义且会扩大响应契约。5xx 带上，用户才能把编号报给管理员。
 */

export const REQUEST_ID_HEADER = 'x-request-id';

/** 上限 128：够 UUID/ULID/常见 trace id，又不至于让日志行失控。 */
export const REQUEST_ID_MAX_LENGTH = 128;

/**
 * 允许透传的字符集：可见 ASCII 里的「标识符安全」子集。
 * 刻意排除空白、换行、控制字符与非 ASCII —— 前两者是日志注入，
 * 后两者会让日志的 grep 与对齐变得不可靠。
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]+$/;

export function isSafeRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= REQUEST_ID_MAX_LENGTH &&
    SAFE_REQUEST_ID.test(value)
  );
}

/**
 * 决定本次请求用哪个编号：沿用合法的入参，否则新生成一个。
 *
 * `generate` 可注入，便于测试断言「非法入参确实走了生成分支」而不依赖随机性。
 */
export function resolveRequestId(raw: unknown, generate: () => string = randomUUID): string {
  // Express 对同名重复请求头会给出数组，取第一个即可（与主流网关行为一致）
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  return isSafeRequestId(candidate) ? candidate : generate();
}

/** 把编号挂到 res.locals，并回写到响应头。 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
  // 用 res.locals 而不是给 Express.Request 做类型扩展：少一处全局类型改动，
  // 且 locals 的生命周期正好与这一次请求一致（异常过滤器里可直接取到）。
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

const accessLogger = new Logger('HTTP');

/**
 * 访问日志：一行一次请求，含方法、路径、状态码、耗时与请求编号。
 *
 * 放在 res 的 'finish' 事件上，因此**失败响应也会被记录**（异常过滤器先写响应，
 * 事件随后触发）。5xx 用 error 级别，便于在日志里直接筛出来。
 *
 * 可用 `ACCESS_LOG=false` 关闭（例如压测时避免日志本身成为瓶颈）。
 */
export function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (process.env.ACCESS_LOG === 'false') {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const rid = res.locals.requestId as string | undefined;
    const line = `${req.method} ${req.originalUrl} → ${res.statusCode} ${ms.toFixed(1)}ms rid=${rid ?? '-'}`;
    if (res.statusCode >= 500) accessLogger.error(line);
    else accessLogger.log(line);
  });

  next();
}

/** 从响应上下文取编号，供异常过滤器使用。 */
export function requestIdOf(res: Response): string | undefined {
  const id = res.locals?.requestId;
  return typeof id === 'string' ? id : undefined;
}
