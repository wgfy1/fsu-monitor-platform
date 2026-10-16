/**
 * 厂家《网关 MQTT 通信协议》V1.0.0（文件内修改记录标注 V1.0.2）常量
 *
 * 本文件是协议事实的**唯一来源**：topic 模板、方法名、错误码、MQTT 参数、
 * 报文上限、过期时间默认值都从这里取，其它模块不得自行硬编码字面量。
 *
 * 协议依据：PDF 3.3 主题说明 / 3.4 MQTT 参数 / 3.5 Method 说明 / 3.7 错误码。
 */

/** 大版本号（协议 3.3：v1 是当前的大版本号） */
export const PROTOCOL_VERSION = 'v1';

/** 网关上行 topic 前缀：gw/v1/... */
export const UPLINK_PREFIX = `gw/${PROTOCOL_VERSION}`;

/** 平台下行 topic 前缀：sc/v1/... */
export const DOWNLINK_PREFIX = `sc/${PROTOCOL_VERSION}`;

/**
 * 网关登录 topic（协议 3.3：网关登录 gw/v1/login）
 * 注意：login 的 topic 中**不含 gwId**，gwId 必须从报文 params.mac 解析。
 */
export const TOPIC_LOGIN = `${UPLINK_PREFIX}/login`;

/** 平台下发 OTA 的 topic 段名（协议 4.10 主题：sc/v1/ota/$(gwId)） */
export const METHOD_OTA_TOPIC = 'ota';

/**
 * OTA 报文体里的 method 值（协议 4.10 字段表与 Demo 均为 "OTA"）
 *
 * ⚠️ 厂家文档大小写不一致：3.5 Method 说明表里写的是小写 `ota`，
 * 而 4.10 的字段表（"method | 方法名称 | 是 | string | OTA"）与 Demo
 * （"method":"OTA"，注释"固定值：OTA"）都是大写。
 * 本实现以 4.10 为准：**topic 用小写 ota，报文体 method 发送大写 "OTA"**，
 * 接收响应时对 "OTA" / "ota" 两种写法都兼容（见 normalizeMethod）。
 */
export const METHOD_OTA_BODY = 'OTA';

/** 协议方法名（3.5 Method 说明） */
export const METHODS = {
  /** 上行：网关向平台发送注册信息 */
  LOGIN: 'login',
  /** 上行：网关向平台发送心跳 */
  HEARTBEAT: 'heartbeat',
  /** 上行：网关主动上报实时数据 */
  DATA_REPORT: 'dataReport',
  /** 上行：网关主动上报告警 */
  ALARM_REPORT: 'alarmReport',
  /** 上行：网关请求校时 */
  NTP: 'ntp',
  /** 下行：平台获取网关实时数据 */
  GET_DATA: 'getData',
  /** 下行：平台获取网关实时告警 */
  GET_ALARM: 'getAlarm',
  /** 下行：平台控制设备信号量 */
  SET_DATA: 'setData',
  /** 下行：平台重启网关(模块) */
  REBOOT: 'reboot',
  /** 下行：平台下发 OTA 升级（topic 段名） */
  OTA: METHOD_OTA_TOPIC,
} as const;

/** 平台需要订阅的网关上行 topic（协议 3.3 + 4.x） */
export const UPLINK_SUBSCRIPTIONS = [
  TOPIC_LOGIN,
  `${UPLINK_PREFIX}/heartbeat/+`,
  `${UPLINK_PREFIX}/dataReport/+`,
  `${UPLINK_PREFIX}/alarmReport/+`,
  `${UPLINK_PREFIX}/ntp/+`,
  // 下行请求对应的网关响应 topic
  `${UPLINK_PREFIX}/getData/+`,
  `${UPLINK_PREFIX}/getAlarm/+`,
  `${UPLINK_PREFIX}/setData/+`,
  `${UPLINK_PREFIX}/reboot/+`,
  `${UPLINK_PREFIX}/ota/+`,
] as const;

/**
 * 错误码（协议 3.7）
 * 平台端只允许使用这些码，不自行发明新码。
 */
