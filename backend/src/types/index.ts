/**
 * 设备信息接口（数据库记录）
 */
export interface Device {
  id: string;
  product_id: string;
  /** 归属租户（NULL=未分配设备，仅平台管理员可见） */
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
  /** 激活状态: inactive=从未连接过, active=已激活（首次连接后不再回落） */
  activationStatus: 'inactive' | 'active';
  /** MQTT 是否连接中: 1=连接, 0=断开 */
  mqttConnected: number;
  last_seen: number;
  created_at: number;
  /** 设备序列号（厂家接入信息） */
  device_sn?: string | null;
  /** 协议类型 */
  protocol_type?: string | null;
  /** MQTT 用户名（历史遗留字段：平台已改用统一账号 platform，不参与认证） */
  mqttUsername?: string | null;
  /** MQTT 密码（历史遗留字段：不参与认证） */
  mqttPassword?: string | null;
}

/**
 * 告警类型
 */
export type AlarmType = string;

/**
 * 告警严重程度（**平台内部字段**，alarms.severity 为 NOT NULL）
 *
 * - 'warning' / 'critical'：平台自行判定严重程度的历史取值（旧物模型链路遗留）
 * - 'vendor'：**平台未定级**。FSU 厂家告警用此值占位 ——
 *   协议 4.4 的 alarmLevel ∈ [1,5] 是厂家自己的级别，厂家**没有**给出
 *   它与 warning/critical 的对应关系，因此平台不做映射、也不冒充已定级。
 *   厂家原始级别完整保存在 alarms.alarm_level，展示与统计一律用它。
 */
export type AlarmSeverity = 'warning' | 'critical' | 'vendor';

/**
 * 告警记录接口
 */
export interface Alarm {
  id: number;
  device_id: string;
  type: AlarmType;
  severity: AlarmSeverity;
  message: string;
  value: string | null;
  source: string;
  resolved: number;
  resolved_at: number | null;
  created_at: number;
  device_name?: string;
  location?: string;
  /** 厂家协议告警唯一标识（协议 4.4 serialNo），非厂家告警为 null */
  serial_no?: string | number | null;
  /** 厂家协议告警级别 [1,5]（协议 4.4 alarmLevel），非厂家告警为 null */
  alarm_level?: number | null;
  /** 厂家协议历史告警标记：1=历史告警（协议 4.4 isHistory） */
  is_history?: number | null;
}

/**
 * 统一响应接口
 */
export interface ApiResponse<T = any> {
  code: number;
  data: T | null;
  message: string;
}

/**
 * 用户角色
 */
export type UserRole = 'admin' | 'user';

/**
 * 用户账号接口（数据库记录，password 仅内部使用，路由层绝不返回）
 */
export interface User {
  id: number;
  username: string;
  password?: string;
  role: UserRole;
  /** 归属租户（NULL=平台运维账号，可查看全部租户数据） */
  tenant_id?: string | null;
  /** 1=启用, 0=禁用 */
  status: number;
  /** 最后登录时间（毫秒） */
  last_login_at: number | null;
  /** 创建时间（秒） */
  created_at: number;
}

/**
 * 安全用户信息（不含密码）
 */
export type SafeUser = Omit<User, 'password'>;

/**
 * 租户（正式租户实体）
 * 一个租户 = 一个登录账号（users.tenant_id 唯一）
 */
export interface Tenant {
  /** 正式租户ID（如 T0001）——各业务表 tenant_id 统一关联此字段 */
  id: string;
  /** 租户名称（唯一） */
  name: string;
  remark: string | null;
  /** 1=启用 0=停用（停用只影响账号登录，不删除任何业务数据） */
  status: number;
  created_at: number;
  updated_at: number;
}

/** 租户 + 派生统计（列表返回结构） */
export interface TenantWithStats extends Tenant {
  /** 绑定的登录账号（NULL=未绑定账号） */
  username: string | null;
  site_count: number;
  device_count: number;
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

/**
 * 站点状态（由关联设备与告警实时计算，不落库）
 * normal=正常  alarm=告警  offline=离线  unassigned=未分配设备
 */
export type SiteStatus = 'normal' | 'alarm' | 'offline' | 'unassigned';

/**
 * 站点记录接口（数据库行）
 */
export interface Site {
  id: number;
  /** 站点编号（系统生成，全局唯一，如 SITE-0001） */
  code: string;
  /** 站点名称（用户自定义，如 "XX路基站"） */
  name: string;
  /** 所属租户（NULL=平台未分配） */
  tenant_id: string | null;
  /** 行政区划 code（名称由 RegionService 解析） */
  province_code: string | null;
  city_code: string | null;
  district_code: string | null;
  /** 详细地址（不含省市县） */
  address: string | null;
  remark: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 站点 + 派生信息（列表/详情返回结构）
 */
export interface SiteWithStats extends Site {
  province_name: string | null;
  city_name: string | null;
  district_name: string | null;
  /** 关联设备数 */
  device_count: number;
  /** 在线设备数 */
  online_count: number;
  /** 未解决告警数 */
  alarm_count: number;
  /** 计算得出的站点状态 */
  status: SiteStatus;
}

/**
 * 推送通道: dingtalk=钉钉群机器人, sms=短信（短信通道暂预留）
 */
export type NotifyChannel = 'dingtalk' | 'sms';

/**
 * 告警推送配置（单行 id=1）
 */
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
  /** 同设备同类型告警去重窗口（分钟） */
  dedupe_minutes: number;
  /** 更新时间（毫秒） */
  updated_at: number;
}

/**
 * 告警推送记录（每次发送尝试留痕）
 */
export interface AlarmPushLog {
  id: number;
  /** 触发告警ID（测试推送时为 NULL） */
  alarm_id: number | null;
  /** 动作: alarm=告警推送, test=测试推送 */
  action: string;
  device_id: string | null;
  type: string | null;
  severity: string | null;
  message: string | null;
  channel: NotifyChannel;
  /** 目标（脱敏展示） */
  target: string | null;
  /** 发送结果 */
  status: 'success' | 'failed' | 'skipped';
  /** 失败原因/说明 */
  detail: string | null;
  /** 创建时间（秒） */
  created_at: number;
}