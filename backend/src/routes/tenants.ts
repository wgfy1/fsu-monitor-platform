import { Router, Request, Response } from 'express';
import TenantService from '../services/tenantService';
import { requirePlatformAdmin } from '../middleware/auth';
const router = Router();

/**
 * 租户管理 API（仅平台管理员）
 *
 * 一个租户 = 一个登录账号；删除租户会连带删除该租户的全部业务数据。
 * 整路由使用 requirePlatformAdmin：租户账号（含租户管理员）一律 403，
 * 无法通过 URL / query / body 中的任何 tenantId 越权。
 */
router.use(requirePlatformAdmin);

/**
 * 租户列表（含绑定账号、站点数、设备数）
 * GET /api/tenants
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const tenants = await TenantService.list();
    res.sendSuccess(tenants, '获取租户列表成功');
  } catch (error) {
    console.error('获取租户列表失败:', error);
    res.sendServerError('获取租户列表失败');
  }
});

/**
 * 未绑定账号的租户（供「新增用户 → 归属租户」下拉）
 * GET /api/tenants/available
 */
router.get('/available', async (_req: Request, res: Response) => {
  try {
    const tenants = await TenantService.listAvailable();
    res.sendSuccess(tenants, '获取可选租户成功');
  } catch (error) {
    console.error('获取可选租户失败:', error);
    res.sendServerError('获取可选租户失败');
  }
});

/**
 * 删除前统计（确认弹窗展示用）
 * GET /api/tenants/:id/delete-preview
 */
router.get('/:id/delete-preview', async (req: Request, res: Response) => {
  try {
    const preview = await TenantService.getDeletePreview(String(req.params.id));
    if (!preview) {
      return res.sendNotFound('租户不存在');
    }
    res.sendSuccess(preview, '获取租户删除预览成功');
  } catch (error) {
    console.error('获取租户删除预览失败:', error);
    res.sendServerError('获取租户删除预览失败');
  }
});

/**
 * 租户详情
 * GET /api/tenants/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const tenant = await TenantService.getById(String(req.params.id));
    if (!tenant) {
      return res.sendNotFound('租户不存在');
    }
    res.sendSuccess(tenant, '获取租户详情成功');
  } catch (error) {
    console.error('获取租户详情失败:', error);
    res.sendServerError('获取租户详情失败');
  }
});

/**
 * 创建租户 + 唯一账号（同一事务）
 * POST /api/tenants
 * Body: { name, remark?, username, password }
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const result = await TenantService.createWithUser({
      name: body.name,
      remark: body.remark,
      username: body.username,
      password: body.password,
    });
    if (!result.ok) {
      return res.sendBadRequest(result.message || '创建租户失败');
    }
    const tenant = await TenantService.getById(result.id!);
    res.sendSuccess(tenant, '租户创建成功');
  } catch (error) {
    console.error('创建租户失败:', error);
    res.sendServerError('创建租户失败');
  }
});

/**
 * 更新租户（名称 / 备注 / 状态）
 * PUT /api/tenants/:id
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const result = await TenantService.update(String(req.params.id), {
      name: body.name,
      remark: body.remark,
      status: body.status,
    });
    if (!result.ok) {
      return result.notFound
        ? res.sendNotFound(result.message || '租户不存在')
        : res.sendBadRequest(result.message || '更新租户失败');
    }
    const tenant = await TenantService.getById(String(req.params.id));
    res.sendSuccess(tenant, '租户更新成功');
  } catch (error) {
    console.error('更新租户失败:', error);
    res.sendServerError('更新租户失败');
  }
});

/**
 * 更换账号（租户不变，只替换唯一账号）
 * PUT /api/tenants/:id/account
 * Body: { username, password? }
 */
router.put('/:id/account', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    if (!body.username) {
      return res.sendBadRequest('请输入新的登录账号');
    }
    const result = await TenantService.replaceAccount(String(req.params.id), {
      username: body.username,
      password: body.password,
    });
    if (!result.ok) {
      return result.notFound
        ? res.sendNotFound(result.message || '租户不存在')
        : res.sendBadRequest(result.message || '更换账号失败');
    }
    res.sendSuccess(null, '账号已更换');
  } catch (error) {
    console.error('更换租户账号失败:', error);
    res.sendServerError('更换租户账号失败');
  }
});

/**
 * 删除租户及其全部业务数据（事务）
 * DELETE /api/tenants/:id
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await TenantService.deleteTenant(String(req.params.id));
    if (!result.ok) {
      return res.sendNotFound(result.message || '租户不存在');
    }
    const p = result.preview!;
    res.sendSuccess(
      { preview: p },
      `租户「${p.tenant_name}」及其全部业务数据已删除`
    );
  } catch (error) {
    console.error('删除租户失败:', error);
    res.sendServerError('删除租户失败');
  }
});

export default router;
