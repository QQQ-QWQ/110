import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

/**
 * 预置数据（考核要求的测试账号与需求）
 *
 * 幂等设计：所有实体使用**固定 UUID** 并 upsert，
 * 因此容器每次启动重复执行都不会产生重复数据，也不会覆盖已有业务进展。
 */

const prisma = new PrismaClient();

const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'Passw0rd!';

const U = {
  alice: '00000000-0000-4000-8000-000000000001',
  bob: '00000000-0000-4000-8000-000000000002',
  carol: '00000000-0000-4000-8000-000000000003',
};

const R = {
  pending: '10000000-0000-4000-8000-000000000001',
  inProgress: '10000000-0000-4000-8000-000000000002',
  inReview: '10000000-0000-4000-8000-000000000003',
};

const C = {
  pending1: '20000000-0000-4000-8000-000000000001',
  pending2: '20000000-0000-4000-8000-000000000002',
  pending3: '20000000-0000-4000-8000-000000000003',
  progress1: '20000000-0000-4000-8000-000000000011',
  progress2: '20000000-0000-4000-8000-000000000012',
  review1: '20000000-0000-4000-8000-000000000021',
  review2: '20000000-0000-4000-8000-000000000022',
};

const S = {
  reviewV1: '30000000-0000-4000-8000-000000000001',
};

const A = {
  reviewV1a: '40000000-0000-4000-8000-000000000001',
};

const E = {
  pendingCreated: '50000000-0000-4000-8000-000000000001',
  progressCreated: '50000000-0000-4000-8000-000000000002',
  progressStarted: '50000000-0000-4000-8000-000000000003',
  reviewCreated: '50000000-0000-4000-8000-000000000004',
  reviewStarted: '50000000-0000-4000-8000-000000000005',
  reviewSubmitted: '50000000-0000-4000-8000-000000000006',
};

async function seedUsers(): Promise<void> {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const users = [
    { id: U.alice, account: 'alice', name: '爱丽丝（提出者）' },
    { id: U.bob, account: 'bob', name: '鲍勃（负责人）' },
    { id: U.carol, account: 'carol', name: '卡罗尔（无关成员）' },
  ];

  for (const user of users) {
    await prisma.user.upsert({
      where: { id: user.id },
      update: { name: user.name },
      create: { ...user, passwordHash },
    });
  }
}

