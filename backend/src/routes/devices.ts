import { Router, Request, Response } from 'express';
import DeviceService from '../services/deviceService';
import DataService from '../services/dataService';
import AlarmService from '../services/alarmService';
import database from '../models/database';
import { requireAdmin, requirePlatformAdmin, isPlatformOperator } from '../middleware/auth';
// 远程功能（重启/OTA）复用厂家协议层已实现的下行能力，不重复实现 MQTT
import { reboot, ota, DownstreamError, codeMessage } from '../protocols/fsu/downstream';
// 平台主动查询/设置（协议 4.5 getData / 4.6 getAlarm / 4.7 setData）同样经由
// protocols/fsu 的既有下行能力，本文件只做权限与响应映射。
import {
  remoteGetData, remoteGetAlarm, remoteSetData, listRemoteMeterOptions,
  RemoteOpError,
} from '../services/remoteService';
// 平台主动校时（协议 4.8，平台→网关）：设备校时配置的读写
import NtpConfigService from '../services/ntpConfigService';
// 子设备通信状态：厂家心跳（协议 4.2）落网关会话，这里只读暴露给前端
import { getSubDeviceCommStatuses, getSession } from '../protocols/fsu/session';
// 功能子设备由厂家字典动态识别（不写死 devId）
import {
  loadMeterDictionary, parseMeterDictionary, pickFunctionalSubDevices,
} from '../protocols/fsu/dictionary';
const router = Router();

/**
 * 远程操作的业务异常 → HTTP 业务响应码映射
 * （RemoteOpError.kind 由业务层给出，路由层只负责翻译）
 */
function sendRemoteError(res: Response, error: any, fallbackMessage: string): void {
  if (error instanceof RemoteOpError) {
    if (error.kind === 'notFound') return res.sendNotFound(error.message);
    if (error.kind === 'server') return res.sendServerError(error.message);
    return res.sendBadRequest(error.message);
  }
  console.error(`${fallbackMessage}:`, error);
  res.sendServerError(fallbackMessage);
}

/**
 * 当前请求可见的设备归属范围（租户过滤）
 * 平台管理员（无租户）→ null（不过滤，可见全部）；租户用户 → 其租户ID
 */
function deviceScope(user?: { tenantId?: string | null }): string | null {
  return user?.tenantId ?? null;
}

/**
 * 站点 id → { name, code } 映射（一次查询，避免逐设备查站点名称）
 */
async function getSiteNameMap(): Promise<Map<number, { name: string; code: string }>> {
  const map = new Map<number, { name: string; code: string }>();
  try {
    const rows = await database.query('SELECT id, name, code FROM sites');
    for (const r of rows) map.set(Number(r.id), { name: r.name, code: r.code });
  } catch {
    // 站点表异常不应影响设备列表主流程
  }
  return map;
}

/**
 * 租户 id → 租户名称 映射（页面展示用 tenants.name，而不是 T0001 这样的内部ID）
 */
async function getTenantNameMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const rows = await database.query('SELECT id, name FROM tenants');
    for (const r of rows) map.set(String(r.id), String(r.name));
  } catch {
    // 租户表异常不应影响设备列表主流程
  }
  return map;
}

/**
 * 为设备补充"归属站点"展示字段（site_name / site_code）
 * 未分配站点时两者均为 null，前端显示"未分配"
 */
function attachSite(device: any, siteMap: Map<number, { name: string; code: string }>): any {
  const site = device.site_id != null ? siteMap.get(Number(device.site_id)) : undefined;
  return {
    ...device,
    site_name: site?.name ?? null,
    site_code: site?.code ?? null,
  };
}

/**
 * 为设备补充"归属租户名称"字段（tenant_name）
 * 设备已归属租户时返回租户名称，未归属时为 null
 */
function attachTenant(device: any, tenantMap: Map<string, string>): any {
  return {
    ...device,
    tenant_name: device.tenant_id ? (tenantMap.get(String(device.tenant_id)) ?? null) : null,
  };
}

/**
 * 解析厂家协议原始电表数据（latest_meters 为 JSON 字符串：
 * { devId: { meterId: value } }），解析失败返回 null
 */
