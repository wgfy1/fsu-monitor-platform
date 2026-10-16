/**
 * 平台主动远程操作（厂家协议 4.5 getData / 4.6 getAlarm / 4.7 setData）
 *
 * 分层职责：
 *   本文件 = 业务编排（设备归属校验 → 在线校验 → 调协议层 → 结果处理）
 *   protocols/fsu = 协议事实（topic、报文字段、request/response 关联、响应解码）
 *   本文件**不自己拼 MQTT 报文**，全部经由 protocols/fsu 的既有下行能力，
 *   因此与远程重启 / OTA 共用同一套下发与 id 关联机制（没有第二套下行链路）。
 *
 * 平台设备ID = 厂家 gwId（项目既有规则：devices.id 就是规范化后的网关 MAC，
 * 见 protocols/fsu/handlers.ts 对 login 的处理），因此这里不再做二次映射。
 */
import DeviceService from './deviceService';
import { Device } from '../types';
import {
  getData, getAlarm, setData as downstreamSetData,
  decodeGetDataResponse, decodeGetAlarmResponse, ackMessage, codeMessage,
  DownstreamError, SET_DATA_MAX_ITEMS, GET_DATA_MAX_DEV_IDS,
  FsuAck, SetDataItem, GetDataDevice, GetAlarmDevice,
} from '../protocols/fsu';
import {
  mergeMeters, metersByDevFromGetData, findMeterName, findDevName, MetersByDev,
} from '../protocols/fsu/mapping';
import { getSession } from '../protocols/fsu/session';
import { loadMeterDictionary } from '../protocols/fsu/dictionary';

/** 远程操作失败类型（路由据此映射为 400 / 404 / 500） */
export type RemoteFailKind = 'badRequest' | 'notFound' | 'server';

/** 远程操作业务异常（消息直接面向使用者，含明确失败原因） */
export class RemoteOpError extends Error {
  constructor(message: string, public readonly kind: RemoteFailKind = 'badRequest') {
    super(message);
    this.name = 'RemoteOpError';
  }
}

/** 字典里查不到的点（诊断信息，回给调用方而不是静默丢弃） */
export interface UnknownPoint {
  devId: string;
  meterId: string;
}

/** 远程操作通用结果信封 */
export interface RemoteResult {
  deviceId: string;
  /** 厂家 gwId（当前等于 deviceId，显式返回便于核对） */
  gwId: string;
  /** 网关返回的协议错误码（0=成功） */
  code: number;
  /** 网关返回的提示文案 */
  msg: string;
  /** 平台侧请求 id（排查用；与响应中的 id 一致才说明关联正确） */
  requestId: string;
}

/** 4.5 getData 的业务结果 */
export interface RemoteGetDataResult extends RemoteResult {
  /** 网关返回的实时数据（已结构归一化） */
  devices: GetDataDevice[];
  /** 回写后的完整实时快照（devices.latest_meters，与页面展示同源） */
  latestMeters: MetersByDev | null;
  /** 厂家字典（device_meters）中查不到的点；正常为空数组 */
  unknownPoints: UnknownPoint[];
  /** 是否成功回写实时快照 */
  applied: boolean;
}

/** 4.6 getAlarm 的业务结果（**仅查询结果**，不写平台 alarms 表，理由见下） */
export interface RemoteGetAlarmResult extends RemoteResult {
  /**
   * 网关返回的实时告警。
   * meterName/devName 来自厂家 uploadDevInfo 字典（查不到为 null，不臆造名称）。
   */
  alarms: Array<{
    devId: string;
    devName: string | null;
    meterId: string;
    /** 协议 4.6：alarmTime 为**秒级**时间戳 */
    alarmTime: number;
    /** 同上，换算为毫秒（前端展示用；未做任何时区加工） */
    alarmTimeMs: number;
    meterName: string | null;
  }>;
  /** 告警点总数 */
  total: number;
  /**
   * 恒为 false：本轮**不**把查询结果写入平台 alarms 表。
   *
   * 原因（这是刻意的设计选择，不是漏实现）：
   *   1) 协议 4.6 的响应只有 (devId, meterId, alarmTime)，**没有 serialNo、没有 alarmLevel**；
   *      而平台既有去重/消除完全依赖 alarmReport 的 serialNo（AlarmService.findUnresolvedBySerialNo）。
   *      用它建告警会无法与 alarmReport 的告警对齐 → 必然产生重复告警。
   *   2) 平台告警链路的唯一数据源是"网关主动 alarmReport"，写入口在 handlers.handleAlarmReport
   *      → AlarmService.createAlarm → NotifyService 推送；多一个写入口会破坏该链路的语义
   *      （把"平台查询到的状态"混进"设备上报的告警事件"）。
   *   3) 用户要求："不得破坏目前 alarmReport → alarms → AlarmNotify 的现有链路"。
   * 因此这里只把网关的实时告警**如实返回给前端展示**，与平台告警记录明确区分。
   */
  synced: false;
}

