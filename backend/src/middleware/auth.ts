import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../utils/jwt';
import database from '../models/database';

/**
 * 扩展 Express Request：认证通过后挂载当前用户载荷
 */
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * 登录认证中间件
 * 解析 Authorization: Bearer <token>，并实时校验用户仍存在且启用
 * （禁用/删除账号后旧 Token 立即失效，无需等待过期）
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    res.sendUnauthorized('未登录或登录已过期');
    return;
  }

  const payload = verifyToken(header.slice(7).trim());
  if (!payload) {
    res.sendUnauthorized('未登录或登录已过期');
    return;
  }

  // 每请求查库校验用户状态（禁用/删除立即生效；低流量内网，主键查询成本可忽略）
  const row = await database
    .get('SELECT status, role, tenant_id FROM users WHERE id = ?', [payload.uid])
    .catch(() => null);
  if (!row || row.status !== 1) {
    res.sendUnauthorized('账号已被禁用或不存在');
    return;
  }

  // 用 DB 最新角色/租户回写，角色或租户变更即时生效（而非等 Token 过期）
  payload.role = row.role;
  payload.tenantId = row.tenant_id ?? null;
  req.user = payload;
  next();
}

/**
 * 平台管理员判定：role=admin 且无归属租户（租户管理员有 tenant_id，只能管自己的租户）
 */
export function isPlatformOperator(user?: JwtPayload): boolean {
  return !!user && user.role === 'admin' && !user.tenantId;
}

/**
 * 平台管理员校验中间件（必须挂在 authMiddleware 之后使用）
 */
export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isPlatformOperator(req.user)) {
    res.sendForbidden('仅平台管理员可执行此操作');
    return;
  }
  next();
}

/**
 * 管理员校验中间件（必须挂在 authMiddleware 之后使用）
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.sendForbidden('无权限执行此操作');
    return;
  }
  next();
}