function parseLatestMeters(device: any): Record<string, Record<string, string | number>> | null {
  if (!device.latest_meters) return null;
  try {
    const parsed = JSON.parse(device.latest_meters);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 获取设备列表（包含最新上报数据）
 * GET /api/devices?siteId=<id>|unassigned
 *
 * siteId 筛选（可选）：
 *  - 不传        → 全部设备
 *  - unassigned  → 仅未归属站点的设备
 *  - <数字>      → 仅该站点下的设备
 * 租户隔离始终生效：先按登录态限定租户，再叠加站点筛选。
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    let devices = await DeviceService.getAllDevices(deviceScope(req.user));

    const siteIdRaw = String(req.query.siteId ?? '').trim();
    if (siteIdRaw) {
      if (siteIdRaw === 'unassigned') {
        devices = devices.filter((d: any) => d.site_id == null);
      } else {
        const siteId = Number(siteIdRaw);
        devices = Number.isInteger(siteId)
          ? devices.filter((d: any) => Number(d.site_id) === siteId)
          : [];
      }
    }

    const [siteMap, tenantMap] = await Promise.all([getSiteNameMap(), getTenantNameMap()]);

    // 为每个设备添加最新属性和告警状态
    const devicesWithDetails = await Promise.all(
      devices.map(async (device: any) => {
        // 获取未解决告警数量
        const unresolvedAlarms = await AlarmService.getAlarms(
          device.id,
          0,
          undefined,
          1
        );

        return {
          ...attachSite(attachTenant(device, tenantMap), siteMap),
          latestMeters: parseLatestMeters(device),
          hasAlarm: unresolvedAlarms.length > 0,
          alarmCount: unresolvedAlarms.length
        };
      })
    );

    res.sendSuccess(devicesWithDetails, '获取设备列表成功');
  } catch (error) {
    console.error('获取设备列表失败:', error);
    res.sendServerError('获取设备列表失败');
  }
});

/**
 * 获取设备详情
 * GET /api/devices/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // 归属校验：非本租户设备一律 404（不暴露存在性）
    const device = await DeviceService.getDeviceById(id, deviceScope(req.user));

    if (!device) {
      return res.sendNotFound('设备不存在');
    }

    // 获取设备未解决告警数量
    const unresolvedAlarms = await AlarmService.getAlarms(id, 0);
    const [siteMap, tenantMap] = await Promise.all([getSiteNameMap(), getTenantNameMap()]);
    const deviceWithAlarm = {
      ...attachSite(attachTenant(device, tenantMap), siteMap),
      // 从 devices 表读取最新状态（不会被事件上报稀疏数据覆盖）
      latestMeters: parseLatestMeters(device),
      hasAlarm: unresolvedAlarms.length > 0,
      alarmCount: unresolvedAlarms.length
    };

    res.sendSuccess(deviceWithAlarm, '获取设备详情成功');
  } catch (error) {
    console.error('获取设备详情失败:', error);
    res.sendServerError('获取设备详情失败');
  }
});

/**
 * 厂家 FSU 原始历史数据（正式数据源：fsu_data_history）
 * GET /api/devices/:id/fsu-history?devId=&meterId=&start=&end=&limit=
 *
 * - devId / meterId 可省略（省略=该网关全部点），支持逗号分隔或多值
 * - 不传 start/end 时默认最近 24 小时（与旧 history 接口一致），毫秒时间戳
 * - limit 默认 1000、上限 5000，防止一次拉全库
 * - 按 data_timestamp 升序返回
 * - 权限/租户隔离复用既有 deviceScope：不可见设备一律 404，无法通过参数绕过
 * - 只返回协议原始点（devId/meterId/value/dataTimestamp/isHistory），
 *   **不返回任何旧物模型字段**
 */
