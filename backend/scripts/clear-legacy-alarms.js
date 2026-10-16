/**
 * 【一次性】清理历史告警数据 + 因删除告警产生的孤立推送记录
 *
 * 背景：FSU 告警改造后，alarms.type 由「平台自造分类（door/battery/ac/dc/env）」
 * 改为存放**厂家 devId**。为避免新旧两种取值混在同一张表里，
 * 经确认历史告警可全部删除，故执行本脚本一次性清空。
 *
 * ⚠️ 这是**手动执行的一次性运维脚本**，不是迁移、更不在服务启动路径上：
 *    服务每次启动都不会调用它，也不会因为重启而清空告警。
 *    幂等：重复执行不会造成额外影响（删除范围是确定的历史数据）。
 *
 * 清理范围（**仅这两张表**）：
 *   1. alarms           —— 全部历史告警记录
 *   2. alarm_push_logs  —— 其中「引用已不存在的告警」的孤立记录
 *      （action='alarm' 且 alarm_id 指向已删除的告警行）
 *      ⚠️ action='test' 的测试推送记录**不是**孤立记录（其 alarm_id 本就为空），予以保留。
 *
 * 明确**不触碰**：devices / device_meters（厂家点位字典）/ fsu_data_history（遥测）/
 *               sites / tenants / users / alarm_notify_config / tenant_notify_config
 *
 * 用法：cd backend && node scripts/clear-legacy-alarms.js
 *      （先停服务更稳妥；服务运行中执行亦可，已设 busy timeout）
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const BACKEND_DIR = path.join(__dirname, '..');

/** 与后端一致地从 backend/.env 解析 DB_PATH（避免与运行实例用错库） */
function resolveDbPath() {
  let dbPath = process.env.DB_PATH;
  if (!dbPath) {
    const envFile = path.join(BACKEND_DIR, '.env');
    if (fs.existsSync(envFile)) {
      const m = fs.readFileSync(envFile, 'utf8').match(/^\s*DB_PATH\s*=\s*(.+)\s*$/m);
      if (m) dbPath = m[1].trim();
    }
  }
  if (!dbPath) dbPath = './data/fsu.db';
  return path.resolve(BACKEND_DIR, dbPath);
}

/** 需要原样保留、清理前后计数必须一致的表 */
const PRESERVE_TABLES = [
  'devices', 'device_meters', 'fsu_data_history',
  'sites', 'tenants', 'users', 'alarm_notify_config', 'tenant_notify_config',
];

function open(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => (err ? reject(err) : resolve(db)));
  });
}
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const run = (db, sql, p = []) => new Promise((res, rej) =>
  db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

const countOf = async (db, t) => (await all(db, `SELECT COUNT(*) c FROM ${t}`))[0].c;

(async () => {
  const DB = resolveDbPath();
  console.log('==================================================');
  console.log(' 历史告警一次性清理');
  console.log('==================================================');
  console.log('数据库路径 :', DB);
  if (!fs.existsSync(DB)) {
    console.error('✗ 数据库文件不存在，终止');
    process.exit(1);
  }
  console.log('文件大小   :', fs.statSync(DB).size, '字节');

  // ---------- 1. 备份 ----------
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const backup = `${DB}.bak-${stamp}-before-clear-legacy-alarms`;
  fs.copyFileSync(DB, backup);
  console.log('备份文件   :', backup);
  console.log('备份大小   :', fs.statSync(backup).size, '字节');

  const db = await open(DB);
  // 服务可能在运行：给足等待写锁的时间，避免 SQLITE_BUSY 直接失败
  await run(db, 'PRAGMA busy_timeout = 15000');

  // ---------- 2. 清理前统计 ----------
  const before = { alarms: await countOf(db, 'alarms'), push: await countOf(db, 'alarm_push_logs') };
  const preserveBefore = {};
  for (const t of PRESERVE_TABLES) preserveBefore[t] = await countOf(db, t);

  const byType = await all(db, 'SELECT type, COUNT(*) c FROM alarms GROUP BY type ORDER BY c DESC');
  const bySeverity = await all(db, 'SELECT severity, COUNT(*) c FROM alarms GROUP BY severity');
  const ORPHAN_SQL = `action = 'alarm' AND alarm_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM alarms a WHERE a.id = alarm_push_logs.alarm_id)`;
  const orphans = (await all(db, `SELECT COUNT(*) c FROM alarm_push_logs WHERE ${ORPHAN_SQL}`))[0].c;

  console.log('\n---------- 清理前 ----------');
  console.log('alarms 总数          :', before.alarms);
  console.log('  按 type 分组       :', byType.length ? JSON.stringify(byType) : '(空)');
  console.log('  按 severity 分组   :', bySeverity.length ? JSON.stringify(bySeverity) : '(空)');
  console.log('alarm_push_logs 总数 :', before.push);
  console.log('  其中孤立记录       :', orphans, '（action=alarm 且所指告警已不存在）');

  // ---------- 3. 事务清理 ----------
  await run(db, 'BEGIN IMMEDIATE TRANSACTION');
  let deletedOrphans = 0;
  let deletedAlarms = 0;
  try {
    const r1 = await run(db, `DELETE FROM alarm_push_logs WHERE ${ORPHAN_SQL}`);
    deletedOrphans = r1.changes || 0;
    const r2 = await run(db, 'DELETE FROM alarms');
    deletedAlarms = r2.changes || 0;
    await run(db, 'COMMIT');
  } catch (err) {
    await run(db, 'ROLLBACK').catch(() => undefined);
    console.error('\n✗ 清理失败，已整体回滚:', err.message);
    db.close();
    process.exit(1);
  }

  // ---------- 4. 清理后校验 ----------
  const after = { alarms: await countOf(db, 'alarms'), push: await countOf(db, 'alarm_push_logs') };
  const remainOrphans = (await all(db, `SELECT COUNT(*) c FROM alarm_push_logs WHERE ${ORPHAN_SQL}`))[0].c;
  const preserveAfter = {};
  for (const t of PRESERVE_TABLES) preserveAfter[t] = await countOf(db, t);

  console.log('\n---------- 清理结果 ----------');
  console.log(`alarms          : ${before.alarms} → ${after.alarms}   （删除 ${deletedAlarms} 条）`);
  console.log(`alarm_push_logs : ${before.push} → ${after.push}   （删除孤立记录 ${deletedOrphans} 条，保留测试推送 ${after.push} 条）`);
  console.log('剩余孤立记录    :', remainOrphans);

  console.log('\n---------- 未受影响表（清理前后必须一致）----------');
  let ok = true;
  for (const t of PRESERVE_TABLES) {
    const same = preserveBefore[t] === preserveAfter[t];
    if (!same) ok = false;
    console.log(`  ${same ? '✓' : '✗'} ${t.padEnd(22)} ${preserveBefore[t]} → ${preserveAfter[t]}`);
  }

  db.close();
  console.log('\n==================================================');
  console.log(ok && after.alarms === 0 && remainOrphans === 0
    ? '✓ 清理完成：历史告警已清空，其他数据未受影响'
    : '✗ 清理结果异常，请检查上面的输出');
  console.log('备份保留在 :', backup);
  console.log('==================================================');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('执行失败:', e);
  process.exit(2);
});
