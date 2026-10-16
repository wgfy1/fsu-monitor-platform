/**
 * 平台下行请求（协议 4.5 getData / 4.6 getAlarm / 4.7 setData / 4.9 reboot / 4.10 OTA）
 *
 * 统一约定：
 *   - 请求 topic：sc/v1/{method}/{gwId}
 *   - 响应 topic：gw/v1/{method}/{gwId}
 *   - id 由平台生成且全局唯一，用于 request/response 关联
 *   - timestamp 毫秒、QoS 0、retain false（协议 3.4）
 *
 * 发布能力由外部注入（内置 Broker 或平台 MQTT 客户端），
 * 避免协议层反向依赖 mqtt/ 造成循环依赖。
 */
import {
  CODES, CODE_MESSAGE, METHODS, METHOD_OTA_BODY, REBOOT_TYPES, downstreamTimeoutMs,
} from './constants';
import { downlinkTopic } from './topics';
import {
  SetDataItem, FsuAck, MeterValue, GetDataDevice, GetAlarmDevice,
} from './types';

/** 下行报文的发布函数（由 broker / client 在启动时注入） */
export type Publisher = (topic: string, payload: Buffer, qos: 0 | 1) => Promise<void>;

let publisher: Publisher | null = null;

/** 注入发布实现（内置 Broker 与外部 Broker 客户端各注入一次） */
export function setPublisher(fn: Publisher | null): void {
  publisher = fn;
}

/** 待响应请求 */
interface PendingRequest {
  id: string;
  method: string;
  gwId: string;
  sentAt: number;
  resolve: (ack: FsuAck) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** id → 待响应请求 */
const pending = new Map<string, PendingRequest>();
/** 单调递增序号，保证同一毫秒内生成的 id 也不重复 */
let seq = 0;

/** 生成平台侧消息 id（协议：id 由平台生成，字符串类型） */
export function nextMessageId(): string {
  seq = (seq + 1) % 1000000;
  return `p${Date.now().toString(36)}${seq.toString(36).padStart(4, '0')}`;
}

/** 当前待响应请求数（健康检查/测试用） */
export function pendingCount(): number {
  return pending.size;
}

/** 下行发布能力是否就绪（供调用方在发起下行前做前置检查，避免必然失败的请求） */
export function hasPublisher(): boolean {
  return publisher !== null;
}

/**
 * 指定 id 是否仍是**待响应请求**（只读，供 NTP 响应链路排查）
 *
 * 用途：上行侧判断"这条 `gw/v1/ntp/{gwId}` 到底是不是我在等的那个响应"，
 * 便于把"网关没回包"与"回了但 id 对不上"两种情形区分开。
 * 不改动任何 pending 状态。
 */
export function hasPendingRequest(id: unknown): boolean {
  if (id === undefined || id === null) return false;
  return pending.has(String(id));
}

/** 下行请求错误（携带厂家错误码，便于上层映射为协议 code/msg） */
export class DownstreamError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = 'DownstreamError';
  }
}

/**
 * 下行发送核心：生成 id → 构造报文体 → 发布 → 等待响应（**不关心报文体形状**）
 *
 * 抽出来是因为协议 4.8 的平台主动校时报文用的是**「响应」形状**（`code`/`msg`），
 * 与 4.5~4.7/4.9/4.10 的「请求」形状（`params`）不同，但 id 生成、pending 登记、
 * 超时、发布失败处理这些逻辑完全一样 —— 只允许有一份实现。
 *
 * @param buildBody 用平台生成的 id 与当前毫秒时间戳构造报文体
 * @throws DownstreamError（超时 → -14 操作超时；未注入 publisher → -1）
 */
async function sendDownlink(
  gwId: string,
  method: string,
  buildBody: (id: string, timestamp: number) => Record<string, unknown>,
  timeoutMs: number,
  onIssued?: (id: string) => void,
): Promise<FsuAck> {
  if (!publisher) {
    throw new DownstreamError(CODES.FAILED, '下行通道未就绪（MQTT 未启动）');
  }
  const id = nextMessageId();
  const topic = downlinkTopic(method, gwId);
  const payload = Buffer.from(JSON.stringify(buildBody(id, Date.now())), 'utf8');

  return new Promise<FsuAck>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new DownstreamError(CODES.TIMEOUT, `请求超时: ${method}/${gwId} (id=${id})`));
    }, timeoutMs);

    pending.set(id, { id, method, gwId, sentAt: Date.now(), resolve, reject, timer });
    // 先登记 pending 再通知调用方，保证 onIssued 里记下的 id 一定能被响应关联到
    try {
      onIssued?.(id);
    } catch (err: any) {
      console.error(`[FSU] onIssued 回调异常（不影响请求）: id=${id}, ${err?.message || err}`);
    }

    publisher!(topic, payload, 0).catch((err) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      reject(new DownstreamError(CODES.FAILED, `下行发布失败: ${err?.message || err}`));
    });
  });
}

