import { Injectable } from '@nestjs/common';
import { Errors } from '../../core/errors';
import { PrismaService } from '../../core/prisma.service';
import { assertAllChecksPassed, assertReturnReason } from '../../domain/invariants';
import { CommandType, EVENT_TYPE, NEXT_STATE } from '../../domain/states';
import { conditionalUpdate, executeCommand } from '../../pipeline/command-pipeline';

export interface ReviewCheckInput {
  criterionId: string;
  passed: boolean;
}

export interface ReviewInput {
  action: 'RETURN' | 'COMPLETE';
  reason?: string;
  checks: ReviewCheckInput[];
}

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 逐项验收。
   * 关键约束：
   *  - 只有提出者能验收（由 POLICY 强制，负责人调用会被 403 拒绝）
   *  - 存在未通过项时不能确认完成
   *  - 退回必须填写具体修改原因
   *  - 只能针对「当前提交」验收，旧提交不可再验收
   *  - 必须对全部验收条件逐项记录结果（恰好一次）
   */
  async review(
    userId: string,
    submissionId: string,
    dto: ReviewInput,
    opts: { expectedRowVersion?: number; idempotencyKey?: string },
  ) {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      include: {
        requirement: { include: { criteria: { orderBy: { seq: 'asc' } } } },
      },
    });
    if (!submission) throw Errors.notFound();

    const requirement = submission.requirement;

    // 旧提交不可再验收
    if (requirement.currentSubmissionId !== submission.id) {
      throw Errors.stateConflict('该提交已不是当前提交，请刷新后针对最新提交验收');
    }

    // ── 验收结果必须恰好覆盖全部验收条件 ──
    const criterionIds = requirement.criteria.map((c) => c.id);
    const provided = dto.checks ?? [];
    const providedIds = provided.map((c) => c.criterionId);

    if (new Set(providedIds).size !== providedIds.length) {
      throw Errors.validation('验收结果中存在重复的验收条件');
    }
    const missing = criterionIds.filter((id) => !providedIds.includes(id));
    if (missing.length > 0) {
      throw Errors.validation('请对全部验收条件逐项记录结果');
    }
    const foreign = providedIds.filter((id) => !criterionIds.includes(id));
    if (foreign.length > 0) {
      throw Errors.validation('验收结果包含不属于本需求的验收条件');
    }

    // ── 动作相关约束 ──
    let reason: string | null = null;
    if (dto.action === 'RETURN') {
      reason = assertReturnReason(dto.reason);
    } else if (dto.action === 'COMPLETE') {
      const ordered = criterionIds.map(
        (id) => provided.find((p) => p.criterionId === id)!.passed,
      );
      assertAllChecksPassed(ordered);
    } else {
      throw Errors.validation('验收动作不合法');
    }

    const isReturn = dto.action === 'RETURN';
    const command = isReturn ? CommandType.REVIEW_RETURN : CommandType.REVIEW_COMPLETE;
    const nextState = NEXT_STATE[isReturn ? 'REVIEW_RETURN' : 'REVIEW_COMPLETE'];

    const result = await executeCommand(this.prisma, {
      actorId: userId,
      command,
      requirementId: requirement.id,
      expectedRowVersion: opts.expectedRowVersion,
      idempotencyKey: opts.idempotencyKey,
      requestPayload: { submissionId, action: dto.action, reason, checks: provided },
      mutate: async (tx, ctx) => {
        const before = ctx.requirement!;

        const newVersion = await conditionalUpdate(tx, requirement.id, before.rowVersion, {
          state: nextState,
          updatedAt: new Date(),
        });

        const review = await tx.review.create({
          data: {
            submissionId,
            action: dto.action,
            reason,
            reviewerId: userId,
            checks: {
              create: provided.map((c) => ({
                criterionId: c.criterionId,
                passed: c.passed,
              })),
            },
          },
        });

        return {
          response: {
            id: review.id,
            action: dto.action,
            state: nextState,
            rowVersion: newVersion,
          },
          event: {
            requirementId: requirement.id,
            seq: newVersion,
            eventType: EVENT_TYPE[command],
            payload: {
              submissionNo: submission.submissionNo,
              action: dto.action,
              reason,
              checks: provided,
            },
          },
        };
      },
    });

    return result.body;
  }
}
