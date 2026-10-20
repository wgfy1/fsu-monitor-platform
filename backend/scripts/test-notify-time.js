/**
 * 通知时间格式化测试（无测试框架，与项目其它自测脚本保持一致）
 *
 * 覆盖：
 *   1) UTC 等任意宿主/容器时区下，输出始终是**北京时间**；
 *   2) 固定格式 YYYY-MM-DD HH:mm:ss；
 *   3) 跨日边界（UTC 16:00 = 北京次日 00:00）；
 *   4) 钉钉与短信使用**同一份**时间文本。
 *
 * 原始缺陷：formatTime 用 Date#getHours() 取本地时间，
 * 容器时区为 UTC 时通知时间比北京时间慢 8 小时。
 *
 * 用法：cd backend && npm run build && node scripts/test-notify-time.js
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DIST_UTILS = path.join(__dirname, '..', 'dist', 'utils');
for (const f of ['beijingTime.js', 'notifyText.js']) {
  if (!fs.existsSync(path.join(DIST_UTILS, f))) {
    console.error(`找不到 dist/utils/${f}，请先执行：npm run build`);
    process.exit(2);
  }
}
const { formatBeijingTime } = require(path.join(DIST_UTILS, 'beijingTime'));
const { buildNotifyText } = require(path.join(DIST_UTILS, 'notifyText'));

// 子进程模式：父进程用它在不同 TZ 下取格式化结果
if (process.argv[2] === '--print') {
  process.stdout.write(formatBeijingTime(Number(process.argv[3])));
  process.exit(0);
}

// ---------- 固定时间戳 ----------
// 2024-01-01T16:00:00Z = 北京时间 2024-01-02 00:00:00（跨日）
const T_MIDNIGHT = Date.UTC(2024, 0, 1, 16, 0, 0);
// 2024-01-01T15:59:59Z = 北京时间 2024-01-01 23:59:59（跨日前一秒）
const T_BEFORE_MIDNIGHT = Date.UTC(2024, 0, 1, 15, 59, 59);
// 2024-07-01T04:05:09Z = 北京时间 2024-07-01 12:05:09
const T_DAYTIME = Date.UTC(2024, 6, 1, 4, 5, 9);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `  ← ${JSON.stringify(detail)}`}`);
}

console.log('==================================================');
console.log(' 通知时间格式化（北京时间）测试');
console.log(` 当前进程 TZ = ${process.env.TZ || '(未设置，由系统决定)'}`);
console.log('==================================================');

// ---------- 1. 固定输出格式 ----------
{
  const out = formatBeijingTime(T_DAYTIME);
  check('1 输出格式为 YYYY-MM-DD HH:mm:ss',
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(out),
    { out });
}

// ---------- 2. 已知时间戳的北京时间 ----------
check('2 2024-07-01T04:05:09Z → 2024-07-01 12:05:09（北京 UTC+8）',
  formatBeijingTime(T_DAYTIME) === '2024-07-01 12:05:09',
  { actual: formatBeijingTime(T_DAYTIME) });

// ---------- 3. 跨日边界 ----------
check('3a UTC 15:59:59 → 北京当日 23:59:59',
  formatBeijingTime(T_BEFORE_MIDNIGHT) === '2024-01-01 23:59:59',
  { actual: formatBeijingTime(T_BEFORE_MIDNIGHT) });
check('3b UTC 16:00:00 → 北京次日 00:00:00（跨日）',
  formatBeijingTime(T_MIDNIGHT) === '2024-01-02 00:00:00',
  { actual: formatBeijingTime(T_MIDNIGHT) });
check('3c 跨日前后相差 1 秒，日期正确翻转',
  formatBeijingTime(T_BEFORE_MIDNIGHT).slice(0, 10) === '2024-01-01'
  && formatBeijingTime(T_MIDNIGHT).slice(0, 10) === '2024-01-02',
  { before: formatBeijingTime(T_BEFORE_MIDNIGHT), after: formatBeijingTime(T_MIDNIGHT) });

// ---------- 4. 任意宿主时区下结果一致（核心：容器为 UTC 时也不能慢 8 小时） ----------
const TZ_CASES = ['UTC', 'Asia/Shanghai', 'America/New_York', 'Europe/London', 'Australia/Sydney'];
for (const tz of TZ_CASES) {
  const r = spawnSync(process.execPath, [__filename, '--print', String(T_MIDNIGHT)], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
  const out = (r.stdout || '').trim();
  check(`4 宿主 TZ=${tz} 时仍输出北京时间 2024-01-02 00:00:00`,
    out === '2024-01-02 00:00:00',
    { out, stderr: (r.stderr || '').trim() });
}

// ---------- 5. 钉钉与短信使用同一份时间文本 ----------
{
  const timeStr = formatBeijingTime(T_DAYTIME);
  const text = buildNotifyText({
    severity: 'vendor',
    alarmLevel: 3,
    deviceId: '00534c080213',
    deviceName: '台州电信13',
    typeName: '48V蓄电池',
    location: null,
    message: '48V蓄电池组电压过高',
    timeStr,
  });
  check('5a 钉钉文案包含同一份时间文本', text.dingtalk.includes(timeStr), { timeStr });
  check('5b 短信文案包含同一份时间文本', text.sms.includes(timeStr), { timeStr });
  check('5c 两个通道的时间文本完全相同（无第二个时区来源）',
    (text.dingtalk.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/) || [])[0] ===
    (text.sms.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/) || [])[0],
    { dingtalk: text.dingtalk, sms: text.sms });
  check('5d 时间文本是北京时间（与 formatBeijingTime 一致）',
    text.dingtalk.includes('2024-07-01 12:05:09') && text.sms.includes('2024-07-01 12:05:09'),
    { dingtalk: (text.dingtalk.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/) || [])[0] });
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`===== 通知时间测试：${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length ? 1 : 0);
