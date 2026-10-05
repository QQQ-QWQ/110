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
  DETAIL_SUBMISSION_LIMIT,
  DEFAULT_SEQ_PAGE_SIZE,
  MAX_SEQ_PAGE_SIZE,
  buildPageInfo,
  buildSeqPageInfo,
  decodeCursor,
  decodeSeqCursor,
  normalizeLimit,
} from '../../domain/pagination';
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

/** 分页参数，取自查询串（因此是未解析的字符串） */
export interface ListPage {
  limit?: string;
  cursor?: string;
}

/** 详情页的分页参数：只对事件时间线开放（submissions 用固定上界，见 pagination.ts） */
export interface DetailPage {
  eventsLimit?: string;
}

/** 历史端点的分页参数：按事件的 `seq` 游标续取 */
export interface HistoryPage {
  limit?: string;
  cursor?: string;
}

/**
 * 提交的完整关联。详情与历史共用同一份定义 —— 两处各写一份迟早会漂移，
 * 而漂移的表现是「某个端点少返回一个字段」，前端只在特定页面才炸。
 */
const SUBMISSION_INCLUDE = {
  submittedBy: { select: { id: true, name: true, account: true } },
  artifacts: { orderBy: { seq: 'asc' } },
  reviews: {
    orderBy: { reviewedAt: 'asc' },
    include: {
      reviewer: { select: { id: true, name: true, account: true } },
      checks: true,
    },
  },
} satisfies Prisma.SubmissionInclude;

@Injectable()
export class RequirementsService {
  constructor(private readonly prisma: PrismaService) {}

  // ────────────────────────────── 读 ──────────────────────────────

