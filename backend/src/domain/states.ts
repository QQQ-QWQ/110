/**
 * 状态机 —— 唯一真相源（架构约束：状态枚举只能在此处定义）
 *
 * 状态流转：
 *   待处理 PENDING ──负责人开始──▶ 进行中 IN_PROGRESS ──负责人提交 Vn──▶ 待验收 IN_REVIEW
 *      ▲                                                                    │
 *      └──────────────── 提出者退回（原因必填）◀──────────────────────────┘
 *                                                                          │ 全部条件通过
 *                                                                          ▼
 *                                                                    已完成 COMPLETED（终态）
 */

export const RequirementState = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  IN_REVIEW: 'IN_REVIEW',
  COMPLETED: 'COMPLETED',
} as const;

export type RequirementState = (typeof RequirementState)[keyof typeof RequirementState];

export const ALL_STATES: readonly RequirementState[] = [
  RequirementState.PENDING,
  RequirementState.IN_PROGRESS,
  RequirementState.IN_REVIEW,
  RequirementState.COMPLETED,
];

export const STATE_LABEL: Record<RequirementState, string> = {
  PENDING: '待处理',
  IN_PROGRESS: '进行中',
  IN_REVIEW: '待验收',
  COMPLETED: '已完成',
};

/** 写命令类型（对应统一写命令管道） */
export const CommandType = {
  CREATE: 'CREATE',
  EDIT: 'EDIT',
  START: 'START',
  SUBMIT: 'SUBMIT',
  REVIEW_RETURN: 'REVIEW_RETURN',
  REVIEW_COMPLETE: 'REVIEW_COMPLETE',
} as const;

export type CommandType = (typeof CommandType)[keyof typeof CommandType];

export type MutatingCommand = Exclude<CommandType, 'CREATE'>;

/** 状态守卫：每个动作允许的前置状态（CREATE 无前置状态） */
export const STATE_GUARD: Record<MutatingCommand, readonly RequirementState[]> = {
  EDIT: [RequirementState.PENDING],
  START: [RequirementState.PENDING],
  SUBMIT: [RequirementState.IN_PROGRESS],
  REVIEW_RETURN: [RequirementState.IN_REVIEW],
  REVIEW_COMPLETE: [RequirementState.IN_REVIEW],
};

/** 动作完成后的目标状态 */
export const NEXT_STATE: Record<MutatingCommand, RequirementState> = {
  EDIT: RequirementState.PENDING,
  START: RequirementState.IN_PROGRESS,
  SUBMIT: RequirementState.IN_REVIEW,
  REVIEW_RETURN: RequirementState.IN_PROGRESS,
  REVIEW_COMPLETE: RequirementState.COMPLETED,
};

/** 事件类型（写入 EVENT 表） */
export const EVENT_TYPE: Record<CommandType, string> = {
  CREATE: 'CREATED',
  EDIT: 'EDITED',
  START: 'STARTED',
  SUBMIT: 'SUBMITTED',
  REVIEW_RETURN: 'RETURNED',
  REVIEW_COMPLETE: 'APPROVED',
};

export function isState(value: string): value is RequirementState {
  return (ALL_STATES as readonly string[]).includes(value);
}

/** 终态判定：已完成之后任何推进/退回一律拒绝 */
export function isTerminal(state: RequirementState): boolean {
  return state === RequirementState.COMPLETED;
}

/** 该状态下是否允许某动作（仅看状态，不看角色） */
export function stateAllows(state: RequirementState, command: MutatingCommand): boolean {
  return STATE_GUARD[command].includes(state);
}

/**
 * 「下一步可执行操作」——供前端展示，避免用户猜。
 * 注意：这只是展示用提示，真正的判定在后端 policy 中强制执行。
 */
export function nextActionsFor(
  state: RequirementState,
  role: 'PROPOSER' | 'ASSIGNEE' | 'IRRELEVANT',
): CommandType[] {
  if (role === 'IRRELEVANT') return [];
  if (isTerminal(state)) return [];

  const actions: CommandType[] = [];
  if (role === 'PROPOSER' && state === RequirementState.PENDING) actions.push(CommandType.EDIT);
  if (role === 'ASSIGNEE' && state === RequirementState.PENDING) actions.push(CommandType.START);
  if (role === 'ASSIGNEE' && state === RequirementState.IN_PROGRESS) actions.push(CommandType.SUBMIT);
  if (role === 'PROPOSER' && state === RequirementState.IN_REVIEW) {
    actions.push(CommandType.REVIEW_RETURN, CommandType.REVIEW_COMPLETE);
  }
  return actions;
}
