/**
 * 厂家协议上行消息处理器（协议 4.1 ~ 4.4、4.8）
 *
 * 分层：Broker/Client → topic 路由 → **本文件（协议层）** → 现有业务 service
 *   login       → session + DeviceService.upsertDevice
 *   heartbeat   → session + DeviceService.setHeartbeat（复用既有在线状态机制）
 *   dataReport  → aggregateMeters → devices.latest_meters + fsu_data_history（厂家原始点）
 *   alarmReport → AlarmService（复用既有告警与推送链路）
 *   ntp         → 仅按协议回时间
 *
 * 本文件不直接写库、不直接读库（除经 service），也不自行判断消息新鲜度（见 expire.ts）。
 */
import DeviceService from '../../services/deviceService';
import DataService from '../../services/dataService';
import AlarmService from '../../services/alarmService';
import {
  CODES, CODE_MESSAGE,
  loginAuthUsername, loginAuthPassword, isLoginAuthEnforced, isLoginAuthConfigured,
  FSU_ALARM_SEVERITY, FSU_ALARM_FALLBACK_NAME,
} from './constants';
import { normalizeGwId } from './topics';
import {
  validateLoginParams, validateHeartbeatParams, validateDataReport,
  validateAlarmReport, validateNtpParams,
} from './codec';
import {
  upsertLoginSession, touchHeartbeat, getSession, isLoggedIn,
} from './session';
import {
  aggregateMeters, mergeMeters, resolveHistoryTimeMs, MetersByDev,
  findMeterName,
} from './mapping';
// 字典读取独立成模块（避免 handlers → alarmService → notifyService → handlers 循环依赖）
import { loadMeterDictionary } from './dictionary';
import { FsuAck } from './types';

/** 处理上下文（由路由层提供） */
export interface HandlerContext {
  /** 平台设备ID（= gwId，见报告"设备映射"章节） */
  deviceId: string;
  /** MQTT clientId（协议 3.4：clientId = gwId） */
  clientId: string | null;
  /** 上行 topic 中的 gwId（login 主题没有，为 null） */
  topicGwId: string | null;
}

/**
 * 构造平台响应（协议各节的"平台响应"表）
 * 所有响应统一：{ id, timestamp(平台当前毫秒), method, code, msg }
 */
export function buildAck(method: string, id: string, code: number, msg?: string): FsuAck {
  return {
    id,
    timestamp: Date.now(),
    method,
    code,
    msg: msg ?? CODE_MESSAGE[code] ?? (code === CODES.SUCCESS ? 'success' : ''),
  };
}

/** 认证失败的 login 响应（协议 4.1：code = 1） */
export function buildLoginAuthFailedAck(id: string): FsuAck {
  return buildAck('login', id, CODES.LOGIN_AUTH_FAILED);
}

/**
 * login 成功日志降噪：gwId → 上次打印时间
 * 厂家固件每 ~10 秒重发 login 作为心跳，逐条打印会刷屏（沿用 broker 层原有做法）。
 */
const lastLoginLogAt = new Map<string, number>();

/**
 * 4.1 网关登录
 *
 * 认证说明（用户要求 §2）：
 *   MQTT CONNECT 层仍用平台统一账号（MQTT_USERNAME / MQTT_PASSWORD，未改动）；
 *   本函数处理的是 **login 报文里 params.username/password 这层平台认证信息**，
 *   与 MQTT 账号无关。两者都不新增"一机一密"。
 *   password 一律不落日志（日志只输出 gwId / username / version）。
 *
 * @returns 响应 ACK；认证通过时会登记会话
 */
