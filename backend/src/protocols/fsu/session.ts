/**
 * 网关会话表（内存）
 *
 * 记录每个厂家网关（gwId）的在线/session 信息：
 *   gwId / clientId / lastLoginAt / lastHeartbeatAt / version / hardwareVersion / upgradeVersion
 * 以及最近一次心跳携带的 ICDI/carrier/vpnip 与子设备在线/离线列表。
 *
 * 为什么放内存：用户明确要求"不要为了保存可选字段而破坏现有数据库设计"。
 * 这些是**会话态**数据（重启后由网关重新 login 恢复），与既有
 * mqtt/deviceMap.ts 的 mac→设备映射同为内存态，保持一致。
 *
 * 层级关系（协议要求严格区分，见报告 §19）：
 *   gwId  = 网关（MAC，去冒号小写）—— 本表的 key
 *   devId = 网关下的实际设备 —— 存放在 session.online/offline 与 latestMeters 里
 *   meterId = 设备下的信号量 —— 与设备数据一起落库
 */
import { normalizeGwId } from './topics';

export interface GatewaySession {
  /** 网关 MAC（去冒号小写） */
  gwId: string;
  /** MQTT clientId（协议 3.4：clientId = gwId；平台侧记录实际值以便排查） */
  clientId: string | null;
  /** 最近一次 login 时间（毫秒） */
  lastLoginAt: number;
  /** 最近一次心跳时间（毫秒）；未收到过为 null */
  lastHeartbeatAt: number | null;
  /** 版本号（params.version，扩展模块版本##应用版本） */
  version: string;
  /** 升级包版本号（可选，协议 4.1） */
  upgradeVersion?: string;
  /** 硬件版本号（可选，协议 4.1） */
  hardwareVersion?: string;
  /** 最近一次心跳的 SIM 卡号（可选） */
  ICCID?: string;
  /** 最近一次心跳的运营商（可选：CT/CM/CU） */
  carrier?: string;
  /** 最近一次心跳的 vpn 地址（可选，获取失败时为空串） */
  vpnip?: string;
  /** 最近一次心跳上报的在线子设备（devId 列表） */
  online: string[];
  /** 最近一次心跳上报的离线子设备（devId 列表） */
  offline: string[];
  /**
   * 当前**连接周期**内是否已收到过有效心跳快照。
   *
   * false 的情形：新建会话 / 网关断开 / 网关刚重连尚未收到心跳 / 后端刚重启。
   * 此时所有功能子设备一律显示"离线"，不沿用上一连接周期的旧快照，
   * 也不因为 MQTT 已连接就显示在线或未知。
   *
   * 与 MQTT 连接状态分开记录：MQTT 连接成功 ≠ 子设备状态可信。
   */
  heartbeatValid: boolean;
}

/** gwId → session */
const sessions = new Map<string, GatewaySession>();

/**
 * 登记/更新登录会话（协议 4.1）
 * @returns 会话对象；gwId 非法时返回 null
 */
export function upsertLoginSession(params: {
  gwId: unknown;
  clientId?: string | null;
  version: string;
  upgradeVersion?: string;
  hardwareVersion?: string;
  now?: number;
}): GatewaySession | null {
  const gwId = normalizeGwId(params.gwId);
  if (!gwId) return null;

  const now = params.now ?? Date.now();
  const prev = sessions.get(gwId);
  const session: GatewaySession = {
    gwId,
    clientId: params.clientId ?? prev?.clientId ?? null,
    lastLoginAt: now,
    lastHeartbeatAt: prev?.lastHeartbeatAt ?? null,
    version: params.version,
    upgradeVersion: params.upgradeVersion,
    hardwareVersion: params.hardwareVersion,
    ICCID: prev?.ICCID,
    carrier: prev?.carrier,
    vpnip: prev?.vpnip,
    online: prev?.online ?? [],
    offline: prev?.offline ?? [],
    // 新建会话默认没有有效心跳；已有会话则沿用（login 每 ~10 秒重发一次，
    // 不能在这里重置，否则子设备状态会反复跳到"离线"）。
    heartbeatValid: prev?.heartbeatValid ?? false,
  };
  sessions.set(gwId, session);
  return session;
}

/** 更新会话中的 MQTT clientId（连接建立时已知，早于 login） */
export function attachClientId(gwId: unknown, clientId: string | null): void {
  const id = normalizeGwId(gwId);
  if (!id) return;
  const s = sessions.get(id);
  if (s) s.clientId = clientId;
}

/** 记录心跳（协议 4.2）：刷新心跳时间与可选字段、在线/离线列表 */
export function touchHeartbeat(params: {
  gwId: unknown;
  online: string[];
  offline: string[];
  ICCID?: string;
  carrier?: string;
  vpnip?: string;
  now?: number;
}): GatewaySession | null {
  const gwId = normalizeGwId(params.gwId);
  if (!gwId) return null;
  const s = sessions.get(gwId);
  // 心跳先于 login 到达时（异常时序）不新建会话：设备身份由 login 建立
  if (!s) return null;

  s.lastHeartbeatAt = params.now ?? Date.now();
  // online / offline 是**全量快照**（协议 4.2：在线设备列表 / 离线设备列表），
  // 每次有效心跳整批覆盖上一份快照，不做增量合并。
  s.online = params.online;
  s.offline = params.offline;
  // 只有通过校验、真正入库的心跳才标记"当前连接周期已有有效快照"。
  // 非法心跳在 handlers 的 validateHeartbeatParams 阶段就被拒绝，不会走到这里，
  // 因此不会覆盖已有的有效快照。
  s.heartbeatValid = true;

  // 数据自相矛盾：同一 devId 同时出现在两个列表 → 记异常日志（查询时按未知处理）。
  // 在这里记而不是在读取接口里记，避免前端每次轮询都刷同一条日志。
  const conflicts = params.online.filter((devId) => params.offline.includes(devId));
  if (conflicts.length > 0) {
    console.warn(
      `[FSU] 心跳数据异常: gwId=${gwId}, ` +
      `devId=${conflicts.join(',')} 同时出现在 online 与 offline 列表，按未知处理`
    );
  }
  if (params.ICCID !== undefined) s.ICCID = params.ICCID;
  if (params.carrier !== undefined) s.carrier = params.carrier;
  if (params.vpnip !== undefined) s.vpnip = params.vpnip;
  return s;
}

