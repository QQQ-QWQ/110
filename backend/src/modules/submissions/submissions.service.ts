import { Injectable } from '@nestjs/common';
import { Errors } from '../../core/errors';
import { PrismaService } from '../../core/prisma.service';
import { assertArtifacts, assertNote } from '../../domain/invariants';
import { CommandType, EVENT_TYPE, NEXT_STATE } from '../../domain/states';
import { conditionalUpdate, executeCommand } from '../../pipeline/command-pipeline';

@Injectable()
export class SubmissionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 提交成果。
   * 每次提交生成**独立**的 Vn 记录，V2 不覆盖 V1（追加式，历史是一等公民数据）。
   */
  async submit(
    userId: string,
    requirementId: string,
    dto: { artifacts: string[]; note: string },
    opts: { expectedRowVersion?: number; idempotencyKey?: string },
  ) {
    const requirement = await this.prisma.requirement.findUnique({
      where: { id: requirementId },
      select: { id: true },
    });
    if (!requirement) throw Errors.notFound();

    const note = assertNote(dto.note);
    const artifacts = assertArtifacts(dto.artifacts);

    const result = await executeCommand(this.prisma, {
      actorId: userId,
      command: CommandType.SUBMIT,
      requirementId,
      expectedRowVersion: opts.expectedRowVersion,
      idempotencyKey: opts.idempotencyKey,
      requestPayload: { artifacts, note },
      statusCode: 201,
      mutate: async (tx, ctx) => {
        const before = ctx.requirement!;

        // 条件更新同时锁定该行：并发提交时后到者会因 row_version 不匹配而被拒
        const newVersion = await conditionalUpdate(tx, requirementId, before.rowVersion, {
          state: NEXT_STATE.SUBMIT,
          updatedAt: new Date(),
        });

        const max = await tx.submission.aggregate({
          where: { requirementId },
          _max: { submissionNo: true },
        });
        const submissionNo = (max._max.submissionNo ?? 0) + 1;

        const submission = await tx.submission.create({
          data: {
            requirementId,
            submissionNo,
            note,
            submittedById: userId,
            artifacts: {
              create: artifacts.map((url, index) => ({ seq: index + 1, url })),
            },
          },
        });

        await tx.requirement.update({
          where: { id: requirementId },
          data: { currentSubmissionId: submission.id },
        });

        return {
          response: {
            id: submission.id,
            submissionNo,
            state: NEXT_STATE.SUBMIT,
            rowVersion: newVersion,
          },
          event: {
            requirementId,
            seq: newVersion,
            eventType: EVENT_TYPE.SUBMIT,
            payload: { submissionNo, artifacts, note },
          },
        };
      },
    });

    return result.body;
  }
}
