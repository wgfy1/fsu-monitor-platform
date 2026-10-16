/** 设备信息接口 */
export interface Device {
  id: string;
  product_id: string;
  /** 归属租户（null/undefined=未分配，仅平台管理员可见） */
  tenant_id?: string | null;
  name: string | null;
  imei: string | null;
  iccid: string | null;
  manufacturer: string | null;
  terminalType: string | null;
  moduleType: string | null;
  hardwareVersion: string | null;
  softwareVersion: string | null;
  reportPeriod: number | null;
  location: string | null;
  status: 'online' | 'offline';
  /** 激活状态: inactive=未激活(从未连接过), active=已激活 */
  activationStatus?: 'inactive' | 'active';
  /** MQTT 是否连接中: 1=连接, 0=断开 */
  mqttConnected?: number;
  last_seen: number;
  created_at: number;
  /** 设备序列号（厂家接入信息） */
  device_sn?: string | null;
  /** 协议类型 */
  protocol_type?: string | null;
  /**
   * MQTT 用户名（历史字段，仅设备档案留档展示用）
   * 注意：平台 MQTT 已改为全设备统一账号（username=platform），
   * 本字段不再代表设备的实际接入凭据，前端不再展示。
   */
  mqttUsername?: string | null;
  /** MQTT 密码（历史字段，同上，不再作为接入凭据） */
  mqttPassword?: string | null;
  /** 归属站点ID（null/undefined=未分配） */
  site_id?: number | null;
  /** 归属租户名称（后端派生自 tenants.name；未归属时为 null） */
  tenant_name?: string | null;
  /** 归属站点名称（后端派生；未分配时为 null） */
  site_name?: string | null;
  /** 归属站点编号（后端派生） */
  site_code?: string | null;
  /** 厂家协议原始电表数据：{ devId: { meterId: value } }（最新一次上报） */
  latestMeters?: Record<string, Record<string, string | number>>;
  /** 最后心跳时间（厂家协议 heartbeat，仅证明设备在线；last_seen 才是数据上报时间） */
  last_heartbeat?: number | null;
  hasAlarm?: boolean;
  alarmCount?: number;
}

/** 告警类型 */
export type AlarmType = string;

/** 告警严重程度 */
export type AlarmSeverity = 'warning' | 'critical';

/** 告警记录接口 */
export interface Alarm {
  id: number;
  device_id: string;
  type: AlarmType;
  severity: AlarmSeverity;
  message: string;
  value: string | null;
  resolved: number;
  resolved_at: number | null;
  created_at: number;
  source?: string;
  device_name?: string;
  location?: string;
  /** 厂家协议告警唯一标识（serialNo），非厂家告警为 null */
  serial_no?: string | null;
  /**
   * 厂家协议告警等级 [1,5]（协议 4.4 alarmLevel 原始值）。
   * 平台**不再**把它映射成 critical/warning，展示与统计一律用它。
   */
  alarm_level?: number | null;
  /** 厂家协议历史告警标记：1=历史告警 */
  is_history?: number | null;
  /**
   * 厂家子设备名称（后端用**设备上报的厂家字典**解析 alarms.type 里的 devId 得到）。
   * 字典中没有该 devId 时为 null，前端回退显示 devId 原文。
   * 前端不维护任何 devId → 中文名 映射表。
   */
  dev_name?: string | null;
}

/** API响应接口 */
export interface ApiResponse<T = any> {
  code: number;
  data: T | null;
  message: string;
}

// ============================================================
// 远程操作（厂家协议 4.5 getData / 4.6 getAlarm / 4.7 setData）
// ============================================================

/** 远程操作结果的公共字段（code/msg 为**网关**返回的协议错误码与提示） */
export interface RemoteResultBase {
  deviceId: string;
  /** 厂家 gwId（当前等于 deviceId） */
  gwId: string;
  /** 网关返回的协议错误码：0=成功 */
  code: number;
  /** 网关返回的提示文案 */
  msg: string;
  /** 平台侧请求 id（与网关响应关联用，排查时核对） */
  requestId: string;
}

/** 一个设置项（协议 4.7：value 为 string） */
export interface RemoteSetDataItem {
  devId: string;
  meterId: string;
  value: string;
}

/**
 * 设备校时配置（协议 4.8，平台→网关）
 *
 * ⚠️ `enabled` 只控制**定时**校时；**上线校时不受该开关影响**，设备每次正常上线
 *    仍会自动校时一次。
 * ⚠️ `lastSentAt` 是"平台把报文交给 Broker 的时间"，**不代表设备已校时**
 *    （真实设备收到该报文后不回包）。
 */
export interface NtpConfig {
  /** 是否启用定时校时 */
  enabled: boolean;
  /** 定时校时间隔（小时） */
  intervalHours: number;
  /** 最近一次校时发布时间（毫秒）；从未校时为 null */
  lastSentAt: number | null;
  /** 最近一次校时类型：online=上线校时 / scheduled=定时校时 */
  lastType: 'online' | 'scheduled' | null;
  /** 下一次计划校时时间（毫秒）；尚未安排为 null */
  nextDueAt: number | null;
  /** 允许的间隔选项（小时） */
  intervalOptions: number[];
  /** 默认间隔（小时） */
  defaultIntervalHours: number;
}

