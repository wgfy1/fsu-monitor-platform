/**
 * 厂家设备字典（gw/v1/uploadDevInfo 上报，落 device_meters 表）的读取入口
 *
 * 为什么单独一个模块（而不是放在 handlers.ts）：
 *   handlers.ts 依赖 services/alarmService，而 alarmService 依赖 services/notifyService；
 *   告警推送文案也需要用字典里的 devName 展示子设备名称。若把读取函数放在 handlers.ts，
 *   就会形成 handlers → alarmService → notifyService → handlers 的循环依赖。
 *   本模块只依赖 models/database，任何层都可以安全引用。
 *
 * 字典的**唯一来源**是设备上报：平台不内建、不维护任何 meterId/devId 名称表。
 */
import database from '../../models/database';

/**
 * 读取该网关的厂家字典原始 JSON（device_meters.meters_json）
 *
 * 结构：[{ devId, devName, meters: [{ meterId, meterName, meterType }] }]
 * 读不到（网关从未上报 uploadDevInfo、或库异常）返回 null，调用方按"无字典"回退，
 * **不得据此编造名称**。
 */
export async function loadMeterDictionary(gwId: string): Promise<string | null> {
  try {
    const row = await database.get(
      'SELECT meters_json FROM device_meters WHERE device_id = ?', [gwId]
    );
    return row?.meters_json ?? null;
  } catch {
    return null;
  }
}

// ============================================================
// 字典解析 与 「功能子设备」识别
// ============================================================

/** 字典里的一个点位 */
export interface DictionaryMeter {
  meterId: string;
  meterName: string | null;
  /** 厂家字典自带的点位类型（见下方 METER_TYPE_ALARM） */
  meterType: number | null;
}

/** 字典里的一个条目（一个子设备 / 或网关自身模块） */
export interface DictionaryEntry {
  devId: string;
  devName: string | null;
  meters: DictionaryMeter[];
}

/** 供前端「子设备筛选」使用的一个选项 */
export interface SubDeviceOption {
  devId: string;
  /** 显示名（已去掉末尾的 .json；库里的原始 devName 不变） */
  devName: string | null;
  /** 该子设备名下的告警类点位数量（便于诊断，不参与筛选判定） */
  alarmPointCount: number;
}

/**
 * 厂家字典的 meterType 取值（**厂家自己的字段**，非平台自造枚举）
 *
 * 实测厂家 uploadDevInfo 上报的取值分布：
 *   1 = 遥测类（电压/电流/温度等模拟量）
 *   2 = 遥信/告警类  ← 本文件用它判定"这个条目会不会产生告警"
 *   3 = 设置类（如"设置系统时间""设备型号设置"）
 *   4 = 控制类（如"Led控制""wifi/gps电源控制"）
 * 平台只读取该值，不做任何二次映射。
 */
export const METER_TYPE_ALARM = 2;

/**
 * 去掉 devName 末尾的 .json（**仅用于显示**，数据库里的原值不动）
 * 厂家把子设备配置文件命名为 `<名称>.json`，devName 就是该文件名。
 */
export function stripJsonSuffix(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const t = name.trim();
  if (!t) return null;
  return t.replace(/\.json$/i, '') || null;
}

/** 解析字典 JSON（容错：结构不对/坏数据一律返回空数组，不抛异常） */
export function parseMeterDictionary(dictJson: string | null | undefined): DictionaryEntry[] {
  if (!dictJson) return [];
  let list: unknown;
  try {
    list = JSON.parse(dictJson);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];

  const out: DictionaryEntry[] = [];
  for (const raw of list as any[]) {
    const devId = raw?.devId != null ? String(raw.devId) : '';
    if (!devId) continue;
    const meters: DictionaryMeter[] = [];
    for (const m of Array.isArray(raw?.meters) ? raw.meters : []) {
      const meterId = m?.meterId != null ? String(m.meterId) : '';
      if (!meterId) continue;
      meters.push({
        meterId,
        meterName: typeof m?.meterName === 'string' && m.meterName.trim() ? m.meterName.trim() : null,
        meterType: Number.isFinite(Number(m?.meterType)) ? Number(m.meterType) : null,
      });
    }
    out.push({
      devId,
      devName: typeof raw?.devName === 'string' && raw.devName.trim() ? raw.devName.trim() : null,
      meters,
    });
  }
  return out;
}

