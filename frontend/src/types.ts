/** 与后端返回结构一一对应的类型定义（唯一真相源在 backend/src/domain） */

export type RequirementState = 'PENDING' | 'IN_PROGRESS' | 'IN_REVIEW' | 'COMPLETED';

export type CommandType =
  'CREATE' | 'EDIT' | 'START' | 'SUBMIT' | 'REVIEW_RETURN' | 'REVIEW_COMPLETE';

export type Role = 'PROPOSER' | 'ASSIGNEE' | 'IRRELEVANT';

export interface UserBrief {
  id: string;
  name: string;
  account: string;
}

export interface RequirementListItem {
  id: string;
  title: string;
  state: RequirementState;
  stateLabel: string;
  rowVersion: number;
  proposer: UserBrief;
  assignee: UserBrief;
  criteriaCount: number;
  latestSubmissionNo: number | null;
  myRole: Role;
  nextActions: CommandType[];
  createdAt: string;
  updatedAt: string;
}

/** 游标分页信息（与后端 domain/pagination.ts 的 PageInfo 对应） */
export interface PageInfo {
  limit: number;
  hasMore: boolean;
  /** 下一页游标；没有下一页时为 null */
  nextCursor: string | null;
}

/** 列表接口的响应：数组已改为「一页 + 分页信息」 */
export interface RequirementListPage {
  items: RequirementListItem[];
  pageInfo: PageInfo;
}

export interface Criterion {
  id: string;
  seq: number;
  text: string;
}

export interface ReviewCheck {
  criterionId: string;
  passed: boolean;
}

export interface ReviewRecord {
  action: 'RETURN' | 'COMPLETE';
  reason: string | null;
  reviewedAt: string;
  reviewer: UserBrief;
  checks: ReviewCheck[];
}

export interface Submission {
  id: string;
  submissionNo: number;
  note: string;
  submittedAt: string;
  submittedBy: UserBrief;
  artifacts: { seq: number; url: string }[];
  reviews: ReviewRecord[];
}

export interface DomainEvent {
  seq: number;
  eventType: string;
  actor: UserBrief;
  payload: unknown;
  createdAt: string;
}

export interface RequirementDetail {
  id: string;
  title: string;
  description: string;
  state: RequirementState;
  stateLabel: string;
  rowVersion: number;
  proposer: UserBrief;
  assignee: UserBrief;
  criteria: Criterion[];
  currentSubmissionId: string | null;
  currentSubmission: Submission | null;
  /**
   * 只包含**最近若干次**提交与**最近若干条**事件 —— 服务端给这两个数组设了上界，
   * 详情响应因此有界（报告 §5.1 E2）。完整时间线走 `/history` 端点。
   * `*Total` / `*HasMore` 让界面能如实说明「这是最近 N 条，共 M 条」，
   * 而不是把截断藏起来。
   */
  submissions: Submission[];
  submissionsTotal: number;
  submissionsHasMore: boolean;
  events: DomainEvent[];
  eventsTotal: number;
  eventsHasMore: boolean;
  eventsLimit: number;
  myRole: Role;
  nextActions: CommandType[];
  createdAt: string;
  updatedAt: string;
}

/** 历史端点（`GET /requirements/:id/history`）：完整时间线，按 seq 游标分页 */
export interface RequirementHistory {
  requirementId: string;
  state: RequirementState;
  submissions: Submission[];
  submissionsHasMore: boolean;
  events: DomainEvent[];
  pageInfo: PageInfo;
}

/** 提交成果的表单载荷（前端 → API） */
export interface SubmitPayload {
  artifacts: string[];
  note: string;
}

/** 逐项验收的表单载荷（前端 → API），由 ReviewPanel 产出 */
export interface ReviewPayload {
  action: 'RETURN' | 'COMPLETE';
  reason?: string;
  checks: ReviewCheck[];
}

/** 状态与动作的中文文案，仅用于展示 */
export const STATE_LABEL: Record<RequirementState, string> = {
  PENDING: '待处理',
  IN_PROGRESS: '进行中',
  IN_REVIEW: '待验收',
  COMPLETED: '已完成',
};

export const COMMAND_LABEL: Record<CommandType, string> = {
  CREATE: '创建需求',
  EDIT: '编辑需求',
  START: '开始处理',
  SUBMIT: '提交成果',
  REVIEW_RETURN: '退回修改',
  REVIEW_COMPLETE: '确认完成',
};

export const EVENT_LABEL: Record<string, string> = {
  CREATED: '创建了需求',
  EDITED: '编辑了需求',
  STARTED: '开始处理',
  SUBMITTED: '提交了成果',
  RETURNED: '退回了成果',
  APPROVED: '确认完成',
};