/** 4.5 获取实时数据的结果 */
export interface RemoteGetDataResult extends RemoteResultBase {
  devices: Array<{ devId: string; meters: Array<{ meterId: string; value: string }> }>;
  /** 回写后的完整实时快照（与页面展示同源） */
  latestMeters: Record<string, Record<string, string>> | null;
  /** 厂家字典中查不到的点（正常为空） */
  unknownPoints: Array<{ devId: string; meterId: string }>;
  /** 是否已回写实时快照 */
  applied: boolean;
}

/** 4.6 实时告警中的一条 */
export interface RemoteAlarmItem {
  devId: string;
  /** 子设备中文名（来自厂家字典，查不到为 null） */
  devName: string | null;
  meterId: string;
  /** 告警产生时间（协议 4.6：**秒级**） */
  alarmTime: number;
  /** 同上，毫秒（仅换算单位，未做时区加工） */
  alarmTimeMs: number;
  /** 测量点中文名（来自厂家字典，查不到为 null） */
  meterName: string | null;
}

/** 4.6 获取实时告警的结果（synced 恒为 false：仅查询，不写平台告警） */
export interface RemoteGetAlarmResult extends RemoteResultBase {
  alarms: RemoteAlarmItem[];
  total: number;
  synced: false;
}

/** 4.7 设置数据的结果 */
export interface RemoteSetDataResult extends RemoteResultBase {
  /** 实际下发的设置项 */
  items: RemoteSetDataItem[];
}

/** 「远程设置」候选点位（来自厂家 uploadDevInfo 字典） */
export interface RemoteMeterOption {
  devId: string;
  devName: string | null;
  meterId: string;
  meterName: string | null;
  meterType: number | null;
}

export interface RemoteMeterOptionsResult {
  deviceId: string;
  gwId: string;
  /** false=该网关还没有厂家点位字典（网关未上传过 uploadDevInfo） */
  dictAvailable: boolean;
  options: RemoteMeterOption[];
}

// ============================================================
// 设备 Excel 批量导入
// ============================================================

/** 预校验通过的一行（租户/站点均为服务端查库确认后的结果） */
export interface DeviceImportResolved {
  id: string;
  tenantId: string | null;
  tenantName: string | null;
  siteId: number | null;
  siteCode: string | null;
  siteName: string | null;
  name: string | null;
  deviceSn: string | null;
  manufacturer: string | null;
  moduleType: string | null;
  imei: string | null;
  iccid: string | null;
  terminalType: string | null;
  protocolType: string;
}

export interface DeviceImportPreviewRow {
  /** Excel 中的行号（第 1 行为表头） */
  row: number;
  status: 'valid' | 'invalid';
  data?: DeviceImportResolved;
  errors?: string[];
}

/** POST /api/devices/import/preview 的返回 */
export interface DeviceImportPreview {
  total: number;
  valid: number;
  invalid: number;
  scopeTenantId: string | null;
  /** 被忽略的未知列（提示用，不阻断导入） */
  ignoredColumns: string[];
  rows: DeviceImportPreviewRow[];
  /** 通过预校验的签名令牌，confirm 时原样回传；全部无效时为 null */
  token: string | null;
  sheet: string;
  maxRows: number;
}

/** POST /api/devices/import/confirm 的返回 */
export interface DeviceImportConfirm {
  imported: number;
  deviceIds: string[];
}

/** 设备统计 */
export interface DeviceStats {
  total: number;
  online: number;
  offline: number;
}

/**
 * 告警中心「子设备」筛选项
 * 完全来自**设备上报的点位字典**，前端不维护任何 devId→名称 / 分类映射。
 */
export interface SubDeviceOption {
  /** 厂家上报的子设备 ID —— 筛选时原样回传，用于精确过滤 */
  devId: string;
  /** 字典里的 devName（已去掉末尾 .json）；字典没给名称时为 null，界面回退显示 devId */
  devName: string | null;
  /** 该子设备名下的告警类点位数量（诊断用） */
  alarmPointCount: number;
}

/** 告警统计 */
export interface AlarmStats {
  total: number;
  unresolved: number;
  /** 平台自行定级为"严重"的历史告警（旧物模型链路）。FSU 厂家告警不计入 */
  critical: number;
  /** 平台自行定级为"警告"的历史告警。FSU 厂家告警不计入 */
  warning: number;
  /**
   * **未解决**告警按**厂家原始 alarmLevel**（协议 4.4，1~5）的分布。
   * FSU 告警的唯一定级口径 —— 平台不把 1~5 翻译成严重/警告。
   */
  byLevel: Record<string, number>;
  /** 未解决但没有 alarm_level 的条数（历史行 / 非厂家告警） */
  withoutLevel: number;
}

