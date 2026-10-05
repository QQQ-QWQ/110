import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Errors } from '../../core/errors';
import { PrismaService } from '../../core/prisma.service';
import {
  LIMITS,
  assertAssigneeDiffers,
  assertCodePointLength,
  assertCriteria,
  assertNonBlank,
} from '../../domain/invariants';
import { assertCanRead, roleOf } from '../../domain/policy';
import {
  CommandType,
  EVENT_TYPE,
  NEXT_STATE,
  RequirementState,
  STATE_LABEL,
  nextActionsFor,
} from '../../domain/states';
import { conditionalUpdate, executeCommand } from '../../pipeline/command-pipeline';

export interface ListFilters {
  state?: string;
  scope?: 'all' | 'proposed' | 'assigned';
  keyword?: string;
}

@Injectable()
export class RequirementsService {
  constructor(private readonly prisma: PrismaService) {}

  // ────────────────────────────── 读 ──────────────────────────────

  /**
   * 列表：可见性在 **SQL 层**过滤。
   * 注意 AND 数组包裹 OR —— 若写成 `proposer = ? OR assignee = ? AND state = ?`，
   * 由于 AND 优先级高于 OR，状态筛选会完全失效。
   */
  async list(userId: string, filters: ListFilters) {
    const conditions: Prisma.RequirementWhereInput[] = [
      { OR: [{ proposerId: userId }, { assigneeId: userId }] },
    ];

    if (filters.state) {
      conditions.push({ state: filters.state });
    }
    if (filters.scope === 'proposed') {
      conditions.push({ proposerId: userId });
    }
    if (filters.scope === 'assigned') {
      conditions.push({ assigneeId: userId });
    }
    if (filters.keyword && filters.keyword.trim().length > 0) {
      conditions.push({ title: { contains: filters.keyword.trim(), mode: 'insensitive' } });
    }

    const rows = await this.prisma.requirement.findMany({
      where: { AND: conditions },
      orderBy: { createdAt: 'desc' },
      include: {
        proposer: { select: { id: true, name: true, account: true } },
        assignee: { select: { id: true, name: true, account: true } },
        criteria: { select: { id: true }, orderBy: { seq: 'asc' } },
        submissions: {
          select: { id: true, submissionNo: true },
          orderBy: { submissionNo: 'desc' },
          take: 1,
        },
      },
    });

    return rows.map((row) => {
      const role = roleOf(userId, row);
      const state = row.state as RequirementState;
      return {
        id: row.id,
        title: row.title,
        state: row.state,
        stateLabel: STATE_LABEL[state],
        rowVersion: row.rowVersion,
        proposer: row.proposer,
        assignee: row.assignee,
        criteriaCount: row.criteria.length,
        latestSubmissionNo: row.submissions[0]?.submissionNo ?? null,
        myRole: role,
        nextActions: nextActionsFor(state, role),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  /** 详情：含验收条件、当前提交、历次提交与反馈、完整事件时间线、下一步操作 */
  async detail(userId: string, id: string) {
    const row = await this.prisma.requirement.findUnique({
      where: { id },
      include: {
        proposer: { select: { id: true, name: true, account: true } },
        assignee: { select: { id: true, name: true, account: true } },
        criteria: { orderBy: { seq: 'asc' } },
        submissions: {
          orderBy: { submissionNo: 'asc' },
          include: {
            submittedBy: { select: { id: true, name: true, account: true } },
            artifacts: { orderBy: { seq: 'asc' } },
            reviews: {
              orderBy: { reviewedAt: 'asc' },
              include: {
                reviewer: { select: { id: true, name: true, account: true } },
                checks: true,
              },
            },
          },
        },
        events: {
          orderBy: { seq: 'asc' },
          include: { actor: { select: { id: true, name: true, account: true } } },
        },
      },
    });

    if (!row) throw Errors.notFound();

    // 无关账号 → 404（不是 403），避免枚举出「这条需求存在」
    const role = assertCanRead(userId, row);
    const state = row.state as RequirementState;

    const currentSubmission = row.submissions.find((s) => s.id === row.currentSubmissionId) ?? null;

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      state: row.state,
      stateLabel: STATE_LABEL[state],
      rowVersion: row.rowVersion,
      proposer: row.proposer,
      assignee: row.assignee,
      criteria: row.criteria.map((c) => ({ id: c.id, seq: c.seq, text: c.text })),
      currentSubmissionId: row.currentSubmissionId,
      currentSubmission: currentSubmission ? this.mapSubmission(currentSubmission) : null,
      submissions: row.submissions.map((s) => this.mapSubmission(s)),
      events: row.events.map((e) => ({
        seq: e.seq,
        eventType: e.eventType,
        actor: e.actor,
        payload: e.payloadJson,
        createdAt: e.createdAt,
      })),
      myRole: role,
      nextActions: nextActionsFor(state, role),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** 历史（单独端点，语义更清晰） */
  async history(userId: string, id: string) {
    const detail = await this.detail(userId, id);
    return {
      requirementId: detail.id,
      state: detail.state,
      submissions: detail.submissions,
      events: detail.events,
    };
  }

  // ────────────────────────────── 写 ──────────────────────────────

  async create(
    userId: string,
    dto: { title: string; description: string; assigneeId: string; criteria: string[] },
    opts: { idempotencyKey?: string },
  ) {
    const title = (dto.title ?? '').trim();
    const description = (dto.description ?? '').trim();
    assertNonBlank(title, '标题');
    assertNonBlank(description, '问题与内容说明');
    assertCodePointLength(title, LIMITS.TITLE_MAX, '标题');
    assertCodePointLength(description, LIMITS.DESCRIPTION_MAX, '问题与内容说明');
    assertAssigneeDiffers(userId, dto.assigneeId);
    const criteria = assertCriteria(dto.criteria);

    const assignee = await this.prisma.user.findUnique({ where: { id: dto.assigneeId } });
    if (!assignee) throw Errors.validation('指定的负责人不存在');

    const result = await executeCommand(this.prisma, {
      actorId: userId,
      command: CommandType.CREATE,
      idempotencyKey: opts.idempotencyKey,
      requestPayload: { title, description, assigneeId: dto.assigneeId, criteria },
      statusCode: 201,
      mutate: async (tx) => {
        const created = await tx.requirement.create({
          data: {
            title,
            description,
            state: RequirementState.PENDING,
            proposerId: userId,
            assigneeId: dto.assigneeId,
            rowVersion: 1,
            criteria: {
              create: criteria.map((text, index) => ({ seq: index + 1, text })),
            },
          },
        });

        return {
          response: { id: created.id, state: created.state, rowVersion: created.rowVersion },
          event: {
            requirementId: created.id,
            seq: 1,
            eventType: EVENT_TYPE.CREATE,
            payload: { title, assigneeId: dto.assigneeId, criteria },
          },
        };
      },
    });

    return result.body;
  }

  /** 编辑：仅提出者、仅待处理阶段（开始处理后验收标准冻结） */
  async edit(
    userId: string,
    id: string,
    dto: { title?: string; description?: string; criteria?: string[] },
    opts: { expectedRowVersion?: number; idempotencyKey?: string },
  ) {
    const current = await this.prisma.requirement.findUnique({
      where: { id },
      include: { criteria: { orderBy: { seq: 'asc' } } },
    });
    if (!current) throw Errors.notFound();

    const nextTitle = dto.title === undefined ? current.title : dto.title.trim();
    const nextDescription =
      dto.description === undefined ? current.description : dto.description.trim();
    assertNonBlank(nextTitle, '标题');
    assertNonBlank(nextDescription, '问题与内容说明');
    assertCodePointLength(nextTitle, LIMITS.TITLE_MAX, '标题');
    assertCodePointLength(nextDescription, LIMITS.DESCRIPTION_MAX, '问题与内容说明');

    const nextCriteria =
      dto.criteria === undefined
        ? current.criteria.map((c) => c.text)
        : assertCriteria(dto.criteria);

    const result = await executeCommand(this.prisma, {
      actorId: userId,
      command: CommandType.EDIT,
      requirementId: id,
      expectedRowVersion: opts.expectedRowVersion,
      idempotencyKey: opts.idempotencyKey,
      requestPayload: { title: nextTitle, description: nextDescription, criteria: nextCriteria },
      mutate: async (tx, ctx) => {
        const before = ctx.requirement!;
        const newVersion = await conditionalUpdate(tx, id, before.rowVersion, {
          title: nextTitle,
          description: nextDescription,
          updatedAt: new Date(),
        });

        if (dto.criteria !== undefined) {
          await tx.criterion.deleteMany({ where: { requirementId: id } });
          await tx.criterion.createMany({
            data: nextCriteria.map((text, index) => ({
              requirementId: id,
              seq: index + 1,
              text,
            })),
          });
        }

        return {
          response: { id, state: before.state, rowVersion: newVersion },
          event: {
            requirementId: id,
            seq: newVersion,
            eventType: EVENT_TYPE.EDIT,
            payload: {
              before: {
                title: before.title,
                description: before.description,
                criteria: current.criteria.map((c) => c.text),
              },
              after: { title: nextTitle, description: nextDescription, criteria: nextCriteria },
            },
          },
        };
      },
    });

    return result.body;
  }

  /** 开始处理：仅负责人、仅待处理；成功后正文与验收条件冻结 */
  async start(
    userId: string,
    id: string,
    opts: { expectedRowVersion?: number; idempotencyKey?: string },
  ) {
    const current = await this.prisma.requirement.findUnique({
      where: { id },
      include: { criteria: { orderBy: { seq: 'asc' } } },
    });
    if (!current) throw Errors.notFound();

    const result = await executeCommand(this.prisma, {
      actorId: userId,
      command: CommandType.START,
      requirementId: id,
      expectedRowVersion: opts.expectedRowVersion,
      idempotencyKey: opts.idempotencyKey,
      requestPayload: { action: 'START' },
      mutate: async (tx, ctx) => {
        const before = ctx.requirement!;
        const newVersion = await conditionalUpdate(tx, id, before.rowVersion, {
          state: NEXT_STATE.START,
          updatedAt: new Date(),
        });

        return {
          response: { id, state: NEXT_STATE.START, rowVersion: newVersion },
          event: {
            requirementId: id,
            seq: newVersion,
            eventType: EVENT_TYPE.START,
            payload: {
              // 冻结快照：此后双方使用同一套标准
              frozenCriteria: current.criteria.map((c) => ({ seq: c.seq, text: c.text })),
            },
          },
        };
      },
    });

    return result.body;
  }

  // ────────────────────────────── 内部 ──────────────────────────────

  private mapSubmission(submission: {
    id: string;
    submissionNo: number;
    note: string;
    submittedAt: Date;
    submittedBy: { id: string; name: string; account: string };
    artifacts: { seq: number; url: string }[];
    reviews: {
      action: string;
      reason: string | null;
      reviewedAt: Date;
      reviewer: { id: string; name: string; account: string };
      checks: { criterionId: string; passed: boolean }[];
    }[];
  }) {
    return {
      id: submission.id,
      submissionNo: submission.submissionNo,
      note: submission.note,
      submittedAt: submission.submittedAt,
      submittedBy: submission.submittedBy,
      artifacts: submission.artifacts.map((a) => ({ seq: a.seq, url: a.url })),
      reviews: submission.reviews.map((r) => ({
        action: r.action,
        reason: r.reason,
        reviewedAt: r.reviewedAt,
        reviewer: r.reviewer,
        checks: r.checks.map((c) => ({ criterionId: c.criterionId, passed: c.passed })),
      })),
    };
  }
}
