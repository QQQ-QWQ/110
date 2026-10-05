import { Prisma, Requirement } from '@prisma/client';
import { requestHashOf } from '../core/canonical-json';
import { Errors } from '../core/errors';
import { PrismaService } from '../core/prisma.service';
import { assertRoleCanPerform, assertStateCanPerform } from '../domain/policy';
import { CommandType, MutatingCommand, RequirementState } from '../domain/states';

/**
 * 统一写命令管道
 *
 * 所有写操作共用同一条管道，按命令性质选择性启用阶段。
 *
 *   ① Authentication       当前主体（绝不信请求体传入的 actor_id）
 *   ② Resource lookup      加载目标需求                        ← CREATE 跳过
 *   ③ Authorization        资源级角色判定                      ← CREATE 仅校验创建权
 *   ④ Parse key/hash       解析 operation / Idempotency-Key / request_hash
 *   ────────────── 以下 ⑤–⑪ 全部在同一数据库事务内 ──────────────
 *   ⑤ Reserve idempotency  占坑（与业务同事务，杜绝崩溃窗口）
 *   ⑥ State guard          当前状态是否允许该动作              ← CREATE 跳过
 *   ⑦ Version guard        row_version 是否匹配（乐观锁）      ← CREATE 跳过
 *   ⑧ Business mutation    业务写入 + 状态迁移 + row_version+1
 *   ⑨ Append EVENT         seq = 新的 row_version
 *   ⑩ Finalize idempotency status=COMPLETED + 落响应
 *   ⑪ Commit
 *   ────────────── 事务边界结束 ──────────────
 *   ⑫ Response
 */

export interface MutateContext {
  /** 事务内加载的最新需求（CREATE 为 null） */
  requirement: Requirement | null;
}

export interface MutateResult<TResponse> {
  response: TResponse;
  event: {
    requirementId: string;
    seq: number;
    eventType: string;
    payload: Record<string, unknown>;
  };
}

export interface ExecuteCommandOptions<TResponse> {
  actorId: string;
  command: CommandType;
  requirementId?: string;
  /** 客户端持有的版本号（If-Match 语义） */
  expectedRowVersion?: number;
  idempotencyKey?: string;
  requestPayload: unknown;
  statusCode?: number;
  mutate: (tx: Prisma.TransactionClient, ctx: MutateContext) => Promise<MutateResult<TResponse>>;
}

export interface ExecuteCommandResult<TResponse> {
  status: number;
  body: TResponse;
  /** true 表示命中了幂等记录，直接回放原响应，未重复执行业务 */
  replayed: boolean;
}