router.get('/:id/fsu-history', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const device = await DeviceService.getDeviceById(id, deviceScope(req.user));
    if (!device) return res.sendNotFound('设备不存在');

    const { start, end, devId, meterId, limit } = req.query;
    const endTime = end !== undefined ? Number(end) : Date.now();
    const startTime = start !== undefined ? Number(start) : endTime - 24 * 60 * 60 * 1000;
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime) {
      return res.sendBadRequest('时间范围不合法');
    }

    const LIMIT_DEFAULT = 1000;
    const LIMIT_MAX = 5000;
    let lim = Number(limit);
    if (!Number.isFinite(lim) || lim <= 0) lim = LIMIT_DEFAULT;
    lim = Math.min(Math.floor(lim), LIMIT_MAX);

    const toList = (v: any): string[] | undefined => {
      if (v === undefined || v === null) return undefined;
      const arr = Array.isArray(v) ? v : String(v).split(',');
      const out = arr.map((x) => String(x).trim()).filter(Boolean);
      return out.length ? out : undefined;
    };

    const rows = await DataService.getFsuHistory({
      deviceId: id,
      devIds: toList(devId),
      meterIds: toList(meterId),
      startTime,
      endTime,
      limit: lim,
    });
    res.sendSuccess(rows, '获取厂家 FSU 历史数据成功');
  } catch (error) {
    console.error('获取厂家 FSU 历史数据失败:', error);
    res.sendServerError('获取厂家 FSU 历史数据失败');
  }
});

/**
 * 功能子设备的通信状态（只读）
 * GET /api/devices/:id/sub-device-comm-status
 *
 * **唯一数据来源**：厂家心跳报文 gw/v1/heartbeat 的 params.online / params.offline
 * （协议 4.2「在线设备列表 / 离线设备列表」，协议说明其用途是
 *  "网关与平台保持在线状态一致"）。
 *
 * 不使用以下任何推断方式：MQTT 网关连接状态、最后上报时间、是否存在告警、
 * 监控点值（meterId=0 的取值）、平台自设的心跳超时阈值。
 *
 * 子设备范围：由厂家字典经 pickFunctionalSubDevices() **动态识别**
 * （自动排除网关自身「设备信息」条目），不写死任何 devId。
 *
 * 返回：
 *   {
 *     deviceId,
 *     lastHeartbeatAt: number|null,
 *     subDevices: [{ devId, devName, status: 'online'|'offline'|'unknown', lastHeartbeatAt }]
 *   }
 * status 为 unknown 的情形：devId 不在两个列表里 / 同时出现在两个列表 /
 * 尚未收到有效心跳（含后端重启后）。本接口不臆造在线或离线。
 *
 * 权限：与查看设备详情一致（只读、租户隔离）。
 */
router.get('/:id/sub-device-comm-status', async (req: Request, res: Response) => {
  try {
    const device = await DeviceService.getDeviceById(req.params.id, deviceScope(req.user));
    if (!device) return res.sendNotFound('设备不存在');

    const deviceId = String(device.id);
    // 功能子设备：来自厂家 uploadDevInfo 字典，动态识别、不写死
    const entries = parseMeterDictionary(await loadMeterDictionary(deviceId));
    let subDevices = pickFunctionalSubDevices(entries).map((o) => ({
      devId: o.devId,
      devName: o.devName,
    }));

    // 字典尚未上报时的兜底：只返回心跳里实际出现过的 devId（devName 未知）。
    // 不据此臆造"功能子设备"，仅保证图标在字典到达前也能反映厂家上报。
    if (subDevices.length === 0) {
      const s = getSession(deviceId);
      subDevices = Array.from(new Set([...(s?.online ?? []), ...(s?.offline ?? [])]))
        .map((devId) => ({ devId, devName: null }));
    }

    const result = getSubDeviceCommStatuses(deviceId, subDevices);
    res.sendSuccess({ deviceId, ...result }, '获取子设备通信状态成功');
  } catch (error) {
    console.error('获取子设备通信状态失败:', error);
    res.sendServerError('获取子设备通信状态失败');
  }
});

