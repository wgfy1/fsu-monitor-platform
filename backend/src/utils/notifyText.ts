/**
 * 告警通知文案构造（纯函数，无数据库 / 网络依赖）
 *
 * 从 notifyService 抽出来是为了两件事：
 *   1) 让"钉钉与短信使用同一份时间文本"可以被单独测试覆盖；
 *   2) 让时间格式化（beijingTime）成为唯一的时区来源。
 *
 * 文案规则保持不变（面向用户，不出现"厂家"字样、不暴露内部枚举）：
 *   「级别」一律用协议 4.4 的原始 alarmLevel；缺失时按内部严重程度兜底，
 *   两者都没有则显示"未定级"。
 */

/** 平台内部严重程度 → 文案 */
export function severityLabel(severity: string): string {
  if (severity === 'critical') return '严重';
  if (severity === 'warning') return '警告';
  // 'vendor' 是 FSU 厂家告警的占位值，含义是"平台未定级"：
  // 协议只给厂家自己的 alarmLevel(1~5)，平台不做映射、也不冒充已定级。
  if (severity === 'vendor') return '';
  return severity;
}

export interface NotifyTextInput {
  severity: string;
  /** 厂家原始告警级别（协议 4.4，1~5）；有值时优先展示 */
  alarmLevel?: number | null;
  deviceId: string;
  /** 设备显示名；为空时回退设备 ID */
  deviceName?: string | null;
  /** 子设备显示名（已由调用方按厂家字典解析） */
  typeName: string;
  location?: string | null;
  message: string;
  /** 已格式化好的时间文本，钉钉与短信**共用同一份** */
  timeStr: string;
}

/**
 * 生成钉钉 markdown 与短信文案
 *
 * 注意：timeStr 由调用方用 formatBeijingTime(Date.now()) 生成并同时传给两个通道，
 * 保证两条通知的时间完全一致。
 */
export function buildNotifyText(info: NotifyTextInput): { dingtalk: string; sms: string } {
  const levelText = info.alarmLevel != null
    ? `级别 ${info.alarmLevel}`
    : (severityLabel(info.severity) || '未定级');
  const name = info.deviceName || info.deviceId;

  const dingtalk = [
    `### ${levelText}告警通知`,
    `- **级别**：${levelText}`,
    `- **设备**：${name}（${info.deviceId}）`,
    `- **子设备**：${info.typeName}`,
    `- **时间**：${info.timeStr}`,
    ...(info.location ? [`- **位置**：${info.location}`] : []),
    `- **内容**：${info.message || '无'}`,
    `---`,
    `请及时登录平台「告警中心」查看处理。`
  ].join('\n');

  const sms = `【FSU监控】${levelText}告警！设备：${name}（${info.deviceId}），${info.typeName}：${info.message || '无'}，时间 ${info.timeStr}`.slice(0, 200);

  return { dingtalk, sms };
}
