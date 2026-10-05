import { Errors } from '../core/errors';
import { CommandType, MutatingCommand, RequirementState, isTerminal, stateAllows } from './states';

/**
 * 资源级授权（架构约束：POLICY 单点，禁止在 controller 内写角色判断）
 *
 * 关键点：角色不是全局的，而是「每条需求」维度动态求得。
 * 同一个人可以在需求 X 是提出者、在需求 Y 是负责人。
 */

export type Role = 'PROPOSER' | 'ASSIGNEE' | 'IRRELEVANT';

export interface RequirementOwnership {
  proposerId: string;
  assigneeId: string;
}

/** 求当前用户在某条需求中的角色 */
export function roleOf(userId: string, r: RequirementOwnership): Role {
  if (r.proposerId === userId) return 'PROPOSER';
  if (r.assigneeId === userId) return 'ASSIGNEE';
  return 'IRRELEVANT';
}

/** 动作 → 允许的角色（只有这两个角色能写，且各自只能做自己的动作） */
const ACTION_ROLES: Record<MutatingCommand, readonly Role[]> = {
  EDIT: ['PROPOSER'],
  START: ['ASSIGNEE'],
  SUBMIT: ['ASSIGNEE'],
  REVIEW_RETURN: ['PROPOSER'],
  REVIEW_COMPLETE: ['PROPOSER'],
};

/**
 * 读权限：仅提出者与负责人可见。
 * 无关账号 → 404（不是 403）——避免通过状态码枚举出「这条需求存在」。
 */
export function assertCanRead(userId: string, r: RequirementOwnership): Role {
  const role = roleOf(userId, r);
  if (role === 'IRRELEVANT') throw Errors.notFound();
  return role;
}

/**
 * 写权限：先判可见性，再判动作合法性。
 * - 不可见        → 404（防枚举）
 * - 可见但角色不符 → 403（「无权限执行该操作」）
 * - 可见但状态不符 → 409（「当前状态不允许该操作」）
 */
export function assertCanPerform(
  userId: string,
  r: RequirementOwnership,
  state: RequirementState,
  command: MutatingCommand,
): Role {
  const role = roleOf(userId, r);

  if (role === 'IRRELEVANT') throw Errors.notFound();
  if (!ACTION_ROLES[command].includes(role)) throw Errors.forbidden();
  if (!stateAllows(state, command)) {
    if (isTerminal(state)) {
      throw Errors.stateConflict('需求已完成，不能继续提交或重复验收');
    }
    throw Errors.stateConflict();
  }
  return role;
}

/** 列表可见性过滤条件（在 SQL 层过滤，而非取回后再过滤） */
export function visibilityFilter(userId: string) {
  return {
    OR: [{ proposerId: userId }, { assigneeId: userId }],
  };
}
