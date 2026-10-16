import { Router, Request, Response } from 'express';
import SiteService from '../services/siteService';
import database from '../models/database';
import { isPlatformOperator } from '../middleware/auth';
const router = Router();

/**
 * 站点管理 API（租户 → 站点 → 设备）
 *
 * 租户隔离：
 *  - 平台管理员（role=admin 且无 tenant_id）：可见/可管全部租户站点，可指定归属租户
 *  - 租户账号：只能看到、创建、修改、删除自己租户的站点与设备
 * 站点归属由服务端从登录态推导，客户端传的 tenantId 仅平台管理员有效。
 */

/** 当前请求可见的站点归属范围：平台管理员 → null（不过滤） */
function siteScope(user?: { tenantId?: string | null }): string | null {
  return user?.tenantId ?? null;
}

/** 解析可空数字字段（空串/undefined 按 null 处理） */
function nullableNumber(value: any): number | null {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** 解析可空字符串字段（空串按 null 处理） */
function nullableString(value: any): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * 获取站点列表
 * GET /api/sites
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const sites = await SiteService.getSites(siteScope(req.user));
    res.sendSuccess(sites, '获取站点列表成功');
  } catch (error) {
    console.error('获取站点列表失败:', error);
    res.sendServerError('获取站点列表失败');
  }
});

/**
 * 获取站点统计（首页卡片用）
 * GET /api/sites/stats
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await SiteService.getSiteStats(siteScope(req.user));
    res.sendSuccess(stats, '获取站点统计成功');
  } catch (error) {
    console.error('获取站点统计失败:', error);
    res.sendServerError('获取站点统计失败');
  }
});

/**
 * 获取站点详情
 * GET /api/sites/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const site = await SiteService.getSiteById(Number(req.params.id), siteScope(req.user));
    if (!site) {
      return res.sendNotFound('站点不存在');
    }
    res.sendSuccess(site, '获取站点详情成功');
  } catch (error) {
    console.error('获取站点详情失败:', error);
    res.sendServerError('获取站点详情失败');
  }
});

/**
 * 获取站点已关联的设备ID列表
 * GET /api/sites/:id/devices
 */
router.get('/:id/devices', async (req: Request, res: Response) => {
  try {
    const site = await SiteService.getSiteById(Number(req.params.id), siteScope(req.user));
    if (!site) {
      return res.sendNotFound('站点不存在');
    }
    const ids = await SiteService.getSiteDeviceIds(Number(req.params.id), siteScope(req.user));
    res.sendSuccess(ids, '获取站点设备成功');
  } catch (error) {
    console.error('获取站点设备失败:', error);
    res.sendServerError('获取站点设备失败');
  }
});

/**
 * 创建站点
 * POST /api/sites
 * Body: { name, province_code?, city_code?, district_code?, address?, remark?, tenant_id? }
 *
 * tenant_id 仅平台管理员可用（租户账号强制为自身租户，传了也忽略）
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const tenantId = isPlatformOperator(req.user)
      ? nullableString(body.tenant_id)
      : (req.user?.tenantId ?? null);

    const result = await SiteService.createSite({
      name: body.name,
      tenantId,
      provinceCode: nullableString(body.province_code),
      cityCode: nullableString(body.city_code),
      districtCode: nullableString(body.district_code),
      address: body.address,
      remark: body.remark,
      // 经纬度可为空；填写时由 service 做范围校验（不做坐标猜测）
      latitude: body.latitude,
      longitude: body.longitude,
    });

    if (!result.ok) {
      return res.sendBadRequest(result.message || '创建站点失败');
    }

    const site = await SiteService.getSiteById(result.id!, siteScope(req.user));
    res.sendSuccess(site, '站点创建成功');
  } catch (error) {
    console.error('创建站点失败:', error);
    res.sendServerError('创建站点失败');
  }
});

/**
 * 更新站点
 * PUT /api/sites/:id
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const result = await SiteService.updateSite(
      Number(req.params.id),
      {
        name: body.name,
        provinceCode: body.province_code !== undefined ? nullableString(body.province_code) : undefined,
        cityCode: body.city_code !== undefined ? nullableString(body.city_code) : undefined,
        districtCode: body.district_code !== undefined ? nullableString(body.district_code) : undefined,
        address: body.address,
        remark: body.remark,
        // 未传 latitude/longitude 时保持原值；传 null/'' 表示清空
        latitude: body.latitude !== undefined ? nullableNumber(body.latitude) : undefined,
        longitude: body.longitude !== undefined ? nullableNumber(body.longitude) : undefined,
      },
      siteScope(req.user)
    );

    if (!result.ok) {
      return result.notFound
        ? res.sendNotFound(result.message || '站点不存在')
        : res.sendBadRequest(result.message || '更新站点失败');
    }

    const site = await SiteService.getSiteById(Number(req.params.id), siteScope(req.user));
    res.sendSuccess(site, '站点更新成功');
  } catch (error) {
    console.error('更新站点失败:', error);
    res.sendServerError('更新站点失败');
  }
});

/**
 * 删除站点（仅站点本身；关联设备保留并解绑为"未分配"）
 * DELETE /api/sites/:id
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await SiteService.deleteSite(Number(req.params.id), siteScope(req.user));
    if (!result.ok) {
      return res.sendNotFound('站点不存在');
    }
    res.sendSuccess(
      { unboundDevices: result.unboundDevices || 0 },
      `站点已删除，${result.unboundDevices || 0} 台设备已变为未分配`
    );
  } catch (error) {
    console.error('删除站点失败:', error);
    res.sendServerError('删除站点失败');
  }
});

/**
 * 绑定设备到站点
 * POST /api/sites/:id/devices
 * Body: { deviceIds: string[] }
 */