/** 平台配置信息 */
export interface PlatformConfig {
  // 正式接入方式只有厂家 FSU MQTT
  connectMode: 'mqtt';
  mqtt: {
    enabled: boolean;
    connected: boolean;
    broker: string;
  };
}

/** 用户角色 */
export type UserRole = 'admin' | 'user';

/** 用户账号接口 */
export interface User {
  id: number;
  username: string;
  role: UserRole;
  /** 归属租户（null/undefined=平台运维账号） */
  tenant_id?: string | null;
  /** 1=启用, 0=禁用 */
  status: number;
  /** 最后登录时间（毫秒） */
  last_login_at: number | null;
  created_at: number;
  /** 所属租户名称（后端联表派生；平台账号为 null） */
  tenant_name?: string | null;
}

/** 登录结果 */
export interface LoginResult {
  token: string;
  user: User;
}

/** 租户（正式租户实体，一个租户 = 一个登录账号） */
export interface Tenant {
  /** 正式租户ID（如 T0001） */
  id: string;
  /** 租户名称（唯一） */
  name: string;
  remark: string | null;
  /** 1=启用 0=停用 */
  status: number;
  created_at: number;
  updated_at: number;
  /** 以下为后端派生字段 */
  username?: string | null;
  site_count?: number;
  device_count?: number;
}

/** 删除租户前的数据统计（确认弹窗展示） */
export interface TenantDeletePreview {
  tenant_id: string;
  tenant_name: string;
  username: string | null;
  site_count: number;
  device_count: number;
  /** 厂家原始历史数据（fsu_data_history）条数 */
  fsu_history_count: number;
  /** 设备电表字典（device_meters）条数 */
  meter_dict_count: number;
  alarm_count: number;
  notify_config_count: number;
  push_log_count: number;
}

/** 站点状态（由关联设备与告警实时计算） */
export type SiteStatus = 'normal' | 'alarm' | 'offline' | 'unassigned';

/** 站点记录（含后端派生的统计字段） */
export interface Site {
  id: number;
  /** 站点编号（系统生成，如 SITE-0001） */
  code: string;
  /** 站点名称（用户自定义） */
  name: string;
  /** 所属租户（null=平台未分配） */
  tenant_id: string | null;
  /**
   * 站点经纬度（可选）
   * 当前数据库中 sites 表尚未提供该字段，首页"站点分布"会在缺失时显示空状态；
   * 后端补齐 latitude / longitude 后，地图将自动渲染站点 Marker，无需改前端。
   */
  latitude?: number | null;
  longitude?: number | null;
  province_code: string | null;
  city_code: string | null;
  district_code: string | null;
  address: string | null;
  remark: string | null;
  created_at: number;
  updated_at: number;
  /** 以下为后端派生字段 */
  province_name?: string | null;
  city_name?: string | null;
  district_name?: string | null;
  device_count?: number;
  online_count?: number;
  alarm_count?: number;
  status?: SiteStatus;
}

/** 站点统计（首页） */
export interface SiteStats {
  total: number;
  normal: number;
  alarm: number;
  offline: number;
  unassigned: number;
}

/** 行政区划节点（省/市/区县级联） */
export interface RegionNode {
  code: string;
  name: string;
}

/** 推送通道: dingtalk=钉钉群机器人, sms=短信（短信通道暂预留） */
export type NotifyChannel = 'dingtalk' | 'sms';

/** 告警推送配置（后端单行 id=1） */
export interface AlarmNotifyConfig {
  /** 推送总开关: 1=开 */
  enabled: number;
  /** 钉钉通道开关: 1=开 */
  dingtalk_enabled: number;
  /** 钉钉群机器人 Webhook URL（含 access_token） */
  dingtalk_webhook: string | null;
  /** 钉钉加签密钥（空=不加密） */
  dingtalk_secret: string | null;
  /** 短信通道开关: 1=开（预留） */
  sms_enabled: number;
  /** 短信接收手机号，逗号分隔（预留） */
  sms_numbers: string | null;
  /** 同设备同类型去重窗口（分钟） */
  dedupe_minutes: number;
  /** 更新时间（毫秒） */
  updated_at: number;
  /** 短信供应商是否已接入（后端附加字段，当前恒 false） */
  smsProviderAvailable?: boolean;
}

/** 告警推送记录 */
export interface AlarmPushLog {
  id: number;
  /** 触发告警ID（测试推送时为 null） */
  alarm_id: number | null;
  /** 动作: alarm=告警推送, test=测试推送 */
  action: string;
  device_id: string | null;
  type: string | null;
  severity: string | null;
  message: string | null;
  channel: NotifyChannel;
  /** 目标（脱敏） */
  target: string | null;
  /** success | failed | skipped */
  status: 'success' | 'failed' | 'skipped';
  /** 失败原因/说明 */
  detail: string | null;
  /** 创建时间（秒） */
  created_at: number;
}