export async function handleLogin(body: any, ctx: HandlerContext): Promise<FsuAck> {
  const id = String(body?.id ?? '');
  const parsed = validateLoginParams(body);
  if (!parsed.ok) {
    // 缺少 mac 时无法构造响应 topic（sc/v1/login/{gwId}），因此只记录不回包；
    // 其它字段缺失仍会回参数错误。错误日志带 method + id 便于排查。
    console.warn(`[FSU] login 报文非法已拒绝: method=login, id=${id}, 原因=${parsed.reason}`);
    return buildAck('login', id, parsed.code ?? CODES.PARAM_ERROR);
  }
  const p = parsed.value!;
  // gwId 从 params.mac 规范化（协议 3.3：去冒号 + 小写）
  const gwId = normalizeGwId(p.mac);
  if (!gwId) {
    return buildAck('login', id, CODES.PARAM_ERROR, 'mac 非法');
  }

  // === FSU login 业务认证（只认 FSU_LOGIN_*，与 MQTT 账号完全无关）===
  const expectedUser = loginAuthUsername();
  const expectedPass = loginAuthPassword();
  const configured = isLoginAuthConfigured();
  const authOk = configured && p.username === expectedUser && p.password === expectedPass;
  if (isLoginAuthEnforced() && !authOk) {
    // 诊断信息只包含 gwId / 对端 username / 配置状态，绝不记录任何 password
    if (!configured) {
      console.warn(
        `[FSU] login 认证失败(服务端未配置凭据): gwId=${gwId}, 对端 username=${p.username}` +
        ' —— 请在 .env 配置 FSU_LOGIN_USERNAME / FSU_LOGIN_PASSWORD'
      );
    } else {
      console.warn(
        `[FSU] login 认证失败: gwId=${gwId}, 对端 username=${p.username}, ` +
        `服务端期望 username=${expectedUser}（password 不打印）`
      );
    }
    return buildLoginAuthFailedAck(id);
  }

  // === 登记会话 ===
  const session = upsertLoginSession({
    gwId,
    clientId: ctx.clientId,
    version: p.version,
    upgradeVersion: p.upgradeVersion,
    hardwareVersion: p.hardwareVersion,
  });

  // === 复用既有设备模型：平台设备ID = gwId，login 即上线 ===
  // 协议 4.1 的 version / upgradeVersion / hardwareVersion 一并写入既有列
  // （softwareVersion / hardwareVersion 两列本就存在，不新增数据库字段）：
  //   - version        → devices.softwareVersion（详情页"版本"展示的即是它）
  //   - hardwareVersion→ devices.hardwareVersion（详情页本轮不展示，仅留档）
  //   - upgradeVersion → 无对应列，只保留在会话与日志中，不为此扩表
  // 字段缺省时传 undefined，upsertDevice 会跳过该列，不会把已有值清空。
  await DeviceService.upsertDevice(gwId, '', Date.now(), 'online', {
    deviceSn: p.mac,
    protocolType: 'vendor',
    softwareVersion: p.version,
    hardwareVersion: p.hardwareVersion,
  });

  // 日志降噪：厂家固件每 ~10 秒重发一次 login，15 秒内重复只记一次
  // （响应每次都照发，不能因为降噪而漏响应）
  const now = Date.now();
  if (now - (lastLoginLogAt.get(gwId) ?? 0) > 15000) {
    lastLoginLogAt.set(gwId, now);
    console.log(
      `[FSU] login 成功: gwId=${gwId}, version=${p.version}` +
      (p.hardwareVersion ? `, hardwareVersion=${p.hardwareVersion}` : '') +
      (p.upgradeVersion ? `, upgradeVersion=${p.upgradeVersion}` : '')
    );
  }
  void session;
  return buildAck('login', id, CODES.SUCCESS);
}

/**
 * 4.2 心跳
 *
 * 在线状态处理（用户要求 §6.4~6.7）：复用**既有**机制，不新建第二套：
 *   - 网关本体：DeviceService.setHeartbeat → devices.status='online' + last_heartbeat
 *     （只证明在线，不刷新 last_seen、不产生测量数据，避免"有上报"假象）
 *   - 子设备 online/offline 列表：devId 不是平台设备（平台设备 = 网关），
 *     若把 devId 交给 upsertDevice 会凭空造出设备行、破坏现有设备模型，
 *     因此列表记录在网关会话（session.online/offline）中，供查询与排查。
 */
