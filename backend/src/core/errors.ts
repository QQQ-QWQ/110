/**
 * 统一错误模型
 *
 * 设计要点（对应验收项「错误不能被显示成成功」「不泄露内部细节」）：
 * - 每个错误都有稳定的 code，前端据此区分展示；
 * - 4xx 只回传语义化消息，绝不回传堆栈 / SQL / 他人 ID；
 * - 读他人资源 → 404（防枚举）；对自己可见资源的非法动作 → 403。
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  /** 未登录 / 会话失效 */
  unauthorized: (msg = '请先登录') => new AppError('UNAUTHORIZED', msg, 401),

  /** 对自己可见的资源执行了非法动作 */
  forbidden: (msg = '无权限执行该操作') => new AppError('FORBIDDEN', msg, 403),

  /** 资源不存在，或对当前用户不可见（防枚举，统一返回 404） */
  notFound: (msg = '资源不存在') => new AppError('NOT_FOUND', msg, 404),

  /** 状态冲突：当前状态不允许该动作（例如已完成需求不可再推进） */
  stateConflict: (msg = '当前状态不允许该操作') => new AppError('STATE_CONFLICT', msg, 409),

  /** 幂等键被复用但内容不同 */
  idempotencyConflict: (msg = '同一请求标识被用于不同内容，已拒绝') =>
    new AppError('IDEMPOTENCY_KEY_REUSED', msg, 409),

  /** 乐观锁：客户端持有的版本号已过期 */
  stale: (msg = '数据已被他人更新，请刷新后重试') => new AppError('PRECONDITION_FAILED', msg, 412),

  /**
   * 缺少前置条件：非创建类写命令必须携带 `If-Match: <rowVersion>`。
   *
   * 为什么不许缺省：若允许缺省，客户端只要不传该头就能跳过版本校验，
   * 使「状态已变化后旧页面操作必须失败」这一领域语义失效（详见代码审查 R-01）。
   */
  preconditionRequired: (msg = '缺少 If-Match 版本号，无法校验数据是否已被更新') =>
    new AppError('PRECONDITION_REQUIRED', msg, 428),

  /** 业务规则不满足（必填缺失、条件未全通过等） */
  validation: (msg: string, details?: unknown) =>
    new AppError('VALIDATION_FAILED', msg, 422, details),

  /**
   * 服务暂时过载：并发闸门已满（报告 §5.1 E4）。
   *
   * 用 503 而不是 429：这是**服务端容量**信号（某个昂贵操作的在途数已达上限），
   * 不是针对某个调用方的配额。429 留给按账号/IP 的限流（S7）。
   * 语义上它是「稍后重试能成功」，因此响应带 `Retry-After`。
   */
  overloaded: (msg = '服务繁忙，请稍后重试') => new AppError('SERVICE_BUSY', msg, 503),
};