/** 4.7 setData 的业务结果 */
export interface RemoteSetDataResult extends RemoteResult {
  /** 实际下发的设置项（value 均为 string，与发出去的报文一致） */
  items: SetDataItem[];
}

// ============================================================
// 校验工具
// ============================================================

/** devId / meterId 格式：非空、≤64 字符、不含空白与斜杠（指标识符，不做过度限制） */
const ID_PATTERN = /^[^\s/\\]{1,64}$/;

function isValidIdentifier(v: string): boolean {
  return ID_PATTERN.test(v);
}

/**
 * 归一化 devId 列表（协议 4.5/4.6：不携带 params 或为空 = 全部设备）
 * @returns 去重后的 devId 列表；空 → undefined（表示"全部"，调用方不下发 params）
 */
function normalizeDevIds(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const arr = Array.isArray(raw) ? raw : [raw];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s) continue;
    if (!isValidIdentifier(s)) {
      throw new RemoteOpError(`devId 格式不合法：${s}（不能包含空白或斜杠，最长 64 字符）`);
    }
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  if (out.length === 0) return undefined;   // 空数组 = 全部设备（协议语义）
  if (out.length > GET_DATA_MAX_DEV_IDS) {
    throw new RemoteOpError(`一次最多查询 ${GET_DATA_MAX_DEV_IDS} 个 devId`);
  }
  return out;
}

/**
 * 取设备并校验其可下发（存在 + 在当前账号可见范围内 + 在线）
 *
 * 在线判定用 devices.status —— 它是平台的权威在线状态：
 * Broker 连接/断开、login、heartbeat、dataReport 都会更新它；
 * 会话表（protocols/fsu/session）只作为日志里的补充信息：
 * 平台重启后会话是空的，此时网关可能已重连上来，不能据此拒绝下发。
 */
async function resolveOnlineDevice(
  deviceId: string,
  tenantId?: string | null,
): Promise<Device> {
  const device = await DeviceService.getDeviceById(deviceId, tenantId ?? null);
  if (!device) {
    // 不暴露其他租户设备是否存在：越权与不存在一律按"设备不存在"处理
    throw new RemoteOpError('设备不存在', 'notFound');
  }
  if (device.status !== 'online') {
    throw new RemoteOpError(
      `设备当前离线（设备ID ${device.id}），无法下发远程指令`
    );
  }
  return device;
}

/** 网关应答的提示文案（顶层 msg 优先，兼容 setData 的 data.msg） */
function resolveAckMsg(ack: FsuAck): string {
  return ackMessage(ack) || codeMessage(ack.code);
}

/** 下行失败（超时/通道未就绪等）统一转换为带明确原因的 RemoteOpError */
function toRemoteError(err: unknown, action: string): RemoteOpError {
  if (err instanceof DownstreamError) {
    return new RemoteOpError(`${action}失败：${codeMessage(err.code, err.message)}`);
  }
  if (err instanceof RemoteOpError) return err;
  const detail = (err as Error)?.message || String(err);
  console.error(`[远程功能] ${action}异常:`, err);
  return new RemoteOpError(`${action}失败：${detail}`, 'server');
}

// ============================================================
// 4.5 getData
// ============================================================

