/**
 * 厂家量映射层：协议 (devId, meterId, value) → 平台可读结果
 *
 * ⚠️ 本文件**不再内建任何厂家档案表**。平台不维护 meterId→中文名、devId→分类
 * 这类硬编码映射：所有名称一律来自**设备上报的厂家字典**
 * （gw/v1/uploadDevInfo → device_meters 表），由 findMeterName / findDevName 查询。
 * 因此厂家改点名称、加子设备，平台无需改代码。
 *
 * 本文件只保留两类纯函数：
 *   1) 结构归并：aggregateMeters / metersByDevFromGetData / mergeMeters
 *   2) 字典查询：findMeterName / findDevName
 *   （字典的**读取**在 ./dictionary.ts，因为那需要访问数据库）
 *
 * 三层身份严格区分：
 *   gwId（网关） ≠ devId（设备） ≠ meterId（信号量）
 */
import { DataReportDevice, GetDataDevice } from './types';

/**
 * 从厂家 uploadDevInfo 字典（device_meters.meters_json）里查某个测量点的中文名
 *
 * 字典结构：[{ devId, devName, meters: [{ meterId, meterName, meterType }] }]
 * 用途：告警信息用**厂家给的中文测量点名称**（如"48V蓄电池组电压过高"），
 *       而不是把 devId/meterId 这些字段名拼进告警文本。
 * @returns 中文名；字典缺失或查不到时返回 null（调用方回退）
 */
export function findMeterName(
  dictJson: string | null | undefined,
  devId: unknown,
  meterId: unknown,
): string | null {
  if (!dictJson || devId == null || meterId == null) return null;
  try {
    const list = JSON.parse(dictJson);
    if (!Array.isArray(list)) return null;
    const dev = list.find((d: any) => String(d?.devId) === String(devId));
    if (!dev || !Array.isArray(dev.meters)) return null;
    const meter = dev.meters.find((m: any) => String(m?.meterId) === String(meterId));
    const name = meter?.meterName;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 从字典里取子设备中文名（devName，如 "48V蓄电池.json"）
 * 仅作为测量点名的兜底与日志用途。
 */
export function findDevName(
  dictJson: string | null | undefined,
  devId: unknown,
): string | null {
  if (!dictJson || devId == null) return null;
  try {
    const list = JSON.parse(dictJson);
    if (!Array.isArray(list)) return null;
    const dev = list.find((d: any) => String(d?.devId) === String(devId));
    const name = dev?.devName;
    return typeof name === 'string' && name.trim()
      ? name.trim().replace(/\.json$/i, '')   // 字典里形如 "48V蓄电池.json"，去掉扩展名
      : null;
  } catch {
    return null;
  }
}

/** { devId: { meterId: value } } */
export type MetersByDev = Record<string, Record<string, string>>;

/**
 * 汇总为 { devId: { meterId: value } }
 * value 一律保持 string（协议规定 string，不强制转数值类型）。
 */
export function aggregateMeters(devices: DataReportDevice[]): MetersByDev {
  const out: MetersByDev = {};
  for (const d of devices) {
    const devMeters: Record<string, string> = {};
    for (const m of d.meters) {
      devMeters[m.meterId] = m.value;
    }
    out[d.devId] = devMeters;
  }
  return out;
}

/**
 * 把 4.5 getData 的响应条目汇总为 { devId: { meterId: value } }
 *
 * 与 aggregateMeters（dataReport 用）输出**同一份结构**，因此可以共用
 * mergeMeters + devices.latest_meters 这条既有实时数据链路，
 * 不需要为"平台主动查询"另造一份实时数据存储。
 * value 同样保持 string。
 */
export function metersByDevFromGetData(devices: GetDataDevice[]): MetersByDev {
  const out: MetersByDev = {};
  for (const d of devices) {
    const devMeters: Record<string, string> = out[d.devId] ?? {};
    for (const m of d.meters) {
      devMeters[m.meterId] = m.value;
    }
    out[d.devId] = devMeters;
  }
  return out;
}

/**
 * 按 isFull 语义合并本次上报到已有电表快照（协议 4.3）
 *   全量(isFull=1)：本次是该设备的完整快照 → 整体替换（可剔除已消失的量）
 *   增量(isFull=0)：只包含变化的量 → 与已有快照合并，**不能丢掉本次未携带的量**
 *
 * 这是 isFull 语义真正生效的地方（不是把字段收下就丢掉）。
 */
export function mergeMeters(
  existing: MetersByDev | null,
  incoming: MetersByDev,
  fullByDev: Record<string, boolean>,
): MetersByDev {
  const out: MetersByDev = { ...(existing || {}) };
  for (const [devId, meters] of Object.entries(incoming)) {
    if (fullByDev[devId]) {
      out[devId] = { ...meters };          // 全量：替换
    } else {
      out[devId] = { ...(out[devId] || {}), ...meters }; // 增量：合并
    }
  }
  return out;
}

/**
 * 历史数据时间（协议 4.3 historyTime）的单位处理
 *
 * ⚠️ 协议**没有**标注 historyTime 的单位：4.3 字段表只写
 *    "historyTime | params | 历史数据时间 | 否 | int | isHistory 为1 时携带"，
 *    正文与 Demo 都没有给出单位或示例值。
 *
 * 因此这里**不臆造单位**，采用显式的"量级判定"：
 *    - 值 >= 1e12  → 按毫秒（13 位及以上，与信封 timestamp 同量级）
 *    - 值  < 1e12  → 按秒（10 位，与 alarmTime 同量级）
 * 判定规则写在代码里并在此声明，便于厂家确认单位后一处修改。
 * 若厂家后续明确单位，只需改本函数并在报告中更新结论。
 */
export const HISTORY_TIME_MS_THRESHOLD = 1e12;

export function resolveHistoryTimeMs(historyTime: number | undefined): number | null {
  if (historyTime === undefined || historyTime === null) return null;
  if (!Number.isFinite(historyTime) || historyTime <= 0) return null;
  return historyTime >= HISTORY_TIME_MS_THRESHOLD ? historyTime : historyTime * 1000;
}

// 说明：原先此处还有 readDoorState()（从 devId=1246001 / meterId=13160016001 猜门磁开关状态）。
// 一并移除，原因同 ALARM_POINT_MAP：厂家字典未定义该状态量的枚举取值，
// 平台据此推断 0=关门/1=开门 并合成告警，属于无厂家依据的自造规则。
// 门磁告警请以厂家自己的告警点（alarmReport 上报的 meterType=2 点位）为准。