/**
 * 创建新设备（仅管理员；普通用户无权建设备）
 * POST /api/devices
 * Body: { id: "FSU001", productId?: string, name?: string, imei?: string, iccid?: string, mqttPassword?: string, tenantId?: string }
 * 注：MQTT 已改为全设备统一账号认证，mqttPassword 字段为历史遗留，不参与认证
 * 归属租户：平台管理员可指定 tenantId（不指定=未分配，仅平台可见）；租户管理员强制本租户
 */
router.post('/', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id, productId, name, imei, iccid, mqttPassword, tenantId } = req.body;

    if (!id) {
      return res.sendBadRequest('设备ID不能为空');
    }

    const existing = await DeviceService.getDeviceById(id);
    if (existing) {
      return res.sendBadRequest(`设备 ${id} 已存在`);
    }

    const targetTenant = isPlatformOperator(req.user)
      ? (tenantId != null && tenantId !== '' ? String(tenantId) : null)
      : (req.user?.tenantId ?? null);
    const credentials = await DeviceService.createDevice(
      id, productId || '', name, imei, iccid, undefined, undefined, undefined, mqttPassword, targetTenant
    );
    res.sendSuccess({ id, tenantId: targetTenant, ...credentials }, '设备添加成功');
  } catch (error: any) {
    console.error('创建设备失败:', error);
    if (error.message && error.message.includes('已存在')) {
      return res.sendBadRequest(error.message);
    }
    res.sendServerError('创建设备失败');
  }
});

/** 批量删除的设备数量上限（防止一次提交异常超大量数据） */
const BATCH_DELETE_MAX = 200;

/**
 * 批量删除设备（仅管理员）
 * DELETE /api/devices/batch   Body: { ids: string[] }
 *
 * 权限：与单删完全一致 —— requireAdmin + 设备必须在当前账号可见范围内
 *       （平台管理员可见全部；租户管理员仅本租户），不因批量而放宽。
 *
 * 语义（与单删保持一致，不新造规则）：
 *   先校验**全部**目标设备都存在且可见 → 全部合法才执行删除；
 *   任一不存在/不可见则整体拒绝，不做部分删除。
 *
 * 注意：本路由必须注册在 DELETE /:id 之前，否则 "batch" 会被当成设备ID。
 */
router.delete('/batch', requireAdmin, async (req: Request, res: Response) => {
  try {
    const raw = (req.body || {}).ids;

    if (!Array.isArray(raw)) {
      return res.sendBadRequest('ids 必须为数组');
    }
    // 逐项校验为有效字符串 → 去重（保持原顺序）
    const ids = Array.from(
      new Set(raw.map((v: any) => String(v ?? '').trim()).filter((s) => s.length > 0))
    );
    if (ids.length === 0) {
      return res.sendBadRequest('请选择要删除的设备');
    }
    if (ids.length > BATCH_DELETE_MAX) {
      return res.sendBadRequest(`一次最多删除 ${BATCH_DELETE_MAX} 台设备`);
    }

    // 先校验全部目标设备（存在 + 在可见范围内），避免部分删除
    const missing: string[] = [];
    for (const id of ids) {
      const device = await DeviceService.getDeviceById(id, deviceScope(req.user));
      if (!device) missing.push(id);
    }
    if (missing.length > 0) {
      return res.sendNotFound(`设备不存在：${missing.join('、')}`);
    }

    const result = await DeviceService.deleteDevicesBatch(ids, deviceScope(req.user));
    if (result.deleted !== ids.length) {
      // 事务已提交但数量对不上：属于异常情况，如实告知而不是谎报成功
      console.error(`批量删除设备数量不符: 目标 ${ids.length} 台，实际 ${result.deleted} 台`);
      return res.sendServerError(`部分设备未删除（目标 ${ids.length} 台，实际 ${result.deleted} 台）`);
    }
    res.sendSuccess({ deleted: result.deleted }, `成功删除 ${result.deleted} 台设备`);
  } catch (error) {
    console.error('批量删除设备失败:', error);
    res.sendServerError('批量删除设备失败');
  }
});

/**
 * 删除设备（仅管理员；非本租户设备一律 404）
 * DELETE /api/devices/:id
 */