export const CODES = {
  SUCCESS: 0,
  /** 操作失败 */
  FAILED: -1,
  /** 参数错误 */
  PARAM_ERROR: -2,
  /** 未登录 */
  NOT_LOGIN: -9,
  /** 非法操作 */
  ILLEGAL_OPERATION: -10,
  /** 操作超时 */
  TIMEOUT: -14,
  /** 设备不存在 */
  DEVICE_NOT_FOUND: -16,
  /** 量不存在 */
  METER_NOT_FOUND: -17,
  /** 缓存已满 */
  CACHE_FULL: -18,
  /** OTA 密码校验错误 */
  OTA_PASSWORD_ERROR: -21,
  /** OTA 硬件版本错误 */
  OTA_HARDWARE_VERSION_ERROR: -22,
  /** OTA CRC 校验错误 */
  OTA_CRC_ERROR: -23,
  /**
   * login 专用（协议 4.1：code 0-成功 1-认证失败）
   * 注意 1 不是通用错误码，只用于 login 响应。
   */
  LOGIN_AUTH_FAILED: 1,
} as const;

/** 错误码 → 默认 msg（协议 3.7 的错误消息列） */
export const CODE_MESSAGE: Record<number, string> = {
  [CODES.SUCCESS]: 'success',
  [CODES.FAILED]: '操作失败',
  [CODES.PARAM_ERROR]: '参数错误',
  [CODES.NOT_LOGIN]: 'notlogin',
  [CODES.ILLEGAL_OPERATION]: '非法操作',
  [CODES.TIMEOUT]: '操作超时',
  [CODES.DEVICE_NOT_FOUND]: '设备不存在',
  [CODES.METER_NOT_FOUND]: '量不存在',
  [CODES.CACHE_FULL]: '缓存已满',
  [CODES.OTA_PASSWORD_ERROR]: '固件升级：密码校验错误',
  [CODES.OTA_HARDWARE_VERSION_ERROR]: '固件升级：硬件版本错误',
  [CODES.OTA_CRC_ERROR]: '固件CRC校验错误',
  [CODES.LOGIN_AUTH_FAILED]: '认证失败',
};

/** 报文最大长度（协议 3.2 a：2097152 字节） */
export const MAX_PAYLOAD_BYTES = 2097152;

/** MQTT 参数（协议 3.4）—— 网关侧取值，平台侧据此校验/记录 */
export const MQTT_PARAMS = {
  KEEPALIVE_SECONDS: 60,
  CLEAN_START: true,
  RETAIN: false,
  QOS: 0 as const,
  SSL: false,
  WILL_TOPIC: null,
} as const;

/**
 * 消息过期时间（协议 3.6 b：建议默认消息过期时间为 3 秒）
 * 可用环境变量 MQTT_MESSAGE_EXPIRE_SECONDS 覆盖，未配置时为 3。
 */