export async function handleHeartbeat(body: any, ctx: HandlerContext): Promise<FsuAck> {
  const id = String(body?.id ?? '');
  const gwId = ctx.topicGwId ?? ctx.deviceId;
  if (!isLoggedIn(gwId)) {
    // 未登录：按协议 -9（notlogin）响应，不进入业务处理
    console.warn(`[FSU] heartbeat 未登录: gwId=${gwId}`);
    return buildAck('heartbeat', id, CODES.NOT_LOGIN);
  }
  const parsed = validateHeartbeatParams(body);
  if (!parsed.ok) {
    return buildAck('heartbeat', id, parsed.code ?? CODES.PARAM_ERROR, parsed.reason);
  }
  const p = parsed.value!;
  const ts = Number(body.timestamp);

  touchHeartbeat({
    gwId, online: p.online, offline: p.offline,
    ICCID: p.ICCID, carrier: p.carrier, vpnip: p.vpnip,
  });
  // 最后心跳：复用既有 setHeartbeat（只更新 last_heartbeat + 在线状态，
  // 不刷新 last_seen、不产生测量数据）。MQTT 的 ping/pong 不参与此时间。
  await DeviceService.setHeartbeat(gwId, ts);
  // ICCID（协议 4.2 可选字段，一个程序周期只上报一次）：落既有 devices.iccid 列，
  // 未上报/空值时不覆盖，详情页显示 "-"
  if (p.ICCID) {
    await DeviceService.updateDeviceIccid(gwId, p.ICCID);
  }

  console.log(
    `[FSU] heartbeat: gwId=${gwId}, 在线子设备 ${p.online.length} 台, 离线 ${p.offline.length} 台` +
    (p.offline.length > 0 ? `: ${p.offline.join(',')}` : '') +
    (p.carrier ? `, carrier=${p.carrier}` : '')
  );
  return buildAck('heartbeat', id, CODES.SUCCESS);
}

/** 读取设备已有的电表快照（增量合并用） */
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
 * 4.3 数据上报
 *
 * 时间语义（用户要求 §7.4 / §7.5）：
 *   isHistory=0 → 使用协议消息时间（信封 timestamp，毫秒）
 *   isHistory=1 → 使用 historyTime 表达历史数据时间（单位判定见 mapping.resolveHistoryTimeMs）；
 *                 历史时间只用于**历史数据行**，设备"最后上报时间"仍用当前消息时间，
 *                 避免历史数据把设备 last_seen 拉回过去而被误判离线。
 *
 * isFull 语义（用户要求 §7.6）：全量替换 / 增量合并（mapping.mergeMeters）。
 */