router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // 归属校验：非本租户设备视为不存在（不暴露其他租户设备存在性）
    const device = await DeviceService.getDeviceById(id, deviceScope(req.user));
    if (!device) {
      return res.sendNotFound('设备不存在');
    }
    const deleted = await DeviceService.deleteDevice(id, deviceScope(req.user));
    if (!deleted) {
      return res.sendNotFound('设备不存在');
    }
    console.log(`设备已删除: ${id}`);
    res.sendSuccess(null, '设备已删除');
  } catch (error) {
    console.error('删除设备失败:', error);
    res.sendServerError('删除设备失败');
  }
});

/**
 * 更新设备信息
 * PUT /api/devices/:id
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const device = await DeviceService.getDeviceById(id, deviceScope(req.user));
    if (!device) {
      return res.sendNotFound('设备不存在');
    }
    const { imei, iccid, manufacturer, terminalType, name } = req.body;
    await DeviceService.upsertDevice(id, device.product_id, Date.now(), device.status, {
      imei: imei ?? device.imei,
      iccid: iccid ?? device.iccid,
      manufacturer: manufacturer ?? device.manufacturer,
      terminalType: terminalType ?? device.terminalType,
    });
    // 设备名称：详情页"编辑"唯一允许修改的字段（为空则置 NULL，前端显示 "-"）
    if (name !== undefined) {
      if (name !== null && String(name).length > 128) {
        return res.sendBadRequest('设备名称不能超过128个字符');
      }
      await DeviceService.updateDeviceName(id, name === null ? null : String(name));
    }
    res.sendSuccess(null, '更新设备信息成功');
  } catch (error) {
    console.error('更新设备信息失败:', error);
    res.sendServerError('更新设备信息失败');
  }
});

/**
 * 远程重启网关（厂家协议 4.9）
 * POST /api/devices/:id/reboot  { type: 1|2|3|4 }  1-sys 2-app 3-4g 4-vpn
 *
 * 复用 protocols/fsu 的下行能力（topic sc/v1/reboot/{gwId}），不重新实现 MQTT。
 * 权限与"删除设备"一致：requireAdmin；且设备必须在当前账号可见范围内。
 */
router.post('/:id/reboot', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const device = await DeviceService.getDeviceById(id, deviceScope(req.user));
    if (!device) return res.sendNotFound('设备不存在');

    const type = Number(req.body?.type ?? 1);
    if (![1, 2, 3, 4].includes(type)) {
      return res.sendBadRequest('重启类型不合法（1-sys 2-app 3-4g 4-vpn）');
    }
    const ack = await reboot(id, type);
    if (ack.code !== 0) {
      return res.sendBadRequest(`网关返回失败：${codeMessage(ack.code, ack.msg)}`);
    }
    console.log(`[远程功能] 重启网关成功: ${id}, type=${type}`);
    res.sendSuccess({ code: ack.code }, '重启指令已下发');
  } catch (error: any) {
    if (error instanceof DownstreamError) {
      return res.sendBadRequest(`下发失败：${codeMessage(error.code, error.message)}`);
    }
    console.error('重启网关失败:', error);
    res.sendServerError('重启网关失败');
  }
});

/**
 * OTA 升级（厂家协议 4.10）
 * POST /api/devices/:id/ota  { urls: string[] }（也接受 url: string）
 *
 * 复用 protocols/fsu 的下行能力（topic sc/v1/ota/{gwId}，报文体 method="OTA"）。
 * 本轮只做协议下发，不实现 OTA 文件服务器。
 * 权限与"删除设备"一致：requireAdmin；且设备必须在当前账号可见范围内。
 */
