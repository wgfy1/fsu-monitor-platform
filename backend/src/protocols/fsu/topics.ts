/**
 * 厂家协议 Topic 解析与构造（协议 3.3 主题说明）
 *
 *   网关登录：gw/v1/login              ← 不含 gwId，gwId 从 params.mac 取
 *   网关上行：gw/v1/$(method)/$(gwId)
 *   平台下行：sc/v1/$(method)/$(gwId)
 *
 * $(gwId) = 去掉 ':' 的小写 mac 地址，如：00534a000282
 */
import { UPLINK_PREFIX, DOWNLINK_PREFIX, TOPIC_LOGIN } from './constants';

/**
 * 规范化厂家协议中的 gwId（协议 3.3）
 *   1. 去掉所有冒号（含全角冒号）
 *   2. 去掉空白
 *   3. 统一转小写
 * 幂等：已规范的 gwId 再次传入结果不变。
 */
export function normalizeGwId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).replace(/[:：\s]/g, '').toLowerCase();
  return s.length > 0 ? s : null;
}

/** 构造网关上行 topic：gw/v1/{method}/{gwId} */
export function uplinkTopic(method: string, gwId: string): string {
  return `${UPLINK_PREFIX}/${method}/${gwId}`;
}

/** 构造平台下行 topic：sc/v1/{method}/{gwId} */
export function downlinkTopic(method: string, gwId: string): string {
  return `${DOWNLINK_PREFIX}/${method}/${gwId}`;
}

/** 解析结果：topic 属于哪种协议消息 */
export interface ParsedTopic {
  /** 'uplink' = gw/v1/...；'downlink' = sc/v1/... */
  direction: 'uplink' | 'downlink';
  /** 方法名（topic 中的原始大小写） */
  method: string;
  /** topic 中的 gwId（login 主题没有，返回 null） */
  gwId: string | null;
  /** 是否是网关登录主题 */
  isLogin: boolean;
}

/**
 * 解析厂家协议 topic
 * 只认 gw/v1/... 与 sc/v1/...；其它返回 null（调用方跳过，不进入业务处理）。
 */
export function parseTopic(topic: string): ParsedTopic | null {
  const parts = topic.split('/');
  if (parts.length < 3) return null;
  const [prefix, version] = parts;
  if (version !== 'v1') return null;
  if (prefix !== 'gw' && prefix !== 'sc') return null;

  const direction = prefix === 'gw' ? 'uplink' : 'downlink';
  const method = parts[2];

  // 登录主题没有 gwId 段
  if (direction === 'uplink' && method === 'login') {
    return { direction, method, gwId: null, isLogin: true };
  }

  const gwId = parts.length >= 4 ? normalizeGwId(parts[3]) : null;
  return { direction, method, gwId, isLogin: false };
}

/**
 * 判断 topic 是否是厂家协议上行消息（gw/v1/...）
 * 平台自身发布的 sc/v1/... 不是上行，必须排除，避免把 ack 当设备数据二次处理。
 */
export function isUplinkTopic(topic: string): boolean {
  const p = parseTopic(topic);
  return !!p && p.direction === 'uplink';
}

/** 判断 topic 是否是厂家协议下行消息（sc/v1/...） */
export function isDownlinkTopic(topic: string): boolean {
  const p = parseTopic(topic);
  return !!p && p.direction === 'downlink';
}

/** 判断是否是网关登录 topic */
export function isLoginTopic(topic: string): boolean {
  return topic === TOPIC_LOGIN;
}