export function messageExpireMs(): number {
  const raw = Number(process.env.MQTT_MESSAGE_EXPIRE_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return 3000;
  return Math.floor(raw * 1000);
}

/**
 * 不参与过期过滤的方法（协议 3.6 b：login 和 ntp 除外）
 */
export const EXPIRE_EXEMPT_METHODS: readonly string[] = [METHODS.LOGIN, METHODS.NTP];

/** 下行请求默认响应超时（毫秒），可用环境变量覆盖 */
export function downstreamTimeoutMs(): number {
  const raw = Number(process.env.FSU_DOWNSTREAM_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 10000;
  return Math.floor(raw);
}

/** reboot 的 type 取值（协议 4.9：1-sys 2-app 3-4g 4-vpn） */
export const REBOOT_TYPES = { SYS: 1, APP: 2, G4: 3, VPN: 4 } as const;

/**
 * 一次 setData 允许携带的设置项上限（协议 4.7 未规定上限）
 *
 * 这是**平台侧的保护性限制**，不是协议字段：协议只要求 params 为对象数组，
 * 但未限制条数。上限用于防止一次下行把异常大的报文发进 MQTT
 * （协议 3.2 报文上限 2MB，但下行也应保持小报文）。
 */
export const SET_DATA_MAX_ITEMS = 50;

/**
 * getData / getAlarm 一次允许请求的 devId 数量上限（协议 4.5/4.6 未规定上限）
 * 同样是平台侧保护性限制，避免一次下行报文过大。
 */
export const GET_DATA_MAX_DEV_IDS = 200;

// ============================================================
// FSU 告警的平台内部约定（不含任何厂家分类语义）
// ============================================================

/**
 * FSU 告警写库时 alarms.severity 的占位值
 *
 * 协议 4.4 只定义 alarmLevel ∈ [1,5]，**没有**给出它与 critical/warning
 * 之间的对应关系。因此平台不做这个映射（做了就是把自造规则冒充厂家规则）：
 *   - alarms.severity 该列 NOT NULL，统一写本占位值，表示"平台未定级"；
 *   - 展示与统计一律使用厂家原始级别 alarms.alarm_level。
 */
export const FSU_ALARM_SEVERITY = 'vendor';

/**
 * 字典里查不到点位名称（meterName）时的告警回退文案
 *
 * ⚠️ 该文案会直接显示在用户界面（告警中心等），因此不使用"厂家"字样，
 * 也绝不伪造厂家名称；回退时附上 devId / meterId 保证可排查。
 */
export const FSU_ALARM_FALLBACK_NAME = '未知告警';

// ============================================================
// 平台主动校时（协议 4.8 ntp 的平台→网关方向）
// ============================================================
//
// 现行为：**设备上线时校时一次 + 在线期间按前端配置的间隔定时校时**。
// 报文使用 4.8「平台响应」形状（构造见 downstream.ts 的 ntp()），该形状已在
// 真实设备 00534c080213 上验证有效。
//
// ⚠️ 旧实现（"普通上行消息因 timestamp 过期被丢弃时触发校时"）已**整体移除**：
//    - 不再由 heartbeat/dataReport/alarmReport 过期触发校时；
//    - 不再发送 params.timezone 形状；
//    - FSU_NTP_SYNC_COOLDOWN_SECONDS / FSU_NTP_TIMEZONE 已**废弃**，
//      不再是本功能的开关，也不参与任何判定。
//    消息过期判定（默认 3000ms）与过期过滤逻辑**未做任何改动**。

/** 定时校时允许的间隔选项（小时） */
export const NTP_SYNC_INTERVAL_OPTIONS: readonly number[] = [1, 6, 12, 24, 48];

/** 定时校时默认间隔（小时）：设备未显式配置时使用 */
export const NTP_SYNC_DEFAULT_INTERVAL_HOURS = 24;

/**
 * 调度器扫描周期（毫秒），可用环境变量 NTP_SCHEDULER_TICK_MS 覆盖
 * （测试用；生产保持默认 30 秒）
 */
export function ntpSchedulerTickMs(): number {
  const raw = Number(process.env.NTP_SCHEDULER_TICK_MS);
  if (!Number.isFinite(raw) || raw < 500) return 30 * 1000;
  return Math.floor(raw);
}

/**
 * 同一设备两次主动校时之间的**最小发送间隔**（毫秒）
 *
 * 兜底保护：防重复注册定时器、防上线校时与定时校时撞车、防并发发送。
 * 默认 10 秒 —— 足够拦住同一事件被触发多次（那种重复是毫秒级的），
 * 又不会误伤"设备断线后正常重连"这类合法场景（重连本身远大于 10 秒）。
 *
 * 可用环境变量 NTP_MIN_SEND_GAP_MS 覆盖（测试用）。
 */
export function ntpMinSendGapMs(): number {
  const raw = Number(process.env.NTP_MIN_SEND_GAP_MS);
  if (!Number.isFinite(raw) || raw < 0) return 10 * 1000;
  return Math.floor(raw);
}

/**
 * 后端重启后的调度宽限（毫秒）：启动后这段时间内不执行任何定时校时
 * 可用环境变量 NTP_STARTUP_GRACE_MS 覆盖（测试用；生产保持默认 60 秒）
 */
export function ntpStartupGraceMs(): number {
  const raw = Number(process.env.NTP_STARTUP_GRACE_MS);
  if (!Number.isFinite(raw) || raw < 0) return 60 * 1000;
  return Math.floor(raw);
}

/** 上线后等待"订阅建立"的最长时间（毫秒）；超时则放弃本次上线校时并留痕 */
export const NTP_ONLINE_WAIT_SUBSCRIBE_MS = 30 * 1000;

/** 定时校时间隔是否合法（只允许 NTP_SYNC_INTERVAL_OPTIONS 中的值） */
export function isValidNtpIntervalHours(v: unknown): boolean {
  const n = Number(v);
  return Number.isInteger(n) && NTP_SYNC_INTERVAL_OPTIONS.includes(n);
}

// ============================================================
// FSU login 业务认证（协议 4.1 params.username / password）
// ============================================================
//
// ⚠️ 这里是**两套彼此独立**的认证，绝不能相互绑定/回退：
//
//   A. MQTT CONNECT 层认证
//      配置：MQTT_USERNAME / MQTT_PASSWORD（当前为 platform）
//      由 mqtt/broker.ts 的 aedes.authenticate 负责，本文件**不参与、不读取**。
//
//   B. FSU login 业务认证（本节）
//      配置：FSU_LOGIN_USERNAME / FSU_LOGIN_PASSWORD
//      校验 gw/v1/login 报文中 params.username / params.password。
//
// 历史教训：曾经让 B 回退到 A 的取值，导致真实网关（login username=admin）
// 被按 MQTT 账号（platform）校验而误判为认证失败（code=1）。
// 因此这里**只读 FSU_LOGIN_\***，不做任何 MQTT_* 回退。
//
// 未配置 FSU_LOGIN_USERNAME / FSU_LOGIN_PASSWORD 时按**失败关闭（fail-closed）**处理：
// 认证一律不通过，并在服务启动时打印醒目告警，提示运维补齐配置。
// 源码中不内置任何默认账号（含 admin/admin），避免弱口令固化。
//
// 注意：凭据只从环境变量读取，password 任何情况下都不落日志。

/** login 报文期望的用户名（未配置返回空串 → 认证必失败） */
export function loginAuthUsername(): string {
  return (process.env.FSU_LOGIN_USERNAME || '').trim();
}

/** login 报文期望的密码（绝不打印；未配置返回空串 → 认证必失败） */
export function loginAuthPassword(): string {
  return process.env.FSU_LOGIN_PASSWORD || '';
}

/** FSU login 认证凭据是否已配置齐全（供启动告警与自检使用） */
export function isLoginAuthConfigured(): boolean {
  return loginAuthUsername().length > 0 && loginAuthPassword().length > 0;
}

/**
 * 启动自检：未配置 FSU login 凭据时打印醒目告警（只提示，不阻断启动）
 * 由 backend/src/index.ts 在数据库就绪后调用一次。
 */
export function warnIfLoginAuthUnconfigured(): void {
  if (isLoginAuthConfigured()) return;
  console.warn(
    '⚠ [FSU] 未配置 FSU_LOGIN_USERNAME / FSU_LOGIN_PASSWORD —— ' +
    '所有厂家网关的 gw/v1/login 都会被判为认证失败（code=1）。' +
    '请在 .env 中补齐这两个变量（与 MQTT_USERNAME/MQTT_PASSWORD 无关，不要复用 MQTT 账号）。'
  );
}

/**
 * 是否强制校验 login 报文凭据
 * 默认 true（协议 4.1 要求认证失败时返回 code=1）。
 * 若厂家网关实际发送的凭据无法与服务端对齐，可临时设 FSU_LOGIN_AUTH_ENFORCE=false
 * 先放行（此时仍会打印一次告警），待确认凭据后再恢复强制。
 */
export function isLoginAuthEnforced(): boolean {
  return String(process.env.FSU_LOGIN_AUTH_ENFORCE ?? 'true').toLowerCase() !== 'false';
}