  /**
   * 列表：可见性在 **SQL 层**过滤，并做**键集游标分页**。
   *
   * 注意 AND 数组包裹 OR —— 若写成 `proposer = ? OR assignee = ? AND state = ?`，
   * 由于 AND 优先级高于 OR，状态筛选会完全失效。
   *
   * 分页动机：这是唯一会随数据量**线性恶化**的读路径。此前 `findMany` 无
   * `take`/`skip`，返回当前用户可见的全部需求，响应体与查询耗时都没有上界。
   */
  async list(userId: string, filters: ListFilters, page: ListPage = {}) {
    const limit = normalizeLimit(page.limit);
    const cursor =
      page.cursor === undefined || page.cursor === '' ? null : decodeCursor(String(page.cursor));

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

    // 键集分页：以 (createdAt, id) 复合游标做「严格小于」比较。
    // 之所以不用 Prisma 的 cursor/skip 语法：那要求游标指向的行**仍然存在**，
    // 而它完全可能刚被删除；显式比较不依赖这一点。
    if (cursor) {
      conditions.push({
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      });
    }

    const rows = await this.prisma.requirement.findMany({
      where: { AND: conditions },
      // 决胜键 id 必须与 createdAt 一起参与排序：只按 createdAt 排时，
      // 同一毫秒创建的多行顺序不稳定，翻页会出现重复或遗漏。
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // 多取一行用于判断「是否还有下一页」，避免额外一次 count 查询
      take: limit + 1,
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

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: pageRows.map((row) => {
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
      }),
      pageInfo: buildPageInfo(limit, hasMore, pageRows[pageRows.length - 1]),
    };
  }

  /**
   * 详情：含验收条件、当前提交、历次提交与反馈、**最近若干条**事件时间线、下一步操作。
   *
   * 为什么要给这两个数组加上界（报告 §5.1 E2）：
   *  · `events` 每次状态变更都会追加一条，是**真正会无界增长**的那个；
   *  · `submissions` 的数量等于重提次数，由人的行为决定，实际上界很低 ——
   *    但仍给一个固定上界，因为「不设上界的数组」迟早会变成事故。
   * 两者都**倒序取 N+1 再翻回升序**：多取的那条只用来判断「还有更早的」，
   * 不返回给客户端（与列表分页的 `take: limit + 1` 是同一手法）。
   *
   * 完整时间线请走 `/history`（支持 `seq` 游标续取）。
   */
  async detail(userId: string, id: string, page: DetailPage = {}) {
    const eventsLimit = normalizeLimit(page.eventsLimit, DEFAULT_SEQ_PAGE_SIZE, MAX_SEQ_PAGE_SIZE);

    // 两个 count 与主查询并发发出：详情是首屏路径，不该串行等三次往返
    const [row, eventsTotal, submissionsTotal] = await Promise.all([
      this.prisma.requirement.findUnique({
        where: { id },
        include: {
          proposer: { select: { id: true, name: true, account: true } },
          assignee: { select: { id: true, name: true, account: true } },
          criteria: { orderBy: { seq: 'asc' } },
          submissions: {
            orderBy: { submissionNo: 'desc' },
            take: DETAIL_SUBMISSION_LIMIT + 1,
            include: SUBMISSION_INCLUDE,
          },
          events: {
            orderBy: { seq: 'desc' },
            take: eventsLimit + 1,
            include: { actor: { select: { id: true, name: true, account: true } } },
          },
        },
      }),
      this.prisma.event.count({ where: { requirementId: id } }),
      this.prisma.submission.count({ where: { requirementId: id } }),
    ]);

    if (!row) throw Errors.notFound();

    // 无关账号 → 404（不是 403），避免枚举出「这条需求存在」
    const role = assertCanRead(userId, row);
    const state = row.state as RequirementState;

    // 倒序取回的窗口翻回升序：时间线必须按发生顺序阅读
    const submissionsHasMore = row.submissions.length > DETAIL_SUBMISSION_LIMIT;
    const submissions = (
      submissionsHasMore ? row.submissions.slice(0, DETAIL_SUBMISSION_LIMIT) : row.submissions
    ).reverse();

    const eventsHasMore = row.events.length > eventsLimit;
    const events = (eventsHasMore ? row.events.slice(0, eventsLimit) : row.events).reverse();

    // `currentSubmissionId` 只会指向最新一次提交，因此必然落在上面那个窗口内。
    // 万一不变量被破坏，这里补一次查询 —— 让行为退化成「正确」，而不是静默
    // 返回 null 让前端整块内容消失。
    let currentSubmission = submissions.find((s) => s.id === row.currentSubmissionId) ?? null;
    if (!currentSubmission && row.currentSubmissionId) {
      currentSubmission = await this.prisma.submission.findUnique({
        where: { id: row.currentSubmissionId },
        include: SUBMISSION_INCLUDE,
      });
    }

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
      submissions: submissions.map((s) => this.mapSubmission(s)),
      submissionsTotal,
      submissionsHasMore,
      events: events.map((e) => ({
        seq: e.seq,
        eventType: e.eventType,
        actor: e.actor,
        payload: e.payloadJson,
        createdAt: e.createdAt,
      })),
      eventsTotal,
      eventsHasMore,
      eventsLimit,
      myRole: role,
      nextActions: nextActionsFor(state, role),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * 历史（单独端点）：**完整**时间线，按 `seq` 游标分页。
   *
   * 与详情页的分工：详情页只给「最近 N 条」用于首屏，历史端点负责完整回溯 ——
   * 这样详情响应有上界，而完整数据仍然拿得到。
   *
   * 游标用 `seq`（需求内单调递增）而不是 `(createdAt, id)`：单调整数天然有序，
   * 不存在「同一毫秒」的稳定性问题，比较条件也只有一个字段。
   * 顺序为**升序 + 前向游标**：时间线按发生顺序阅读，`nextCursor` 指向本页最后
   * 一条的 seq，下一页取 `seq > cursor`。
   */
  async history(userId: string, id: string, page: HistoryPage = {}) {
    const limit = normalizeLimit(page.limit, DEFAULT_SEQ_PAGE_SIZE, MAX_SEQ_PAGE_SIZE);
    const after =
      page.cursor === undefined || page.cursor === '' ? null : decodeSeqCursor(String(page.cursor));

    const row = await this.prisma.requirement.findUnique({
      where: { id },
      include: {
        submissions: {
          orderBy: { submissionNo: 'desc' },
          take: DETAIL_SUBMISSION_LIMIT + 1,
          include: SUBMISSION_INCLUDE,
        },
        events: {
          where: after === null ? undefined : { seq: { gt: after } },
          orderBy: { seq: 'asc' },
          take: limit + 1,
          include: { actor: { select: { id: true, name: true, account: true } } },
        },
      },
    });

    if (!row) throw Errors.notFound();

    // 可见性判定与详情完全一致：无关账号 → 404（不是 403）
    assertCanRead(userId, row);

    const eventsHasMore = row.events.length > limit;
    const events = eventsHasMore ? row.events.slice(0, limit) : row.events;

    const submissionsHasMore = row.submissions.length > DETAIL_SUBMISSION_LIMIT;
    const submissions = (
      submissionsHasMore ? row.submissions.slice(0, DETAIL_SUBMISSION_LIMIT) : row.submissions
    ).reverse();

    return {
      requirementId: row.id,
      state: row.state,
      submissions: submissions.map((s) => this.mapSubmission(s)),
      submissionsHasMore,
      events: events.map((e) => ({
        seq: e.seq,
        eventType: e.eventType,
        actor: e.actor,
        payload: e.payloadJson,
        createdAt: e.createdAt,
      })),
      pageInfo: buildSeqPageInfo(limit, eventsHasMore, events[events.length - 1]?.seq),
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