/** 读取设备已有的实时快照（增量合并用；与 dataReport 走同一份存储） */
async function loadExistingMeters(deviceId: string): Promise<MetersByDev | null> {
  const device: any = await DeviceService.getDeviceById(deviceId);
  if (!device?.latest_meters) return null;
  try {
    const parsed = JSON.parse(device.latest_meters);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 找出不在厂家字典（device_meters）里的 devId / meterId
 *
 * 只在**有字典**时才有判断依据：没有字典（网关还没发过 uploadDevInfo）时
 * 无法区分"陌生点"与"字典缺失"，此时返回空数组（不误报）。
 */
async function findUnknownPoints(gwId: string, incoming: MetersByDev): Promise<UnknownPoint[]> {
  const dictJson = await loadMeterDictionary(gwId);
  if (!dictJson) return [];

  const known = new Map<string, Set<string>>();
  try {
    const list = JSON.parse(dictJson);
    if (!Array.isArray(list)) return [];
    for (const d of list) {
      const devId = d?.devId != null ? String(d.devId) : '';
      if (!devId) continue;
      const set = new Set<string>();
      for (const m of Array.isArray(d?.meters) ? d.meters : []) {
        if (m?.meterId != null) set.add(String(m.meterId));
      }
      known.set(devId, set);
    }
  } catch {
    return [];   // 字典 JSON 坏了：不据此拒绝数据，交由字典读取方各自的容错处理
  }

  const unknown: UnknownPoint[] = [];
  for (const [devId, meters] of Object.entries(incoming)) {
    const meterSet = known.get(devId);
    if (!meterSet) {
      for (const meterId of Object.keys(meters)) unknown.push({ devId, meterId });
      continue;
    }
    for (const meterId of Object.keys(meters)) {
      if (!meterSet.has(meterId)) unknown.push({ devId, meterId });
    }
  }
  return unknown;
}

/**
 * 4.5 获取实时数据（平台主动下发，网关响应后回写实时快照）
 *
 * @param deviceId 平台设备ID（= 厂家 gwId）
 * @param tenantId 租户范围：传入时设备必须属于该租户；平台管理员传 null
 * @param devIds   子设备列表；空/缺省 = 查询该网关全部设备（协议 4.5，不下发 params）
 */
export async function remoteGetData(
  deviceId: string,
  tenantId: string | null | undefined,
  devIds?: unknown,
): Promise<RemoteGetDataResult> {
  const device = await resolveOnlineDevice(deviceId, tenantId);
  const gwId = String(device.id);
  const list = normalizeDevIds(devIds);

  if (!getSession(gwId)) {
    console.warn(
      `[远程功能] getData: gwId=${gwId} 无平台登录会话（设备状态为在线，按已连接处理）`
    );
  }

  let ack: FsuAck;
  try {
    ack = await getData(gwId, list);
  } catch (err) {
    throw toRemoteError(err, '获取实时数据');
  }

  const base: RemoteResult = {
    deviceId,
    gwId,
    code: ack.code,
    msg: resolveAckMsg(ack),
    requestId: String(ack.id),
  };

  if (ack.code !== 0) {
    // 网关明确拒绝：如实透传错误码与文案，不回写任何数据
    return {
      ...base, devices: [], latestMeters: null, unknownPoints: [], applied: false,
    };
  }

  const payload = decodeGetDataResponse(ack);
  if (payload.skipped > 0) {
    console.warn(
      `[远程功能] getData 响应存在结构非法条目: gwId=${gwId}, 跳过 ${payload.skipped} 条`
    );
  }

  // === 回写实时快照：复用 dataReport 的同一份存储与合并语义 ===
  // 协议 4.5 响应**没有 isFull 字段**（4.3 dataReport 才有），因此这里一律按
  // **增量合并**处理：只覆盖本次实际返回的点，未返回的点保留原值。
  // 这样网关少返回几个点时不会把已有实时数据抹掉；代价是网关已删除的点不会被剔除。
  const incoming = metersByDevFromGetData(payload.devices);
  const unknownPoints = await findUnknownPoints(gwId, incoming);
  if (unknownPoints.length > 0) {
    // 明确留痕（不静默）：陌生点仍按项目既有设计原样保存在 latest_meters 中，
    // 字典只用于命名与展示，不参与"是否落库"的判断；**绝不因陌生 devId 造设备行**。
    console.warn(
      `[远程功能] getData 返回厂家字典中不存在的点: gwId=${gwId}, ` +
      `共 ${unknownPoints.length} 个 → ${unknownPoints
        .slice(0, 20)
        .map((p) => `${p.devId}/${p.meterId}`)
        .join(', ')}${unknownPoints.length > 20 ? ' ...' : ''}`
    );
  }

  let applied = false;
  let latestMeters: MetersByDev | null = null;
  try {
    const existing = await loadExistingMeters(deviceId);
    const merged = mergeMeters(existing, incoming, {});   // fullByDev 为空 → 全部增量合并
    applied = await DeviceService.updateLatestMeters(deviceId, JSON.stringify(merged));
    if (applied) {
      latestMeters = merged;
      console.log(
        `[远程功能] getData 成功: gwId=${gwId}, 子设备 ${Object.keys(incoming).length} 个, ` +
        `点 ${Object.values(incoming).reduce((n, m) => n + Object.keys(m).length, 0)} 个 (已回写实时快照)`
      );
    } else {
      console.error(`[远程功能] getData 实时快照回写失败（设备不存在）: ${deviceId}`);
    }
  } catch (err) {
    // 回写失败不影响把网关返回的数据交给前端展示，但必须留痕
    console.error(`[远程功能] getData 实时快照回写异常: gwId=${gwId}`, err);
  }

  return { ...base, devices: payload.devices, latestMeters, unknownPoints, applied };
}

// ============================================================
// 4.6 getAlarm
// ============================================================

/**
 * 4.6 获取实时告警（平台主动下发，网关响应后**仅返回查询结果**）
 *
 * 不写平台 alarms 表：见 RemoteGetAlarmResult.synced 的说明
 * （响应缺 serialNo，写入会与 alarmReport 链路产生重复告警）。
 *
 * @param devIds 子设备列表；空/缺省 = 查询该网关全部设备（协议 4.6，不下发 params）
 */
export async function remoteGetAlarm(
  deviceId: string,
  tenantId: string | null | undefined,
  devIds?: unknown,
): Promise<RemoteGetAlarmResult> {
  const device = await resolveOnlineDevice(deviceId, tenantId);
  const gwId = String(device.id);
  const list = normalizeDevIds(devIds);

  let ack: FsuAck;
  try {
    ack = await getAlarm(gwId, list);
  } catch (err) {
    throw toRemoteError(err, '获取实时告警');
  }

  const base: RemoteResult = {
    deviceId,
    gwId,
    code: ack.code,
    msg: resolveAckMsg(ack),
    requestId: String(ack.id),
  };

  if (ack.code !== 0) {
    return { ...base, alarms: [], total: 0, synced: false };
  }

  const payload = decodeGetAlarmResponse(ack);
  if (payload.skipped > 0) {
    console.warn(
      `[远程功能] getAlarm 响应存在结构非法条目: gwId=${gwId}, 跳过 ${payload.skipped} 条`
    );
  }

  // 用厂家字典补中文名（查不到就 null，绝不用 devId/meterId 冒充名称）
  const dictJson = await loadMeterDictionary(gwId);
  const alarms = payload.devices.flatMap((d: GetAlarmDevice) => {
    const devName = findDevName(dictJson, d.devId);
    return d.meters.map((m) => ({
      devId: d.devId,
      devName,
      meterId: m.meterId,
      // 协议 4.6：alarmTime 为秒级时间戳，原样返回，不加工
      alarmTime: m.alarmTime,
      alarmTimeMs: m.alarmTime * 1000,
      meterName: findMeterName(dictJson, d.devId, m.meterId),
    }));
  });

  console.log(
    `[远程功能] getAlarm 成功: gwId=${gwId}, 子设备 ${payload.devices.length} 个, ` +
    `告警点 ${alarms.length} 个（仅返回查询结果，未写入平台告警）`
  );

  return { ...base, alarms, total: alarms.length, synced: false };
}

// ============================================================
// 4.7 setData
// ============================================================

/**
 * 校验并归一化单条设置项（协议 4.7：devId / meterId / value **均为 string**）
 */
function normalizeSetItem(raw: any, index: number): SetDataItem {
  const where = `第 ${index + 1} 项`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RemoteOpError(`${where}格式错误：应为 { devId, meterId, value } 对象`);
  }
  const devId = raw.devId != null ? String(raw.devId).trim() : '';
  const meterId = raw.meterId != null ? String(raw.meterId).trim() : '';
  if (!devId) throw new RemoteOpError(`${where} devId 不能为空`);
  if (!isValidIdentifier(devId)) {
    throw new RemoteOpError(`${where} devId 格式不合法：${devId}（不能包含空白或斜杠，最长 64 字符）`);
  }
  if (!meterId) throw new RemoteOpError(`${where} meterId 不能为空`);
  if (!isValidIdentifier(meterId)) {
    throw new RemoteOpError(`${where} meterId 格式不合法：${meterId}（不能包含空白或斜杠，最长 64 字符）`);
  }
  // 协议 4.7 要求 value 为 string：这里**严格**要求字符串，
  // 不做 1 → "1" 的隐式转换（避免把调用方传错类型当成正常下发）。
  if (typeof raw.value !== 'string') {
    throw new RemoteOpError(
      `${where} value 必须是字符串（协议 4.7 规定 value 为 string，收到 ${typeof raw.value}）`
    );
  }
  return { devId, meterId, value: raw.value };
}

/**
 * 4.7 设置数据（平台主动下发，单个或多个设置项）
 *
 * 平台侧不校验 devId/meterId 是否存在于字典：
 *   - 协议 4.7 未要求平台做点位存在性判断，点位是否存在由**网关**应答
 *     （网关用 -16 设备不存在 / -17 量不存在 表达，原样透传给调用方）；
 *   - 平台字典（device_meters）是网关 uploadDevInfo 上传的，可能落后于实际设备，
 *     拿它当"是否允许下发"的闸门会误拦合法点位。
 * 前端仍**优先从已有点位元数据选择**，避免用户手工拼 devId/meterId。
 */
export async function remoteSetData(
  deviceId: string,
  tenantId: string | null | undefined,
  itemsRaw: unknown,
): Promise<RemoteSetDataResult> {
  const device = await resolveOnlineDevice(deviceId, tenantId);
  const gwId = String(device.id);

  if (!Array.isArray(itemsRaw)) {
    throw new RemoteOpError('items 必须是数组');
  }
  if (itemsRaw.length === 0) {
    throw new RemoteOpError('请至少提供一个设置项');
  }
  if (itemsRaw.length > SET_DATA_MAX_ITEMS) {
    throw new RemoteOpError(`一次最多下发 ${SET_DATA_MAX_ITEMS} 个设置项`);
  }

  const items = itemsRaw.map((raw, i) => normalizeSetItem(raw, i));

  let ack: FsuAck;
  try {
    ack = await downstreamSetData(gwId, items);
  } catch (err) {
    throw toRemoteError(err, '设置数据');
  }

  const result: RemoteSetDataResult = {
    deviceId,
    gwId,
    code: ack.code,
    msg: resolveAckMsg(ack),
    requestId: String(ack.id),
    items,
  };

  if (ack.code === 0) {
    console.log(
      `[远程功能] setData 网关已受理: gwId=${gwId}, ${items.length} 项 ` +
      `(${items.map((i) => `${i.devId}/${i.meterId}=${i.value}`).join(', ')})`
    );
  } else {
    // 网关拒绝不是平台异常：如实记录并透传
    console.warn(
      `[远程功能] setData 网关返回失败: gwId=${gwId}, code=${ack.code}, msg=${result.msg}`
    );
  }
  return result;
}

// ============================================================
// 前端「远程设置」用的点位元数据（复用既有 device_meters 字典，不新建数据源）
// ============================================================

/** 远程设置弹窗里的一个候选点位 */
export interface RemoteMeterOption {
  devId: string;
  devName: string | null;
  meterId: string;
  meterName: string | null;
  /** 厂家字典里的 meterType（原始值，未定义时为 null） */
  meterType: number | null;
}

export interface RemoteMeterOptionsResult {
  deviceId: string;
  gwId: string;
  /** 是否拿到了厂家字典（false 时 options 为空，前端应提示"暂无点位字典"） */
  dictAvailable: boolean;
  options: RemoteMeterOption[];
}

/**
 * 列出可用于「远程设置」的候选点位（来自厂家 uploadDevInfo 字典 device_meters）
 *
 * 只读字典，不查网关、不下发任何 MQTT 消息。
 */
export async function listRemoteMeterOptions(deviceId: string): Promise<RemoteMeterOptionsResult> {
  const dictJson = await loadMeterDictionary(deviceId);
  const options: RemoteMeterOption[] = [];

  if (dictJson) {
    try {
      const list = JSON.parse(dictJson);
      if (Array.isArray(list)) {
        for (const d of list) {
          const devId = d?.devId != null ? String(d.devId) : '';
          if (!devId) continue;
          const devName = findDevName(dictJson, devId);
          for (const m of Array.isArray(d?.meters) ? d.meters : []) {
            const meterId = m?.meterId != null ? String(m.meterId) : '';
            if (!meterId) continue;
            options.push({
              devId,
              devName,
              meterId,
              meterName: findMeterName(dictJson, devId, meterId),
              meterType: Number.isFinite(Number(m?.meterType)) ? Number(m.meterType) : null,
            });
          }
        }
      }
    } catch (err) {
      console.error(`[远程功能] 解析厂家点位字典失败: gwId=${deviceId}`, err);
    }
  }

  return { deviceId, gwId: deviceId, dictAvailable: dictJson !== null, options };
}