export async function handleDataReport(body: any, ctx: HandlerContext): Promise<FsuAck> {
  const id = String(body?.id ?? '');
  const gwId = ctx.topicGwId ?? ctx.deviceId;
  if (!isLoggedIn(gwId)) {
    console.warn(`[FSU] dataReport 未登录: gwId=${gwId}`);
    return buildAck('dataReport', id, CODES.NOT_LOGIN);
  }
  const parsed = validateDataReport(body);
  if (!parsed.ok) {
    return buildAck('dataReport', id, parsed.code ?? CODES.PARAM_ERROR, parsed.reason);
  }
  const devices = parsed.value!;

  // === 排查用诊断日志（纯打印，不参与任何判断与计算）===
  // 目的：区分 isHistory / historyTime 是**厂家原样上报**，还是平台换算/加工后的结果。
  // 因此这里打印的是 body.params 里的原始值与类型，而不是校验后的对象。
  const rawParams: any[] = Array.isArray(body?.params) ? body.params : [];
  console.log(
    `[FSU][诊断] dataReport 原始字段: msgTimestamp=${JSON.stringify(body?.timestamp)}` +
    `(typeof ${typeof body?.timestamp}) entries=` +
    JSON.stringify(rawParams.map((p: any) => ({
      devId: p?.devId,
      isHistory: p?.isHistory, isHistoryType: typeof p?.isHistory,
      historyTime: p?.historyTime, historyTimeType: typeof p?.historyTime,
      isFull: p?.isFull,
      meterCount: Array.isArray(p?.meters) ? p.meters.length : null,
    })))
  );

  const incoming = aggregateMeters(devices);
  const fullByDev: Record<string, boolean> = {};
  for (const d of devices) fullByDev[d.devId] = d.isFull === 1;

  // 增量上报只含变化的量 → 与已有快照合并，不能丢掉未携带的量
  const existing = await loadExistingMeters(gwId);
  const merged = mergeMeters(existing, incoming, fullByDev);

  // 数据时间：实时用消息时间；历史上报用 historyTime（取第一条历史记录的时间）
  const msgTs = Number(body.timestamp);
  const historyEntry = devices.find((d) => d.isHistory === 1);
  const historyMs = historyEntry ? resolveHistoryTimeMs(historyEntry.historyTime) : null;
  const dataTs = historyMs ?? msgTs;

  // === 排查用诊断日志：时间取值链路（纯打印）===
  console.log(
    `[FSU][诊断] 时间取值: msgTs=${msgTs}(${new Date(msgTs).toISOString()}) ` +
    `历史条目=${historyEntry ? historyEntry.devId : '无'} ` +
    `historyTime原始值=${JSON.stringify(historyEntry?.historyTime)} ` +
    `→ 换算后=${historyMs}(${historyMs ? new Date(historyMs).toISOString() : 'null'}) ` +
    `→ 入库用 dataTs=${dataTs}(${new Date(dataTs).toISOString()})`
  );

  // === 历史时间异常诊断（纯打印，不改变入库逻辑）===
  // 厂家协议要求 isHistory=1 时携带 historyTime；实测网关**未携带**（原始报文里没有该键）。
  // 此时 dataTs 会退回 msgTs —— 那是"消息发送时间"，**不是**"历史数据实际发生时间"。
  // 因此必须逐条显式留痕，绝不允许静默地把 msgTs 当成真实历史采集时间。
  for (const d of devices) {
    if (Number(d.isHistory) !== 1) continue;
    if (resolveHistoryTimeMs(d.historyTime) !== null) continue;
    console.warn(
      `[FSU][历史时间异常] gwId=${gwId}, devId=${d.devId}, isHistory=1, ` +
      `historyTime=missing (原始值=${JSON.stringify(d.historyTime)}, typeof=${typeof d.historyTime}), ` +
      `msgTimestamp=${msgTs}(${new Date(msgTs).toISOString()}), ` +
      `本次入库 dataTs=${dataTs}(${new Date(dataTs).toISOString()}), ` +
      `原因=网关历史数据未携带historyTime`
    );
  }

  // === 最新快照回写（devices.latest_meters，设备实时数据的唯一来源）===
  // 直接存厂家 FSU 原始点表 { devId: { meterId: value } }：merged 由 aggregateMeters +
  // mergeMeters 得出，多 devId / 多 meterId 互不覆盖，本条未携带的点按增量语义保留。
  // 不经任何旧物模型转换、不写 device_data、不读 fsu_data_history。
  // last_seen 用**本条消息时间**（历史上报也用消息时间，避免 last_seen 被拉回过去而误判离线）。
  // 失败不阻断本条上报（历史链路与门磁联动继续），但必须打印含 gwId/devId 的错误日志。
  try {
    const curDevice = await DeviceService.getDeviceById(gwId);
    await DeviceService.upsertDevice(gwId, curDevice?.product_id ?? '', msgTs, 'online', {
      latestMeters: JSON.stringify(merged),
    });
  } catch (err: any) {
    console.error(
      `[FSU] latest_meters 回写失败: gwId=${gwId}, devId=${Object.keys(merged).join(',')}, ` +
      `错误=${err?.message || err}`
    );
  }

  // === 厂家 FSU 正式历史写入（唯一正式历史链路）===
  // 每个 (devId, meterId) 独立成行，value 保持厂家原始 string，不做任何物模型转换。
  // 写入的是**本条报文实际携带的点**（不是合并后的快照），因此不会把未上报的量写进历史。
  // 失败不阻断本条上报（latest_meters 已成功更新），但必须打印含 gwId/devId/点数的错误日志。
  {
    const points = devices.flatMap((d) =>
      d.meters.map((m) => ({
        deviceId: gwId,
        devId: d.devId,
        meterId: m.meterId,
        value: String(m.value),
        isHistory: d.isHistory,
        dataTimestamp: dataTs,   // 历史数据用 historyTime 换算值，实时用报文 timestamp
      }))
    );
    try {
      const n = await DataService.saveFsuHistory(points);
      console.log(
        `[FSU] 历史写入: gwId=${gwId}, devId ${Object.keys(incoming).length} 个` +
        ` (${Object.keys(incoming).join(',')}), 点 ${n} 条, dataTs=${dataTs}, isHistory=${devices[0]?.isHistory ?? 0}`
      );
    } catch (err: any) {
      console.error(
        `[FSU] 历史写入失败: gwId=${gwId}, devId=${Object.keys(incoming).join(',')}, ` +
        `点数=${points.length}, 错误=${err?.message || err}`
      );
    }
  }

  // 【已移除】门磁联动告警
  //
  // 原实现在此处读取 devId=1246001 / meterId=13160016001（门磁开关状态），
  // 自行认定 0=关门 / 1=开门 并合成一条 type='door' 的"门磁告警"、关门时再消除。
  // 移除原因：
  //   1) 厂家字典只给出该点的 meterName="门磁开关状态"、meterType=1，**未定义枚举取值**，
  //      0/1 的语义是平台自己猜的；
  //   2) 厂家另有正式的告警点（meterType=2 的点位）由 alarmReport 上报，
  //      平台自造的门磁告警会与之重复；
  //   3) 'door' 这套分类在本项目里是平台内部自造的，不是厂家协议字段。
  // 现在：门磁相关的告警**只来自厂家 alarmReport**，平台不再从遥测值推断告警。
  // 门磁开关状态的**实时值**仍照常落库（latest_meters / fsu_data_history），
  // 展示层可原样显示，但不再据此产生告警。

  console.log(
    `✓ [FSU] dataReport: gwId=${gwId}, 子设备 ${Object.keys(incoming).length} 台, ` +
    `isFull=${devices[0]?.isFull}, isHistory=${devices[0]?.isHistory}` +
    (historyMs ? `, historyTime=${new Date(historyMs).toISOString()}` : '') +
    (devices[0]?.isHistory === 1 ? '（注意：historyTime 单位协议未标注，按量级判定）' : '')
  );
  return buildAck('dataReport', id, CODES.SUCCESS);
}

