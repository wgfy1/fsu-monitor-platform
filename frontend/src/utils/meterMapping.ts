/**
 * 厂家 dataReport 电表数据映射表
 *
 * 设备上报的原始数据格式：latestMeters = { devId: { meterId: value } }
 * 本文档集中维护 devId / meterId → 字段名的映射（单一配置源），
 * 详情页各卡片按此表从 device.latestMeters 中取值。
 * 若实际协议与下列 meterId 不一致，只需修改本文件常量即可。
 */
import { Device } from '../types';

/** ==================== 子设备 devId ====================
 *
 * devId 取自厂家 uploadDevInfo 字典实测值（2026-09-24 经真实网关 00534c080213 核对）：
 *   1061001 = "48V蓄电池.json"      1064001 = "48V交流屏_JJ.json"
 *   2060001 = "48V直流屏_JJ.json"    1120001 = "数字温湿度_CT_JJ.json"
 *   1246001 = "门磁_CT_JJ.json"
 * 另有 215001 = "设备信息"（网关自身系统模块，非物理子设备，此处不映射）。
 * 下方各 meterId 与 devId 是不同层级，未做任何改动。
 */

/** 电池组（BMS） */
export const DEV_BATTERY = '1061001';
/** 交流整流设备（市电/AC 输入） */
export const DEV_RECTIFIER = '1064001';
/** 直流系统（DC 输出） */
export const DEV_DC = '2060001';
/** 环境监测（温湿度） */
export const DEV_ENV = '1120001';

/** ==================== 电池组 meterId ==================== */

/** 电池组基础测量量：meterId → 字段名 */
export const BATTERY_METERS: Record<string, string> = {
  '13061001001': '电池组总电压',
  '13061002001': '电池组电流',
  '13061003001': '电池组温度',
};

/** 16 节单体电压 meterId（13061007001 ~ 13061007016） */
export function getCellVoltageMeterIds(count: number = 16): string[] {
  return Array.from({ length: count }, (_, i) =>
    `130610070${String(i + 1).padStart(2, '0')}`
  );
}

/** 单体高压告警遥信点（12061010001 ~ 12061010016，任一非 0 即告警） */
export function getCellHighAlarmMeterIds(count: number = 16): string[] {
  return Array.from({ length: count }, (_, i) =>
    `120610100${String(i + 1).padStart(2, '0')}`
  );
}

/** 单体低压告警遥信点（12061011001 ~ 12061011016，任一非 0 即告警） */
export function getCellLowAlarmMeterIds(count: number = 16): string[] {
  return Array.from({ length: count }, (_, i) =>
    `120610110${String(i + 1).padStart(2, '0')}`
  );
}

/** 电池组总压过高/过低告警遥信点 */
export const BATTERY_TOTAL_ALARM_METERS: Record<string, string> = {
  '11061004001': '总压过高告警',
  '11061005001': '总压过低告警',
};

/** 单体电压异常阈值（低于 2.0V 或高于 3.6V 判定为异常，标红） */
export const CELL_VOLTAGE_MIN = 2.0;
export const CELL_VOLTAGE_MAX = 3.6;

/** ==================== 交流输入 meterId（整流设备 devId） ==================== */

/** 交流输入测量量：meterId → 字段名（线电压/相电压/相电流/频率）
 *  实测（dataReport 来自交流屏子设备），meterId = 2306 + 4位组号 + 001：
 *  线电压组 0001/0002/0003、相电压组 0004/0005/0006、相电流组 0007/0008/0009、
 *  频率组 0010（Uab=408.5V、Ubc=408.9V、Uca=409.5V、Ua=236.1V、f=50Hz）。 */
export const AC_METERS: Record<string, string> = {
  '23060001001': '线电压 Uab',
  '23060002001': '线电压 Ubc',
  '23060003001': '线电压 Uca',
  '23060004001': '相电压 Ua',
  '23060005001': '相电压 Ub',
  '23060006001': '相电压 Uc',
  '23060007001': '相电流 Ia',
  '23060008001': '相电流 Ib',
  '23060009001': '相电流 Ic',
  '23060010001': '输入频率',
};

