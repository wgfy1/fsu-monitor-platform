import { Router } from 'express';
import UserService from '../services/userService';
import { SafeUser } from '../types';
import { authMiddleware } from '../middleware/auth';

const router = Router();

/**
 * 用户登录（公开）
 * POST /api/auth/login  { username, password }
 * 成功返回 { token, user }
 */
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    res.sendBadRequest('请输入用户名和密码');
    return;
  }
  const result = await UserService.login(String(username), String(password));
  if (!result) {
    // 统一提示，不区分"用户不存在/密码错误/账号禁用"
    res.sendUnauthorized('用户名或密码错误');
    return;
  }
  res.sendSuccess(result, '登录成功');
});

/**
 * 获取当前登录用户信息（需登录）
 * GET /api/auth/me
 */
router.get('/me', authMiddleware, async (req, res) => {
  const user = await UserService.getById(req.user!.uid);
  if (!user) {
    res.sendUnauthorized('用户不存在');
    return;
  }
  const { password: _password, ...safe } = user;
  res.sendSuccess(safe as SafeUser, '获取当前用户成功');
});

/**
 * 修改自己的密码（需登录）
 * POST /api/auth/change-password  { oldPassword, newPassword }
 *
 * 限制：租户账号（存在 tenant_id）不支持自助修改密码，
 * 统一由管理员在「用户管理 → 重置密码」处理。
 * 注意这是服务端强制校验——即使前端隐藏了入口，直接调接口同样会被拒绝。
 */
router.post('/change-password', authMiddleware, async (req, res) => {
  if (req.user!.tenantId) {
    res.sendForbidden('租户账号不支持自助修改密码，请联系管理员在「用户管理」中重置');
    return;
  }

  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) {
    res.sendBadRequest('请输入原密码和新密码');
    return;
  }
  try {
    await UserService.changePassword(req.user!.uid, String(oldPassword), String(newPassword));
    res.sendSuccess(null, '密码修改成功');
  } catch (error: any) {
    res.sendBadRequest(error.message || '密码修改失败');
  }
});

/**
 * 退出登录（需登录；无状态 JWT，前端清除 Token 即可）
 * POST /api/auth/logout
 */
router.post('/logout', authMiddleware, (_req, res) => {
  res.sendSuccess(null, '已退出登录');
});

export default router;
