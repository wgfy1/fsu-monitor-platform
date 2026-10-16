import { Router } from 'express';
import UserService from '../services/userService';
import database from '../models/database';
import { UserRole } from '../types';
import { requireAdmin, isPlatformOperator } from '../middleware/auth';

const router = Router();

// 全路由仅管理员可访问（须挂在 authMiddleware 之后）
router.use(requireAdmin);

/**
 * 统计"除指定用户之外"仍在启用状态的【平台管理员】数量
 *
 * 平台管理员口径 = role='admin' 且 tenant_id IS NULL（与 middleware/auth 的
 * isPlatformOperator 保持一致）。
 *
 * 两个要点：
 *  1. 必须排除当前正在修改的用户（id <> ?），否则"自己算自己"会永远判定为
 *     最后一位管理员，导致无法把自己降级；
 *  2. 按【整个系统】统计，不按租户范围统计——其他租户存在管理员，不能作为
 *     "本租户还有管理员"的依据，反之亦然。
 *
 * @param excludeUserId 需要排除的用户ID（通常是当前被修改的用户）
 */
async function countOtherEnabledPlatformAdmins(excludeUserId: number): Promise<number> {
  const row = await database.get(
    `SELECT COUNT(*) AS count FROM users
     WHERE role = 'admin' AND status = 1 AND tenant_id IS NULL AND id <> ?`,
    [excludeUserId]
  );
  return row?.count || 0;
}

/**
 * 租户访问范围校验：非平台管理员的 admin（租户管理员）只能操作本租户用户
 * @returns 目标用户是否在当前管理员的管理范围内
 */
function canManageUser(operatorTenantId: string | null | undefined, targetTenantId: string | null | undefined): boolean {
  // 平台管理员（无租户）可管理全部；租户管理员仅可管理同租户用户
  if (operatorTenantId === null || operatorTenantId === undefined) return true;
  return targetTenantId === operatorTenantId;
}

/**
 * 用户列表
 * GET /api/users
 * 平台管理员：全部用户；租户管理员：仅本租户用户
 * 附带租户名称（tenants.name），前端"所属租户"列直接展示正式租户名
 */
router.get('/', async (req, res) => {
  try {
    const users = await UserService.list(isPlatformOperator(req.user) ? null : (req.user?.tenantId ?? null));
    const tenants = await database.query('SELECT id, name FROM tenants');
    const nameMap = new Map(tenants.map((t: any) => [String(t.id), String(t.name)]));
    const withTenant = users.map((u: any) => ({
      ...u,
      tenant_name: u.tenant_id ? (nameMap.get(String(u.tenant_id)) ?? null) : null,
    }));
    res.sendSuccess(withTenant, '获取用户列表成功');
  } catch (error) {
    console.error('获取用户列表失败:', error);
    res.sendServerError('获取用户列表失败');
  }
});

/**
 * 创建用户
 * POST /api/users  { username, password, role?, tenantId? }
 * 平台管理员：可指定 tenantId（不指定则创建平台运维账号）；
 * 租户管理员：强制在本租户内建号，忽略传入的 tenantId
 */
router.post('/', async (req, res) => {
  try {
    const { username, password, role, tenantId } = req.body || {};
    if (!username || !password) {
      res.sendBadRequest('请输入用户名和密码');
      return;
    }
    if (role !== undefined && role !== 'admin' && role !== 'user') {
      res.sendBadRequest('角色仅支持 admin 或 user');
      return;
    }
    const targetTenant = isPlatformOperator(req.user)
      ? (tenantId != null && tenantId !== '' ? String(tenantId) : null)
      : (req.user?.tenantId ?? null);

    // 租户必须是正式租户，且一个租户最多绑定一个用户（数据库唯一约束 + 此业务校验双重保证）
    if (targetTenant) {
      const tenant = await database.get('SELECT id, name FROM tenants WHERE id = ?', [targetTenant]);
      if (!tenant) {
        res.sendBadRequest('所选租户不存在，请先在「租户管理」中创建');
        return;
      }
      const bound = await database.get('SELECT id FROM users WHERE tenant_id = ?', [targetTenant]);
      if (bound) {
        res.sendBadRequest(`租户「${tenant.name}」已经绑定用户，一个租户只能绑定一个用户`);
        return;
      }
    }

    const user = await UserService.createUser({
      username: String(username),
      password: String(password),
      role: role as UserRole | undefined,
      tenantId: targetTenant,
    });
    res.sendSuccess(user, '创建用户成功');
  } catch (error: any) {
    if (error.message === '用户名已存在' || error.message?.includes('用户名需为') || error.message?.includes('密码长度')) {
      res.sendBadRequest(error.message);
      return;
    }
    console.error('创建用户失败:', error);
    res.sendServerError('创建用户失败');
  }
});

/**
 * 编辑用户（仅 role / status）
 * PUT /api/users/:id  { role?, status? }
 */