/**
 * 发送下行请求并等待网关响应（「请求」形状：`{id,timestamp,method,params?}`）
 *
 * 协议 4.5/4.6/4.7/4.9/4.10 的平台下发一律用本函数。4.8 校时例外，见 `ntp()`。
 */
export async function sendRequest(
  gwId: string,
  method: string,
  params?: unknown,
  timeoutMs: number = downstreamTimeoutMs(),
  /**
   * 报文体里的 method 值（缺省与 topic 段名一致）
   * 仅 OTA 需要：topic 段名是小写 ota，报文体按厂家 4.10 要求发送大写 "OTA"。
   */
  bodyMethod?: string,
  /**
   * 报文发出后的回调（可选）：把平台侧生成的 id 交给调用方
   *
   * 用于"请求已超时、响应迟到"的场景 —— 调用方需要预先记下自己发过哪些 id，
   * 才能在 pending 已被清理后识别出这是迟到响应而非新的网关请求。
   * 不影响任何既有行为（不传即为空操作）。
   */
  onIssued?: (id: string) => void,
): Promise<FsuAck> {
  return sendDownlink(gwId, method, (id, timestamp) => {
    const body: Record<string, unknown> = {
      id,
      timestamp,               // 毫秒（协议所有报文的 timestamp）
      method: bodyMethod ?? method,
    };
    // params 可缺省（协议 4.5/4.6：为空或不携带表示全部设备）
    if (params !== undefined) body.params = params;
    return body;
  }, timeoutMs, onIssued);
}

/**
 * 处理网关对本平台下行请求的响应（由上行路由在识别到"响应"时调用）
 * 关联规则（用户要求 §10/§11）：id 一致 + gwId 一致；method 兼容大小写（OTA/ota）。
 * @returns 是否已作为响应消费（true = 调用方不应再按普通上行处理）
 */
export function handleDownlinkResponse(
  topic: string,
  body: any,
  gwId: string | null,
): boolean {
  const id = body?.id != null ? String(body.id) : null;
  if (!id) return false;
  const req = pending.get(id);
  if (!req) return false;

  // gwId 校验：响应必须来自请求的网关
  if (gwId && req.gwId !== gwId) {
    console.warn(`[FSU] 下行响应 gwId 不匹配: 期望 ${req.gwId}, 实际 ${gwId} (id=${id})，已忽略`);
    return false;
  }
  // method 校验（OTA 大小写差异：请求 method="OTA"，响应可能 "OTA"/"ota"）
  const respMethod = String(body?.method ?? '').toLowerCase();
  if (respMethod && respMethod !== req.method.toLowerCase()) {
    console.warn(`[FSU] 下行响应 method 不匹配: 期望 ${req.method}, 实际 ${body?.method} (id=${id})，已忽略`);
    return false;
  }

  pending.delete(id);
  clearTimeout(req.timer);
  const rtt = Date.now() - req.sentAt;
  console.log(`[FSU] 下行响应到达: ${topic} (id=${id}, method=${req.method}, gwId=${req.gwId}, rtt=${rtt}ms, code=${body?.code})`);
  req.resolve(body as FsuAck);
  return true;
}

/** 拒绝并清理所有待响应请求（MQTT 断开时调用，避免悬挂） */
export function rejectAllPending(reason: string): void {
  for (const [id, req] of pending) {
    clearTimeout(req.timer);
    req.reject(new DownstreamError(CODES.FAILED, `${reason} (id=${id})`));
  }
  pending.clear();
}

// ============================================================
// 协议方法封装
// ============================================================

/**
 * 4.5 平台获取实时数据
 * @param deviceIds 设备 id 列表；为空/缺省表示获取全部设备（协议 4.5：不携带 params）
 */
export async function getData(gwId: string, deviceIds?: string[]): Promise<FsuAck> {
  const params = deviceIds && deviceIds.length > 0 ? deviceIds.map(String) : undefined;
  return sendRequest(gwId, METHODS.GET_DATA, params);
}

/**
 * 4.6 平台获取实时告警
 * @param deviceIds 设备 id 列表；为空/缺省表示获取全部设备
 */
export async function getAlarm(gwId: string, deviceIds?: string[]): Promise<FsuAck> {
  const params = deviceIds && deviceIds.length > 0 ? deviceIds.map(String) : undefined;
  return sendRequest(gwId, METHODS.GET_ALARM, params);
}

/**
 * 4.7 平台设置数据（单个或多个设置项）
 * value 保持 string（协议字符串类型，不做数值转换）
 */