/**
 * 4.4 告警上报
 *
 * 去重/关联（用户要求 §8.1）：以 **serialNo** 为准，不再按类型+文本猜测。
 *   alarmFlag=1 → 该 serialNo 未解决则忽略（重复上报），否则按协议时间创建
 *   alarmFlag=0 → 按 serialNo 找到告警并消除，优先使用协议 clearTime
 * alarmLevel 一并保留；告警创建后仍走既有 AlarmService → 告警推送链路（未改动）。
 */
export async function handleAlarmReport(body: any, ctx: HandlerContext): Promise<FsuAck> {
  const id = String(body?.id ?? '');
  const gwId = ctx.topicGwId ?? ctx.deviceId;
  if (!isLoggedIn(gwId)) {
    console.warn(`[FSU] alarmReport 未登录: gwId=${gwId}`);
    return buildAck('alarmReport', id, CODES.NOT_LOGIN);
  }
  const parsed = validateAlarmReport(body);
  if (!parsed.ok) {
    return buildAck('alarmReport', id, parsed.code ?? CODES.PARAM_ERROR, parsed.reason);
  }
  const p = parsed.value!;

  // === 子设备归属：直接用厂家上报的 devId ===
  // alarms.type 存厂家 devId 原文（如 '1246001'）。平台**不再**把 devId 翻译成
  // battery/ac/dc/env/door 这类自造分类——厂家协议里没有这种分类字段。
  // 前端按 devId 分组，并用厂家字典里的 devName 显示子设备名称。
  // （validateAlarmReport 已保证 devId 非空，这里不会再回退）
  const alarmType = p.devId;

  // === 告警名称：只来自厂家 uploadDevInfo 字典 ===
  // 平台不内建任何 meterId→名称 表；字典里有什么就显示什么，
  // 厂家改点名称 / 加子设备，平台无需改代码。
  const dictJson = await loadMeterDictionary(gwId);
  const cnMeterName = findMeterName(dictJson, p.devId, p.meterId);
  // 字典缺失 / 查不到 / 名称为空时**不伪造名称**，回退到通用文案，
  // 并把 devId + meterId 一并写进文本，保证可排查。
  // 文案面向用户界面，因此不含"厂家"字样、也不暴露内部枚举。
  const message = cnMeterName
    ?? `${FSU_ALARM_FALLBACK_NAME}（设备 ID：${p.devId}，点位 ID：${p.meterId}）`;
  if (!cnMeterName) {
    console.warn(
      `[FSU] alarmReport 点位名称未命中厂家字典（回退通用名称）: gwId=${gwId}, ` +
      `devId=${p.devId}, meterId=${p.meterId}, 字典=${dictJson ? '已上报但无此点位' : '尚未上报'}`
    );
  }

  // alarmTime / clearTime 协议为**秒级**（4.6 表明确"秒级时间戳"），落库统一转毫秒
  const alarmTimeMs = p.alarmTime * 1000;
  const clearTimeMs = p.clearTime !== undefined ? p.clearTime * 1000 : undefined;

  if (p.alarmFlag === 1) {
    const dup = await AlarmService.findUnresolvedBySerialNo(gwId, p.serialNo);
    if (dup) {
      console.log(`[FSU] alarmReport 重复 serialNo=${p.serialNo} 已忽略 (gwId=${gwId})`);
      return buildAck('alarmReport', id, CODES.SUCCESS);
    }
    // severity 写中性占位值：协议 4.4 只定义 alarmLevel ∈ [1,5]，
    // **没有**给出它与 critical/warning 的对应关系，平台不做这个映射。
    // 厂家原始级别完整保存在 alarm_level 列，展示与统计都用它。
    await AlarmService.createAlarm(
      gwId, alarmType, FSU_ALARM_SEVERITY, message,
      // value 存**告警点编号**(meterId)，供详情页展示；serialNo 已在独立列中
      p.meterId, 'MQTT',
      { serialNo: p.serialNo, alarmLevel: p.alarmLevel, createdAtMs: alarmTimeMs, isHistory: p.isHistory },
    );
    console.log(
      `[FSU] alarmReport 产生: gwId=${gwId}, serialNo=${p.serialNo}, level=${p.alarmLevel}, ` +
      `devId=${p.devId}, meterId=${p.meterId}` + (p.isHistory === 1 ? ' (历史告警)' : '')
    );
  } else {
    const target = await AlarmService.findUnresolvedBySerialNo(gwId, p.serialNo);
    if (!target) {
      console.log(`[FSU] alarmReport 消除但未找到告警: gwId=${gwId}, serialNo=${p.serialNo}（按已消除处理）`);
      return buildAck('alarmReport', id, CODES.SUCCESS);
    }
    await AlarmService.resolveAlarm(target.id, null, clearTimeMs);
    console.log(
      `[FSU] alarmReport 消除: gwId=${gwId}, serialNo=${p.serialNo}, alarmId=${target.id}` +
      (clearTimeMs ? `, clearTime=${new Date(clearTimeMs).toISOString()}` : '')
    );
  }
  return buildAck('alarmReport', id, CODES.SUCCESS);
}

/**
 * 4.8 网关请求校时
 * 只用响应 timestamp 表达当前时间；timezone 为可选回显（协议：不携带即不更改时区）。
 * 不实现任何复杂校时逻辑。
 */
export async function handleNtp(body: any, ctx: HandlerContext): Promise<FsuAck> {
  const id = String(body?.id ?? '');
  const gwId = ctx.topicGwId ?? ctx.deviceId;
  const parsed = validateNtpParams(body);
  if (!parsed.ok) {
    return buildAck('ntp', id, parsed.code ?? CODES.PARAM_ERROR, parsed.reason);
  }
  console.log(`[FSU] ntp 校时: gwId=${gwId}, timezone=${parsed.value!.timezone}`);
  // 响应不带 data.timezone：表示不更改网关时区（协议 4.8 说明）
  return buildAck('ntp', id, CODES.SUCCESS);
}

/** 查询网关会话（供健康检查/下行前置校验） */
export { getSession };
