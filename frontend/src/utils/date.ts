import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

// 配置dayjs
dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

/**
 * 归一化时间戳：兼容秒级（10位）与毫秒级（13位）
 * alarms.created_at 等字段由 DB DEFAULT strftime('%s') 生成，是秒级；
 * devices.last_seen / fsu_data_history.data_timestamp 等为毫秒级。
 * 显示前统一转为毫秒，避免 10 位秒级被当作毫秒解析（如 1970-01-22）。
 */
export function normalizeTimestamp(timestamp: number): number {
  if (typeof timestamp === 'number' && timestamp > 0 && timestamp < 1e12) {
    return timestamp * 1000;
  }
  return timestamp;
}

/**
 * 格式化时间戳
 * @param timestamp 时间戳（秒级或毫秒级均可）
 * @param format 格式，默认 'YYYY-MM-DD HH:mm:ss'
 */
export function formatTimestamp(
  timestamp: number,
  format: string = 'YYYY-MM-DD HH:mm:ss'
): string {
  return dayjs(normalizeTimestamp(timestamp)).format(format);
}

/**
 * 格式化相对时间
 * @param timestamp 时间戳（秒级或毫秒级均可）
 */
export function formatRelativeTime(timestamp: number): string {
  return dayjs(normalizeTimestamp(timestamp)).fromNow();
}

/**
 * 获取时间范围的时间戳
 * @param range 时间范围：1h, 6h, 24h, 7d
 * @returns [开始时间, 结束时间] 毫秒时间戳
 */
export function getTimeRange(range: '1h' | '6h' | '24h' | '7d'): [number, number] {
  const now = dayjs();
  let start: dayjs.Dayjs;

  switch (range) {
    case '1h':
      start = now.subtract(1, 'hour');
      break;
    case '6h':
      start = now.subtract(6, 'hour');
      break;
    case '24h':
      start = now.subtract(1, 'day');
      break;
    case '7d':
      start = now.subtract(7, 'day');
      break;
    default:
      start = now.subtract(1, 'hour');
  }

  return [start.valueOf(), now.valueOf()];
}

/** 历史曲线可选时间范围（1 小时 / 6 小时档位已下线） */
export type ChartRange = '24h' | '7d' | '30d';

/** 各档位时间窗长度（毫秒） */
export const CHART_RANGE_MS: Record<ChartRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/**
 * 生成图表 X 轴的**参考刻度**（与数据点完全解耦）
 *
 * 刻度一律落在自然时间边界上（24h 档位落在整点、7d/30d 落在本地零点），
 * 并把刻度数控制在 6~8 个左右——30 天档位不会堆出 30 个日期刻度。
 * **数据点不受影响**：它们仍按各自真实的 dataTimestamp 定位。
 *
 * @param start 查询窗口起点（毫秒）
 * @param end   查询窗口终点（毫秒）
 * @param range 时间范围档位
 * @returns 刻度时间戳数组（毫秒，升序）
 */
export function buildChartTicks(start: number, end: number, range: ChartRange): number[] {
  const s = dayjs(normalizeTimestamp(start));
  const e = dayjs(normalizeTimestamp(end));
  if (!s.isValid() || !e.isValid() || !s.isBefore(e)) return [];

  const ticks: number[] = [];

  if (range === '24h') {
    // 按小时：挑一个能让刻度数 ≤ 8 的步长，再对齐到该步长的整数倍整点
    const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];
    const hours = e.diff(s, 'hour', true);
    const step = HOUR_STEPS.find((h) => hours / h <= 7) ?? 12;
    let cur = s.startOf('hour');
    while (cur.hour() % step !== 0) cur = cur.add(1, 'hour');
    for (; !cur.isAfter(e); cur = cur.add(step, 'hour')) ticks.push(cur.valueOf());
    return ticks;
  }

  // 7d / 30d：按天，刻度落在本地零点（自然日期）
  const DAY_STEPS = [1, 2, 3, 5, 7, 10, 14];
  const days = e.diff(s, 'day', true);
  const step = DAY_STEPS.find((d) => days / d <= 7) ?? 14;
  let cur = s.startOf('day');
  if (cur.isBefore(s)) cur = cur.add(1, 'day');
  for (; !cur.isAfter(e); cur = cur.add(step, 'day')) ticks.push(cur.valueOf());
  return ticks;
}

/**
 * X 轴刻度标签
 *  - 24h：以 HH:mm 为主；落在本地日期边界（00:00）时带上日期，避免跨日看不出是哪天
 *  - 7d / 30d：MM-DD
 */
export function formatTickLabel(timestamp: number, range: ChartRange): string {
  const d = dayjs(normalizeTimestamp(timestamp));
  if (range === '24h') {
    return d.hour() === 0 && d.minute() === 0 ? d.format('MM-DD HH:mm') : d.format('HH:mm');
  }
  return d.format('MM-DD');
}
