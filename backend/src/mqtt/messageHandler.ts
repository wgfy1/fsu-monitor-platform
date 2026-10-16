import database from '../models/database';
import { routeUplink } from '../protocols/fsu';

// ============================================================
// 业务 Topic 路由（handleDeviceMessage 中按 topic 前缀分发）：
//   厂家协议: gw/v1/#                由 protocols/fsu 适配层处理；
//                                    适配层不认的方法（如 uploadDevInfo）落到本文件的厂家扩展分支
//   旧物模型: fsu/{deviceId}/data|status|event —— 已随旧协议整体下线删除
//
// 该模块同时被两层接入路径调用，保证共用同一套解析逻辑：
//   - Broker 层（aedes publish 事件，内置 Broker 模式主路径）
//   - Client 层（外部 Broker 模式下客户端订阅兜底）
//
// ⚠️ 厂家《网关 MQTT 通信协议》定义的方法（login/heartbeat/dataReport/
//    alarmReport/ntp 以及下行请求响应）**已全部迁移**到 protocols/fsu，
//    本文件不再实现它们，避免同一路径出现两套实现。
// ============================================================




/**
 * 厂家协议消息入口（gw/v1/#）
 *
 * 1) 先交给 protocols/fsu 适配层：协议定义的 login/heartbeat/dataReport/
 *    alarmReport/ntp 与平台下行请求的响应都在那里处理（含过期过滤、会话、落库、回响应）。
 * 2) 适配层返回 false（不是协议定义的方法）时，走本文件的兼容分支：
 *    - uploadDevInfo：厂家固件随 login 周期下发的电表字典（协议文档未定义，抓包实测存在）
 *    - 其它未定义方法：仅留痕忽略（旧物模型兜底链路已随旧协议下线，不再落库）
 */
async function handleGatewayProtocol(deviceId: string | null, topic: string, message: Buffer): Promise<void> {
  const handled = await routeUplink(topic, message, null);
  if (handled) return;

  const parts = topic.split('/');
  const id = deviceId || parts[2];
  if (!id) {
    console.warn(`[MQTT] 厂家协议 topic 缺少设备ID: ${topic}`);
    return;
  }

  let payload: any;
  try {
    payload = JSON.parse(message.toString());
  } catch {
    console.log(`[MQTT] 厂家协议消息不是 JSON，已忽略: ${topic}`);
    return;
  }

  // 厂家设备信息上传（协议文档未定义，抓包实测存在）：
  // gw/v1/uploadDevInfo/{mac}，params 为子设备电表字典
  // [{ devId, devName, meters: [{ meterId, meterName, meterType }] }]
  // 只存字典（device_meters 表）供按名称映射展示；不写测量数据、不更新 last_seen。
  if (topic.startsWith('gw/v1/uploadDevInfo/') || payload.method === 'uploadDevInfo') {
    const uId = parts[3] || id;
    const devs = Array.isArray(payload.params) ? payload.params : [];
    let meterCount = 0;
    for (const d of devs) meterCount += Array.isArray(d?.meters) ? d.meters.length : 0;
    await database.run(
      `INSERT INTO device_meters (device_id, meters_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET meters_json = excluded.meters_json, updated_at = excluded.updated_at`,
      [uId, JSON.stringify(devs), payload.timestamp ?? Date.now()]
    );
    console.log(`[MQTT] 厂家设备信息: ${uId}, 子设备 ${devs.length} 台, 电表点 ${meterCount} 个 (已存字典)`);
    return;
  }

  // 其它未定义方法：旧物模型兜底链路已随旧协议下线，这里只留痕，不再落库
  console.warn(`[MQTT] 厂家未定义方法已忽略: topic=${topic}, method=${payload?.method ?? '(无)'}`);
}

/**
 * 统一设备消息入口：按 Topic 前缀分发
 * @param deviceId 调用方提供的权威设备ID；null 时由各处理器从 topic 提取
 */
export async function handleDeviceMessage(
  deviceId: string | null,
  topic: string,
  message: Buffer,
): Promise<void> {
  try {
    // 忽略 $SYS 等 Broker 保留 Topic（$ 开头）
    if (topic.startsWith('$')) return;

    // 平台回给设备的 ack（sc/v1/...）不是设备上报，跳过避免二次处理
    if (topic.startsWith('sc/v1/')) return;

    if (topic.startsWith('gw/v1/')) {
      await handleGatewayProtocol(deviceId, topic, message);
    } else {
      // 旧物模型 Topic（fsu/{deviceId}/data|status|event）已随旧协议下线
      console.warn(`[MQTT] 未匹配厂家协议 Topic，已忽略: ${topic}`);
    }
  } catch (error) {
    console.error('[MQTT] 处理消息失败:', error);
  }
}