router.post('/:id/ota', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const device = await DeviceService.getDeviceById(id, deviceScope(req.user));
    if (!device) return res.sendNotFound('设备不存在');

    const raw = req.body?.urls ?? req.body?.url;
    const urls = (Array.isArray(raw) ? raw : raw != null ? [raw] : [])
      .map((u: any) => String(u).trim())
      .filter(Boolean);
    if (urls.length === 0) return res.sendBadRequest('请提供固件下载地址');
    if (urls.some((u: string) => !/^https?:\/\//i.test(u))) {
      return res.sendBadRequest('固件地址必须是 http/https 链接');
    }
    const ack = await ota(id, urls);
    if (ack.code !== 0) {
      return res.sendBadRequest(`网关返回失败：${codeMessage(ack.code, ack.msg)}`);
    }
    console.log(`[远程功能] OTA 下发成功: ${id}, 文件数=${urls.length}`);
    res.sendSuccess({ code: ack.code }, 'OTA 升级指令已下发');
  } catch (error: any) {
    if (error instanceof DownstreamError) {
      return res.sendBadRequest(`下发失败：${codeMessage(error.code, error.message)}`);
    }
    console.error('OTA 下发失败:', error);
    res.sendServerError('OTA 下发失败');
  }
});

/**
 * 平台主动获取实时数据（厂家协议 4.5 getData）
 * POST /api/devices/:id/remote/get-data   Body: { devIds?: string[] }
 *
 * 语义：
 *   - devIds 缺省或为空数组 = 请求该网关**全部**子设备（协议 4.5：不携带 params）
 *   - 网关响应经既有 request id 关联后，实时数据**回写 devices.latest_meters**
 *     （与 dataReport 同一份存储、同一套 mergeMeters 合并语义），
 *     因此前端拿到响应后重新读取设备详情即可看到最新实时数据。
 *
 * 权限：与「查看设备详情」一致（登录 + 设备在当前账号可见范围内），
 *       只读操作，不需要管理员。
 */
router.post('/:id/remote/get-data', async (req: Request, res: Response) => {
  try {
    const result = await remoteGetData(req.params.id, deviceScope(req.user), req.body?.devIds);
    if (result.code !== 0) {
      return res.sendBadRequest(`网关返回失败：${result.msg}（code=${result.code}）`);
    }
    res.sendSuccess(result, '实时数据已刷新');
  } catch (error: any) {
    sendRemoteError(res, error, '获取实时数据失败');
  }
});

// ============================================================
// 平台主动校时配置（协议 4.8，平台→网关）
// ============================================================

/**
 * 读取设备校时配置
 * GET /api/devices/:id/ntp-config
 *
 * 返回：是否启用定时校时、间隔、最近一次校时时间/类型、下一次计划校时时间。
 * 权限：与「查看设备详情」一致（登录 + 设备在当前账号可见范围内）。
 */
router.get('/:id/ntp-config', async (req: Request, res: Response) => {
  try {
    const device = await DeviceService.getDeviceById(req.params.id, deviceScope(req.user));
    if (!device) return res.sendNotFound('设备不存在');
    res.sendSuccess(NtpConfigService.view(device), '获取校时配置成功');
  } catch (error) {
    console.error('获取校时配置失败:', error);
    res.sendServerError('获取校时配置失败');
  }
});

/**
 * 保存设备校时配置
 * PUT /api/devices/:id/ntp-config   Body: { enabled?: boolean, intervalHours?: number }
 *
 * 校验：intervalHours 只允许 1 / 6 / 12 / 24 / 48；enabled 必须是布尔值。
 * 生效：写库后立即持久化；修改间隔会同时重算"下一次计划时间"，无需重启后端。
 * 权限：写操作，与「远程重启 / OTA」一致（requireAdmin + 设备可见范围）。
 */
router.put('/:id/ntp-config', requireAdmin, async (req: Request, res: Response) => {
  try {
    const device = await DeviceService.getDeviceById(req.params.id, deviceScope(req.user));
    if (!device) return res.sendNotFound('设备不存在');

    const result = await NtpConfigService.update(req.params.id, {
      enabled: req.body?.enabled,
      intervalHours: req.body?.intervalHours,
    });
    if (!result.ok) return res.sendBadRequest(result.reason || '保存校时配置失败');

    console.log(
      `[FSU][校时] 配置更新: gwId=${req.params.id}, enabled=${result.view!.enabled}, interval=${result.view!.intervalHours}h`
    );
    res.sendSuccess(result.view, '校时配置已保存');
  } catch (error) {
    console.error('保存校时配置失败:', error);
    res.sendServerError('保存校时配置失败');
  }
});

