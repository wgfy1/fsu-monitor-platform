/**
 * 告警规则（保留类型名称映射，不包含主动判断逻辑）
 * 告警完全由厂家 FSU 协议的 alarmReport 推送，平台不做任何判断
 */
export class AlarmRulesService {
  /**
   * 获取告警类型中文名称
   * @param type 告警类型
   */
  static getAlarmTypeName(type: string): string {
    const typeNames: Record<string, string> = {
      temperature: '温度',
      humidity: '湿度',
      signal: '信号',
      smoke: '烟感',
      water: '水浸',
      door: '门禁',
      power: '电源',
      offline: '离线',
      alarm: '告警',
      error_code: '故障告警',
      power_outage: '停电告警',
      power_restore: '供电恢复',
      sensor_fault: '传感器故障',
    };
    return typeNames[type] || type;
  }
}