import { Prisma, Requirement } from '@prisma/client';
import { requestHashOf } from '../core/canonical-json';
import { Errors } from '../core/errors';
import { PrismaService } from '../core/prisma.service';
import { assertCanPerform } from '../domain/policy';
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
  const { actorId, command, requirementId, expectedRowVersion, idempotencyKey, requestPayload } = opts;
  const successStatus = opts.statusCode ?? 200;

  // ── ② Resource lookup + ③ Authorization（事务外预检，快速失败）──
  if (command !== CommandType.CREATE) {
    if (!requirementId) throw Errors.notFound();
    const pre = await prisma.requirement.findUnique({ where: { id: requirementId } });
    if (!pre) throw Errors.notFound();
    assertCanPerform(actorId, pre, pre.state as RequirementState, command as MutatingCommand);
    if (expectedRowVersion !== undefined && pre.rowVersion !== expectedRowVersion) {
      throw Errors.stale();
    }
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
    let current: Requirement | null = null;
    if (command !== CommandType.CREATE) {
      current = await tx.requirement.findUnique({ where: { id: requirementId! } });
      if (!current) throw Errors.notFound();
      assertCanPerform(actorId, current, current.state as RequirementState, command as MutatingCommand);
      if (expectedRowVersion !== undefined && current.rowVersion !== expectedRowVersion) {
        throw Errors.stale();
      }
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
