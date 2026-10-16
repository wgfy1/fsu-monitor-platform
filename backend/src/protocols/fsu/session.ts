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
  s.online = params.online;
  s.offline = params.offline;
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