export async function executeCommand<TResponse>(
  prisma: PrismaService,
  opts: ExecuteCommandOptions<TResponse>,
): Promise<ExecuteCommandResult<TResponse>> {
  const { actorId, command, requirementId, expectedRowVersion, idempotencyKey, requestPayload } =
    opts;
  const successStatus = opts.statusCode ?? 200;

  // ── ①′ 乐观锁强制前置（代码审查 R-01）──
  // 非创建命令**必须**携带 If-Match 版本号。
  // 若允许缺省，客户端只要不传该头即可跳过版本校验，
  // 使「状态已变化后旧页面操作必须失败」这一领域语义形同虚设。
  if (command !== CommandType.CREATE && expectedRowVersion === undefined) {
    throw Errors.preconditionRequired();
  }

  // ── ② Resource lookup + ③ Authorization（事务外预检，快速失败）──
  if (command !== CommandType.CREATE) {
    if (!requirementId) throw Errors.notFound();
    const pre = await prisma.requirement.findUnique({ where: { id: requirementId } });
    if (!pre) throw Errors.notFound();
    // 顺序即语义：可见性 404 → 角色 403 → 版本 412 → 状态 409。
    // 版本必须排在状态之前 —— `If-Match` 是请求前置条件，RFC 9110 要求它先于
    // 方法处理求值；且客户端手里是旧状态，回 409「状态不允许」对它没有指导意义，
    // 回 412 才能让它知道「应当刷新后重试」。
    assertRoleCanPerform(actorId, pre, command as MutatingCommand);
    if (pre.rowVersion !== expectedRowVersion) {
      throw Errors.stale();
    }
    assertStateCanPerform(pre.state as RequirementState, command as MutatingCommand);
  }

  // ── ④ Parse key / hash ──
  const hash = requestHashOf(command, requirementId ?? null, requestPayload);
  const key = idempotencyKey && idempotencyKey.trim().length > 0 ? idempotencyKey.trim() : null;

  // ── ⑤–⑪ 同一事务 ──
  return prisma.$transaction(async (tx) => {
    // ⑤ 占坑：与业务写入处于同一事务，因此不存在「业务已提交但幂等未记录」的崩溃窗口
    if (key) {
      const reserved = await tx.idempotencyRecord.createMany({
        data: [
          {
            userId: actorId,
            operation: command,
            idempotencyKey: key,
            requestHash: hash,
            status: 'PROCESSING',
          },
        ],
        skipDuplicates: true,
      });

      if (reserved.count === 0) {
        const existing = await tx.idempotencyRecord.findUnique({
          where: {
            userId_operation_idempotencyKey: {
              userId: actorId,
              operation: command,
              idempotencyKey: key,
            },
          },
        });
        if (!existing) {
          throw Errors.stateConflict('相同请求正在处理中，请稍后重试');
        }
        // 同键不同内容 → 拒绝（防止前端复用 key 提交了不同数据）
        if (existing.requestHash !== hash) {
          throw Errors.idempotencyConflict();
        }
        if (existing.status === 'COMPLETED') {
          return {
            status: existing.responseStatus ?? successStatus,
            body: existing.responseBody as TResponse,
            replayed: true,
          };
        }
        throw Errors.stateConflict('相同请求正在处理中，请稍后重试');
      }
    }

    // ⑥⑦ 事务内重新加载并再次守卫（并发下以事务内读到的为准）
    //     顺序与事务外预检保持一致：角色 403 → 版本 412 → 状态 409
    let current: Requirement | null = null;
    if (command !== CommandType.CREATE) {
      current = await tx.requirement.findUnique({ where: { id: requirementId! } });
      if (!current) throw Errors.notFound();
      assertRoleCanPerform(actorId, current, command as MutatingCommand);
      // 版本号必填已在上方 ①′ 强制，此处直接比较
      if (current.rowVersion !== expectedRowVersion) {
        throw Errors.stale();
      }
      assertStateCanPerform(current.state as RequirementState, command as MutatingCommand);
    }

    // ⑧ 业务写入（内部必须使用条件更新以保证乐观锁真正生效）
    const { response, event } = await opts.mutate(tx, { requirement: current });

    // ⑨ 追加事件：一次成功的领域命令恰好产生一个 EVENT，seq = 新的 row_version
    await tx.event.create({
      data: {
        requirementId: event.requirementId,
        seq: event.seq,
        eventType: event.eventType,
        actorId,
        payloadJson: event.payload as Prisma.InputJsonValue,
      },
    });

    // ⑩ 落幂等响应（仅保存最小可重放响应）
    if (key) {
      await tx.idempotencyRecord.update({
        where: {
          userId_operation_idempotencyKey: {
            userId: actorId,
            operation: command,
            idempotencyKey: key,
          },
        },
        data: {
          status: 'COMPLETED',
          responseStatus: successStatus,
          responseBody: response as Prisma.InputJsonValue,
        },
      });
    }

    return { status: successStatus, body: response, replayed: false };
  });
}

/**
 * 乐观锁条件更新。
 * 必须使用 updateMany + rowVersion 条件，并校验 count === 1；
 * 「先查询再更新」在并发下会产生竞态。
 */
export async function conditionalUpdate(
  tx: Prisma.TransactionClient,
  requirementId: string,
  expectedRowVersion: number,
  data: Prisma.RequirementUpdateManyMutationInput,
): Promise<number> {
  const result = await tx.requirement.updateMany({
    where: { id: requirementId, rowVersion: expectedRowVersion },
    data: { ...data, rowVersion: { increment: 1 } },
  });
  if (result.count !== 1) {
    throw Errors.stale();
  }
  return expectedRowVersion + 1;
}