async function seedRequirements(): Promise<void> {
  // ── 需求 1：待处理（3 条验收条件）──
  await prisma.requirement.upsert({
    where: { id: R.pending },
    update: {},
    create: {
      id: R.pending,
      title: '导出需求列表为 CSV',
      description:
        '团队希望把当前需求列表按筛选条件导出成 CSV，便于在周会上做离线复盘。需要支持中文表头，且导出内容与页面筛选结果保持一致。',
      state: 'PENDING',
      proposerId: U.alice,
      assigneeId: U.bob,
      rowVersion: 1,
    },
  });

  const pendingCriteria = [
    { id: C.pending1, seq: 1, text: '列表页提供「导出 CSV」按钮，点击后浏览器下载 .csv 文件' },
    {
      id: C.pending2,
      seq: 2,
      text: '导出内容与当前筛选条件（状态 / 我提出 / 我负责 / 关键词）完全一致',
    },
    { id: C.pending3, seq: 3, text: 'CSV 表头为中文，且用 Excel 打开无乱码（含 BOM）' },
  ];
  for (const c of pendingCriteria) {
    await prisma.criterion.upsert({
      where: { id: c.id },
      update: { text: c.text },
      create: { id: c.id, requirementId: R.pending, seq: c.seq, text: c.text },
    });
  }

  await prisma.event.upsert({
    where: { id: E.pendingCreated },
    update: {},
    create: {
      id: E.pendingCreated,
      requirementId: R.pending,
      seq: 1,
      eventType: 'CREATED',
      actorId: U.alice,
      payloadJson: { title: '导出需求列表为 CSV', assigneeId: U.bob },
    },
  });

  // ── 需求 2：进行中 ──
  await prisma.requirement.upsert({
    where: { id: R.inProgress },
    update: {},
    create: {
      id: R.inProgress,
      title: '列表页支持按标题关键词搜索',
      description:
        '目前只能按状态筛选，需求变多后很难定位。希望增加标题关键词搜索，并与现有筛选条件叠加生效。',
      state: 'IN_PROGRESS',
      proposerId: U.alice,
      assigneeId: U.bob,
      rowVersion: 2,
    },
  });

  const progressCriteria = [
    { id: C.progress1, seq: 1, text: '列表页提供关键词输入框，输入后回车即可搜索' },
    {
      id: C.progress2,
      seq: 2,
      text: '关键词与状态、我提出 / 我负责筛选可以叠加，且筛选条件同步到 URL',
    },
  ];
  for (const c of progressCriteria) {
    await prisma.criterion.upsert({
      where: { id: c.id },
      update: { text: c.text },
      create: { id: c.id, requirementId: R.inProgress, seq: c.seq, text: c.text },
    });
  }

  await prisma.event.upsert({
    where: { id: E.progressCreated },
    update: {},
    create: {
      id: E.progressCreated,
      requirementId: R.inProgress,
      seq: 1,
      eventType: 'CREATED',
      actorId: U.alice,
      payloadJson: { title: '列表页支持按标题关键词搜索', assigneeId: U.bob },
    },
  });

  await prisma.event.upsert({
    where: { id: E.progressStarted },
    update: {},
    create: {
      id: E.progressStarted,
      requirementId: R.inProgress,
      seq: 2,
      eventType: 'STARTED',
      actorId: U.bob,
      payloadJson: { frozenCriteria: progressCriteria.map((c) => ({ seq: c.seq, text: c.text })) },
    },
  });

  // ── 需求 3：待验收（已提交 V1）──
  //
  // ⚠️ 循环外键，必须分三步写：
  //   requirement.current_submission_id → submission.id
  //   submission.requirement_id         → requirement.id
  //   两者互为外键，任何单条语句都无法同时满足。
  //
  //   ① 先建需求（currentSubmissionId 留空）
  //   ② 再建提交与链接（此时需求已存在）
  //   ③ 最后回填需求的当前提交指针
  //
  // 若把 currentSubmissionId 直接写在下面的 create 里（初版即如此），
  // 迁移 0002 加上的外键会以 P2003 直接拒绝写入，导致 seed 退出码为 1，
  // 进而被 docker-entrypoint.sh 的 `set -e` 放大为「容器起不来」。
  await prisma.requirement.upsert({
    where: { id: R.inReview },
    update: {},
    create: {
      id: R.inReview,
      title: '需求详情页展示完整操作历史',
      description:
        '验收时经常需要回溯「谁在什么时候做了什么」。希望在详情页按时间顺序展示创建、开始、提交、退回、通过等操作。',
      state: 'IN_REVIEW',
      proposerId: U.alice,
      assigneeId: U.bob,
      rowVersion: 3,
    },
  });

  const reviewCriteria = [
    { id: C.review1, seq: 1, text: '详情页按时间顺序展示全部操作，包含操作者姓名与时间' },
    { id: C.review2, seq: 2, text: '历史记录只增不改，已发生的记录不会因后续操作被覆盖' },
  ];
  for (const c of reviewCriteria) {
    await prisma.criterion.upsert({
      where: { id: c.id },
      update: { text: c.text },
      create: { id: c.id, requirementId: R.inReview, seq: c.seq, text: c.text },
    });
  }

  await prisma.submission.upsert({
    where: { id: S.reviewV1 },
    update: {},
    create: {
      id: S.reviewV1,
      requirementId: R.inReview,
      submissionNo: 1,
      note: '已实现历史时间线组件，数据来自追加式事件表；每条记录包含操作者与时间，且不做任何覆盖更新。',
      submittedById: U.bob,
    },
  });

  await prisma.submissionArtifact.upsert({
    where: { id: A.reviewV1a },
    update: {},
    create: {
      id: A.reviewV1a,
      submissionId: S.reviewV1,
      seq: 1,
      url: 'https://github.com/QQQ-QWQ/110',
    },
  });

  // ③ 回填当前提交指针（提交此时已存在，外键可满足）。
  // 幂等：重复执行只是把同一指针再写一次，不会覆盖已有业务进展。
  await prisma.requirement.update({
    where: { id: R.inReview },
    data: { currentSubmissionId: S.reviewV1 },
  });

  await prisma.event.upsert({
    where: { id: E.reviewCreated },
    update: {},
    create: {
      id: E.reviewCreated,
      requirementId: R.inReview,
      seq: 1,
      eventType: 'CREATED',
      actorId: U.alice,
      payloadJson: { title: '需求详情页展示完整操作历史', assigneeId: U.bob },
    },
  });

  await prisma.event.upsert({
    where: { id: E.reviewStarted },
    update: {},
    create: {
      id: E.reviewStarted,
      requirementId: R.inReview,
      seq: 2,
      eventType: 'STARTED',
      actorId: U.bob,
      payloadJson: { frozenCriteria: reviewCriteria.map((c) => ({ seq: c.seq, text: c.text })) },
    },
  });

  await prisma.event.upsert({
    where: { id: E.reviewSubmitted },
    update: {},
    create: {
      id: E.reviewSubmitted,
      requirementId: R.inReview,
      seq: 3,
      eventType: 'SUBMITTED',
      actorId: U.bob,
      payloadJson: {
        submissionNo: 1,
        artifacts: ['https://github.com/QQQ-QWQ/110'],
        note: '已实现历史时间线组件。',
      },
    },
  });
}

async function main(): Promise<void> {
  await seedUsers();
  await seedRequirements();
  // 本文件是命令行脚本，控制台输出即其正常产出（见 eslint.config.mjs 中对该文件的覆盖）
  console.log(
    `[seed] 完成：3 个测试账号（alice / bob / carol，密码 ${DEMO_PASSWORD}）、3 条需求（待处理 / 进行中 / 待验收）`,
  );
}

main()
  .catch((error) => {
    console.error('[seed] 失败：', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
