/**
 * 厂家 FSU MQTT 协议适配层 —— 统一入口
 *
 * 数据流（上行）：
 *   MQTT Broker / Client
 *     → 本模块 routeUplink()（topic 路由）
 *     → codec 校验（大小 / JSON / 结构）
 *     → expire 过期过滤（login、ntp 豁免）
 *     → handlers 协议处理
 *     → 现有 DeviceService / DataService / AlarmService
 *
 * 数据流（下行）：
 *   业务调用 downstream.getData/setData/... → 本模块 publish → sc/v1/{method}/{gwId}
 *   网关响应 gw/v1/{method}/{gwId} → routeUplink 识别为响应 → 关联回 pending 请求
 *
 * 业务层只依赖本模块，不直接接触厂家字段；协议变更不影响业务 service。
 */
import {
  METHODS, CODES, MAX_PAYLOAD_BYTES, TOPIC_LOGIN,
} from './constants';
import { parseTopic, downlinkTopic, normalizeGwId } from './topics';
import { checkPayloadSize, parseJsonPayload, validateEnvelope } from './codec';
import { checkExpiry } from './expire';
import {
  HandlerContext, handleLogin, handleHeartbeat, handleDataReport,
  handleAlarmReport, handleNtp, buildAck,
} from './handlers';
import { setPublisher, handleDownlinkResponse, Publisher } from './downstream';
// 平台主动校时：login 成功即标记"上线事件"（真正发送由校时模块在订阅就绪后执行）
import { onGatewayOnline } from './ntpSync';
import { FsuAck } from './types';

/** 协议规定的上行方法（统一小写，用于大小写无关的比配） */
const UPLINK_LOGIN = METHODS.LOGIN.toLowerCase();
const UPLINK_HEARTBEAT = METHODS.HEARTBEAT.toLowerCase();
const UPLINK_DATA_REPORT = METHODS.DATA_REPORT.toLowerCase();
const UPLINK_ALARM_REPORT = METHODS.ALARM_REPORT.toLowerCase();
const UPLINK_NTP = METHODS.NTP.toLowerCase();
const KNOWN_UPLINK_METHODS = new Set<string>([
  UPLINK_LOGIN, UPLINK_HEARTBEAT, UPLINK_DATA_REPORT, UPLINK_ALARM_REPORT, UPLINK_NTP,
]);

/** 协议层发布函数（与 downstream 共用同一个注入点） */
let publishFn: Publisher | null = null;

/**
 * 同一网关的消息**串行处理**队列
 *
 * 为什么必须串行：dataReport 的增量合并是"读现有 latest_meters → 合并 → 写回"，
 * 同一网关若在极短时间内连发多条（网关常按 devId 分多条上报），
 * 并发执行会出现读-改-写竞争：各自读到旧快照，后写者覆盖前者，导致子设备数据丢失。
 * 同理，alarmReport 的 serialNo 去重（先查后插）在并发下会重复建告警。
 * 按 gwId 串行即可同时消除这两类竞争，且天然保证同一网关消息的处理顺序。
 */
const gwQueues = new Map<string, Promise<void>>();

function enqueuePerGateway(gwId: string, task: () => Promise<void>): Promise<void> {
  const prev = gwQueues.get(gwId) ?? Promise.resolve();
  const next = prev.then(task, task).catch(() => undefined);
  gwQueues.set(gwId, next);
  // 队列空闲后清理，避免 Map 无限增长
  void next.then(() => {
    if (gwQueues.get(gwId) === next) gwQueues.delete(gwId);
  });
  return next;
}

/**
 * 注入下行发布能力（内置 Broker / 平台 MQTT 客户端启动时调用）
 * 协议层不直接依赖 mqtt/，避免循环依赖。
 */
export function registerPublisher(fn: Publisher | null): void {
  publishFn = fn;
  setPublisher(fn);
}