/** 查询会话 */
export function getSession(gwId: unknown): GatewaySession | null {
  const id = normalizeGwId(gwId);
  if (!id) return null;
  return sessions.get(id) ?? null;
}

/**
 * 子设备通信状态
 *
 * ⚠️ 唯一来源 = 厂家心跳（协议 4.2）的 params.online / params.offline。
 *    不得用 MQTT 连接状态、最后上报时间、是否有告警、监控点值等方式推断。
 */
export type SubDeviceCommStatus = 'online' | 'offline' | 'unknown';

/** 一个功能子设备的通信状态（供只读接口返回） */
export interface SubDeviceCommStatusEntry {
  devId: string;
  devName: string | null;
  status: SubDeviceCommStatus;
  /** 本状态依据的心跳时间（毫秒）；从未收到有效心跳为 null */
  lastHeartbeatAt: number | null;
}

/**
 * 计算某网关各功能子设备当前的通信状态
 *
 * @param subDevices 由厂家字典动态识别出的功能子设备（devId / devName）
 *
 * 状态规则（严格按 heartbeat.params.online / params.offline）：
 *
 *   当前连接周期**没有**有效心跳快照时（新建会话 / 网关断开 / 刚重连未收到心跳 /
 *   后端刚重启）：全部子设备 **offline**。
 *     —— 不沿用上一周期的旧快照，也不因 MQTT 已连接就显示在线或未知。
 *
 *   有有效快照时（每次心跳整批覆盖）：
 *     - 只在 online  → online
 *     - 只在 offline → offline
 *     - 两个列表都没有 → **unknown**（不默认在线，也不默认离线）
 *     - **同时出现在两个列表** → unknown（touchHeartbeat 入库时已记异常日志，
 *       平台不擅自选边）
 */
export function getSubDeviceCommStatuses(
  gwId: unknown,
  subDevices: Array<{ devId: string; devName: string | null }>
): { lastHeartbeatAt: number | null; subDevices: SubDeviceCommStatusEntry[] } {
  const s = getSession(gwId);

  // 没有有效快照：一律离线（包括从未连接、断开后、重连未收到心跳、后端重启）
  if (!s || !s.heartbeatValid) {
    return {
      lastHeartbeatAt: null,
      subDevices: subDevices.map((d) => ({
        devId: d.devId,
        devName: d.devName,
        status: 'offline',
        lastHeartbeatAt: null,
      })),
    };
  }

  const online = new Set(s.online);
  const offline = new Set(s.offline);
  const lastHeartbeatAt = s.lastHeartbeatAt;

  const statusOf = (devId: string): SubDeviceCommStatus => {
    const inOnline = online.has(devId);
    const inOffline = offline.has(devId);
    if (inOnline && inOffline) return 'unknown';
    if (inOnline) return 'online';
    if (inOffline) return 'offline';
    return 'unknown';
  };

  return {
    lastHeartbeatAt,
    subDevices: subDevices.map((d) => ({
      devId: d.devId,
      devName: d.devName,
      status: statusOf(d.devId),
      lastHeartbeatAt,
    })),
  };
}

/**
 * 作废某网关当前的心跳快照（网关断开 / 新连接接管时调用）
 *
 * 为什么必须作废：online/offline 是**某个连接周期内**的上报快照。
 * 网关断开（重启、断电、断网）或换了一条新连接后，旧快照不再代表实时状态；
 * 继续沿用等于"拿未经确认的旧状态冒充实时状态"。
 *
 * 作废后 getSubDeviceCommStatuses() 对所有功能子设备返回 **offline**
 * （按要求：断开后、重连尚未收到有效心跳前，一律离线），
 * 直到新连接周期收到第一条有效心跳，再按全量快照恢复。
 *
 * 只作用于传入的 gwId，不影响其它网关。
 */
export function clearHeartbeatStatus(gwId: unknown): void {
  const s = getSession(gwId);
  if (!s) return;
  s.online = [];
  s.offline = [];
  s.lastHeartbeatAt = null;
  s.heartbeatValid = false;
}

/** 网关是否已登录（下行消息的前置条件） */
export function isLoggedIn(gwId: unknown): boolean {
  return getSession(gwId) !== null;
}

/** 移除会话（MQTT 断开时调用，并清空 clientId） */
export function removeSession(gwId: unknown): void {
  const id = normalizeGwId(gwId);
  if (!id) return;
  const s = sessions.get(id);
  if (s) s.clientId = null;
}

/** 当前会话数（健康检查/测试用） */
export function sessionCount(): number {
  return sessions.size;
}

/** 清空全部会话（仅测试用） */
export function clearSessions(): void {
  sessions.clear();
}

/** 通过 clientId 反查 gwId（协议 3.4：clientId = gwId） */
export function findGwIdByClientId(clientId: string | null | undefined): string | null {
  if (!clientId) return null;
  const direct = normalizeGwId(clientId);
  if (direct && sessions.has(direct)) return direct;
  for (const s of sessions.values()) {
    if (s.clientId === clientId) return s.gwId;
  }
  return null;
}
