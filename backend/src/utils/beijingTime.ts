/**
 * 北京时间格式化（钉钉 / 短信通知文案专用）
 *
 * 背景：生产宿主机是北京时间、Docker 容器是 UTC，且未设置 process.env.TZ。
 * 原实现用 `Date#getHours()` 等**本地时间**方法，在容器里会少 8 小时，
 * 表现为钉钉/短信通知时间比北京时间慢 8 小时。
 *
 * 修复方式：显式指定 IANA 时区 `Asia/Shanghai`，输出与宿主机/容器时区无关。
 * **不采用"时间戳 + 8 小时"**：那种写法在非 UTC 机器上会重复偏移，
 * 也无法正确处理时区规则变化。
 *
 * 本模块为纯函数、无任何依赖，便于单独测试。
 */

/** 通知文案统一使用的时区 */
export const NOTIFY_TIME_ZONE = 'Asia/Shanghai';

/**
 * 固定分段格式器
 * - h23：00~23 时，避免个别 ICU 实现在 hour12=false 时输出 "24" 点
 * - 时区显式指定，不受 TZ 环境变量影响
 */
const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: NOTIFY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * 把毫秒时间戳格式化为北京时间 `YYYY-MM-DD HH:mm:ss`
 *
 * @param ts 毫秒时间戳
 * @throws RangeError 时间戳非法时抛出（调用方在推送链路的 try 内，不影响告警落库）
 */
export function formatBeijingTime(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`无效的时间戳: ${String(ts)}`);
  }
  const parts = partsFormatter.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} `
    + `${pick('hour')}:${pick('minute')}:${pick('second')}`;
}