router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.sendBadRequest('用户ID不合法');
      return;
    }
    const { role, status } = req.body || {};

    if (role !== undefined && role !== 'admin' && role !== 'user') {
      res.sendBadRequest('角色仅支持 admin 或 user');
      return;
    }
    if (status !== undefined && status !== 0 && status !== 1) {
      res.sendBadRequest('状态仅支持 0（禁用）或 1（启用）');
      return;
    }

    const target = await UserService.getById(id);
    if (!target) {
      res.sendNotFound('用户不存在');
      return;
    }

    // 租户管理员只能管理本租户用户
    if (!canManageUser(req.user?.tenantId ?? null, target.tenant_id ?? null)) {
      res.sendForbidden('不能操作其他租户的用户');
      return;
    }

    // 防呆：不能修改自己的角色或状态
    if (id === req.user!.uid && (role !== undefined || status !== undefined)) {
      res.sendBadRequest('不能修改自己的角色或状态');
      return;
    }

    // 防呆：整个系统至少保留一个启用状态的平台管理员
    //  - 判断时排除"当前被修改的用户"（id <> ?），否则自己会被算进去，永远判定为最后一个
    //  - 按全系统统计，不按租户范围统计：其他租户有管理员 ≠ 本租户还有管理员
    //  - 仅当"目标当前是启用中的平台管理员，且本次会失去该身份"时才校验；
    //    降级/禁用租户管理员、普通用户不受此限制（本平台不要求每个租户必须保留管理员）
    const newRole: UserRole = role ?? target.role;
    const newStatus = status !== undefined ? status : target.status;
    const isEnabledPlatformAdmin =
      target.role === 'admin' && target.status === 1 && (target.tenant_id ?? null) === null;
    const stopsBeingEnabledPlatformAdmin =
      isEnabledPlatformAdmin && (newRole !== 'admin' || newStatus === 0);
    if (stopsBeingEnabledPlatformAdmin && (await countOtherEnabledPlatformAdmins(id)) === 0) {
      res.sendBadRequest('系统至少需要保留一个启用状态的平台管理员');
      return;
    }

    const fields: { role?: UserRole; status?: number } = {};
    if (role !== undefined) fields.role = role as UserRole;
    if (status !== undefined) fields.status = Number(status);

    const updated = await UserService.updateUser(id, fields);
    if (!updated) {
      res.sendNotFound('用户不存在');
      return;
    }
    res.sendSuccess(null, '更新用户成功');
  } catch (error) {
    console.error('更新用户失败:', error);
    res.sendServerError('更新用户失败');
  }
});

/**
 * 删除用户
 * DELETE /api/users/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.sendBadRequest('用户ID不合法');
      return;
    }
    if (id === req.user!.uid) {
      res.sendBadRequest('不能删除自己的账号');
      return;
    }
    const target = await UserService.getById(id);
    if (!target) {
      res.sendNotFound('用户不存在');
      return;
    }
    // 租户管理员只能管理本租户用户
    if (!canManageUser(req.user?.tenantId ?? null, target.tenant_id ?? null)) {
      res.sendForbidden('不能操作其他租户的用户');
      return;
    }

    // 一个租户 = 一个账号：租户账号不能单独删除，否则会留下"有租户没有账号"的孤儿租户。
    // 需要清理整个租户时，请走「租户管理 → 删除租户」（会连带删除该租户全部业务数据）。
    if (target.tenant_id) {
      res.sendBadRequest('租户账号不能单独删除，请在租户管理中删除租户');
      return;
    }

    // 防呆：整个系统至少保留一个启用状态的平台管理员
    // 口径与「修改用户角色」完全一致（同一个 countOtherEnabledPlatformAdmins）：
    //  - 只保护平台管理员（role='admin' 且 tenant_id IS NULL）
    //  - 全系统统计，不按租户范围统计：其他租户/平台侧有管理员 ≠ 本租户还有管理员
    //  - 排除当前被删除的用户
    //  - 删除租户管理员、普通用户不受此限制（本平台不要求每个租户必须保留管理员）
    const isEnabledPlatformAdmin =
      target.role === 'admin' && target.status === 1 && (target.tenant_id ?? null) === null;
    if (isEnabledPlatformAdmin && (await countOtherEnabledPlatformAdmins(id)) === 0) {
      res.sendBadRequest('系统至少需要保留一个启用状态的平台管理员');
      return;
    }
    await UserService.deleteUser(id);
    res.sendSuccess(null, '删除用户成功');
  } catch (error) {
    console.error('删除用户失败:', error);
    res.sendServerError('删除用户失败');
  }
});

/**
 * 重置密码（管理员操作）
 * POST /api/users/:id/reset-password  { newPassword }
 */
router.post('/:id/reset-password', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.sendBadRequest('用户ID不合法');
      return;
    }
    const { newPassword } = req.body || {};
    if (!newPassword) {
      res.sendBadRequest('请输入新密码');
      return;
    }
    // 租户管理员只能管理本租户用户
    const target = await UserService.getById(id);
    if (!target) {
      res.sendNotFound('用户不存在');
      return;
    }
    if (!canManageUser(req.user?.tenantId ?? null, target.tenant_id ?? null)) {
      res.sendForbidden('不能操作其他租户的用户');
      return;
    }
    try {
      const updated = await UserService.resetPassword(id, String(newPassword));
      if (!updated) {
        res.sendNotFound('用户不存在');
        return;
      }
      res.sendSuccess(null, '密码重置成功');
    } catch (error: any) {
      if (error.message?.includes('密码长度')) {
        res.sendBadRequest(error.message);
        return;
      }
      throw error;
    }
  } catch (error) {
    console.error('重置密码失败:', error);
    res.sendServerError('重置密码失败');
  }
});

export default router;