router.post('/:id/remote/get-alarm', async (req: Request, res: Response) => {
  try {
    const result = await remoteGetAlarm(req.params.id, deviceScope(req.user), req.body?.devIds);
    if (result.code !== 0) {
      return res.sendBadRequest(`网关返回失败：${result.msg}（code=${result.code}）`);
    }
    res.sendSuccess(result, '实时告警已刷新');
  } catch (error: any) {
    sendRemoteError(res, error, '获取实时告警失败');
  }
});

/**
 * 平台设置数据（厂家协议 4.7 setData）
 * POST /api/devices/:id/remote/set-data
 * Body: { items: [{ devId, meterId, value }] }   value 必须是字符串
 *
 * 权限：写操作，与「远程重启 / OTA」保持一致（requireAdmin + 设备可见范围）。
 *
 * ⚠️ 网关返回 code=0 只代表**指令已被网关受理**，不代表设备侧已经设置完成。
 *    需要确认实际值时，调用方应在成功后再调用 get-data 读取真实值。
 */
router.post('/:id/remote/set-data', requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await remoteSetData(req.params.id, deviceScope(req.user), req.body?.items);
    if (result.code !== 0) {
      return res.sendBadRequest(`网关返回失败：${result.msg}（code=${result.code}）`);
    }
    res.sendSuccess(result, '设置指令已下发');
  } catch (error: any) {
    sendRemoteError(res, error, '设置数据失败');
  }
});

/**
 * 「远程设置」候选点位（来自厂家 uploadDevInfo 字典 device_meters）
 * GET /api/devices/:id/remote/meter-options
 *
 * 只读平台字典：不查网关、不下发 MQTT，因此对离线设备也可用
 * （前端打开设置弹窗时用它渲染 devId / meterId 下拉，不让用户手工拼点位）。
 * 权限：与「查看设备详情」一致（只读）。
 */
router.get('/:id/remote/meter-options', async (req: Request, res: Response) => {
  try {
    const device = await DeviceService.getDeviceById(req.params.id, deviceScope(req.user));
    if (!device) return res.sendNotFound('设备不存在');
    const result = await listRemoteMeterOptions(String(device.id));
    res.sendSuccess(result, '获取点位列表成功');
  } catch (error) {
    console.error('获取远程设置点位失败:', error);
    res.sendServerError('获取远程设置点位失败');
  }
});

/**
 * 修改设备归属租户（仅平台管理员，用于给存量设备分配客户）
 * PUT /api/devices/:id/tenant  { tenantId?: string }
 *
 * tenantId 传空/缺省 = 取消分配（设备变未分配，仅平台管理员可见）；
 * 非空时校验租户存在——**校验的是 tenants 表**（正式租户实体）。
 *
 * 注意：一个租户只有一个【账号】，但可以有多个【设备】。
 * 因此这里**不能**用"该租户是否有用户"来判断租户是否可用，
 * 否则未绑定账号的租户就无法被分配设备。
 */
router.put('/:id/tenant', requirePlatformAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const device = await DeviceService.getDeviceById(id);
    if (!device) {
      return res.sendNotFound('设备不存在');
    }

    const { tenantId } = req.body || {};
    const targetTenant = tenantId != null && String(tenantId).trim() !== ''
      ? String(tenantId).trim()
      : null;

    if (targetTenant) {
      const tenant = await database.get('SELECT id, name FROM tenants WHERE id = ?', [targetTenant]);
      if (!tenant) {
        return res.sendBadRequest('所选租户不存在，请先在「租户管理」中创建');
      }
    }

    const updated = await DeviceService.setDeviceTenant(id, targetTenant);
    if (!updated) {
      return res.sendNotFound('设备不存在');
    }
    console.log(`设备归属变更: ${id} -> ${targetTenant ?? '未分配'}`);
    res.sendSuccess({ id, tenantId: targetTenant }, '设备归属更新成功');
  } catch (error) {
    console.error('修改设备租户失败:', error);
    res.sendServerError('修改设备租户失败');
  }
});

export default router;