router.post('/:id/devices', async (req: Request, res: Response) => {
  try {
    const deviceIds = Array.isArray(req.body?.deviceIds) ? req.body.deviceIds : [];
    if (deviceIds.length === 0) {
      return res.sendBadRequest('请选择要绑定的设备');
    }
    const result = await SiteService.bindDevices(
      Number(req.params.id), deviceIds, siteScope(req.user)
    );
    if (!result.ok) {
      return res.sendNotFound(result.message || '站点不存在');
    }
    const failedCount = result.failed?.length || 0;
    const message = failedCount > 0
      ? `已绑定 ${result.bound?.length || 0} 台，${failedCount} 台未绑定`
      : `已绑定 ${result.bound?.length || 0} 台设备`;
    res.sendSuccess({ bound: result.bound, failed: result.failed }, message);
  } catch (error) {
    console.error('绑定站点设备失败:', error);
    res.sendServerError('绑定站点设备失败');
  }
});

/**
 * 解绑设备（设备回到"未分配"，设备与历史数据均保留）
 * DELETE /api/sites/:id/devices
 * Body: { deviceIds: string[] }
 */
router.delete('/:id/devices', async (req: Request, res: Response) => {
  try {
    const deviceIds = Array.isArray(req.body?.deviceIds) ? req.body.deviceIds : [];
    if (deviceIds.length === 0) {
      return res.sendBadRequest('请选择要解绑的设备');
    }
    const result = await SiteService.unbindDevices(
      Number(req.params.id), deviceIds, siteScope(req.user)
    );
    if (!result.ok) {
      return res.sendNotFound(result.message || '站点不存在');
    }
    res.sendSuccess({ unbound: result.unbound }, `已解绑 ${result.unbound?.length || 0} 台设备`);
  } catch (error) {
    console.error('解绑站点设备失败:', error);
    res.sendServerError('解绑站点设备失败');
  }
});

/**
 * 可绑定到站点的设备候选列表
 * GET /api/sites/:id/device-candidates
 *
 * 只返回"本站点所属租户"的设备，且排除已归属其他站点的设备
 * （已在本站点的设备也会返回，供编辑时回显勾选状态）
 */
router.get('/:id/device-candidates', async (req: Request, res: Response) => {
  try {
    const site = await SiteService.getSiteById(Number(req.params.id), siteScope(req.user));
    if (!site) {
      return res.sendNotFound('站点不存在');
    }

    // 站点归属租户决定可选设备范围；平台站点（tenant_id 为空）只在其自身范围内选
    const rows = await database.query(
      site.tenant_id
        ? `SELECT id, name, status, site_id FROM devices
           WHERE tenant_id = ? AND (site_id IS NULL OR site_id = ?)
           ORDER BY id`
        : `SELECT id, name, status, site_id FROM devices
           WHERE tenant_id IS NULL AND (site_id IS NULL OR site_id = ?)
           ORDER BY id`,
      site.tenant_id ? [site.tenant_id, site.id] : [site.id]
    );
    res.sendSuccess(rows, '获取可绑定设备成功');
  } catch (error) {
    console.error('获取可绑定设备失败:', error);
    res.sendServerError('获取可绑定设备失败');
  }
});

export default router;