/** 发送响应 ACK 到 sc/v1/{method}/{gwId} */
async function publishAck(method: string, gwId: string, ack: FsuAck): Promise<void> {
  if (!publishFn) {
    console.warn(`[FSU] 无法发送响应（下行通道未就绪）: ${method}/${gwId}`);
    return;
  }
  const topic = downlinkTopic(method, gwId);
  const buf = Buffer.from(JSON.stringify(ack), 'utf8');
  try {
    // ACK 沿用既有 QoS 1（与厂家固件实际联调验证过的投递方式一致，未改动）
    await publishFn(topic, buf, 1);
  } catch (err: any) {
    console.error(`[FSU] 响应发送失败: topic=${topic}, id=${ack.id}, code=${ack.code}`, err?.message || err);
  }
}

/**
 * 校验并进入协议处理（上行消息统一入口）
 *
 * @param topic   完整 MQTT topic
 * @param payload 原始报文
 * @param clientId 发布方 clientId（协议 3.4：网关 clientId = gwId；平台客户端为 fsu-platform-*）
 * @returns 是否被本协议层处理
 */
export async function routeUplink(
  topic: string,
  payload: Buffer,
  clientId: string | null = null,
): Promise<boolean> {
  const parsed = parseTopic(topic);
  if (!parsed || parsed.direction !== 'uplink') return false;

  const method = parsed.method;
  const methodLower = method.toLowerCase();

  // === 1. 报文大小（协议 3.2 a）——超限直接拒绝，不进入 JSON 解析 ===
  const sizeCheck = checkPayloadSize(payload);
  if (!sizeCheck.ok) {
    console.warn(`[FSU] 报文超限已拒绝: topic=${topic}, ${sizeCheck.reason}`);
    return true;
  }

  // === 2. JSON 解析（UTF-8，只接受 object/array）===
  const jsonCheck = parseJsonPayload(payload);
  if (!jsonCheck.ok) {
    console.warn(`[FSU] 报文非法已拒绝: topic=${topic}, ${jsonCheck.reason}`);
    // 非法 JSON 无法回响应（拿不到 id / method），按协议错误处理并结束
    return true;
  }
  const body = jsonCheck.value;

  // === 3. 是否是本平台下行请求的响应 ===
  //    先于业务分发判断：getData/getAlarm/setData/reboot/ota 的响应
  //    绝不能当成普通上行（尤其不能与 alarmReport 混为一类）。
  if (handleDownlinkResponse(topic, body, parsed.gwId)) {
    return true;   // 成功匹配由 downstream.ts 打印「下行响应到达」
  }

  // === 4. 信封校验（id / timestamp / method）===
  const env = validateEnvelope(body);
  if (!env.ok) {
    console.warn(`[FSU] 信封非法已拒绝: topic=${topic}, ${env.reason}`);
    return true;
  }
  const envelope = env.value!;
  const id = envelope.id;

  // === 5. 过期过滤（协议 3.6 b；login / ntp 豁免）===
  //    login 用 topic 判定（登录报文 method=login），ntp 按 method 判定
  const effectiveMethod = topic === TOPIC_LOGIN ? METHODS.LOGIN : methodLower;
  const expiry = checkExpiry(effectiveMethod, envelope.timestamp);
  if (expiry.expired) {
    // 过期即丢弃（行为与改造前完全一致）。
    // 注意：旧实现曾在此处触发"平台主动校时"，该逻辑**已整体移除** ——
    // 现在平台主动校时改由"设备上线 + 定时调度"驱动，与消息是否过期无关。
    console.warn(`[FSU] 消息过期已丢弃: topic=${topic}, id=${id}, ${expiry.reason}`);
    return true;
  }

  // === 6. 网关身份（gwId）===
  //    login：必须从 params.mac 规范化取得（协议 3.3，topic 里没有 gwId）
  //    其它：topic 末段即为 gwId
  let gwId = parsed.gwId;
  if (!gwId && effectiveMethod === METHODS.LOGIN) {
    gwId = normalizeGwId(body?.params?.mac);
  }

  const ctx: HandlerContext = {
    deviceId: gwId ?? '',
    clientId,
    topicGwId: gwId,
  };

  // === 7. 未登录校验（下行请求类消息必须要求已登录）===
  //    上行数据类消息保持宽松：设备可能先上报后登录（既有行为，避免丢数据），
  //    仅记录告警；下行（平台发起）则严格要求会话存在。
  if (methodLower !== METHODS.LOGIN && !gwId) {
    console.warn(`[FSU] topic 缺少 gwId 已忽略: ${topic}`);
    return true;
  }

  // 只处理协议明确规定的上行方法；其它（如厂家抓包出现的 uploadDevInfo）
  // 立即交回调用方的既有兼容逻辑。
  // 注意：方法名一律按**小写**比配（协议 3.5 方法名是大小写混排的驼峰，
  // 发送方可能大小写不一致），避免因大小写差异落到兜底分支。
  if (!KNOWN_UPLINK_METHODS.has(methodLower)) return false;

  // 同一网关串行处理（消除 latest_meters 读-改-写竞争与 serialNo 去重竞争）
  const queueKey = gwId ?? `__no_gw__`;
  await enqueuePerGateway(queueKey, async () => {
    try {
      switch (methodLower) {
        case UPLINK_LOGIN: {
          const ack = await handleLogin(body, ctx);
          // 登录响应的 gwId 以 params.mac 规范化结果为准
          const ackGwId = normalizeGwId(body?.params?.mac) ?? gwId;
          if (ackGwId) await publishAck(METHODS.LOGIN, ackGwId, ack);
          // 平台主动校时：login 成功即视为"上线事件"（真正发送由校时模块在
          // 确认订阅就绪后执行；同一连接内重复 login 不会重复触发）。
          onGatewayOnline(ackGwId ?? gwId);
          return;
        }
        case UPLINK_HEARTBEAT: {
          const ack = await handleHeartbeat(body, ctx);
          await publishAck(METHODS.HEARTBEAT, gwId!, ack);
          return;
        }
        case UPLINK_DATA_REPORT: {
          const ack = await handleDataReport(body, ctx);
          await publishAck(METHODS.DATA_REPORT, gwId!, ack);
          return;
        }
        case UPLINK_ALARM_REPORT: {
          const ack = await handleAlarmReport(body, ctx);
          await publishAck(METHODS.ALARM_REPORT, gwId!, ack);
          return;
        }
        case UPLINK_NTP: {
          const ack = await handleNtp(body, ctx);
          await publishAck(METHODS.NTP, gwId!, ack);
          return;
        }
        default:
          return;
      }
    } catch (error: any) {
      console.error(`[FSU] 处理失败: topic=${topic}, method=${method}, id=${id}, gwId=${gwId}`, error);
      // 内部异常映射为协议 -1（操作失败），保持对外协议一致
      if (gwId) await publishAck(methodLower, gwId, buildAck(method, id, CODES.FAILED));
    }
  });
  return true;
}

// ============================================================
// 对外导出
// ============================================================
export * from './constants';
export * from './types';
export * from './topics';
export * from './session';
export {
  getData, getAlarm, setData, reboot, ota, ntp, nextMessageId,
  pendingCount, hasPublisher, rejectAllPending, DownstreamError, codeMessage,
  decodeGetDataResponse, decodeGetAlarmResponse, ackMessage,
} from './downstream';
// 平台主动校时（上线校时 + 定时校时）
export {
  initNtpSync, startNtpScheduler, stopNtpScheduler,
  onGatewayOnline, onGatewayOffline, onGatewaySubscribed,
  ntpSyncState, resetNtpSyncState,
} from './ntpSync';
export type { NtpSyncDeps, NtpSyncRecord, NtpSyncType } from './ntpSync';
// 注：SET_DATA_MAX_ITEMS / GET_DATA_MAX_DEV_IDS 由上方 `export * from './constants'` 导出
export { MAX_PAYLOAD_BYTES };