export async function setData(gwId: string, items: SetDataItem[]): Promise<FsuAck> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new DownstreamError(CODES.PARAM_ERROR, 'setData 至少需要一个设置项');
  }
  const params = items.map((it) => ({
    devId: String(it.devId),
    meterId: String(it.meterId),
    value: String(it.value),   // 保持 string
  }));
  return sendRequest(gwId, METHODS.SET_DATA, params);
}

/**
 * 4.9 平台重启网关（1-sys 2-app 3-4g 4-vpn）
 */
export async function reboot(gwId: string, type: number): Promise<FsuAck> {
  const valid = Object.values(REBOOT_TYPES) as number[];
  if (!valid.includes(Number(type))) {
    throw new DownstreamError(CODES.PARAM_ERROR, `reboot type 非法（应为 ${valid.join('/')}）`);
  }
  return sendRequest(gwId, METHODS.REBOOT, { type: Number(type) });
}

/**
 * 只发布、**不注册 pending、不等待响应**（"发出去即完成"类下行）
 *
 * 平台主动校时就属于这一类：真实设备 00534c080213 收到 4.8 报文后**不会回包**
 * （已实测：15 分钟观察期间 `gw/v1/ntp/*` 上行 0 条），因此若沿用
 * `sendRequest()` 的 pending + 超时语义，每次校时都会被判为"请求超时"。
 *
 * 与其他下行共用**同一个 publisher**，因此走完全相同的 MQTT 投递路径。
 */
async function publishOnly(
  gwId: string,
  method: string,
  buildBody: (id: string, timestamp: number) => Record<string, unknown>,
): Promise<{ id: string; topic: string; payload: string; publishedAt: number }> {
  if (!publisher) {
    throw new DownstreamError(CODES.FAILED, '下行通道未就绪（MQTT 未启动）');
  }
  const id = nextMessageId();
  const topic = downlinkTopic(method, gwId);
  const payloadText = JSON.stringify(buildBody(id, Date.now()));
  const publishedAt = Date.now();
  // QoS 0、retain false、dup false（协议 3.4；由 Broker 侧统一设置）
  await publisher(topic, Buffer.from(payloadText, 'utf8'), 0);
  return { id, topic, payload: payloadText, publishedAt };
}

/**
 * 构造 4.8 平台主动校时报文体（**唯一的一份构造逻辑**）
 *
 * 报文体（**已在真实设备 00534c080213 上验证有效**，勿改动形状）：
 *   { id, timestamp(毫秒), method:"ntp", code:0, msg:"success" }
 *
 *   **不带 `params`、不带 `data`** —— 不带 `data.timezone` 即"不更改网关时区"
 *   （文档："不携带即表示不更改时区"）。`timestamp` 是文档所说
 *   "使用 timestamp 来同步时间"的时间源。
 *
 * 形状依据：厂家文档 4.8 定义 `sc/v1/ntp/$(gwId)` 承载的是**「平台响应」形状**
 * （`code` 为必须字段），不是「请求」形状；用请求形状发送会被固件静默丢弃。
 */
function buildNtpBody(id: string, timestamp: number): Record<string, unknown> {
  return {
    id,
    timestamp,
    method: METHODS.NTP,
    code: CODES.SUCCESS,
    msg: CODE_MESSAGE[CODES.SUCCESS],     // 'success'
  };
}

/**
 * 4.8 平台主动校时（**平台→网关**）
 *
 * 发布成功即返回；**不等待网关响应**（真实设备不对此报文回包）。
 *
 * ⚠️ 返回的 `id` 只代表"平台已把这条报文交给 Broker"，**不代表设备已校时**。
 *    调用方不得把"发布成功"表述为"设备校时成功"。
 */
export async function ntp(gwId: string): Promise<{ id: string; topic: string; payload: string; publishedAt: number }> {
  return publishOnly(gwId, METHODS.NTP, buildNtpBody);
}

/**
 * 4.10 平台下发 OTA 升级
 *
 * ⚠️ 厂家文档大小写不一致：
 *   - topic 段名一律小写 `ota`（4.10 主题：sc/v1/ota/$(gwId)）
 *   - 报文体 method 按 4.10 字段表与 Demo 发送 **"OTA"**
 *   - 接收响应时兼容 "OTA" / "ota"（见 handleDownlinkResponse 的 method 归一化）
 *
 * 本轮只做 MQTT 协议发送/响应适配，不实现 OTA 下载服务器（用户要求 §15）。
 * @param urls 固件下载地址数组（支持单/多文件）
 */