/** 交流输入告警遥信点（过压/欠压/停电/缺相/频率异常等）
 *  实际 meterId 可在此补充（value 非 0 即告警）；
 *  未配置时自动用告警列表关键字兜底（见详情页告警汇总逻辑） */
export const AC_ALARM_METERS: Record<string, string> = {
  // '2306002xxxx': '交流输入过压',
  // '2306002xxxx': '交流输入欠压',
};

/** ==================== 直流输出 meterId（直流系统 devId） ==================== */

/** 直流输出测量量：meterId → 字段名 */
export const DC_METERS: Record<string, string> = {
  '23060018001': '直流总电压',
  '23060019001': '负载总电流',
};

/** 直流输出告警遥信点 */
export const DC_ALARM_METERS: Record<string, string> = {
  '22060021001': '直流输出过压',
  '22060022001': '直流输出欠压',
};

/** ==================== 整流模块 meterId ==================== */

/** 整流模块测量量（devId 未明确，取值时在所有子设备中搜索）
 *  一台 FSU 有 3 个整流模块：电流组 13060001001/2/3、温度组 13060005001/2/3 */
export const MODULE_METERS: Record<string, string> = {
  '13060025001': '模块输出电压',
  '13060001001': '模块1电流',
  '13060001002': '模块2电流',
  '13060001003': '模块3电流',
  '13060005001': '模块1温度',
  '13060005002': '模块2温度',
  '13060005003': '模块3温度',
  '12060029001': '均/浮充状态',
};

/** ==================== 环境监测（数字温湿度子设备） ==================== */

/** 环境温湿度：meterId → 字段名（抓包实测 25.6°C / 50.5%） */
export const ENV_METERS: Record<string, string> = {
  '13120003001': '环境温度',
  '13120004001': '环境湿度',
};

/** ==================== 门磁/门禁 ==================== */

/** 门磁子设备（字典 devName="门磁_CT_JJ.json"） */
export const DEV_DOOR = '1246001';

/**
 * 门磁开关状态 meterId（字典 1246001 / "门磁开关状态"，meterType=1 状态量）
 *
 * ⚠️ 厂家字典只给出名称与类型，**未定义枚举取值**。当前只认已知的 0/1：
 *    0 = 关门，1 = 开门；其他值保持**未知**，不得推断为开门或关门。
 */
export const DOOR_METER_ID = '13160016001';

/** 门磁状态量映射（当前未被页面消费，保留为单一配置源；语义见上方 DOOR_METER_ID） */
export const DOOR_ALARM_METERS: Record<string, string> = {
  [DOOR_METER_ID]: '门磁',
};

/** ==================== 取值辅助函数 ==================== */

/** 取某子设备某 meterId 的原始值 */
export function getMeterValue(
  device: Device,
  devId: string,
  meterId: string
): string | number | undefined {
  return device.latestMeters?.[devId]?.[meterId];
}

/** 取任意子设备中某 meterId 的值（模块类 meter 的 devId 不固定时使用） */
export function findMeterValue(
  device: Device,
  meterId: string
): string | number | undefined {
  const devs = device.latestMeters ?? {};
  for (const devId of Object.keys(devs)) {
    const v = devs[devId]?.[meterId];
    if (v !== undefined) return v;
  }
  return undefined;
}

/** 原始值 → 数值（undefined/null/空串 → undefined） */
export function toNumber(v: string | number | undefined | null): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

/** 遥信点告警判断：value 非 0（含字符串 '0'）视为无告警，非 0 视为告警 */
export function isAlarm(v: string | number | undefined): boolean {
  if (v === undefined || v === null || v === '') return false;
  const n = toNumber(v);
  return n !== undefined && n !== 0;
}

/** 一组遥信点中是否有任一告警 */
export function hasAnyAlarm(
  device: Device,
  devId: string,
  meterIds: string[]
): boolean {
  return meterIds.some((id) => isAlarm(getMeterValue(device, devId, id)));
}
