import { Router, Request, Response } from 'express';
import AlarmService from '../services/alarmService';
const router = Router();

/**
 * 解析时间查询参数（秒级时间戳）
 *  - 未提供 / 空串 → null（表示不限制该端）
 *  - 非数字 / 非有限数 / 负数 → 返回错误提示（调用方回 400）
 */
function parseTimeParam(
  raw: unknown,
  label: string
): { value: number | null; error?: string } {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: null };
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return { value: null, error: `${label} 必须是时间戳数字` };
  }
  if (num < 0) {
    return { value: null, error: `${label} 不能为负数` };
  }
  return { value: Math.floor(num) };
}

/**
 * 当前请求可见的告警归属范围（租户过滤）
 * 平台管理员（无租户）→ null（不过滤，可见全部）；租户用户 → 其租户ID
 */
function alarmScope(user?: { tenantId?: string | null }): string | null {
  return user?.tenantId ?? null;
}

/**
 * 获取告警列表
 * GET /api/alarms?deviceId=xxx&resolved=0&devId=1246001&limit=100&offset=0
 *
 * 子设备筛选参数：`devId`（推荐）—— 按**厂家上报的 devId** 精确过滤。
 * alarms.type 列目前承载的就是厂家 devId（零迁移方案），因此 SQL 上等价于
 * `a.type = ?`；`type` 作为兼容别名继续接受，两者同时给出时以 `devId` 为准。
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      deviceId,
      resolved,
      type,
      devId,
      limit = 100,
      offset = 0,
      startTime,
      endTime,
      search
    } = req.query;

    // 时间参数校验：非法值一律 400，绝不把非法值带进 SQL
    const start = parseTimeParam(startTime, 'startTime');
    if (start.error) return res.sendBadRequest(start.error);
    const end = parseTimeParam(endTime, 'endTime');
    if (end.error) return res.sendBadRequest(end.error);
    if (start.value != null && end.value != null && start.value > end.value) {
      return res.sendBadRequest('开始时间不能晚于结束时间');
    }

    // 列表与总数由同一套条件生成（见 AlarmService.buildAlarmWhere），
    // 关键词搜索、状态、类型、时间、租户隔离全部下推到 SQL
    // 子设备筛选：devId 优先，type 兼容；空串一律视为"全部"
    const subDeviceFilterRaw = (devId ?? type) as unknown;
    const subDeviceFilter = subDeviceFilterRaw != null && String(subDeviceFilterRaw).trim() !== ''
      ? String(subDeviceFilterRaw).trim()
      : undefined;

    const data = await AlarmService.getAlarmsPaged({
      deviceId: deviceId as string | undefined,
      resolved: resolved !== undefined ? Number(resolved) : undefined,
      // 该值就是 alarms.type 里的厂家 devId（见上方说明），不是旧的告警分类
      type: subDeviceFilter as any,
      tenantId: alarmScope(req.user),
      startTime: start.value,
      endTime: end.value,
      search: search != null ? String(search) : null,
      limit: Number(limit),
      offset: Number(offset),
    });

    res.sendSuccess(data, '获取告警列表成功');
  } catch (error) {
    console.error('获取告警列表失败:', error);
    res.sendServerError('获取告警列表失败');
  }
});

/**
 * 告警中心「子设备」筛选选项（**取自设备上报的厂家字典**，不是从告警列表提取）
 * GET /api/alarms/sub-devices
 *
 * 返回：{ options: [{ devId, devName, alarmPointCount }], conflicts: [{ devId, names }] }
 *   - devId       厂家上报的子设备 ID（筛选时原样回传，用于精确过滤）
 *   - devName     厂家字典里的 devName（已去掉末尾 .json），仅作显示
 *   - 即使某子设备当前没有任何告警，它也会出现在 options 里
 *   - conflicts   同一 devId 在不同网关字典里名称不一致时的冲突报告（不静默覆盖）
 *
 * 哪些条目算「功能子设备」由字典数据推导（见 protocols/fsu/dictionary
 * 的 pickFunctionalSubDevices），平台不写死 devId / 名称 / 分类数组。
 *
 * ⚠️ 必须注册在 GET /:id 之前，否则 "sub-devices" 会被当成告警ID。
 */
router.get('/sub-devices', async (req: Request, res: Response) => {
  try {
    const data = await AlarmService.listSubDeviceOptions(alarmScope(req.user));
    res.sendSuccess(data, '获取子设备筛选项成功');
  } catch (error) {
    console.error('获取子设备筛选项失败:', error);
    res.sendServerError('获取子设备筛选项失败');
  }
});

/**
 * 获取告警统计
 * GET /api/alarms/stats
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await AlarmService.getAlarmStats(alarmScope(req.user));
    res.sendSuccess(stats, '获取告警统计成功');
  } catch (error) {
    console.error('获取告警统计失败:', error);
    res.sendServerError('获取告警统计失败');
  }
});

/**
 * 获取告警趋势
 * GET /api/alarms/trend?days=7
 */
router.get('/trend', async (req: Request, res: Response) => {
  try {
    const { days = 7 } = req.query;
    const trend = await AlarmService.getAlarmTrend(Number(days), alarmScope(req.user));
    res.sendSuccess(trend, '获取告警趋势成功');
  } catch (error) {
    console.error('获取告警趋势失败:', error);
    res.sendServerError('获取告警趋势失败');
  }
});

/**
 * 批量删除告警
 * DELETE /api/alarms/batch
 * Body: { ids: [1, 2, 3] }
 */
router.delete('/batch', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.sendBadRequest('ids 不能为空');
    }
    const deleted = await AlarmService.deleteAlarmsBatch(ids, alarmScope(req.user));
    res.sendSuccess({ deleted }, `已删除 ${deleted} 条告警`);
  } catch (error) {
    console.error('批量删除告警失败:', error);
    res.sendServerError('批量删除告警失败');
  }
});

/**
 * 删除单条告警
 * DELETE /api/alarms/:id
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ok = await AlarmService.deleteAlarm(Number(id), alarmScope(req.user));
    if (!ok) {
      return res.sendNotFound('告警不存在');
    }
    res.sendSuccess(null, '告警已删除');
  } catch (error) {
    console.error('删除告警失败:', error);
    res.sendServerError('删除告警失败');
  }
});

/**
 * 获取告警详情
 * GET /api/alarms/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const alarm = await AlarmService.getAlarmById(Number(id), alarmScope(req.user));

    if (!alarm) {
      return res.sendNotFound('告警不存在');
    }

    res.sendSuccess(alarm, '获取告警详情成功');
  } catch (error) {
    console.error('获取告警详情失败:', error);
    res.sendServerError('获取告警详情失败');
  }
});

/**
 * 解决告警
 * PUT /api/alarms/:id/resolve
 */
router.put('/:id/resolve', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await AlarmService.resolveAlarm(Number(id), alarmScope(req.user));

    if (!result) {
      return res.sendNotFound('告警不存在或已被解决');
    }

    res.sendSuccess(null, '告警已解决');
  } catch (error) {
    console.error('解决告警失败:', error);
    res.sendServerError('解决告警失败');
  }
});

export default router;