/**
 * 从字典里挑出「功能子设备」（即会产生告警、需要出现在筛选里的条目）
 *
 * 判定规则（**完全由字典数据推导，不写死任何 devId / 名称 / 分类数组**）：
 *   1) 该条目含有至少一个 `meterType === METER_TYPE_ALARM`（厂家定义的遥信/告警类）点位；
 *   2) 且该点位**不是所有条目共有的通用点** —— 通用点按数据算出来：
 *      在**每一个**条目里都出现的 meterId（实测为 meterId="0"「通信状态」，
 *      厂家在每个条目里都带它，它表示网关与子设备的通信状态，不是子设备自身的告警）。
 *
 * 效果：网关自身的「设备信息」条目（只有通用点 + 遥测点 + 设置/控制点）被自动排除；
 *      厂家将来新增功能子设备时，本函数无需修改即可自动识别。
 */
// ============================================================
// 通信状态：识别 与 告警抑制范围
// ============================================================

/**
 * 通信状态监控点在厂家字典里的标识
 *
 * 实测 gw/v1/uploadDevInfo 的每个条目（含网关自身「设备信息」）都带：
 *   { "meterId": "0", "meterName": "通信状态", "meterType": 2 }
 *
 * 识别时**同时**要求 meterId 与 meterName 命中（两者都来自厂家字典，
 * 不是平台自造枚举）：
 *   - 只按名称匹配，可能误伤同名的其它点位；
 *   - 只按 ID 匹配，可能把厂家未命名的 "0" 点位当成通信状态。
 *
 * 注意：meterType=2 只说明它属于"遥信类"点位，**不代表它是一条告警**。
 * 通信状态改由 heartbeat 状态图标展示，因此该点位产生的 alarmReport
 * 不再作为普通告警创建/推送（但数据接收、解析、落库照旧）。
 *
 * ⚠️ 职责分离：本常量只用于**识别通信状态告警**；
 *    前端在线/离线图标只用 heartbeat.params.online/offline，两者互不替代。
 */
export const COMM_STATUS_METER_ID = '0';
export const COMM_STATUS_METER_NAME = '通信状态';

/** 从字典里取出所有「通信状态」点位的 meterId（同时命中 ID 与名称，去重） */
export function findCommStatusMeterIds(entries: DictionaryEntry[]): string[] {
  const ids = new Set<string>();
  for (const e of entries) {
    for (const m of e.meters) {
      if (m.meterId === COMM_STATUS_METER_ID
        && (m.meterName || '').trim() === COMM_STATUS_METER_NAME) {
        ids.add(m.meterId);
      }
    }
  }
  return Array.from(ids);
}

/**
 * 通信状态事件的抑制范围
 *
 * subDeviceIds 用 pickFunctionalSubDevices() 推导 ——
 * 即该网关下**真实的功能子设备**（含告警点、排除网关自身「设备信息」条目），
 * 而不是写死五个全局 devId。厂家将来增减子设备，这里自动跟着变。
 */
export interface CommStatusEventScope {
  /** 会产生通信状态上报的功能子设备 devId */
  subDeviceIds: string[];
  /** 通信状态点位对应的 meterId（取自厂家字典） */
  meterIds: string[];
}

export function getCommStatusEventScope(entries: DictionaryEntry[]): CommStatusEventScope {
  return {
    subDeviceIds: pickFunctionalSubDevices(entries).map((o) => o.devId),
    meterIds: findCommStatusMeterIds(entries),
  };
}

/**
 * 判断 (devId, meterId) 是否属于「功能子设备的通信状态事件」
 *
 * 只有**同时**命中目标子设备与通信状态点位才算 ——
 * 子设备的其它告警点、以及网关自身条目的通信状态都不在此范围。
 */
export function isSubDeviceCommStatusEvent(
  entries: DictionaryEntry[],
  devId: string,
  meterId: string
): boolean {
  if (entries.length === 0) return false;
  const scope = getCommStatusEventScope(entries);
  return scope.subDeviceIds.includes(devId) && scope.meterIds.includes(meterId);
}

export function pickFunctionalSubDevices(entries: DictionaryEntry[]): SubDeviceOption[] {
  if (entries.length === 0) return [];

  // 通用点：所有条目都有的 meterId（逐条目求交集）
  const commonMeterIds = new Set<string>(
    entries[0].meters.map((m) => m.meterId)
  );
  for (const e of entries) {
    const own = new Set(e.meters.map((m) => m.meterId));
    for (const id of Array.from(commonMeterIds)) {
      if (!own.has(id)) commonMeterIds.delete(id);
    }
    if (commonMeterIds.size === 0) break;
  }

  const options: SubDeviceOption[] = [];
  for (const e of entries) {
    const alarmPoints = e.meters.filter(
      (m) => m.meterType === METER_TYPE_ALARM && !commonMeterIds.has(m.meterId)
    );
    if (alarmPoints.length === 0) continue;
    options.push({
      devId: e.devId,
      devName: stripJsonSuffix(e.devName),
      alarmPointCount: alarmPoints.length,
    });
  }
  return options;
}
