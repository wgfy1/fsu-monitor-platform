/**
 * 厂家 MQTT 协议报文类型定义
 *
 * 字段名与协议 PDF 表格逐字对应；标注了协议要求（必须/可选）与数据类型。
 * 注意三类时间单位（协议里混用，必须严格区分）：
 *   - envelope.timestamp : 毫秒级（协议所有报文的"消息产生的时间戳"）
 *   - alarmTime/clearTime: 秒级（协议 4.6 getAlarm 表明确写"秒级时间戳"）
 *   - historyTime        : 协议**未标注单位**（见 mapping / 报告说明）
 */

/** 协议报文外层信封（所有消息共有） */
export interface FsuEnvelope {
  /** 消息id（必须，string） */
  id: string;
  /** 消息产生的时间戳（必须，uint64 毫秒级） */
  timestamp: number;
  /** 方法名称（必须，string） */
  method: string;
}

/** 平台响应信封（网关上行消息的响应） */
export interface FsuAck extends FsuEnvelope {
  /** 错误码（必须，int） */
  code: number;
  /** 错误消息（可选，string） */
  msg?: string;
  /** 响应消息体（getData/getAlarm 等下行请求的响应才有） */
  data?: unknown;
}

/** 4.1 网关登录 params */
export interface LoginParams {
  /** 版本号（必须）：扩展模块版本和应用版本，中间以 ## 拼接 */
  version: string;
  /** 网关 mac（必须）：如 00534a000282 */
  mac: string;
  /** 用户名（必须）：平台认证信息 */
  username: string;
  /** 密码（必须）：平台认证信息 —— 任何日志都不得输出 */
  password: string;
  /** 升级包版本号（可选） */
  upgradeVersion?: string;
  /** 硬件版本号（可选） */
  hardwareVersion?: string;
}

/** 4.2 心跳 params */
export interface HeartbeatParams {
  /** 卡号（可选） */
  ICCID?: string;
  /** 运营商（可选）：CT-电信 CM-移动 CU-联通 */
  carrier?: string;
  /**
   * 本机 vpn 地址
   * 协议表格标注为"必须"，但协议正文说明"获取失败时则上报空字符串"，
   * 因此解析层按**可选**处理（缺失不报错），避免因厂商实现差异丢整条心跳。
   */
  vpnip?: string;
  /** 在线设备列表（必须，array） */
  online: string[];
  /** 离线设备列表（必须，array） */
  offline: string[];
}

/** 4.3 数据上报中的单个信号量 */
export interface MeterValue {
  /** 信号量id（必须，string） */
  meterId: string;
  /** 值（必须，string）—— 协议规定 string，不得强制转成固定数值类型 */
  value: string;
}

/** 4.3 数据上报中的单个设备 */
export interface DataReportDevice {
  /** 设备id（必须，string）—— 与 gwId、meterId 是三个不同层级 */
  devId: string;
  /** 是否是历史数据（必须，int 1-是 0-否；Demo 中偶有缺省，按 0 处理） */
  isHistory: number;
  /**
   * 历史数据时间（isHistory=1 时携带）
   * ⚠️ 协议未标注单位（表格只写 int），处理方式见 mapping.ts / 报告。
   */
  historyTime?: number;
  /** 是否全量（必须，int 1-全量 0-增量；Demo 里出现过字符串 "0"，已受控兼容） */
  isFull: number;
  /** 量信息（必须，array） */
  meters: MeterValue[];
}

/** 4.4 告警上报 params */
export interface AlarmReportParams {
  /** 告警标志（必须，int 1-产生 0-消除） */
  alarmFlag: number;
  /** 告警级别（必须，int [1,5]） */
  alarmLevel: number;
  /** 告警产生时间（必须，int 秒级） */
  alarmTime: number;
  /** 告警消除时间（可选，int 秒级） */
  clearTime?: number;
  /** 设备id（必须，string） */
  devId: string;
  /** 信号量id（必须，string） */
  meterId: string;
  /** 序列号（必须，int）：厂家定义的告警唯一标识，去重/关联以此为准 */
  serialNo: number;
  /** 是否是历史告警（必须，int 1-是 0-否；Demo 中缺省，按 0 处理） */
  isHistory: number;
}

/** 4.8 校时 params */
export interface NtpParams {
  /** 时区（必须）：如 GMT+08:00，取值 GMT-12:00 ~ GMT+13:00 */
  timezone: string;
}

/** 4.5 getData 响应中的单个设备 */
export interface GetDataDevice {
  devId: string;
  meters: MeterValue[];
}

/** 4.6 getAlarm 响应中的单个信号量（alarmTime 为秒级） */
export interface GetAlarmMeter {
  meterId: string;
  /** 告警产生时间（秒级，协议 4.6 表格明确） */
  alarmTime: number;
}

/** 4.6 getAlarm 响应中的单个设备 */
export interface GetAlarmDevice {
  devId: string;
  meters: GetAlarmMeter[];
}

/** 4.7 平台设置数据项 */
export interface SetDataItem {
  devId: string;
  meterId: string;
  /** 要设置的值（必须，string） */
  value: string;
}

/** 协议报文校验结果 */
export interface ParseResult<T> {
  ok: boolean;
  /** 失败时的厂家错误码 */
  code?: number;
  /** 失败原因（内部排查用，不直接回给网关时可映射为 CODE_MESSAGE） */
  reason?: string;
  /** 成功时的解析结果 */
  value?: T;
}
