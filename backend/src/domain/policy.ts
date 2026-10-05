import { Errors } from '../core/errors';
import { MutatingCommand, RequirementState, isTerminal, stateAllows } from './states';

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
 * 写权限 · 第 1 段：**角色判定**（不可见 → 404；角色不符 → 403）。
 *
 * 为什么要把角色与状态拆成两段：
 *   HTTP 语义要求请求头里的前置条件（`If-Match`）**先于**方法处理求值
 *   （RFC 9110 §13.1.1）。写命令管道因此需要把顺序摆成
 *
 *       可见性 404 → 角色 403 → 版本 412 → 状态 409
 *
 *   若把状态判定和角色判定绑在一起（旧写法），版本校验只能排在两者之后，
 *   于是「客户端版本已过期」会被误报成「当前状态不允许该操作」——
 *   而后者对客户端是误导：它屏幕上看到的还是旧状态，收到 409 只会困惑，
 *   收到 412 才知道「应当刷新后重试」。
 *
 *   注意不可见性仍必须排在最前：否则对他人资源发一个过期版本号就能
 *   通过 412/409 的差异把资源存在性试出来（枚举漏洞）。
 */
export function assertRoleCanPerform(
  userId: string,
  r: RequirementOwnership,
  command: MutatingCommand,
): Role {
  const role = roleOf(userId, r);

  if (role === 'IRRELEVANT') throw Errors.notFound();

  // 未登记的命令一律拒绝。
  // 若直接写 ACTION_ROLES[command].includes(...)，传入非法命令会因取到 undefined
  // 而抛出 TypeError，最终以 500 暴露内部细节（代码审查 R-04）。
  const allowedRoles = ACTION_ROLES[command];
  if (!allowedRoles) throw Errors.forbidden();
  if (!allowedRoles.includes(role)) throw Errors.forbidden();

  return role;
}

/** 写权限 · 第 2 段：**状态判定**（可见、角色对但状态不符 → 409） */
export function assertStateCanPerform(state: RequirementState, command: MutatingCommand): void {
  if (!stateAllows(state, command)) {
    if (isTerminal(state)) {
      throw Errors.stateConflict('需求已完成，不能继续提交或重复验收');
    }
    throw Errors.stateConflict();
  }
}

/**
 * 写权限：角色 + 状态的合并判定（404 → 403 → 409）。
 *
 * 不需要区分 412 与 409 的调用方可以继续用它；
 * 写命令管道因为要插入版本校验，改用上面两个函数显式排列顺序。
 */
export function assertCanPerform(
  userId: string,
  r: RequirementOwnership,
  state: RequirementState,
  command: MutatingCommand,
): Role {
  const role = assertRoleCanPerform(userId, r, command);
  assertStateCanPerform(state, command);
  return role;
}

/** 列表可见性过滤条件（在 SQL 层过滤，而非取回后再过滤） */
export function visibilityFilter(userId: string) {
  return {
    OR: [{ proposerId: userId }, { assigneeId: userId }],
  };
}
