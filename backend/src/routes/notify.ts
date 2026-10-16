import { Router, Request, Response } from 'express';
import NotifyService, { isSmsProviderAvailable } from '../services/notifyService';
import { isPlatformOperator, requirePlatformAdmin } from '../middleware/auth';
import { AlarmNotifyConfig } from '../types';
import database from '../models/database';
const router = Router();

/**
 * 告警推送访问控制（已挂在全局 /api 鉴权之后）
 *  - 平台管理员（admin 且无租户）：管理平台级配置，并可用 ?tenantId= 管理任一租户
 *  - 有租户归属的账号（租户管理员、普通租户用户）：只能管理自己租户的配置，
 *    tenantId 一律由服务端从登录态推导，请求里传的其他 tenantId 一律忽略
 *  - 既非平台管理员、又无租户归属的账号：没有对应的推送配置，拒绝访问
 */
router.use((req: Request, res: Response, next) => {
  if (isPlatformOperator(req.user) || req.user?.tenantId) {
    next();
    return;
  }
  res.sendForbidden('当前账号未归属任何租户，无法使用告警推送');
});

/**
 * 解析本次请求操作的租户范围
 *
 * 安全要点：非平台管理员的 tenantId **只取登录态**，完全忽略 req.query.tenantId，
 * 因此手动传入其他租户 ID 也无法越权。
 *
 * @returns tenantId（null=平台级）、crossTenant（是否可跨租户）
 */
function resolveScope(req: Request): { tenantId: string | null; crossTenant: boolean } {
  const isPlatform = isPlatformOperator(req.user);
  if (!isPlatform) {
    // 租户账号（含普通租户用户）：强制锁定自身租户，忽略请求里的 tenantId，杜绝越权
    return { tenantId: req.user?.tenantId ?? null, crossTenant: false };
  }
  // 平台管理员：可通过 ?tenantId=xxx 指定要管理的租户；不传 = 平台级配置
  const raw = String(req.query.tenantId ?? '').trim();
  return { tenantId: raw === '' ? null : raw, crossTenant: true };
}

/**
 * 获取推送配置
 * GET /api/notify/config[?tenantId=xxx]
 */
router.get('/config', async (req: Request, res: Response) => {
  try {
    const { tenantId } = resolveScope(req);
    const config = await NotifyService.getConfig(tenantId);
    res.sendSuccess({
      ...config,
      // 当前生效的租户范围（前端据此显示在管理哪个租户的配置）
      tenantId,
      // 短信供应商是否已接入（预留扩展，当前恒 false，接入真实短信后由 .env 控制）
      smsProviderAvailable: isSmsProviderAvailable()
    }, '获取推送配置成功');
  } catch (error) {
    console.error('获取推送配置失败:', error);
    res.sendServerError('获取推送配置失败');
  }
});

/**
 * 保存推送配置
 * PUT /api/notify/config[?tenantId=xxx]
 * Body: 任意子集 { enabled, dingtalk_enabled, dingtalk_webhook, dingtalk_secret, sms_enabled, sms_numbers, dedupe_minutes }
 */
router.put('/config', async (req: Request, res: Response) => {
  try {
    const { tenantId } = resolveScope(req);
    const body = req.body || {};
    const patch: Partial<AlarmNotifyConfig> = {};

    // 白名单字段（布尔开关允许 true/false 与 0/1）
    for (const key of ['enabled', 'dingtalk_enabled', 'sms_enabled'] as const) {
      if (body[key] !== undefined) patch[key] = body[key] ? 1 : 0;
    }
    if (body.dingtalk_webhook !== undefined) patch.dingtalk_webhook = String(body.dingtalk_webhook);
    if (body.dingtalk_secret !== undefined) patch.dingtalk_secret = String(body.dingtalk_secret);
    if (body.sms_numbers !== undefined) patch.sms_numbers = String(body.sms_numbers);
    if (body.dedupe_minutes !== undefined) patch.dedupe_minutes = Number(body.dedupe_minutes);

    await NotifyService.updateConfig(patch, tenantId);
    res.sendSuccess({ tenantId }, '推送配置已保存');
  } catch (error: any) {
    if (error?.message && /^(开启|钉钉|手机号|去重)/.test(error.message)) {
      console.warn('保存推送配置校验失败:', error.message);
      res.sendBadRequest(error.message);
      return;
    }
    console.error('保存推送配置失败:', error);
    res.sendServerError('保存推送配置失败');
  }
});

/**
 * 发送测试推送（样例告警走真实通道，不做去重）
 * POST /api/notify/test[?tenantId=xxx]
 *
 * 权限：**仅平台管理员**。这是主动向通道发消息的动作，普通租户账号即使直接调接口也一律 403，
 * 不依赖前端隐藏按钮。租户账号仍可正常保存/读取自己的推送配置。
 */
router.post('/test', requirePlatformAdmin, async (req: Request, res: Response) => {
  try {
    const { tenantId } = resolveScope(req);
    const results = await NotifyService.pushTest(tenantId);
    res.sendSuccess(results, '测试推送完成');
  } catch (error: any) {
    if (error?.message && error.message.startsWith('请先启用')) {
      res.sendBadRequest(error.message);
      return;
    }
    console.error('测试推送失败:', error);
    res.sendServerError('测试推送失败');
  }
});

/**
 * 获取推送记录（最近优先）
 * GET /api/notify/logs?limit=50&offset=0[&tenantId=xxx][&all=true]
 *
 * 租户账号：只看自己的记录
 * 平台管理员：默认看平台级记录；all=true 看全部租户；tenantId=xxx 看指定租户
 */
router.get('/logs', async (req: Request, res: Response) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const { tenantId, crossTenant } = resolveScope(req);
    // 仅平台管理员可以使用 all=true 查看全部租户记录
    const allTenants = crossTenant && String(req.query.all ?? '') === 'true';
    const logs = await NotifyService.listLogs(Number(limit), Number(offset), tenantId, allTenants);
    res.sendSuccess(logs, '获取推送记录成功');
  } catch (error) {
    console.error('获取推送记录失败:', error);
    res.sendServerError('获取推送记录失败');
  }
});

/**
 * 租户列表（平台管理员为租户配置推送时选择目标租户用）
 * GET /api/notify/tenants
 */
router.get('/tenants', async (req: Request, res: Response) => {
  try {
    if (!isPlatformOperator(req.user)) {
      // 租户账号只返回自己，前端无需（也不能）切换租户
      return res.sendSuccess(
        req.user?.tenantId ? [{ tenantId: req.user.tenantId }] : [],
        '获取租户列表成功'
      );
    }
    const rows = await database.query(
      `SELECT DISTINCT tenant_id FROM users WHERE tenant_id IS NOT NULL AND tenant_id <> '' ORDER BY tenant_id`
    );
    const deviceTenants = await database.query(
      `SELECT DISTINCT tenant_id FROM devices WHERE tenant_id IS NOT NULL AND tenant_id <> '' ORDER BY tenant_id`
    );
    const merged = new Set<string>();
    rows.forEach((r: any) => merged.add(String(r.tenant_id)));
    deviceTenants.forEach((r: any) => merged.add(String(r.tenant_id)));
    res.sendSuccess(
      Array.from(merged).sort().map((t) => ({ tenantId: t })),
      '获取租户列表成功'
    );
  } catch (error) {
    console.error('获取租户列表失败:', error);
    res.sendServerError('获取租户列表失败');
  }
});

export default router;