export async function ota(gwId: string, urls: string | string[]): Promise<FsuAck> {
  const list = (Array.isArray(urls) ? urls : [urls]).map(String).filter(Boolean);
  if (list.length === 0) {
    throw new DownstreamError(CODES.PARAM_ERROR, 'OTA 至少需要一个固件地址');
  }
  // topic 段名 METHODS.OTA = 'ota'（小写），报文体 method = "OTA"（厂家 4.10 字段表与 Demo）
  return sendRequest(gwId, METHODS.OTA, { url: list }, undefined, METHOD_OTA_BODY);
}

/** 厂家协议错误码 → 提示文案（上层按协议 code/msg 返回时使用） */
export function codeMessage(code: number, fallback?: string): string {
  return fallback || CODE_MESSAGE[code] || `未知错误(${code})`;
}

/**
 * 下行成功响应里的提示文案
 *
 * ⚠️ 厂家文档在这一点上不统一：
 *   - 4.5/4.6/4.9/4.10 的响应把提示放在**顶层 msg**（"msg": "success"）；
 *   - 4.7 setData 的响应 Demo 却放在 **data.msg**（"data": { "msg": "success" }）。
 * 两者都按"网关返回的提示"读取，优先顶层 msg，其次 data.msg，最后按错误码兜底。
 * 不臆造文案：网关没给就说网关没给。
 */
export function ackMessage(ack: FsuAck): string {
  const top = typeof ack?.msg === 'string' ? ack.msg.trim() : '';
  if (top) return top;
  const nested = (ack?.data as { msg?: unknown } | undefined)?.msg;
  return typeof nested === 'string' ? nested.trim() : '';
}

/** 4.5 getData 响应解析结果 */
export interface GetDataPayload {
  /** 网关返回的设备实时数据（已剔除结构非法的条目） */
  devices: GetDataDevice[];
  /** 因结构非法被跳过的条目数（诊断用，>0 时上层会打日志） */
  skipped: number;
}

/**
 * 解析 4.5 getData 的响应体
 *
 * 协议 4.5 响应：data 为数组，每项 { devId, meters: [{ meterId, value }] }，
 * value 是 **string**（不强制转数值类型）。
 *
 * 本函数只做**结构归一化**，不做任何业务判断（不查字典、不落库）：
 *   - devId 缺失或 meters 不是数组 → 整条跳过并计入 skipped（不静默写坏数据）
 *   - meterId 缺失 → 该点跳过并计入 skipped
 *   - value 为 null/undefined → 记为 ''（网关没给值，如实保留为空串，不编造数值）
 */
export function decodeGetDataResponse(ack: FsuAck): GetDataPayload {
  const list = Array.isArray(ack?.data) ? (ack.data as any[]) : [];
  const devices: GetDataDevice[] = [];
  let skipped = 0;

  for (const raw of list) {
    const devId = raw?.devId != null ? String(raw.devId).trim() : '';
    if (!devId || !Array.isArray(raw?.meters)) {
      skipped++;
      continue;
    }
    const meters: MeterValue[] = [];
    for (const m of raw.meters) {
      const meterId = m?.meterId != null ? String(m.meterId).trim() : '';
      if (!meterId) {
        skipped++;
        continue;
      }
      meters.push({
        meterId,
        value: m?.value === undefined || m?.value === null ? '' : String(m.value),
      });
    }
    devices.push({ devId, meters });
  }
  return { devices, skipped };
}

/** 4.6 getAlarm 响应解析结果 */
export interface GetAlarmPayload {
  devices: GetAlarmDevice[];
  skipped: number;
}

/**
 * 解析 4.6 getAlarm 的响应体
 *
 * 协议 4.6 响应：data 为数组，每项 { devId, meters: [{ meterId, alarmTime }] }，
 * alarmTime 为 **int 秒级**时间戳（协议 4.6 表格明确"秒级"，与信封毫秒不同）。
 *
 * 同样只做结构归一化：alarmTime 非有限数字的点被跳过并计入 skipped
 * （不把 NaN/字符串硬塞进时间字段）。
 */
export function decodeGetAlarmResponse(ack: FsuAck): GetAlarmPayload {
  const list = Array.isArray(ack?.data) ? (ack.data as any[]) : [];
  const devices: GetAlarmDevice[] = [];
  let skipped = 0;

  for (const raw of list) {
    const devId = raw?.devId != null ? String(raw.devId).trim() : '';
    if (!devId || !Array.isArray(raw?.meters)) {
      skipped++;
      continue;
    }
    const meters: GetAlarmDevice['meters'] = [];
    for (const m of raw.meters) {
      const meterId = m?.meterId != null ? String(m.meterId).trim() : '';
      const alarmTime = Number(m?.alarmTime);
      if (!meterId || !Number.isFinite(alarmTime)) {
        skipped++;
        continue;
      }
      meters.push({ meterId, alarmTime });
    }
    devices.push({ devId, meters });
  }
  return { devices, skipped };
}
